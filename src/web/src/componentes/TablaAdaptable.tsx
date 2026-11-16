import type { ReactNode } from "react";

// Tabla que se adapta al ancho de pantalla: en md o más (>=768px) se ve como tabla con letra grande
// (para proyectar en sala); en móvil (<768px) cada fila se convierte en una tarjeta, sin scroll horizontal.
// La primera columna es el título de la fila; las columnas "destacada" (p. ej. "Qué hacer") se resaltan.

export type ColumnaTabla<F> = {
  clave: string;                    // key de React
  titulo: string;                   // encabezado de la columna
  valor: (fila: F) => ReactNode;    // contenido de la celda
  derecha?: boolean;                // alinear a la derecha (números)
  destacada?: boolean;              // columna de recomendación ("Qué hacer"): se resalta
};

export function TablaAdaptable<F>({
  columnas,
  filas,
  clave,
  altoMaximo,
  ayudaFila,
}: {
  columnas: ColumnaTabla<F>[];
  filas: F[];
  clave: (fila: F, n: number) => string | number;
  altoMaximo?: boolean;                        // true: limita el alto y deja scroll vertical
  ayudaFila?: (fila: F) => string | undefined; // atributo title de la fila
}) {
  const [primera, ...restantes] = columnas;
  const normales = restantes.filter((c) => !c.destacada);
  const destacadas = restantes.filter((c) => c.destacada);

  return (
    <>
      {/* Vista tabla: md o más */}
      <div
        className={`hidden md:block overflow-x-auto ${altoMaximo ? "max-h-96 overflow-y-auto" : ""}`}
      >
        <table className="w-full text-base">
          <thead className={`text-left text-sm font-semibold text-gris ${altoMaximo ? "sticky top-0 bg-white" : ""}`}>
            <tr>
              {columnas.map((c, i) => (
                <th
                  key={c.clave}
                  className={`py-2 ${i > 0 ? "pl-4" : ""} ${c.derecha ? "text-right" : ""}`}
                >
                  {c.titulo}
                </th>
              ))}
            </tr>
          </thead>
          <tbody>
            {filas.map((fila, n) => (
              <tr key={clave(fila, n)} title={ayudaFila?.(fila)} className="border-t border-borde align-top transition-colors duration-150 hover:bg-crema/40">
                {columnas.map((c, i) => (
                  <td
                    key={c.clave}
                    className={[
                      "py-2.5",
                      i === 0 ? "pr-2" : "pl-4",
                      c.derecha ? "text-right tabular-nums whitespace-nowrap" : "",
                      c.destacada ? "font-semibold text-negro" : "",
                    ].join(" ")}
                  >
                    {c.valor(fila)}
                  </td>
                ))}
              </tr>
            ))}
          </tbody>
        </table>
      </div>

      {/* Vista móvil: menos de md, tarjetas */}
      <ul
        className={`md:hidden divide-y divide-borde ${altoMaximo ? "max-h-[28rem] overflow-y-auto" : ""}`}
      >
        {filas.map((fila, n) => (
          <li key={clave(fila, n)} title={ayudaFila?.(fila)} className="py-3">
            <div className="text-base font-bold">{primera.valor(fila)}</div>
            {normales.length > 0 && (
              <dl className="mt-2 grid grid-cols-2 gap-x-4 gap-y-2">
                {normales.map((c) => (
                  <div key={c.clave}>
                    <dt className="text-xs font-semibold uppercase tracking-wide text-gris">{c.titulo}</dt>
                    <dd className="text-base font-semibold tabular-nums">{c.valor(fila)}</dd>
                  </div>
                ))}
              </dl>
            )}
            {destacadas.map((c) => (
              <div key={c.clave} className="mt-3 rounded-lg border-l-4 border-cobre bg-crema/60 px-3 py-2">
                <div className="text-xs font-bold uppercase tracking-wide text-gris">{c.titulo}</div>
                <div className="text-base font-semibold text-negro">{c.valor(fila)}</div>
              </div>
            ))}
          </li>
        ))}
      </ul>
    </>
  );
}
