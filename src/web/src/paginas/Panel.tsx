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
import { api, numero, pesos, pesosCortos } from "../api";
import { Encabezado } from "../componentes/Encabezado";

// Panel administrativo: indicadores, gráficos con datos de Bsale y del buscador,
// y el agente que explica cada gráfico en lenguaje simple.

const COLORES = { rojo: "#9e1b2c", cobre: "#c8946a", negro: "#111111", gris: "#6b6b6b", verde: "#1fa855" };

export function Panel({ salir }: { salir: () => void }) {
  const [r, setR] = useState<Record<string, any> | null>(null);
  const [error, setError] = useState("");

  useEffect(() => {
    api.resumen().then(setR).catch((e) => setError(e.message));
  }, []);

  const variacion = r && r.ventas_30_dias_previos > 0 ? (r.ventas_30_dias / r.ventas_30_dias_previos - 1) * 100 : null;

  return (
    <div className="min-h-screen">
      <Encabezado titulo="Panel del administrador" salir={salir}>
        {r && <span className="hidden text-xs text-crema/60 md:inline">Ventas de Bsale al {fecha(r.ultima_sync_ventas)}</span>}
      </Encabezado>
      <main className="mx-auto max-w-7xl space-y-6 px-4 py-6">
        {error && <p className="rounded-lg bg-rojo/10 px-4 py-3 text-rojo">{error}</p>}
        {r && (
          <section className="grid grid-cols-2 gap-3 md:grid-cols-3 lg:grid-cols-6">
            <Indicador titulo="Ventas últimos 30 días" valor={pesosCortos(r.ventas_30_dias)}
              nota={variacion == null ? `${numero(r.documentos_30_dias)} documentos` : `${variacion >= 0 ? "▲" : "▼"} ${Math.abs(Math.round(variacion))}% vs. 30 días previos`}
              tono={variacion == null ? undefined : variacion >= 0 ? "bien" : "mal"} />
            <Indicador titulo="Valor del inventario" valor={pesosCortos(r.valor_inventario ?? 0)} nota="a precio de venta" />
            <Indicador titulo="Productos con stock" valor={numero(r.con_stock)} nota={`${numero(r.sin_stock)} agotados`} tono={r.sin_stock > r.con_stock ? "mal" : undefined} />
            <Indicador titulo="Sin precio" valor={numero(r.sin_precio)} nota="productos activos" tono={r.sin_precio > 0 ? "mal" : "bien"} />
            <Indicador titulo="Búsquedas 7 días" valor={numero(r.consultas_7_dias)} nota={`${numero(r.sin_resultados_7_dias)} sin resultado`} />
            <Indicador titulo="Buscador listo" valor={`${numero(r.vectorizados)}`} nota={r.pendientes_vector ? `${r.pendientes_vector} por vectorizar` : `vectores · p95 ${numero(r.latencia_p95_ms)} ms`}
              tono={r.pendientes_vector ? "mal" : "bien"} />
          </section>
        )}

        <div className="grid gap-6 lg:grid-cols-2">
          <Grafico id="ventas_por_dia" render={(d) => (
            <LineChart data={d}>
              <CartesianGrid stroke="#eee" vertical={false} />
              <XAxis dataKey="dia" tickFormatter={diaCorto} fontSize={11} />
              <YAxis tickFormatter={pesosCortos} fontSize={11} width={70} />
              <Tooltip formatter={(v: any) => pesos(v)} labelFormatter={(l: any) => fecha(l)} />
              <Line dataKey="total" name="Ventas" stroke={COLORES.rojo} strokeWidth={2} dot={false} />
            </LineChart>
          )} />
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
          <Grafico id="productos_mas_vendidos" tabla={[
            ["nombre", "Producto"], ["unidades", "Unidades", numero], ["total", "Vendido", pesos], ["stock", "Stock hoy", numero],
          ]} />
          <Grafico id="riesgo_quiebre" tabla={[
            ["nombre", "Producto"], ["venta_diaria", "Venta/día", numero], ["stock", "Stock", numero], ["dias_de_stock", "Días que alcanza", numero],
          ]} />
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
          <Grafico id="busquedas_sin_resultados" tabla={[["busqueda", "Lo que pidieron"], ["veces", "Veces", numero], ["ultima_vez", "Última vez", fecha]]} />
        </div>

        <Actividad />
      </main>
    </div>
  );
}

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
    <section className="flex flex-col rounded-xl border border-borde bg-white p-4">
      <div className="flex items-start gap-3">
        <div>
          <h2 className="font-bold">{g?.titulo ?? "…"}</h2>
          <p className="text-xs text-gris">{g?.descripcion}</p>
        </div>
        <button
          onClick={interpretar}
          disabled={pensando || !g}
          className="ml-auto shrink-0 rounded-lg bg-negro px-3 py-1.5 text-xs font-bold text-cobre hover:bg-carbon disabled:opacity-50"
        >
          {pensando ? "Analizando…" : agente ? "Volver a explicar" : "Explícame este gráfico"}
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
    <div className="space-y-1 leading-relaxed">
      {lineas.map((l, i) => {
        const titulo = /^#+\s*/.test(l) || i === 0;
        const vineta = /^[-•*]\s+/.test(l);
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
        <p className="text-xs text-gris">Qué escribieron y qué les mostró primero el buscador.</p>
        <div className="mt-3 max-h-72 overflow-y-auto">
          <table className="w-full text-sm">
            <thead className="sticky top-0 bg-white text-left text-xs text-gris">
              <tr><th>Búsqueda</th><th>Primer resultado</th><th className="text-right">ms</th></tr>
            </thead>
            <tbody>
              {consultas.map((c) => (
                <tr key={c.id} className="border-t border-borde">
                  <td className="py-1.5 pr-2">{c.texto}</td>
                  <td className={`pr-2 ${c.primer_resultado ? "" : "text-rojo"}`}>{c.primer_resultado ?? "Sin resultado"}</td>
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
