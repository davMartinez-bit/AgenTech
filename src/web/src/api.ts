// Cliente mínimo de la API de AgenTech (en desarrollo Vite redirige estas rutas a localhost:3000).

export type Producto = {
  sku: string;
  nombre: string;
  categoria: string | null;
  marca?: string | null;
  precio: number | null;
  stock: number;
  unidad_medida?: string | null;
  foto?: string | null;
};

export type ResultadoConsulta = {
  consulta_id: number;
  texto: string;
  modelo: string;
  latencia_ms: number;
  agotado_parecido: { sku: string; nombre: string; foto: string | null } | null;
  resultados: (Producto & { score: number })[];
};

export type Complemento = Producto & { veces_juntos: number; confianza: number };
export type Alternativa = Producto & { similitud: number };

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
  consulta: (texto: string, limite = 8) =>
    pedir<ResultadoConsulta>("/consulta", { method: "POST", body: JSON.stringify({ texto, limite }) }),
  resumen: () => pedir<Record<string, any>>("/admin/resumen"),
  grafico: (id: string) => pedir<{ id: string; titulo: string; descripcion: string; datos: any[] }>(`/admin/graficos/${id}`),
  interpretar: (grafico: string) =>
    pedir<{ texto: string; modelo: string; latencia_ms: number; desde_cache: boolean }>("/admin/interpretar", {
      method: "POST",
      body: JSON.stringify({ grafico }),
    }),
  ingestas: () => pedir<any[]>("/admin/ingestas"),
  consultas: () => pedir<any[]>("/admin/consultas"),
};

const clp = new Intl.NumberFormat("es-CL", { style: "currency", currency: "CLP", maximumFractionDigits: 0 });
const num = new Intl.NumberFormat("es-CL", { maximumFractionDigits: 1 });

export const pesos = (v: number | null | undefined) => (v == null ? "Sin precio" : clp.format(v));
export const numero = (v: number | null | undefined) => (v == null ? "—" : num.format(v));
export const pesosCortos = (v: number) =>
  Math.abs(v) >= 1_000_000 ? `$${num.format(v / 1_000_000)} M` : Math.abs(v) >= 1000 ? `$${num.format(v / 1000)} mil` : clp.format(v);
