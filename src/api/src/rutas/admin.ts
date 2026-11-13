import { createHash } from "node:crypto";
import { Router } from "express";
import { z } from "zod";
import { config } from "../config.js";
import { consultar } from "../db.js";
import { ErrorApi } from "../errores.js";
import { conversar } from "../ollama.js";

// Panel administrativo: indicadores, gráficos (ventas de Bsale y uso del buscador) y el agente
// que los interpreta. El agente solo recibe los números que la base ya calculó; no consulta nada por su cuenta.

type Grafico = { titulo: string; descripcion: string; sql: string };

export const GRAFICOS: Record<string, Grafico> = {
  ventas_por_dia: {
    titulo: "Ventas por día (últimos 60 días)",
    descripcion: "Total vendido por día en pesos con IVA, notas de crédito descontadas.",
    sql: `SELECT dia, documentos, total FROM ventas_por_dia
          WHERE dia >= current_date - 60 ORDER BY dia`,
  },
  ventas_por_mes: {
    titulo: "Ventas por mes",
    descripcion: "Total vendido por mes en pesos con IVA.",
    sql: `SELECT to_char(date_trunc('month', dia), 'YYYY-MM') AS mes, sum(documentos) AS documentos, sum(total) AS total
          FROM ventas_por_dia GROUP BY 1 ORDER BY 1`,
  },
  ventas_por_categoria: {
    titulo: "Ventas por categoría (últimos 90 días)",
    descripcion: "Pesos vendidos por categoría de producto.",
    sql: `SELECT coalesce(categoria, 'Sin categoría') AS categoria, sum(total) AS total, sum(unidades) AS unidades
          FROM ventas_por_producto WHERE dia >= current_date - 90
          GROUP BY 1 ORDER BY total DESC`,
  },
  productos_mas_vendidos: {
    titulo: "Productos más vendidos (últimos 90 días)",
    descripcion: "Los 10 productos con más pesos vendidos y su stock actual.",
    sql: `SELECT v.sku, v.nombre, sum(v.unidades) AS unidades, sum(v.total) AS total, p.stock,
                 unidad_venta(p.nombre, p.permite_decimal, p.unidad_medida) AS unidad
          FROM ventas_por_producto v JOIN productos p ON p.id = v.producto_id
          WHERE v.dia >= current_date - 90
          GROUP BY v.sku, v.nombre, p.stock, p.nombre, p.permite_decimal, p.unidad_medida ORDER BY total DESC LIMIT 10`,
  },
  riesgo_quiebre: {
    titulo: "Riesgo de quiebre de stock",
    descripcion: "Productos que se venden y cuyo stock alcanza para menos de 14 días al ritmo de los últimos 30 días.",
    sql: `WITH ritmo AS (
            SELECT producto_id, sum(unidades) / 30.0 AS por_dia
            FROM ventas_por_producto WHERE dia >= current_date - 30 AND producto_id IS NOT NULL
            GROUP BY producto_id HAVING sum(unidades) > 0)
          SELECT p.sku, p.nombre, p.stock, round(r.por_dia, 2) AS venta_diaria,
                 round(greatest(p.stock, 0) / r.por_dia, 1) AS dias_de_stock
          FROM ritmo r JOIN productos p ON p.id = r.producto_id
          WHERE greatest(p.stock, 0) / r.por_dia < 14
          ORDER BY dias_de_stock, venta_diaria DESC LIMIT 15`,
  },
  stock_por_categoria: {
    titulo: "Stock por categoría",
    descripcion: "Productos activos con y sin stock, y valor del inventario a precio de venta.",
    sql: `SELECT coalesce(c.nombre, 'Sin categoría') AS categoria,
                 count(*) FILTER (WHERE p.stock > 0) AS con_stock,
                 count(*) FILTER (WHERE p.stock <= 0) AS sin_stock,
                 round(sum(greatest(p.stock, 0) * coalesce(p.precio, 0))) AS valor_inventario
          FROM productos p LEFT JOIN categorias c ON c.id = p.categoria_id
          WHERE p.activo GROUP BY 1 ORDER BY valor_inventario DESC`,
  },
  busquedas_por_dia: {
    titulo: "Uso del buscador (últimos 30 días)",
    descripcion: "Consultas de los vendedores por día, cuántas no encontraron nada y la latencia.",
    sql: `SELECT dia, consultas, sin_resultados, latencia_promedio_ms, round(latencia_p95_ms) AS latencia_p95_ms
          FROM resumen_consultas WHERE dia >= current_date - 30 ORDER BY dia`,
  },
  busquedas_sin_resultados: {
    titulo: "Lo que buscan y no encuentran",
    descripcion: "Búsquedas de los vendedores que no devolvieron productos con stock: demanda sin cubrir.",
    sql: `SELECT lower(texto) AS busqueda, count(*) AS veces, max(creado_en)::date AS ultima_vez
          FROM consultas WHERE cantidad_resultados = 0
          GROUP BY 1 ORDER BY veces DESC, ultima_vez DESC LIMIT 15`,
  },
};

export const rutaAdmin = Router();

rutaAdmin.get("/admin/resumen", async (_req, res) => {
  const [r] = await consultar(`
    SELECT
      (SELECT count(*) FROM productos WHERE activo)                              AS productos_activos,
      (SELECT count(*) FROM productos WHERE activo AND stock > 0)                AS con_stock,
      (SELECT count(*) FROM productos WHERE activo AND stock <= 0)               AS sin_stock,
      (SELECT count(*) FROM productos WHERE activo AND precio IS NULL)           AS sin_precio,
      (SELECT round(sum(greatest(stock, 0) * coalesce(precio, 0))) FROM productos WHERE activo) AS valor_inventario,
      (SELECT count(*) FROM producto_embeddings)                                 AS vectorizados,
      (SELECT count(*) FROM productos_pendientes_embedding)                      AS pendientes_vector,
      (SELECT coalesce(sum(signo * total), 0) FROM ventas WHERE emitido_en >= current_date - 30) AS ventas_30_dias,
      (SELECT coalesce(sum(signo * total), 0) FROM ventas
        WHERE emitido_en >= current_date - 60 AND emitido_en < current_date - 30) AS ventas_30_dias_previos,
      (SELECT count(*) FROM ventas WHERE signo = 1 AND emitido_en >= current_date - 30) AS documentos_30_dias,
      (SELECT count(*) FROM consultas WHERE creado_en >= now() - interval '7 days') AS consultas_7_dias,
      (SELECT count(*) FROM consultas WHERE creado_en >= now() - interval '7 days' AND cantidad_resultados = 0) AS sin_resultados_7_dias,
      (SELECT round(percentile_cont(0.95) WITHIN GROUP (ORDER BY latencia_ms))
         FROM consultas WHERE creado_en >= now() - interval '7 days')            AS latencia_p95_ms,
      (SELECT max(terminado_en) FROM sincronizaciones_bsale WHERE estado = 'ok' AND recurso = 'ventas')   AS ultima_sync_ventas,
      (SELECT max(terminado_en) FROM sincronizaciones_bsale WHERE estado = 'ok' AND recurso = 'catalogo') AS ultima_sync_catalogo,
      (SELECT max(creado_en) FROM ingestas)                                      AS ultima_ingesta`);
  res.json({ ...r, modelo_embedding: config.modeloEmbedding, modelo_agente: config.modeloAgente });
});

rutaAdmin.get("/admin/graficos", (_req, res) => {
  res.json(Object.entries(GRAFICOS).map(([id, g]) => ({ id, titulo: g.titulo, descripcion: g.descripcion })));
});

async function datosGrafico(id: string) {
  const g = GRAFICOS[id];
  if (!g) throw new ErrorApi(404, "grafico_no_encontrado", `No existe el gráfico "${id}".`);
  return { id, titulo: g.titulo, descripcion: g.descripcion, datos: await consultar(g.sql) };
}

rutaAdmin.get("/admin/graficos/:id", async (req, res) => {
  res.json(await datosGrafico(req.params.id));
});

rutaAdmin.get("/admin/ingestas", async (_req, res) => {
  res.json(
    await consultar(
      `SELECT i.id, i.origen, c.nombre AS cliente, i.recibidos, i.aceptados, i.rechazados, i.errores, i.creado_en
       FROM ingestas i LEFT JOIN clientes_api c ON c.id = i.cliente_id
       ORDER BY i.creado_en DESC LIMIT 20`,
    ),
  );
});

rutaAdmin.get("/admin/consultas", async (_req, res) => {
  res.json(
    await consultar(
      `SELECT c.id, c.texto, c.cantidad_resultados, c.latencia_ms, c.creado_en, m.nombre AS modelo,
              (SELECT p.nombre FROM consulta_resultados r JOIN productos p ON p.id = r.producto_id
                WHERE r.consulta_id = c.id AND r.posicion = 1) AS primer_resultado,
              (SELECT p.nombre || ' (' || r.posicion || '°)' FROM consulta_clics k
                 JOIN consulta_resultados r ON r.consulta_id = k.consulta_id AND r.producto_id = k.producto_id
                 JOIN productos p ON p.id = k.producto_id
                WHERE k.consulta_id = c.id ORDER BY k.creado_en, k.id LIMIT 1) AS producto_abierto
       FROM consultas c JOIN modelos_embedding m ON m.id = c.modelo_id
       ORDER BY c.creado_en DESC LIMIT 30`,
    ),
  );
});

// ---------------------------------------------------------------- agente

const SISTEMA = `Eres el analista de AgenTech para una ferretería y tapicería de Chile.
Recibes UN gráfico del panel administrativo: los HECHOS ya calculados por el sistema (son exactos) y los datos.
Tu tarea es explicárselo al dueño en español de Chile, con "tú", simple y directo.

Reglas:
- Apóyate en los HECHOS y copia sus cifras tal cual. No hagas cálculos nuevos ni compares cifras por tu cuenta.
- No inventes cifras, productos, fechas ni causas. Si sugieres una causa, di que es una posibilidad.
- Si un período está marcado como incompleto, no lo trates como una caída.
- Si los datos están vacíos o son muy pocos, dilo en una frase y sugiere qué falta.
- Formato: un título corto en una línea; luego 2 a 4 viñetas con lo más importante; al final una línea
  que empiece con "Qué hacer:" con una acción concreta para la tienda.
- Máximo 120 palabras. Sin tablas ni encabezados markdown.`;

const clp = new Intl.NumberFormat("es-CL", { style: "currency", currency: "CLP", maximumFractionDigits: 0 });
const pct = (a: number, b: number) => `${Math.round((a / b - 1) * 100)} %`;

// Hechos exactos que el servidor calcula antes de llamar al agente: los modelos pequeños
// se equivocan al comparar cifras, así que solo redactan a partir de esto.
export function hechos(id: string, datos: any[]): string[] {
  if (!datos.length) return ["No hay datos para este gráfico."];
  const h: string[] = [];
  const hoy = new Date().toISOString().slice(0, 10);
  const periodo = "mes" in datos[0] ? "mes" : "dia" in datos[0] ? "dia" : null;
  const medida = ["total", "consultas"].find((k) => k in datos[0]);
  const fmt = (v: number) => (medida === "total" ? clp.format(v) : String(v));

  if (periodo && medida) {
    const serie = datos.map((d) => ({ p: String(d[periodo]), v: Number(d[medida]) }));
    const ultimo = serie[serie.length - 1];
    const incompleto = periodo === "mes" ? ultimo.p === hoy.slice(0, 7) : ultimo.p === hoy;
    if (incompleto) h.push(`El último período (${ultimo.p}) está en curso e incompleto: no se compara.`);
    const completos = incompleto ? serie.slice(0, -1) : serie;
    if (completos.length) {
      const max = completos.reduce((a, b) => (b.v > a.v ? b : a));
      const min = completos.reduce((a, b) => (b.v < a.v ? b : a));
      h.push(`Máximo: ${max.p} con ${fmt(max.v)}. Mínimo: ${min.p} con ${fmt(min.v)}.`);
      const suma = completos.reduce((a, b) => a + b.v, 0);
      h.push(`Promedio por ${periodo === "mes" ? "mes" : "día"}: ${fmt(Math.round(suma / completos.length))}.`);
    }
    if (completos.length >= 2) {
      const [pen, ult] = completos.slice(-2);
      h.push(`Último período completo ${ult.p}: ${fmt(ult.v)}, ${ult.v >= pen.v ? "sube" : "baja"} ${pct(ult.v, pen.v)} frente a ${pen.p}.`);
      const primero = completos[0];
      if (primero.v > 0) h.push(`Desde ${primero.p} hasta ${ult.p} pasó de ${fmt(primero.v)} a ${fmt(ult.v)}.`);
      if (periodo === "mes") {
        const subidas = completos.slice(1).filter((x, i) => x.v >= completos[i].v).length;
        h.push(`Meses que subieron respecto del anterior: ${subidas} de ${completos.length - 1}.`);
      }
    }
  } else if (medida === "total" && ("categoria" in datos[0] || "nombre" in datos[0])) {
    const etiqueta = "categoria" in datos[0] ? "categoria" : "nombre";
    const total = datos.reduce((a, d) => a + Number(d.total), 0);
    h.push(`Suma de lo mostrado: ${clp.format(total)}.`);
    datos.slice(0, 3).forEach((d, i) =>
      h.push(`Puesto ${i + 1}: ${d[etiqueta]} con ${clp.format(d.total)} (${Math.round((d.total / total) * 100)} % de lo mostrado).`));
    if ("stock" in datos[0]) {
      const sinStock = datos.filter((d) => Number(d.stock) <= 0).map((d) => d.nombre);
      if (sinStock.length) h.push(`De estos, sin stock hoy: ${sinStock.join(", ")}.`);
    }
  } else if (id === "stock_por_categoria") {
    const con = datos.reduce((a, d) => a + Number(d.con_stock), 0);
    const sin = datos.reduce((a, d) => a + Number(d.sin_stock), 0);
    h.push(`Productos con stock: ${con}; agotados: ${sin} (${Math.round((sin / (con + sin)) * 100)} %).`);
    const proporcion = (d: any) => d.sin_stock / (Number(d.con_stock) + Number(d.sin_stock));
    const peor = [...datos].sort((a, b) => proporcion(b) - proporcion(a))[0];
    h.push(`Categoría con más agotados en proporción: ${peor.categoria} (${peor.sin_stock} de ${Number(peor.con_stock) + Number(peor.sin_stock)}).`);
    h.push(`Mayor valor de inventario: ${datos[0].categoria} con ${clp.format(datos[0].valor_inventario)}.`);
  } else if (id === "riesgo_quiebre") {
    const agotados = datos.filter((d) => Number(d.stock) <= 0);
    h.push(`${datos.length} productos que se venden tienen stock para menos de 14 días; ${agotados.length} ya están agotados.`);
    datos.slice(0, 5).forEach((d) => h.push(`${d.nombre}: vende ${d.venta_diaria} por día, stock ${d.stock}, alcanza ${d.dias_de_stock} días.`));
  } else if (id === "busquedas_sin_resultados") {
    datos.slice(0, 5).forEach((d) => h.push(`"${d.busqueda}": ${d.veces} veces sin resultado.`));
  }
  return h;
}

const cache = new Map<string, { texto: string; generado_en: string; latencia_ms: number }>();

rutaAdmin.post("/admin/interpretar", async (req, res) => {
  const { grafico } = z.object({ grafico: z.string() }).parse(req.body);
  const g = await datosGrafico(grafico);
  const datosJson = JSON.stringify(g.datos.slice(0, 60));
  const clave = createHash("sha1").update(grafico + datosJson + config.modeloAgente).digest("hex");
  const guardada = cache.get(clave);
  if (guardada) {
    res.json({ grafico, modelo: config.modeloAgente, desde_cache: true, ...guardada });
    return;
  }
  const inicio = performance.now();
  const hoy = new Date().toISOString().slice(0, 10);
  const texto = await conversar(
    SISTEMA,
    `Fecha de hoy: ${hoy}\nGráfico: ${g.titulo}\nQué mide: ${g.descripcion}\n\nHECHOS:\n- ${hechos(grafico, g.datos).join("\n- ")}\n\nDatos (JSON):\n${datosJson}`,
  );
  const resultado = { texto, generado_en: new Date().toISOString(), latencia_ms: Math.round(performance.now() - inicio) };
  cache.set(clave, resultado);
  res.json({ grafico, modelo: config.modeloAgente, desde_cache: false, ...resultado });
});
