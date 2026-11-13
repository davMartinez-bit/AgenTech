-- Frases de cliente: cómo se pide cada producto en el mostrador.
--
-- El vector de un producto sale de su nombre y su descripción. Sirve cuando la consulta se parece a
-- esa ficha, y falla cuando el vendedor escribe el problema del cliente ("se me suelta la pata de la
-- silla") con palabras que la ficha no tiene. Aquí se guarda un segundo índice: conversaciones de
-- mostrador (lo que dice el cliente, cómo lo escribiría el vendedor, qué productos lo resuelven y qué
-- contestaría un buen vendedor). Cada frase tiene su vector, y la búsqueda compara la consulta contra
-- esas frases además de contra las fichas: una consulta parecida a una frase conocida trae los
-- productos de esa conversación.
--
-- Las conversaciones del conjunto 'prueba' no se vectorizan: quedan para medir la búsqueda con frases
-- que el índice nunca vio.

CREATE TABLE IF NOT EXISTS conversaciones_mostrador (
    id        bigserial PRIMARY KEY,
    clave     text        NOT NULL UNIQUE,          -- identificador estable del archivo de origen
    cliente   text        NOT NULL,                 -- lo que dice el cliente
    respuesta text        NOT NULL,                 -- lo que contesta el vendedor
    tipo      text        NOT NULL,
    origen    text        NOT NULL DEFAULT 'simulada' CHECK (origen IN ('simulada', 'real')),
    conjunto  text        NOT NULL DEFAULT 'indice'   CHECK (conjunto IN ('indice', 'prueba')),
    creado_en timestamptz NOT NULL DEFAULT now()
);

CREATE TABLE IF NOT EXISTS conversacion_productos (
    conversacion_id bigint NOT NULL REFERENCES conversaciones_mostrador (id) ON DELETE CASCADE,
    producto_id     bigint NOT NULL REFERENCES productos (id) ON DELETE CASCADE,
    PRIMARY KEY (conversacion_id, producto_id)
);
CREATE INDEX IF NOT EXISTS conversacion_productos_producto_idx ON conversacion_productos (producto_id);

CREATE TABLE IF NOT EXISTS frases_cliente (
    id                       bigserial PRIMARY KEY,
    conversacion_id          bigint      NOT NULL REFERENCES conversaciones_mostrador (id) ON DELETE CASCADE,
    texto                    text        NOT NULL,
    clase                    text        NOT NULL DEFAULT 'consulta' CHECK (clase IN ('consulta', 'cliente')),
    contenido_actualizado_en timestamptz NOT NULL DEFAULT now(),
    UNIQUE (conversacion_id, texto)
);

CREATE TABLE IF NOT EXISTS frase_embeddings (
    frase_id     bigint      PRIMARY KEY REFERENCES frases_cliente (id) ON DELETE CASCADE,
    modelo_id    smallint    NOT NULL REFERENCES modelos_embedding (id),
    texto_fuente text        NOT NULL,
    embedding    vector(768) NOT NULL,
    generado_en  timestamptz NOT NULL DEFAULT now()
);
CREATE INDEX IF NOT EXISTS frase_embeddings_hnsw_idx ON frase_embeddings USING hnsw (embedding vector_cosine_ops);

-- Cola de frases por vectorizar. El texto pasa por expandir_consulta, igual que la consulta del
-- vendedor, para que las dos partes se comparen con las mismas palabras. Si cambia el diccionario de
-- sinónimos hay que revectorizar las frases (vectorizar.py --frases --todo).
CREATE OR REPLACE VIEW frases_pendientes_embedding AS
SELECT f.id AS frase_id, expandir_consulta(f.texto) AS texto
FROM frases_cliente f
JOIN conversaciones_mostrador c ON c.id = f.conversacion_id
LEFT JOIN frase_embeddings e ON e.frase_id = f.id
WHERE c.conjunto = 'indice'
  AND (e.frase_id IS NULL OR e.generado_en < f.contenido_actualizado_en);

-- Conversaciones parecidas a una consulta: sirven de ejemplo para redactar la respuesta al vendedor.
CREATE OR REPLACE FUNCTION conversaciones_parecidas(
    consulta vector(768),
    limite   integer DEFAULT 3,
    minimo   real    DEFAULT 0.6
)
RETURNS TABLE (conversacion_id bigint, cliente text, respuesta text, tipo text, similitud real)
LANGUAGE sql STABLE
SET hnsw.ef_search = 100
AS $$
    WITH cerca AS (
        SELECT e.frase_id, (1 - (e.embedding <=> consulta))::real AS sim
        FROM frase_embeddings e
        ORDER BY e.embedding <=> consulta
        LIMIT 30
    ),
    por_conversacion AS (
        SELECT f.conversacion_id, max(n.sim) AS sim
        FROM cerca n JOIN frases_cliente f ON f.id = n.frase_id
        GROUP BY f.conversacion_id
    )
    SELECT c.id, c.cliente, c.respuesta, c.tipo, x.sim
    FROM por_conversacion x JOIN conversaciones_mostrador c ON c.id = x.conversacion_id
    WHERE x.sim >= minimo
    ORDER BY x.sim DESC
    LIMIT limite;
$$;

-- Búsqueda por fusión, ahora con cuatro listas: vector de la ficha, texto completo, parecido del
-- nombre y frases de cliente. Cambios respecto de la versión de 09_busqueda_fusion.sql:
--   - Lista de frases: las frases más cercanas a la consulta aportan los productos de su conversación.
--     Pesa según qué tan parecida es la frase (nada bajo umbral_frase, todo si es idéntica).
--   - Un producto también pasa el filtro si llegó por una frase muy parecida (frase_pasa).
--   - Un producto sin vector (recién ingresado) ya no desaparece: se encuentra por sus palabras.
--   - Si la consulta llega sin vector (Ollama caído), busca solo por palabras y parecido del nombre.
DROP FUNCTION IF EXISTS buscar_productos_fusion(vector, text, integer, real, integer, real, real);
DROP FUNCTION IF EXISTS buscar_productos_fusion(vector, text, integer, real, integer, real, real, real, real, real);
DROP FUNCTION IF EXISTS buscar_productos_fusion(vector, text, integer, real, integer, real, real, real, real, real, real);
CREATE FUNCTION buscar_productos_fusion(
    consulta         vector(768),
    texto            text,
    limite           integer DEFAULT 10,
    similitud_minima real    DEFAULT 0.32,
    k                integer DEFAULT 20,     -- constante de RRF: más alta = las posiciones pesan más parejo
    peso_texto       real    DEFAULT 1.0,
    peso_trigrama    real    DEFAULT 0.5,
    peso_frase       real    DEFAULT 1.5,
    umbral_frase     real    DEFAULT 0.5,    -- parecido mínimo para que una frase aporte
    frase_pasa       real    DEFAULT 0.6,    -- parecido desde el que una frase basta para mostrar el producto
    frase_corta      real    DEFAULT 0.5     -- cuánto pesan las frases en una consulta de hasta 3 palabras
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
    por_vector AS (
        SELECT e.producto_id, row_number() OVER (ORDER BY e.embedding <=> consulta) AS pos
        FROM producto_embeddings e
        JOIN productos p ON p.id = e.producto_id
        WHERE consulta IS NOT NULL AND p.activo AND p.stock > 0
        ORDER BY e.embedding <=> consulta
        LIMIT 60
    ),
    por_texto AS (
        SELECT x.producto_id, x.cobertura,
               row_number() OVER (ORDER BY x.cobertura DESC, x.rango DESC, x.producto_id) AS pos
        FROM (
            SELECT b.producto_id, ts_rank(b.documento, q.alguna) AS rango,
                   (SELECT sum(CASE WHEN b.documento @@ (quote_literal(l) || ':A')::tsquery THEN 1.0
                                    WHEN b.documento @@ (quote_literal(l) || ':B')::tsquery THEN 0.6
                                    WHEN b.documento @@ (quote_literal(l) || ':C')::tsquery THEN 0.3
                                    ELSE 0 END)
                    FROM unnest(q.lexemas) l)::real / cardinality(q.lexemas) AS cobertura
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
    frases_cerca AS (
        SELECT e.frase_id, (1 - (e.embedding <=> consulta))::real AS sim
        FROM frase_embeddings e
        WHERE consulta IS NOT NULL
        ORDER BY e.embedding <=> consulta
        LIMIT 30
    ),
    por_frase AS (
        SELECT x.producto_id, x.sim, x.votos, dense_rank() OVER (ORDER BY x.votos DESC) AS pos
        FROM (
            -- Cada frase cercana vota por los productos de su conversación, y el voto vale lo que
            -- la frase supera el umbral. Varias frases que apuntan al mismo producto pesan más que
            -- una sola parecida por casualidad.
            SELECT y.producto_id, max(y.sim) AS sim, sum(y.sim - umbral_frase) AS votos
            FROM (
                -- La conversación nombra unos pocos productos; vale para toda su familia (los que
                -- comparten la misma descripción: otros colores y medidas, y los que lleguen después).
                SELECT DISTINCT n.frase_id, n.sim, p.id AS producto_id
                FROM frases_cerca n
                JOIN frases_cliente f           ON f.id = n.frase_id
                JOIN conversaciones_mostrador c ON c.id = f.conversacion_id AND c.conjunto = 'indice'
                JOIN conversacion_productos cp  ON cp.conversacion_id = c.id
                JOIN productos p0               ON p0.id = cp.producto_id
                JOIN productos p                ON p.id = p0.id OR p.descripcion = p0.descripcion
                WHERE n.sim >= umbral_frase AND p.activo AND p.stock > 0
            ) y
            GROUP BY y.producto_id
        ) x
    ),
    fusion AS (
        SELECT u.producto_id, sum(u.peso / (k + u.pos)) AS rrf
        FROM (
            SELECT producto_id, pos, 1.0::real AS peso FROM por_vector
            UNION ALL SELECT producto_id, pos, peso_texto * cobertura * cobertura FROM por_texto
            UNION ALL SELECT producto_id, pos, peso_trigrama * parecido FROM por_trigrama
            -- Las frases pesan completo con 0,3 de votos (unas tres frases claras) y menos en una
            -- consulta corta, que casi siempre es el nombre del producto y ya la resuelven las otras listas.
            UNION ALL SELECT pf.producto_id, pf.pos,
                             peso_frase * least(1.0, pf.votos / 0.3)
                             * CASE WHEN cardinality(q.lexemas) <= 3 THEN frase_corta ELSE 1.0 END
                      FROM por_frase pf CROSS JOIN q
        ) u
        GROUP BY u.producto_id
    ),
    candidatos AS (
        SELECT p.id, p.sku, p.nombre, c.nombre AS categoria, p.precio, p.stock, f.rrf,
               (1 - (e.embedding <=> consulta))::real AS similitud,
               (numnode(q.todas) > 0 AND b.documento @@ q.todas) AS todas_las_palabras,
               word_similarity(q.t, b.nombre_normalizado) AS sim_nombre,
               coalesce(pf.sim, 0) AS sim_frase,
               coalesce(pt.cobertura, 0) AS cobertura
        FROM fusion f
        JOIN productos p                ON p.id = f.producto_id
        JOIN producto_busqueda b        ON b.producto_id = p.id
        LEFT JOIN producto_embeddings e ON e.producto_id = p.id
        LEFT JOIN por_frase pf          ON pf.producto_id = p.id
        LEFT JOIN por_texto pt          ON pt.producto_id = p.id
        LEFT JOIN categorias c          ON c.id = p.categoria_id
        CROSS JOIN q
    )
    SELECT id, sku, nombre, categoria, precio, stock, coalesce(similitud, 0)::real,
           -- 1,0 = primero en las cuatro listas
           (rrf * (k + 1) / (1.0 + peso_texto + peso_trigrama + peso_frase))::real AS puntaje
    FROM candidatos
    WHERE CASE
              -- Sin vector (producto recién ingresado u Ollama caído): solo por palabras.
              WHEN similitud IS NULL THEN todas_las_palabras OR sim_nombre >= 0.5 OR cobertura >= 0.6
              ELSE similitud >= similitud_minima
                   OR sim_frase >= frase_pasa
                   OR (similitud >= 0.2 AND (todas_las_palabras OR sim_nombre >= 0.5))
          END
    ORDER BY rrf DESC, similitud DESC NULLS LAST
    LIMIT limite;
$$;
