import { Router } from "express";
import { config } from "../config.js";
import { pool } from "../db.js";
import { ErrorApi } from "../errores.js";
import { conversar } from "../ollama.js";

// Sugerencia para el vendedor: a partir de los productos que devolvió una consulta, el modelo de lenguaje
// propone de 1 a 3 productos y una frase corta. Como ejemplos de tono se usan conversaciones de mostrador
// parecidas (conversaciones_parecidas). Si la consulta no trajo productos, no se llama al modelo.

const SISTEMA = `Eres el asistente de un vendedor de mostrador de una ferretería chilena que también vende insumos de tapicería y mueblería. El vendedor te escribe lo que pide el cliente y tú le dices qué ofrecer, usando SOLO los productos de la lista.
Reglas:
1. Recomienda de 1 a 3 productos de la lista: los que de verdad resuelven lo que pide el cliente. Si ninguno sirve, dilo y no recomiendes nada.
2. Explica en una o dos frases por qué sirven y agrega un consejo práctico de uso. Si sugieres llevar algo más, que esté en la lista.
3. No inventes productos, medidas, marcas ni precios. No hables de precios ni de stock: el vendedor ya los ve en la tabla.
4. Castellano de Chile, directo y breve: máximo 45 palabras. Háblale al vendedor de tú. Escribe "para", nunca "pa".
5. Responde solo con JSON: {"recomendados": ["SKU"], "respuesta": "texto"}. En "recomendados" van los SKU tal como aparecen entre corchetes en la lista.`;

const SIN_PRODUCTOS = "No encontré productos para eso. Prueba con otras palabras o con el nombre del producto.";
const RESPALDO = "Revisa los primeros resultados de la tabla: son los que más se parecen a lo que pide el cliente.";

type Candidato = { sku: string; nombre: string; descripcion: string | null; unidad: string };

function ahoraMs(inicio: number): number {
  return Math.round(performance.now() - inicio);
}

// Lee la salida del modelo. Devuelve null si no se puede usar (JSON roto o sin respuesta).
// Los recomendados se quedan solo con SKU que estaban en la lista, sin repetir, máximo 3.
function interpretar(salida: string, candidatos: Candidato[]): { respuesta: string; recomendados: Candidato[] } | null {
  let datos: any;
  try {
    datos = JSON.parse(salida);
  } catch {
    return null;
  }
  const respuesta = typeof datos?.respuesta === "string" ? datos.respuesta.trim() : "";
  if (!respuesta) return null;
  const pedidos: unknown[] = Array.isArray(datos.recomendados) ? datos.recomendados : [];
  const recomendados: Candidato[] = [];
  for (const sku of pedidos) {
    if (typeof sku !== "string") continue;
    const candidato = candidatos.find((c) => c.sku === sku.trim());
    if (candidato && !recomendados.includes(candidato) && recomendados.length < 3) recomendados.push(candidato);
  }
  return { respuesta, recomendados };
}

export const rutaRespuesta = Router();

rutaRespuesta.post("/consulta/:id/respuesta", async (req, res) => {
  const inicio = performance.now();
  const consultaId = Number(req.params.id);
  if (!Number.isInteger(consultaId) || consultaId <= 0) throw new ErrorApi(400, "solicitud_invalida", "El id de la consulta no es válido.");

  const { rows: [consulta] } = await pool.query(
    "SELECT texto, embedding::text AS embedding FROM consultas WHERE id = $1",
    [consultaId],
  );
  if (!consulta) throw new ErrorApi(404, "consulta_no_encontrada", `No existe una consulta con id ${consultaId}.`);

  const { rows: candidatos } = await pool.query<Candidato>(
    `SELECT p.sku, p.nombre, left(p.descripcion, 220) AS descripcion,
            unidad_venta(p.nombre, p.permite_decimal, p.unidad_medida) AS unidad
     FROM consulta_resultados r JOIN productos p ON p.id = r.producto_id
     WHERE r.consulta_id = $1
     ORDER BY r.posicion
     LIMIT 8`,
    [consultaId],
  );
  if (!candidatos.length) {
    res.json({
      consulta_id: consultaId,
      respuesta: SIN_PRODUCTOS,
      recomendados: [],
      ejemplos: 0,
      generada: false,
      modelo: null,
      latencia_ms: ahoraMs(inicio),
    });
    return;
  }

  const ejemplos = consulta.embedding
    ? (await pool.query<{ cliente: string; respuesta: string }>(
        "SELECT cliente, respuesta FROM conversaciones_parecidas($1::vector, 3, 0.5)",
        [consulta.embedding],
      )).rows
    : [];

  const lineas = candidatos.map(
    (c, i) => `${i + 1}. [${c.sku}] ${c.nombre}: ${c.descripcion ?? "sin descripción"} (se vende por ${c.unidad})`,
  );
  let usuario = `El cliente pide: ${consulta.texto}\n\nProductos encontrados:\n${lineas.join("\n")}`;
  if (ejemplos.length) {
    usuario +=
      "\n\nAsí respondieron buenos vendedores en casos parecidos. Son ejemplos de tono y de criterio: no nombres productos que no estén en la lista.\n" +
      ejemplos.map((e) => `- Cliente: ${e.cliente}\n  Vendedor: ${e.respuesta}`).join("\n");
  }

  const salida = await conversar(SISTEMA, usuario, config.modeloRespuesta, { formato: "json", temperatura: 0.2, maxTokens: 220 });
  const interpretada = interpretar(salida, candidatos);

  res.json({
    consulta_id: consultaId,
    respuesta: interpretada?.respuesta ?? RESPALDO,
    recomendados: (interpretada?.recomendados ?? []).map((c) => ({ sku: c.sku, nombre: c.nombre })),
    ejemplos: ejemplos.length,
    generada: interpretada !== null,
    modelo: interpretada ? config.modeloRespuesta : null,
    latencia_ms: ahoraMs(inicio),
  });
});
