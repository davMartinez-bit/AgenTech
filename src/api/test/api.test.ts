// Pruebas de la API contra la base local (docker compose up -d db) y Ollama.
// Usan SKU que empiezan con "PRUEBA-" y los borran al terminar.
import assert from "node:assert/strict";
import type { AddressInfo } from "node:net";
import { after, before, describe, test } from "node:test";
import { pool } from "../src/db.js";
import { hechos } from "../src/rutas/admin.js";
import { app } from "../src/server.js";

let base = "";
let servidor: ReturnType<typeof app.listen>;
const ingestas: number[] = [];
const consultas: number[] = [];

async function post(ruta: string, cuerpo: unknown) {
  const r = await fetch(base + ruta, { method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify(cuerpo) });
  const datos = (await r.json()) as any;
  if (datos?.consulta_id) consultas.push(datos.consulta_id);
  return { estado: r.status, datos };
}

before(async () => {
  servidor = app.listen(0);
  base = `http://127.0.0.1:${(servidor.address() as AddressInfo).port}`;
});

after(async () => {
  await pool.query("DELETE FROM ingestas WHERE id = ANY($1)", [ingestas]);
  await pool.query("DELETE FROM consultas WHERE id = ANY($1)", [consultas]);
  await pool.query("DELETE FROM productos WHERE sku LIKE 'PRUEBA-%'");
  servidor.close();
  await pool.end();
});

describe("POST /ingesta", () => {
  test("acepta los válidos, rechaza los inválidos con su motivo y cuadra los totales", async () => {
    const { estado, datos } = await post("/ingesta", {
      origen: "pruebas",
      productos: [
        { sku: "PRUEBA-1", nombre: "Producto de prueba uno", precio: 1990, stock: 5, categoria: "Ferreteria" },
        { sku: "PRUEBA-2", nombre: "Producto de prueba dos", precio: 500, stock: 1.5 },
        { sku: "PRUEBA-3", nombre: "Sin precio", stock: 2 },
        { sku: "PRUEBA-4", nombre: "Precio negativo", precio: -10, stock: 2 },
        { nombre: "Sin SKU", precio: 10, stock: 1 },
      ],
    });
    ingestas.push(datos.ingesta_id);
    assert.equal(estado, 201);
    assert.equal(datos.recibidos, 5);
    assert.equal(datos.aceptados, 2);
    assert.equal(datos.rechazados, 3);
    assert.equal(datos.aceptados + datos.rechazados, datos.recibidos);
    assert.deepEqual(datos.errores.map((e: any) => e.posicion), [3, 4, 5]);
    assert.match(datos.errores[0].motivo, /precio/);

    const { rows } = await pool.query("SELECT precio, stock FROM productos WHERE sku = 'PRUEBA-2'");
    assert.deepEqual(rows[0], { precio: 500, stock: 1.5 });
  });

  test("actualiza por SKU sin duplicar", async () => {
    const { datos } = await post("/ingesta", { origen: "pruebas", productos: [{ sku: "PRUEBA-1", nombre: "Producto de prueba uno", precio: 2490, stock: 0 }] });
    ingestas.push(datos.ingesta_id);
    const { rows } = await pool.query("SELECT count(*)::int AS n, max(precio) AS precio FROM productos WHERE sku = 'PRUEBA-1'");
    assert.deepEqual(rows[0], { n: 1, precio: 2490 });
  });

  test("responde 422 si todos vienen malos y 400 si el cuerpo no tiene productos", async () => {
    const todosMalos = await post("/ingesta", { origen: "pruebas", productos: [{ sku: "PRUEBA-X" }] });
    ingestas.push(todosMalos.datos.ingesta_id);
    assert.equal(todosMalos.estado, 422);
    const vacio = await post("/ingesta", { productos: [] });
    assert.equal(vacio.estado, 400);
    assert.equal(vacio.datos.error.codigo, "solicitud_invalida");
  });
});

describe("POST /consulta", () => {
  test("devuelve el contrato JSON con solo productos con stock", async () => {
    const { estado, datos } = await post("/consulta", { texto: "huincha pa medir", limite: 5 });
    assert.equal(estado, 200);
    assert.ok(datos.resultados.length > 0);
    for (const r of datos.resultados) {
      assert.deepEqual(Object.keys(r).sort(), ["categoria", "foto", "nombre", "precio", "score", "sku", "stock"]);
      assert.ok(r.stock > 0);
    }
    assert.match(datos.resultados[0].nombre, /huincha/i);
  });

  test("una búsqueda ajena a la ferretería vuelve vacía, sin error", async () => {
    const { estado, datos } = await post("/consulta", { texto: "pizza napolitana" });
    assert.equal(estado, 200);
    assert.deepEqual(datos.resultados, []);
  });

  test("texto vacío es un 400 con el formato de error", async () => {
    const { estado, datos } = await post("/consulta", { texto: "   " });
    assert.equal(estado, 400);
    assert.equal(datos.error.codigo, "solicitud_invalida");
  });
});

describe("recomendaciones", () => {
  test("alternativas y complementos solo traen productos con stock y no el mismo producto", async () => {
    const { rows } = await pool.query(
      `SELECT p.sku FROM venta_detalle d JOIN productos p ON p.id = d.producto_id
       GROUP BY p.sku ORDER BY count(*) DESC LIMIT 1`,
    );
    const sku = rows[0].sku;
    for (const tipo of ["alternativas", "complementos"]) {
      const lista = (await (await fetch(`${base}/productos/${sku}/${tipo}`)).json()) as any[];
      assert.ok(lista.length > 0, `${tipo} vacío`);
      assert.ok(lista.every((p) => p.stock > 0 && p.sku !== sku));
    }
  });
});

describe("agente del panel", () => {
  test("los hechos marcan el mes en curso como incompleto", () => {
    const mes = new Date().toISOString().slice(0, 7);
    const h = hechos("ventas_por_mes", [
      { mes: "2026-01", documentos: 10, total: 1000 },
      { mes: "2026-02", documentos: 12, total: 2000 },
      { mes, documentos: 1, total: 10 },
    ]);
    assert.ok(h.some((x) => x.includes("incompleto")));
    assert.ok(h.some((x) => x.includes("sube 100 %")));
  });

  test("GET /admin/graficos/:id inexistente responde 404", async () => {
    const r = await fetch(`${base}/admin/graficos/no-existe`);
    assert.equal(r.status, 404);
  });
});
