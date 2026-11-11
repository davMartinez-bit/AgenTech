-- Avisos de inventario del panel administrativo.
-- Agrega las recepciones de stock de Bsale (cuándo entró mercadería) y una vista con la
-- situación de cada producto: ritmo de venta, última venta, última compra y stock estimado.
-- Se puede aplicar sobre una base ya creada: todo usa IF NOT EXISTS / OR REPLACE.

ALTER TABLE sincronizaciones_bsale DROP CONSTRAINT IF EXISTS sincronizaciones_bsale_recurso_check;
ALTER TABLE sincronizaciones_bsale ADD CONSTRAINT sincronizaciones_bsale_recurso_check
    CHECK (recurso IN ('catalogo', 'ventas', 'recepciones'));

-- Una fila por línea de recepción (un producto que entró a bodega).
CREATE TABLE IF NOT EXISTS recepciones_stock (
    id                 bigint PRIMARY KEY,          -- id del detalle de la recepción en Bsale
    recepcion_id       bigint NOT NULL,
    recibido_en        date   NOT NULL,
    sucursal_id        integer,
    bsale_variante_id  integer,
    producto_id        bigint REFERENCES productos (id) ON DELETE SET NULL,
    cantidad           numeric(12, 3) NOT NULL,
    costo              numeric(14, 2),
    sincronizado_en    timestamptz NOT NULL DEFAULT now()
);
CREATE INDEX IF NOT EXISTS recepciones_stock_producto_idx ON recepciones_stock (producto_id, recibido_en);

-- Situación de cada producto activo. El stock de Bsale se lee en cada sincronización del catálogo;
-- mientras esa lectura sea vieja, stock_estimado le descuenta lo vendido después y le suma lo recibido.
CREATE OR REPLACE VIEW productos_situacion AS
WITH corte AS (
    SELECT coalesce(max(terminado_en), now())::date AS dia
    FROM sincronizaciones_bsale WHERE estado = 'ok' AND recurso = 'catalogo'
),
v AS (
    SELECT producto_id,
           coalesce(sum(unidades) FILTER (WHERE dia >= current_date - 30), 0)                             AS unidades_30,
           coalesce(sum(unidades) FILTER (WHERE dia >= current_date - 60 AND dia < current_date - 30), 0) AS unidades_30_previos,
           coalesce(sum(unidades) FILTER (WHERE dia >= current_date - 90), 0)                             AS unidades_90,
           coalesce(sum(total)    FILTER (WHERE dia >= current_date - 90), 0)                             AS total_90,
           coalesce(sum(unidades) FILTER (WHERE dia >= current_date - 365), 0)                            AS unidades_365,
           max(dia) FILTER (WHERE unidades > 0)                                                           AS ultima_venta,
           coalesce(sum(unidades) FILTER (WHERE dia > (SELECT dia FROM corte)), 0)                        AS vendido_desde_corte
    FROM ventas_por_producto
    WHERE producto_id IS NOT NULL
    GROUP BY producto_id
),
r AS (
    SELECT producto_id,
           max(recibido_en)                                                              AS ultima_recepcion,
           coalesce(sum(cantidad) FILTER (WHERE recibido_en > (SELECT dia FROM corte)), 0) AS recibido_desde_corte
    FROM recepciones_stock
    WHERE producto_id IS NOT NULL
    GROUP BY producto_id
)
SELECT p.id AS producto_id,
       p.sku,
       p.nombre,
       c.nombre                              AS categoria,
       p.precio,
       p.stock                               AS stock_bsale,
       (SELECT dia FROM corte)               AS stock_leido_el,
       greatest(greatest(p.stock, 0) - coalesce(v.vendido_desde_corte, 0) + coalesce(r.recibido_desde_corte, 0), 0)
                                             AS stock_estimado,
       coalesce(v.unidades_30, 0)            AS unidades_30,
       coalesce(v.unidades_30_previos, 0)    AS unidades_30_previos,
       coalesce(v.unidades_90, 0)            AS unidades_90,
       coalesce(v.total_90, 0)               AS total_90,
       coalesce(v.unidades_365, 0)           AS unidades_365,
       v.ultima_venta,
       current_date - v.ultima_venta         AS dias_sin_vender,
       r.ultima_recepcion,
       current_date - r.ultima_recepcion     AS dias_sin_comprar,
       coalesce(v.vendido_desde_corte, 0)    AS vendido_desde_corte
FROM productos p
LEFT JOIN categorias c ON c.id = p.categoria_id
LEFT JOIN v ON v.producto_id = p.id
LEFT JOIN r ON r.producto_id = p.id
WHERE p.activo;
