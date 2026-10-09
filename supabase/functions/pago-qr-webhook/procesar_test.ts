import { assertEquals } from "jsr:@std/assert@1";
import { configQR, type CobroQR, type DepsPagoQR, procesarPagoQR } from "./procesar.ts";
import type { EventoPagoQR } from "../_shared/pago_qr.ts";

function setup(cobro: CobroQR | null, tagOk = true) {
  const c = cobro ? { ...cobro } : null;
  const log = { tags: [] as string[], avisos: [] as string[] };
  const d: DepsPagoQR = {
    buscarCobro: () => Promise.resolve(c),
    cambiarEstado: (_id, estado, extra) => {
      if (!c || c.estado === "pagado") return Promise.resolve(false);
      c.estado = estado;
      void extra;
      return Promise.resolve(true);
    },
    leerPedido: () => Promise.resolve({ nombre: "#1001", courier: "lucero" }),
    agregarTag: (_id, tag) => { log.tags.push(tag); return Promise.resolve(tagOk ? { ok: true } : { ok: false, error: "shopify" }); },
    avisar: (t) => { log.avisos.push(t); return Promise.resolve(); },
    escapar: (s) => String(s),
    ahora: () => new Date("2026-10-06T15:00:00Z"),
  };
  return { d, log, c };
}
const cobro: CobroQR = { id: "c1", shopify_order_id: 9001, proveedor: "adamspay", estado: "pendiente", monto: 129000, id_externo: "voltra-9001" };
const ev = (o: Partial<EventoPagoQR> = {}): EventoPagoQR => ({ id_evento: "e1", id_externo: "voltra-9001", pagado: true, monto: 129000, estado_crudo: "paid", ...o });
const cfg = configQR({ activo: true });

Deno.test("la bandera apagada es el valor por defecto", () => {
  assertEquals(configQR(undefined).activo, false);
});

Deno.test("pago confirmado: marca pagado, tag PAGADO_QR y aviso con la instrucción al courier", async () => {
  const { d, log, c } = setup(cobro);
  assertEquals((await procesarPagoQR("adamspay", ev(), cfg, d)).accion, "pagado");
  assertEquals(c!.estado, "pagado");
  assertEquals(log.tags, ["PAGADO_QR"]);
  assertEquals(log.avisos.length, 1);
  assertEquals(log.avisos[0].includes("NO COBRAR"), true);
});

Deno.test("idempotencia: el mismo webhook dos veces actúa una sola vez", async () => {
  const { d, log } = setup(cobro);
  await procesarPagoQR("adamspay", ev(), cfg, d);
  assertEquals((await procesarPagoQR("adamspay", ev(), cfg, d)).accion, "ya_pagado");
  assertEquals(log.tags.length, 1);
  assertEquals(log.avisos.length, 1);
});

Deno.test("monto distinto: no marca pagado ni pone tag, avisa", async () => {
  const { d, log, c } = setup(cobro);
  assertEquals((await procesarPagoQR("adamspay", ev({ monto: 50000 }), cfg, d)).accion, "monto_distinto");
  assertEquals(c!.estado, "monto_distinto");
  assertEquals(log.tags.length, 0);
  assertEquals(log.avisos.length, 1);
});

Deno.test("no pagado y cobro desconocido", async () => {
  const a = setup(cobro);
  assertEquals((await procesarPagoQR("adamspay", ev({ pagado: false }), cfg, a.d)).accion, "no_pagado");
  assertEquals(a.log.avisos.length, 0);
  const b = setup(null);
  assertEquals((await procesarPagoQR("adamspay", ev(), cfg, b.d)).accion, "cobro_desconocido");
  assertEquals(b.log.avisos.length, 1);
});

Deno.test("si falla la tag en Shopify, igual queda pagado y el aviso lo dice", async () => {
  const { d, log, c } = setup(cobro, false);
  await procesarPagoQR("adamspay", ev(), cfg, d);
  assertEquals(c!.estado, "pagado");
  assertEquals(log.avisos[0].includes("No se pudo poner la tag"), true);
});

// ── atenderEventoQR (webhook ya verificado) ──
import { atenderEventoQR, type DepsEventoQR } from "./procesar.ts";

function depsEvento(nuevo: boolean, falla: boolean) {
  const log = { procesado: 0, marcas: [] as (string | null)[], borrado: 0, avisos: [] as string[] };
  const d: DepsEventoQR = {
    guardarEvento: () => Promise.resolve(nuevo),
    procesar: () => { log.procesado++; return falla ? Promise.reject(new Error("db caída")) : Promise.resolve(); },
    marcarProcesado: (e) => { log.marcas.push(e); return Promise.resolve(); },
    borrarEvento: () => { log.borrado++; return Promise.resolve(); },
    avisar: (t) => { log.avisos.push(t); return Promise.resolve(); },
    escapar: (s) => String(s),
  };
  return { d, log };
}

Deno.test("evento nuevo se procesa aunque la bandera esté apagada (no depende de ola4.qr)", async () => {
  const { d, log } = depsEvento(true, false);
  const r = await atenderEventoQR(d, "e1");
  assertEquals(r.status, 200);
  assertEquals(log.procesado, 1);
  assertEquals(log.marcas, [null]);
});

Deno.test("evento repetido no se procesa", async () => {
  const { d, log } = depsEvento(false, false);
  const r = await atenderEventoQR(d, "e1");
  assertEquals(r.cuerpo.repetido, true);
  assertEquals(log.procesado, 0);
});

Deno.test("si procesar falla: borra la marca, avisa y devuelve 500 para que el proveedor reintente", async () => {
  const { d, log } = depsEvento(true, true);
  const r = await atenderEventoQR(d, "e1");
  assertEquals(r.status, 500);
  assertEquals(log.borrado, 1);
  assertEquals(log.avisos.length, 1);
  assertEquals(log.marcas, []);
});
