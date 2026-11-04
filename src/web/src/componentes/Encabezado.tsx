import type { ReactNode } from "react";

export function Encabezado({ titulo, salir, children }: { titulo: string; salir: () => void; children?: ReactNode }) {
  return (
    <header className="sticky top-0 z-20 bg-negro text-white shadow">
      <div className="mx-auto flex max-w-7xl items-center gap-3 px-4 py-3">
        <img src="/logo.jpg" alt="" className="h-10 w-10 rounded-full object-cover ring-2 ring-cobre" />
        <div className="leading-tight">
          <div className="font-extrabold">Ferre y Tapiz</div>
          <div className="text-xs text-cobre">{titulo}</div>
        </div>
        <div className="ml-auto flex items-center gap-3">
          {children}
          <button onClick={salir} className="rounded-lg px-3 py-1.5 text-sm text-crema/80 hover:bg-white/10">
            Salir
          </button>
        </div>
      </div>
    </header>
  );
}
