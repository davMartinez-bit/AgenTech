"""Convierte el reporte de productos exportado desde Bsale (.xlsx) al CSV
que usa db/init/03_carga_catalogo.sql.

Uso:
    python db/scripts/exportar_catalogo.py ruta/al/reporte.xlsx
"""

import csv
import sys
from pathlib import Path

import pandas as pd

SALIDA = Path(__file__).resolve().parent.parent / "seed" / "catalogo_bsale.csv"

COLUMNAS = {
    "SKU": "sku",
    "Código de Barras": "codigo_barras",
    "Nombre del Producto": "nombre",
    "Tipo de Producto": "categoria",
    "Marca": "marca",
    "Unidad de medida": "unidad_medida",
    "¿Posible vender en cantidad decimal?": "permite_decimal",
    "Estado": "estado",
    "Fecha de creacion": "creado_en",
}


def si_no(valor):
    return "true" if str(valor).strip().lower() in ("si", "sí") else "false"


def main(ruta_xlsx):
    df = pd.read_excel(ruta_xlsx, dtype=str)
    df = df[list(COLUMNAS)].rename(columns=COLUMNAS)

    for col in df.columns:
        df[col] = df[col].str.strip()

    df["nombre"] = df["nombre"].str.replace(r"\s+", " ", regex=True)
    df["permite_decimal"] = df["permite_decimal"].map(si_no)
    df["activo"] = (df.pop("estado").str.lower() == "activo").map(str).str.lower()
    df["creado_en"] = pd.to_datetime(df["creado_en"], format="%Y/%m/%d %H:%M:%S")

    duplicados = df[df.duplicated("sku", keep=False)]
    if not duplicados.empty:
        sys.exit(f"Hay SKU repetidos en el reporte:\n{duplicados[['sku', 'nombre']]}")

    SALIDA.parent.mkdir(parents=True, exist_ok=True)
    df.to_csv(SALIDA, index=False, quoting=csv.QUOTE_MINIMAL, lineterminator="\n")
    print(f"{len(df)} productos exportados a {SALIDA}")


if __name__ == "__main__":
    if len(sys.argv) != 2:
        sys.exit(__doc__)
    main(sys.argv[1])
