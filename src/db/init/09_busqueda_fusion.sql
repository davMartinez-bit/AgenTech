-- Búsqueda por fusión (T30): entiende otros nombres y errores de escritura.
--   1. expandir_consulta: corrige la escritura, quita saludos y muletillas y cambia el nombre que usa
--      el cliente por el del catálogo ("huincha aislante" -> "cinta aisladora") con sinonimos_busqueda.
--   2. buscar_productos_fusion: tres listas (vector, texto completo en español y trigramas del nombre)
--      combinadas por posición (RRF), no por promedio de puntajes que están en escalas distintas.
-- El filtro duro no cambia: solo productos activos con stock > 0.
-- Se puede aplicar sobre una base ya creada. La función anterior (buscar_productos_hibrida) se conserva
-- para comparar en evaluar_busqueda.py.

CREATE EXTENSION IF NOT EXISTS unaccent;

-- Minúsculas, sin tildes y sin espacios repetidos. Se usa igual en la consulta y en el catálogo.
CREATE OR REPLACE FUNCTION normalizar_busqueda(t text) RETURNS text
LANGUAGE sql IMMUTABLE PARALLEL SAFE
AS $$
    SELECT btrim(regexp_replace(lower(unaccent('unaccent'::regdictionary, coalesce(t, ''))), '\s+', ' ', 'g'))
$$;

-- ---------------------------------------------------------------- sinónimos

-- Plural -> singular, palabra por palabra. No busca ser perfecto: se aplica igual a la regla y a la
-- consulta, así "huinchas aislantes" calza con la regla "huincha aislante".
CREATE OR REPLACE FUNCTION singular_busqueda(palabra text) RETURNS text
LANGUAGE sql IMMUTABLE PARALLEL SAFE
AS $$
    SELECT CASE
        WHEN length(palabra) <= 3 THEN palabra
        WHEN palabra ~ '[aeiou]ces$' THEN regexp_replace(palabra, 'ces$', 'z')
        WHEN palabra ~ '[aeiou][lrnd]es$' THEN regexp_replace(palabra, 'es$', '')
        WHEN palabra ~ '[aeiou]s$' THEN regexp_replace(palabra, 's$', '')
        ELSE palabra
    END
$$;

CREATE OR REPLACE FUNCTION clave_busqueda(frase text) RETURNS text
LANGUAGE sql IMMUTABLE PARALLEL SAFE
AS $$
    SELECT coalesce(string_agg(singular_busqueda(p), ' ' ORDER BY n), '')
    FROM unnest(string_to_array(normalizar_busqueda(frase), ' ')) WITH ORDINALITY AS t(p, n)
$$;

-- frase: lo que escribe el cliente. equivale: lo que se busca en su lugar, con las palabras del catálogo.
-- Las reglas se aplican en este orden:
--   'escritura'  errores y abreviaturas (wincha -> huincha, pa -> para).
--   'sinonimo'   otro nombre del producto: chilenismos, marcas usadas como genérico y nombres de otros
--                países ("galletera", "agorex", "bombillo"). Si el catálogo usa dos nombres para lo mismo,
--                el equivale lleva los dos ("cuerina pu"): el texto completo busca cualquiera de ellos.
--   'relleno'    saludos, muletillas y fórmulas de pedido que no describen el producto; se quitan
--                ("hola, ¿tiene ... porfa?"). Su equivale va vacío. Van al final para no romper un
--                nombre que las contiene ("pie de amigo").
-- La semilla está en 10_sinonimos_semilla.sql; se amplía con lo que el panel muestra en
-- "Lo que buscan y no encuentran".
CREATE TABLE IF NOT EXISTS sinonimos_busqueda (
    id         serial PRIMARY KEY,
    frase      text NOT NULL UNIQUE CHECK (frase ~ '^[a-z0-9ñ]+( [a-z0-9ñ]+)*$'),
    clave      text GENERATED ALWAYS AS (clave_busqueda(frase)) STORED,
    equivale   text NOT NULL CHECK (equivale ~ '^[a-z0-9ñ/." -]*$'),
    tipo       varchar(10) NOT NULL DEFAULT 'sinonimo' CHECK (tipo IN ('escritura', 'relleno', 'sinonimo')),
    nota       text,
    activo     boolean NOT NULL DEFAULT true,
    creado_en  timestamptz NOT NULL DEFAULT now(),
    CHECK (tipo = 'relleno' OR equivale <> '')
);
CREATE INDEX IF NOT EXISTS sinonimos_busqueda_clave_idx ON sinonimos_busqueda (tipo, clave);

-- Palabras que aparecen en los nombres del catálogo (en singular). Sirve para reconocer diminutivos:
-- "tornillito" se cambia por "tornillo" solo si "tornillo" existe en el catálogo y "tornillito" no.
CREATE TABLE IF NOT EXISTS vocabulario_busqueda (
    palabra text PRIMARY KEY
);

CREATE OR REPLACE FUNCTION sin_diminutivo(palabra text) RETURNS text
LANGUAGE plpgsql STABLE
AS $$
DECLARE
    p text := singular_busqueda(palabra);
    candidato text;
BEGIN
    IF p !~ 'it[oa]$' OR length(p) < 6 OR EXISTS (SELECT 1 FROM vocabulario_busqueda v WHERE v.palabra = p) THEN
        RETURN palabra;
    END IF;
    FOREACH candidato IN ARRAY ARRAY[
        regexp_replace(p, 'quit([oa])$', 'c\1'),   -- tuerquita -> tuerca
        regexp_replace(p, 'cit[oa]$', ''),         -- botoncito -> boton
        regexp_replace(p, 'it([oa])$', '\1'),      -- tornillito -> tornillo
        regexp_replace(p, 'it[oa]$', '')           -- pincelito -> pincel
    ] LOOP
        IF candidato <> p AND EXISTS (SELECT 1 FROM vocabulario_busqueda v WHERE v.palabra = candidato) THEN
            RETURN candidato;
        END IF;
    END LOOP;
    RETURN palabra;
END;
$$;

-- Aplica las reglas de un tipo en una sola pasada, de izquierda a derecha y probando primero la frase
-- más larga (hasta 5 palabras). Lo ya reemplazado no se vuelve a revisar: una regla no pisa a otra.
CREATE OR REPLACE FUNCTION aplicar_reglas_busqueda(texto text, fase text) RETURNS text
LANGUAGE plpgsql STABLE
AS $$
DECLARE
    palabras text[] := string_to_array(texto, ' ');
    n        integer := coalesce(array_length(palabras, 1), 0);
    salida   text[] := '{}';
    i        integer := 1;
    largo    integer;
    tramo    text;
    eq       text;
    hallado  boolean;
BEGIN
    WHILE i <= n LOOP
        hallado := false;
        largo := least(5, n - i + 1);
        WHILE largo >= 1 AND NOT hallado LOOP
            tramo := array_to_string(palabras[i:i + largo - 1], ' ');
            SELECT s.equivale INTO eq
            FROM sinonimos_busqueda s
            WHERE s.activo AND s.tipo = fase AND s.clave = clave_busqueda(tramo)
            ORDER BY (s.frase = tramo) DESC, s.id
            LIMIT 1;
            hallado := FOUND;
            IF NOT hallado THEN
                largo := largo - 1;
            END IF;
        END LOOP;
        IF hallado THEN
            salida := salida || eq;
            i := i + largo;
        ELSE
            salida := salida || palabras[i];
            i := i + 1;
        END IF;
    END LOOP;
    RETURN normalizar_busqueda(array_to_string(salida, ' '));
END;
$$;

CREATE OR REPLACE FUNCTION expandir_consulta(texto text) RETURNS text
LANGUAGE plpgsql STABLE
AS $$
DECLARE
    r       text;
    limpio  text;
BEGIN
    -- Signos fuera; el apóstrofo se pega ("pa'l" -> "pal"); "pegao", "oxidao" -> "pegado", "oxidado".
    r := regexp_replace(normalizar_busqueda(texto), '[''’´`]', '', 'g');
    r := regexp_replace(r, '([a-zñ])-([a-zñ0-9])', '\1 \2', 'g');      -- "tip-top", "wd-40"
    r := normalizar_busqueda(regexp_replace(r, '[¿?¡!,;:()]+', ' ', 'g'));
    r := regexp_replace(r, '\m([a-zñ]{3,})ao(s?)\M', '\1ado\2', 'g');
    r := aplicar_reglas_busqueda(r, 'escritura');
    SELECT coalesce(string_agg(sin_diminutivo(p), ' ' ORDER BY n), '') INTO r
    FROM unnest(string_to_array(r, ' ')) WITH ORDINALITY AS t(p, n);
    r := aplicar_reglas_busqueda(r, 'sinonimo');
    -- Si la consulta era puro relleno ("hola"), se deja como venía.
    limpio := aplicar_reglas_busqueda(r, 'relleno');
    IF limpio <> '' THEN
        r := limpio;
    END IF;
    -- Una palabra repetida por dos reglas ("chapa cerradura" -> "chapa cerradura cerradura chapa") va una vez.
    SELECT string_agg(p, ' ' ORDER BY n) INTO r
    FROM (SELECT p, n, row_number() OVER (PARTITION BY p ORDER BY n) AS vez
          FROM unnest(string_to_array(r, ' ')) WITH ORDINALITY AS t(p, n)) x
    WHERE vez = 1 OR p !~ '^[a-zñ]{3,}$';
    RETURN r;
END;
$$;

-- Reglas que conviene mirar: el equivalente no encuentra ningún producto con stock (regla inútil hoy),
-- o la frase original calzaba con más productos que su equivalente (la regla esconde productos).
CREATE OR REPLACE FUNCTION revisar_sinonimos()
RETURNS TABLE (frase text, equivale text, productos_frase bigint, productos_equivale bigint, problema text)
LANGUAGE sql STABLE
AS $$
    WITH cuenta AS (
        SELECT s.frase, s.equivale,
               (SELECT count(*) FROM producto_busqueda b JOIN productos p ON p.id = b.producto_id
                WHERE p.activo AND p.stock > 0 AND numnode(plainto_tsquery('spanish', s.frase)) > 0
                  AND b.documento @@ plainto_tsquery('spanish', s.frase)) AS n_frase,
               (SELECT count(*) FROM producto_busqueda b JOIN productos p ON p.id = b.producto_id
                WHERE p.activo AND p.stock > 0 AND numnode(plainto_tsquery('spanish', s.equivale)) > 0
                  AND b.documento @@ replace(plainto_tsquery('spanish', s.equivale)::text, '&', '|')::tsquery) AS n_equivale
        FROM sinonimos_busqueda s
        WHERE s.activo AND s.tipo = 'sinonimo'
    )
    SELECT c.frase, c.equivale, c.n_frase, c.n_equivale,
           CASE WHEN c.n_equivale = 0 THEN 'el equivalente no encuentra productos'
                ELSE 'la frase original encuentra más productos' END
    FROM cuenta c
    WHERE c.n_equivale = 0 OR c.n_frase > c.n_equivale
    ORDER BY 5, 1
$$;

-- ---------------------------------------------------------------- texto completo

-- Documento de búsqueda de cada producto: el nombre pesa más (A), después categoría y marca (B)
-- y la descripción de uso (C). Va en su propia tabla para no tocar productos ni sus vectores.
CREATE TABLE IF NOT EXISTS producto_busqueda (
    producto_id         bigint PRIMARY KEY REFERENCES productos (id) ON DELETE CASCADE,
    nombre_normalizado  text NOT NULL,
    documento           tsvector NOT NULL
);
CREATE INDEX IF NOT EXISTS producto_busqueda_documento_idx ON producto_busqueda USING gin (documento);
CREATE INDEX IF NOT EXISTS producto_busqueda_nombre_idx ON producto_busqueda USING gin (nombre_normalizado gin_trgm_ops);

CREATE OR REPLACE FUNCTION actualizar_producto_busqueda(pid bigint) RETURNS void
LANGUAGE sql
AS $$
    INSERT INTO producto_busqueda (producto_id, nombre_normalizado, documento)
    SELECT p.id,
           normalizar_busqueda(p.nombre),
           setweight(to_tsvector('spanish', normalizar_busqueda(p.nombre)), 'A') ||
           setweight(to_tsvector('spanish', normalizar_busqueda(concat_ws(' ', c.nombre, m.nombre))), 'B') ||
           setweight(to_tsvector('spanish', normalizar_busqueda(p.descripcion)), 'C')
    FROM productos p
    LEFT JOIN categorias c ON c.id = p.categoria_id
    LEFT JOIN marcas m     ON m.id = p.marca_id
    WHERE p.id = pid
    ON CONFLICT (producto_id) DO UPDATE
        SET nombre_normalizado = EXCLUDED.nombre_normalizado, documento = EXCLUDED.documento;

    INSERT INTO vocabulario_busqueda (palabra)
    SELECT DISTINCT singular_busqueda(t.p)
    FROM productos p, regexp_split_to_table(normalizar_busqueda(p.nombre), '[^a-zñ]+') AS t(p)
    WHERE p.id = pid AND length(t.p) >= 4
    ON CONFLICT DO NOTHING;
$$;

CREATE OR REPLACE FUNCTION productos_actualizar_busqueda() RETURNS trigger
LANGUAGE plpgsql
AS $$
BEGIN
    PERFORM actualizar_producto_busqueda(NEW.id);
    RETURN NULL;
END;
$$;

DROP TRIGGER IF EXISTS productos_busqueda_trg ON productos;
CREATE TRIGGER productos_busqueda_trg
    AFTER INSERT OR UPDATE OF nombre, descripcion, categoria_id, marca_id ON productos
    FOR EACH ROW EXECUTE FUNCTION productos_actualizar_busqueda();

-- Carga inicial (y recarga si cambió la forma del documento).
DO $$
BEGIN
    PERFORM actualizar_producto_busqueda(id) FROM productos;
END;
$$;

-- ---------------------------------------------------------------- búsqueda

-- texto: la consulta ya pasada por expandir_consulta. consulta: su vector.
-- Cada lista aporta según la posición del producto en ella (RRF). En las dos listas de texto el aporte
-- además se pondera por lo bien que calza el producto:
--   - texto completo: por la parte de las palabras de la consulta que tiene el producto (cobertura al
--     cuadrado). Una palabra en el nombre vale 1; en la categoría o la marca, 0,6; en la descripción, 0,3.
--     Si alguien pide "algo para tapar goteras en techo de zinc", una golilla "zincada" tiene 1 de 4
--     palabras y casi no suma; "cinta aisladora" con sus 2 de 2 suma completo.
--   - trigramas: por el parecido del nombre con la consulta.
-- Así una consulta por uso (larga, descriptiva) se ordena sobre todo por significado, y una por nombre,
-- por las palabras.
-- Pasa un producto si su similitud semántica supera similitud_minima, o si tiene todas las palabras
-- de la búsqueda, o si el nombre se parece mucho (errores de tipeo); en los dos últimos casos la
-- semántica no puede ser lejana (>= 0,2). Así una consulta ajena a la ferretería sigue volviendo vacía.
DROP FUNCTION IF EXISTS buscar_productos_fusion(vector, text, integer, real, integer, real, real);
CREATE FUNCTION buscar_productos_fusion(
    consulta         vector(768),
    texto            text,
    limite           integer DEFAULT 10,
    similitud_minima real    DEFAULT 0.32,
    k                integer DEFAULT 20,     -- constante de RRF: más alta = las posiciones pesan más parejo
    peso_texto       real    DEFAULT 1.0,
    peso_trigrama    real    DEFAULT 0.5
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
        WHERE p.activo AND p.stock > 0
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
       OR (similitud >= 0.2 AND (todas_las_palabras OR sim_nombre >= 0.4))
    ORDER BY rrf DESC, similitud DESC
    LIMIT limite;
$$;
