// Cliente mínimo de la API de AgenTech (en desarrollo Vite redirige estas rutas a localhost:3000).

export type Producto = {
  sku: string;
  nombre: string;
  categoria: string | null;
  marca?: string | null;
  precio: number | null;
  stock: number;
  unidad_medida?: string | null;
  unidad?: string;
  foto?: string | null;
};

export type ResultadoConsulta = {
  consulta_id: number;
  origen?: "buscador" | "asistente";
  texto: string;
  texto_buscado: string;
  se_corrigio: boolean;
  // Solo en el asistente: las búsquedas cortas en que se tradujo el pedido del cliente.
  interpretacion?: string[];
  modelo: string;
  latencia_ms: number;
  agotado_parecido: { sku: string; nombre: string; foto: string | null } | null;
  resultados: (Producto & { score: number })[];
  modo?: "semantica" | "solo_texto";
};

export type RespuestaAsistente = {
  consulta_id: number;
  respuesta: string;
  recomendados: { sku: string; nombre: string }[];
  ejemplos: number;
  generada: boolean;
  modelo: string | null;
  latencia_ms: number;
};

export type Complemento = Producto & { veces_juntos: number; confianza: number };
export type Alternativa = Producto & { similitud: number };

export type TipoAlerta = "por_agotarse" | "agotado_con_demanda" | "agotado_olvidado" | "stock_parado" | "piden_y_no_hay";

export type Alerta = {
  tipo: TipoAlerta;
  urgencia: 1 | 2 | 3;
  sku: string | null;
  unidad?: string;
  nombre: string;
  categoria: string | null;
  aviso: string;
  accion: string;
  monto: number;
  datos: Record<string, number | null>;
};

export type Alertas = {
  fechas: { ventas_hasta: string | null; recepciones_hasta: string | null; stock_leido_el: string; dias_stock_viejo: number };
  conteo: Record<TipoAlerta, number>;
  montos: Record<TipoAlerta, number>;
  por_agotarse_urgentes: number;
  resumen_reglas: string;
  alertas: Alerta[];
};

export type AvisosAgente = {
  texto: string;
  redactado_por: "agente" | "reglas";
  modelo: string;
  latencia_ms: number;
  desde_cache: boolean;
  motivo?: string;
};

async function pedir<T>(ruta: string, opciones?: RequestInit): Promise<T> {
  const r = await fetch(ruta, {
    ...opciones,
    headers: { "Content-Type": "application/json", ...(opciones?.headers ?? {}) },
  });
  const datos = await r.json().catch(() => ({}));
  if (!r.ok) throw new Error(datos?.error?.mensaje ?? `Error ${r.status}`);
  return datos as T;
}

export const api = {
  productos: (params: Record<string, string | number | undefined>) => {
    const q = new URLSearchParams(Object.entries(params).filter(([, v]) => v !== undefined && v !== "") as [string, string][]);
    return pedir<{ total: number; productos: Producto[] }>(`/productos?${q}`);
  },
  alternativas: (sku: string, limite = 4) =>
    pedir<Alternativa[]>(`/productos/${encodeURIComponent(sku)}/alternativas?limite=${limite}`),
  complementos: (sku: string, limite = 4) =>
    pedir<Complemento[]>(`/productos/${encodeURIComponent(sku)}/complementos?limite=${limite}`),
  categorias: () => pedir<{ nombre: string; productos: number; disponibles: number }[]>("/categorias"),
  // "buscador": palabras simples o compuestas. "asistente": lo que dijo el cliente (suma las frases de cliente).
  consulta: (texto: string, limite = 8, origen: "buscador" | "asistente" = "buscador") =>
    pedir<ResultadoConsulta>("/consulta", { method: "POST", body: JSON.stringify({ texto, limite, origen }) }),
  // Avisa qué resultado se abrió. No interrumpe al vendedor si falla.
  clic: (consultaId: number, sku: string, origen: "buscador" | "asistente") =>
    pedir(`/consulta/${consultaId}/clic`, { method: "POST", body: JSON.stringify({ sku, origen }) }).catch(() => {}),
  resumen: () => pedir<Record<string, any>>("/admin/resumen"),
  grafico: (id: string) => pedir<{ id: string; titulo: string; descripcion: string; datos: any[] }>(`/admin/graficos/${id}`),
  interpretar: (grafico: string) =>
    pedir<{ texto: string; modelo: string; latencia_ms: number; desde_cache: boolean }>("/admin/interpretar", {
      method: "POST",
      body: JSON.stringify({ grafico }),
    }),
  alertas: () => pedir<Alertas>("/admin/alertas"),
  avisos: () => pedir<AvisosAgente>("/admin/avisos", { method: "POST" }),
  ingestas: () => pedir<any[]>("/admin/ingestas"),
  consultas: () => pedir<any[]>("/admin/consultas"),
};

// Respuesta del asistente para una consulta ya hecha. Puede tardar de 1 a 10 s y fallar con 503.
export const pedirRespuesta = (consultaId: number) =>
  pedir<RespuestaAsistente>(`/consulta/${consultaId}/respuesta`, { method: "POST" });

const clp = new Intl.NumberFormat("es-CL", { style: "currency", currency: "CLP", maximumFractionDigits: 0 });
const num = new Intl.NumberFormat("es-CL", { maximumFractionDigits: 1 });

export const pesos = (v: number | null | undefined) => (v == null ? "Sin precio" : clp.format(v));
export const numero = (v: number | null | undefined) => (v == null ? "—" : num.format(v));
// Cantidad con su unidad de venta: "3,8 m", "12 kg". Lo que se vende por unidad queda como número solo.
const ABREVIATURA: Record<string, string> = { metro: "m", kilo: "kg", litro: "L" };
export const cantidad = (v: number | null | undefined, unidad?: string) =>
  unidad && ABREVIATURA[unidad] ? `${numero(v)} ${ABREVIATURA[unidad]}` : numero(v);
export const pesosCortos = (v: number) =>
  Math.abs(v) >= 1_000_000 ? `$${num.format(v / 1_000_000)} M` : Math.abs(v) >= 1000 ? `$${num.format(v / 1000)} mil` : clp.format(v);
