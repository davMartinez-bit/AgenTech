# Worker de vectorización

Genera el embedding de cada producto y lo guarda en `producto_embeddings`. Procesa la vista `productos_pendientes_embedding`: productos activos sin vector o cuyo nombre, descripción, categoría o marca cambió después de generar su vector. Los cambios de stock o precio no generan un vector nuevo.

## Modelo

- `nomic-embed-text` servido por [Ollama](https://ollama.com), 768 dimensiones (registrado en `modelos_embedding`).
- A cada texto se le antepone `search_document: `, como indica el modelo para los documentos. Las consultas de búsqueda deben usar `search_query: `.

## Requisitos

- La base levantada (`docker compose up -d db` desde `src/`).
- Ollama corriendo y el modelo descargado:

```bash
ollama pull nomic-embed-text
```

- Python 3.11 o superior.

## Uso

Desde `src/`:

```bash
python -m venv worker/.venv
worker/.venv/Scripts/pip install -r worker/requirements.txt
worker/.venv/Scripts/python worker/vectorizar.py
```

En Linux o macOS la carpeta es `worker/.venv/bin/` en lugar de `worker/.venv/Scripts/`.

- Sin argumentos procesa la cola una vez y termina.
- `--intervalo 60` deja el worker revisando la cola cada 60 segundos.
- `--lote 32` cambia cuántos productos se envían al modelo por llamada.

## Configuración

Lee `src/.env` (las variables ya definidas en el entorno tienen prioridad):

| Variable | Por defecto |
|---|---|
| `POSTGRES_HOST` | `localhost` |
| `POSTGRES_PORT`, `POSTGRES_DB`, `POSTGRES_USER`, `POSTGRES_PASSWORD` | los mismos de la base |
| `OLLAMA_URL` | `http://localhost:11434` |
| `EMBEDDING_MODEL` | `nomic-embed-text` |

## Comprobar

```bash
docker compose exec db psql -U agentech -d agentech -c "select count(*) from producto_embeddings;"
```

Debe coincidir con la cantidad de productos activos, y la vista `productos_pendientes_embedding` debe quedar vacía.
