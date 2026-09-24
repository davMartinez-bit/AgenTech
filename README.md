# AgenTech

**Nombre del proyecto:** AgenTech

**Descripción:** Capa de inteligencia de compras, inventario y ventas para PYMEs, que funciona sobre el sistema de ventas que la empresa ya utiliza, sin reemplazarlo. Para el producto mínimo viable se integra con Bsale mediante su API y webhooks, sincronizando productos, stock y documentos de venta. Sobre estos datos, el sistema detecta productos sin rotación, identifica productos duplicados o equivalentes mediante búsqueda semántica y genera sugerencias de reposición. Además, incorpora asistentes basados en una arquitectura RAG: uno para el encargado de compras, que permite consultar el inventario en lenguaje natural, y otro para el vendedor, que ayuda a encontrar productos con stock disponible a partir de la necesidad del cliente y aclara diferencias entre productos. La solución se valida con una ferretería real que utiliza Bsale. La emisión de documentos tributarios electrónicos queda fuera del alcance, ya que es resuelta por Bsale.

## Tecnologías utilizadas

| Área | Tecnologías |
|---|---|
| Lenguaje | TypeScript |
| Backend | Node.js, API REST, Drizzle ORM |
| Frontend | React, Vite, Tailwind CSS |
| Base de datos | PostgreSQL con la extensión pgvector (datos relacionales y vectoriales) |
| Inteligencia artificial | Modelo de embeddings para búsqueda semántica y modelo de lenguaje (LLM) para la arquitectura RAG |
| Integraciones | API REST y webhooks de Bsale |
| Contenedores | Docker y Docker Compose |
| Cloud | AWS |
| Control de versiones | Git y GitHub |

## Instrucciones para ejecutar el proyecto localmente

**Requisitos previos:** Node.js 20 o superior, pnpm, Docker y Docker Compose, un token de acceso de Bsale (se puede obtener uno de pruebas creando una cuenta sandbox) y una API key del proveedor del modelo de lenguaje.

1. Clonar el repositorio:
   ```bash
   git clone https://github.com/<usuario>/agentech.git
   ```
2. Entrar a la carpeta del código:
   ```bash
   cd agentech/src
   ```
3. Crear el archivo de variables de entorno a partir del ejemplo y completar los valores:
   ```bash
   cp .env.example .env
   ```
   ```env
   DATABASE_URL=postgresql://agentech:agentech@localhost:5432/agentech
   BSALE_ACCESS_TOKEN=tu_token_de_bsale
   LLM_API_KEY=tu_api_key
   ```
4. Levantar PostgreSQL con pgvector:
   ```bash
   docker compose up -d
   ```
5. Instalar las dependencias:
   ```bash
   pnpm install
   ```
6. Aplicar las migraciones de la base de datos:
   ```bash
   pnpm db:migrate
   ```
7. Ejecutar la sincronización inicial con Bsale:
   ```bash
   pnpm sync:bsale
   ```
8. Iniciar el proyecto en modo desarrollo:
   ```bash
   pnpm dev
   ```
9. Abrir en el navegador: http://localhost:5173

## Integrantes del equipo con sus roles

| Integrante | Rol |
|---|---|
| David Martínez Arenas | Dev |
| Tomás Brogi Castillo | Dev |

## Metodología de trabajo del equipo

Metodología ágil basada en **Scrum**:

- El alcance se organiza en épicas escritas como historias de usuario, cada una con sus criterios de aceptación.
- Las épicas se estiman en puntos de historia (escala Fibonacci) mediante **Poker Planning**.
- El desarrollo se divide en cinco sprints de dos semanas, entre las semanas 5 y 14.
- Cada sprint cierra con una revisión del incremento junto al cliente y una retrospectiva del equipo.

| Épica | Puntos |
|---|---|
| Integración con Bsale | 13 |
| Calidad de datos | 5 |
| Detección de productos sin rotación | 5 |
| Detección de productos duplicados o equivalentes | 8 |
| Sugerencia de reposición | 8 |
| Asistente de compras con arquitectura RAG | 13 |
| Asistente de ventas con búsqueda semántica | 8 |
| Panel del encargado de compras | 8 |
| **Total** | **68** |

## Arquitectura de la solución

AgenTech utiliza una arquitectura desacoplada basada en servicios. Bsale es la fuente de verdad de ventas, stock y documentos tributarios; AgenTech sincroniza esos datos y construye sobre ellos una capa analítica y de inteligencia artificial.

```mermaid
flowchart LR
    B[Bsale<br/>API REST y webhooks] --> S[Servicio de sincronización]
    S --> Q[Validación y calidad de datos]
    Q --> DB[(PostgreSQL<br/>datos relacionales)]
    Q --> E[Generación de embeddings]
    E --> V[(pgvector<br/>datos vectoriales)]
    DB --> A[Motor analítico<br/>rotación, duplicados, reposición]
    V --> A
    DB --> R[Motor RAG]
    V --> R
    R --> LLM[Modelo de lenguaje]
    A --> P[Panel del encargado de compras]
    R --> AC[Asistente de compras]
    R --> AV[Asistente de ventas]
```

**Flujo principal:**

1. El servicio de sincronización obtiene productos, stock y ventas desde la API de Bsale y se mantiene actualizado mediante webhooks.
2. Los datos se validan, se marcan inconsistencias (como costos en cero o márgenes negativos) y se guardan en PostgreSQL.
3. Se generan embeddings de los nombres y descripciones de los productos, que se almacenan en pgvector.
4. El motor analítico detecta productos sin rotación, posibles duplicados y calcula sugerencias de reposición.
5. El motor RAG recupera la información relevante desde PostgreSQL y pgvector, y el modelo de lenguaje genera respuestas fundamentadas en esos datos, tanto para el asistente de compras como para el de ventas.

## Estructura del repositorio

```
agentech/
├── README.md
├── src/                          # Código fuente del proyecto
└── Fase 1/
    ├── Evidencias Grupales/
    └── Evidencias Individuales/
```
