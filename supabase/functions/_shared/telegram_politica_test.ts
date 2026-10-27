import { assert, assertEquals } from "@std/assert";
import { decidirRuta, inicioDiaPY, leerPolitica } from "./telegram_politica.ts";
import { _limpiarCachePolitica, avisar, depsAvisos } from "./telegram.ts";

const POL = { enrique: ["cancelado_en_courier"], resumen: ["plazo_pap"], descartar: ["sin_confirmar_horas"] };

Deno.test("ruta: sin opciones y 'todos' van por Telegram como antes", () => {
  assertEquals(decidirRuta(POL, undefined), "telegram");
  assertEquals(decidirRuta("todos", { tipo: "stock_bajo", destino: "admin" }), "telegram");
  assertEquals(decidirRuta("todos", { tipo: "sin_confirmar_horas", destino: "admin" }), "telegram");
});

Deno.test("ruta: listas de la política mandan sobre el código; lo no listado sigue al código", () => {
  assertEquals(decidirRuta(POL, { tipo: "cancelado_en_courier", destino: "admin" }), "telegram");
  assertEquals(decidirRuta(POL, { tipo: "plazo_pap", destino: "enrique" }), "resumen");
  assertEquals(decidirRuta(POL, { tipo: "sin_confirmar_horas", destino: "enrique" }), "descartar");
  assertEquals(decidirRuta(POL, { tipo: "nuevo_tipo", destino: "enrique" }), "telegram");
  assertEquals(decidirRuta(POL, { tipo: "stock_bajo", destino: "admin" }), "admin");
  assertEquals(decidirRuta(null, { tipo: "plazo_pap", destino: "enrique" }), "telegram");
});

Deno.test("leerPolitica: texto 'todos', JSON, basura → null", () => {
  assertEquals(leerPolitica("todos"), "todos");
  assertEquals(leerPolitica('"todos"'), "todos");
  assertEquals(leerPolitica(JSON.stringify(POL)), POL);
  assertEquals(leerPolitica("{roto"), null);
  assertEquals(leerPolitica(null), null);
});

Deno.test("inicioDiaPY: 00:00 de Paraguay en UTC", () => {
  assertEquals(inicioDiaPY(new Date("2026-10-27T02:00:00Z")), "2026-10-26T03:00:00.000Z");
  assertEquals(inicioDiaPY(new Date("2026-10-27T15:00:00Z")), "2026-10-27T03:00:00.000Z");
});

function falsos(politica: unknown, opciones: { colaFalla?: boolean; yaSalio?: boolean } = {}) {
  const cola: unknown[] = [], registro: unknown[] = [];
  Object.assign(depsAvisos, {
    leerPoliticaCruda: () => Promise.resolve(politica),
    encolar: (f: unknown) => { cola.push(f); return Promise.resolve(opciones.colaFalla ? "base caída" : null); },
    registrar: (f: unknown) => { registro.push(f); return Promise.resolve(); },
    yaSalio: () => Promise.resolve(!!opciones.yaSalio),
  });
  _limpiarCachePolitica();
  return { cola, registro };
}

Deno.test("avisar: admin y resumen van a la cola sin Telegram; descartar no deja nada", async () => {
  const { cola, registro } = falsos(JSON.stringify(POL));
  assert((await avisar("stock", undefined, { tipo: "stock_bajo", destino: "admin" })).ok);
  assert((await avisar("plazo", undefined, { tipo: "plazo_pap", destino: "enrique", pedido: "#1101" })).ok);
  assert((await avisar("x", undefined, { tipo: "sin_confirmar_horas", destino: "admin" })).ok);
  assertEquals(cola, [
    { tipo: "stock_bajo", texto: "stock", pedido: null, destino: "admin", clave: null },
    { tipo: "plazo_pap", texto: "plazo", pedido: "#1101", destino: "resumen", clave: null },
  ]);
  assertEquals(registro.length, 0);
});

Deno.test("avisar: Telegram inmediato queda registrado (sin token: ok=false pero registrado)", async () => {
  const { registro } = falsos(JSON.stringify(POL));
  const r = await avisar("cancelado", undefined, { tipo: "cancelado_en_courier", destino: "enrique", pedido: "#1", clave: "99" });
  assertEquals(r.ok, false);
  assertEquals((registro[0] as { tipo: string; clave: string }).tipo, "cancelado_en_courier");
  assertEquals((registro[0] as { clave: string }).clave, "99");
});

Deno.test("avisar: unaVezPorDia no repite; si la cola falla, el aviso de Enrique sale por Telegram", async () => {
  let x = falsos(JSON.stringify(POL), { yaSalio: true });
  assert((await avisar("error", undefined, { tipo: "cola_sifen_error", destino: "admin", unaVezPorDia: true, clave: "c" })).ok);
  assertEquals(x.cola.length + x.registro.length, 0);
  x = falsos(JSON.stringify(POL), { colaFalla: true });
  await avisar("plazo", undefined, { tipo: "plazo_pap", destino: "enrique" });
  assertEquals(x.registro.length, 1); // salió (intentó) por Telegram
  const r = await avisar("stock", undefined, { tipo: "stock_bajo", destino: "admin" });
  assertEquals(r.ok, false);
});

Deno.test("avisar: política 'todos' (vuelta atrás) manda todo por Telegram", async () => {
  const { cola, registro } = falsos("todos");
  await avisar("stock", undefined, { tipo: "stock_bajo", destino: "admin" });
  await avisar("x", undefined, { tipo: "sin_confirmar_horas", destino: "admin" });
  assertEquals(cola.length, 0);
  assertEquals(registro.length, 2);
});
