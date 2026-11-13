import { useEffect, useRef, useState } from "react";
import { api, cantidad, pedirRespuesta, pesos, type Complemento, type Producto, type ResultadoConsulta } from "../api";

// Asistente del vendedor (historia 6). Aquí va lo que dijo el cliente con sus palabras, o lo que el vendedor
// no conoce; las palabras simples van al buscador. Cada mensaje se busca con /consulta (origen "asistente",
// que suma las frases de cliente) y se responde con la tabla de resultados (SKU, nombre, precio, stock,
// relevancia). Después llega el consejo redactado por el modelo de lenguaje, que solo puede nombrar
// productos de esa tabla: precio y stock siempre salen de la base de datos.

type Mensaje =
  | { de: "vendedor"; texto: string }
  | {
      de: "asistente";
      texto: string;
      resultado?: ResultadoConsulta;
      complementos?: Complemento[];
      // undefined: no se pidió consejo. null: se está redactando. Texto: listo.
      consejo?: string | null;
      recomendados?: string[];
    };

const SUGERENCIAS = ["algo para tapar goteras", "tela resistente para tapizar un sillón", "tarugos para concreto", "pintura para reja que no se oxide"];

export function Chatbot({
  abierto,
  cerrar,
  abrir,
  pregunta,
  alRecibir,
}: {
  abierto: boolean;
  cerrar: () => void;
  abrir: (p: Producto) => void;
  // Pregunta que llega desde el buscador ("Preguntar al asistente"). Se envía sola y se avisa con alRecibir.
  pregunta?: string | null;
  alRecibir?: () => void;
}) {
  const [mensajes, setMensajes] = useState<Mensaje[]>([
    { de: "asistente", texto: "Hola. Escríbeme lo que pide el cliente, tal como lo dice, y te digo qué ofrecerle de lo que tenemos con stock." },
  ]);
  const [texto, setTexto] = useState("");
  const [pensando, setPensando] = useState(false);
  const fin = useRef<HTMLDivElement>(null);

  useEffect(() => {
    fin.current?.scrollIntoView({ behavior: "smooth" });
  }, [mensajes, pensando]);

  useEffect(() => {
    if (!abierto || !pregunta || pensando) return;
    alRecibir?.();
    enviar(pregunta);
  }, [abierto, pregunta, pensando]);

  async function enviar(t: string) {
    const consulta = t.trim();
    if (!consulta || pensando) return;
    setTexto("");
    setMensajes((m) => [...m, { de: "vendedor", texto: consulta }]);
    setPensando(true);
    try {
      const r = await api.consulta(consulta, 6, "asistente");
      const aviso = r.agotado_parecido ? `“${r.agotado_parecido.nombre}” está agotado. ` : "";
      const respuesta = r.resultados.length
        ? `${aviso}${aviso ? "Puedes ofrecer" : "Encontré"} ${r.resultados.length} ${r.resultados.length === 1 ? "producto" : "productos"} con stock${
            r.interpretacion?.length ? ` (busqué: ${r.interpretacion.join(", ")})` : ""
          }:`
        : `${aviso}No tengo productos con stock que se parezcan a eso. Pregúntale al cliente para qué lo necesita o prueba con otras palabras.`;
      // Venta cruzada: lo que otros clientes llevaron junto con el primer resultado.
      const complementos = r.resultados.length ? await api.complementos(r.resultados[0].sku, 3).catch(() => []) : [];
      const conResultados = r.resultados.length > 0;
      setMensajes((m) => [...m, { de: "asistente", texto: respuesta, resultado: r, complementos, consejo: conResultados ? null : undefined }]);
      // El consejo llega después: la tabla ya se ve y esto no la demora. Si falla, se queda solo la tabla.
      if (conResultados) {
        const poner = (consejo: string | undefined, recomendados: string[]) =>
          setMensajes((m) =>
            m.map((x) => (x.de === "asistente" && x.resultado?.consulta_id === r.consulta_id ? { ...x, consejo, recomendados } : x)),
          );
        pedirRespuesta(r.consulta_id)
          .then((a) => poner(a.respuesta, a.recomendados.map((p) => p.sku)))
          .catch(() => poner(undefined, []));
      }
    } catch (e: any) {
      setMensajes((m) => [...m, { de: "asistente", texto: `No pude buscar: ${e.message}` }]);
    } finally {
      setPensando(false);
    }
  }

  return (
    <aside
      className={`fixed inset-y-0 right-0 z-30 flex w-full max-w-lg flex-col bg-white shadow-2xl transition-transform duration-300 ${
        abierto ? "translate-x-0" : "translate-x-full"
      }`}
    >
      <div className="flex items-center gap-3 bg-negro px-4 py-3 text-white">
        <div className="grid h-9 w-9 place-items-center rounded-full bg-cobre font-black text-negro">A</div>
        <div>
          <div className="font-bold">Asistente del vendedor</div>
          <div className="text-xs text-crema/70">Cuéntale lo que pide el cliente · solo productos con stock</div>
        </div>
        <button onClick={cerrar} className="ml-auto rounded px-2 py-1 text-crema/80 hover:bg-white/10" aria-label="Cerrar">
          ✕
        </button>
      </div>

      <div className="flex-1 space-y-3 overflow-y-auto bg-fondo p-4">
        {mensajes.map((m, i) =>
          m.de === "vendedor" ? (
            <div key={i} className="ml-auto max-w-[80%] rounded-2xl rounded-br-sm bg-negro px-4 py-2 text-white">
              {m.texto}
            </div>
          ) : (
            <div key={i} className="max-w-[95%] rounded-2xl rounded-bl-sm bg-white px-4 py-3 shadow-sm">
              <p>{m.texto}</p>
              {m.consejo !== undefined && (
                <p aria-live="polite" className="mt-2 rounded-lg border-l-4 border-cobre bg-crema/60 px-3 py-2 text-sm leading-relaxed">
                  {m.consejo ?? "Pensando qué conviene ofrecer…"}
                </p>
              )}
              {m.resultado && m.resultado.resultados.length > 0 && (
                <table className="mt-2 w-full text-left text-sm">
                  <thead className="text-xs text-gris">
                    <tr>
                      <th className="py-1">Producto</th>
                      <th className="py-1 text-right">Precio</th>
                      <th className="py-1 text-right">Stock</th>
                      <th className="py-1 text-right">Rel.</th>
                    </tr>
                  </thead>
                  <tbody>
                    {m.resultado.resultados.map((p) => (
                      <tr
                        key={p.sku}
                        onClick={() => (api.clic(m.resultado!.consulta_id, p.sku, "asistente"), abrir(p))}
                        className="cursor-pointer border-t border-borde hover:bg-crema/50"
                      >
                        <td className="py-1.5 pr-2">
                          <div className="font-medium leading-tight">
                            {m.recomendados?.includes(p.sku) && (
                              <span className="mr-1.5 rounded bg-cobre px-1.5 py-0.5 align-middle text-[10px] font-bold uppercase text-negro">Sugerido</span>
                            )}
                            {p.nombre}
                          </div>
                          <div className="text-xs text-gris">SKU {p.sku}</div>
                        </td>
                        <td className="py-1.5 text-right font-semibold text-rojo">{pesos(p.precio)}</td>
                        <td className="py-1.5 text-right">{cantidad(p.stock, p.unidad)}</td>
                        <td className="py-1.5 text-right text-gris">{Math.round(p.score * 100)}%</td>
                      </tr>
                    ))}
                  </tbody>
                </table>
              )}
              {m.complementos && m.complementos.length > 0 && m.resultado && (
                <div className="mt-3 rounded-lg bg-crema/70 px-3 py-2 text-sm">
                  <div className="font-semibold">Quienes llevan “{m.resultado.resultados[0].nombre}” también llevan:</div>
                  <div className="mt-1 flex flex-wrap gap-1.5">
                    {m.complementos.map((c) => (
                      <button key={c.sku} onClick={() => abrir(c)} className="rounded-full bg-white px-2.5 py-1 text-xs hover:ring-1 hover:ring-cobre">
                        {c.nombre} · <span className="font-semibold text-rojo">{pesos(c.precio)}</span>
                      </button>
                    ))}
                  </div>
                </div>
              )}
            </div>
          ),
        )}
        {pensando && <div className="w-24 rounded-2xl bg-white px-4 py-2 text-gris shadow-sm">Buscando…</div>}
        <div ref={fin} />
      </div>

      {mensajes.length < 2 && (
        <div className="flex flex-wrap gap-2 border-t border-borde px-4 py-2">
          {SUGERENCIAS.map((s) => (
            <button key={s} onClick={() => enviar(s)} className="rounded-full bg-crema px-3 py-1 text-xs hover:brightness-95">
              {s}
            </button>
          ))}
        </div>
      )}
      <form onSubmit={(e) => (e.preventDefault(), enviar(texto))} className="flex gap-2 border-t border-borde p-3">
        <input
          value={texto}
          onChange={(e) => setTexto(e.target.value)}
          placeholder="Lo que pide el cliente…"
          className="flex-1 rounded-xl border border-borde px-4 py-3 outline-none focus:border-cobre"
        />
        <button disabled={pensando} className="rounded-xl bg-rojo px-5 font-bold text-white disabled:opacity-50">
          Enviar
        </button>
      </form>
    </aside>
  );
}
