# Paneles de AgenTech

React + Vite + Tailwind CSS. Dos paneles, solo para uso local:

- **Vendedor** (`/vendedor`): el catálogo con foto, precio y stock, la búsqueda "como lo dice el cliente"
  (búsqueda semántica) y el asistente de búsqueda (chatbot). El asistente responde con la tabla de productos reales
  con stock; no redacta con un modelo de lenguaje, así no inventa productos ni precios.
- **Administrador** (`/panel`): indicadores, gráficos de ventas de Bsale, stock y uso del buscador, y el botón
  "Explícame este gráfico", donde el agente interpreta cada gráfico con los datos que calculó la base.

## Levantar

Con la API corriendo en `http://localhost:3000`:

```bash
npm install
```

```bash
npm run dev
```

Abre `http://localhost:5173`. Vite redirige las llamadas a la API.

Las fotos se leen de la carpeta local indicada en `FOTOS_DIR` (fotos `<SKU>.jpg` del e-commerce); no se copian ni se suben.
