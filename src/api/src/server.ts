import { existsSync, readFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import cors from "cors";
import express from "express";
import swaggerUi from "swagger-ui-express";
import YAML from "yaml";
import { config } from "./config.js";
import { pool } from "./db.js";
import { manejarErrores } from "./errores.js";
import { rutaAdmin } from "./rutas/admin.js";
import { rutaAlertas } from "./rutas/alertas.js";
import { rutaConsulta } from "./rutas/consulta.js";
import { rutaIngesta } from "./rutas/ingesta.js";
import { rutaProductos } from "./rutas/productos.js";
import { rutaRespuesta } from "./rutas/respuesta.js";

const aqui = dirname(fileURLToPath(import.meta.url));
const especificacion = YAML.parse(readFileSync(join(aqui, "..", "openapi.yaml"), "utf-8"));

export const app = express();
app.use(cors());
app.use(express.json({ limit: "20mb" }));

app.get("/salud", async (_req, res) => {
  const db = await pool.query("SELECT 1").then(() => true, () => false);
  res.status(db ? 200 : 503).json({ api: true, base_de_datos: db, modelo_embedding: config.modeloEmbedding });
});
app.get("/openapi.json", (_req, res) => res.json(especificacion));
app.use("/docs", swaggerUi.serve, swaggerUi.setup(especificacion));
if (config.fotosDir) app.use("/fotos", express.static(config.fotosDir, { maxAge: "1d" }));

app.use(rutaIngesta, rutaConsulta, rutaRespuesta, rutaProductos, rutaAdmin, rutaAlertas);

// Si los paneles están compilados (src/web/dist), la API también los sirve en local.
const web = join(aqui, "..", "..", "web", "dist");
if (existsSync(web)) {
  app.use(express.static(web));
  app.get(/^\/(vendedor|panel)?$/,(_req, res) => res.sendFile(join(web, "index.html")));
}

app.use((_req, res) => {
  res.status(404).json({ error: { codigo: "ruta_no_encontrada", mensaje: "La ruta no existe. Revisa /docs." } });
});
app.use(manejarErrores);

if (process.argv[1] && fileURLToPath(import.meta.url) === process.argv[1]) {
  app.listen(config.puerto, () => console.log(`API de AgenTech en http://localhost:${config.puerto} (docs en /docs)`));
}
