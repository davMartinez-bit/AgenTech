# Evaluación de la búsqueda (2026-11-11)

Modelo `nomic-embed-text-v2-moe`, 169 consultas con productos esperados en stock, top 5.
Cada celda: acierto@5 / MRR.

| Variante | Total (169) | Mal escrito (10) | Nombre exacto (7) | Original (30) | Otro nombre (25) | Por uso (12) | Validación a ciegas (45) | Validación a ciegas 2 (40) | SQL p50 (ms) |
|---|---|---|---|---|---|---|---|---|---|
| Híbrida, peso del texto 0.0 | 0.91 / 0.84 | 1.00 / 1.00 | 1.00 / 1.00 | 1.00 / 0.96 | 0.84 / 0.75 | 1.00 / 0.90 | 0.98 / 0.90 | 0.75 / 0.66 | 20 |
| Híbrida, peso del texto 0.15 | 0.89 / 0.82 | 1.00 / 1.00 | 1.00 / 1.00 | 1.00 / 0.96 | 0.80 / 0.73 | 1.00 / 0.86 | 0.98 / 0.90 | 0.70 / 0.60 | 19 |
| Híbrida, peso del texto 0.35 | 0.86 / 0.78 | 1.00 / 1.00 | 1.00 / 1.00 | 1.00 / 0.96 | 0.68 / 0.57 | 0.92 / 0.67 | 0.98 / 0.91 | 0.68 / 0.56 | 20 |
| Fusión con sinónimos | 0.95 / 0.92 | 1.00 / 1.00 | 1.00 / 1.00 | 1.00 / 1.00 | 1.00 / 0.97 | 1.00 / 0.84 | 0.98 / 0.92 | 0.82 / 0.80 | 24 |

Precisión@5 total: Híbrida, peso del texto 0.0: 0.449; Híbrida, peso del texto 0.15: 0.440; Híbrida, peso del texto 0.35: 0.400; Fusión con sinónimos: 0.495

Consultas ajenas que vuelven vacías (de 8): Híbrida, peso 0.15 y umbral 0.32: 8; Fusión con sinónimos: 8

Fallan con «Híbrida, peso del texto 0.15» (18): metro pa medir; galletera; tiner; arandelas; pitilla; algo pa lijar las patas de la silla a mano; se me trabó la gaveta del escritorio, qué le pongo pa que corra bien; pa cerrar con llave la gaveta del velador; quiero poner un estante flotando en la pared, con qué lo afirmo; tengo una silla de madera vieja, con qué le doy color pa que quede como nueva; necesito algo pa soldar cañería de cobre con llama; tengo un agujero en la pared de la pieza, con qué lo relleno antes de pintar; pa colgar un cuadro en el muro de ladrillo, qué compro; la hoja pega contra la muralla cuando se abre, qué pongo pa que no golpee; pa la ventana que no pasen los zancudos; pa amarrar las ramas del árbol del patio; quiero forrar de nuevo el sillón, qué género compro; quiero colgar las camisas en el ropero

Fallan con «Híbrida, peso del texto 0.35» (23): huincha de papel pa pintar; metro pa medir; galletera; tiner; arandelas; pestillo pa la puerta; pitilla; sellador pal techo; pa cortar tela gruesa; algo pa lijar las patas de la silla a mano; se me trabó la gaveta del escritorio, qué le pongo pa que corra bien; pa cerrar con llave la gaveta del velador; quiero poner un estante flotando en la pared, con qué lo afirmo; tengo una silla de madera vieja, con qué le doy color pa que quede como nueva; necesito algo pa soldar cañería de cobre con llama; tengo un agujero en la pared de la pieza, con qué lo relleno antes de pintar; pa colgar un cuadro en el muro de ladrillo, qué compro; la hoja pega contra la muralla cuando se abre, qué pongo pa que no golpee; pa la ventana que no pasen los zancudos; pa amarrar las ramas del árbol del patio; quiero forrar de nuevo el sillón, qué género compro; quiero colgar las camisas en el ropero; un thinner pa limpiar la pistola de pintar

Fallan con «Fusión con sinónimos» (8): algo pa lijar las patas de la silla a mano; se me abrió la puerta del mueble que sube hacia arriba, quiero algo que la sostenga; tengo una silla de madera vieja, con qué le doy color pa que quede como nueva; necesito algo pa soldar cañería de cobre con llama; el desagüe de la cocina está tapado, qué le echo; pa colgar un cuadro en el muro de ladrillo, qué compro; pa amarrar las ramas del árbol del patio; quiero forrar de nuevo el sillón, qué género compro

Cómo leer estos números:
- El diccionario tiene 941 reglas (95 de escritura, 128 de relleno, 718 de sinonimo); 20 por revisar (`SELECT * FROM revisar_sinonimos();`).
- Los grupos «Otro nombre», «Por uso», «Mal escrito» y «Nombre exacto» se conocían al escribir el diccionario: su mejora muestra que el mecanismo funciona, no cuánto acierta con consultas nuevas.
- «Validación a ciegas» se escribió sin ver el diccionario y cada consulta espera un producto puntual (con su medida o color). Las descripciones revisadas (tipos_producto.py) se escribieron conociéndola.
- «Validación a ciegas 2» se escribió después, sin ver el diccionario ni las descripciones; casi todas son por uso y no nombran el producto. Es la más difícil y la que mejor anticipa el uso real. Su primera medición fue 0,70 / 0,67 (0,55 / 0,49 con las descripciones anteriores); después se agregaron al diccionario palabras aprendidas de sus fallas (gaveta, ropero, zancudo, «qué le pongo»).
