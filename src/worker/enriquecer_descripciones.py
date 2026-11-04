"""Enriquece la descripción de cada producto con un modelo de lenguaje local (una sola vez, offline).

    python enriquecer_descripciones.py            # solo productos sin descripción
    python enriquecer_descripciones.py --limite 50

Es la única tarea en que AgenTech usa un modelo de lenguaje sobre el catálogo: escribir, a partir del
nombre y la categoría, para qué sirve el producto y cómo lo pide un cliente chileno. Así la búsqueda
semántica entiende "pa tapar goteras" o "tarugos pal concreto". No inventa precios, stock ni medidas:
esos datos vienen siempre de la base. Al cambiar la descripción, el trigger de productos lo deja
pendiente y vectorizar.py lo vuelve a vectorizar.
"""

import argparse
import json
import os
import time
import urllib.request

from vectorizar import cargar_env, conexion

LOTE = 10

SISTEMA = """Eres vendedor experto de una ferretería y tapicería en Chile.
Para cada producto recibes SKU, nombre y categoría. Escribe una descripción de 20 a 40 palabras con dos partes:
1) "Sirve para ..." : para qué se usa y en qué trabajos (casa, construcción, tapicería, muebles, electricidad, etc.).
2) "Se pide como: ..." : 3 a 6 formas en que un cliente chileno lo pediría (sinónimos y palabras coloquiales).
No inventes marcas, medidas, colores ni datos técnicos que no estén en el nombre.

Ejemplos:
- Silicona Tapagoteras 300 ml -> "Sirve para sellar goteras y filtraciones en techos, canaletas, ventanas y uniones expuestas a la lluvia. Se pide como: tapagoteras, sellador pa goteras, algo pa tapar filtraciones, silicona pal techo."
- Tarugo Paloma n°8 100 und -> "Sirve para fijar tornillos en muros de concreto, ladrillo o albañilería al colgar repisas, cuadros o soportes. Se pide como: tarugos, tacos, tarugos pal concreto, tarugos pa la pared."

Responde solo con un objeto JSON {"<sku>": "<descripción>", ...} con todos los SKU recibidos."""


def describir(lote, modelo, url):
    entrada = "\n".join(f"- SKU {sku}: {nombre} (categoría: {categoria or 'sin categoría'})"
                        for sku, nombre, categoria in lote)
    cuerpo = json.dumps({
        "model": modelo, "stream": False, "format": "json", "options": {"temperature": 0.2},
        "messages": [{"role": "system", "content": SISTEMA}, {"role": "user", "content": entrada}],
    }).encode("utf-8")
    pedido = urllib.request.Request(f"{url}/api/chat", data=cuerpo, headers={"Content-Type": "application/json"})
    with urllib.request.urlopen(pedido, timeout=600) as r:
        contenido = json.loads(r.read())["message"]["content"]
    datos = json.loads(contenido)
    skus = {sku for sku, _, _ in lote}
    return {sku: " ".join(str(texto).split())[:400] for sku, texto in datos.items() if sku in skus and str(texto).strip()}


def main():
    ap = argparse.ArgumentParser(description=__doc__, formatter_class=argparse.RawDescriptionHelpFormatter)
    ap.add_argument("--limite", type=int, default=0, help="máximo de productos (0 = todos los pendientes)")
    args = ap.parse_args()
    cargar_env()
    modelo = os.environ.get("ENRICH_MODEL") or os.environ.get("AGENT_MODEL", "qwen2.5:7b")
    url = os.environ.get("OLLAMA_URL", "http://127.0.0.1:11434").rstrip("/")

    with conexion() as con:
        pendientes = con.execute(
            """SELECT p.sku, p.nombre, c.nombre FROM productos p LEFT JOIN categorias c ON c.id = p.categoria_id
               WHERE p.activo AND (p.descripcion IS NULL OR p.descripcion = '') ORDER BY p.id""").fetchall()
        if args.limite:
            pendientes = pendientes[:args.limite]
        print(f"{len(pendientes)} productos sin descripción; modelo {modelo}")
        inicio, hechos = time.time(), 0
        for i in range(0, len(pendientes), LOTE):
            lote = pendientes[i:i + LOTE]
            try:
                descripciones = describir(lote, modelo, url)
            except Exception as e:
                print(f"  lote {i // LOTE + 1}: falló ({e}); se reintenta en la próxima corrida")
                continue
            con.cursor().executemany("UPDATE productos SET descripcion = %s WHERE sku = %s",
                                     [(d, sku) for sku, d in descripciones.items()])
            con.commit()
            hechos += len(descripciones)
            print(f"  {hechos}/{len(pendientes)} ({time.time() - inicio:.0f} s)", flush=True)
        print(f"Listo: {hechos} descripciones. Ahora corre vectorizar.py para actualizar los vectores.")


if __name__ == "__main__":
    main()
