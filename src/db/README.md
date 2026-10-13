# Base de datos

PostgreSQL 16 con las extensiones `pgvector` (búsqueda semántica) y `pg_trgm` (búsqueda por texto aproximado).

## Levantar

Desde la carpeta `src/`:

```bash
cp .env.example .env        # y cambiar la clave
docker compose up -d
```

Para revisar que quedó cargada:

```bash
docker compose exec db psql -U agentech -d agentech -c "select count(*) from productos;"
```

Para administrarla desde el navegador (Adminer en http://localhost:8080):

```bash
docker compose --profile herramientas up -d
```

Los scripts de `db/init/` se ejecutan solo cuando el volumen está vacío. Si se modifican, hay que recrear la base:

```bash
docker compose down -v
docker compose up -d
```

## Scripts de inicio

| Archivo | Qué hace |
|---|---|
| `01_extensiones.sql` | Habilita `vector` y `pg_trgm` |
| `02_esquema.sql` | Tablas, índices, trigger, vista y función de búsqueda |
| `03_carga_catalogo.sql` | Carga el catálogo de la ferretería desde `db/seed/catalogo_bsale.csv` |

## Modelo

- **categorias** y **marcas**: catálogos normalizados a partir del reporte de Bsale.
- **productos**: SKU, código de barras, nombre, categoría, marca, precio y stock. `stock` es numérico porque hay productos que se venden por metro.
- **producto_embeddings**: un vector de 768 dimensiones por producto, con el modelo y el texto que se usó para generarlo. Tiene índice HNSW por distancia coseno.
- **productos_pendientes_embedding** (vista): productos nuevos o cuyo nombre, descripción, categoría o marca cambió desde el último vector. Es la cola del worker de vectorización. Los cambios de stock o precio no generan un vector nuevo.
- **buscar_productos(vector, limite, similitud_minima)**: devuelve los productos más parecidos a la consulta, solo entre los activos con stock mayor a cero.
- **ingestas**: registro de cada carga por API, con los registros aceptados, rechazados y el detalle de errores.

## Actualizar el catálogo

Con un reporte de productos nuevo exportado desde Bsale:

```bash
pip install pandas openpyxl
python db/scripts/exportar_catalogo.py ruta/al/reporte.xlsx
```

Eso regenera `db/seed/catalogo_bsale.csv`. Después hay que recrear la base como se indica arriba.

## Pendiente

- El reporte de Bsale no incluye precio ni stock, así que se cargan en `NULL` y `0`. Se completan con el endpoint de ingesta.
- La dimensión del vector (768) corresponde a modelos como `nomic-embed-text` o `multilingual-e5-base`. Si se elige otro modelo, hay que cambiarla en `02_esquema.sql`.
