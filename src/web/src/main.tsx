import { StrictMode, useEffect, useState } from "react";
import { createRoot } from "react-dom/client";
import "./estilos.css";
import { Panel } from "./paginas/Panel";
import { Vendedor } from "./paginas/Vendedor";

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
  return (
    <main className="min-h-screen grid place-items-center bg-negro px-4">
      <div className="w-full max-w-md text-center">
        <img src="/logo.jpg" alt="Ferre y Tapiz" className="mx-auto h-28 w-28 rounded-full object-cover ring-4 ring-cobre" />
        <h1 className="mt-6 text-3xl font-extrabold text-white">AgenTech</h1>
        <p className="mt-2 text-crema/80">Busca productos como los describe el cliente y entiende cómo va el negocio.</p>
        <div className="mt-8 grid gap-3">
          <button onClick={() => irA("/vendedor")} className="rounded-xl bg-cobre px-6 py-4 text-lg font-bold text-negro hover:brightness-110">
            Entrar como vendedor
          </button>
          <button onClick={() => irA("/panel")} className="rounded-xl border-2 border-crema/40 px-6 py-4 text-lg font-bold text-crema hover:bg-white/5">
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
