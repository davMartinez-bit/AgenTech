# API de AgenTech

API en Node.js + Express + TypeScript. Expone la ingesta del catálogo, la consulta en lenguaje natural
(búsqueda híbrida) y los datos del panel administrativo, incluido el agente que interpreta los gráficos.

Funciona **solo en local** (proyecto de título). No se publica en ningún servidor ni toca la tienda en línea.

## Requisitos

- Base de datos levantada (`docker compose up -d db` en `src/`).
- Ollama corriendo (`ollama serve`) con el modelo de embeddings (`EMBEDDING_MODEL`) y el modelo del agente (`AGENT_MODEL`).
- Node.js 22 o superior.

## Levantar

```bash
npm install
```

```bash
npm run dev
```

La API queda en `http://localhost:3000` y la documentación OpenAPI (Swagger) en `http://localhost:3000/docs`.
Lee la configuración de `src/.env` (ver `src/.env.example`).

## Endpoints

| Método | Ruta | Para qué |
|---|---|---|
| POST | `/ingesta` | Recibe el catálogo (SKU, nombre, precio, stock obligatorios). Alta o actualización por SKU; rechaza registro por registro con su motivo |
| POST | `/consulta` | Busca productos con una frase como la dice el cliente. Devuelve SKU, nombre, precio, stock y `score` |
| GET | `/productos`, `/productos/{sku}`, `/categorias` | Catálogo para el panel del vendedor |
| GET | `/admin/resumen` | Indicadores del panel administrativo |
| GET | `/admin/graficos/{id}` | Datos de cada gráfico (ventas de Bsale, stock, uso del buscador) |
| POST | `/admin/interpretar` | El agente explica un gráfico en lenguaje simple, usando solo los datos del gráfico |
| GET | `/admin/ingestas`, `/admin/consultas` | Historial de cargas y de búsquedas |
| GET | `/salud` | Estado de la API y la base |

Los errores siempre vienen como `{ "error": { "codigo", "mensaje", "detalles" } }` con el código HTTP que corresponde.

## Cargar precio, stock y ventas desde Bsale

Bsale se usa **solo en lectura** (pedidos GET). Con la API corriendo:

```bash
python ../db/scripts/sincronizar_bsale.py catalogo
```

```bash
python ../db/scripts/sincronizar_bsale.py ventas --meses 12
```

El token va en `BSALE_ACCESS_TOKEN` dentro de `src/.env` (o en otro archivo con `--env`). Nunca se sube al repositorio.
