"""Mide la búsqueda en la base (T09 y T30): compara la híbrida anterior con la de fusión.

    python evaluar_busqueda.py

Carga los casos de CASOS (evaluar_modelos.py) en casos_prueba y usa el modelo de EMBEDDING_MODEL.
Solo considera productos con stock, igual que la búsqueda real. Compara:

- "Híbrida": buscar_productos_hibrida con distintos pesos de texto (lo que había hasta el 10-11-2026).
- "Fusión": expandir_consulta (sinónimos y escritura) + buscar_productos_fusion (vector, texto completo
  y trigramas combinados por posición), si la base ya tiene el script 09.

Informa el total y cada grupo de consultas por separado, y las consultas que fallan.
Deja el informe en resultados/evaluacion_busqueda.md.
"""

import os
import time
from pathlib import Path

from evaluar_modelos import cargar_casos, prefijo_consulta
from vectorizar import cargar_env, como_vector, conexion, embeddings

AQUI = Path(__file__).resolve().parent
K = 5
PESOS = [0.0, 0.15, 0.35]
# Consultas que no tienen nada que ver con una ferretería: deben volver vacías.
AJENAS = ["pizza napolitana", "pasaje en bus a Valparaíso", "seguro de auto", "zapatillas de running",
          "clases de guitarra", "receta de empanadas", "celular samsung nuevo", "arriendo de departamento",
          "domotica", "notebook gamer", "corte de pelo para hombre", "veterinaria para mi perro", "pasaje de avion a santiago"]


def grupo(descripcion):
    return descripcion.split(":")[0] if descripcion and ":" in descripcion else "Original"


def medir(casos, buscar):
    """casos: [(texto, grupo, esperados)]. buscar(texto) -> ids del top K. Devuelve métricas por grupo y fallas."""
    por_grupo, fallas, tiempos = {}, [], []
    for texto, g, esperados in casos:
        t0 = time.time()
        top = buscar(texto)
        tiempos.append((time.time() - t0) * 1000)
        rel = [pid in esperados for pid in top]
        fila = (any(rel), sum(rel) / K, next((1 / (i + 1) for i, r in enumerate(rel) if r), 0))
        for clave in (g, "Total"):
            por_grupo.setdefault(clave, []).append(fila)
        if not any(rel):
            fallas.append(texto)
    resumen = {g: (len(f), sum(x[0] for x in f) / len(f), sum(x[1] for x in f) / len(f), sum(x[2] for x in f) / len(f))
               for g, f in por_grupo.items()}
    return resumen, fallas, sorted(tiempos)[len(tiempos) // 2]


def main():
    cargar_env()
    url = os.environ.get("OLLAMA_URL", "http://127.0.0.1:11434")
    modelo = os.environ.get("EMBEDDING_MODEL", "nomic-embed-text-v2-moe")
    with conexion() as con:
        cargar_casos(con)
        casos = [(texto, grupo(desc), set(esperados)) for texto, desc, esperados in con.execute(
            """SELECT c.consulta, c.descripcion, array_agg(e.producto_id)
               FROM casos_prueba c JOIN casos_prueba_esperados e ON e.caso_id = c.id
               JOIN productos p ON p.id = e.producto_id AND p.stock > 0
               WHERE c.activo GROUP BY c.id ORDER BY c.id""").fetchall()]
        hay_fusion = con.execute("SELECT to_regproc('buscar_productos_fusion') IS NOT NULL").fetchone()[0]

        def vector(texto):
            return como_vector(embeddings([prefijo_consulta(modelo) + texto], modelo, url, 768)[0])

        textos = [t for t, _, _ in casos] + AJENAS
        vectores = {t: vector(t) for t in textos}
        expandidas, vectores_exp = {}, {}
        if hay_fusion:
            for t in textos:
                expandidas[t] = con.execute("SELECT expandir_consulta(%s)", (t,)).fetchone()[0]
                vectores_exp[t] = vectores[t] if expandidas[t] == t else vector(expandidas[t])

        def hibrida(peso, minima=0):
            return lambda t: [r[0] for r in con.execute(
                "SELECT producto_id FROM buscar_productos_hibrida(%s::vector, %s::text, %s::int, %s::real, %s::real)",
                (vectores[t], t, K, minima, peso)).fetchall()]

        def fusion(t):
            return [r[0] for r in con.execute(
                "SELECT producto_id FROM buscar_productos_fusion(%s::vector, %s::text, %s::int)",
                (vectores_exp[t], expandidas[t], K)).fetchall()]

        variantes = [(f"Híbrida, peso del texto {p}", hibrida(p)) for p in PESOS]
        if hay_fusion:
            variantes.append(("Fusión con sinónimos", fusion))
        resultados = [(nombre, *medir(casos, buscar)) for nombre, buscar in variantes]

        # Con el umbral real: las consultas ajenas deben volver vacías.
        ajenas = [("Híbrida, peso 0.15 y umbral 0.32", sum(1 for t in AJENAS if not hibrida(0.15, 0.32)(t)))]
        reglas, por_revisar = {}, 0
        if hay_fusion:
            ajenas.append(("Fusión con sinónimos", sum(1 for t in AJENAS if not fusion(t))))
            reglas = dict(con.execute("SELECT tipo, count(*) FROM sinonimos_busqueda WHERE activo GROUP BY tipo").fetchall())
            por_revisar = con.execute("SELECT count(*) FROM revisar_sinonimos()").fetchone()[0]

    grupos = ["Total"] + sorted({g for _, g, _ in casos})
    lineas = [f"# Evaluación de la búsqueda ({time.strftime('%Y-%m-%d')})", "",
              f"Modelo `{modelo}`, {len(casos)} consultas con productos esperados en stock, top {K}.",
              "Cada celda: acierto@5 / MRR.", "",
              "| Variante | " + " | ".join(f"{g} ({resultados[0][1][g][0]})" for g in grupos) + " | SQL p50 (ms) |",
              "|---|" + "---|" * (len(grupos) + 1)]
    for nombre, resumen, _, p50 in resultados:
        lineas.append(f"| {nombre} | " + " | ".join(f"{resumen[g][1]:.2f} / {resumen[g][3]:.2f}" for g in grupos)
                      + f" | {p50:.0f} |")
    lineas += ["", "Precisión@5 total: " + "; ".join(f"{n}: {r['Total'][2]:.3f}" for n, r, _, _ in resultados), "",
               f"Consultas ajenas que vuelven vacías (de {len(AJENAS)}): "
               + "; ".join(f"{n}: {v}" for n, v in ajenas), ""]
    for nombre, _, fallas, _ in resultados[1:]:
        lineas += [f"Fallan con «{nombre}» ({len(fallas)}): " + ("; ".join(fallas) if fallas else "ninguna"), ""]
    if reglas:
        lineas += ["Cómo leer estos números:",
                   f"- El diccionario tiene {sum(reglas.values())} reglas ("
                   + ", ".join(f"{n} de {t}" for t, n in sorted(reglas.items())) + f"); {por_revisar} por revisar "
                   "(`SELECT * FROM revisar_sinonimos();`).",
                   "- Los grupos «Otro nombre», «Por uso», «Mal escrito» y «Nombre exacto» se conocían al escribir el "
                   "diccionario: su mejora muestra que el mecanismo funciona, no cuánto acierta con consultas nuevas.",
                   "- «Validación a ciegas» se escribió sin ver el diccionario y cada consulta espera un producto puntual "
                   "(con su medida o color). Las descripciones revisadas (tipos_producto.py) se escribieron conociéndola.",
                   "- «Validación a ciegas 2» se escribió después, sin ver el diccionario ni las descripciones; casi todas "
                   "son por uso y no nombran el producto. Es la más difícil y la que mejor anticipa el uso real. Su primera "
                   "medición fue 0,70 / 0,67 (0,55 / 0,49 con las descripciones anteriores); después se agregaron al "
                   "diccionario palabras aprendidas de sus fallas (gaveta, ropero, zancudo, «qué le pongo»).", ""]
    (AQUI / "resultados").mkdir(exist_ok=True)
    (AQUI / "resultados" / "evaluacion_busqueda.md").write_text("\n".join(lineas), encoding="utf-8")
    print("\n".join(lineas))


if __name__ == "__main__":
    main()
