"""Carga las conversaciones de mostrador (frases de cliente) desde un archivo JSONL.

Cada línea del archivo es una conversación:
    {"clave": "p09-001", "cliente": "...", "consultas": ["...", "...", "..."],
     "skus": ["SKU1", ...], "respuesta": "...", "tipo": "problema"}

El archivo es la fuente de verdad: las conversaciones simuladas de la base que ya no estén en él se
borran. Correrlo dos veces deja la misma base.

Uso (desde src/worker):
    PYTHONIOENCODING=utf-8 .venv/Scripts/python.exe cargar_conversaciones.py
    PYTHONIOENCODING=utf-8 .venv/Scripts/python.exe cargar_conversaciones.py --archivo ruta.jsonl
"""

import argparse
import hashlib
import json
import sys
from pathlib import Path

from vectorizar import cargar_env, conexion

ARCHIVO_POR_DEFECTO = Path(__file__).resolve().parent / "datos" / "conversaciones_mostrador.jsonl"
CAMPOS = ("clave", "cliente", "consultas", "skus", "respuesta", "tipo")

SQL_CONVERSACION = """
    INSERT INTO conversaciones_mostrador (clave, cliente, respuesta, tipo, origen, conjunto)
    VALUES (%s, %s, %s, %s, 'simulada', %s)
    ON CONFLICT (clave) DO UPDATE
       SET cliente   = EXCLUDED.cliente,
           respuesta = EXCLUDED.respuesta,
           tipo      = EXCLUDED.tipo,
           conjunto  = EXCLUDED.conjunto,
           origen    = 'simulada'
    RETURNING id
"""

SQL_FRASE = """
    INSERT INTO frases_cliente (conversacion_id, texto, clase)
    VALUES (%s, %s, %s)
    ON CONFLICT (conversacion_id, texto) DO NOTHING
"""


def conjunto_de(clave):
    """Reparto determinista: una de cada cinco conversaciones queda para prueba."""
    return "prueba" if int(hashlib.md5(clave.encode("utf-8")).hexdigest(), 16) % 5 == 0 else "indice"


def leer_archivo(ruta):
    conversaciones = []
    claves = set()
    with open(ruta, encoding="utf-8") as f:
        for n, linea in enumerate(f, start=1):
            linea = linea.strip()
            if not linea:
                continue
            try:
                c = json.loads(linea)
            except json.JSONDecodeError as e:
                raise SystemExit(f"Línea {n}: JSON inválido ({e}).")
            faltan = [campo for campo in CAMPOS if campo not in c]
            if faltan:
                raise SystemExit(f"Línea {n}: faltan campos {', '.join(faltan)}.")
            if not isinstance(c["consultas"], list) or not isinstance(c["skus"], list):
                raise SystemExit(f"Línea {n}: 'consultas' y 'skus' deben ser listas.")
            if c["clave"] in claves:
                raise SystemExit(f"Línea {n}: la clave '{c['clave']}' está repetida.")
            claves.add(c["clave"])
            conversaciones.append(c)
    return conversaciones


def cargar(con, conversaciones):
    resumen = {"cargadas": 0, "indice": 0, "prueba": 0, "descartadas": 0}
    desconocidos = set()
    vigentes = []

    with con.cursor() as cur:
        cur.execute("SELECT sku, id FROM productos")
        id_por_sku = dict(cur.fetchall())

    for c in conversaciones:
        clave = c["clave"]
        ids = []
        for sku in dict.fromkeys(c["skus"]):
            if sku in id_por_sku:
                ids.append(id_por_sku[sku])
            else:
                desconocidos.add(sku)
        if not ids:
            resumen["descartadas"] += 1
            continue

        conjunto = conjunto_de(clave)
        textos_cliente = [(texto, "consulta") for texto in c["consultas"]] + [(c["cliente"], "cliente")]
        try:
            with con.cursor() as cur:
                cur.execute(SQL_CONVERSACION, (clave, c["cliente"], c["respuesta"], c["tipo"], conjunto))
                conversacion_id = cur.fetchone()[0]
                cur.execute("DELETE FROM conversacion_productos WHERE conversacion_id = %s", (conversacion_id,))
                cur.executemany(
                    "INSERT INTO conversacion_productos (conversacion_id, producto_id) VALUES (%s, %s)",
                    [(conversacion_id, pid) for pid in ids],
                )
                cur.executemany(SQL_FRASE, [(conversacion_id, texto, clase) for texto, clase in textos_cliente])
                cur.execute(
                    "DELETE FROM frases_cliente WHERE conversacion_id = %s AND NOT (texto = ANY(%s::text[]))",
                    (conversacion_id, [texto for texto, _ in textos_cliente]),
                )
            con.commit()
        except Exception:
            con.rollback()
            raise

        vigentes.append(clave)
        resumen["cargadas"] += 1
        resumen[conjunto] += 1

    with con.cursor() as cur:
        cur.execute(
            "DELETE FROM conversaciones_mostrador WHERE origen = 'simulada' AND NOT (clave = ANY(%s::text[]))",
            (vigentes,),
        )
        resumen["borradas"] = cur.rowcount
        cur.execute("SELECT count(*) FROM frases_cliente")
        resumen["frases"] = cur.fetchone()[0]
    con.commit()

    resumen["desconocidos"] = sorted(desconocidos)
    return resumen


def main():
    cargar_env()
    parser = argparse.ArgumentParser(description="Carga las conversaciones de mostrador desde un JSONL.")
    parser.add_argument("--archivo", type=Path, default=ARCHIVO_POR_DEFECTO,
                        help="archivo JSONL con las conversaciones")
    args = parser.parse_args()

    if not args.archivo.exists():
        sys.exit(f"No existe el archivo {args.archivo}.")

    conversaciones = leer_archivo(args.archivo)
    with conexion() as con:
        r = cargar(con, conversaciones)

    print(f"Conversaciones cargadas: {r['cargadas']} (indice: {r['indice']}, prueba: {r['prueba']})")
    print(f"Frases totales en la base: {r['frases']}")
    print(f"SKU desconocidos: {len(r['desconocidos'])}"
          + (f" (ejemplos: {', '.join(r['desconocidos'][:10])})" if r["desconocidos"] else ""))
    print(f"Descartadas (sin ningún producto): {r['descartadas']}")
    print(f"Simuladas borradas (ya no están en el archivo): {r['borradas']}")


if __name__ == "__main__":
    main()
