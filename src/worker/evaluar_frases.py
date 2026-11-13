"""Mide la búsqueda por fusión con las frases de cliente. Solo lectura.

    python evaluar_frases.py                       # tabla con los parámetros por defecto
    python evaluar_frases.py --fallos              # además, las consultas que fallan
    python evaluar_frases.py --fallos-grupo TEXTO  # fallos de los grupos que contienen TEXTO
    python evaluar_frases.py --barrido             # grilla de peso_frase, umbral_frase y frase_pasa
    python evaluar_frases.py --sin-cache-expansion # recalcula las expansiones (si cambió el diccionario)

Mide sin escribir en ninguna tabla ni en resultados/:
1. Los casos de evaluar_modelos.py (CASOS y validaciones), con el criterio de evaluar_busqueda.py:
   método fusión con sinónimos, texto = expandir_consulta(consulta) y vector del texto expandido.
2. Las consultas ajenas: AJENAS de evaluar_busqueda.py y AJENAS_EXTRA de este archivo. Deben volver vacías.
3. Las conversaciones de prueba (conjunto 'prueba'): cada frase es una consulta y los esperados son los
   productos de su conversación que están activos y con stock.

Expansiones y vectores se guardan en un caché JSON en la carpeta temporal del sistema, para que repetir
la medición no vuelva a llamar a Ollama.
"""

import argparse
import json
import os
import re
import tempfile
import time
from collections import namedtuple
from pathlib import Path

from evaluar_busqueda import AJENAS, K, grupo
from evaluar_modelos import (CASOS, CASOS_VALIDACION, CASOS_VALIDACION_2, CASOS_VALIDACION_3,
                             prefijo_consulta, sin_tildes)
from vectorizar import cargar_env, como_vector, conexion, embeddings

CACHE = Path(tempfile.gettempdir()) / "agentech_cache_consultas.json"

# Consultas que no tienen nada que ver con una ferretería: deben volver vacías.
AJENAS_EXTRA = ["arriendo de departamento", "pizza napolitana", "zapatillas para correr", "seguro de auto",
                "clases de guitarra", "receta de pan amasado", "celular samsung", "comida para gatos",
                "remedio para el dolor de cabeza", "entradas para el concierto", "bicicleta de montaña",
                "perfume de mujer", "cuaderno universitario", "vino tinto reserva", "hora al dentista",
                "pasaje de bus a concepcion", "shampoo anticaspa", "torta de cumpleaños", "consola de videojuegos",
                "curso de ingles"]

# Parámetros de buscar_productos_fusion, en el mismo orden que la función.
Params = namedtuple("Params", "similitud_minima peso_texto peso_trigrama peso_frase umbral_frase frase_pasa k frase_corta")

SQL_FUSION = """
    SELECT producto_id, nombre
    FROM buscar_productos_fusion(%s::vector, %s::text, %s::int, %s::real, %s::int,
                                 %s::real, %s::real, %s::real, %s::real, %s::real, %s::real)
"""

# Grilla del --barrido.
PESOS_FRASE = [0.0, 0.5, 1.0, 2.0]
UMBRALES_FRASE = [0.5, 0.55, 0.6]
FRASES_PASAN = [0.6, 0.7, 2.0]


class Consultas:
    """Expansión y vector de cada consulta. Caché en disco: texto -> expandido, modelo + expandido -> vector."""

    def __init__(self, con, modelo, url, recalcular_expansion):
        self.con, self.modelo, self.url = con, modelo, url
        self.recalcular = recalcular_expansion
        try:
            datos = json.loads(CACHE.read_text(encoding="utf-8"))
        except (OSError, ValueError):
            datos = {}
        self.expansiones = datos.get("expansiones", {})
        self.vectores = datos.get("vectores", {})
        self.memoria = {}
        self.cambio = False
        self.expansiones_sql = 0
        self.vectores_nuevos = 0

    def de(self, texto):
        """Devuelve (texto expandido, vector en formato de pgvector)."""
        if texto not in self.memoria:
            if self.recalcular or texto not in self.expansiones:
                expandido = self.con.execute("SELECT expandir_consulta(%s)", (texto,)).fetchone()[0]
                self.expansiones_sql += 1
                if self.expansiones.get(texto) != expandido:
                    self.expansiones[texto] = expandido
                    self.cambio = True
            expandido = self.expansiones[texto]
            clave = f"{self.modelo}\t{expandido}"
            if clave not in self.vectores:
                self.vectores[clave] = embeddings([prefijo_consulta(self.modelo) + expandido],
                                                  self.modelo, self.url, 768)[0]
                self.vectores_nuevos += 1
                self.cambio = True
            self.memoria[texto] = (expandido, como_vector(self.vectores[clave]))
        return self.memoria[texto]

    def preparar(self, textos):
        for t in textos:
            self.de(t)

    def guardar(self):
        if self.cambio:
            CACHE.write_text(json.dumps({"expansiones": self.expansiones, "vectores": self.vectores},
                                        ensure_ascii=False), encoding="utf-8")


def grupo_prueba(clase, texto):
    if clase == "cliente":
        return "Prueba: cliente"
    n = len(texto.split())
    tramo = "1-4" if n <= 4 else "5-7" if n <= 7 else "8 o más"
    return f"Prueba: consulta {tramo} palabras"


def construir_casos(con):
    """Casos de evaluar_modelos.py con sus productos esperados activos y con stock. Nada se escribe."""
    filas = con.execute("SELECT id, nombre, stock FROM productos WHERE activo").fetchall()
    nombres = {pid: nombre for pid, nombre, _ in filas}
    con_stock = {pid for pid, _, stock in filas if stock is not None and stock > 0}
    # Igual que el ON CONFLICT de la base: la última definición de una consulta gana.
    definiciones = {}
    for consulta, descripcion, regex in CASOS + CASOS_VALIDACION + CASOS_VALIDACION_2 + CASOS_VALIDACION_3:
        definiciones[consulta] = (descripcion, regex)
    casos = []
    for consulta, (descripcion, regex) in definiciones.items():
        patron = re.compile(regex, re.IGNORECASE)
        esperados = {pid for pid, nombre in nombres.items()
                     if pid in con_stock and patron.search(" ".join(sin_tildes(nombre).split()))}
        if esperados:
            casos.append({"texto": consulta, "grupo": grupo(descripcion), "esperados": esperados})
    return casos, nombres


def construir_prueba(con):
    """Frases de las conversaciones de prueba. Se salta la frase si ningún producto de su conversación queda.

    Vale como acierto cualquier producto de la familia de los esperados (misma descripción): la
    conversación nombra a lo más 8, y otro color o medida del mismo producto es igual de correcto.
    """
    filas = con.execute("""
        SELECT f.texto, f.clase, coalesce(
            (SELECT array_agg(DISTINCT p.id) FROM conversacion_productos cp
             JOIN productos p0 ON p0.id = cp.producto_id
             JOIN productos p ON (p.id = p0.id OR p.descripcion = p0.descripcion) AND p.activo AND p.stock > 0
             WHERE cp.conversacion_id = c.id), '{}')
        FROM frases_cliente f
        JOIN conversaciones_mostrador c ON c.id = f.conversacion_id AND c.conjunto = 'prueba'
        ORDER BY f.id""").fetchall()
    casos = []
    for texto, clase, esperados in filas:
        if esperados:
            casos.append({"texto": texto, "grupo": grupo_prueba(clase, texto), "esperados": set(esperados)})
    return casos


def buscar_fusion(con, consultas, p):
    """buscar(texto) -> [(producto_id, nombre)] del top K con los parámetros p."""
    def buscar(texto):
        expandido, vector = consultas.de(texto)
        filas = con.execute(SQL_FUSION, (vector, expandido, K, p.similitud_minima, p.k, p.peso_texto,
                                         p.peso_trigrama, p.peso_frase, p.umbral_frase, p.frase_pasa,
                                         p.frase_corta)).fetchall()
        return [(pid, nombre) for pid, nombre in filas]
    return buscar


def correr(casos, buscar):
    """Ejecuta cada caso y devuelve registros con el top, el acierto, el RR y el tiempo en ms."""
    registros = []
    for caso in casos:
        inicio = time.perf_counter()
        top = buscar(caso["texto"])
        ms = (time.perf_counter() - inicio) * 1000
        rel = [pid in caso["esperados"] for pid, _ in top]
        registros.append({**caso, "top": top, "acierto": any(rel),
                          "rr": next((1 / (i + 1) for i, r in enumerate(rel) if r), 0.0), "ms": ms})
    return registros


def resumir(registros):
    """{grupo: (n, acierto@5, MRR)}, con la fila «Total»."""
    por_grupo = {}
    for r in registros:
        for clave in (r["grupo"], "Total"):
            por_grupo.setdefault(clave, []).append(r)
    return {g: (len(f), sum(r["acierto"] for r in f) / len(f), sum(r["rr"] for r in f) / len(f))
            for g, f in por_grupo.items()}


def imprimir_tabla(modelo, p, reg, reg_p, reg_a, aviso):
    print(f"Fusión con frases de cliente, modelo {modelo}, top {K}. Solo lectura.")
    print(f"similitud-minima {p.similitud_minima} | peso-texto {p.peso_texto} | peso-trigrama {p.peso_trigrama} | "
          f"peso-frase {p.peso_frase} | umbral-frase {p.umbral_frase} | frase-pasa {p.frase_pasa} | k {p.k}")
    print("grupo | n | acierto@5 | MRR")
    filas = resumir(reg)
    for g in ["Total"] + sorted(g for g in filas if g != "Total"):
        n, a, m = filas[g]
        print(f"{g} | {n} | {a:.2f} | {m:.2f}")
    if reg_p:
        filas_p = resumir(reg_p)
        for g in sorted(g for g in filas_p if g != "Total"):
            n, a, m = filas_p[g]
            print(f"{g} | {n} | {a:.2f} | {m:.2f}")
        n, a, m = filas_p["Total"]
        print(f"Prueba: total | {n} | {a:.2f} | {m:.2f}")
    else:
        print(f"Conversaciones de prueba: {aviso}")
    vacias_o = sum(1 for r in reg_a if r["grupo"] == "Ajena original" and not r["top"])
    vacias_e = sum(1 for r in reg_a if r["grupo"] == "Ajena extra" and not r["top"])
    print(f"Ajenas vacías: original {vacias_o} de {len(AJENAS)}; extra {vacias_e} de {len(AJENAS_EXTRA)}")
    ms = sorted(r["ms"] for r in reg + reg_p + reg_a)
    print(f"Latencia SQL p50: {ms[len(ms) // 2]:.0f} ms")


def imprimir_fallos(reg, reg_p, reg_a, nombres, filtro):
    fallos = [r for r in reg + reg_p if not r["acierto"] and (not filtro or filtro.lower() in r["grupo"].lower())]
    print(f"\nFallos ({len(fallos)}):")
    for r in fallos:
        nombres_esp = sorted(nombres.get(pid, str(pid)) for pid in r["esperados"])
        resumen_esp = "; ".join(nombres_esp[:3]) + (" ..." if len(nombres_esp) > 3 else "")
        top3 = " ; ".join(nombre for _, nombre in r["top"][:3]) or "VACÍO"
        print(f"[{r['grupo']}] {r['texto']}")
        print(f"  esperado ({len(nombres_esp)}): {resumen_esp}")
        print(f"  top 3: {top3}")
    if filtro is None:
        no_vacias = [r for r in reg_a if r["top"]]
        print(f"\nAjenas que no vuelven vacías ({len(no_vacias)}):")
        for r in no_vacias:
            print(f"[{r['grupo']}] {r['texto']} -> primer resultado: {r['top'][0][1]}")


def barrido(con, consultas, base, casos, prueba, ajenas):
    combinaciones = []
    for pf in PESOS_FRASE:
        if pf == 0:
            # Sin frases: la pasa 2.0 nunca se alcanza, así que una sola combinación basta.
            combinaciones.append((0.0, 0.6, 2.0))
            continue
        combinaciones += [(pf, um, pa) for um in UMBRALES_FRASE for pa in FRASES_PASAN]
    print(f"{len(combinaciones)} combinaciones. Columnas: peso_frase, umbral_frase, frase_pasa | "
          f"acierto@5 total | a ciegas 2 | a ciegas 3 | prueba (acierto / MRR) | ajenas vacías (de {len(ajenas)})")
    filas = []
    for pf, um, pa in combinaciones:
        p = base._replace(peso_frase=pf, umbral_frase=um, frase_pasa=pa)
        buscar = buscar_fusion(con, consultas, p)
        reg = resumir(correr(casos, buscar))
        reg_p = resumir(correr(prueba, buscar)) if prueba else {}
        vacias = sum(1 for r in correr([{"texto": t, "grupo": g, "esperados": set()} for t, g in ajenas], buscar)
                     if not r["top"])
        total = reg["Total"][1]
        a2 = reg.get("Validación a ciegas 2", (0, 0.0, 0.0))[1]
        a3 = reg.get("Validación a ciegas 3", (0, 0.0, 0.0))[1]
        if reg_p:
            _, ap_acierto, ap_mrr = reg_p["Total"]
            prueba_txt = f"{ap_acierto:.2f} / {ap_mrr:.2f}"
        else:
            ap_acierto, prueba_txt = 0.0, "sin datos"
        linea = (f"{pf:.2f}, {um:.2f}, {pa:.2f} | acierto@5 total {total:.2f} | a ciegas 2 {a2:.2f} | "
                 f"a ciegas 3 {a3:.2f} | prueba {prueba_txt} | ajenas vacías {vacias} de {len(ajenas)}")
        print(linea)
        filas.append((vacias, total + ap_acierto, linea))
    print("\nMejores 5 (ajenas vacías, luego acierto total + acierto prueba):")
    for _, _, linea in sorted(filas, key=lambda f: (-f[0], -f[1]))[:5]:
        print(linea)


def main():
    cargar_env()
    ap = argparse.ArgumentParser(description=__doc__, formatter_class=argparse.RawDescriptionHelpFormatter)
    ap.add_argument("--similitud-minima", type=float, default=0.32)
    ap.add_argument("--peso-frase", type=float, default=1.5)
    ap.add_argument("--umbral-frase", type=float, default=0.5)
    ap.add_argument("--frase-pasa", type=float, default=0.6)
    ap.add_argument("--frase-corta", type=float, default=0.5, help="peso de las frases en consultas de hasta 3 palabras")
    ap.add_argument("--peso-texto", type=float, default=1.0)
    ap.add_argument("--peso-trigrama", type=float, default=0.5)
    ap.add_argument("--k", type=int, default=20, help="constante RRF de buscar_productos_fusion")
    ap.add_argument("--fallos", action="store_true", help="lista las consultas que fallan y las ajenas que no vuelven vacías")
    ap.add_argument("--fallos-grupo", metavar="TEXTO", help="lista solo los fallos de los grupos que contienen TEXTO")
    ap.add_argument("--barrido", action="store_true", help="recorre la grilla de peso_frase, umbral_frase y frase_pasa")
    ap.add_argument("--sin-cache-expansion", action="store_true",
                    help="recalcula las expansiones (necesario si cambió el diccionario)")
    args = ap.parse_args()

    url = os.environ.get("OLLAMA_URL", "http://127.0.0.1:11434").rstrip("/")
    modelo = os.environ.get("EMBEDDING_MODEL", "nomic-embed-text-v2-moe")
    base = Params(args.similitud_minima, args.peso_texto, args.peso_trigrama, args.peso_frase,
                  args.umbral_frase, args.frase_pasa, args.k, args.frase_corta)
    ajenas = [(t, "Ajena original") for t in AJENAS] + [(t, "Ajena extra") for t in AJENAS_EXTRA]

    with conexion() as con:
        try:
            con.read_only = True
        except Exception as e:
            print("aviso: no se pudo fijar read_only:", e)
        if not con.execute("SELECT to_regproc('buscar_productos_fusion') IS NOT NULL").fetchone()[0]:
            raise SystemExit("Falta buscar_productos_fusion (aplica 15_frases_cliente.sql).")

        casos, nombres = construir_casos(con)
        prueba = construir_prueba(con)
        conv, frases = con.execute("""
            SELECT count(DISTINCT c.id), count(f.id) FROM conversaciones_mostrador c
            LEFT JOIN frases_cliente f ON f.conversacion_id = c.id WHERE c.conjunto = 'prueba'""").fetchone()
        if not conv:
            aviso = "no hay conversaciones de prueba (conjunto 'prueba' vacío); se salta."
        elif not prueba:
            aviso = (f"hay {conv} conversaciones y {frases} frases de prueba, pero ninguna tiene producto "
                     "esperado en stock; se salta.")
        else:
            aviso = ""

        consultas = Consultas(con, modelo, url, args.sin_cache_expansion)
        consultas.preparar([c["texto"] for c in casos + prueba] + [t for t, _ in ajenas])

        if args.barrido:
            barrido(con, consultas, base, casos, prueba, ajenas)
        else:
            buscar = buscar_fusion(con, consultas, base)
            reg = correr(casos, buscar)
            reg_p = correr(prueba, buscar)
            reg_a = correr([{"texto": t, "grupo": g, "esperados": set()} for t, g in ajenas], buscar)
            imprimir_tabla(modelo, base, reg, reg_p, reg_a, aviso)
            if args.fallos or args.fallos_grupo:
                imprimir_fallos(reg, reg_p, reg_a, nombres, args.fallos_grupo)

    consultas.guardar()
    print(f"Caché: {consultas.expansiones_sql} expansiones calculadas en la base, "
          f"{consultas.vectores_nuevos} vectores pedidos a Ollama.")


if __name__ == "__main__":
    main()
