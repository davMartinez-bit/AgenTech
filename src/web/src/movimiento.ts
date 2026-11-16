import { useEffect, useRef } from "react";

// Parallax sin librerías. El gancho deja en el elemento variables CSS que las capas (.capa-*, en estilos.css)
// usan en su transform:
//   --desplazo: píxeles de avance (número sin unidad). Con origen "inicio" es el scroll de la página;
//               con origen "centro" es la distancia entre el centro de la pantalla y el del elemento.
//   --mx, --my: posición del mouse sobre el elemento, de -1 a 1 (solo si se pide `puntero`).
// Con "reducir movimiento" activado en el sistema no hace nada.
export function useParallax<T extends HTMLElement>(opciones: { origen?: "inicio" | "centro"; puntero?: boolean } = {}) {
  const { origen = "inicio", puntero = false } = opciones;
  const ref = useRef<T>(null);

  useEffect(() => {
    const el = ref.current;
    if (!el || matchMedia("(prefers-reduced-motion: reduce)").matches) return;
    let cuadro = 0;

    const medir = () => {
      cuadro = 0;
      const r = el.getBoundingClientRect();
      if (r.bottom < -200 || r.top > innerHeight + 200) return; // fuera de la vista: no se recalcula
      const avance = origen === "inicio" ? scrollY : innerHeight / 2 - (r.top + r.height / 2);
      el.style.setProperty("--desplazo", String(Math.round(Math.max(-600, Math.min(600, avance)))));
    };
    const alDesplazar = () => {
      if (!cuadro) cuadro = requestAnimationFrame(medir);
    };
    const alMover = (e: PointerEvent) => {
      if (e.pointerType !== "mouse") return;
      const r = el.getBoundingClientRect();
      el.style.setProperty("--mx", (((e.clientX - r.left) / r.width) * 2 - 1).toFixed(3));
      el.style.setProperty("--my", (((e.clientY - r.top) / r.height) * 2 - 1).toFixed(3));
    };
    const alSalir = () => {
      el.style.setProperty("--mx", "0");
      el.style.setProperty("--my", "0");
    };

    medir();
    addEventListener("scroll", alDesplazar, { passive: true });
    addEventListener("resize", alDesplazar);
    if (puntero) {
      el.addEventListener("pointermove", alMover);
      el.addEventListener("pointerleave", alSalir);
    }
    return () => {
      cancelAnimationFrame(cuadro);
      removeEventListener("scroll", alDesplazar);
      removeEventListener("resize", alDesplazar);
      el.removeEventListener("pointermove", alMover);
      el.removeEventListener("pointerleave", alSalir);
    };
  }, [origen, puntero]);

  return ref;
}
