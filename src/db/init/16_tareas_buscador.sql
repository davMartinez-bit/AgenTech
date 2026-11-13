-- Tareas en el buscador: el vendedor escribe el trabajo en pocas palabras ("reparación de techo",
-- "pintar muros", "forrado de sillones") y el buscador muestra los productos que se usan para hacerlo.
-- Cada tarea tiene una lista de búsquedas cortas; la API busca cada una y mezcla los resultados por
-- turnos, para que no gane una sola familia (por ejemplo, solo tornillos de techo).
-- Las frases largas del cliente ("algo para tapar las goteras del techo") no van aquí: las resuelve
-- el asistente, que las traduce con un modelo de lenguaje (rutas/consulta.ts, origen "asistente").
-- Las palabras de destino existen en el catálogo con stock (revisado el 13-11-2026).

CREATE TABLE IF NOT EXISTS tareas_busqueda (
    frase     text PRIMARY KEY,   -- como queda después de normalizar_busqueda (minúsculas, sin tildes)
    busquedas text[] NOT NULL CHECK (cardinality(busquedas) BETWEEN 1 AND 5),
    nota      text
);

INSERT INTO tareas_busqueda (frase, busquedas, nota) VALUES
    ('gotera',                ARRAY['tapagoteras', 'sellador', 'brea'], 'Tapar goteras'),
    ('goteras',               ARRAY['tapagoteras', 'sellador', 'brea'], 'Tapar goteras'),
    ('reparacion de goteras', ARRAY['tapagoteras', 'sellador', 'brea'], 'Tapar goteras'),
    ('reparar goteras',       ARRAY['tapagoteras', 'sellador', 'brea'], 'Tapar goteras'),
    ('arreglar goteras',      ARRAY['tapagoteras', 'sellador', 'brea'], 'Tapar goteras'),
    ('tapar goteras',         ARRAY['tapagoteras', 'sellador', 'brea'], 'Tapar goteras'),
    ('reparacion de techo',   ARRAY['tapagoteras', 'tornillo techo', 'brea', 'sellador'], 'Reparar un techo'),
    ('reparacion techo',      ARRAY['tapagoteras', 'tornillo techo', 'brea', 'sellador'], 'Reparar un techo'),
    ('reparar techo',         ARRAY['tapagoteras', 'tornillo techo', 'brea', 'sellador'], 'Reparar un techo'),
    ('arreglar techo',        ARRAY['tapagoteras', 'tornillo techo', 'brea', 'sellador'], 'Reparar un techo'),
    ('pintar muro',           ARRAY['latex', 'rodillo', 'brocha'], 'Pintar muros'),
    ('pintar muros',          ARRAY['latex', 'rodillo', 'brocha'], 'Pintar muros'),
    ('pintar muralla',        ARRAY['latex', 'rodillo', 'brocha'], 'Pintar muros'),
    ('pintar pared',          ARRAY['latex', 'rodillo', 'brocha'], 'Pintar muros'),
    ('pintar paredes',        ARRAY['latex', 'rodillo', 'brocha'], 'Pintar muros'),
    ('pintar pieza',          ARRAY['latex', 'rodillo', 'brocha'], 'Pintar muros'),
    ('pintura de muros',      ARRAY['latex', 'rodillo', 'brocha'], 'Pintar muros'),
    ('pintar madera',         ARRAY['barniz', 'brocha', 'lija'], 'Pintar o barnizar madera'),
    ('pintar mueble',         ARRAY['barniz', 'esmalte', 'brocha', 'lija'], 'Pintar o barnizar madera'),
    ('pintar reja',           ARRAY['anticorrosivo', 'esmalte', 'brocha'], 'Pintar fierro'),
    ('pintar fierro',         ARRAY['anticorrosivo', 'esmalte', 'brocha'], 'Pintar fierro'),
    ('cortar fierro',         ARRAY['disco corte metal'], 'Cortar metal'),
    ('cortar metal',          ARRAY['disco corte metal'], 'Cortar metal'),
    ('forrado de sillones',   ARRAY['cuerina', 'felpa', 'espuma', 'corchete'], 'Tapizar un sillón'),
    ('forrado de sillon',     ARRAY['cuerina', 'felpa', 'espuma', 'corchete'], 'Tapizar un sillón'),
    ('forrar sillon',         ARRAY['cuerina', 'felpa', 'espuma', 'corchete'], 'Tapizar un sillón'),
    ('forrar sillones',       ARRAY['cuerina', 'felpa', 'espuma', 'corchete'], 'Tapizar un sillón'),
    ('tapizar sillon',        ARRAY['cuerina', 'felpa', 'espuma', 'corchete'], 'Tapizar un sillón'),
    ('tapizar sillones',      ARRAY['cuerina', 'felpa', 'espuma', 'corchete'], 'Tapizar un sillón')
ON CONFLICT (frase) DO UPDATE SET busquedas = EXCLUDED.busquedas, nota = EXCLUDED.nota;
