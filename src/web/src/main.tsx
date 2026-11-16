import { StrictMode, useEffect, useState } from "react";
import { createRoot } from "react-dom/client";
import "./estilos.css";
import { Panel } from "./paginas/Panel";
import { Vendedor } from "./paginas/Vendedor";
import { useParallax } from "./movimiento";

// Navegación simple por ruta: /vendedor y /panel (administrador). Sin contraseñas: es la demo local.

function irA(ruta: string) {
  history.pushState(null, "", ruta);
  dispatchEvent(new PopStateEvent("popstate"));
}

function App() {
  const [ruta, setRuta] = useState(location.pathname);
  useEffect(() => {
    const cambio = () => setRuta(location.pathname);
    addEventListener("popstate", cambio);
    return () => removeEventListener("popstate", cambio);
  }, []);

  if (ruta.startsWith("/vendedor")) return <Vendedor salir={() => irA("/")} />;
  if (ruta.startsWith("/panel")) return <Panel salir={() => irA("/")} />;
  return <Portada irA={irA} />;
}

function Portada({ irA }: { irA: (ruta: string) => void }) {
  const fondo = useParallax<HTMLElement>({ origen: "inicio", puntero: true });
  return (
    <main ref={fondo} className="parallax grid min-h-screen place-items-center bg-negro px-4">
      <div aria-hidden className="capa capa-trama" />
      <div aria-hidden className="capa capa-cobre" />
      <div aria-hidden className="capa capa-rojo" />
      <div className="w-full max-w-md text-center">
        <div className="anim-crecer">
          <img src="/logo.jpg" alt="Ferre y Tapiz" className="anim-flotar mx-auto h-28 w-28 rounded-full object-cover shadow-2xl shadow-black/50 ring-4 ring-cobre" />
        </div>
        <h1 className="anim-subir mt-6 text-3xl font-extrabold text-white" style={{ "--i": 1 } as React.CSSProperties}>AgenTech</h1>
        <p className="anim-subir mt-2 text-crema/80" style={{ "--i": 2 } as React.CSSProperties}>
          Busca productos como los describe el cliente y entiende cómo va el negocio.
        </p>
        <div className="anim-subir mt-8 grid gap-3" style={{ "--i": 3 } as React.CSSProperties}>
          <button
            onClick={() => irA("/vendedor")}
            className="rounded-xl bg-cobre px-6 py-4 text-lg font-bold text-negro transition duration-200 hover:-translate-y-0.5 hover:brightness-110 active:translate-y-0 active:scale-[.98]"
          >
            Entrar como vendedor
          </button>
          <button
            onClick={() => irA("/panel")}
            className="rounded-xl border-2 border-crema/40 px-6 py-4 text-lg font-bold text-crema transition duration-200 hover:-translate-y-0.5 hover:bg-white/5 active:translate-y-0 active:scale-[.98]"
          >
            Entrar como administrador
          </button>
        </div>
      </div>
    </main>
  );
}

createRoot(document.getElementById("root")!).render(
  <StrictMode>
    <App />
  </StrictMode>,
);
