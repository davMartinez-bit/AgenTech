import { useEffect, useState } from "react";
import { api, numero, pesos, type Alternativa, type Complemento, type Producto } from "../api";

// Ficha del producto para el vendedor: datos, "Lleva también" (venta cruzada con las ventas reales)
// y alternativas con stock (lo más parecido por significado), clave cuando el producto está agotado.

export function Ficha({ producto, cerrar, abrir }: { producto: Producto; cerrar: () => void; abrir: (p: Producto) => void }) {
  const [complementos, setComplementos] = useState<Complemento[] | null>(null);
  const [alternativas, setAlternativas] = useState<Alternativa[] | null>(null);
  const agotado = producto.stock <= 0;

  useEffect(() => {
    setComplementos(null);
    setAlternativas(null);
    api.complementos(producto.sku).then(setComplementos).catch(() => setComplementos([]));
    api.alternativas(producto.sku).then(setAlternativas).catch(() => setAlternativas([]));
  }, [producto.sku]);

  const listaAlternativas = (
    <Seccion titulo={agotado ? "Está agotado. Ofrece esto, que sí hay:" : "Parecidos con stock"} acento={agotado}>
      {alternativas === null ? <Cargando /> : alternativas.length ? (
        alternativas.map((a) => <Mini key={a.sku} p={a} nota={`${Math.round(a.similitud * 100)}% parecido`} abrir={abrir} />)
      ) : <Vacio>No hay productos parecidos con stock.</Vacio>}
    </Seccion>
  );

  return (
    <div className="fixed inset-0 z-40 grid place-items-center bg-negro/60 p-4" onClick={cerrar}>
      <div className="max-h-[90vh] w-full max-w-3xl overflow-y-auto rounded-2xl bg-white shadow-2xl" onClick={(e) => e.stopPropagation()}>
        <div className="flex gap-5 p-5">
          <div className={`h-40 w-40 shrink-0 overflow-hidden rounded-xl bg-fondo ${agotado ? "grayscale" : ""}`}>
            {producto.foto ? <img src={producto.foto} alt="" className="h-full w-full object-cover" /> : (
              <div className="grid h-full place-items-center text-5xl font-black text-borde">{producto.nombre.slice(0, 1)}</div>
            )}
          </div>
          <div className="min-w-0 flex-1">
            <div className="text-xs uppercase tracking-wide text-gris">{producto.categoria ?? "Sin categoría"}</div>
            <h2 className="text-xl font-extrabold leading-tight">{producto.nombre}</h2>
            <div className="mt-1 text-sm text-gris">SKU {producto.sku}</div>
            <div className="mt-3 text-2xl font-extrabold text-rojo">{pesos(producto.precio)}</div>
            <div className={`mt-1 font-semibold ${agotado ? "text-rojo" : "text-verde"}`}>
              {agotado ? "Agotado" : `Stock ${numero(producto.stock)}`}
            </div>
          </div>
          <button onClick={cerrar} className="self-start rounded px-2 text-gris hover:bg-fondo" aria-label="Cerrar">✕</button>
        </div>

        <div className="space-y-4 border-t border-borde bg-fondo/50 p-5">
          {agotado && listaAlternativas}
          <Seccion titulo="Lleva también (lo que otros clientes compraron con este producto)">
            {complementos === null ? <Cargando /> : complementos.length ? (
              complementos.map((c) => (
                <Mini key={c.sku} p={c} nota={`juntos en ${c.veces_juntos} ventas · ${Math.round(c.confianza * 100)}% de las veces`} abrir={abrir} />
              ))
            ) : <Vacio>Todavía no hay ventas suficientes de este producto para sugerir complementos.</Vacio>}
          </Seccion>
          {!agotado && listaAlternativas}
        </div>
      </div>
    </div>
  );
}

function Seccion({ titulo, acento, children }: { titulo: string; acento?: boolean; children: React.ReactNode }) {
  return (
    <section>
      <h3 className={`mb-2 text-sm font-bold ${acento ? "text-rojo" : ""}`}>{titulo}</h3>
      <div className="grid gap-2 sm:grid-cols-2">{children}</div>
    </section>
  );
}

function Mini({ p, nota, abrir }: { p: Producto; nota: string; abrir: (p: Producto) => void }) {
  return (
    <button onClick={() => abrir(p)} className="flex items-center gap-3 rounded-xl border border-borde bg-white p-2 text-left hover:border-cobre">
      <div className="h-14 w-14 shrink-0 overflow-hidden rounded-lg bg-fondo">
        {p.foto ? <img src={p.foto} alt="" className="h-full w-full object-cover" /> : (
          <div className="grid h-full place-items-center font-black text-borde">{p.nombre.slice(0, 1)}</div>
        )}
      </div>
      <div className="min-w-0">
        <div className="truncate text-sm font-semibold">{p.nombre}</div>
        <div className="text-sm font-bold text-rojo">{pesos(p.precio)} <span className="font-normal text-gris">· stock {numero(p.stock)}</span></div>
        <div className="text-xs text-gris">{nota}</div>
      </div>
    </button>
  );
}

const Cargando = () => <p className="text-sm text-gris">Buscando…</p>;
const Vacio = ({ children }: { children: React.ReactNode }) => <p className="text-sm text-gris">{children}</p>;
