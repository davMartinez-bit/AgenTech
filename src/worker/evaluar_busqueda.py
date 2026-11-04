"""Mide la búsqueda híbrida en la base (T09): precisión con distintos pesos de texto y umbral de similitud.

    python evaluar_busqueda.py

Usa los casos de casos_prueba (los carga evaluar_modelos.py) y el modelo de EMBEDDING_MODEL.
Solo considera productos con stock, igual que la búsqueda real. Deja el informe en
resultados/evaluacion_busqueda.md.
"""

import os
import time
from pathlib import Path

from evaluar_modelos import prefijo_consulta
from vectorizar import cargar_env, como_vector, conexion, embeddings

AQUI = Path(__file__).resolve().parent
K = 5
PESOS = [0.0, 0.15, 0.25, 0.35, 0.5]
# Consultas que no tienen nada que ver con una ferretería: sirven para fijar el umbral.
AJENAS = ["pizza napolitana", "pasaje en bus a Valparaíso", "seguro de auto", "zapatillas de running",
          "clases de guitarra", "receta de empanadas", "celular samsung nuevo", "arriendo de departamento"]


def main():
    cargar_env()
    url = os.environ.get("OLLAMA_URL", "http://127.0.0.1:11434")
    modelo = os.environ.get("EMBEDDING_MODEL", "nomic-embed-text-v2-moe")
    with conexion() as con:
        casos = con.execute(
            """SELECT c.consulta, array_agg(e.producto_id)
               FROM casos_prueba c JOIN casos_prueba_esperados e ON e.caso_id = c.id
               JOIN productos p ON p.id = e.producto_id AND p.stock > 0
               WHERE c.activo GROUP BY c.consulta ORDER BY c.consulta""").fetchall()
        vectores = {}
        latencias = []
        for texto in [c for c, _ in casos] + AJENAS:
            t0 = time.time()
            vectores[texto] = como_vector(embeddings([prefijo_consulta(modelo) + texto], modelo, url, 768)[0])
            latencias.append((time.time() - t0) * 1000)

        filas = []
        for peso in PESOS:
            aciertos, precisiones, rr, tiempos = 0, [], [], []
            for texto, esperados in casos:
                t0 = time.time()
                top = [r[0] for r in con.execute(
                    "SELECT producto_id FROM buscar_productos_hibrida(%s::vector, %s::text, %s::int, 0, %s::real)",
                    (vectores[texto], texto, K, peso)).fetchall()]
                tiempos.append((time.time() - t0) * 1000)
                rel = [pid in esperados for pid in top]
                aciertos += any(rel)
                precisiones.append(sum(rel) / K)
                rr.append(next((1 / (i + 1) for i, r in enumerate(rel) if r), 0))
            n = len(casos)
            filas.append((peso, aciertos / n, sum(precisiones) / n, sum(rr) / n, sorted(tiempos)[n // 2]))

        def top1(texto):
            return con.execute("SELECT max(1 - (embedding <=> %s::vector)) FROM producto_embeddings",
                               (vectores[texto],)).fetchone()[0]

        validas = sorted(top1(t) for t, _ in casos)
        ajenas = sorted(top1(t) for t in AJENAS)

    lineas = [f"# Evaluación de la búsqueda híbrida ({time.strftime('%Y-%m-%d')})", "",
              f"Modelo `{modelo}`, {len(casos)} consultas con productos esperados en stock, top {K}.", "",
              "| Peso del texto | Acierto@5 | Precisión@5 | MRR | SQL p50 (ms) |", "|---|---|---|---|---|"]
    lineas += [f"| {p} | {a:.3f} | {pr:.3f} | {m:.3f} | {t:.0f} |" for p, a, pr, m, t in filas]
    lineas += ["", "Similitud del mejor producto (para fijar `similitud_minima`):", "",
               f"- Consultas de ferretería: mínimo {validas[0]:.3f}, mediana {validas[len(validas) // 2]:.3f}",
               f"- Consultas ajenas: máximo {ajenas[-1]:.3f}, mediana {ajenas[len(ajenas) // 2]:.3f}",
               f"- Embedding de la consulta: mediana {sorted(latencias)[len(latencias) // 2]:.0f} ms"]
    (AQUI / "resultados").mkdir(exist_ok=True)
    (AQUI / "resultados" / "evaluacion_busqueda.md").write_text("\n".join(lineas) + "\n", encoding="utf-8")
    print("\n".join(lineas))


if __name__ == "__main__":
    main()
