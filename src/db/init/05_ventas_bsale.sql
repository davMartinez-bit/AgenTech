-- Ventas leídas desde Bsale (solo lectura) para los gráficos del panel administrativo.
-- No se guardan datos de clientes: solo fecha, tipo de documento, montos y productos vendidos.
-- Se puede aplicar sobre una base ya creada: todo usa IF NOT EXISTS / OR REPLACE.

CREATE TABLE IF NOT EXISTS ventas (
    id              bigint PRIMARY KEY,          -- id del documento en Bsale
    tipo_documento  varchar(60) NOT NULL,
    signo           smallint NOT NULL CHECK (signo IN (-1, 1)),  -- -1 = nota de crédito
    numero          bigint,
    emitido_en      date NOT NULL,
    sucursal_id     integer,
    neto            numeric(14, 2) NOT NULL DEFAULT 0,
    total           numeric(14, 2) NOT NULL DEFAULT 0,
    sincronizado_en timestamptz NOT NULL DEFAULT now()
);
CREATE INDEX IF NOT EXISTS ventas_emitido_idx ON ventas (emitido_en);

CREATE TABLE IF NOT EXISTS venta_detalle (
    venta_id           bigint   NOT NULL REFERENCES ventas (id) ON DELETE CASCADE,
    linea              smallint NOT NULL,
    bsale_variante_id  integer,
    producto_id        bigint REFERENCES productos (id) ON DELETE SET NULL,
    cantidad           numeric(12, 3) NOT NULL,
    neto               numeric(14, 2) NOT NULL DEFAULT 0,
    total              numeric(14, 2) NOT NULL DEFAULT 0,
    PRIMARY KEY (venta_id, linea)
);
CREATE INDEX IF NOT EXISTS venta_detalle_producto_idx ON venta_detalle (producto_id);

CREATE TABLE IF NOT EXISTS sincronizaciones_bsale (
    id            bigserial PRIMARY KEY,
    recurso       varchar(20) NOT NULL CHECK (recurso IN ('catalogo', 'ventas')),
    iniciado_en   timestamptz NOT NULL DEFAULT now(),
    terminado_en  timestamptz,
    registros     integer NOT NULL DEFAULT 0,
    estado        varchar(10) NOT NULL DEFAULT 'en_curso' CHECK (estado IN ('en_curso', 'ok', 'error')),
    mensaje       text
);

-- Montos con signo: las notas de crédito restan.
CREATE OR REPLACE VIEW ventas_por_dia AS
SELECT emitido_en AS dia,
       count(*) FILTER (WHERE signo = 1)  AS documentos,
       sum(signo * total)                 AS total,
       sum(signo * neto)                  AS neto
FROM ventas
GROUP BY emitido_en;

CREATE OR REPLACE VIEW ventas_por_producto AS
SELECT d.producto_id,
       p.sku,
       p.nombre,
       c.nombre                    AS categoria,
       v.emitido_en                AS dia,
       sum(v.signo * d.cantidad)   AS unidades,
       sum(v.signo * d.total)      AS total
FROM venta_detalle d
JOIN ventas v           ON v.id = d.venta_id
LEFT JOIN productos p   ON p.id = d.producto_id
LEFT JOIN categorias c  ON c.id = p.categoria_id
GROUP BY d.producto_id, p.sku, p.nombre, c.nombre, v.emitido_en;
