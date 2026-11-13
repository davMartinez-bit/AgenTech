// Configuración leída de src/.env (npm run dev la carga con --env-file).

function numero(nombre: string, porDefecto: number): number {
  const valor = process.env[nombre];
  return valor ? Number(valor) : porDefecto;
}

export const config = {
  puerto: numero("API_PORT", 3000),
  postgres: {
    host: process.env.POSTGRES_HOST ?? "localhost",
    port: numero("POSTGRES_PORT", 5432),
    database: process.env.POSTGRES_DB ?? "agentech",
    user: process.env.POSTGRES_USER ?? "agentech",
    password: process.env.POSTGRES_PASSWORD,
  },
  // 127.0.0.1 y no localhost: en Windows localhost prueba primero IPv6 y agrega ~2 s por llamada.
  ollamaUrl: process.env.OLLAMA_URL ?? "http://127.0.0.1:11434",
  // Debe ser el mismo modelo con que el worker vectorizó los productos.
  modeloEmbedding: process.env.EMBEDDING_MODEL ?? "nomic-embed-text-v2-moe",
  // Modelo de lenguaje del agente que interpreta los gráficos del panel administrativo.
  modeloAgente: process.env.AGENT_MODEL ?? "qwen2.5:7b",
  // Modelo chico y rápido con que el asistente traduce lo que dijo el cliente a búsquedas cortas.
  modeloInterprete: process.env.INTERPRETE_MODEL ?? "gemma3:4b",
  // Modelo que redacta la sugerencia del asistente. El mismo modelo chico: cabe junto al de embeddings
  // en una tarjeta gráfica de 6 GB y no hay que cargar otro modelo en cada pregunta.
  modeloRespuesta: process.env.RESPUESTA_MODEL ?? "gemma3:4b",
  // Umbral y peso fijados con src/worker/evaluar_busqueda.py (03-11-2026).
  similitudMinima: Number(process.env.SIMILITUD_MINIMA ?? 0.32),
  pesoTexto: Number(process.env.PESO_TEXTO ?? 0.15),
  // Carpeta con las fotos <SKU>.jpg del e-commerce (opcional).
  fotosDir: process.env.FOTOS_DIR,
};
