-- Carga inicial del catálogo exportado desde Bsale (db/seed/catalogo_bsale.csv).
-- El reporte no trae precio ni stock: quedan en NULL y 0 hasta la primera ingesta.

CREATE TEMP TABLE catalogo_bsale (
    sku              text,
    codigo_barras    text,
    nombre           text,
    categoria        text,
    marca            text,
    unidad_medida    text,
    permite_decimal  boolean,
    creado_en        timestamp,
    activo           boolean
);

COPY catalogo_bsale FROM '/seed/catalogo_bsale.csv' WITH (FORMAT csv, HEADER true);

-- "electricidad" viene en minúscula y "Sin Tipo" no es una categoría real
UPDATE catalogo_bsale
SET categoria = CASE
        WHEN categoria = 'Sin Tipo' THEN NULL
        ELSE upper(left(categoria, 1)) || substr(categoria, 2)
    END;

INSERT INTO categorias (nombre)
SELECT DISTINCT categoria
FROM catalogo_bsale
WHERE categoria IS NOT NULL
ORDER BY categoria;

INSERT INTO marcas (nombre)
SELECT DISTINCT ON (lower(marca)) marca
FROM catalogo_bsale
WHERE marca IS NOT NULL
ORDER BY lower(marca), marca;

INSERT INTO productos (
    sku, codigo_barras, nombre, categoria_id, marca_id, unidad_medida,
    permite_decimal, activo, creado_en, actualizado_en, contenido_actualizado_en
)
SELECT cb.sku,
       nullif(cb.codigo_barras, ''),
       cb.nombre,
       c.id,
       m.id,
       cb.unidad_medida,
       cb.permite_decimal,
       cb.activo,
       cb.creado_en AT TIME ZONE 'America/Santiago',
       now(),
       now()
FROM catalogo_bsale cb
LEFT JOIN categorias c ON c.nombre = cb.categoria
LEFT JOIN marcas m     ON lower(m.nombre) = lower(cb.marca)
ORDER BY cb.nombre;

DROP TABLE catalogo_bsale;
