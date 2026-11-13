// Pruebas de la API contra la base local (docker compose up -d db) y Ollama.
// Usan SKU que empiezan con "PRUEBA-" y los borran al terminar.
import assert from "node:assert/strict";
import type { AddressInfo } from "node:net";
import { after, before, describe, test } from "node:test";
import { config } from "../src/config.js";
import { pool } from "../src/db.js";
import { hechos } from "../src/rutas/admin.js";
import { cifrasInventadas, clasificar } from "../src/rutas/alertas.js";
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
      assert.deepEqual(Object.keys(r).sort(), ["categoria", "foto", "nombre", "precio", "score", "sku", "stock", "unidad"]);
      assert.ok(r.stock > 0);
    }
    assert.match(datos.resultados[0].nombre, /huincha/i);
  });

  test("el buscador no usa las frases de cliente y el asistente sí", async () => {
    const buscador = await post("/consulta", { texto: "reparación de techo", limite: 5 });
    assert.equal(buscador.estado, 200);
    assert.equal(buscador.datos.origen, "buscador", "sin origen, la consulta es del buscador");
    const asistente = await post("/consulta", { texto: "se me llueve el techo de zinc y necesito taparlo", limite: 5, origen: "asistente" });
    assert.equal(asistente.estado, 200);
    assert.equal(asistente.datos.origen, "asistente");
    assert.ok(asistente.datos.resultados.length > 0, "el asistente encuentra algo para un problema contado");
    const malo = await post("/consulta", { texto: "techo", origen: "otro" });
    assert.equal(malo.estado, 400);
  });

  test("el buscador entiende una tarea corta y mezcla los productos que se usan", async () => {
    const { estado, datos } = await post("/consulta", { texto: "pintar muros", limite: 6 });
    assert.equal(estado, 200);
    const nombres = datos.resultados.map((r: { nombre: string }) => r.nombre.toLowerCase()).join(" | ");
    for (const palabra of ["latex", "rodillo", "brocha"]) assert.match(nombres, new RegExp(palabra), palabra);
    assert.deepEqual(datos.interpretacion, [], "el buscador no usa el modelo de lenguaje");
  });

  test("una búsqueda ajena a la ferretería vuelve vacía, sin error", async () => {
    const { estado, datos } = await post("/consulta", { texto: "pizza napolitana" });
    assert.equal(estado, 200);
    assert.deepEqual(datos.resultados, []);
  });

  test("entiende el nombre que usa el cliente y la escritura informal", async () => {
    for (const texto of ["huincha aislante", "wincha aislante", "hola buenas, ¿tiene huinchas aislantes porfa?"]) {
      const { datos } = await post("/consulta", { texto, limite: 3 });
      assert.match(datos.resultados[0].nombre, /cinta aisladora/i, texto);
      assert.equal(datos.texto, texto, "devuelve el texto tal como se escribió");
      assert.equal(datos.texto_buscado, "cinta aisladora");
      assert.equal(datos.se_corrigio, true);
      const { rows } = await pool.query("SELECT texto FROM consultas WHERE id = $1", [datos.consulta_id]);
      assert.equal(rows[0].texto, texto, "guarda el texto original, no el corregido");
    }
    const galletera = await post("/consulta", { texto: "galletera", limite: 3 });
    assert.match(galletera.datos.resultados[0].nombre, /esmeril angular/i);
    const exacta = await post("/consulta", { texto: "cinta aisladora", limite: 3 });
    assert.equal(exacta.datos.se_corrigio, false);
  });

  test("registra el clic en un resultado y rechaza un producto que no venía en la consulta", async () => {
    const { datos } = await post("/consulta", { texto: "huincha pa medir", limite: 5 });
    const segundo = datos.resultados[1];
    const clic = await post(`/consulta/${datos.consulta_id}/clic`, { sku: segundo.sku, origen: "asistente" });
    assert.equal(clic.estado, 201);
    assert.equal(clic.datos.posicion, 2);
    const { rows } = await pool.query("SELECT origen FROM consulta_clics WHERE consulta_id = $1", [datos.consulta_id]);
    assert.deepEqual(rows, [{ origen: "asistente" }]);
    const ajeno = await post(`/consulta/${datos.consulta_id}/clic`, { sku: "NO-EXISTE" });
    assert.equal(ajeno.estado, 404);
    assert.equal(ajeno.datos.error.codigo, "resultado_no_encontrado");
  });

  test("texto vacío es un 400 con el formato de error", async () => {
    const { estado, datos } = await post("/consulta", { texto: "   " });
    assert.equal(estado, 400);
    assert.equal(datos.error.codigo, "solicitud_invalida");
  });

  test("con el modelo de embeddings arriba la búsqueda es semántica", async () => {
    const { estado, datos } = await post("/consulta", { texto: "pegamento para madera", limite: 5 });
    assert.equal(estado, 200);
    assert.equal(datos.modo, "semantica");
  });

  test("sin el modelo de embeddings la búsqueda sigue por palabras y la consulta queda sin vector", async () => {
    const original = config.ollamaUrl;
    config.ollamaUrl = "http://127.0.0.1:9";
    let respuesta;
    try {
      respuesta = await post("/consulta", { texto: "silicona para baño", limite: 5 });
    } finally {
      config.ollamaUrl = original;
    }
    assert.equal(respuesta.estado, 200);
    assert.equal(respuesta.datos.modo, "solo_texto");
    assert.equal(respuesta.datos.agotado_parecido, null);
    const { rows } = await pool.query("SELECT embedding IS NULL AS sin_vector FROM consultas WHERE id = $1", [respuesta.datos.consulta_id]);
    assert.deepEqual(rows[0], { sin_vector: true });
  });
});

describe("POST /consulta/:id/respuesta", () => {
  test("una consulta inexistente responde 404", async () => {
    const { estado, datos } = await post("/consulta/999999999/respuesta", {});
    assert.equal(estado, 404);
    assert.equal(datos.error.codigo, "consulta_no_encontrada");
  });

  test("redacta una sugerencia con productos de la consulta", { timeout: 90_000 }, async () => {
    const consulta = await post("/consulta", { texto: "pegamento para madera", limite: 8 });
    assert.ok(consulta.datos.resultados.length > 0);
    const { estado, datos } = await post(`/consulta/${consulta.datos.consulta_id}/respuesta`, {});
    assert.equal(estado, 200);
    assert.deepEqual(Object.keys(datos).sort(), ["consulta_id", "ejemplos", "generada", "latencia_ms", "modelo", "recomendados", "respuesta"]);
    assert.ok(datos.respuesta.trim().length > 0);
    const skus = consulta.datos.resultados.map((r: any) => r.sku);
    assert.ok(datos.recomendados.length <= 3);
    for (const r of datos.recomendados) assert.ok(skus.includes(r.sku), `${r.sku} no estaba en los resultados`);
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

describe("avisos de inventario", () => {
  const producto = {
    sku: "X1", nombre: "Producto de prueba", categoria: null, precio: 1000, stock_bsale: 5, vendido_desde_corte: 0, stock_estimado: 5,
    unidades_30: 30, unidades_30_previos: 10, unidades_90: 60, total_90: 60000, unidades_365: 100,
    dias_sin_vender: 1, dias_sin_comprar: null, unidad: "unidad",
  };

  test("avisa cuando el stock alcanza para pocos días y sugiere cuánto comprar", () => {
    const a = clasificar(producto, false)!;
    assert.equal(a.tipo, "por_agotarse");
    assert.equal(a.urgencia, 1);
    assert.equal(a.datos.dias_alcanza, 5);
    assert.equal(a.datos.comprar, 25);
    assert.ok(a.aviso.includes("Se está vendiendo más"));
  });

  test("con unidad de metro, las cantidades llevan la abreviatura y la compra dice 'unos'", () => {
    const metro = clasificar({ ...producto, unidad: "metro" }, false)!;
    assert.equal(metro.tipo, "por_agotarse");
    assert.ok(metro.accion.includes("Compra unos"));
    assert.ok(metro.accion.includes(" m "));
    assert.ok(metro.aviso.includes(" m"));
    assert.equal(metro.unidad, "metro");
    const unidad = clasificar(producto, false)!;
    assert.ok(unidad.accion.startsWith("Compra unas"));
  });

  test("distingue el agotado que se vendía, el olvidado y el stock parado", () => {
    assert.equal(clasificar({ ...producto, stock_estimado: 0 }, false)!.tipo, "agotado_con_demanda");
    assert.equal(
      clasificar({ ...producto, stock_estimado: 0, unidades_30: 0, unidades_90: 0, dias_sin_vender: 150 }, false)!.tipo,
      "agotado_olvidado",
    );
    const parado = { ...producto, stock_estimado: 100, unidades_30: 0, unidades_90: 0, dias_sin_vender: 200 };
    assert.equal(clasificar(parado, false)!.tipo, "stock_parado");
    assert.equal(clasificar({ ...parado, dias_sin_comprar: 10 }, true), null, "recién comprado no es stock parado");
    assert.equal(clasificar({ ...producto, stock_estimado: 500 }, false), null);
  });

  test("detecta cifras que el agente inventó", () => {
    const hechos = "quedan: 5 | vendidos en los últimos 30 días: 1.644,7 | valor: $2.936.800";
    assert.deepEqual(cifrasInventadas("Te quedan 5 y vendiste 1.644,7 ($2.936.800).", hechos), []);
    assert.deepEqual(cifrasInventadas("Te quedan 6.", hechos), ["6"]);
  });

  test("GET /admin/alertas entrega los avisos ordenados y con sus cuentas", async () => {
    const d = (await (await fetch(`${base}/admin/alertas`)).json()) as any;
    assert.ok(d.fechas.stock_leido_el);
    assert.equal(d.alertas.filter((a: any) => a.tipo === "por_agotarse").length, Math.min(d.conteo.por_agotarse, d.reglas.porTipo));
    assert.ok(d.alertas.every((a: any) => a.aviso && a.accion));
  });
});
