-- Ampliación del modelo: modelos de embeddings, clientes de la API,
-- detalle de ingestas, usuarios, registro de consultas y casos de prueba.

-- Modelos de embeddings
CREATE TABLE modelos_embedding (
    id           smallserial PRIMARY KEY,
    nombre       varchar(100) NOT NULL UNIQUE,
    dimensiones  smallint NOT NULL CHECK (dimensiones > 0),
    proveedor    varchar(60),
    activo       boolean NOT NULL DEFAULT true,
    creado_en    timestamptz NOT NULL DEFAULT now()
);

INSERT INTO modelos_embedding (nombre, dimensiones, proveedor) VALUES
    ('nomic-embed-text', 768, 'Ollama'),
    ('multilingual-e5-base', 768, 'Hugging Face');

-- El vector de cada producto apunta al modelo que lo generó
ALTER TABLE producto_embeddings DROP COLUMN modelo;
ALTER TABLE producto_embeddings
    ADD COLUMN modelo_id smallint NOT NULL REFERENCES modelos_embedding (id);


-- Sistemas que usan la API (POS, ERP o el chatbot)
CREATE TABLE clientes_api (
    id             serial PRIMARY KEY,
    nombre         varchar(100) NOT NULL UNIQUE,
    tipo           varchar(20)  NOT NULL CHECK (tipo IN ('pos', 'erp', 'chatbot', 'otro')),
    clave_hash     text,  -- hash de la clave de API; NULL = no puede llamar a la API
    activo         boolean NOT NULL DEFAULT true,
    creado_en      timestamptz NOT NULL DEFAULT now(),
    ultimo_uso_en  timestamptz
);

INSERT INTO clientes_api (nombre, tipo) VALUES
    ('Carga inicial desde Bsale', 'otro'),
    ('Chatbot del vendedor', 'chatbot');

ALTER TABLE ingestas ADD COLUMN cliente_id integer REFERENCES clientes_api (id);
CREATE INDEX ingestas_cliente_idx ON ingestas (cliente_id);


-- Resultado de cada registro dentro de una ingesta
CREATE TABLE ingesta_detalle (
    id           bigserial PRIMARY KEY,
    ingesta_id   bigint  NOT NULL REFERENCES ingestas (id) ON DELETE CASCADE,
    posicion     integer NOT NULL CHECK (posicion > 0),
    sku          varchar(40),
    producto_id  bigint REFERENCES productos (id) ON DELETE SET NULL,
    estado       varchar(10) NOT NULL CHECK (estado IN ('aceptado', 'rechazado')),
    motivo       text,
    UNIQUE (ingesta_id, posicion),
    CHECK (estado = 'aceptado' OR motivo IS NOT NULL)
);

CREATE INDEX ingesta_detalle_producto_idx ON ingesta_detalle (producto_id);

-- Registro de la carga inicial del catálogo (03_carga_catalogo.sql)
INSERT INTO ingestas (origen, recibidos, aceptados, rechazados, cliente_id)
SELECT 'carga-inicial-bsale', count(*), count(*), 0,
       (SELECT id FROM clientes_api WHERE nombre = 'Carga inicial desde Bsale')
FROM productos;

INSERT INTO ingesta_detalle (ingesta_id, posicion, sku, producto_id, estado)
SELECT i.id, row_number() OVER (ORDER BY p.id), p.sku, p.id, 'aceptado'
FROM productos p
CROSS JOIN (SELECT id FROM ingestas WHERE origen = 'carga-inicial-bsale') i;


-- Usuarios del chatbot
CREATE TABLE usuarios (
    id         serial PRIMARY KEY,
    nombre     varchar(100) NOT NULL,
    correo     varchar(150) NOT NULL,
    rol        varchar(20)  NOT NULL CHECK (rol IN ('vendedor', 'encargado_compras', 'administrador')),
    activo     boolean NOT NULL DEFAULT true,
    creado_en  timestamptz NOT NULL DEFAULT now()
);

CREATE UNIQUE INDEX usuarios_correo_uk ON usuarios (lower(correo));


-- Registro de cada búsqueda (base de las métricas de latencia)
CREATE TABLE consultas (
    id                   bigserial PRIMARY KEY,
    cliente_id           integer  NOT NULL REFERENCES clientes_api (id),
    usuario_id           integer  REFERENCES usuarios (id) ON DELETE SET NULL,
    texto                text     NOT NULL CHECK (length(trim(texto)) > 0),
    modelo_id            smallint NOT NULL REFERENCES modelos_embedding (id),
    embedding            vector(768),
    limite               smallint NOT NULL CHECK (limite BETWEEN 1 AND 100),
    similitud_minima     real     NOT NULL CHECK (similitud_minima BETWEEN 0 AND 1),
    cantidad_resultados  smallint NOT NULL DEFAULT 0 CHECK (cantidad_resultados >= 0),
    latencia_ms          integer  CHECK (latencia_ms >= 0),
    creado_en            timestamptz NOT NULL DEFAULT now()
);

CREATE INDEX consultas_creado_idx ON consultas (creado_en);
CREATE INDEX consultas_usuario_idx ON consultas (usuario_id);
CREATE INDEX consultas_sin_resultados_idx ON consultas (creado_en) WHERE cantidad_resultados = 0;

-- Productos que devolvió cada búsqueda
CREATE TABLE consulta_resultados (
    consulta_id  bigint   NOT NULL REFERENCES consultas (id) ON DELETE CASCADE,
    posicion     smallint NOT NULL CHECK (posicion > 0),
    producto_id  bigint   NOT NULL REFERENCES productos (id),
    similitud    real     NOT NULL,
    precio       numeric(12, 2),
    stock        numeric(12, 3),
    PRIMARY KEY (consulta_id, posicion),
    UNIQUE (consulta_id, producto_id)
);

CREATE VIEW resumen_consultas AS
SELECT creado_en::date AS dia,
       count(*) AS consultas,
       count(*) FILTER (WHERE cantidad_resultados = 0) AS sin_resultados,
       round(avg(latencia_ms)) AS latencia_promedio_ms,
       percentile_cont(0.95) WITHIN GROUP (ORDER BY latencia_ms) AS latencia_p95_ms
FROM consultas
GROUP BY creado_en::date;


-- Casos de prueba para medir la precisión de la búsqueda
CREATE TABLE casos_prueba (
    id           serial PRIMARY KEY,
    consulta     text NOT NULL UNIQUE,
    descripcion  text,
    activo       boolean NOT NULL DEFAULT true,
    creado_en    timestamptz NOT NULL DEFAULT now()
);

CREATE TABLE casos_prueba_esperados (
    caso_id      integer  NOT NULL REFERENCES casos_prueba (id) ON DELETE CASCADE,
    producto_id  bigint   NOT NULL REFERENCES productos (id),
    relevancia   smallint NOT NULL DEFAULT 1 CHECK (relevancia BETWEEN 1 AND 3),
    PRIMARY KEY (caso_id, producto_id)
);

INSERT INTO casos_prueba (consulta, descripcion) VALUES
    ('tela resistente para tapizar un sillón', 'Telas de tapicería'),
    ('relleno para el asiento de una silla', 'Espumas de tapicería'),
    ('algo para pintar una reja de fierro que no se oxide', 'Anticorrosivos'),
    ('tornillos para colgar planchas de yeso cartón', 'Tornillos para drywall');

-- Productos esperados iniciales (se revisan y amplían durante las pruebas)
INSERT INTO casos_prueba_esperados (caso_id, producto_id)
SELECT c.id, p.id
FROM casos_prueba c
JOIN productos p ON
       (c.descripcion = 'Telas de tapicería'     AND p.nombre ~* '(chenille|lino|felpa|tafet)')
    OR (c.descripcion = 'Espumas de tapicería'   AND p.nombre ~* 'espuma' AND p.nombre !~* 'poliuretano')
    OR (c.descripcion = 'Anticorrosivos'         AND p.nombre ~* 'anticorrosivo')
    OR (c.descripcion = 'Tornillos para drywall' AND p.nombre ~* 'drywall');
