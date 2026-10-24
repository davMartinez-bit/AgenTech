"""Worker de vectorización de AgenTech.

Lee la cola `productos_pendientes_embedding`, genera el embedding de cada
producto con un modelo servido por Ollama y lo guarda en `producto_embeddings`.

Uso (desde src/):
    python worker/vectorizar.py              # procesa la cola una vez y termina
    python worker/vectorizar.py --intervalo 60   # queda revisando la cola cada 60 s
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

# nomic-embed-text distingue documentos y consultas con un prefijo
PREFIJO_DOCUMENTO = "search_document: "


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
        if len(v) != dimensiones:
            raise ValueError(f"El modelo devolvió {len(v)} dimensiones; se esperaban {dimensiones}.")
    return vectores


def como_vector(v):
    return "[" + ",".join(f"{x:.7f}" for x in v) + "]"


def procesar_cola(con, modelo, url, lote):
    with con.cursor() as cur:
        cur.execute("SELECT id, dimensiones FROM modelos_embedding WHERE nombre = %s AND activo", (modelo,))
        fila = cur.fetchone()
        if fila is None:
            raise SystemExit(f"El modelo '{modelo}' no está registrado en modelos_embedding.")
        modelo_id, dimensiones = fila

        cur.execute("SELECT id, texto_fuente FROM productos_pendientes_embedding ORDER BY id")
        pendientes = cur.fetchall()

    total = len(pendientes)
    if total == 0:
        return 0
    print(f"{total} productos pendientes")

    for i in range(0, total, lote):
        grupo = pendientes[i:i + lote]
        vectores = embeddings([PREFIJO_DOCUMENTO + texto for _, texto in grupo], modelo, url, dimensiones)
        with con.cursor() as cur:
            cur.executemany(
                """
                INSERT INTO producto_embeddings (producto_id, modelo_id, texto_fuente, embedding, generado_en)
                VALUES (%s, %s, %s, %s::vector, now())
                ON CONFLICT (producto_id) DO UPDATE
                   SET modelo_id    = EXCLUDED.modelo_id,
                       texto_fuente = EXCLUDED.texto_fuente,
                       embedding    = EXCLUDED.embedding,
                       generado_en  = now()
                """,
                [(pid, modelo_id, texto, como_vector(v)) for (pid, texto), v in zip(grupo, vectores)],
            )
        con.commit()
        print(f"  {min(i + lote, total)}/{total}")
    return total


def main():
    cargar_env()
    parser = argparse.ArgumentParser(description="Vectoriza los productos pendientes.")
    parser.add_argument("--lote", type=int, default=32, help="productos por llamada al modelo")
    parser.add_argument("--intervalo", type=int, default=0,
                        help="segundos entre revisiones de la cola; 0 = procesar una vez y terminar")
    args = parser.parse_args()

    modelo = os.environ.get("EMBEDDING_MODEL", "nomic-embed-text")
    url = os.environ.get("OLLAMA_URL", "http://localhost:11434").rstrip("/")

    try:
        with conexion() as con:
            while True:
                procesados = procesar_cola(con, modelo, url, args.lote)
                if args.intervalo <= 0:
                    print(f"Listo: {procesados} productos vectorizados.")
                    break
                time.sleep(args.intervalo)
    except urllib.error.URLError as e:
        sys.exit(f"No se pudo conectar con Ollama en {url}: {e.reason}")


if __name__ == "__main__":
    main()
