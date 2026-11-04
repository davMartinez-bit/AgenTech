import { existsSync, readdirSync } from "node:fs";
import { Router } from "express";
import { z } from "zod";
import { config } from "../config.js";
import { consultar } from "../db.js";
import { ErrorApi } from "../errores.js";

// Catálogo para el panel del vendedor (misma vista que el e-commerce: foto, precio, stock).

const fotos = new Set<string>(
  config.fotosDir && existsSync(config.fotosDir)
    ? readdirSync(config.fotosDir).filter((f) => f.toLowerCase().endsWith(".jpg")).map((f) => f.slice(0, -4))
    : [],
);

export function urlFoto(sku: string): string | null {
  return fotos.has(sku) ? `/fotos/${encodeURIComponent(sku)}.jpg` : null;
}

const filtros = z.object({
  q: z.string().trim().optional(),
  categoria: z.string().trim().optional(),
  disponibles: z.enum(["true", "false"]).optional(),
  orden: z.enum(["nombre", "precio_asc", "precio_desc", "stock"]).default("nombre"),
  pagina: z.coerce.number().int().min(1).default(1),
  por_pagina: z.coerce.number().int().min(1).max(100).default(24),
});

const ORDEN: Record<string, string> = {
  nombre: "p.nombre",
  precio_asc: "p.precio NULLS LAST",
  precio_desc: "p.precio DESC NULLS LAST",
  stock: "p.stock DESC",
};

export const rutaProductos = Router();

rutaProductos.get("/productos", async (req, res) => {
  const f = filtros.parse(req.query);
  const params: unknown[] = [];
  const where = ["p.activo"];
  if (f.q) {
    params.push(`%${f.q}%`, f.q);
    where.push(`(p.nombre ILIKE $${params.length - 1} OR p.sku = $${params.length} OR p.nombre % $${params.length})`);
  }
  if (f.categoria) {
    params.push(f.categoria);
    where.push(`c.nombre = $${params.length}`);
  }
  if (f.disponibles === "true") where.push("p.stock > 0");
  params.push(f.por_pagina, (f.pagina - 1) * f.por_pagina);

  const filas = await consultar(
    `SELECT p.sku, p.nombre, c.nombre AS categoria, m.nombre AS marca, p.precio, p.stock, p.unidad_medida,
            count(*) OVER () AS total
     FROM productos p
     LEFT JOIN categorias c ON c.id = p.categoria_id
     LEFT JOIN marcas m ON m.id = p.marca_id
     WHERE ${where.join(" AND ")}
     ORDER BY ${ORDEN[f.orden]}, p.id
     LIMIT $${params.length - 1} OFFSET $${params.length}`,
    params,
  );
  res.json({
    total: filas[0]?.total ?? 0,
    pagina: f.pagina,
    por_pagina: f.por_pagina,
    productos: filas.map(({ total, ...p }) => ({ ...p, foto: urlFoto(p.sku) })),
  });
});

rutaProductos.get("/productos/:sku", async (req, res) => {
  const [p] = await consultar(
    `SELECT p.sku, p.codigo_barras, p.nombre, p.descripcion, c.nombre AS categoria, m.nombre AS marca,
            p.precio, p.stock, p.unidad_medida, p.permite_decimal, p.actualizado_en
     FROM productos p
     LEFT JOIN categorias c ON c.id = p.categoria_id
     LEFT JOIN marcas m ON m.id = p.marca_id
     WHERE p.sku = $1`,
    [req.params.sku],
  );
  if (!p) throw new ErrorApi(404, "producto_no_encontrado", `No existe un producto con SKU ${req.params.sku}.`);
  res.json({ ...p, foto: urlFoto(p.sku) });
});

const limite = z.coerce.number().int().min(1).max(12).default(4);

// Alternativas con stock (lo más parecido por significado): para ofrecer cuando el producto está agotado.
rutaProductos.get("/productos/:sku/alternativas", async (req, res) => {
  const filas = await consultar(
    "SELECT sku, nombre, categoria, precio, stock, similitud FROM productos_alternativos($1, $2)",
    [req.params.sku, limite.parse(req.query.limite)],
  );
  res.json(filas.map((p) => ({ ...p, similitud: Math.round(p.similitud * 1000) / 1000, foto: urlFoto(p.sku) })));
});

// Venta cruzada: lo que otros clientes llevaron en la misma boleta o factura (ventas reales de Bsale).
rutaProductos.get("/productos/:sku/complementos", async (req, res) => {
  const filas = await consultar(
    "SELECT sku, nombre, categoria, precio, stock, veces_juntos, confianza FROM productos_complementarios($1, $2)",
    [req.params.sku, limite.parse(req.query.limite)],
  );
  res.json(filas.map((p) => ({ ...p, confianza: Math.round(p.confianza * 100) / 100, foto: urlFoto(p.sku) })));
});

rutaProductos.get("/categorias", async (_req, res) => {
  res.json(
    await consultar(
      `SELECT c.nombre, count(p.id) AS productos, count(p.id) FILTER (WHERE p.stock > 0) AS disponibles
       FROM categorias c JOIN productos p ON p.categoria_id = c.id AND p.activo
       GROUP BY c.nombre ORDER BY c.nombre`,
    ),
  );
});
