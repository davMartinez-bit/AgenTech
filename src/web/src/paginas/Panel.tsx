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
import { api, numero, pesos, pesosCortos, type Alerta, type Alertas, type AvisosAgente, type TipoAlerta } from "../api";
import { Encabezado } from "../componentes/Encabezado";

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
    api.resumen().then(setR).catch((e) => setError(e.message));
    api.alertas().then(setAlertas).catch((e) => setError(e.message));
    const alCambiar = () => setPestana(pestanaInicial());
    window.addEventListener("hashchange", alCambiar);
    return () => window.removeEventListener("hashchange", alCambiar);
  }, []);

  function ir(p: Pestana) {
    setPestana(p);
    window.history.replaceState(null, "", `#${p}`);
    window.scrollTo({ top: 0 });
  }

  return (
    <div className="min-h-screen">
      <Encabezado titulo="Panel del administrador" salir={salir}>
        {alertas && (
          <span className="hidden text-xs text-crema/60 md:inline">
            Ventas al {fecha(alertas.fechas.ventas_hasta)} · Stock al {fecha(alertas.fechas.stock_leido_el)}
          </span>
        )}
      </Encabezado>
      <nav className="border-b border-borde bg-white">
        <div className="mx-auto flex max-w-7xl gap-1 overflow-x-auto px-4">
          {PESTANAS.map(([id, nombre]) => (
            <button
              key={id}
              onClick={() => ir(id)}
              className={`border-b-2 px-4 py-3 text-sm font-bold ${pestana === id ? "border-rojo text-rojo" : "border-transparent text-gris hover:text-negro"}`}
            >
              {nombre}
              {id === "inventario" && alertas && alertas.por_agotarse_urgentes > 0 && (
                <span className="ml-2 rounded-full bg-rojo px-1.5 py-0.5 text-[10px] text-white">{alertas.por_agotarse_urgentes}</span>
              )}
            </button>
          ))}
        </div>
      </nav>
      <main className="mx-auto max-w-7xl space-y-6 px-4 py-6">
        {error && <p className="rounded-lg bg-rojo/10 px-4 py-3 text-rojo">{error}</p>}
        {pestana === "hoy" && <Hoy r={r} alertas={alertas} verInventario={() => ir("inventario")} />}
        {pestana === "ventas" && <Ventas />}
        {pestana === "inventario" && <Inventario alertas={alertas} />}
        {pestana === "buscador" && <Buscador r={r} />}
      </main>
    </div>
  );
}

// ---------------------------------------------------------------- Hoy

function Hoy({ r, alertas, verInventario }: { r: Record<string, any> | null; alertas: Alertas | null; verInventario: () => void }) {
  const variacion = r && r.ventas_30_dias_previos > 0 ? (r.ventas_30_dias / r.ventas_30_dias_previos - 1) * 100 : null;
  return (
    <>
      <section className="grid grid-cols-2 gap-3 lg:grid-cols-4">
        {r && (
          <Indicador titulo="Ventas últimos 30 días" valor={pesosCortos(r.ventas_30_dias)}
            nota={variacion == null ? `${numero(r.documentos_30_dias)} documentos` : `${variacion >= 0 ? "▲" : "▼"} ${Math.abs(Math.round(variacion))}% vs. 30 días previos`}
            tono={variacion == null ? undefined : variacion >= 0 ? "bien" : "mal"} />
        )}
        {alertas && (
          <>
            <Indicador titulo="Por agotarse" valor={numero(alertas.conteo.por_agotarse)}
              nota={`${numero(alertas.por_agotarse_urgentes)} alcanzan menos de 7 días`} tono={alertas.por_agotarse_urgentes ? "mal" : "bien"} />
            <Indicador titulo="Agotados que se vendían" valor={numero(alertas.conteo.agotado_con_demanda)}
              nota={`${pesosCortos(alertas.montos.agotado_con_demanda)} al mes en juego`} tono={alertas.conteo.agotado_con_demanda ? "mal" : "bien"} />
            <Indicador titulo="Plata parada en bodega" valor={pesosCortos(alertas.montos.stock_parado)}
              nota={`${numero(alertas.conteo.stock_parado)} productos sin moverse`} />
          </>
        )}
      </section>

      <div className="grid gap-6 lg:grid-cols-5">
        <div className="lg:col-span-3">
          <AvisosDelAgente alertas={alertas} verInventario={verInventario} />
        </div>
        <div className="lg:col-span-2">
          <Grafico id="ventas_por_dia" render={(d) => (
            <LineChart data={d}>
              <CartesianGrid stroke="#eee" vertical={false} />
              <XAxis dataKey="dia" tickFormatter={diaCorto} fontSize={11} />
              <YAxis tickFormatter={pesosCortos} fontSize={11} width={70} />
              <Tooltip formatter={(v: any) => pesos(v)} labelFormatter={(l: any) => fecha(l)} />
              <Line dataKey="total" name="Ventas" stroke={COLORES.rojo} strokeWidth={2} dot={false} />
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

  useEffect(() => {
    api.avisos().then(setAgente).catch(() => setFallo(true));
  }, []);

  const delAgente = agente?.redactado_por === "agente";
  const texto = agente?.texto ?? alertas?.resumen_reglas;
  const viejo = alertas ? alertas.fechas.dias_stock_viejo : 0;
  const total = alertas ? alertas.conteo.por_agotarse + alertas.conteo.agotado_con_demanda + alertas.conteo.agotado_olvidado + alertas.conteo.stock_parado : 0;

  return (
    <section className="flex h-full flex-col rounded-xl border border-borde bg-white p-5">
      <div className="flex items-start gap-3">
        <div>
          <h2 className="text-lg font-extrabold">Avisos de hoy</h2>
          <p className="text-xs text-gris">Lo que no se te puede pasar del inventario, en orden de urgencia.</p>
        </div>
        <button onClick={verInventario} className="ml-auto shrink-0 rounded-lg border border-borde px-3 py-1.5 text-xs font-bold hover:bg-crema/60">
          Ver los {numero(total)} avisos
        </button>
      </div>

      <div className="mt-4 flex-1 rounded-lg border-l-4 border-cobre bg-crema/60 px-4 py-3 text-sm">
        {texto ? <TextoAgente texto={texto} /> : <p className="text-gris">Revisando el inventario…</p>}
      </div>

      <div className="mt-3 space-y-1 text-xs text-gris">
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
    </section>
  );
}

// ---------------------------------------------------------------- Ventas

function Ventas() {
  return (
    <div className="grid gap-6 lg:grid-cols-2">
      <Grafico id="ventas_por_mes" render={(d) => (
        <BarChart data={d}>
          <CartesianGrid stroke="#eee" vertical={false} />
          <XAxis dataKey="mes" fontSize={11} />
          <YAxis tickFormatter={pesosCortos} fontSize={11} width={70} />
          <Tooltip formatter={(v: any) => pesos(v)} />
          <Bar dataKey="total" name="Ventas" fill={COLORES.cobre} radius={[4, 4, 0, 0]} />
        </BarChart>
      )} />
      <Grafico id="ventas_por_categoria" render={(d) => (
        <BarChart data={d} layout="vertical" margin={{ left: 20 }}>
          <XAxis type="number" tickFormatter={pesosCortos} fontSize={11} />
          <YAxis type="category" dataKey="categoria" width={95} fontSize={11} interval={0} />
          <Tooltip formatter={(v: any, n: any) => (n === "Ventas" ? pesos(v) : numero(v))} />
          <Bar dataKey="total" name="Ventas" fill={COLORES.rojo} radius={[0, 4, 4, 0]} />
        </BarChart>
      )} />
      <div className="lg:col-span-2">
        <Grafico id="productos_mas_vendidos" tabla={[
          ["nombre", "Producto"], ["unidades", "Unidades", numero], ["total", "Vendido", pesos], ["stock", "Stock en Bsale", numero],
        ]} />
      </div>
    </div>
  );
}

// ---------------------------------------------------------------- Inventario

const hace = (d: number | null) => (d == null ? "—" : d <= 0 ? "hoy" : d === 1 ? "ayer" : `hace ${numero(d)} días`);
const dias = (d: number | null) => (d == null ? "—" : d < 1 ? "menos de 1 día" : `${numero(d)} días`);

const LISTAS: { tipo: TipoAlerta; nombre: string; ayuda: string; columnas: Columna[] }[] = [
  {
    tipo: "por_agotarse",
    nombre: "Por agotarse",
    ayuda: "Se venden y el stock alcanza para menos de 14 días al ritmo de los últimos 30.",
    columnas: [["stock", "Quedan", numero], ["unidades_30", "Vendidos 30 días", numero], ["dias_alcanza", "Alcanza", dias], ["comprar", "Comprar", numero]],
  },
  {
    tipo: "agotado_con_demanda",
    nombre: "Agotados que se vendían",
    ayuda: "Tuvieron ventas en los últimos 90 días y están en 0, o lo vendido después de la última lectura de Bsale ya los habría agotado (esos dicen Revisa).",
    columnas: [["unidades_90", "Vendidos 90 días", numero], ["al_mes", "Salían al mes", numero], ["dias_sin_vender", "Última venta", hace], ["dias_sin_comprar", "Última compra", hace]],
  },
  {
    tipo: "agotado_olvidado",
    nombre: "En cero hace tiempo",
    ayuda: "Están en 0, no se venden hace más de 90 días y antes sí se vendían.",
    columnas: [["unidades_365", "Vendidos en el año", numero], ["dias_sin_vender", "Última venta", hace], ["dias_sin_comprar", "Última compra", hace]],
  },
  {
    tipo: "stock_parado",
    nombre: "Stock parado",
    ayuda: "Hay stock por $30.000 o más y no se vende hace 120 días o más.",
    columnas: [["stock", "En bodega", numero], ["valor", "Valor a precio de venta", pesos], ["dias_sin_vender", "Última venta", (d) => (d == null ? "sin ventas en el año" : hace(d))]],
  },
];

const URGENCIA = { 1: ["Hoy", "bg-rojo text-white"], 2: ["Esta semana", "bg-cobre text-negro"], 3: ["Cuando puedas", "bg-borde text-gris"] } as const;

function Inventario({ alertas }: { alertas: Alertas | null }) {
  const [tipo, setTipo] = useState<TipoAlerta>("por_agotarse");
  const lista = LISTAS.find((l) => l.tipo === tipo)!;
  const filas = alertas?.alertas.filter((a) => a.tipo === tipo) ?? [];
  const totalDelTipo = alertas?.conteo[tipo] ?? 0;

  return (
    <>
      <section className="rounded-xl border border-borde bg-white p-4">
        <div className="flex flex-wrap gap-2">
          {LISTAS.map((l) => (
            <button
              key={l.tipo}
              onClick={() => setTipo(l.tipo)}
              className={`rounded-full px-3 py-1.5 text-sm font-bold ${tipo === l.tipo ? "bg-negro text-cobre" : "border border-borde text-gris hover:text-negro"}`}
            >
              {l.nombre} <span className="font-normal opacity-70">{alertas ? numero(alertas.conteo[l.tipo]) : "…"}</span>
            </button>
          ))}
        </div>
        <p className="mt-3 text-xs text-gris">
          {lista.ayuda}
          {alertas && alertas.fechas.recepciones_hasta == null && " La última compra aparece cuando se cargan las recepciones de stock de Bsale."}
        </p>

        <div className="mt-3 overflow-x-auto">
          <table className="w-full text-sm">
            <thead className="text-left text-xs text-gris">
              <tr>
                <th className="py-1">Producto</th>
                {lista.columnas.map(([k, t]) => <th key={k} className="py-1 text-right">{t}</th>)}
                <th className="py-1 pl-4">Qué hacer</th>
              </tr>
            </thead>
            <tbody>
              {filas.map((a: Alerta) => (
                <tr key={a.sku ?? a.nombre} className="border-t border-borde align-top">
                  <td className="py-2 pr-2">
                    <div className="font-semibold">{a.nombre}</div>
                    <div className="mt-0.5 flex items-center gap-2 text-xs text-gris">
                      <span className={`rounded-full px-1.5 py-0.5 text-[10px] font-bold ${URGENCIA[a.urgencia][1]}`}>{URGENCIA[a.urgencia][0]}</span>
                      {a.categoria}
                    </div>
                  </td>
                  {lista.columnas.map(([k, , f]) => (
                    <td key={k} className="py-2 text-right tabular-nums">{f ? f(a.datos[k]) : a.datos[k]}</td>
                  ))}
                  <td className="py-2 pl-4 text-gris">{a.accion}</td>
                </tr>
              ))}
            </tbody>
          </table>
          {alertas && !filas.length && <p className="py-8 text-center text-sm text-gris">Nada en esta lista. Bien.</p>}
          {totalDelTipo > filas.length && (
            <p className="mt-2 text-xs text-gris">Se muestran los {filas.length} más importantes de {numero(totalDelTipo)}.</p>
          )}
        </div>
      </section>

      <Grafico id="stock_por_categoria" render={(d) => (
        <BarChart data={d} layout="vertical" margin={{ left: 20 }}>
          <XAxis type="number" fontSize={11} />
          <YAxis type="category" dataKey="categoria" width={95} fontSize={11} interval={0} />
          <Tooltip />
          <Legend />
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
        <section className="grid grid-cols-2 gap-3 lg:grid-cols-4">
          <Indicador titulo="Búsquedas 7 días" valor={numero(r.consultas_7_dias)} nota={`${numero(r.sin_resultados_7_dias)} sin resultado`} />
          <Indicador titulo="Buscador listo" valor={`${numero(r.vectorizados)}`} nota={r.pendientes_vector ? `${r.pendientes_vector} por vectorizar` : `vectores · p95 ${numero(r.latencia_p95_ms)} ms`}
            tono={r.pendientes_vector ? "mal" : "bien"} />
          <Indicador titulo="Productos con stock" valor={numero(r.con_stock)} nota={`${numero(r.sin_stock)} agotados`} />
          <Indicador titulo="Sin precio" valor={numero(r.sin_precio)} nota="productos activos" tono={r.sin_precio > 0 ? "mal" : "bien"} />
        </section>
      )}
      <div className="grid gap-6 lg:grid-cols-2">
        <Grafico id="busquedas_sin_resultados" tabla={[["busqueda", "Lo que pidieron"], ["veces", "Veces", numero], ["ultima_vez", "Última vez", fecha]]} />
        <Grafico id="busquedas_por_dia" render={(d) => (
          <LineChart data={d}>
            <CartesianGrid stroke="#eee" vertical={false} />
            <XAxis dataKey="dia" tickFormatter={diaCorto} fontSize={11} />
            <YAxis fontSize={11} allowDecimals={false} />
            <Tooltip labelFormatter={(l: any) => fecha(l)} />
            <Legend />
            <Line dataKey="consultas" name="Búsquedas" stroke={COLORES.negro} strokeWidth={2} />
            <Line dataKey="sin_resultados" name="Sin resultado" stroke={COLORES.rojo} strokeWidth={2} />
          </LineChart>
        )} />
      </div>
      <Actividad />
    </>
  );
}

// ---------------------------------------------------------------- piezas

function Indicador({ titulo, valor, nota, tono }: { titulo: string; valor: string; nota?: string; tono?: "bien" | "mal" }) {
  return (
    <div className="rounded-xl border border-borde bg-white p-4">
      <div className="text-xs font-semibold uppercase tracking-wide text-gris">{titulo}</div>
      <div className="mt-1 text-2xl font-extrabold">{valor}</div>
      {nota && <div className={`mt-0.5 text-xs ${tono === "bien" ? "text-verde" : tono === "mal" ? "text-rojo" : "text-gris"}`}>{nota}</div>}
    </div>
  );
}

type Columna = [string, string, ((v: any) => string)?];

function Grafico({ id, render, tabla }: { id: string; render?: (datos: any[]) => React.ReactElement; tabla?: Columna[] }) {
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
    <section className="flex h-full flex-col rounded-xl border border-borde bg-white p-4">
      <div className="flex items-start gap-3">
        <div>
          <h2 className="font-bold">{g?.titulo ?? "…"}</h2>
          <p className="text-xs text-gris">{g?.descripcion}</p>
        </div>
        <button
          onClick={interpretar}
          disabled={pensando || !g}
          className="ml-auto shrink-0 rounded-lg border border-borde px-2.5 py-1 text-xs text-gris hover:bg-crema/60 hover:text-negro disabled:opacity-50"
        >
          {pensando ? "Analizando…" : agente ? "Volver a explicar" : "Explícame"}
        </button>
      </div>

      <div className="mt-3 min-h-56 flex-1">
        {g && !g.datos.length && <p className="grid h-56 place-items-center text-sm text-gris">Todavía no hay datos para este gráfico.</p>}
        {g && g.datos.length > 0 && render && (
          <ResponsiveContainer width="100%" height={260}>
            {render(g.datos)}
          </ResponsiveContainer>
        )}
        {g && g.datos.length > 0 && tabla && (
          <div className="max-h-64 overflow-y-auto">
            <table className="w-full text-sm">
              <thead className="sticky top-0 bg-white text-left text-xs text-gris">
                <tr>{tabla.map(([k, t], i) => <th key={k} className={`py-1 ${i ? "text-right" : ""}`}>{t}</th>)}</tr>
              </thead>
              <tbody>
                {g.datos.map((fila, n) => (
                  <tr key={n} className="border-t border-borde">
                    {tabla.map(([k, , f], i) => (
                      <td key={k} className={`py-1.5 ${i ? "text-right tabular-nums" : "pr-2"}`}>{f ? f(fila[k]) : fila[k]}</td>
                    ))}
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        )}
      </div>

      {error && <p className="mt-3 rounded-lg bg-rojo/10 px-3 py-2 text-sm text-rojo">{error}</p>}
      {agente && (
        <div className="mt-3 rounded-lg border-l-4 border-cobre bg-crema/60 px-4 py-3 text-sm">
          <TextoAgente texto={agente.texto} />
          <div className="mt-2 text-xs text-gris">Agente {agente.modelo} · {(agente.latencia_ms / 1000).toFixed(1)} s · usa solo los datos del gráfico</div>
        </div>
      )}
    </section>
  );
}

// El modelo a veces responde con markdown: se muestran títulos, viñetas y negritas sin los símbolos.
function TextoAgente({ texto }: { texto: string }) {
  const lineas = texto.split("\n").map((l) => l.trim()).filter(Boolean);
  const negritas = (l: string) =>
    l.split(/\*\*(.+?)\*\*/g).map((parte, i) => (i % 2 ? <strong key={i}>{parte}</strong> : parte));
  return (
    <div className="space-y-1.5 leading-relaxed">
      {lineas.map((l, i) => {
        const vineta = /^[-•*]\s+/.test(l);
        const titulo = /^#+\s*/.test(l) || (i === 0 && !vineta);
        const limpia = l.replace(/^#+\s*/, "").replace(/^[-•*]\s+/, "");
        if (titulo) return <p key={i} className="font-bold">{negritas(limpia)}</p>;
        if (vineta) return <p key={i} className="pl-4 -indent-3">• {negritas(limpia)}</p>;
        return <p key={i}>{negritas(limpia)}</p>;
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
  return (
    <div className="grid gap-6 lg:grid-cols-2">
      <section className="rounded-xl border border-borde bg-white p-4">
        <h2 className="font-bold">Cargas del catálogo</h2>
        <p className="text-xs text-gris">Cada vez que Bsale u otro sistema envía productos a AgenTech.</p>
        <table className="mt-3 w-full text-sm">
          <thead className="text-left text-xs text-gris">
            <tr><th>Fecha</th><th>Origen</th><th className="text-right">Recibidos</th><th className="text-right">Aceptados</th><th className="text-right">Rechazados</th></tr>
          </thead>
          <tbody>
            {ingestas.map((i) => (
              <tr key={i.id} className="border-t border-borde" title={i.errores?.slice(0, 5).map((e: any) => `${e.sku}: ${e.motivo}`).join("\n")}>
                <td className="py-1.5">{fecha(i.creado_en, true)}</td>
                <td>{i.origen}</td>
                <td className="text-right">{numero(i.recibidos)}</td>
                <td className="text-right text-verde">{numero(i.aceptados)}</td>
                <td className={`text-right ${i.rechazados ? "font-bold text-rojo" : ""}`}>{numero(i.rechazados)}</td>
              </tr>
            ))}
          </tbody>
        </table>
      </section>
      <section className="rounded-xl border border-borde bg-white p-4">
        <h2 className="font-bold">Últimas búsquedas de los vendedores</h2>
        <p className="text-xs text-gris">Qué escribieron, qué les mostró primero el buscador y qué producto abrieron.</p>
        <div className="mt-3 max-h-72 overflow-y-auto">
          <table className="w-full text-sm">
            <thead className="sticky top-0 bg-white text-left text-xs text-gris">
              <tr><th>Búsqueda</th><th>Primer resultado</th><th>Abrió</th><th className="text-right">ms</th></tr>
            </thead>
            <tbody>
              {consultas.map((c) => (
                <tr key={c.id} className="border-t border-borde">
                  <td className="py-1.5 pr-2">{c.texto}</td>
                  <td className={`pr-2 ${c.primer_resultado ? "" : "text-rojo"}`}>{c.primer_resultado ?? "Sin resultado"}</td>
                  <td className="pr-2 text-gris">{c.producto_abierto ?? "—"}</td>
                  <td className="text-right tabular-nums text-gris">{c.latencia_ms}</td>
                </tr>
              ))}
            </tbody>
          </table>
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
