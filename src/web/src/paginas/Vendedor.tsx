import { useEffect, useState } from "react";
import { api, numero, pesos, type Producto, type ResultadoConsulta } from "../api";
import { Chatbot } from "../componentes/Chatbot";
import { Encabezado } from "../componentes/Encabezado";
import { Ficha } from "../componentes/Ficha";

// Panel del vendedor: el mismo catálogo del e-commerce (foto, precio, stock) más la búsqueda
// semántica ("como lo dice el cliente") y el chatbot.

export function Vendedor({ salir }: { salir: () => void }) {
  const [categorias, setCategorias] = useState<{ nombre: string; disponibles: number }[]>([]);
  const [categoria, setCategoria] = useState("");
  const [texto, setTexto] = useState("");
  const [modo, setModo] = useState<"inteligente" | "nombre">("inteligente");
  const [soloStock, setSoloStock] = useState(true);
  const [pagina, setPagina] = useState(1);
  const [catalogo, setCatalogo] = useState<{ total: number; productos: Producto[] }>({ total: 0, productos: [] });
  const [semantica, setSemantica] = useState<ResultadoConsulta | null>(null);
  const [cargando, setCargando] = useState(false);
  const [error, setError] = useState("");
  const [chatAbierto, setChatAbierto] = useState(false);
  const [ficha, setFicha] = useState<Producto | null>(null);

  useEffect(() => {
    api.categorias().then(setCategorias).catch(() => {});
  }, []);

  useEffect(() => {
    if (semantica) return;
    setCargando(true);
    api
      .productos({ q: modo === "nombre" ? texto : undefined, categoria, disponibles: soloStock ? "true" : undefined, pagina, por_pagina: 24 })
      .then((r) => (setCatalogo(r), setError("")))
      .catch((e) => setError(e.message))
      .finally(() => setCargando(false));
  }, [categoria, soloStock, pagina, semantica, modo === "nombre" ? texto : ""]);

  async function buscar(e: React.FormEvent) {
    e.preventDefault();
    if (modo === "nombre" || !texto.trim()) {
      setSemantica(null);
      setPagina(1);
      return;
    }
    setCargando(true);
    try {
      setSemantica(await api.consulta(texto, 12));
      setError("");
    } catch (err: any) {
      setError(err.message);
    } finally {
      setCargando(false);
    }
  }

  const productos: (Producto & { score?: number })[] = semantica ? semantica.resultados : catalogo.productos;
  const paginas = Math.ceil(catalogo.total / 24);

  return (
    <div className="min-h-screen">
      <Encabezado titulo="Panel del vendedor" salir={salir}>
        <button onClick={() => setChatAbierto(true)} className="rounded-lg bg-cobre px-4 py-2 text-sm font-bold text-negro hover:brightness-110">
          Asistente
        </button>
      </Encabezado>

      <section className="bg-negro pb-8 pt-4">
        <form onSubmit={buscar} className="mx-auto max-w-3xl px-4">
          <div className="mb-3 flex justify-center gap-2 text-sm">
            {(["inteligente", "nombre"] as const).map((m) => (
              <button
                type="button"
                key={m}
                onClick={() => (setModo(m), setSemantica(null))}
                className={`rounded-full px-4 py-1.5 font-semibold ${modo === m ? "bg-crema text-negro" : "text-crema/70 hover:text-crema"}`}
              >
                {m === "inteligente" ? "Como lo dice el cliente" : "Por nombre o SKU"}
              </button>
            ))}
          </div>
          <div className="flex gap-2">
            <input
              value={texto}
              onChange={(e) => setTexto(e.target.value)}
              placeholder={modo === "inteligente" ? "Ej.: algo pa tapar goteras, tarugos pal concreto…" : "Ej.: silicona, A000000001"}
              className="w-full rounded-xl border-0 bg-white px-5 py-4 text-lg outline-none ring-cobre focus:ring-4"
            />
            <button className="rounded-xl bg-rojo px-6 font-bold text-white hover:bg-rojo-oscuro">Buscar</button>
          </div>
        </form>
      </section>

      <main className="mx-auto max-w-7xl px-4 py-6">
        {!semantica && (
          <div className="mb-5 flex flex-wrap items-center gap-2">
            <Chip activo={!categoria} onClick={() => (setCategoria(""), setPagina(1))}>Todo</Chip>
            {categorias.map((c) => (
              <Chip key={c.nombre} activo={categoria === c.nombre} onClick={() => (setCategoria(c.nombre), setPagina(1))}>
                {c.nombre} <span className="opacity-60">{c.disponibles}</span>
              </Chip>
            ))}
            <label className="ml-auto flex items-center gap-2 text-sm text-gris">
              <input type="checkbox" checked={soloStock} onChange={(e) => (setSoloStock(e.target.checked), setPagina(1))} />
              Solo con stock
            </label>
          </div>
        )}

        {semantica && (
          <div className="mb-5 flex flex-wrap items-center gap-3 rounded-xl bg-crema px-4 py-3 text-sm">
            {semantica.agotado_parecido && (
              <span className="w-full font-semibold text-rojo">
                “{semantica.agotado_parecido.nombre}” está agotado. Estas son las alternativas con stock:
              </span>
            )}
            <span>
              <b>{semantica.resultados.length}</b> productos con stock para “{semantica.texto}” · {semantica.latencia_ms} ms
            </span>
            <button onClick={() => setSemantica(null)} className="ml-auto font-semibold text-rojo hover:underline">
              Volver al catálogo
            </button>
          </div>
        )}

        {error && <p className="mb-4 rounded-lg bg-rojo/10 px-4 py-3 text-rojo">{error}</p>}
        {cargando && <p className="py-10 text-center text-gris">Buscando…</p>}
        {!cargando && semantica && !semantica.resultados.length && (
          <p className="rounded-xl bg-white px-6 py-10 text-center text-gris">
            No encontramos productos con stock que se parezcan a lo que pide el cliente. Prueba con otras palabras o pregúntale para qué lo necesita.
          </p>
        )}

        <div className="grid grid-cols-2 gap-4 sm:grid-cols-3 lg:grid-cols-4 xl:grid-cols-6">
          {!cargando && productos.map((p) => <Tarjeta key={p.sku} p={p} abrir={() => setFicha(p)} />)}
        </div>

        {!semantica && paginas > 1 && (
          <div className="mt-8 flex items-center justify-center gap-3">
            <button disabled={pagina === 1} onClick={() => setPagina(pagina - 1)} className="rounded-lg bg-white px-4 py-2 disabled:opacity-40">
              Anterior
            </button>
            <span className="text-sm text-gris">
              Página {pagina} de {paginas} · {catalogo.total} productos
            </span>
            <button disabled={pagina >= paginas} onClick={() => setPagina(pagina + 1)} className="rounded-lg bg-white px-4 py-2 disabled:opacity-40">
              Siguiente
            </button>
          </div>
        )}
      </main>

      <Chatbot abierto={chatAbierto} cerrar={() => setChatAbierto(false)} abrir={setFicha} />
      {ficha && <Ficha producto={ficha} cerrar={() => setFicha(null)} abrir={setFicha} />}
    </div>
  );
}

function Chip({ activo, onClick, children }: { activo: boolean; onClick: () => void; children: React.ReactNode }) {
  return (
    <button
      onClick={onClick}
      className={`rounded-full border px-3 py-1 text-sm ${activo ? "border-negro bg-negro text-white" : "border-borde bg-white hover:border-negro"}`}
    >
      {children}
    </button>
  );
}

function Tarjeta({ p, abrir }: { p: Producto & { score?: number }; abrir: () => void }) {
  const agotado = p.stock <= 0;
  return (
    <article
      onClick={abrir}
      className={`flex cursor-pointer flex-col overflow-hidden rounded-xl border border-borde bg-white transition hover:-translate-y-0.5 hover:shadow-md ${agotado ? "opacity-60 grayscale" : ""}`}
    >
      <div className="relative aspect-square bg-fondo">
        {p.foto ? (
          <img src={p.foto} alt={p.nombre} loading="lazy" className="h-full w-full object-cover" />
        ) : (
          <div className="grid h-full place-items-center text-4xl font-black text-borde">{p.nombre.slice(0, 1)}</div>
        )}
        {agotado && <span className="absolute left-2 top-2 rounded bg-gris px-2 py-0.5 text-xs font-bold text-white">Agotado</span>}
        {p.score != null && (
          <span className="absolute right-2 top-2 rounded bg-negro/80 px-2 py-0.5 text-xs font-bold text-cobre">
            {Math.round(p.score * 100)}%
          </span>
        )}
      </div>
      <div className="flex flex-1 flex-col gap-1 p-3">
        <div className="text-xs uppercase tracking-wide text-gris">{p.categoria ?? "Sin categoría"}</div>
        <h3 className="line-clamp-2 text-sm font-semibold leading-snug">{p.nombre}</h3>
        <div className="mt-auto pt-2">
          <div className="text-lg font-extrabold text-rojo">{pesos(p.precio)}</div>
          <div className="flex justify-between text-xs text-gris">
            <span>SKU {p.sku}</span>
            <span className={agotado ? "" : "font-semibold text-verde"}>Stock {numero(p.stock)}</span>
          </div>
        </div>
      </div>
    </article>
  );
}
