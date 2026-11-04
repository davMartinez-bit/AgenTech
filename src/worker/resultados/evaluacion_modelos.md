# Evaluación de modelos de embeddings (2026-11-03)

30 consultas de prueba, top 5 sobre el catálogo activo.

| Modelo | Dim. | Acierto@5 | Precisión@5 | MRR | Latencia consulta (ms) | Vectorizar catálogo (s) |
|---|---|---|---|---|---|---|
| nomic-embed-text-v2-moe | 768 | 0.8 | 0.54 | 0.693 | 2112 | 135.8 |
| hf.co/vectorlink/multilingual-e5-base-GGUF | 768 | 0.733 | 0.427 | 0.633 | 2095 | 118.3 |
| bge-m3 | 1024 | 0.733 | 0.4 | 0.631 | 2112 | 154.1 |
| granite-embedding:278m | 768 | 0.667 | 0.327 | 0.517 | 2099 | 129.6 |
| nomic-embed-text | 768 | 0.567 | 0.353 | 0.464 | 2076 | 139.6 |
