import { assert, assertEquals } from "@std/assert";
import { coincideNombre, decidir, montoSaldo, nombrePedido, type PedidoPago } from "./logica.ts";
import { type DepsPago, procesarPago } from "./procesar.ts";

const ped = (over: Partial<PedidoPago> = {}): PedidoPago => ({
  shopify_order_id: 9001, nombre: "#9001", estado_envio: null, tags: ["CONFIRMADO", "OFERTA_PAGO_ANTICIPADO", "PAGO_ANTICIPADO_COMPROBANTE"],
  total: 158000, cancelado: false, nombresCliente: ["Juan Prueba Inventado"], ...over,
});

Deno.test("nombrePedido y montoSaldo", () => {
  assertEquals([nombrePedido("#1135"), nombrePedido("VT-1135"), nombrePedido("1135"), nombrePedido("hola")], ["#1135", "#1135", "#1135", null]);
  assertEquals(montoSaldo(["SALDO_PENDIENTE", "SALDO_45000"]), 45000);
});

Deno.test("coincideNombre: nombre y apellido, sin tildes ni mayúsculas; uno solo no alcanza", () => {
  assert(coincideNombre("JUAN PRUEBA", ["Juan Prueba Inventado"]));
  assert(coincideNombre("Inventado Juan", ["juan prueba inventado"]));
  assert(!coincideNombre("JUAN PEREZ", ["Juan Prueba Inventado"]));
  assert(!coincideNombre("JUAN", ["Juan Prueba Inventado"]));
  assert(coincideNombre("Jose Ramirez", ["José Ramírez"]));
});

Deno.test("decidir: monto exacto + comprobante → ok; monto distinto → error con lo pendiente", () => {
  assertEquals(decidir(ped(), 158000), { ok: true, motivo: "oferta_pago_anticipado", pendiente: 158000, coincidencia: "comprobante" });
  const d = decidir(ped(), 150000);
  assertEquals(d.ok ? null : [d.error, d.pendiente], ["monto_distinto", 158000]);
});

Deno.test("decidir: sin comprobante necesita el titular; si no, sin_coincidencia", () => {
  const p = ped({ tags: ["CONFIRMADO", "SIN_COBERTURA"] });
  assertEquals(decidir(p, 158000, "JUAN PRUEBA").ok, true);
  const d = decidir(p, 158000, "OTRA PERSONA");
  assertEquals(d.ok ? null : d.error, "sin_coincidencia");
});

Deno.test("decidir: saldo pendiente usa SALDO_<monto>; ya pagado, cancelado, reemplazado y sin oferta no se tocan", () => {
  assertEquals(decidir(ped({ tags: ["SALDO_PENDIENTE", "SALDO_45000", "PAGO_ANTICIPADO_COMPROBANTE"] }), 45000).ok, true);
  const sinMonto = decidir(ped({ tags: ["SALDO_PENDIENTE", "PAGO_ANTICIPADO_COMPROBANTE"] }), 45000);
  assertEquals(sinMonto.ok ? null : sinMonto.error, "sin_monto_pendiente");
  for (const [p, err] of [
    [ped({ tags: ["OFERTA_PAGO_ANTICIPADO", "PAGADO", "PAGO_VERIFICADO"] }), "ya_pagado"],
    [ped({ cancelado: true }), "pedido_cancelado"],
    [ped({ tags: ["OFERTA_PAGO_ANTICIPADO", "SIN_COBERTURA_CANCELADO"] }), "pedido_cancelado"],
    [ped({ tags: ["OFERTA_PAGO_ANTICIPADO", "REEMPLAZADO_POR_#9002"] }), "pedido_cancelado"],
    [ped({ tags: ["CONFIRMADO"] }), "no_espera_pago"],
  ] as const) {
    const d = decidir(p, 158000);
    assertEquals(d.ok ? null : d.error, err);
  }
});

function dobles(over: Partial<DepsPago> = {}) {
  const log = { reservas: [] as string[], liberadas: [] as string[], recibidos: [] as number[], admin: [] as string[] };
  const usadas = new Set<string>();
  const d: DepsPago = {
    activo: () => Promise.resolve(true),
    leerPedido: (n) => Promise.resolve(n === "#9001" ? ped() : null),
    reservarTransaccion: (f) => { if (usadas.has(f.nro_transaccion)) return Promise.resolve(false); usadas.add(f.nro_transaccion); log.reservas.push(f.nro_transaccion); return Promise.resolve(true); },
    liberarTransaccion: (n) => { usadas.delete(n); log.liberadas.push(n); return Promise.resolve(); },
    guardarResultado: () => Promise.resolve(),
    marcarRecibido: (id) => { log.recibidos.push(id); return Promise.resolve({ tipo: "hecho", notas: ["Marcado como pagado en Shopify."] }); },
    registrarAdmin: (t) => { log.admin.push(t); return Promise.resolve(); },
    ...over,
  };
  return { d, log };
}

Deno.test("procesarPago: apagado no hace nada; prueba dice qué haría sin reservar ni marcar", async () => {
  const { d, log } = dobles({ activo: () => Promise.resolve(false) });
  assertEquals((await procesarPago({ pedido: "#9001", monto: 158000, nro_transaccion: "T-1" }, d)).ok, false);
  const r = await procesarPago({ pedido: "VT-9001", monto: 158000, nro_transaccion: "T-1", prueba: true }, d);
  assert(r.ok && r.prueba);
  assertEquals([log.reservas.length, log.recibidos.length], [0, 0]);
});

Deno.test("procesarPago: marca una vez; la misma transacción no se usa dos veces", async () => {
  const { d, log } = dobles();
  const r1 = await procesarPago({ pedido: "#9001", monto: 158000, nro_transaccion: "T-77" }, d);
  assert(r1.ok && !r1.prueba && r1.resultado === "hecho");
  const r2 = await procesarPago({ pedido: "#9001", monto: 158000, nro_transaccion: "T-77" }, d);
  assertEquals(r2.ok ? null : r2.error, "transaccion_ya_usada");
  assertEquals(log.recibidos, [9001]);
  assertEquals(log.admin.length, 1);
});

Deno.test("procesarPago: monto distinto o pedido inexistente no reservan; si Recibido falla se libera la transacción", async () => {
  const { d, log } = dobles();
  const m = await procesarPago({ pedido: "#9001", monto: 100, nro_transaccion: "T-2" }, d);
  assertEquals(m.ok ? null : [m.error, m.pendiente], ["monto_distinto", 158000]);
  const n = await procesarPago({ pedido: "#9999", monto: 158000, nro_transaccion: "T-3" }, d);
  assertEquals(n.ok ? null : n.error, "pedido_inexistente");
  assertEquals(log.reservas.length, 0);
  const f = dobles({ marcarRecibido: () => Promise.resolve({ tipo: "error", error: "Shopify no lo marcó pagado" }) });
  const r = await procesarPago({ pedido: "#9001", monto: 158000, nro_transaccion: "T-4" }, f.d);
  assertEquals(r.ok ? null : r.error, "recibido_fallo");
  assertEquals(f.log.liberadas, ["T-4"]);
});

Deno.test("procesarPago: datos inválidos", async () => {
  const { d } = dobles();
  for (const e of [{ pedido: "x", monto: 1, nro_transaccion: "T-1" }, { pedido: "#9001", monto: 10.5, nro_transaccion: "T-1" }, { pedido: "#9001", monto: 158000, nro_transaccion: "" }]) {
    const r = await procesarPago(e, d);
    assertEquals(r.ok ? null : r.error, "datos_invalidos");
  }
});
