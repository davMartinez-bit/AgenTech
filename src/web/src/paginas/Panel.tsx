import { useEffect, useState } from "react";
import {
  Bar,
  BarChart,
  CartesianGrid,
  Legend,
  Line,
  LineChart,
  ResponsiveContainer,
  Tooltip,
  XAxis,
  YAxis,
} from "recharts";
import { api, cantidad, numero, pesos, pesosCortos, type Alerta, type Alertas, type AvisosAgente, type TipoAlerta } from "../api";
import { Encabezado } from "../componentes/Encabezado";
import { TablaAdaptable, type ColumnaTabla } from "../componentes/TablaAdaptable";
import { useParallax } from "../movimiento";

// Panel administrativo en cuatro pestañas: "Hoy" abre con los avisos del agente y pocas cifras;
// el detalle de ventas, inventario y buscador queda en su propia pestaña para no marear.

const COLORES = { rojo: "#9e1b2c", cobre: "#c8946a", negro: "#111111", gris: "#6b6b6b", verde: "#1fa855" };

const PESTANAS = [
  ["hoy", "Hoy"],
  ["ventas", "Ventas"],
  ["inventario", "Inventario"],
  ["buscador", "Buscador"],
] as const;
type Pestana = (typeof PESTANAS)[number][0];

function pestanaInicial(): Pestana {
  const h = window.location.hash.slice(1);
  return PESTANAS.some(([id]) => id === h) ? (h as Pestana) : "hoy";
}

export function Panel({ salir }: { salir: () => void }) {
  const [pestana, setPestana] = useState<Pestana>(pestanaInicial);
  const [r, setR] = useState<Record<string, any> | null>(null);
  const [alertas, setAlertas] = useState<Alertas | null>(null);
  const [error, setError] = useState("");

  useEffect(() => {
    document.documentElement.classList.add("panel");
    api.resumen().then(setR).catch((e) => setError(e.message));
    api.alertas().then(setAlertas).catch((e) => setError(e.message));
    const alCambiar = () => setPestana(pestanaInicial());
    window.addEventListener("hashchange", alCambiar);
    return () => {
      window.removeEventListener("hashchange", alCambiar);
      document.documentElement.classList.remove("panel");
    };
  }, []);

  function ir(p: Pestana) {
    setPestana(p);
    window.history.replaceState(null, "", `#${p}`);
    window.scrollTo({ top: 0 });
  }

  return (
    <div className="min-h-screen anim-aparecer">
      <Encabezado titulo="Panel del administrador" salir={salir}>
        {alertas && (
          <span className="hidden text-sm text-crema/60 md:inline">
            Ventas al {fecha(alertas.fechas.ventas_hasta)} · Stock al {fecha(alertas.fechas.stock_leido_el)}
          </span>
        )}
      </Encabezado>
      <nav className="border-b border-borde bg-white">
        <div className="mx-auto flex max-w-7xl gap-1 overflow-x-auto px-2 sm:px-4">
          {PESTANAS.map(([id, nombre]) => (
            <button
              key={id}
              onClick={() => ir(id)}
              className={`flex-1 whitespace-nowrap border-b-4 px-2 py-3 text-sm font-bold transition-colors duration-200 sm:flex-none sm:px-5 sm:text-base ${pestana === id ? "border-rojo text-rojo" : "border-transparent text-gris-oscuro hover:text-negro"}`}
            >
              {nombre}
              {id === "inventario" && alertas && alertas.por_agotarse_urgentes > 0 && (
                <span className="ml-2 rounded-full bg-rojo px-2 py-0.5 text-xs text-white">{alertas.por_agotarse_urgentes}</span>
              )}
            </button>
          ))}
        </div>
      </nav>
      <main className="mx-auto max-w-7xl space-y-5 px-3 py-5 sm:px-4 sm:py-6">
        {alertas && (
          <p className="text-sm text-gris-oscuro md:hidden">
            Ventas al {fecha(alertas.fechas.ventas_hasta)} · Stock al {fecha(alertas.fechas.stock_leido_el)}
          </p>
        )}
        {error && <p className="rounded-lg bg-rojo/10 px-4 py-3 text-rojo">{error}</p>}
        <div key={pestana} className="anim-subir-sutil space-y-5">
          {pestana === "hoy" && <Hoy r={r} alertas={alertas} verInventario={() => ir("inventario")} />}
          {pestana === "ventas" && <Ventas />}
          {pestana === "inventario" && <Inventario alertas={alertas} />}
          {pestana === "buscador" && <Buscador r={r} />}
        </div>
      </main>
    </div>
  );
}

// ---------------------------------------------------------------- Hoy

function Hoy({ r, alertas, verInventario }: { r: Record<string, any> | null; alertas: Alertas | null; verInventario: () => void }) {
  const variacion = r && r.ventas_30_dias_previos > 0 ? (r.ventas_30_dias / r.ventas_30_dias_previos - 1) * 100 : null;
  return (
    <>
      <section className="grid grid-cols-2 gap-3 sm:gap-4 lg:grid-cols-4">
        {r && (
          <Indicador titulo="Ventas últimos 30 días" valor={pesosCortos(r.ventas_30_dias)}
            nota={variacion == null ? `${numero(r.documentos_30_dias)} documentos` : `${variacion >= 0 ? "▲" : "▼"} ${Math.abs(Math.round(variacion))}% vs. 30 días previos`}
            tono={variacion == null ? undefined : variacion >= 0 ? "bien" : "mal"} orden={0} />
        )}
        {alertas && (
          <>
            <Indicador titulo="Por agotarse" valor={numero(alertas.conteo.por_agotarse)}
              nota={`${numero(alertas.por_agotarse_urgentes)} alcanzan menos de 7 días`} tono={alertas.por_agotarse_urgentes ? "mal" : "bien"} orden={1} />
            <Indicador titulo="Agotados que se vendían" valor={numero(alertas.conteo.agotado_con_demanda)}
              nota={`${pesosCortos(alertas.montos.agotado_con_demanda)} al mes en juego`} tono={alertas.conteo.agotado_con_demanda ? "mal" : "bien"} orden={2} />
            <Indicador titulo="Plata parada en bodega" valor={pesosCortos(alertas.montos.stock_parado)}
              nota={`${numero(alertas.conteo.stock_parado)} productos sin moverse`} orden={3} />
          </>
        )}
      </section>

      <div className="grid gap-5 xl:grid-cols-5">
        <div className="xl:col-span-3">
          <AvisosDelAgente alertas={alertas} verInventario={verInventario} />
        </div>
        <div className="xl:col-span-2 xl:self-start">
          <Grafico id="ventas_por_dia" render={(d, m) => (
            <LineChart data={d} margin={{ left: m.movil ? 0 : 12, right: 12 }}>
              <CartesianGrid stroke="#eee" vertical={false} />
              <XAxis dataKey="dia" tickFormatter={diaCorto} fontSize={m.letra} tick={{ fill: "#2a2a2a" }} minTickGap={m.movil ? 24 : 40} />
              <YAxis tickFormatter={pesosCortos} fontSize={m.letra} width={m.anchoPesos} tick={{ fill: "#2a2a2a" }} />
              <Tooltip formatter={(v: any) => pesos(v)} labelFormatter={(l: any) => fecha(l)} />
              <Line dataKey="total" name="Ventas" stroke={COLORES.rojo} strokeWidth={3} dot={false} />
            </LineChart>
          )} />
        </div>
      </div>
    </>
  );
}

// Los avisos se ven al instante con el texto de las reglas; cuando el agente termina de redactar, se reemplazan.
function AvisosDelAgente({ alertas, verInventario }: { alertas: Alertas | null; verInventario: () => void }) {
  const [agente, setAgente] = useState<AvisosAgente | null>(null);
  const [fallo, setFallo] = useState(false);
  const banda = useParallax<HTMLDivElement>({ origen: "centro" });

  useEffect(() => {
    api.avisos().then(setAgente).catch(() => setFallo(true));
  }, []);

  const delAgente = agente?.redactado_por === "agente";
  const texto = agente?.texto ?? alertas?.resumen_reglas;
  const viejo = alertas ? alertas.fechas.dias_stock_viejo : 0;
  const total = alertas ? alertas.conteo.por_agotarse + alertas.conteo.agotado_con_demanda + alertas.conteo.agotado_olvidado + alertas.conteo.stock_parado : 0;

  return (
    <section className="flex h-full flex-col overflow-hidden rounded-xl border border-borde bg-white">
      <div ref={banda} className="parallax flex flex-wrap items-center gap-x-3 gap-y-2 bg-negro px-4 py-4 text-white sm:px-6">
        <div aria-hidden className="capa capa-sutil" />
        <div>
          <h2 className="text-xl font-extrabold sm:text-2xl">Avisos y recomendaciones de hoy</h2>
          <p className="text-sm text-crema/75">Lo que no se te puede pasar del inventario, en orden de urgencia.</p>
        </div>
        <span className="ml-auto rounded-full bg-cobre px-3 py-1 text-sm font-bold text-negro transition-colors duration-300">
          {delAgente ? `Agente IA · ${agente.modelo}` : agente || fallo ? "Reglas del sistema" : "El agente está redactando…"}
        </span>
      </div>

      <div className="flex-1 px-4 py-4 sm:px-6 sm:py-5">
        {texto ? (
          <div key={delAgente ? "agente" : "reglas"} className="anim-aparecer">
            <TextoAgente texto={texto} grande />
          </div>
        ) : (
          <p className="text-lg text-gris-oscuro">Revisando el inventario…</p>
        )}
      </div>

      <div className="flex flex-wrap items-center gap-3 border-t border-borde bg-crema/40 px-4 py-3 sm:px-6">
        <div className="space-y-1 text-sm text-gris-oscuro">
          <p>
            {delAgente
              ? `Redactado por el agente ${agente.modelo} · las cifras las calcula el sistema`
              : agente || fallo
                ? "Texto de las reglas del sistema (el agente no respondió esta vez)."
                : "El agente está redactando los avisos…"}
          </p>
          {viejo > 1 && alertas && (
            <p className="text-rojo">
              El stock se leyó de Bsale el {fecha(alertas.fechas.stock_leido_el)} (hace {viejo} días). Los avisos ya descuentan lo vendido después.
            </p>
          )}
        </div>
        <button onClick={verInventario} className="ml-auto shrink-0 rounded-lg bg-rojo px-4 py-2 text-sm font-bold text-white transition duration-200 active:scale-95 hover:bg-rojo-oscuro">
          Ver los {numero(total)} avisos
        </button>
      </div>
    </section>
  );
}

// ---------------------------------------------------------------- Ventas

function Ventas() {
  return (
    <div className="grid gap-5 lg:grid-cols-2">
      <Grafico id="ventas_por_mes" render={(d, m) => (
        <BarChart data={d}>
          <CartesianGrid stroke="#eee" vertical={false} />
          <XAxis dataKey="mes" fontSize={m.letra} tick={{ fill: "#2a2a2a" }} />
          <YAxis tickFormatter={pesosCortos} fontSize={m.letra} width={m.anchoPesos} tick={{ fill: "#2a2a2a" }} />
          <Tooltip formatter={(v: any) => pesos(v)} />
          <Bar dataKey="total" name="Ventas" fill={COLORES.cobre} radius={[4, 4, 0, 0]} />
        </BarChart>
      )} />
      <Grafico id="ventas_por_categoria" render={(d, m) => (
        <BarChart data={d} layout="vertical" margin={{ left: m.movil ? 0 : 12, right: 12 }}>
          <XAxis type="number" tickFormatter={pesosCortos} fontSize={m.letra} tick={{ fill: "#2a2a2a" }} />
          <YAxis type="category" dataKey="categoria" width={m.anchoCategoria} fontSize={m.letra} interval={0} tick={{ fill: "#2a2a2a" }} />
          <Tooltip formatter={(v: any, n: any) => (n === "Ventas" ? pesos(v) : numero(v))} />
          <Bar dataKey="total" name="Ventas" fill={COLORES.rojo} radius={[0, 4, 4, 0]} />
        </BarChart>
      )} />
      <div className="lg:col-span-2">
        <Grafico id="productos_mas_vendidos" tabla={[
          ["nombre", "Producto"], ["unidades", "Cantidad", enCantidad], ["total", "Vendido", pesos], ["stock", "Stock en Bsale", enCantidad],
        ]} />
      </div>
    </div>
  );
}

// ---------------------------------------------------------------- Inventario

const hace = (d: number | null) => (d == null ? "—" : d <= 0 ? "hoy" : d === 1 ? "ayer" : `hace ${numero(d)} días`);
const dias = (d: number | null) => (d == null ? "—" : d < 1 ? "menos de 1 día" : `${numero(d)} días`);
// Cantidades de producto con su unidad de venta (metro, kilo, litro); la fila o el aviso trae el campo `unidad`.
const enCantidad = (v: number | null, fila: { unidad?: string }) => cantidad(v, fila.unidad);

const LISTAS: { tipo: TipoAlerta; nombre: string; ayuda: string; columnas: Columna[] }[] = [
  {
    tipo: "por_agotarse",
    nombre: "Por agotarse",
    ayuda: "Se venden y el stock alcanza para menos de 14 días al ritmo de los últimos 30.",
    columnas: [["stock", "Quedan", enCantidad], ["unidades_30", "Vendidos 30 días", enCantidad], ["dias_alcanza", "Alcanza", dias], ["comprar", "Comprar", enCantidad]],
  },
  {
    tipo: "agotado_con_demanda",
    nombre: "Agotados que se vendían",
    ayuda: "Tuvieron ventas en los últimos 90 días y están en 0, o lo vendido después de la última lectura de Bsale ya los habría agotado (esos dicen Revisa).",
    columnas: [["unidades_90", "Vendidos 90 días", enCantidad], ["al_mes", "Salían al mes", enCantidad], ["dias_sin_vender", "Última venta", hace], ["dias_sin_comprar", "Última compra", hace]],
  },
  {
    tipo: "agotado_olvidado",
    nombre: "En cero hace tiempo",
    ayuda: "Están en 0, no se venden hace más de 90 días y antes sí se vendían.",
    columnas: [["unidades_365", "Vendidos en el año", enCantidad], ["dias_sin_vender", "Última venta", hace], ["dias_sin_comprar", "Última compra", hace]],
  },
  {
    tipo: "stock_parado",
    nombre: "Stock parado",
    ayuda: "Hay stock por $30.000 o más y no se vende hace 120 días o más.",
    columnas: [["stock", "En bodega", enCantidad], ["valor", "Valor a precio de venta", pesos], ["dias_sin_vender", "Última venta", (d) => (d == null ? "sin ventas en el año" : hace(d))]],
  },
];

const URGENCIA = { 1: ["Hoy", "bg-rojo text-white"], 2: ["Esta semana", "bg-cobre text-negro"], 3: ["Cuando puedas", "bg-borde text-gris"] } as const;

function Inventario({ alertas }: { alertas: Alertas | null }) {
  const [tipo, setTipo] = useState<TipoAlerta>("por_agotarse");
  const lista = LISTAS.find((l) => l.tipo === tipo)!;
  const filas = alertas?.alertas.filter((a) => a.tipo === tipo) ?? [];
  const totalDelTipo = alertas?.conteo[tipo] ?? 0;

  const columnasInventario: ColumnaTabla<any>[] = [
    {
      clave: "producto",
      titulo: "Producto",
      valor: (a: Alerta) => (
        <>
          <div className="font-semibold">{a.nombre}</div>
          <div className="mt-0.5 flex flex-wrap items-center gap-2 text-sm font-normal text-gris-oscuro">
            <span className={`rounded-full px-2 py-0.5 text-xs font-bold ${URGENCIA[a.urgencia][1]}`}>{URGENCIA[a.urgencia][0]}</span>
            {a.categoria}
          </div>
        </>
      ),
    },
    ...aColumnas(lista.columnas, (a, k) => a.datos[k]).map((c) => ({ ...c, derecha: true })),
    { clave: "accion", titulo: "Qué hacer", destacada: true, valor: (a: Alerta) => a.accion },
  ];

  return (
    <>
      <section className="rounded-xl border border-borde bg-white p-4 sm:p-5">
        <div className="flex flex-wrap gap-2">
          {LISTAS.map((l) => (
            <button
              key={l.tipo}
              onClick={() => setTipo(l.tipo)}
              className={`rounded-full px-3.5 py-2 text-sm font-bold transition-colors duration-200 active:scale-95 sm:text-base ${tipo === l.tipo ? "bg-negro text-cobre" : "border border-borde text-gris hover:text-negro"}`}
            >
              {l.nombre} <span className="font-normal opacity-70">{alertas ? numero(alertas.conteo[l.tipo]) : "…"}</span>
            </button>
          ))}
        </div>
        <p className="mt-3 text-sm text-gris-oscuro">
          {lista.ayuda}
          {alertas && alertas.fechas.recepciones_hasta == null && " La última compra aparece cuando se cargan las recepciones de stock de Bsale."}
        </p>

        <div key={tipo} className="anim-aparecer mt-3">
          <TablaAdaptable columnas={columnasInventario} filas={filas} clave={(a: Alerta) => a.sku ?? a.nombre} />
          {alertas && !filas.length && <p className="py-8 text-center text-base text-gris-oscuro">Nada en esta lista. Bien.</p>}
          {totalDelTipo > filas.length && (
            <p className="mt-2 text-sm text-gris-oscuro">Se muestran los {filas.length} más importantes de {numero(totalDelTipo)}.</p>
          )}
        </div>
      </section>

      <Grafico id="stock_por_categoria" render={(d, m) => (
        <BarChart data={d} layout="vertical" margin={{ left: m.movil ? 0 : 12, right: 12 }}>
          <XAxis type="number" fontSize={m.letra} tick={{ fill: "#2a2a2a" }} />
          <YAxis type="category" dataKey="categoria" width={m.anchoCategoria} fontSize={m.letra} interval={0} tick={{ fill: "#2a2a2a" }} />
          <Tooltip />
          <Legend wrapperStyle={{ fontSize: m.letra + 1 }} />
          <Bar dataKey="con_stock" name="Con stock" stackId="s" fill={COLORES.verde} />
          <Bar dataKey="sin_stock" name="Agotados" stackId="s" fill={COLORES.gris} radius={[0, 4, 4, 0]} />
        </BarChart>
      )} />
    </>
  );
}

// ---------------------------------------------------------------- Buscador

function Buscador({ r }: { r: Record<string, any> | null }) {
  return (
    <>
      {r && (
        <section className="grid grid-cols-2 gap-3 sm:gap-4 lg:grid-cols-4">
          <Indicador titulo="Búsquedas 7 días" valor={numero(r.consultas_7_dias)} nota={`${numero(r.sin_resultados_7_dias)} sin resultado`} orden={0} />
          <Indicador titulo="Buscador listo" valor={`${numero(r.vectorizados)}`} nota={r.pendientes_vector ? `${r.pendientes_vector} por vectorizar` : `vectores · p95 ${numero(r.latencia_p95_ms)} ms`}
            tono={r.pendientes_vector ? "mal" : "bien"} orden={1} />
          <Indicador titulo="Productos con stock" valor={numero(r.con_stock)} nota={`${numero(r.sin_stock)} agotados`} orden={2} />
          <Indicador titulo="Sin precio" valor={numero(r.sin_precio)} nota="productos activos" tono={r.sin_precio > 0 ? "mal" : "bien"} orden={3} />
        </section>
      )}
      <div className="grid gap-5 lg:grid-cols-2">
        <Grafico id="busquedas_sin_resultados" tabla={[["busqueda", "Lo que pidieron"], ["veces", "Veces", numero], ["ultima_vez", "Última vez", (v) => fecha(v)]]} />
        <Grafico id="busquedas_por_dia" render={(d, m) => (
          <LineChart data={d} margin={{ left: m.movil ? 0 : 12, right: 12 }}>
            <CartesianGrid stroke="#eee" vertical={false} />
            <XAxis dataKey="dia" tickFormatter={diaCorto} fontSize={m.letra} tick={{ fill: "#2a2a2a" }} minTickGap={m.movil ? 24 : 40} />
            <YAxis fontSize={m.letra} allowDecimals={false} tick={{ fill: "#2a2a2a" }} />
            <Tooltip labelFormatter={(l: any) => fecha(l)} />
            <Legend wrapperStyle={{ fontSize: m.letra + 1 }} />
            <Line dataKey="consultas" name="Búsquedas" stroke={COLORES.negro} strokeWidth={3} />
            <Line dataKey="sin_resultados" name="Sin resultado" stroke={COLORES.rojo} strokeWidth={3} />
          </LineChart>
        )} />
      </div>
      <Actividad />
    </>
  );
}

// ---------------------------------------------------------------- piezas

function Indicador({ titulo, valor, nota, tono, orden }: { titulo: string; valor: string; nota?: string; tono?: "bien" | "mal"; orden?: number }) {
  const borde = tono === "bien" ? "border-t-verde" : tono === "mal" ? "border-t-rojo" : "border-t-cobre";
  return (
    <div
      className={`anim-subir-sutil transition-shadow duration-200 hover:shadow-md rounded-xl border border-t-4 border-borde bg-white p-3 sm:p-5 ${borde}`}
      style={{ "--i": orden ?? 0 } as React.CSSProperties}
    >
      <div className="text-xs font-bold uppercase tracking-wide text-gris-oscuro sm:text-sm">{titulo}</div>
      <div className="mt-1 text-3xl font-extrabold tabular-nums sm:text-4xl xl:text-5xl">{valor}</div>
      {nota && <div className={`mt-1 text-sm font-semibold ${tono === "bien" ? "text-verde-oscuro" : tono === "mal" ? "text-rojo" : "text-gris-oscuro"}`}>{nota}</div>}
    </div>
  );
}

type Columna = [string, string, ((v: any, fila: any) => string)?];

// Los ejes de recharts van en píxeles: se agrandan en pantallas anchas (sala) y se achican en móvil.
type Medidas = { movil: boolean; letra: number; alto: number; anchoPesos: number; anchoCategoria: number };
function useMedidas(): Medidas {
  const consulta = "(max-width: 639px)";
  const [movil, setMovil] = useState(() => window.matchMedia(consulta).matches);
  useEffect(() => {
    const mq = window.matchMedia(consulta);
    const alCambiar = () => setMovil(mq.matches);
    mq.addEventListener("change", alCambiar);
    return () => mq.removeEventListener("change", alCambiar);
  }, []);
  return movil
    ? { movil, letra: 11, alto: 250, anchoPesos: 50, anchoCategoria: 86 }
    : { movil, letra: 14, alto: 340, anchoPesos: 82, anchoCategoria: 150 };
}

// Convierte las columnas de una tabla de gráfico en columnas para TablaAdaptable (la primera a la izquierda, el resto a la derecha).
const aColumnas = (cols: Columna[], leer: (fila: any, k: string) => any = (f, k) => f[k]): ColumnaTabla<any>[] =>
  cols.map(([k, t, f], i) => ({ clave: k, titulo: t, derecha: i > 0, valor: (fila) => (f ? f(leer(fila, k), fila) : leer(fila, k)) }));

function Grafico({ id, render, tabla }: { id: string; render?: (datos: any[], m: Medidas) => React.ReactElement; tabla?: Columna[] }) {
  const m = useMedidas();
  const [g, setG] = useState<{ titulo: string; descripcion: string; datos: any[] } | null>(null);
  const [agente, setAgente] = useState<{ texto: string; modelo: string; latencia_ms: number } | null>(null);
  const [pensando, setPensando] = useState(false);
  const [error, setError] = useState("");

  useEffect(() => {
    api.grafico(id).then(setG).catch((e) => setError(e.message));
  }, [id]);

  async function interpretar() {
    setPensando(true);
    setError("");
    try {
      setAgente(await api.interpretar(id));
    } catch (e: any) {
      setError(e.message);
    } finally {
      setPensando(false);
    }
  }

  return (
    <section className="flex h-full flex-col rounded-xl border border-borde bg-white p-4 transition-shadow duration-200 hover:shadow-md sm:p-5">
      <div className="flex items-start gap-3">
        <div className="min-w-0 flex-1">
          <h2 className="text-lg font-extrabold sm:text-xl">{g?.titulo ?? "…"}</h2>
          <p className="text-sm text-gris-oscuro">{g?.descripcion}</p>
        </div>
        <button
          onClick={interpretar}
          disabled={pensando || !g}
          className="ml-auto shrink-0 rounded-lg bg-negro px-3.5 py-2 text-sm font-bold text-cobre transition duration-200 active:scale-95 hover:bg-carbon disabled:opacity-50"
        >
          {pensando ? "Analizando…" : agente ? "Volver a explicar" : "Explícame"}
        </button>
      </div>

      {/* Sin flex-1: la lectura del agente queda pegada bajo el gráfico; el espacio que sobre va al final de la tarjeta. */}
      <div className="mt-3">
        {!g && <div aria-hidden className="esqueleto h-56 rounded-lg" />}
        {g && !g.datos.length && <p className="grid h-56 place-items-center text-base text-gris-oscuro">Todavía no hay datos para este gráfico.</p>}
        {g && g.datos.length > 0 && render && (
          <ResponsiveContainer width="100%" height={m.alto}>
            {render(g.datos, m)}
          </ResponsiveContainer>
        )}
        {g && g.datos.length > 0 && tabla && (
          <TablaAdaptable columnas={aColumnas(tabla)} filas={g.datos} clave={(_, n) => n} altoMaximo />
        )}
      </div>

      {error && <p className="mt-3 rounded-lg bg-rojo/10 px-3 py-2 text-base text-rojo">{error}</p>}
      {agente && (
        <div className="anim-subir-sutil mt-4 rounded-lg border-l-4 border-cobre bg-crema/60 px-4 py-3">
          <div className="mb-1 text-xs font-bold uppercase tracking-wide text-rojo">Lectura del agente</div>
          <div className="text-base sm:text-lg">
            <TextoAgente texto={agente.texto} />
          </div>
          <div className="mt-2 text-sm text-gris-oscuro">Agente {agente.modelo} · {(agente.latencia_ms / 1000).toFixed(1)} s · usa solo los datos del gráfico</div>
        </div>
      )}
    </section>
  );
}

// El modelo a veces responde con markdown: se muestran títulos, viñetas y negritas sin los símbolos.
// Con `grande` (bloque protagonista del agente) las viñetas van numeradas y el texto es más grande.
function TextoAgente({ texto, grande }: { texto: string; grande?: boolean }) {
  const lineas = texto.split("\n").map((l) => l.trim()).filter(Boolean);
  const negritas = (l: string) =>
    l.split(/\*\*(.+?)\*\*/g).map((parte, i) => (i % 2 ? <strong key={i}>{parte}</strong> : parte));
  let n = 0;
  return (
    <div className={grande ? "" : "space-y-1.5 text-base leading-relaxed"}>
      {lineas.map((l, i) => {
        const vineta = /^[-•*]\s+/.test(l);
        const titulo = /^#+\s*/.test(l) || (i === 0 && !vineta);
        const limpia = l.replace(/^#+\s*/, "").replace(/^[-•*]\s+/, "");
        if (titulo) {
          return grande
            ? <p key={i} className="pb-3 text-xl font-extrabold leading-snug sm:text-2xl">{negritas(limpia)}</p>
            : <p key={i} className="font-bold">{negritas(limpia)}</p>;
        }
        if (vineta && grande) {
          n += 1;
          return (
            <div key={i} className="anim-subir-sutil flex gap-3 border-t border-borde py-3 text-base leading-snug sm:text-lg" style={{ "--i": Math.min(n, 8) } as React.CSSProperties}>
              <span className="mt-0.5 grid h-7 w-7 shrink-0 place-items-center rounded-full bg-negro text-sm font-bold text-cobre">{n}</span>
              <p>{negritas(limpia)}</p>
            </div>
          );
        }
        if (vineta) return <p key={i} className="pl-4 -indent-3">• {negritas(limpia)}</p>;
        return grande ? <p key={i} className="py-2 text-base sm:text-lg">{negritas(limpia)}</p> : <p key={i}>{negritas(limpia)}</p>;
      })}
    </div>
  );
}

function Actividad() {
  const [ingestas, setIngestas] = useState<any[]>([]);
  const [consultas, setConsultas] = useState<any[]>([]);
  useEffect(() => {
    api.ingestas().then(setIngestas).catch(() => {});
    api.consultas().then(setConsultas).catch(() => {});
  }, []);

  const columnasCargas: ColumnaTabla<any>[] = [
    { clave: "fecha", titulo: "Fecha", valor: (i) => fecha(i.creado_en, true) },
    { clave: "origen", titulo: "Origen", valor: (i) => i.origen },
    { clave: "recibidos", titulo: "Recibidos", derecha: true, valor: (i) => numero(i.recibidos) },
    { clave: "aceptados", titulo: "Aceptados", derecha: true, valor: (i) => <span className="text-verde-oscuro">{numero(i.aceptados)}</span> },
    { clave: "rechazados", titulo: "Rechazados", derecha: true, valor: (i) => <span className={i.rechazados ? "font-bold text-rojo" : ""}>{numero(i.rechazados)}</span> },
  ];

  const columnasConsultas: ColumnaTabla<any>[] = [
    { clave: "texto", titulo: "Búsqueda", valor: (c) => c.texto },
    { clave: "primer", titulo: "Primer resultado", valor: (c) => <span className={c.primer_resultado ? "" : "text-rojo"}>{c.primer_resultado ?? "Sin resultado"}</span> },
    { clave: "abrio", titulo: "Abrió", valor: (c) => <span className="text-gris-oscuro">{c.producto_abierto ?? "—"}</span> },
    { clave: "ms", titulo: "ms", derecha: true, valor: (c) => <span className="text-gris-oscuro">{c.latencia_ms}</span> },
  ];

  return (
    <div className="grid gap-5 lg:grid-cols-2">
      <section className="rounded-xl border border-borde bg-white p-4 transition-shadow duration-200 hover:shadow-md sm:p-5">
        <h2 className="text-lg font-extrabold sm:text-xl">Cargas del catálogo</h2>
        <p className="text-sm text-gris-oscuro">Cada vez que Bsale u otro sistema envía productos a AgenTech.</p>
        <div className="mt-3">
          <TablaAdaptable
            columnas={columnasCargas}
            filas={ingestas}
            clave={(i) => i.id}
            ayudaFila={(i) => i.errores?.slice(0, 5).map((e: any) => `${e.sku}: ${e.motivo}`).join("\n")}
          />
        </div>
      </section>
      <section className="rounded-xl border border-borde bg-white p-4 transition-shadow duration-200 hover:shadow-md sm:p-5">
        <h2 className="text-lg font-extrabold sm:text-xl">Últimas búsquedas de los vendedores</h2>
        <p className="text-sm text-gris-oscuro">Qué escribieron, qué les mostró primero el buscador y qué producto abrieron.</p>
        <div className="mt-3">
          <TablaAdaptable columnas={columnasConsultas} filas={consultas} clave={(c) => c.id} altoMaximo />
        </div>
      </section>
    </div>
  );
}

function fecha(v: any, conHora = false) {
  if (!v) return "—";
  const d = typeof v === "string" && v.length === 10 ? new Date(`${v}T12:00:00`) : new Date(v);
  return d.toLocaleDateString("es-CL", { day: "2-digit", month: "short", ...(conHora ? { hour: "2-digit", minute: "2-digit" } : { year: "numeric" }) });
}

function diaCorto(v: string) {
  return new Date(`${String(v).slice(0, 10)}T12:00:00`).toLocaleDateString("es-CL", { day: "2-digit", month: "2-digit" });
}
