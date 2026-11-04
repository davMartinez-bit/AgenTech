-- Modelo de embeddings elegido en T07 y búsqueda híbrida (T09).
-- Se puede aplicar sobre una base ya creada.

-- nomic-embed-text-v2-moe ganó la comparación del 03-11-2026 (src/worker/resultados/evaluacion_modelos.md).
INSERT INTO modelos_embedding (nombre, dimensiones, proveedor)
VALUES ('nomic-embed-text-v2-moe', 768, 'Ollama')
ON CONFLICT (nombre) DO NOTHING;

-- Búsqueda híbrida: filtro duro (activo y stock > 0) + puntaje que combina la similitud semántica
-- con la coincidencia de palabras del nombre (pg_trgm). La parte de texto ayuda cuando el vendedor
-- escribe el nombre técnico o una palabra compuesta ("tapar goteras" -> "Tapagoteras"); la semántica,
-- cuando lo dice como el cliente. Candidatos: los 60 vecinos más cercanos por vector (índice HNSW)
-- más los 20 nombres más parecidos por texto. Pasa un producto si su similitud semántica supera
-- similitud_minima, o si el texto coincide bien (>= 0,4) y la semántica no es lejana (>= 0,2).
DROP FUNCTION IF EXISTS buscar_productos_hibrida(vector, text, integer, real, real);
CREATE FUNCTION buscar_productos_hibrida(
    consulta         vector(768),
    texto            text,
    limite           integer DEFAULT 10,
    similitud_minima real    DEFAULT 0.32,
    peso_texto       real    DEFAULT 0.15
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
    WITH por_vector AS (
        SELECT e.producto_id
        FROM producto_embeddings e
        JOIN productos p ON p.id = e.producto_id
        WHERE p.activo AND p.stock > 0
        ORDER BY e.embedding <=> consulta
        LIMIT 60
    ),
    por_texto AS (
        SELECT p.id AS producto_id
        FROM productos p
        WHERE p.activo AND p.stock > 0
        ORDER BY word_similarity(lower(texto), lower(p.nombre)) DESC
        LIMIT 20
    ),
    candidatos AS (
        SELECT p.id, p.sku, p.nombre, c.nombre AS categoria, p.precio, p.stock,
               (1 - (e.embedding <=> consulta))::real                  AS similitud,
               word_similarity(lower(texto), lower(p.nombre))::real     AS sim_texto
        FROM (SELECT producto_id FROM por_vector UNION SELECT producto_id FROM por_texto) k
        JOIN productos p             ON p.id = k.producto_id
        JOIN producto_embeddings e   ON e.producto_id = p.id
        LEFT JOIN categorias c       ON c.id = p.categoria_id
    )
    SELECT id, sku, nombre, categoria, precio, stock, similitud,
           ((1 - peso_texto) * similitud + peso_texto * sim_texto)::real AS puntaje
    FROM candidatos
    WHERE similitud >= similitud_minima
       OR (sim_texto >= 0.4 AND similitud >= 0.2)
    ORDER BY puntaje DESC
    LIMIT limite;
$$;
