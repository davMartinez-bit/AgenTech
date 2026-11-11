"""Sincroniza el catálogo y las ventas de Bsale con la base local de AgenTech.

Bsale se usa SOLO EN LECTURA: este script hace únicamente pedidos GET.

    python sincronizar_bsale.py catalogo   # precio (lista 4 con IVA) y stock disponible -> POST /ingesta
    python sincronizar_bsale.py ventas     # boletas, facturas y notas de crédito -> tablas ventas y venta_detalle
    python sincronizar_bsale.py recepciones  # entradas de mercadería a bodega -> tabla recepciones_stock
    python sincronizar_bsale.py todo

El token se lee de BSALE_ACCESS_TOKEN (src/.env o el archivo que indique --env). Nunca se imprime.
Con --desde DIR el catálogo se arma con los JSON ya descargados (por ejemplo, Mapeo Bsale/salida/datos)
en vez de llamar a la API.
"""

import argparse
import json
import os
import sys
import time
import urllib.error
import urllib.parse
import urllib.request
from datetime import date, datetime, timedelta, timezone
from pathlib import Path

import psycopg

SRC = Path(__file__).resolve().parents[2]
BASE_BSALE = "https://api.bsale.io/v1"
LISTA_PRECIOS = 4  # Lista de Precios Base (decisión D3 del e-commerce)
PAUSA = 0.15       # Bsale admite 8 pedidos por segundo


def cargar_env(archivo):
    if not archivo.exists():
        return
    for linea in archivo.read_text(encoding="utf-8").splitlines():
        linea = linea.strip()
        if not linea or linea.startswith("#") or "=" not in linea:
            continue
        clave, valor = linea.split("=", 1)
        os.environ.setdefault(clave.strip(), valor.strip().strip('"'))


def conexion():
    return psycopg.connect(
        host=os.environ.get("POSTGRES_HOST", "localhost"),
        port=int(os.environ.get("POSTGRES_PORT", "5432")),
        dbname=os.environ.get("POSTGRES_DB", "agentech"),
        user=os.environ.get("POSTGRES_USER", "agentech"),
        password=os.environ["POSTGRES_PASSWORD"],
    )


def get(ruta, params=None):
    token = os.environ.get("BSALE_ACCESS_TOKEN")
    if not token:
        sys.exit("Falta BSALE_ACCESS_TOKEN (agrégalo a src/.env o usa --env).")
    url = f"{BASE_BSALE}/{ruta}"
    if params:
        url += "?" + urllib.parse.urlencode(params)
    # PROHIBIDO modificar Bsale: el único método permitido es GET y no se envía cuerpo.
    pedido = urllib.request.Request(url, method="GET",
                                    headers={"access_token": token, "Accept": "application/json"})
    assert pedido.get_method() == "GET" and pedido.data is None
    for intento in range(4):
        try:
            with urllib.request.urlopen(pedido, timeout=60) as r:
                time.sleep(PAUSA)
                return json.loads(r.read())
        except urllib.error.HTTPError as e:
            if e.code in (429, 500, 502, 503) and intento < 3:
                time.sleep(2 * (intento + 1))
                continue
            raise


def todo_paginado(ruta, params=None):
    params = dict(params or {})
    params.setdefault("limit", 50)
    offset, items = 0, []
    while True:
        datos = get(ruta, {**params, "offset": offset})
        items.extend(datos.get("items", []))
        offset += params["limit"]
        print(f"  {ruta}: {len(items)}/{datos.get('count', '?')}", end="\r")
        if offset >= datos.get("count", 0):
            print()
            return items


def leer(desde, nombre, ruta):
    if desde:
        return json.loads((desde / nombre).read_text(encoding="utf-8"))
    return todo_paginado(ruta)


def ref(obj):
    return int(obj["id"]) if obj and obj.get("id") is not None else None


# ---------------------------------------------------------------- catálogo

def categoria(tipo):
    """Misma regla que 03_carga_catalogo.sql: "Sin Tipo" no es categoría y la inicial va en mayúscula."""
    if not tipo or tipo == "Sin Tipo":
        return None
    return tipo[0].upper() + tipo[1:]


def armar_catalogo(desde):
    variantes = leer(desde, "variants.json", "variants.json")
    productos = {p["id"]: p for p in leer(desde, "products.json", "products.json")}
    tipos = {t["id"]: t["name"] for t in leer(desde, "product_types.json", "product_types.json")}
    stocks = {}
    for s in leer(desde, "stocks.json", "stocks.json"):
        vid = ref(s["variant"])
        stocks[vid] = stocks.get(vid, 0) + float(s.get("quantityAvailable") or 0)
    precios = {ref(d["variant"]): float(d["variantValueWithTaxes"] or 0)
               for d in leer(desde, f"price_list_{LISTA_PRECIOS}_details.json",
                             f"price_lists/{LISTA_PRECIOS}/details.json")}

    catalogo = []
    for v in variantes:
        prod = productos.get(ref(v["product"]))
        if not prod or v.get("state") != 0 or prod.get("state") != 0 or not (v.get("code") or "").strip():
            continue
        nombre = prod["name"].strip()
        if v.get("description") and sum(1 for x in variantes if ref(x["product"]) == prod["id"]) > 1:
            nombre = f"{nombre} {v['description'].strip()}"
        catalogo.append({
            "sku": v["code"].strip(),
            "nombre": nombre,
            "precio": round(precios.get(v["id"], 0)),
            "stock": round(stocks.get(v["id"], 0), 3),
            "categoria": categoria(tipos.get(ref(prod.get("product_type")))),
            "permite_decimal": bool(prod.get("allowDecimal")),
            "bsale_variante_id": v["id"],
        })
    return catalogo


def sincronizar_catalogo(desde, api):
    print("Leyendo catálogo de Bsale" + (f" desde {desde}" if desde else " (API, solo GET)"))
    catalogo = armar_catalogo(desde)
    print(f"Enviando {len(catalogo)} productos a {api}/ingesta")
    cuerpo = json.dumps({"origen": "bsale-api", "productos": catalogo}).encode("utf-8")
    pedido = urllib.request.Request(f"{api}/ingesta", data=cuerpo, headers={"Content-Type": "application/json"})
    try:
        with urllib.request.urlopen(pedido, timeout=300) as r:
            resultado = json.loads(r.read())
    except urllib.error.HTTPError as e:
        resultado = json.loads(e.read())
    print(f"Ingesta {resultado.get('ingesta_id')}: {resultado.get('aceptados')} aceptados, "
          f"{resultado.get('rechazados')} rechazados")
    for err in resultado.get("errores", [])[:10]:
        print(f"  - fila {err['posicion']} ({err['sku']}): {err['motivo']}")
    return resultado.get("aceptados", 0)


# ---------------------------------------------------------------- ventas

def signo_documento(tipo):
    """+1 boletas, facturas y notas de débito; -1 notas de crédito; None lo que no es venta."""
    if tipo.get("isCreditNote"):
        return -1
    nombre = tipo["name"].upper()
    if tipo.get("isSalesNote") or "COTIZ" in nombre or "GU" in nombre[:3]:
        return None
    return 1


def sincronizar_ventas(con, meses):
    tipos = {t["id"]: t for t in todo_paginado("document_types.json")}
    hasta = datetime.now(timezone.utc)
    desde = hasta - timedelta(days=30 * meses)
    rango = f"[{int(desde.timestamp())},{int(hasta.timestamp())}]"
    print(f"Leyendo documentos de Bsale desde {desde.date()} (solo GET)")
    documentos = todo_paginado("documents.json", {"emissiondaterange": rango, "expand": "[details]", "state": 0})

    variantes = dict(con.execute(
        "SELECT bsale_variante_id, id FROM productos WHERE bsale_variante_id IS NOT NULL").fetchall())
    guardados = 0
    with con.cursor() as cur:
        for d in documentos:
            tipo = tipos.get(ref(d.get("document_type")))
            signo = signo_documento(tipo) if tipo else None
            if signo is None:
                continue
            emitido = datetime.fromtimestamp(d["emissionDate"], timezone.utc).date()
            cur.execute(
                """INSERT INTO ventas (id, tipo_documento, signo, numero, emitido_en, sucursal_id, neto, total)
                   VALUES (%s, %s, %s, %s, %s, %s, %s, %s)
                   ON CONFLICT (id) DO UPDATE SET neto = EXCLUDED.neto, total = EXCLUDED.total,
                                                  sincronizado_en = now()""",
                (d["id"], tipo["name"], signo, d.get("number"), emitido, ref(d.get("office")),
                 d.get("netAmount") or 0, d.get("totalAmount") or 0))
            cur.execute("DELETE FROM venta_detalle WHERE venta_id = %s", (d["id"],))
            items = (d.get("details") or {}).get("items") or []
            if len(items) < (d.get("details") or {}).get("count", 0):
                items = todo_paginado(f"documents/{d['id']}/details.json")
            for i, it in enumerate(items, start=1):
                vid = ref(it.get("variant"))
                cur.execute(
                    """INSERT INTO venta_detalle (venta_id, linea, bsale_variante_id, producto_id, cantidad, neto, total)
                       VALUES (%s, %s, %s, %s, %s, %s, %s)""",
                    (d["id"], it.get("lineNumber") or i, vid, variantes.get(vid), it.get("quantity") or 0,
                     it.get("netAmount") or 0, it.get("totalAmount") or 0))
            guardados += 1
    con.commit()
    print(f"{guardados} documentos de venta guardados ({len(documentos)} leídos)")
    return guardados


# ---------------------------------------------------------------- recepciones de stock

def sincronizar_recepciones(con):
    """Entradas de mercadería a bodega: dicen cuándo se compró cada producto por última vez."""
    print("Leyendo recepciones de stock de Bsale (solo GET)")
    recepciones = todo_paginado("stocks/receptions.json", {"expand": "[details]"})
    variantes = dict(con.execute(
        "SELECT bsale_variante_id, id FROM productos WHERE bsale_variante_id IS NOT NULL").fetchall())
    lineas = 0
    with con.cursor() as cur:
        for r in recepciones:
            if not r.get("admissionDate"):
                continue
            recibido = datetime.fromtimestamp(r["admissionDate"], timezone.utc).date()
            items = (r.get("details") or {}).get("items") or []
            if len(items) < (r.get("details") or {}).get("count", 0):
                items = todo_paginado(f"stocks/receptions/{r['id']}/details.json")
            for it in items:
                vid = ref(it.get("variant"))
                cur.execute(
                    """INSERT INTO recepciones_stock (id, recepcion_id, recibido_en, sucursal_id, bsale_variante_id,
                                                      producto_id, cantidad, costo)
                       VALUES (%s, %s, %s, %s, %s, %s, %s, %s)
                       ON CONFLICT (id) DO UPDATE SET recibido_en = EXCLUDED.recibido_en, cantidad = EXCLUDED.cantidad,
                                                      costo = EXCLUDED.costo, producto_id = EXCLUDED.producto_id,
                                                      sincronizado_en = now()""",
                    (it["id"], r["id"], recibido, ref(r.get("office")), vid, variantes.get(vid),
                     it.get("quantity") or 0, it.get("cost")))
                lineas += 1
    con.commit()
    print(f"{lineas} líneas de recepción guardadas ({len(recepciones)} recepciones leídas)")
    return lineas


def registrar(con, recurso, funcion):
    sid = con.execute("INSERT INTO sincronizaciones_bsale (recurso) VALUES (%s) RETURNING id", (recurso,)).fetchone()[0]
    con.commit()
    try:
        n = funcion()
        con.execute("UPDATE sincronizaciones_bsale SET estado = 'ok', registros = %s, terminado_en = now() WHERE id = %s",
                    (n, sid))
    except Exception as e:
        con.rollback()
        con.execute("UPDATE sincronizaciones_bsale SET estado = 'error', mensaje = %s, terminado_en = now() WHERE id = %s",
                    (str(e)[:500], sid))
        con.commit()
        raise
    con.commit()


def main():
    ap = argparse.ArgumentParser(description=__doc__, formatter_class=argparse.RawDescriptionHelpFormatter)
    ap.add_argument("que", choices=["catalogo", "ventas", "recepciones", "todo"])
    ap.add_argument("--env", type=Path, help="archivo .env adicional con BSALE_ACCESS_TOKEN")
    ap.add_argument("--desde", type=Path, help="carpeta con los JSON ya descargados de Bsale (solo catálogo)")
    ap.add_argument("--api", default=os.environ.get("AGENTECH_API", "http://localhost:3000"))
    ap.add_argument("--meses", type=int, default=12, help="meses de ventas a leer (por defecto 12)")
    args = ap.parse_args()

    cargar_env(SRC / ".env")
    if args.env:
        cargar_env(args.env)

    with conexion() as con:
        if args.que in ("catalogo", "todo"):
            registrar(con, "catalogo", lambda: sincronizar_catalogo(args.desde, args.api))
        if args.que in ("ventas", "todo"):
            registrar(con, "ventas", lambda: sincronizar_ventas(con, args.meses))
        if args.que in ("recepciones", "todo"):
            registrar(con, "recepciones", lambda: sincronizar_recepciones(con))


if __name__ == "__main__":
    main()
