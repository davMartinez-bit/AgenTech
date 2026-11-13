-- Corrector de escritura para el buscador.
-- Una palabra de 6 letras o más que no aparece en el catálogo ni en el diccionario se cambia
-- por la palabra conocida más parecida, con una letra de diferencia (dos si tiene 8 letras o más).
-- Así "eletrcista" pasa a "electricista" y "tapizeria" a "tapiceria".
-- Una palabra corta o sin parecido cercano queda como viene, para que "pizza" no pase a "pinza".

CREATE EXTENSION IF NOT EXISTS fuzzystrmatch;

-- Palabras que el buscador conoce: las de nombres, descripciones y rubros del catálogo, y las del diccionario.
CREATE TABLE IF NOT EXISTS palabras_conocidas (
    palabra text PRIMARY KEY
);
ALTER TABLE palabras_conocidas ADD COLUMN IF NOT EXISTS raiz text;
CREATE INDEX IF NOT EXISTS palabras_conocidas_raiz_idx ON palabras_conocidas (raiz);

CREATE OR REPLACE FUNCTION agregar_palabras_conocidas(texto text) RETURNS void
LANGUAGE sql
AS $$
    INSERT INTO palabras_conocidas (palabra, raiz)
    SELECT DISTINCT f.forma, (tsvector_to_array(to_tsvector('spanish', f.forma)))[1]
    FROM regexp_split_to_table(normalizar_busqueda(coalesce(texto, '')), '[^a-zñ]+') AS t(p)
    CROSS JOIN LATERAL (VALUES (t.p), (singular_busqueda(t.p))) AS f(forma)
    WHERE length(t.p) >= 4 AND length(f.forma) >= 4
    ON CONFLICT DO NOTHING;
$$;

-- Vuelve a armar la lista completa. Conviene correrla después de una carga grande del catálogo.
CREATE OR REPLACE FUNCTION actualizar_palabras_conocidas() RETURNS integer
LANGUAGE plpgsql
AS $$
BEGIN
    DELETE FROM palabras_conocidas;
    PERFORM agregar_palabras_conocidas(concat_ws(' ', p.nombre, p.descripcion)) FROM productos p WHERE p.activo;
    PERFORM agregar_palabras_conocidas(c.nombre) FROM categorias c;
    PERFORM agregar_palabras_conocidas(m.nombre) FROM marcas m;
    -- Del diccionario: en las reglas de escritura la frase es justamente la palabra mal escrita, así que solo vale el equivalente.
    PERFORM agregar_palabras_conocidas(CASE WHEN s.tipo = 'escritura' THEN s.equivale ELSE concat_ws(' ', s.frase, s.equivale) END)
    FROM sinonimos_busqueda s WHERE s.activo;
    RETURN (SELECT count(*) FROM palabras_conocidas);
END;
$$;

CREATE OR REPLACE FUNCTION palabras_conocidas_de_producto() RETURNS trigger
LANGUAGE plpgsql
AS $$
BEGIN
    PERFORM agregar_palabras_conocidas(concat_ws(' ', NEW.nombre, NEW.descripcion));
    RETURN NULL;
END;
$$;
DROP TRIGGER IF EXISTS productos_palabras_trg ON productos;
CREATE TRIGGER productos_palabras_trg
    AFTER INSERT OR UPDATE OF nombre, descripcion ON productos
    FOR EACH ROW EXECUTE FUNCTION palabras_conocidas_de_producto();

CREATE OR REPLACE FUNCTION palabras_conocidas_de_regla() RETURNS trigger
LANGUAGE plpgsql
AS $$
BEGIN
    PERFORM agregar_palabras_conocidas(CASE WHEN NEW.tipo = 'escritura' THEN NEW.equivale ELSE concat_ws(' ', NEW.frase, NEW.equivale) END);
    RETURN NULL;
END;
$$;
DROP TRIGGER IF EXISTS sinonimos_palabras_trg ON sinonimos_busqueda;
CREATE TRIGGER sinonimos_palabras_trg
    AFTER INSERT OR UPDATE ON sinonimos_busqueda
    FOR EACH ROW EXECUTE FUNCTION palabras_conocidas_de_regla();

-- Dos resguardos para no "corregir" castellano correcto que no está en el catálogo:
--   - si la palabra es vacía para el buscador ("contra", "desde") o comparte raíz con una conocida
--     ("manchar" con "mancha", "engancharla" con "enganchar"), no se toca;
--   - la corrección tiene que empezar con la misma letra ("atornillo" no pasa a "tornillo").
CREATE OR REPLACE FUNCTION corregir_escritura(texto text) RETURNS text
LANGUAGE sql STABLE
AS $$
    SELECT coalesce(string_agg(coalesce(c.palabra, t.p), ' ' ORDER BY t.n), '')
    FROM unnest(string_to_array(texto, ' ')) WITH ORDINALITY AS t(p, n)
    CROSS JOIN LATERAL (SELECT (tsvector_to_array(to_tsvector('spanish', t.p)))[1] AS raiz) r
    LEFT JOIN LATERAL (
        SELECT k.palabra
        FROM palabras_conocidas k
        WHERE length(t.p) >= 6 AND t.p ~ '^[a-zñ]+$'
          AND r.raiz IS NOT NULL
          AND NOT EXISTS (SELECT 1 FROM palabras_conocidas x
                          WHERE x.palabra IN (t.p, singular_busqueda(t.p)) OR x.raiz = r.raiz)
          AND left(k.palabra, 1) = left(t.p, 1)
          AND abs(length(k.palabra) - length(t.p)) <= 2
          AND similarity(k.palabra, t.p) >= 0.3
          AND levenshtein(k.palabra, t.p) <= CASE WHEN length(t.p) >= 8 THEN 2 ELSE 1 END
        ORDER BY levenshtein(k.palabra, t.p), similarity(k.palabra, t.p) DESC, k.palabra
        LIMIT 1
    ) c ON true
$$;

SELECT actualizar_palabras_conocidas();

-- Misma función del script 09 con un paso más: el corrector, después de las reglas de escritura.
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
    r := corregir_escritura(r);   -- palabras mal escritas que no están en el diccionario
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
