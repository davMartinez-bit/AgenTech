# Evaluación de la búsqueda híbrida (2026-11-03)

Modelo `nomic-embed-text-v2-moe`, 30 consultas con productos esperados en stock, top 5.

| Peso del texto | Acierto@5 | Precisión@5 | MRR | SQL p50 (ms) |
|---|---|---|---|---|
| 0.0 | 0.933 | 0.587 | 0.828 | 16 |
| 0.15 | 0.933 | 0.593 | 0.858 | 16 |
| 0.25 | 0.900 | 0.580 | 0.851 | 15 |
| 0.35 | 0.867 | 0.573 | 0.828 | 15 |
| 0.5 | 0.867 | 0.573 | 0.811 | 16 |

Similitud del mejor producto (para fijar `similitud_minima`):

- Consultas de ferretería: mínimo 0.295, mediana 0.517
- Consultas ajenas: máximo 0.317, mediana 0.264
- Embedding de la consulta: mediana 70 ms
