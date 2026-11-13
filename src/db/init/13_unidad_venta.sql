-- Unidad de venta de cada producto (metro, kilo, litro o unidad).
-- La tela se vende por metro y Bsale no entrega la unidad de medida; solo indica si el producto admite decimales.
-- Si unidad_medida trae un valor conocido, manda ese. Si no, lo que no admite decimales se vende por unidad,
-- y lo que admite decimales es metro, salvo que el nombre indique kilo o litro.
-- Los casos de kilo y litro están por confirmar con la ferretería.

CREATE OR REPLACE FUNCTION unidad_venta(nombre text, permite_decimal boolean, unidad_medida text DEFAULT NULL)
RETURNS text
LANGUAGE sql IMMUTABLE
AS $$
    SELECT CASE
        WHEN lower(btrim(coalesce(unidad_medida, ''))) ~ '^(m|mt|mts|metro|metros)$' THEN 'metro'
        WHEN lower(btrim(coalesce(unidad_medida, ''))) ~ '^(kg|kilo|kilos|kilogramo|kilogramos)$' THEN 'kilo'
        WHEN lower(btrim(coalesce(unidad_medida, ''))) ~ '^(l|lt|lts|litro|litros)$' THEN 'litro'
        WHEN NOT coalesce(permite_decimal, false) THEN 'unidad'
        WHEN nombre ~* '\m(kilos?|kg)\M' OR nombre ~* '^\s*(clavo|punta|soldadura|molido)\M' THEN 'kilo'
        WHEN nombre ~* '\m(litros?|lts?|granel)\M' OR nombre ~* '^\s*(laca|sellador|diluyente)\M' THEN 'litro'
        ELSE 'metro'
    END
$$;
