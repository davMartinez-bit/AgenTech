import { Router } from "express";
import { z } from "zod";
import { config } from "../config.js";
import { comoVector, pool } from "../db.js";
import { ErrorApi } from "../errores.js";
import { embeberConsulta } from "../ollama.js";
import { urlFoto } from "./productos.js";

// Historias 3 y 4: consulta en lenguaje natural. buscar_productos_fusion combina la similitud semántica
// con la coincidencia de texto completo. Antes de vectorizar, expandir_consulta corrige la escritura y
// aplica sinónimos (lo que dice el cliente -> nombre en el catálogo). Solo productos activos con stock > 0.

const cuerpoConsulta = z.object({
  texto: z.string().trim().min(1, "Escribe qué estás buscando").max(500),
  limite: z.number().int().min(1).max(50).default(10),
  similitud_minima: z.number().min(0).max(1).optional(),
  usuario_id: z.number().int().optional(),
  cliente: z.string().default("Chatbot del vendedor"),
});

export type ResultadoConsulta = {
  consulta_id: number;
  texto: string;
  // Texto con el que se buscó (ya corregido y con sinónimos) y si cambió respecto del normalizado.
  texto_buscado: string;
  se_corrigio: boolean;
  modelo: string;
  similitud_minima: number;
  latencia_ms: number;
  resultados: { sku: string; nombre: string; categoria: string | null; precio: number | null; stock: number; score: number; foto: string | null }[];
  // El producto que mejor calzaba pero está agotado (los resultados son sus alternativas con stock).
  agotado_parecido: { sku: string; nombre: string; foto: string | null } | null;
};

export async function ejecutarConsulta(entrada: z.input<typeof cuerpoConsulta>): Promise<ResultadoConsulta> {
  const c = cuerpoConsulta.parse(entrada);
  const umbral = c.similitud_minima ?? config.similitudMinima;
  const inicio = performance.now();

  const modelo = await pool.query("SELECT id FROM modelos_embedding WHERE nombre = $1", [config.modeloEmbedding]);
  if (!modelo.rowCount) throw new ErrorApi(500, "modelo_no_registrado", `El modelo ${config.modeloEmbedding} no está en modelos_embedding.`);
  const cliente = await pool.query("SELECT id FROM clientes_api WHERE nombre = $1 AND activo", [c.cliente]);
  if (!cliente.rowCount) throw new ErrorApi(403, "cliente_desconocido", `El cliente "${c.cliente}" no está registrado.`);

  const { rows: [{ normalizada, expandida }] } = await pool.query(
    "SELECT normalizar_busqueda($1) AS normalizada, expandir_consulta($1) AS expandida",
    [c.texto],
  );
  const vector = comoVector(await embeberConsulta(expandida));
  const { rows } = await pool.query(
    `SELECT producto_id, sku, nombre, categoria, precio, stock, similitud, puntaje
     FROM buscar_productos_fusion($1::vector, $2::text, $3::int, $4::real)`,
    [vector, expandida, c.limite, umbral],
  );

  // Si lo que mejor calza con la búsqueda está agotado, se avisa para que el vendedor ofrezca
  // las alternativas con stock (que son los resultados) en vez de decir solo "no hay".
  // Se compara por similitud semántica: los puntajes de la fusión no son comparables con este.
  const { rows: agotados } = await pool.query(
    `SELECT p.sku, p.nombre, (1 - (e.embedding <=> $1::vector))::real AS similitud
     FROM producto_embeddings e JOIN productos p ON p.id = e.producto_id
     WHERE p.activo AND p.stock <= 0
     ORDER BY e.embedding <=> $1::vector LIMIT 1`,
    [vector],
  );
  const agotado = agotados[0];
  const agotadoParecido =
    agotado && agotado.similitud >= umbral && (!rows.length || agotado.similitud > Math.max(...rows.map((r) => r.similitud)))
      ? { sku: agotado.sku, nombre: agotado.nombre, foto: urlFoto(agotado.sku) }
      : null;
  const latencia = Math.round(performance.now() - inicio);

  const reg = await pool.query(
    `INSERT INTO consultas (cliente_id, usuario_id, texto, modelo_id, embedding, limite, similitud_minima,
                            cantidad_resultados, latencia_ms)
     VALUES ($1, $2, $3, $4, $5::vector, $6, $7, $8, $9) RETURNING id`,
    [cliente.rows[0].id, c.usuario_id ?? null, c.texto, modelo.rows[0].id, vector, c.limite, umbral, rows.length, latencia],
  );
  const consultaId = reg.rows[0].id;
  if (rows.length) {
    await pool.query(
      `INSERT INTO consulta_resultados (consulta_id, posicion, producto_id, similitud, precio, stock)
       SELECT $1, r.posicion, r.producto_id, r.similitud, r.precio, r.stock
       FROM jsonb_to_recordset($2::jsonb) AS r(posicion smallint, producto_id bigint, similitud real, precio numeric, stock numeric)`,
      [consultaId, JSON.stringify(rows.map((r, i) => ({ ...r, posicion: i + 1 })))],
    );
  }

  return {
    consulta_id: consultaId,
    texto: c.texto,
    texto_buscado: expandida,
    se_corrigio: expandida !== normalizada,
    modelo: config.modeloEmbedding,
    similitud_minima: umbral,
    latencia_ms: latencia,
    agotado_parecido: agotadoParecido,
    resultados: rows.map((r) => ({
      sku: r.sku,
      nombre: r.nombre,
      categoria: r.categoria,
      precio: r.precio,
      stock: r.stock,
      score: Math.round(r.puntaje * 1000) / 1000,
      foto: urlFoto(r.sku),
    })),
  };
}

export const rutaConsulta = Router();

rutaConsulta.post("/consulta", async (req, res) => {
  res.json(await ejecutarConsulta(req.body));
});

// Clic en un resultado: qué producto abrió el vendedor después de buscar. Con esto se mide la búsqueda
// con uso real (en qué posición estaba lo que se abrió). Solo vale un producto que venía en esa consulta.
const cuerpoClic = z.object({
  sku: z.string().trim().min(1, "Falta el SKU del producto abierto"),
  origen: z.enum(["buscador", "asistente"]).default("buscador"),
});

rutaConsulta.post("/consulta/:id/clic", async (req, res) => {
  const consultaId = Number(req.params.id);
  if (!Number.isInteger(consultaId) || consultaId <= 0) throw new ErrorApi(400, "solicitud_invalida", "El id de la consulta no es válido.");
  const c = cuerpoClic.parse(req.body);
  const { rows } = await pool.query(
    `INSERT INTO consulta_clics (consulta_id, producto_id, origen)
     SELECT r.consulta_id, r.producto_id, $3
     FROM consulta_resultados r JOIN productos p ON p.id = r.producto_id
     WHERE r.consulta_id = $1 AND p.sku = $2
     RETURNING (SELECT posicion FROM consulta_resultados x WHERE x.consulta_id = $1 AND x.producto_id = consulta_clics.producto_id) AS posicion`,
    [consultaId, c.sku, c.origen],
  );
  if (!rows.length) throw new ErrorApi(404, "resultado_no_encontrado", "Ese producto no está entre los resultados de la consulta.");
  res.status(201).json({ consulta_id: consultaId, sku: c.sku, posicion: rows[0].posicion });
});
