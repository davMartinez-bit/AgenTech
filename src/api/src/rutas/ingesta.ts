import { Router } from "express";
import { z } from "zod";
import { pool } from "../db.js";
import { ErrorApi } from "../errores.js";

// Historia 1: el sistema externo (POS, ERP o el script de Bsale) envía el catálogo
// y la API lo valida y lo guarda. Los registros malos se rechazan uno a uno sin frenar al resto.

const productoIngesta = z.object({
  sku: z.string().trim().min(1, "El SKU es obligatorio").max(40),
  nombre: z.string().trim().min(1, "El nombre es obligatorio").max(200),
  precio: z.number({ error: "El precio es obligatorio y debe ser numérico" }).nonnegative("El precio no puede ser negativo"),
  stock: z.number({ error: "El stock es obligatorio y debe ser numérico" }),
  categoria: z.string().trim().max(60).nullish(),
  marca: z.string().trim().max(80).nullish(),
  codigo_barras: z.string().trim().max(40).nullish(),
  unidad_medida: z.string().trim().max(20).nullish(),
  descripcion: z.string().nullish(),
  permite_decimal: z.boolean().nullish(),
  bsale_variante_id: z.number().int().nullish(),
});

const cuerpoIngesta = z.object({
  origen: z.string().trim().min(1).max(40).default("api"),
  cliente: z.string().trim().optional(),
  productos: z.array(z.unknown()).min(1, "Debe enviar al menos un producto").max(10000),
});

type Detalle = { posicion: number; sku: string | null; producto_id: number | null; estado: "aceptado" | "rechazado"; motivo?: string };

export const rutaIngesta = Router();

rutaIngesta.post("/ingesta", async (req, res) => {
  const cuerpo = cuerpoIngesta.parse(req.body);
  const cli = await pool.connect();
  try {
    const nombreCliente = cuerpo.cliente ?? "Carga inicial desde Bsale";
    const filaCliente = await cli.query("SELECT id FROM clientes_api WHERE nombre = $1 AND activo", [nombreCliente]);
    if (!filaCliente.rowCount) throw new ErrorApi(403, "cliente_desconocido", `El cliente "${nombreCliente}" no está registrado o está inactivo.`);
    const clienteId = filaCliente.rows[0].id;

    await cli.query("BEGIN");
    const detalle: Detalle[] = [];
    const cacheCategorias = new Map<string, number>();
    const cacheMarcas = new Map<string, number>();

    for (const [i, crudo] of cuerpo.productos.entries()) {
      const posicion = i + 1;
      const validado = productoIngesta.safeParse(crudo);
      const skuCrudo = typeof (crudo as any)?.sku === "string" ? (crudo as any).sku.slice(0, 40) : null;
      if (!validado.success) {
        const motivo = validado.error.issues.map((x) => `${x.path.join(".") || "registro"}: ${x.message}`).join("; ");
        detalle.push({ posicion, sku: skuCrudo, producto_id: null, estado: "rechazado", motivo });
        continue;
      }
      const p = validado.data;
      await cli.query("SAVEPOINT fila");
      try {
        const categoriaId = p.categoria ? await idCategoria(cli, cacheCategorias, p.categoria) : null;
        const marcaId = p.marca ? await idMarca(cli, cacheMarcas, p.marca) : null;
        const { rows } = await cli.query(
          `INSERT INTO productos (sku, nombre, precio, stock, categoria_id, marca_id, codigo_barras,
                                  unidad_medida, descripcion, permite_decimal, bsale_variante_id)
           VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, coalesce($10, false), $11)
           ON CONFLICT (sku) DO UPDATE SET
               nombre            = EXCLUDED.nombre,
               precio            = EXCLUDED.precio,
               stock             = EXCLUDED.stock,
               categoria_id      = coalesce(EXCLUDED.categoria_id, productos.categoria_id),
               marca_id          = coalesce(EXCLUDED.marca_id, productos.marca_id),
               codigo_barras     = coalesce(EXCLUDED.codigo_barras, productos.codigo_barras),
               unidad_medida     = coalesce(EXCLUDED.unidad_medida, productos.unidad_medida),
               descripcion       = coalesce(EXCLUDED.descripcion, productos.descripcion),
               permite_decimal   = coalesce($10, productos.permite_decimal),
               bsale_variante_id = coalesce(EXCLUDED.bsale_variante_id, productos.bsale_variante_id),
               activo            = true
           RETURNING id`,
          [p.sku, p.nombre, p.precio, p.stock, categoriaId, marcaId, p.codigo_barras ?? null,
           p.unidad_medida ?? null, p.descripcion ?? null, p.permite_decimal ?? null, p.bsale_variante_id ?? null],
        );
        await cli.query("RELEASE SAVEPOINT fila");
        detalle.push({ posicion, sku: p.sku, producto_id: rows[0].id, estado: "aceptado" });
      } catch (e: any) {
        await cli.query("ROLLBACK TO SAVEPOINT fila");
        const motivo = e.code === "23505" ? `Valor duplicado (${e.constraint})` : `No se pudo guardar: ${e.message}`;
        detalle.push({ posicion, sku: p.sku, producto_id: null, estado: "rechazado", motivo });
      }
    }

    const aceptados = detalle.filter((d) => d.estado === "aceptado").length;
    const rechazados = detalle.length - aceptados;
    const errores = detalle.filter((d) => d.estado === "rechazado").map(({ posicion, sku, motivo }) => ({ posicion, sku, motivo }));
    const { rows } = await cli.query(
      `INSERT INTO ingestas (origen, recibidos, aceptados, rechazados, errores, cliente_id)
       VALUES ($1, $2, $3, $4, $5, $6) RETURNING id, creado_en`,
      [cuerpo.origen, detalle.length, aceptados, rechazados, JSON.stringify(errores), clienteId],
    );
    const ingestaId = rows[0].id;
    await cli.query(
      `INSERT INTO ingesta_detalle (ingesta_id, posicion, sku, producto_id, estado, motivo)
       SELECT $1, d.posicion, d.sku, d.producto_id, d.estado, d.motivo
       FROM jsonb_to_recordset($2::jsonb) AS d(posicion int, sku varchar, producto_id bigint, estado varchar, motivo text)`,
      [ingestaId, JSON.stringify(detalle)],
    );
    await cli.query("UPDATE clientes_api SET ultimo_uso_en = now() WHERE id = $1", [clienteId]);
    await cli.query("COMMIT");

    res.status(rechazados && !aceptados ? 422 : 201).json({
      ingesta_id: ingestaId,
      creado_en: rows[0].creado_en,
      recibidos: detalle.length,
      aceptados,
      rechazados,
      errores,
    });
  } catch (e) {
    await cli.query("ROLLBACK").catch(() => {});
    throw e;
  } finally {
    cli.release();
  }
});

async function idCategoria(cli: any, cache: Map<string, number>, nombre: string) {
  const clave = nombre.toLowerCase();
  if (cache.has(clave)) return cache.get(clave)!;
  const existente = await cli.query("SELECT id FROM categorias WHERE lower(nombre) = lower($1)", [nombre]);
  const id = existente.rowCount
    ? existente.rows[0].id
    : (await cli.query("INSERT INTO categorias (nombre) VALUES ($1) RETURNING id", [nombre])).rows[0].id;
  cache.set(clave, id);
  return id as number;
}

async function idMarca(cli: any, cache: Map<string, number>, nombre: string) {
  const clave = nombre.toLowerCase();
  if (cache.has(clave)) return cache.get(clave)!;
  const existente = await cli.query("SELECT id FROM marcas WHERE lower(nombre) = lower($1)", [nombre]);
  const id = existente.rowCount
    ? existente.rows[0].id
    : (await cli.query("INSERT INTO marcas (nombre) VALUES ($1) RETURNING id", [nombre])).rows[0].id;
  cache.set(clave, id);
  return id as number;
}
