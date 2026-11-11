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
    # --- Ampliación del 10-11-2026. La descripción empieza con el grupo ("Grupo: detalle") y
    # evaluar_busqueda.py informa cada grupo por separado.
    # Otro nombre: el cliente usa una palabra que no está en el nombre del producto.
    ("huincha aislante", "Otro nombre: cinta aisladora", "cinta aisladora"),
    ("cinta aislante negra", "Otro nombre: cinta aisladora", "cinta aisladora"),
    ("scotch pa embalar cajas", "Otro nombre: cinta de embalaje", "cinta embalaje"),
    ("huincha de papel pa pintar", "Otro nombre: cinta masking", "masking"),
    ("metro pa medir", "Otro nombre: huincha de medir", "huincha medir"),
    ("cola fria pa madera", "Otro nombre: colafría", "colafria"),
    ("neopren", "Otro nombre: adhesivo de contacto", "(afix|didepren|pegamac|contact)"),
    ("galletera", "Otro nombre: esmeril angular", "esmeril angular"),
    ("disco pa la galletera", "Otro nombre: discos de esmeril", "disco (corte|desbaste|diamantado|traslape)"),
    ("tiner", "Otro nombre: diluyente", "diluyente"),
    ("tip top", "Otro nombre: cuchillo cartonero", "(cuchillo cartonero|hoja cuchillo)"),
    ("grapas para la engrapadora", "Otro nombre: corchetes", "corchete "),
    ("grapadora", "Otro nombre: engrapadora", "(engrapadora|corchetera)"),
    ("ecocuero", "Otro nombre: cuerina", "(cuerina|^pu )"),
    ("wata pa rellenar", "Otro nombre: napa", "(napa|algodon sintetico)"),
    ("destornillador de cruz", "Otro nombre: atornillador", "(atornillador|destornillador|punta philips)"),
    ("arandelas", "Otro nombre: golillas", "golilla"),
    ("pestillo pa la puerta", "Otro nombre: picaporte", "picaporte"),
    ("amarracables", "Otro nombre: amarra plástica", "amarra plastica"),
    ("bombilla led", "Otro nombre: ampolleta", "(ampolleta|foco led)"),
    ("pitilla", "Otro nombre: cordel", "cordel"),
    ("tornillos pa volcanita", "Otro nombre: tornillo drywall", "drywall"),
    ("tachuelas", "Otro nombre: tachas", "tacha "),
    ("cierre eclair", "Otro nombre: cierre", "^cierre"),
    ("sellador pal techo", "Otro nombre: tapagoteras", "tapagotera"),
    # Mal escrito: errores de tipeo y de ortografía.
    ("wincha aislante", "Mal escrito: cinta aisladora", "cinta aisladora"),
    ("tornilo drywal", "Mal escrito: tornillo drywall", "drywall"),
    ("bizagra", "Mal escrito: bisagra", "bisagra"),
    ("teflom", "Mal escrito: teflón", "teflon"),
    ("silicon tapa goteras", "Mal escrito: silicona tapagoteras", "tapagotera"),
    ("anticorosivo negro", "Mal escrito: anticorrosivo", "anticorrosivo"),
    ("espuma pa cogines", "Mal escrito: espuma para cojines", "espuma"),
    ("llabe allen", "Mal escrito: llave allen", "llave allen"),
    ("taruguos", "Mal escrito: tarugos", "tarugo"),
    ("corchetes 8mm", "Mal escrito: corchete 8", "corchete "),
    # Nombre exacto: el vendedor escribe el nombre técnico.
    ("tornillo roscalata 10x1", "Nombre exacto: tornillo roscalata", "roscalata 10x1"),
    ("felpa gris perla", "Nombre exacto: felpa gris perla", "felpa gris perla"),
    ("lino caburgua crudo", "Nombre exacto: lino caburgua crudo", "lino cabur.*crudo"),
    ("broca sds", "Nombre exacto: broca SDS", "broca sds"),
    ("soldadura 6011", "Nombre exacto: soldadura 6011", "soldadura 6011"),
    ("pata cama plastica", "Nombre exacto: pata cama plástica", "pata cama plastica"),
    ("teflon gas", "Nombre exacto: teflón gas", "teflon gas"),
    # Por uso: el cliente describe para qué lo quiere.
    ("algo pa tapar goteras en techo de zinc", "Por uso: tapagoteras", "tapagotera"),
    ("pintura pa reja que no se oxide", "Por uso: anticorrosivo", "anticorrosivo"),
    ("para colgar un cuadro en la pared", "Por uso: colgar un cuadro", "(tarugo|gancho colgar|clavo)"),
    ("con que saco el oxido", "Por uso: desoxidante", "desoxidante"),
    ("pa que no se resbale la pata de la silla", "Por uso: regatones y patines", "(regaton|patin|tope)"),
    ("para sellar la tina del baño", "Por uso: silicona", "silicona"),
    ("pa soldar cables", "Por uso: cautín y soldadura", "(cautin|soldadura electronica)"),
    ("tela pa que no entren los mosquitos", "Por uso: malla mosquitera", "malla mosquito"),
    ("pa cortar tela gruesa", "Por uso: tijeras", "tijera"),
    ("relleno pa cojin", "Por uso: rellenos", "(espuma|napa|algodon|molido)"),
    ("pa nivelar la ceramica del piso", "Por uso: separadores y cuñas", "(separador|cuña|cuna)"),
    ("pegamento pa tubos de pvc", "Por uso: adhesivo PVC", "adhesivo pvc"),
]

# Validación a ciegas (T30): consultas escritas sin ver el diccionario de sinónimos ni los casos de arriba.
# Cada una espera un producto puntual (con su medida o color), así que es más exigente que CASOS.
CASOS_VALIDACION = [
    ("bombillo led de 15 watts", "Validación a ciegas: otro nombre", "ampolleta led 15 w"),
    ("cola fria de 20 kilos pa madera", "Validación a ciegas: otro nombre", "colafria madera rapida 20"),
    ("rollo de cinta de embalar cafe", "Validación a ciegas: otro nombre", "cinta embalaje cafe"),
    ("cinta teflon pa gas", "Validación a ciegas: otro nombre", "teflon gas"),
    ("pinza universal de 6 pulgadas", "Validación a ciegas: otro nombre", "alicate 6 pulg universal"),
    ("desarmador de paleta 1/4 x 6", "Validación a ciegas: otro nombre", "atornillador plano 1/4x6"),
    ("cuchilla de repuesto pa cartonero", "Validación a ciegas: otro nombre", "^hoja cuchillo cartonero"),
    ("flexometro de 5 metros", "Validación a ciegas: otro nombre", "huincha medir 5 mts"),
    ("pegamento de contacto de 1 galon", "Validación a ciegas: otro nombre", "afix super contact 1 gl"),
    ("pegamento pa tubos pvc de 240", "Validación a ciegas: otro nombre", "adhesivo pvc 240"),
    ("espuma expansiva de 750 ml", "Validación a ciegas: otro nombre", "espuma poliuretano 750"),
    ("varsol de 5 litros", "Validación a ciegas: otro nombre", "^aguarras 5 litros"),
    ("algo pa sellar la tina que gotea", "Validación a ciegas: por uso", "silicona tapagoteras"),
    ("algo pa que la silla no raye el piso, negro", "Validación a ciegas: por uso", "patin base negro"),
    ("algo pa tapar los tornillos del mueble, negros", "Validación a ciegas: por uso", "tapa soberbio grande negro"),
    ("algo pa lijar las patas de la silla a mano", "Validación a ciegas: por uso", "soporte lijador\\s+7"),
    ("algo pa pegar el parche de la bici", "Validación a ciegas: por uso", "^pegamento parche bicicleta"),
    ("algo pa tapar hoyos en la madera color encina", "Validación a ciegas: por uso", "masilla retape encina"),
    ("algo pa perforar el concreto de 10 mm", "Validación a ciegas: por uso", "broca concreto 10 mm"),
    ("algo pa limpiar el oxido del fierro", "Validación a ciegas: por uso", "^desoxidante 1 litro"),
    ("algo pa cortar fierro de 7 pulgadas", "Validación a ciegas: por uso", "disco corte 7x3"),
    ("algo pa cargar el hornillo de camping", "Validación a ciegas: por uso", "gas butano cocinilla"),
    ("pila duracel aa", "Validación a ciegas: mal escrito", "^pila duracell aa\\s*$"),
    ("tornillo drywal 6x1 1/4", "Validación a ciegas: mal escrito", "tornillo drywall 6x1 1/4"),
    ("guantes negro pu", "Validación a ciegas: mal escrito", "^guante negro pu\\s*$"),
    ("cueina PU negro", "Validación a ciegas: mal escrito", "cuerina pu negro"),
    ("bisajra semicurva 35 mm cierre suabe", "Validación a ciegas: mal escrito", "bisagra semicurva 35 mm cierre suave"),
    ("yave punta corona 9mm", "Validación a ciegas: mal escrito", "llave punta corona 9 mm"),
    ("espatula trupper plastika 4 pulgada", "Validación a ciegas: mal escrito", "espatula truper plastica 4 pulg"),
    ("silikona asetica transparente", "Validación a ciegas: mal escrito", "silicona acetica c/fungicida transparente"),
    ("hola buenas, tiene pila duracell AAA porfa", "Validación a ciegas: con relleno", "pila duracell aaa"),
    ("oiga maestro, me da un tubo conduit de 25 mm pa la luz porfa", "Validación a ciegas: con relleno", "tubo conduit 25 mm"),
    ("buenas tardes, la cuestion esa pa perforar el hormigon de 6 mm, la broca de concreto?", "Validación a ciegas: con relleno", "broca concreto 6 mm"),
    ("hola buenas, tienen el limpia contacto? porfa", "Validación a ciegas: con relleno", "^limpia contacto\\s*$"),
    ("hola, me das 1 kilo de soldadura 6013 porfa", "Validación a ciegas: con relleno", "soldadura 6013"),
    ("la cuestion esa pa la puerta, un tirador concha negro porfa", "Validación a ciegas: con relleno", "tirador concha negro"),
    ("buenas, oiga maestro, tiene cinta aisladora negra de 20 metros?", "Validación a ciegas: con relleno", "cinta aisladora negra 20"),
    ("hola buenas, tiene la pata L negra de 13 cm pa la mesa porfa", "Validación a ciegas: con relleno", "pata l negro 13 cm"),
    ("tornillito roscalata 8x1", "Validación a ciegas: diminutivo o plural", "^tornillo roscalata 8x1\\s*$"),
    ("brochitas de 2 pulgadas", "Validación a ciegas: diminutivo o plural", "^brocha 2 pulg\\s*$"),
    ("tarugitos de 6 mm", "Validación a ciegas: diminutivo o plural", "^tarugo 6 mm\\s*$"),
    ("candaditos de fibra de 40", "Validación a ciegas: diminutivo o plural", "candado fibra 40"),
    ("ruedecitas giratorias de 2 pulgadas", "Validación a ciegas: diminutivo o plural", "rueda giratoria 2 pulg"),
    ("pilitas eveready AA", "Validación a ciegas: diminutivo o plural", "^pila eveready aa\\s*$"),
    ("clavitos corrientes de 2", "Validación a ciegas: diminutivo o plural", "^clavo corriente 2\\s*$"),
]

# Segunda validación a ciegas (T31): escrita después de corregir las descripciones, sin verlas ni ver
# el diccionario. Casi todas son por uso: el cliente describe el problema sin nombrar el producto.
CASOS_VALIDACION_2 = [
    ("se me abrió la puerta del mueble que sube hacia arriba, quiero algo que la sostenga", "Validación a ciegas 2: por uso", "^piston gas"),
    ("pa que el mueble no raye el piso cuando lo muevo", "Validación a ciegas 2: por uso", "^patin (base|clavo|nylon)"),
    ("se me trabó la gaveta del escritorio, qué le pongo pa que corra bien", "Validación a ciegas 2: por uso", "^riel\\b"),
    ("la mesa me cojea porque el piso es chueco, cómo la nivelo", "Validación a ciegas 2: por uso", "^patin regulable"),
    ("pa cerrar con llave la gaveta del velador", "Validación a ciegas 2: por uso", "^(chapa|cerradura) cajon"),
    ("quiero poner un estante flotando en la pared, con qué lo afirmo", "Validación a ciegas 2: por uso", "^(soporte|escuadra) repisa"),
    ("tengo una silla de madera vieja, con qué le doy color pa que quede como nueva", "Validación a ciegas 2: por uso", "^(barniz|tinta kromatin)"),
    ("se me despegó la suela del zapato, con qué la pego", "Validación a ciegas 2: por uso", "^(pegamac|afix super contact)"),
    ("el techo me gotea cuando llueve, con qué lo tapo", "Validación a ciegas 2: por uso", "^silicona tapagoteras"),
    ("necesito algo pa soldar cañería de cobre con llama", "Validación a ciegas 2: por uso", "^gas butano soplete"),
    ("tengo un agujero en la pared de la pieza, con qué lo relleno antes de pintar", "Validación a ciegas 2: por uso", "^(pasta muro|masilla sherwim)"),
    ("el fierro se me oxidó, qué le paso antes de pintar", "Validación a ciegas 2: por uso", "^(anticorrosivo|desoxidante)"),
    ("el desagüe de la cocina está tapado, qué le echo", "Validación a ciegas 2: por uso", "^soda caustica"),
    ("pa colgar un cuadro en el muro de ladrillo, qué compro", "Validación a ciegas 2: por uso", "^(tarugo \\d+ mm|clavo hilti)"),
    ("la hoja pega contra la muralla cuando se abre, qué pongo pa que no golpee", "Validación a ciegas 2: por uso", "^tope de puerta"),
    ("pa la ventana que no pasen los zancudos", "Validación a ciegas 2: por uso", "^malla mosquito"),
    ("pa amarrar las ramas del árbol del patio", "Validación a ciegas 2: por uso", "^cordel"),
    ("se me rompió el zipper del bolso, tienen para cambiarlo", "Validación a ciegas 2: por uso", "^cierre"),
    ("quiero rellenar unos cojines pa la terraza, qué compro", "Validación a ciegas 2: por uso", "^(espuma (densidad|\\d)|algodon sintetico|molido espuma)"),
    ("quiero forrar de nuevo el sillón, qué género compro", "Validación a ciegas 2: por uso", "^(felpa|chenille|lino|cuerina|pu |napa|gabana)"),
    ("quiero cubrir la cabeza de los tornillos del mueble pa que se vean bonitos", "Validación a ciegas 2: por uso", "^tapa soberbio"),
    ("quiero colgar las camisas en el ropero", "Validación a ciegas 2: por uso", "^barra closet"),
    ("me pasas una cinta métrica de 5 metros", "Validación a ciegas 2: otro nombre", "^huincha medir 5"),
    ("tenes una llave stillson pa cañerías", "Validación a ciegas 2: otro nombre", "^llave gasfiter"),
    ("una lamparita led de 13 watts", "Validación a ciegas 2: otro nombre", "^ampolleta led 13 w"),
    ("tacos fischer pa ladrillo", "Validación a ciegas 2: otro nombre", "^tarugo (\\d+ mm|clavo|autoroscante)"),
    ("un desarmador normal pa la casa", "Validación a ciegas 2: otro nombre", "^(atornillador|destornillador)"),
    ("una pinza de 6 pulgadas pa pelar cables", "Validación a ciegas 2: otro nombre", "^alicate"),
    ("un cable mellizo pa la lámpara del living", "Validación a ciegas 2: otro nombre", "^cable paralelo"),
    ("una ficha de 10 amperes pa el artefacto", "Validación a ciegas 2: otro nombre", "^enchufe macho"),
    ("un thinner pa limpiar la pistola de pintar", "Validación a ciegas 2: otro nombre", "^diluyente"),
    ("un pegamento de contacto pa zapatos", "Validación a ciegas 2: otro nombre", "^(pegamac|afix super contact)"),
    ("oiga jefe tendra un cierre pa la chaqueta po", "Validación a ciegas 2: con relleno", "^cierre"),
    ("wena maestro, ando buskando juego de brocas pa madera po", "Validación a ciegas 2: con relleno", "^(juego brocas madera|set broca madera)"),
    ("buenas tardes, tiene pilas duracel AA pa el control? gracias", "Validación a ciegas 2: con relleno", "^pila (duracell|eveready) aa\\b"),
    ("oye wena, tenis un tubo conduit 20 mm de 3 metros?", "Validación a ciegas 2: con relleno", "^tubo conduit 20"),
    ("hola jefe, nesesito tornillo drywall 6x1 1/4 pa la placa porfa", "Validación a ciegas 2: con relleno", "^tornillo drywall 6x1 1/4"),
    ("oiga, cuanto sale la silicona acetica transparente? ando haciendo una ventana po", "Validación a ciegas 2: con relleno", "^silicona acetica .*transparente"),
    ("buena jefe, tiene lija de agua 240 pa la pintura po? ando buscando", "Validación a ciegas 2: con relleno", "^lija pliego al agua g240"),
    ("wena cabros, tendran cinta embalaje transparente pa la mudanza po", "Validación a ciegas 2: con relleno", "^cinta embalaje transparente"),
]


def sin_tildes(t):
    return "".join(c for c in unicodedata.normalize("NFD", t) if unicodedata.category(c) != "Mn")


def cargar_casos(con):
    productos = con.execute("SELECT id, nombre FROM productos WHERE activo").fetchall()
    with con.cursor() as cur:
        for consulta, descripcion, regex in CASOS + CASOS_VALIDACION + CASOS_VALIDACION_2:
            cur.execute(
                """INSERT INTO casos_prueba (consulta, descripcion) VALUES (%s, %s)
                   ON CONFLICT (consulta) DO UPDATE SET descripcion = EXCLUDED.descripcion RETURNING id""",
                (consulta, descripcion))
            caso_id = cur.fetchone()[0]
            cur.execute("DELETE FROM casos_prueba_esperados WHERE caso_id = %s", (caso_id,))
            patron = re.compile(regex, re.IGNORECASE)
            esperados = [pid for pid, nombre in productos if patron.search(" ".join(sin_tildes(nombre).split()))]
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
