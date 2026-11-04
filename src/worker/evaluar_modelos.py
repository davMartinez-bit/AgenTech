"""Compara modelos de embeddings con las consultas de prueba de casos_prueba (T07 y T09).

    python evaluar_modelos.py --modelos nomic-embed-text,granite-embedding:278m,bge-m3

1. Carga (o actualiza) los casos de prueba de CASOS en casos_prueba y casos_prueba_esperados.
   El producto esperado se marca con una expresión regular sobre el nombre.
2. Para cada modelo, vectoriza todos los productos activos en memoria (no toca producto_embeddings),
   vectoriza cada consulta y mide sobre el top 5: acierto@5, precisión@5 y MRR. También mide la latencia
   del embedding de una consulta.
3. Deja el informe en resultados/evaluacion_modelos.md y .json.
"""

import argparse
import json
import math
import os
import re
import time
import unicodedata
from pathlib import Path

from vectorizar import cargar_env, conexion, embeddings, prefijo_documento

AQUI = Path(__file__).resolve().parent
K = 5

# (consulta del vendedor, descripción, regex sobre el nombre del producto esperado)
CASOS = [
    ("tela resistente para tapizar un sillón", "Telas de tapicería", "(chenille|lino|felpa|tafet)"),
    ("relleno para el asiento de una silla", "Espumas de tapicería", "espuma"),
    ("algo para pintar una reja de fierro que no se oxide", "Anticorrosivos", "anticorrosivo"),
    ("tornillos para colgar planchas de yeso cartón", "Tornillos para drywall", "drywall"),
    ("tarugos pal concreto", "Tarugos", "tarugo"),
    ("huincha pa medir", "Huinchas de medir", "huincha (de )?medir"),
    ("algo pa tapar goteras", "Selladores para goteras", "(tapagotera|gotera)"),
    ("pegamento de contacto para cuero y goma", "Adhesivos de contacto", "(super contact|contacto|afix)"),
    ("cinta de papel para pintar sin manchar", "Cinta masking", "masking"),
    ("disco para cortar fierro con el esmeril", "Discos de corte", "disco (de )?corte"),
    ("teflón pa la llave del agua", "Teflón", "teflon"),
    ("manguera pal jardín", "Mangueras de jardín", "manguera jardin"),
    ("pilas chicas pal control remoto", "Pilas AAA", "pila .*aaa"),
    ("enchufe para conectar varias cosas", "Enchufes múltiples", "(enchufe.*(triple|multiple)|zapatilla|alargador)"),
    ("diluyente para limpiar las brochas", "Diluyentes", "(diluyente|aguarras)"),
    ("rodillo para pintar la muralla", "Rodillos", "rodillo"),
    ("bisagra para la puerta del mueble", "Bisagras", "bisagra"),
    ("tirador para el cajón", "Tiradores", "tirador"),
    ("pistón a gas para mueble", "Pistones", "piston"),
    ("clavos para pegar en concreto", "Clavos de acero", "clavo (hilti|acero|concreto)"),
    ("lija para madera", "Lijas", "lija"),
    ("guantes pa trabajar", "Guantes", "guante"),
    ("silicona para el baño que no le salgan hongos", "Silicona antihongos", "(fungicida|antihongo)"),
    ("ácido pa limpiar la cerámica", "Ácido muriático", "muriatico"),
    ("flexible para la ducha", "Flexibles", "flexible.*ducha"),
    ("ruedas para mover un mueble", "Ruedas", "rueda"),
    ("espuma para hacer cojines", "Espumas", "espuma"),
    ("llave para apretar tuercas", "Llaves", "llave (punta|corona|francesa|ajustable)"),
    ("algo pa ponerle candado al portón", "Portacandados", "(portacandado|candado)"),
    ("botones para tapizar un respaldo", "Botones de tapicería", "boton"),
]


def sin_tildes(t):
    return "".join(c for c in unicodedata.normalize("NFD", t) if unicodedata.category(c) != "Mn")


def cargar_casos(con):
    productos = con.execute("SELECT id, nombre FROM productos WHERE activo").fetchall()
    with con.cursor() as cur:
        for consulta, descripcion, regex in CASOS:
            cur.execute(
                """INSERT INTO casos_prueba (consulta, descripcion) VALUES (%s, %s)
                   ON CONFLICT (consulta) DO UPDATE SET descripcion = EXCLUDED.descripcion RETURNING id""",
                (consulta, descripcion))
            caso_id = cur.fetchone()[0]
            cur.execute("DELETE FROM casos_prueba_esperados WHERE caso_id = %s", (caso_id,))
            patron = re.compile(regex, re.IGNORECASE)
            esperados = [pid for pid, nombre in productos if patron.search(sin_tildes(nombre))]
            cur.executemany("INSERT INTO casos_prueba_esperados (caso_id, producto_id) VALUES (%s, %s)",
                            [(caso_id, pid) for pid in esperados])
    con.commit()
    filas = con.execute(
        """SELECT c.id, c.consulta, array_agg(e.producto_id) FILTER (WHERE e.producto_id IS NOT NULL)
           FROM casos_prueba c LEFT JOIN casos_prueba_esperados e ON e.caso_id = c.id
           WHERE c.activo GROUP BY c.id ORDER BY c.id""").fetchall()
    return [(cid, texto, set(esp or [])) for cid, texto, esp in filas]


def prefijo_consulta(modelo):
    base = modelo.split(":")[0]
    if "e5" in base:
        return "query: "
    return "search_query: " if base.startswith("nomic-embed-text") else ""


def normalizar(v):
    n = math.sqrt(sum(x * x for x in v)) or 1.0
    return [x / n for x in v]


def evaluar(con, modelo, url, casos):
    productos = con.execute(
        """SELECT p.id, p.nombre, concat_ws('. ', p.nombre, c.nombre, m.nombre, p.descripcion)
           FROM productos p LEFT JOIN categorias c ON c.id = p.categoria_id
           LEFT JOIN marcas m ON m.id = p.marca_id WHERE p.activo ORDER BY p.id""").fetchall()
    inicio = time.time()
    vectores = []
    for i in range(0, len(productos), 32):
        grupo = productos[i:i + 32]
        crudos = embeddings([prefijo_documento(modelo) + t for _, _, t in grupo], modelo, url, None)
        vectores.extend(normalizar(v) for v in crudos)
    t_productos = time.time() - inicio

    nombres = {pid: nombre for pid, nombre, _ in productos}
    aciertos, precisiones, rr, latencias, detalle = 0, [], [], [], []
    for _, texto, esperados in casos:
        t0 = time.time()
        q = normalizar(embeddings([prefijo_consulta(modelo) + texto], modelo, url, None)[0])
        latencias.append((time.time() - t0) * 1000)
        puntajes = sorted(((sum(a * b for a, b in zip(q, v)), pid) for (pid, _, _), v in zip(productos, vectores)),
                          reverse=True)[:K]
        relevantes = [pid in esperados for _, pid in puntajes]
        aciertos += any(relevantes)
        precisiones.append(sum(relevantes) / K)
        rr.append(next((1 / (i + 1) for i, r in enumerate(relevantes) if r), 0))
        detalle.append({"consulta": texto, "top": [(nombres[pid], round(s, 3), pid in esperados) for s, pid in puntajes]})
    latencias.sort()
    return {
        "modelo": modelo,
        "dimensiones": len(vectores[0]),
        "acierto_5": round(aciertos / len(casos), 3),
        "precision_5": round(sum(precisiones) / len(casos), 3),
        "mrr": round(sum(rr) / len(casos), 3),
        "latencia_consulta_ms_p50": round(latencias[len(latencias) // 2]),
        "segundos_vectorizar_catalogo": round(t_productos, 1),
        "detalle": detalle,
    }


def main():
    ap = argparse.ArgumentParser(description=__doc__, formatter_class=argparse.RawDescriptionHelpFormatter)
    ap.add_argument("--modelos", required=True, help="lista separada por comas, tal como la muestra `ollama list`")
    args = ap.parse_args()
    cargar_env()
    url = os.environ.get("OLLAMA_URL", "http://127.0.0.1:11434")

    with conexion() as con:
        casos = cargar_casos(con)
        sin_esperados = [t for _, t, e in casos if not e]
        if sin_esperados:
            print("Casos sin productos esperados (se ignoran):", sin_esperados)
        casos = [c for c in casos if c[2]]
        resultados = []
        for modelo in [m.strip() for m in args.modelos.split(",") if m.strip()]:
            print(f"Evaluando {modelo} con {len(casos)} consultas...")
            try:
                r = evaluar(con, modelo, url, casos)
            except Exception as e:
                print(f"  falló: {e}")
                continue
            print(f"  acierto@5={r['acierto_5']} precisión@5={r['precision_5']} MRR={r['mrr']} "
                  f"latencia={r['latencia_consulta_ms_p50']} ms dim={r['dimensiones']}")
            resultados.append(r)

    salida = AQUI / "resultados"
    salida.mkdir(exist_ok=True)
    (salida / "evaluacion_modelos.json").write_text(json.dumps(resultados, ensure_ascii=False, indent=1), encoding="utf-8")
    lineas = [f"# Evaluación de modelos de embeddings ({time.strftime('%Y-%m-%d')})", "",
              f"{len(casos)} consultas de prueba, top {K} sobre el catálogo activo.", "",
              "| Modelo | Dim. | Acierto@5 | Precisión@5 | MRR | Latencia consulta (ms) | Vectorizar catálogo (s) |",
              "|---|---|---|---|---|---|---|"]
    for r in sorted(resultados, key=lambda r: (-r["mrr"], -r["acierto_5"])):
        lineas.append(f"| {r['modelo']} | {r['dimensiones']} | {r['acierto_5']} | {r['precision_5']} | {r['mrr']} | "
                      f"{r['latencia_consulta_ms_p50']} | {r['segundos_vectorizar_catalogo']} |")
    (salida / "evaluacion_modelos.md").write_text("\n".join(lineas) + "\n", encoding="utf-8")
    print("\n".join(lineas))


if __name__ == "__main__":
    main()
