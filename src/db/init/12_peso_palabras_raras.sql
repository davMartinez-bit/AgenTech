-- T32: en la lista de texto completo, una palabra rara del catálogo pesa más que una común.
-- Hasta ahora 'cocina' (está en el nombre de 20 pernos) pesaba igual que 'desagüe' (está en 2 productos).
-- Una palabra que no aparece en ningún producto no distingue productos y pesa lo mínimo.

-- Frecuencia de cada lexema en los productos activos. Se recalcula con actualizar_lexemas_busqueda().
CREATE TABLE IF NOT EXISTS lexemas_busqueda (
    lexema     text PRIMARY KEY,
    productos  integer NOT NULL      -- en cuántos productos activos aparece
);

CREATE OR REPLACE FUNCTION actualizar_lexemas_busqueda() RETURNS integer
LANGUAGE plpgsql
AS $$
BEGIN
    DELETE FROM lexemas_busqueda;
    INSERT INTO lexemas_busqueda (lexema, productos)
    SELECT word, ndoc
    FROM ts_stat('SELECT b.documento FROM producto_busqueda b JOIN productos p ON p.id = b.producto_id WHERE p.activo');
    RETURN (SELECT count(*) FROM lexemas_busqueda);
END;
$$;

SELECT actualizar_lexemas_busqueda();

-- buscar_productos_fusion con pesos por rareza de palabra.
-- peso_rareza: 0 hace que todas las palabras pesen igual (comportamiento anterior); más alto da más peso a las raras.
-- peso_descripcion: valor de una palabra que aparece solo en la descripción de uso.
-- Con peso_rareza = 0 y peso_descripcion = 0.3, el resultado es idéntico al del script 09.
DROP FUNCTION IF EXISTS buscar_productos_fusion(vector, text, integer, real, integer, real, real);
DROP FUNCTION IF EXISTS buscar_productos_fusion(vector, text, integer, real, integer, real, real, real, real);
CREATE FUNCTION buscar_productos_fusion(
    consulta         vector(768),
    texto            text,
    limite           integer DEFAULT 10,
    similitud_minima real    DEFAULT 0.32,
    k                integer DEFAULT 20,     -- constante de RRF: más alta = las posiciones pesan más parejo
    peso_texto       real    DEFAULT 1.0,
    peso_trigrama    real    DEFAULT 0.5,
    peso_rareza      real    DEFAULT 1.0,    -- 0 = todas las palabras pesan igual (como antes); más alto = las raras pesan más
    peso_descripcion real    DEFAULT 0.3     -- cuánto vale una palabra que solo está en la descripción de uso
)
RETURNS TABLE (
    producto_id  bigint,
    sku          varchar,
    nombre       varchar,
    categoria    varchar,
    precio       numeric,
    stock        numeric,
    similitud    real,
    puntaje      real
)
LANGUAGE sql STABLE
SET hnsw.ef_search = 100
AS $$
    WITH q AS (
        SELECT normalizar_busqueda(texto) AS t,
               plainto_tsquery('spanish', normalizar_busqueda(texto)) AS todas,
               NULLIF(replace(plainto_tsquery('spanish', normalizar_busqueda(texto))::text, '&', '|'), '')::tsquery AS alguna,
               tsvector_to_array(to_tsvector('spanish', normalizar_busqueda(texto))) AS lexemas
    ),
    pesos AS (
        SELECT l.lexema,
               power(ln(1.0 + n.total / COALESCE(f.productos, n.total)::float8), peso_rareza) AS peso
        FROM q
        CROSS JOIN LATERAL unnest(q.lexemas) AS l(lexema)
        CROSS JOIN (SELECT GREATEST(count(*), 1)::float8 AS total FROM producto_busqueda) n
        LEFT JOIN lexemas_busqueda f ON f.lexema = l.lexema
    ),
    por_vector AS (
        SELECT e.producto_id, row_number() OVER (ORDER BY e.embedding <=> consulta) AS pos
        FROM producto_embeddings e
        JOIN productos p ON p.id = e.producto_id
        WHERE p.activo AND p.stock > 0
        ORDER BY e.embedding <=> consulta
        LIMIT 60
    ),
    por_texto AS (
        SELECT x.producto_id, x.cobertura,
               row_number() OVER (ORDER BY x.cobertura DESC, x.rango DESC, x.producto_id) AS pos
        FROM (
            SELECT b.producto_id, ts_rank(b.documento, q.alguna) AS rango,
                   (SELECT sum(w.peso * CASE WHEN b.documento @@ (quote_literal(w.lexema) || ':A')::tsquery THEN 1.0
                                             WHEN b.documento @@ (quote_literal(w.lexema) || ':B')::tsquery THEN 0.6
                                             WHEN b.documento @@ (quote_literal(w.lexema) || ':C')::tsquery THEN peso_descripcion
                                             ELSE 0 END) / NULLIF(sum(w.peso), 0)
                    FROM pesos w)::real AS cobertura
            FROM q
            JOIN producto_busqueda b ON b.documento @@ q.alguna
            JOIN productos p ON p.id = b.producto_id
            WHERE p.activo AND p.stock > 0
        ) x
        ORDER BY x.cobertura DESC, x.rango DESC, x.producto_id
        LIMIT 40
    ),
    por_trigrama AS (
        SELECT b.producto_id, word_similarity(q.t, b.nombre_normalizado) AS parecido,
               row_number() OVER (ORDER BY word_similarity(q.t, b.nombre_normalizado) DESC, b.producto_id) AS pos
        FROM q
        JOIN producto_busqueda b ON word_similarity(q.t, b.nombre_normalizado) >= 0.3
        JOIN productos p ON p.id = b.producto_id
        WHERE p.activo AND p.stock > 0
        ORDER BY word_similarity(q.t, b.nombre_normalizado) DESC, b.producto_id
        LIMIT 20
    ),
    fusion AS (
        SELECT u.producto_id, sum(u.peso / (k + u.pos)) AS rrf
        FROM (
            SELECT producto_id, pos, 1.0::real AS peso FROM por_vector
            UNION ALL SELECT producto_id, pos, peso_texto * cobertura * cobertura FROM por_texto
            UNION ALL SELECT producto_id, pos, peso_trigrama * parecido FROM por_trigrama
        ) u
        GROUP BY u.producto_id
    ),
    candidatos AS (
        SELECT p.id, p.sku, p.nombre, c.nombre AS categoria, p.precio, p.stock, f.rrf,
               (1 - (e.embedding <=> consulta))::real AS similitud,
               (numnode(q.todas) > 0 AND b.documento @@ q.todas) AS todas_las_palabras,
               word_similarity(q.t, b.nombre_normalizado) AS sim_nombre
        FROM fusion f
        JOIN productos p           ON p.id = f.producto_id
        JOIN producto_embeddings e ON e.producto_id = p.id
        JOIN producto_busqueda b   ON b.producto_id = p.id
        LEFT JOIN categorias c     ON c.id = p.categoria_id
        CROSS JOIN q
    )
    SELECT id, sku, nombre, categoria, precio, stock, similitud,
           -- 1,0 = primero en las tres listas
           (rrf * (k + 1) / (1.0 + peso_texto + peso_trigrama))::real AS puntaje
    FROM candidatos
    WHERE similitud >= similitud_minima
       OR (similitud >= 0.2 AND (todas_las_palabras OR sim_nombre >= 0.5))
    ORDER BY rrf DESC, similitud DESC
    LIMIT limite;
$$;
