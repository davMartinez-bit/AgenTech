import { createHash } from "node:crypto";
import { Router } from "express";
import { config } from "../config.js";
import { consultar } from "../db.js";
import { conversar } from "../ollama.js";

// Avisos de inventario del panel: qué se está por acabar, qué se acabó y se vendía, qué lleva
// tiempo en cero, qué plata está parada en bodega y qué piden los clientes y no hay.
// Las reglas y las cifras las calcula este archivo con la vista productos_situacion.
// El agente solo las redacta; si cambia una cifra, se muestra el texto de las reglas.

export const REGLAS = {
  diasMinimosDeStock: 14, // con menos días de stock que esto, el producto está "por agotarse"
  diasUrgente: 7,
  diasACubrir: 30, // la compra sugerida deja stock para este plazo
  ventasMinimas30: 3, // con menos ventas el ritmo no es confiable
  diasStockParado: 120,
  valorMinimoParado: 30000,
  diasRecienComprado: 60,
  vecesMinimasBusqueda: 2,
  porTipo: 25, // filas que se envían al panel por cada tipo
};

export type TipoAlerta = "por_agotarse" | "agotado_con_demanda" | "agotado_olvidado" | "stock_parado" | "piden_y_no_hay";

export type Situacion = {
  sku: string;
  nombre: string;
  categoria: string | null;
  precio: number | null;
  stock_bsale: number; // lo que decía Bsale en la última lectura del catálogo
  vendido_desde_corte: number; // lo vendido después de esa lectura
  stock_estimado: number;
  unidades_30: number;
  unidades_30_previos: number;
  unidades_90: number;
  total_90: number;
  unidades_365: number;
  dias_sin_vender: number | null;
  dias_sin_comprar: number | null;
  unidad: string; // unidad de venta del producto: metro, kilo, litro o unidad
};

export type Alerta = {
  tipo: TipoAlerta;
  urgencia: 1 | 2 | 3; // 1 = hoy, 2 = esta semana, 3 = cuando puedas
  sku: string | null;
  nombre: string;
  categoria: string | null;
  unidad: string; // unidad de venta: metro, kilo, litro o unidad
  aviso: string;
  accion: string;
  monto: number; // venta mensual en juego; en stock_parado, valor inmovilizado
  datos: Record<string, number | null>;
};

export const ETIQUETAS: Record<TipoAlerta, string> = {
  por_agotarse: "Por agotarse",
  agotado_con_demanda: "Agotado y se vendía",
  agotado_olvidado: "En cero hace tiempo",
  stock_parado: "Stock parado",
  piden_y_no_hay: "Lo piden y no hay",
};

const clp = new Intl.NumberFormat("es-CL", { style: "currency", currency: "CLP", maximumFractionDigits: 0 });
const num = new Intl.NumberFormat("es-CL", { maximumFractionDigits: 1 });
const n = (v: number) => num.format(v);
// Cantidad con su unidad de venta: "3,8 m", "12 kg". Lo que se vende por unidad queda como número solo.
const ABREVIATURA: Record<string, string> = { metro: "m", kilo: "kg", litro: "L" };
const cant = (v: number, unidad: string) => (ABREVIATURA[unidad] ? `${n(v)} ${ABREVIATURA[unidad]}` : n(v));
const hace = (dias: number) => (dias <= 0 ? "hoy" : dias === 1 ? "ayer" : `hace ${dias} días`);

/** Decide si un producto merece aviso y lo redacta con sus cifras. Sin base de datos: se puede probar sola. */
export function clasificar(p: Situacion, hayRecepciones: boolean): Alerta | null {
  const base = { sku: p.sku, nombre: p.nombre, categoria: p.categoria, unidad: p.unidad };
  const precio = p.precio ?? 0;
  const stock = p.stock_estimado;
  const datos = {
    stock,
    unidades_30: p.unidades_30,
    unidades_30_previos: p.unidades_30_previos,
    unidades_90: p.unidades_90,
    total_90: p.total_90,
    unidades_365: p.unidades_365,
    dias_sin_vender: p.dias_sin_vender,
    dias_sin_comprar: p.dias_sin_comprar,
  };
  // Bsale decía que había stock y después se vendió eso o más: o se acabó o llegó mercadería.
  // No se sabe hasta la próxima lectura del stock, así que se avisa como "revisa", no como hecho.
  const estimado = stock <= 0 && p.stock_bsale > 0;
  const enCero = estimado
    ? `Puede que ya no quede: Bsale tenía ${cant(p.stock_bsale, p.unidad)} en su última lectura y después se vendieron ${cant(p.vendido_desde_corte, p.unidad)}.`
    : "Está en 0";
  const compra =
    !hayRecepciones ? "" : p.dias_sin_comprar == null ? " No tiene compras registradas en Bsale." : ` La última compra fue ${hace(p.dias_sin_comprar)}.`;

  // "unas 12" si se vende por unidad; "unos 12 m" si se vende por metro, kilo o litro.
  const unas = (v: number) => (p.unidad === "unidad" ? `unas ${n(v)}` : `unos ${cant(v, p.unidad)}`);

  if (stock > 0 && p.unidades_30 >= REGLAS.ventasMinimas30) {
    const alcanza = stock / (p.unidades_30 / 30);
    if (alcanza < REGLAS.diasMinimosDeStock) {
      const dias = Math.floor(alcanza);
      const comprar = Math.max(1, Math.ceil((p.unidades_30 / 30) * REGLAS.diasACubrir - stock));
      const acelera = p.unidades_30_previos > 0 && p.unidades_30 >= 1.5 * p.unidades_30_previos;
      return {
        ...base,
        tipo: "por_agotarse",
        urgencia: alcanza < REGLAS.diasUrgente ? 1 : 2,
        aviso:
          `Quedan ${cant(stock, p.unidad)} y se vendieron ${cant(p.unidades_30, p.unidad)} en los últimos 30 días: alcanza para ` +
          `${dias < 1 ? "menos de un día" : dias === 1 ? "1 día" : `unos ${dias} días`}.` +
          (acelera ? ` Se está vendiendo más que antes: en los 30 días anteriores fueron ${cant(p.unidades_30_previos, p.unidad)}.` : ""),
        accion: `Compra ${unas(comprar)} para cubrir ${REGLAS.diasACubrir} días.`,
        monto: Math.round(p.unidades_30 * precio),
        datos: { ...datos, dias_alcanza: dias, comprar },
      };
    }
  }

  if (stock <= 0 && p.unidades_90 > 0) {
    const alMes = Math.max(1, Math.round(p.unidades_90 / 3));
    return {
      ...base,
      tipo: "agotado_con_demanda",
      urgencia: p.unidades_30 >= REGLAS.ventasMinimas30 ? 1 : 2,
      aviso:
        (estimado
          ? `${enCero} En los últimos 90 días se vendieron ${cant(p.unidades_90, p.unidad)} (${clp.format(p.total_90)}).`
          : `${enCero} y se vendieron ${cant(p.unidades_90, p.unidad)} en los últimos 90 días (${clp.format(p.total_90)}).`) +
        (p.dias_sin_vender != null ? ` La última venta fue ${hace(p.dias_sin_vender)}.` : "") +
        compra,
      accion: estimado
        ? `Revisa cuánto queda y reponlo si falta: se vendían ${unas(alMes)} al mes.`
        : `Reponlo: se vendían ${unas(alMes)} al mes.`,
      monto: Math.round(p.total_90 / 3),
      datos: { ...datos, al_mes: alMes, stock_bsale: estimado ? p.stock_bsale : null, vendido_desde_corte: estimado ? p.vendido_desde_corte : null },
    };
  }

  if (stock <= 0 && p.unidades_365 >= REGLAS.ventasMinimas30 && p.dias_sin_vender != null) {
    return {
      ...base,
      tipo: "agotado_olvidado",
      urgencia: 3,
      aviso:
        `Está en 0 hace tiempo: la última venta fue ${hace(p.dias_sin_vender)} y en el último año se vendieron ${cant(p.unidades_365, p.unidad)}.` +
        compra,
      accion: "Decide si lo vuelves a traer o si lo sacas del catálogo.",
      monto: Math.round((p.unidades_365 * precio) / 12),
      datos,
    };
  }

  const valor = Math.round(stock * precio);
  const sinVender = p.dias_sin_vender == null || p.dias_sin_vender >= REGLAS.diasStockParado;
  const recienComprado = p.dias_sin_comprar != null && p.dias_sin_comprar < REGLAS.diasRecienComprado;
  if (stock > 0 && sinVender && !recienComprado && valor >= REGLAS.valorMinimoParado) {
    return {
      ...base,
      tipo: "stock_parado",
      urgencia: 3,
      aviso:
        `Hay ${cant(stock, p.unidad)} en bodega (${clp.format(valor)} a precio de venta) y ` +
        (p.dias_sin_vender == null ? "no registra ventas en el último año." : `no se vende ${hace(p.dias_sin_vender)}.`) +
        compra,
      accion: "Ponlo a la vista o en oferta, y no lo recompres por ahora.",
      monto: valor,
      datos: { ...datos, valor },
    };
  }
  return null;
}

const TIPOS = Object.keys(ETIQUETAS) as TipoAlerta[];

export async function calcularAlertas() {
  const [productos, busquedas, [fechas]] = await Promise.all([
    consultar<Situacion & { stock_leido_el: string }>(
      "SELECT s.*, unidad_venta(p.nombre, p.permite_decimal, p.unidad_medida) AS unidad FROM productos_situacion s JOIN productos p ON p.id = s.producto_id",
    ),
    consultar<{ busqueda: string; veces: number; ultima_vez: string }>(
      `SELECT lower(btrim(texto)) AS busqueda, count(*)::int AS veces, max(creado_en)::date AS ultima_vez
       FROM consultas WHERE cantidad_resultados = 0 AND creado_en >= now() - interval '30 days'
       GROUP BY 1 HAVING count(*) >= $1 ORDER BY veces DESC, ultima_vez DESC`,
      [REGLAS.vecesMinimasBusqueda],
    ),
    consultar<{ ventas_hasta: string | null; recepciones_hasta: string | null; stock_leido_el: string; dias_stock_viejo: number }>(
      `SELECT (SELECT max(emitido_en) FROM ventas)              AS ventas_hasta,
              (SELECT max(recibido_en) FROM recepciones_stock)  AS recepciones_hasta,
              corte.dia                                         AS stock_leido_el,
              current_date - corte.dia                          AS dias_stock_viejo
       FROM (SELECT coalesce(max(terminado_en), now())::date AS dia FROM sincronizaciones_bsale
             WHERE estado = 'ok' AND recurso = 'catalogo') corte`,
    ),
  ]);
  const hayRecepciones = fechas.recepciones_hasta != null;

  const todas: Alerta[] = [];
  for (const p of productos) {
    const a = clasificar(p, hayRecepciones);
    if (a) todas.push(a);
  }
  for (const b of busquedas) {
    todas.push({
      tipo: "piden_y_no_hay",
      urgencia: 3,
      sku: null,
      nombre: b.busqueda,
      categoria: null,
      unidad: "unidad",
      aviso: `Lo buscaron ${b.veces} veces en los últimos 30 días y el buscador no encontró nada con stock.`,
      accion: "Revisa si conviene traerlo o si en el catálogo tiene otro nombre.",
      monto: 0,
      datos: { veces: b.veces },
    });
  }
  todas.sort((a, b) => a.urgencia - b.urgencia || b.monto - a.monto);

  const conteo = Object.fromEntries(TIPOS.map((t) => [t, 0])) as Record<TipoAlerta, number>;
  const montos = { ...conteo };
  let urgentes = 0;
  for (const a of todas) {
    conteo[a.tipo]++;
    montos[a.tipo] += a.monto;
    if (a.tipo === "por_agotarse" && a.urgencia === 1) urgentes++;
  }
  const alertas = TIPOS.flatMap((t) => todas.filter((a) => a.tipo === t).slice(0, REGLAS.porTipo));
  return {
    fechas,
    reglas: REGLAS,
    etiquetas: ETIQUETAS,
    conteo,
    montos,
    por_agotarse_urgentes: urgentes,
    resumen_reglas: textoDeReglas(elegirAvisos(alertas)), // lo que se muestra mientras el agente redacta
    alertas,
  };
}

// ---------------------------------------------------------------- agente

// Cómo suena cada tipo de aviso. N, M, D y C son las cifras del aviso: el ejemplo no trae números
// para que el modelo no los copie.
const EJEMPLOS: Record<Exclude<TipoAlerta, "piden_y_no_hay">, string> = {
  por_agotarse: "Te va quedando poco: N, y se han vendido M en 30 días. Te alcanza para unos D días. Compra unas C.",
  agotado_con_demanda: "Se te acabó y se estaba vendiendo bien: M en 90 días. Reponlo luego, salían unas C al mes.",
  agotado_olvidado: "Lleva harto tiempo en 0: la última venta fue hace D días. Ve si lo vuelves a traer o lo sacas del catálogo.",
  stock_parado: "Aquí tienes plata parada: N en bodega y no se mueve. Ponlo a la vista o en oferta, y no lo recompres por ahora.",
};
const EJEMPLO_URGENTE = "Ojito, te quedan poquitas (N) y se han vendido harto: M en 30 días. Te alcanza para unos D días. Compra unas C.";

function sistemaPara(a: Alerta): string {
  const ejemplo = a.tipo === "por_agotarse" && a.urgencia === 1 ? EJEMPLO_URGENTE : EJEMPLOS[a.tipo as keyof typeof EJEMPLOS];
  return `Eres el encargado de confianza de una ferretería y tapicería de Chile y le hablas al dueño.
Recibes los datos de UN aviso de inventario que el sistema ya calculó (son exactos).
Díselo como en persona: cercano, directo, en español de Chile, con "tú".

Así suena este tipo de aviso (N, M, D y C son las cifras del aviso):
"${ejemplo}"

Reglas:
- Una o dos frases, máximo 35 palabras, en una sola línea.
- No nombres el producto: su nombre ya está escrito antes de tu frase.
- Usa solo las cifras del aviso y escríbelas igual. No calcules, no redondees, no inventes cifras ni causas.
- Si el aviso trae "unidad de venta", escribe las cantidades con esa unidad (por ejemplo: 3,8 metros).
- Termina con qué hacer, con su cifra si el aviso la trae.
- Sin comillas, sin viñetas, sin negritas, sin título.`;
}

/** Avisos que se le pasan al agente: los más urgentes de cada tipo, para que el resumen sea corto y variado. */
export function elegirAvisos(alertas: Alerta[]): Alerta[] {
  const cupos: [TipoAlerta, number][] = [
    ["por_agotarse", 3],
    ["agotado_con_demanda", 2],
    ["agotado_olvidado", 1],
    ["stock_parado", 1],
  ]; // "Lo piden y no hay" queda en la pestaña del buscador: ahí también caen búsquedas de prueba.
  return cupos.flatMap(([tipo, cupo]) => alertas.filter((a) => a.tipo === tipo).slice(0, cupo));
}

const UNIDAD_PLURAL: Record<string, string> = { metro: "metros", kilo: "kilos", litro: "litros" };

/** Los datos de un aviso como lista de campos: así el agente redacta y no copia una frase hecha. */
export function datosParaAgente(a: Alerta): string {
  const d = a.datos;
  const campos: (string | false)[] = [
    UNIDAD_PLURAL[a.unidad] && `unidad de venta: ${UNIDAD_PLURAL[a.unidad]}`,
    `tipo: ${ETIQUETAS[a.tipo]}`,
    `producto: ${a.nombre}`,
  ];
  if (a.tipo === "por_agotarse") {
    const acelera = d.unidades_30_previos! > 0 && d.unidades_30! >= 1.5 * d.unidades_30_previos!;
    campos.push(
      `quedan: ${n(d.stock!)}`,
      `vendidos en los últimos 30 días: ${n(d.unidades_30!)}`,
      acelera && `vendidos en los 30 días anteriores: ${n(d.unidades_30_previos!)} (ahora se vende más)`,
      `alcanza para: ${d.dias_alcanza! < 1 ? "menos de un día" : `${d.dias_alcanza} días`}`,
      `comprar para cubrir ${REGLAS.diasACubrir} días: ${n(d.comprar!)}`,
    );
  } else if (a.tipo === "stock_parado") {
    campos.push(
      `en bodega: ${n(d.stock!)}`,
      `valor a precio de venta: ${clp.format(d.valor!)}`,
      d.dias_sin_vender == null ? "sin ventas en el último año" : `última venta: ${hace(d.dias_sin_vender)}`,
      "qué hacer: ponerlo a la vista o en oferta y no recomprarlo por ahora",
    );
  } else {
    campos.push(
      d.stock_bsale != null
        ? `stock: ya debería estar en 0 (Bsale tenía ${n(d.stock_bsale)} en su última lectura y después se vendieron ${n(d.vendido_desde_corte!)})`
        : "stock: 0",
    );
    if (a.tipo === "agotado_con_demanda")
      campos.push(`vendidos en los últimos 90 días: ${n(d.unidades_90!)} (${clp.format(d.total_90!)})`, `salían al mes: ${n(d.al_mes!)}`);
    else campos.push(`vendidos en el último año: ${n(d.unidades_365!)}`);
    campos.push(d.dias_sin_vender != null && `última venta: ${hace(d.dias_sin_vender)}`);
    campos.push(d.dias_sin_comprar != null && `última compra: ${hace(d.dias_sin_comprar)}`);
    campos.push(a.tipo === "agotado_con_demanda" ? "qué hacer: reponerlo" : "qué hacer: decidir si se vuelve a traer o se saca del catálogo");
  }
  return campos.filter(Boolean).join(" | ");
}

export function textoDeReglas(avisos: Alerta[]): string {
  if (!avisos.length) return "Hoy no hay avisos de inventario: nada por agotarse ni agotado con ventas recientes.";
  return [
    `Lo más urgente: ${avisos[0].nombre}.`,
    ...avisos.map((a) => `- **${a.nombre}**: ${a.aviso} ${a.accion}`),
  ].join("\n");
}

const cifras = (texto: string) => new Set((texto.match(/\d+(?:[.,]\d+)*/g) ?? []).map((c) => c.replace(/\./g, "")));

/** El agente no puede traer cifras que no estén en los avisos calculados. Devuelve las que sobran. */
export function cifrasInventadas(textoAgente: string, hechos: string): string[] {
  const permitidas = cifras(hechos);
  return [...cifras(textoAgente)].filter((c) => !permitidas.has(c));
}

// Una redacción guardada por aviso: si mañana cambia un solo producto, solo ese se vuelve a redactar.
const cache = new Map<string, string | null>();

/** Pide al agente la frase de un aviso. Si falla, trae cifras ajenas o se alarga, devuelve null y se usa la regla. */
export async function redactar(a: Alerta): Promise<string | null> {
  if (a.datos.stock_bsale != null) return null; // stock estimado: el matiz ("puede que ya no quede") lo dice la regla
  const datos = datosParaAgente(a);
  const clave = createHash("sha1").update(datos + config.modeloAgente).digest("hex");
  if (cache.has(clave)) return cache.get(clave)!;
  const frase = (await conversar(sistemaPara(a), `AVISO: ${datos}`))
    .replace(/\s+/g, " ")
    .replace(/^[-•*"“\s]+|["”\s]+$/g, "")
    .replace(/\*\*/g, "");
  const palabras = frase.split(" ").length;
  // También se guarda el rechazo: así no se vuelve a pedir en cada carga del panel una frase que salió mal.
  const valida = palabras >= 5 && palabras <= 60 && !cifrasInventadas(frase, datos).length;
  cache.set(clave, valida ? frase : null);
  return valida ? frase : null;
}

export const rutaAlertas = Router();

rutaAlertas.get("/admin/alertas", async (_req, res) => {
  res.json(await calcularAlertas());
});

async function generarAvisos() {
  const { alertas } = await calcularAlertas();
  const avisos = elegirAvisos(alertas);
  const inicio = performance.now();
  let delAgente = 0;
  let motivo: string | undefined;
  const lineas: string[] = [];
  for (const a of avisos) {
    let frase: string | null = null;
    if (!motivo) {
      try {
        frase = await redactar(a);
      } catch (e: any) {
        motivo = e?.message ?? "El agente no respondió."; // sin agente no se sigue intentando con los demás
      }
    }
    if (frase) delAgente++;
    lineas.push(`- **${a.nombre}**: ${frase ?? `${a.aviso} ${a.accion}`}`);
  }
  return {
    texto: avisos.length ? [`Lo más urgente: ${avisos[0].nombre}.`, ...lineas].join("\n") : textoDeReglas(avisos),
    redactado_por: delAgente ? "agente" : "reglas",
    avisos: avisos.length,
    del_agente: delAgente,
    modelo: config.modeloAgente,
    latencia_ms: Math.round(performance.now() - inicio),
    motivo,
  };
}

// Si el panel pide los avisos dos veces a la vez, las dos esperan la misma redacción: el modelo corre una sola vez.
let enCurso: ReturnType<typeof generarAvisos> | null = null;

rutaAlertas.post("/admin/avisos", async (_req, res) => {
  enCurso ??= generarAvisos().finally(() => (enCurso = null));
  res.json(await enCurso);
});
