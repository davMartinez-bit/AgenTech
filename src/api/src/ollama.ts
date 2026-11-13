import { config } from "./config.js";
import { ErrorApi } from "./errores.js";

// Prefijos que cada modelo espera para distinguir consultas de documentos.
// Deben coincidir con PREFIJOS en src/worker/vectorizar.py.
const PREFIJOS_CONSULTA: Record<string, string> = {
  "nomic-embed-text": "search_query: ",
  "nomic-embed-text-v2-moe": "search_query: ",
  "multilingual-e5-base": "query: ",
};

export function prefijoConsulta(modelo: string): string {
  const base = modelo.split(":")[0];
  if (base.includes("e5")) return "query: ";
  return PREFIJOS_CONSULTA[base] ?? "";
}

async function llamar(ruta: string, cuerpo: unknown): Promise<any> {
  let respuesta: Response;
  try {
    respuesta = await fetch(`${config.ollamaUrl}${ruta}`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify(cuerpo),
    });
  } catch {
    throw new ErrorApi(503, "modelo_no_disponible", "No se pudo conectar con Ollama. ¿Está corriendo `ollama serve`?");
  }
  if (!respuesta.ok) {
    throw new ErrorApi(503, "modelo_no_disponible", `Ollama respondió ${respuesta.status}: ${await respuesta.text()}`);
  }
  return respuesta.json();
}

// Caché en memoria de embeddings de consulta: el vendedor repite las mismas frases y no hace falta
// volver a llamar al modelo. Se descarta la entrada más antigua al pasar del límite (LRU simple).
const CACHE_MAXIMO = 500;
const cacheEmbeddings = new Map<string, number[]>();

function leerCache(clave: string): number[] | undefined {
  const vector = cacheEmbeddings.get(clave);
  if (vector) {
    cacheEmbeddings.delete(clave);
    cacheEmbeddings.set(clave, vector);
  }
  return vector;
}

function guardarCache(clave: string, vector: number[]): void {
  cacheEmbeddings.delete(clave);
  cacheEmbeddings.set(clave, vector);
  if (cacheEmbeddings.size > CACHE_MAXIMO) {
    cacheEmbeddings.delete(cacheEmbeddings.keys().next().value as string);
  }
}

export async function embeberConsulta(texto: string, modelo = config.modeloEmbedding): Promise<number[]> {
  const clave = modelo + "\n" + texto;
  const guardado = leerCache(clave);
  if (guardado) return guardado;
  const datos = await llamar("/api/embed", { model: modelo, input: [prefijoConsulta(modelo) + texto], keep_alive: "30m" });
  const vector = datos.embeddings?.[0];
  if (Array.isArray(vector) && vector.length) guardarCache(clave, vector);
  return vector;
}

export async function conversar(
  sistema: string,
  usuario: string,
  modelo = config.modeloAgente,
  opciones: { formato?: "json"; temperatura?: number; maxTokens?: number } = {},
): Promise<string> {
  const cuerpo: Record<string, unknown> = {
    model: modelo,
    stream: false,
    options: {
      temperature: opciones.temperatura ?? 0.1,
      ...(opciones.maxTokens !== undefined ? { num_predict: opciones.maxTokens } : {}),
    },
    messages: [
      { role: "system", content: sistema },
      { role: "user", content: usuario },
    ],
  };
  if (opciones.formato === "json") cuerpo.format = "json";
  const datos = await llamar("/api/chat", cuerpo);
  return String(datos.message?.content ?? "").trim();
}
