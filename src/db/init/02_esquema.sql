-- Catálogo

CREATE TABLE categorias (
    id      smallserial PRIMARY KEY,
    nombre  varchar(60) NOT NULL UNIQUE
);

CREATE TABLE marcas (
    id      serial PRIMARY KEY,
    nombre  varchar(80) NOT NULL
);

CREATE UNIQUE INDEX marcas_nombre_uk ON marcas (lower(nombre));

CREATE TABLE productos (
    id                       bigserial PRIMARY KEY,
    sku                      varchar(40)  NOT NULL UNIQUE,
    codigo_barras            varchar(40)  UNIQUE,
    nombre                   varchar(200) NOT NULL,
    descripcion              text,
    categoria_id             smallint REFERENCES categorias (id),
    marca_id                 integer  REFERENCES marcas (id),
    unidad_medida            varchar(20),
    precio                   numeric(12, 2) CHECK (precio >= 0),
    stock                    numeric(12, 3) NOT NULL DEFAULT 0,
    permite_decimal          boolean NOT NULL DEFAULT false,
    activo                   boolean NOT NULL DEFAULT true,
    bsale_variante_id        integer UNIQUE,
    creado_en                timestamptz NOT NULL DEFAULT now(),
    actualizado_en           timestamptz NOT NULL DEFAULT now(),
    -- solo cambia cuando cambia el texto que se vectoriza (no con el stock ni el precio)
    contenido_actualizado_en timestamptz NOT NULL DEFAULT now()
);

CREATE INDEX productos_categoria_idx ON productos (categoria_id);
CREATE INDEX productos_marca_idx ON productos (marca_id);
CREATE INDEX productos_disponibles_idx ON productos (id) WHERE activo AND stock > 0;
CREATE INDEX productos_nombre_trgm_idx ON productos USING gin (nombre gin_trgm_ops);

CREATE FUNCTION productos_marcar_cambios() RETURNS trigger
LANGUAGE plpgsql AS $$
BEGIN
    NEW.actualizado_en := now();

    IF NEW.nombre       IS DISTINCT FROM OLD.nombre
    OR NEW.descripcion  IS DISTINCT FROM OLD.descripcion
    OR NEW.categoria_id IS DISTINCT FROM OLD.categoria_id
    OR NEW.marca_id     IS DISTINCT FROM OLD.marca_id THEN
        NEW.contenido_actualizado_en := now();
    END IF;

    RETURN NEW;
END;
$$;

CREATE TRIGGER productos_marcar_cambios
    BEFORE UPDATE ON productos
    FOR EACH ROW EXECUTE FUNCTION productos_marcar_cambios();


-- Búsqueda semántica
-- 768 dimensiones: nomic-embed-text / multilingual-e5-base.
-- Si se cambia de modelo hay que ajustar la dimensión y regenerar los vectores.

CREATE TABLE producto_embeddings (
    producto_id   bigint PRIMARY KEY REFERENCES productos (id) ON DELETE CASCADE,
    modelo        varchar(100) NOT NULL,
    texto_fuente  text NOT NULL,
    embedding     vector(768) NOT NULL,
    generado_en   timestamptz NOT NULL DEFAULT now()
);

CREATE INDEX producto_embeddings_hnsw_idx
    ON producto_embeddings USING hnsw (embedding vector_cosine_ops);

-- Cola de trabajo del worker: productos nuevos o cuyo texto cambió
CREATE VIEW productos_pendientes_embedding AS
SELECT p.id,
       p.sku,
       concat_ws('. ', p.nombre, c.nombre, m.nombre, p.descripcion) AS texto_fuente
FROM productos p
LEFT JOIN categorias c          ON c.id = p.categoria_id
LEFT JOIN marcas m              ON m.id = p.marca_id
LEFT JOIN producto_embeddings e ON e.producto_id = p.id
WHERE p.activo
  AND (e.producto_id IS NULL OR e.generado_en < p.contenido_actualizado_en);

-- La similitud la calcula el vector; la disponibilidad la decide el stock.
CREATE FUNCTION buscar_productos(
    consulta         vector(768),
    limite           integer DEFAULT 10,
    similitud_minima real    DEFAULT 0.5
)
RETURNS TABLE (
    producto_id  bigint,
    sku          varchar,
    nombre       varchar,
    categoria    varchar,
    precio       numeric,
    stock        numeric,
    similitud    real
)
LANGUAGE sql STABLE
SET hnsw.ef_search = 100
AS $$
    SELECT p.id, p.sku, p.nombre, c.nombre, p.precio, p.stock,
           (1 - (e.embedding <=> consulta))::real
    FROM producto_embeddings e
    JOIN productos p       ON p.id = e.producto_id
    LEFT JOIN categorias c ON c.id = p.categoria_id
    WHERE p.activo
      AND p.stock > 0
      AND 1 - (e.embedding <=> consulta) >= similitud_minima
    ORDER BY e.embedding <=> consulta
    LIMIT limite;
$$;


-- Ingesta

CREATE TABLE ingestas (
    id          bigserial PRIMARY KEY,
    origen      varchar(40) NOT NULL,
    recibidos   integer NOT NULL,
    aceptados   integer NOT NULL,
    rechazados  integer NOT NULL,
    errores     jsonb NOT NULL DEFAULT '[]',
    creado_en   timestamptz NOT NULL DEFAULT now(),
    CHECK (aceptados + rechazados = recibidos)
);
