-- Recomendaciones para el vendedor: alternativas con stock y venta cruzada.
-- Se puede aplicar sobre una base ya creada.

-- Alternativas: los productos con stock más parecidos por significado a uno dado.
-- Sirve sobre todo cuando el producto que pide el cliente está agotado.
CREATE OR REPLACE FUNCTION productos_alternativos(p_sku varchar, limite integer DEFAULT 4)
RETURNS TABLE (sku varchar, nombre varchar, categoria varchar, precio numeric, stock numeric, similitud real)
LANGUAGE sql STABLE
SET hnsw.ef_search = 100
AS $$
    WITH origen AS (
        SELECT p.id, e.embedding
        FROM productos p JOIN producto_embeddings e ON e.producto_id = p.id
        WHERE p.sku = p_sku
    )
    SELECT p.sku, p.nombre, c.nombre, p.precio, p.stock, (1 - (e.embedding <=> o.embedding))::real
    FROM origen o
    JOIN producto_embeddings e ON e.producto_id <> o.id
    JOIN productos p           ON p.id = e.producto_id
    LEFT JOIN categorias c     ON c.id = p.categoria_id
    WHERE p.activo AND p.stock > 0
    ORDER BY e.embedding <=> o.embedding
    LIMIT limite;
$$;

-- Venta cruzada: lo que otros clientes compraron en la misma boleta o factura (ventas de Bsale).
-- Se descartan los productos de la misma familia (misma primera palabra del nombre, por ejemplo
-- otro color de la misma tela) porque no son complementos sino variantes.
-- confianza = boletas con ambos / boletas con el producto de origen.
CREATE OR REPLACE FUNCTION productos_complementarios(p_sku varchar, limite integer DEFAULT 4)
RETURNS TABLE (sku varchar, nombre varchar, categoria varchar, precio numeric, stock numeric,
               veces_juntos bigint, confianza real)
LANGUAGE sql STABLE
AS $$
    WITH origen AS (
        SELECT id, lower(split_part(nombre, ' ', 1)) AS familia FROM productos WHERE sku = p_sku
    ),
    boletas AS (
        SELECT DISTINCT d.venta_id
        FROM venta_detalle d JOIN ventas v ON v.id = d.venta_id
        JOIN origen o ON o.id = d.producto_id
        WHERE v.signo = 1
    )
    SELECT p.sku, p.nombre, c.nombre, p.precio, p.stock,
           count(DISTINCT d.venta_id) AS veces_juntos,
           (count(DISTINCT d.venta_id)::real / (SELECT count(*) FROM boletas)) AS confianza
    FROM boletas b
    JOIN venta_detalle d   ON d.venta_id = b.venta_id
    JOIN productos p       ON p.id = d.producto_id
    LEFT JOIN categorias c ON c.id = p.categoria_id
    CROSS JOIN origen o
    WHERE p.id <> o.id
      AND lower(split_part(p.nombre, ' ', 1)) <> o.familia
      AND p.activo AND p.stock > 0
    GROUP BY p.sku, p.nombre, c.nombre, p.precio, p.stock
    HAVING count(DISTINCT d.venta_id) >= 2
    ORDER BY veces_juntos DESC, p.nombre
    LIMIT limite;
$$;

CREATE INDEX IF NOT EXISTS venta_detalle_venta_idx ON venta_detalle (venta_id);
