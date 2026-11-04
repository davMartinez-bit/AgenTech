import tailwindcss from "@tailwindcss/vite";
import react from "@vitejs/plugin-react";
import { defineConfig } from "vite";

const api = process.env.AGENTECH_API ?? "http://localhost:3000";
const rutasApi = ["/ingesta", "/consulta", "/productos", "/categorias", "/admin/", "/fotos", "/salud", "/docs", "/openapi.json"];

export default defineConfig({
  plugins: [react(), tailwindcss()],
  server: {
    port: 5173,
    proxy: Object.fromEntries(rutasApi.map((r) => [r, { target: api, changeOrigin: true }])),
  },
});
