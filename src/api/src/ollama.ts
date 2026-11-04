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

export async function embeberConsulta(texto: string, modelo = config.modeloEmbedding): Promise<number[]> {
  const datos = await llamar("/api/embed", { model: modelo, input: [prefijoConsulta(modelo) + texto] });
  return datos.embeddings[0];
}

export async function conversar(sistema: string, usuario: string, modelo = config.modeloAgente): Promise<string> {
  const datos = await llamar("/api/chat", {
    model: modelo,
    stream: false,
    options: { temperature: 0.1 },
    messages: [
      { role: "system", content: sistema },
      { role: "user", content: usuario },
    ],
  });
  return String(datos.message?.content ?? "").trim();
}
