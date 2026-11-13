"""Reescribe consultas largas en 2 a 6 palabras clave de producto, con un modelo de lenguaje local (Ollama).

Cuando el cliente cuenta un problema ("se me echó a perder la chapa de la reja") en vez de nombrar
el producto, esta reescritura transforma el texto en lo que se busca ("chapa cerradura candado").
Solo cambia el texto con que se busca: los productos, precios y stock siguen saliendo de la base.

    python reescribir_consulta.py "texto 1" "texto 2" ...

Imprime por cada texto los segundos que tardó, el texto original y la reescritura (o NADA si no
corresponde a algo que venda la ferretería). Si Ollama no responde, la búsqueda sigue sin reescritura.
"""

import argparse
import json
import os
import re
import time
import urllib.request
from pathlib import Path

from vectorizar import cargar_env

MIN_PALABRAS = 5          # desde cuántas palabras (ya sin relleno) una consulta se considera larga
MAX_PALABRAS_CLAVE = 6

PROMPT_SISTEMA = (
    "Eres el buscador de una ferretería y tapicería de barrio en Chile. El cliente cuenta un problema "
    "o para qué quiere algo, sin nombrar el producto. Responde SOLO con 2 a 6 palabras clave en minúsculas: "
    "el nombre genérico del producto o los productos que lo resuelven, como aparecen rotulados en una "
    "ferretería. Sin explicación, sin marcas, sin medidas inventadas, sin puntuación. "
    "Si el texto no trata de algo que venda una ferretería o tapicería, responde exactamente: NADA"
)
EJEMPLOS = [
    ("la puerta de entrada chirría cada vez que la abro", "aceite lubricante bisagra"),
    ("quiero pegar un espejo al muro del baño sin hacer hoyos", "silicona montaje adhesivo espejo"),
    ("se me quebró el vidrio de la mesa y quiero protegerme las manos al sacarlo", "guante seguridad"),
    ("necesito comprar un pasaje a Concepción para el viernes", "NADA"),
]

RUTA_CACHE = Path(__file__).resolve().parent / "resultados" / "reescrituras.json"

_QUITAR = str.maketrans("", "", "\"'`«»“”‘’.,:;*")


def es_larga(texto_expandido: str) -> bool:
    """Indica si la consulta tiene suficientes palabras para necesitar reescritura."""
    return len(texto_expandido.split()) >= MIN_PALABRAS


def limpiar(respuesta: str) -> str | None:
    """Deja solo las palabras clave de la respuesta del modelo. Devuelve None si no sirve."""
    lineas = [linea.strip() for linea in respuesta.splitlines() if linea.strip()]
    if not lineas:
        return None
    texto = re.sub(r"^[\s\-•]+", "", lineas[0].lower())  # quita guiones o viñetas de lista
    texto = " ".join(texto.translate(_QUITAR).split())
    palabras = texto.split()[:MAX_PALABRAS_CLAVE]
    resultado = " ".join(palabras)
    if not resultado or resultado == "nada":
        return None
    return resultado


def reescribir(texto: str, url: str, modelo: str, cache: dict | None = None) -> tuple[str | None, float]:
    """Devuelve (palabras clave o None, segundos que tardó).

    Si Ollama falla, devuelve (None, segundos) sin lanzar excepción para que la búsqueda siga funcionando.
    Con `cache`, reutiliza lo ya reescrito para el mismo modelo y texto.
    """
    clave = f"{modelo}|{texto}"
    if cache is not None and clave in cache:
        reescrito, segundos = cache[clave]
        return reescrito, segundos

    mensajes = [{"role": "system", "content": PROMPT_SISTEMA}]
    for entrada, salida in EJEMPLOS:
        mensajes.append({"role": "user", "content": entrada})
        mensajes.append({"role": "assistant", "content": salida})
    mensajes.append({"role": "user", "content": texto})
    cuerpo = json.dumps({
        "model": modelo, "messages": mensajes, "stream": False, "keep_alive": "10m",
        "options": {"temperature": 0, "num_predict": 24},
    }).encode("utf-8")

    inicio = time.time()
    try:
        pedido = urllib.request.Request(f"{url}/api/chat", data=cuerpo, headers={"Content-Type": "application/json"})
        with urllib.request.urlopen(pedido, timeout=60) as r:
            contenido = json.loads(r.read())["message"]["content"]
    except Exception:
        return None, time.time() - inicio

    segundos = time.time() - inicio
    reescrito = limpiar(contenido)
    if cache is not None:
        cache[clave] = [reescrito, segundos]
    return reescrito, segundos


def cargar_cache(ruta) -> dict:
    """Lee la caché de reescrituras. Si el archivo no existe, devuelve un diccionario vacío."""
    ruta = Path(ruta)
    if not ruta.exists():
        return {}
    return json.loads(ruta.read_text(encoding="utf-8"))


def guardar_cache(ruta, cache: dict) -> None:
    """Guarda la caché de reescrituras en JSON UTF-8, ordenada para que los cambios se vean en git."""
    ruta = Path(ruta)
    ruta.parent.mkdir(parents=True, exist_ok=True)
    ruta.write_text(json.dumps(cache, ensure_ascii=False, indent=1, sort_keys=True), encoding="utf-8")


def main():
    ap = argparse.ArgumentParser(description=__doc__, formatter_class=argparse.RawDescriptionHelpFormatter)
    ap.add_argument("textos", nargs="+", help="consultas a reescribir")
    args = ap.parse_args()
    cargar_env()
    modelo = os.environ.get("AGENT_MODEL", "qwen2.5:7b")
    url = os.environ.get("OLLAMA_URL", "http://127.0.0.1:11434").rstrip("/")
    for texto in args.textos:
        reescrito, segundos = reescribir(texto, url, modelo)
        print(f"{segundos:.1f} | {texto} -> {reescrito or 'NADA'}")


if __name__ == "__main__":
    main()
