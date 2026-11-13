import { Router } from "express";
import { z } from "zod";
import { config } from "../config.js";
import { comoVector, pool } from "../db.js";
import { ErrorApi } from "../errores.js";
import { conversar, embeberConsulta } from "../ollama.js";
import { urlFoto } from "./productos.js";

// Historias 3 y 4: consulta en lenguaje natural. buscar_productos_fusion combina la similitud semántica
// con la coincidencia de texto completo. Antes de vectorizar, expandir_consulta corrige la escritura y
// aplica sinónimos (lo que dice el cliente -> nombre en el catálogo). Solo productos activos con stock > 0.
//
// Hay dos formas de preguntar, y se distinguen con "origen":
//   - "buscador": el vendedor escribe palabras simples o compuestas ("reparación de techo"). No usa las
//     frases de cliente: la consulta corta ya la resuelven el vector, el texto completo y los trigramas.
//   - "asistente": el vendedor escribe lo que dijo el cliente ("algo para tapar goteras"). Un modelo de
//     lenguaje chico traduce el pedido a búsquedas cortas, como las que se escriben en el buscador
//     ("silicona tapagoteras", "sellante techo"), y cada una se busca igual que en el buscador. Además se
//     busca el texto completo con la lista de frases de cliente (conversaciones de mostrador). El modelo
//     solo elige qué buscar: productos, precio y stock salen de la base.

const cuerpoConsulta = z.object({
  origen: z.enum(["buscador", "asistente"]).default("buscador"),
  texto: z.string().trim().min(1, "Escribe qué estás buscando").max(500),
  limite: z.number().int().min(1).max(50).default(10),
  similitud_minima: z.number().min(0).max(1).optional(),
  usuario_id: z.number().int().optional(),
  cliente: z.string().default("Chatbot del vendedor"),
});

// [peso_frase, frase_pasa] de buscar_productos_fusion. En el buscador las frases no pesan y ninguna
// basta para mostrar un producto (el parecido nunca pasa de 1). En el asistente valen los de la función.
const FRASES: Record<"buscador" | "asistente", [number, number]> = {
  buscador: [0, 2],
  asistente: [1.5, 0.6],
};

export type ResultadoConsulta = {
  consulta_id: number;
  origen: "buscador" | "asistente";
  texto: string;
  // Texto con el que se buscó (ya corregido y con sinónimos) y si cambió respecto del normalizado.
  texto_buscado: string;
  se_corrigio: boolean;
  // Solo en el asistente: las búsquedas cortas en que se tradujo el pedido del cliente ([] si no hubo).
  interpretacion: string[];
  // "solo_texto" si el modelo de embeddings no respondió: la búsqueda sigue, solo por palabras.
  modo: "semantica" | "solo_texto";
  modelo: string;
  similitud_minima: number;
  latencia_ms: number;
  resultados: { sku: string; nombre: string; categoria: string | null; precio: number | null; stock: number; unidad: string; score: number; foto: string | null }[];
  // El producto que mejor calzaba pero está agotado (los resultados son sus alternativas con stock).
  agotado_parecido: { sku: string; nombre: string; foto: string | null } | null;
};

type Fila = { producto_id: number; sku: string; nombre: string; categoria: string | null; precio: number | null; stock: number; similitud: number; puntaje: number; unidad: string };

// Una búsqueda: corrige y expande el texto, lo vectoriza y llama a la función de fusión.
async function buscar(texto: string, origen: "buscador" | "asistente", limite: number, umbral: number) {
  const { rows: [{ normalizada, expandida }] } = await pool.query(
    "SELECT normalizar_busqueda($1) AS normalizada, expandir_consulta($1) AS expandida",
    [texto],
  );
  // Sin modelo de embeddings la búsqueda sigue por palabras: el vector queda en NULL.
  let modo: ResultadoConsulta["modo"] = "semantica";
  let vector: string | null = null;
  try {
    vector = comoVector(await embeberConsulta(expandida));
  } catch (err) {
    if (!(err instanceof ErrorApi && err.codigo === "modelo_no_disponible")) throw err;
    modo = "solo_texto";
  }
  const { rows } = await pool.query<Fila>(
    `SELECT f.producto_id, f.sku, f.nombre, f.categoria, f.precio, f.stock, f.similitud, f.puntaje,
            (SELECT unidad_venta(p.nombre, p.permite_decimal, p.unidad_medida) FROM productos p WHERE p.id = f.producto_id) AS unidad
     FROM buscar_productos_fusion($1::vector, $2::text, $3::int, $4::real,
                                  peso_frase => $5::real, frase_pasa => $6::real) f`,
    [vector, expandida, limite, umbral, ...FRASES[origen]],
  );
  return { normalizada: normalizada as string, expandida: expandida as string, vector, modo, rows };
}

// Traduce el pedido del cliente a 1 a 3 búsquedas cortas. Devuelve [] si el modelo no responde, si no
// entiende o si el pedido no es de ferretería: el asistente sigue con la búsqueda del texto completo.
const INTERPRETE = `Eres el vendedor experto de una ferretería y tapicería de barrio en Chile. Te cuentan lo que pidió un cliente, con sus palabras.
Responde SOLO un JSON {"busquedas": [...]} con 1 a 3 búsquedas cortas (1 a 3 palabras cada una, en minúsculas) con el nombre genérico de los productos que resuelven el pedido, como los rotula una ferretería.
Sin marcas ni medidas inventadas. Si el pedido no es algo que venda una ferretería o tapicería, responde {"busquedas": []}.
Ejemplos:
"algo para tapar goteras en el techo" -> {"busquedas": ["silicona tapagoteras", "sellante techo", "brea"]}
"se me soltó la pata de la silla" -> {"busquedas": ["cola fría", "adhesivo madera", "tarugo"]}
"quiero pintar la pieza" -> {"busquedas": ["látex", "rodillo", "brocha"]}
"necesito un pasaje a Concepción" -> {"busquedas": []}`;

const cacheInterpretacion = new Map<string, string[]>();

async function interpretarPedido(texto: string): Promise<string[]> {
  const clave = texto.toLowerCase().trim();
  const guardada = cacheInterpretacion.get(clave);
  if (guardada) return guardada;
  try {
    const crudo = await conversar(INTERPRETE, texto, config.modeloInterprete, { formato: "json", temperatura: 0, maxTokens: 80 });
    const lista = JSON.parse(crudo)?.busquedas;
    const busquedas = Array.isArray(lista)
      ? [...new Set(lista.map((b: unknown) => String(b).toLowerCase().trim()).filter((b: string) => b && b.split(/\s+/).length <= 4))].slice(0, 3)
      : [];
    if (cacheInterpretacion.size > 500) cacheInterpretacion.delete(cacheInterpretacion.keys().next().value as string);
    cacheInterpretacion.set(clave, busquedas);
    return busquedas;
  } catch {
    return [];
  }
}

// Une las listas por turnos (primero de cada búsqueda interpretada, después el segundo...) y deja el
// texto completo al final de cada turno. Un producto repetido queda en su mejor posición.
function unirPorTurnos(listas: Fila[][], limite: number): Fila[] {
  const vistos = new Set<number>();
  const salida: Fila[] = [];
  const largo = Math.max(0, ...listas.map((l) => l.length));
  for (let i = 0; i < largo && salida.length < limite; i++) {
    for (const lista of listas) {
      const fila = lista[i];
      if (fila && !vistos.has(fila.producto_id)) {
        vistos.add(fila.producto_id);
        salida.push(fila);
        if (salida.length >= limite) break;
      }
    }
  }
  return salida;
}

export async function ejecutarConsulta(entrada: z.input<typeof cuerpoConsulta>): Promise<ResultadoConsulta> {
  const c = cuerpoConsulta.parse(entrada);
  const umbral = c.similitud_minima ?? config.similitudMinima;
  const inicio = performance.now();

  const modelo = await pool.query("SELECT id FROM modelos_embedding WHERE nombre = $1", [config.modeloEmbedding]);
  if (!modelo.rowCount) throw new ErrorApi(500, "modelo_no_registrado", `El modelo ${config.modeloEmbedding} no está en modelos_embedding.`);
  const cliente = await pool.query("SELECT id FROM clientes_api WHERE nombre = $1 AND activo", [c.cliente]);
  if (!cliente.rowCount) throw new ErrorApi(403, "cliente_desconocido", `El cliente "${c.cliente}" no está registrado.`);

  const [base, interpretacion] = await Promise.all([
    buscar(c.texto, c.origen, c.limite, umbral),
    c.origen === "asistente" ? interpretarPedido(c.texto) : Promise.resolve([] as string[]),
  ]);
  const { normalizada, expandida, vector, modo } = base;
  let rows = base.rows;
  if (interpretacion.length) {
    const porBusqueda = await Promise.all(interpretacion.map((t) => buscar(t, "buscador", c.limite, umbral)));
    rows = unirPorTurnos([...porBusqueda.map((b) => b.rows), base.rows], c.limite);
  } else if (c.origen === "buscador") {
    // Una tarea escrita en pocas palabras ("pintar muros") se busca por cada producto de su lista.
    const tarea = await pool.query<{ busquedas: string[] }>(
      "SELECT busquedas FROM tareas_busqueda WHERE frase IN ($1, $2) LIMIT 1",
      [normalizada, expandida],
    );
    if (tarea.rowCount) {
      const porBusqueda = await Promise.all(tarea.rows[0].busquedas.map((t) => buscar(t, "buscador", c.limite, umbral)));
      rows = unirPorTurnos([...porBusqueda.map((b) => b.rows), base.rows], c.limite);
    }
  }

  // Si lo que mejor calza con la búsqueda está agotado, se avisa para que el vendedor ofrezca
  // las alternativas con stock (que son los resultados) en vez de decir solo "no hay".
  // Se compara por similitud semántica: los puntajes de la fusión no son comparables con este.
  // Sin vector no hay comparación semántica: en modo solo_texto este aviso queda en null.
  const { rows: agotados } = vector
    ? await pool.query(
        `SELECT p.sku, p.nombre, (1 - (e.embedding <=> $1::vector))::real AS similitud
         FROM producto_embeddings e JOIN productos p ON p.id = e.producto_id
         WHERE p.activo AND p.stock <= 0
         ORDER BY e.embedding <=> $1::vector LIMIT 1`,
        [vector],
      )
    : { rows: [] as { sku: string; nombre: string; similitud: number }[] };
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
    origen: c.origen,
    texto: c.texto,
    texto_buscado: expandida,
    se_corrigio: expandida !== normalizada,
    interpretacion,
    modo,
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
      unidad: r.unidad,
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
