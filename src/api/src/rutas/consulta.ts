import { Router } from "express";
import { z } from "zod";
import { config } from "../config.js";
import { comoVector, pool } from "../db.js";
import { ErrorApi } from "../errores.js";
import { embeberConsulta } from "../ollama.js";
import { urlFoto } from "./productos.js";

// Historias 3 y 4: consulta en lenguaje natural + búsqueda híbrida.
// buscar_productos_hibrida aplica el filtro duro (solo activos con stock > 0) y ordena por un puntaje
// que combina la similitud semántica con la coincidencia de palabras del nombre.

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

  const vector = comoVector(await embeberConsulta(c.texto));
  const { rows } = await pool.query(
    `SELECT producto_id, sku, nombre, categoria, precio, stock, similitud, puntaje
     FROM buscar_productos_hibrida($1::vector, $2::text, $3::int, $4::real, $5::real)`,
    [vector, c.texto, c.limite, umbral, config.pesoTexto],
  );

  // Si lo que mejor calza con la búsqueda está agotado, se avisa para que el vendedor ofrezca
  // las alternativas con stock (que son los resultados) en vez de decir solo "no hay".
  const { rows: agotados } = await pool.query(
    `WITH cercanos AS (
       SELECT p.sku, p.nombre, (1 - (e.embedding <=> $1::vector))::real AS similitud,
              word_similarity(lower($2::text), lower(p.nombre))::real AS sim_texto
       FROM producto_embeddings e JOIN productos p ON p.id = e.producto_id
       WHERE p.activo AND p.stock <= 0
       ORDER BY e.embedding <=> $1::vector LIMIT 10)
     SELECT sku, nombre, similitud, ((1 - $3::real) * similitud + $3::real * sim_texto)::real AS puntaje
     FROM cercanos ORDER BY puntaje DESC LIMIT 1`,
    [vector, c.texto, config.pesoTexto],
  );
  const agotado = agotados[0];
  const agotadoParecido =
    agotado && agotado.similitud >= umbral && (!rows.length || agotado.puntaje > rows[0].puntaje)
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
