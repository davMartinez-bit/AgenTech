-- Clics de la búsqueda (T30): qué producto abrió el vendedor después de buscar.
-- Sirve para medir la búsqueda con uso real: si el producto abierto estaba primero, quinto o si nadie
-- abrió nada. Solo se puede registrar un producto que venía entre los resultados de esa consulta.
-- Se puede aplicar sobre una base ya creada.

CREATE TABLE IF NOT EXISTS consulta_clics (
    id           bigserial PRIMARY KEY,
    consulta_id  bigint NOT NULL,
    producto_id  bigint NOT NULL,
    origen       varchar(20) NOT NULL DEFAULT 'buscador' CHECK (origen IN ('buscador', 'asistente')),
    creado_en    timestamptz NOT NULL DEFAULT now(),
    FOREIGN KEY (consulta_id, producto_id)
        REFERENCES consulta_resultados (consulta_id, producto_id) ON DELETE CASCADE
);
CREATE INDEX IF NOT EXISTS consulta_clics_consulta_idx ON consulta_clics (consulta_id);

-- Por día: consultas con resultados, cuántas terminaron en un clic y en qué posición estaba, en promedio,
-- el primer producto abierto (1 = el primero de la lista).
CREATE OR REPLACE VIEW resumen_clics_busqueda AS
SELECT c.creado_en::date                                   AS dia,
       count(*)                                            AS consultas_con_resultados,
       count(k.consulta_id)                                AS consultas_con_clic,
       round(avg(k.posicion), 1)                           AS posicion_promedio_del_clic,
       count(*) FILTER (WHERE k.posicion = 1)              AS clic_en_el_primero
FROM consultas c
LEFT JOIN LATERAL (
    SELECT cc.consulta_id, r.posicion
    FROM consulta_clics cc
    JOIN consulta_resultados r ON r.consulta_id = cc.consulta_id AND r.producto_id = cc.producto_id
    WHERE cc.consulta_id = c.id
    ORDER BY cc.creado_en, cc.id
    LIMIT 1
) k ON true
WHERE c.cantidad_resultados > 0
GROUP BY 1;
