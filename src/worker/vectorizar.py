"""Worker de vectorización de AgenTech.

Vectoriza dos colas con un modelo servido por Ollama:
    - `productos_pendientes_embedding` -> `producto_embeddings` (prefijo de documento).
    - `frases_pendientes_embedding` -> `frase_embeddings` (prefijo de consulta).

Uso (desde src/):
    python worker/vectorizar.py              # procesa productos y frases una vez y termina
    python worker/vectorizar.py --intervalo 60   # queda revisando las colas cada 60 s
    python worker/vectorizar.py --solo frases    # solo las frases
    python worker/vectorizar.py --todo --solo frases   # revectoriza todas las frases
"""

import argparse
import json
import os
import sys
import time
import urllib.error
import urllib.request
from pathlib import Path

import psycopg

SRC = Path(__file__).resolve().parent.parent

# Algunos modelos distinguen documentos y consultas con un prefijo.
# Deben coincidir con prefijoConsulta() en src/api/src/ollama.ts.
PREFIJOS_DOCUMENTO = {
    "nomic-embed-text": "search_document: ",
    "nomic-embed-text-v2-moe": "search_document: ",
}
PREFIJOS_CONSULTA = {
    "nomic-embed-text": "search_query: ",
    "nomic-embed-text-v2-moe": "search_query: ",
}


def prefijo_documento(modelo):
    base = modelo.split(":")[0]
    if "e5" in base:
        return "passage: "
    return PREFIJOS_DOCUMENTO.get(base, "")


def prefijo_consulta(modelo):
    base = modelo.split(":")[0]
    if "e5" in base:
        return "query: "
    return PREFIJOS_CONSULTA.get(base, "")


def cargar_env():
    """Lee src/.env sin pisar variables ya definidas en el entorno."""
    archivo = SRC / ".env"
    if not archivo.exists():
        return
    for linea in archivo.read_text(encoding="utf-8").splitlines():
        linea = linea.strip()
        if not linea or linea.startswith("#") or "=" not in linea:
            continue
        clave, valor = linea.split("=", 1)
        os.environ.setdefault(clave.strip(), valor.strip())


def conexion():
    return psycopg.connect(
        host=os.environ.get("POSTGRES_HOST", "localhost"),
        port=int(os.environ.get("POSTGRES_PORT", "5432")),
        dbname=os.environ.get("POSTGRES_DB", "agentech"),
        user=os.environ.get("POSTGRES_USER", "agentech"),
        password=os.environ["POSTGRES_PASSWORD"],
    )


def embeddings(textos, modelo, url, dimensiones):
    cuerpo = json.dumps({"model": modelo, "input": textos}).encode("utf-8")
    pedido = urllib.request.Request(f"{url}/api/embed", data=cuerpo,
                                    headers={"Content-Type": "application/json"})
    with urllib.request.urlopen(pedido, timeout=600) as respuesta:
        vectores = json.loads(respuesta.read())["embeddings"]
    for v in vectores:
        if dimensiones and len(v) != dimensiones:
            raise ValueError(f"El modelo devolvió {len(v)} dimensiones; se esperaban {dimensiones}.")
    return vectores


def como_vector(v):
    return "[" + ",".join(f"{x:.7f}" for x in v) + "]"


def datos_modelo(cur, modelo):
    cur.execute("SELECT id, dimensiones FROM modelos_embedding WHERE nombre = %s AND activo", (modelo,))
    fila = cur.fetchone()
    if fila is None:
        raise SystemExit(f"El modelo '{modelo}' no está registrado en modelos_embedding.")
    return fila


def tabla_disponible(con, nombre):
    with con.cursor() as cur:
        cur.execute("SELECT to_regclass(%s) IS NOT NULL", (nombre,))
        return cur.fetchone()[0]


def generar_vectores(con, pendientes, modelo_id, dimensiones, modelo, url, lote, prefijo, sql, etiqueta):
    """Vectoriza `pendientes` (lista de (id, texto)) por lotes y guarda cada lote con `sql`."""
    total = len(pendientes)
    if total == 0:
        return 0
    print(f"{total} {etiqueta} pendientes")

    for i in range(0, total, lote):
        grupo = pendientes[i:i + lote]
        vectores = embeddings([prefijo + texto for _, texto in grupo], modelo, url, dimensiones)
        with con.cursor() as cur:
            cur.executemany(sql, [(id_, modelo_id, texto, como_vector(v))
                                  for (id_, texto), v in zip(grupo, vectores)])
        con.commit()
        print(f"  {min(i + lote, total)}/{total}")
    return total


SQL_PRODUCTOS = """
    INSERT INTO producto_embeddings (producto_id, modelo_id, texto_fuente, embedding, generado_en)
    VALUES (%s, %s, %s, %s::vector, now())
    ON CONFLICT (producto_id) DO UPDATE
       SET modelo_id    = EXCLUDED.modelo_id,
           texto_fuente = EXCLUDED.texto_fuente,
           embedding    = EXCLUDED.embedding,
           generado_en  = now()
"""

SQL_FRASES = """
    INSERT INTO frase_embeddings (frase_id, modelo_id, texto_fuente, embedding, generado_en)
    VALUES (%s, %s, %s, %s::vector, now())
    ON CONFLICT (frase_id) DO UPDATE
       SET modelo_id    = EXCLUDED.modelo_id,
           texto_fuente = EXCLUDED.texto_fuente,
           embedding    = EXCLUDED.embedding,
           generado_en  = now()
"""


def procesar_productos(con, modelo, url, lote):
    with con.cursor() as cur:
        modelo_id, dimensiones = datos_modelo(cur, modelo)
        cur.execute("SELECT id, texto_fuente FROM productos_pendientes_embedding ORDER BY id")
        pendientes = cur.fetchall()
    return generar_vectores(con, pendientes, modelo_id, dimensiones, modelo, url, lote,
                            prefijo_documento(modelo), SQL_PRODUCTOS, "productos")


def procesar_frases(con, modelo, url, lote):
    with con.cursor() as cur:
        modelo_id, dimensiones = datos_modelo(cur, modelo)
        cur.execute("SELECT frase_id, texto FROM frases_pendientes_embedding ORDER BY frase_id")
        pendientes = cur.fetchall()
    return generar_vectores(con, pendientes, modelo_id, dimensiones, modelo, url, lote,
                            prefijo_consulta(modelo), SQL_FRASES, "frases")


def marcar_viejos(con, procesar):
    """Con --todo: marca los vectores existentes como viejos. Siguen en la búsqueda hasta que se reemplazan."""
    with con.cursor() as cur:
        if "productos" in procesar:
            cur.execute("UPDATE producto_embeddings SET generado_en = 'epoch'")
            print(f"Marcados como viejos {cur.rowcount} vectores de productos.")
        if "frases" in procesar:
            cur.execute("UPDATE frase_embeddings SET generado_en = 'epoch'")
            print(f"Marcados como viejos {cur.rowcount} vectores de frases.")
    con.commit()


def main():
    cargar_env()
    parser = argparse.ArgumentParser(description="Vectoriza los productos y las frases pendientes.")
    parser.add_argument("--lote", type=int, default=32, help="textos por llamada al modelo")
    parser.add_argument("--intervalo", type=int, default=0,
                        help="segundos entre revisiones de las colas; 0 = procesar una vez y terminar")
    parser.add_argument("--solo", choices=["productos", "frases"],
                        help="procesa solo una de las dos colas (por defecto, las dos)")
    parser.add_argument("--todo", action="store_true",
                        help="revectoriza todo aunque no esté pendiente (marca los vectores existentes como viejos)")
    args = parser.parse_args()

    modelo = os.environ.get("EMBEDDING_MODEL", "nomic-embed-text-v2-moe")
    url = os.environ.get("OLLAMA_URL", "http://127.0.0.1:11434").rstrip("/")

    try:
        with conexion() as con:
            procesar = ["productos", "frases"] if args.solo is None else [args.solo]
            if "frases" in procesar and not (tabla_disponible(con, "frases_pendientes_embedding")
                                             and tabla_disponible(con, "frase_embeddings")):
                print("Aviso: falta frases_pendientes_embedding (aplica 15_frases_cliente.sql); se omiten las frases.")
                procesar.remove("frases")

            if args.todo:
                marcar_viejos(con, procesar)

            while True:
                n_productos = procesar_productos(con, modelo, url, args.lote) if "productos" in procesar else 0
                n_frases = procesar_frases(con, modelo, url, args.lote) if "frases" in procesar else 0
                if args.intervalo <= 0:
                    if n_productos == 0 and n_frases == 0:
                        print("No hay nada pendiente.")
                    partes = []
                    if "productos" in procesar:
                        partes.append(f"{n_productos} productos")
                    if "frases" in procesar:
                        partes.append(f"{n_frases} frases")
                    print(f"Listo: {' y '.join(partes) or 'nada que hacer'} vectorizados.")
                    break
                time.sleep(args.intervalo)
    except urllib.error.URLError as e:
        sys.exit(f"No se pudo conectar con Ollama en {url}: {e.reason}")


if __name__ == "__main__":
    main()
