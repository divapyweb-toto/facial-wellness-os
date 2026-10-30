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

Deno.test("29-10 factura al cobrar: marcado el pago se llama facturarAlCobrar una vez; si Recibido falla, no; su error no frena", async () => {
  const facturas: number[] = [];
  const { d } = dobles({ facturarAlCobrar: (id) => (facturas.push(id), Promise.resolve({ accion: "aprobada" })) });
  const r = await procesarPago({ pedido: "#9001", monto: 158000, nro_transaccion: "T-90" }, d);
  assert(r.ok && !r.prueba && r.notas.includes("Factura emitida al cobrar."));
  assertEquals(facturas, [9001]);
  // Prueba (prueba:true) y transacción repetida: no se factura.
  await procesarPago({ pedido: "#9001", monto: 158000, nro_transaccion: "T-91", prueba: true }, d);
  await procesarPago({ pedido: "#9001", monto: 158000, nro_transaccion: "T-90" }, d);
  assertEquals(facturas, [9001]);
  // Recibido falla → no se factura.
  const f = dobles({ marcarRecibido: () => Promise.resolve({ tipo: "error", error: "x" }), facturarAlCobrar: (id) => (facturas.push(id), Promise.resolve({ accion: "aprobada" })) });
  await procesarPago({ pedido: "#9001", monto: 158000, nro_transaccion: "T-92" }, f.d);
  assertEquals(facturas, [9001]);
  // La factura falla o tira excepción: el pago queda marcado igual (la cola reintenta).
  for (const falla of [() => Promise.resolve({ accion: "error", error: "sifen-cola 500" }), () => Promise.reject(new Error("red"))]) {
    const g = dobles({ facturarAlCobrar: falla });
    const x = await procesarPago({ pedido: "#9001", monto: 158000, nro_transaccion: "T-93" }, g.d);
    assert(x.ok && !x.prueba && x.notas.some((n) => n.includes("la reintenta la cola")));
  }
});

// ---------- 29-10 modo sin pedido (el ranking elige el pedido). Datos inventados (repo público). ----------
import type { CandidatoPago } from "../_shared/pagos_ranking.ts";

const TRANSF_1164 = { monto: 112000, fecha: "2026-10-29T15:30:00-03:00" }; // aviso de ueno desde otro banco: solo monto y hora

let k = 0;
function cnd(o: Partial<CandidatoPago> = {}): CandidatoPago {
  k++;
  return {
    shopify_order_id: 80000 + k, pedido: `#${5000 + k}`, monto_pendiente: 112000, total: 112000, ciudad: "Ciudad Prueba",
    creado_en: `2026-10-${String(10 + (k % 15)).padStart(2, "0")}T12:00:00Z`, tags: ["CONFIRMADO", "OFERTA_PAGO_ANTICIPADO"],
    telefono: `+59598200${String(1000 + k).slice(-4)}`, nombresCliente: [`Cliente${k} Apellido${k}`], comprobantes: [], ...o,
  };
}
const lista17 = (extra: Partial<CandidatoPago>[]) => [...extra.map((e) => cnd(e)), ...Array.from({ length: 17 - extra.length }, () => cnd())];

function doblesSin(cands: CandidatoPago[], over: Partial<DepsPago> = {}) {
  const base = dobles({
    leerPedido: (n) => {
      const c = cands.find((x) => x.pedido === n);
      return Promise.resolve(c ? ped({ shopify_order_id: c.shopify_order_id, nombre: c.pedido, tags: c.tags, total: c.total, nombresCliente: c.nombresCliente ?? [] }) : null);
    },
    ...over,
  });
  const avisos: { texto: string; botones: unknown[][]; clave: string }[] = [];
  const consultas: number[] = [];
  base.d.candidatos = (monto) => (consultas.push(monto), Promise.resolve(cands));
  base.d.avisarEnrique = (texto, botones, clave) => (avisos.push({ texto, botones, clave }), Promise.resolve(true));
  base.d.transferenciaYaAsociada = over.transferenciaYaAsociada ?? (() => Promise.resolve(false));
  base.d.ahora = () => new Date("2026-10-29T18:40:00Z");
  return { ...base, avisos, consultas };
}

Deno.test("sin pedido · caso #1164: aviso solo con monto y hora, 17 esperan Gs 112.000, comprobante desde el celular del pedido → ese", async () => {
  const cands = lista17([{ pedido: "#1164", shopify_order_id: 1164, creado_en: "2026-10-29T18:24:04Z", telefono: "0981 222 333", comprobantes: [{ en: "2026-10-29T18:30:14Z", telefono: "+595981222333", monto: 112000 }] }]);
  const { d, log, avisos } = doblesSin(cands);
  const r = await procesarPago(TRANSF_1164, d);
  assert(r.ok && !r.prueba, JSON.stringify(r));
  assertEquals([r.pedido, r.coincidencia, r.senales], ["#1164", "telefono", ["telefono"]]);
  assertEquals(log.recibidos, [1164]);
  assertEquals(log.reservas, ["SN-t2610291530-112000"]); // sin nro. en el aviso: clave por hora y monto
  assertEquals(avisos.length, 0);
});

Deno.test("sin pedido · nro. del comprobante = nro. del aviso → se asocia aunque el titular sea otro (un familiar)", async () => {
  const cands = lista17([
    { pedido: "#5101", shopify_order_id: 5101, nombresCliente: ["Ana Prueba Uno"], comprobantes: [{ en: "2026-10-28T10:00:00Z", telefono: "0985000000", nro_transaccion: "000987654321" }] },
    { pedido: "#5102", nombresCliente: ["Carlos Familiar Prueba"] },
  ]);
  const { d, log } = doblesSin(cands);
  const r = await procesarPago({ ...TRANSF_1164, nro_transaccion: "987654321", titular: "CARLOS FAMILIAR PRUEBA" }, d);
  assert(r.ok && !r.prueba, JSON.stringify(r));
  assertEquals([r.pedido, r.coincidencia], ["#5101", "nro"]);
  assertEquals([log.recibidos, log.reservas], [[5101], ["987654321"]]);
});

Deno.test("sin pedido · titular = nombre y apellido de un solo pedido → se asocia; con un solo candidato también", async () => {
  const cands = lista17([{ pedido: "#5201", shopify_order_id: 5201, nombresCliente: ["José Luis Fernández"] }]);
  const a = doblesSin(cands);
  const r = await procesarPago({ ...TRANSF_1164, nro_transaccion: "TX-55", titular: "FERNANDEZ JOSE LUIS" }, a.d);
  assert(r.ok && !r.prueba && r.pedido === "#5201" && r.coincidencia === "nombre", JSON.stringify(r));
  const b = doblesSin([cnd({ pedido: "#5202", shopify_order_id: 5202, nombresCliente: ["Rosa María Prueba"] })]);
  const r2 = await procesarPago({ ...TRANSF_1164, nro_transaccion: "TX-56", titular: "ROSA PRUEBA" }, b.d);
  assert(r2.ok && !r2.prueba && r2.pedido === "#5202", JSON.stringify(r2));
  // Dos con el mismo nombre y apellido → ambiguo, no se marca.
  const c = doblesSin(lista17([{ nombresCliente: ["Rosa Prueba"] }, { nombresCliente: ["Rosa Prueba Dos"] }]));
  const r3 = await procesarPago({ ...TRANSF_1164, nro_transaccion: "TX-57", titular: "ROSA PRUEBA" }, c.d);
  assertEquals(r3.ok ? null : r3.error, "ambiguo");
  assertEquals(c.log.recibidos, []);
});

Deno.test("sin pedido · ambiguo → aviso a Enrique con los 3 más probables y botones Es este; nada marcado", async () => {
  const { d, log, avisos } = doblesSin(lista17([]));
  const r = await procesarPago(TRANSF_1164, d);
  assert(!r.ok);
  assertEquals([r.error, r.total, r.avisado, r.candidatos?.length], ["ambiguo", 17, true, 3]);
  assertEquals(avisos.length, 1);
  assertEquals(avisos[0].botones.length, 3);
  const b = avisos[0].botones[0][0] as { texto: string; callback: string };
  assert(/^Es este: #\d+$/.test(b.texto) && /^es_este:\d+:t2610291530$/.test(b.callback), JSON.stringify(b));
  assertEquals(avisos[0].clave, "t2610291530:112000");
  assert(avisos[0].texto.includes("hay 17 pedidos esperando ese monto"), avisos[0].texto);
  assert(!/\+595|Cliente\d|Apellido/.test(avisos[0].texto)); // sin datos personales
  assertEquals([log.reservas.length, log.recibidos.length], [0, 0]);
});

Deno.test("sin pedido · distinto monto → nunca se asocia (aunque el comprobante sea del celular del pedido)", async () => {
  const cands = [cnd({ pedido: "#5301", telefono: "0981222444", comprobantes: [{ en: "2026-10-29T18:30:00Z", telefono: "0981222444" }] })];
  const { d, log, avisos } = doblesSin(cands);
  const r = await procesarPago({ ...TRANSF_1164, monto: 111000 }, d);
  assertEquals(r.ok ? null : [r.error, r.avisado], ["sin_candidatos", true]);
  assert(avisos[0].texto.includes("sin pedido que espere ese monto"));
  assertEquals(log.recibidos, []);
});

Deno.test("sin pedido · interruptor apagado → no consulta, no avisa, no marca; prueba:true dice qué haría sin tocar nada", async () => {
  const cands = lista17([{ pedido: "#1164", shopify_order_id: 1164, telefono: "0981222333", creado_en: "2026-10-29T18:24:04Z", comprobantes: [{ en: "2026-10-29T18:30:14Z", telefono: "0981222333" }] }]);
  const a = doblesSin(cands, { activo: () => Promise.resolve(false) });
  const r = await procesarPago(TRANSF_1164, a.d);
  assertEquals(r.ok ? null : r.error, "apagado");
  assertEquals([a.consultas.length, a.avisos.length, a.log.reservas.length, a.log.recibidos.length], [0, 0, 0, 0]);
  const p = await procesarPago({ ...TRANSF_1164, prueba: true }, a.d);
  assert(p.ok && p.prueba && p.pedido === "#1164", JSON.stringify(p));
  const amb = await procesarPago({ ...TRANSF_1164, monto: 112000, prueba: true }, doblesSin(lista17([]), { activo: () => Promise.resolve(false) }).d);
  assert(!amb.ok && amb.error === "ambiguo" && amb.avisado === true && !!amb.aviso);
  assertEquals([a.avisos.length, a.log.reservas.length, a.log.recibidos.length], [0, 0, 0]);
});

Deno.test("sin pedido · rendición de Punto a Punto o Lucero del Este → se ignora, sin aviso ni consulta", async () => {
  for (const titular of ["PUNTO A PUNTO S.A.", "Lucero del Este SRL"]) {
    const { d, log, avisos, consultas } = doblesSin(lista17([]));
    const r = await procesarPago({ monto: 1250000, fecha: "2026-10-29T11:00:00-03:00", nro_transaccion: "R-1", titular }, d);
    assertEquals(r.ok ? null : [r.error, r.ignorar], ["rendicion_courier", true]);
    assertEquals([consultas.length, avisos.length, log.recibidos.length], [0, 0, 0]);
  }
});

Deno.test("sin pedido · transferencia ya asociada (automático o Es este) → nada; la misma clave no marca dos veces", async () => {
  const cands = lista17([{ pedido: "#1164", shopify_order_id: 1164, telefono: "0981222333", creado_en: "2026-10-29T18:24:04Z", comprobantes: [{ en: "2026-10-29T18:30:14Z", telefono: "0981222333" }] }]);
  const a = doblesSin(cands, { transferenciaYaAsociada: (_c, ref) => Promise.resolve(ref === "t2610291530") });
  const r = await procesarPago(TRANSF_1164, a.d);
  assertEquals(r.ok ? null : [r.error, r.ignorar], ["ya_asociada", true]);
  assertEquals([a.consultas.length, a.avisos.length, a.log.recibidos.length], [0, 0, 0]);
  // Sin el chequeo: la reserva por clave también frena la segunda vez.
  const b = doblesSin(cands);
  assert((await procesarPago(TRANSF_1164, b.d)).ok);
  const r2 = await procesarPago(TRANSF_1164, b.d);
  assertEquals(r2.ok ? null : r2.error, "transaccion_ya_usada");
  assertEquals(b.log.recibidos, [1164]);
});

Deno.test("sin pedido · datos inválidos: sin fecha, monto con decimales, nro. con espacios", async () => {
  const { d } = doblesSin(lista17([]));
  for (const e of [{ monto: 112000 }, { monto: 10.5, fecha: "2026-10-29T15:30:00-03:00" }, { monto: 112000, fecha: "2026-10-29T15:30:00-03:00", nro_transaccion: "a b" }]) {
    const r = await procesarPago(e, d);
    assertEquals(r.ok ? null : r.error, "datos_invalidos");
  }
});

Deno.test("decidir: acepta las señales del ranking (nro, telefono, titular); 'comprobante' de otro celular u 'hora' solas no", () => {
  const p = ped({ tags: ["CONFIRMADO", "OFERTA_PAGO_ANTICIPADO"] });
  assertEquals(decidir(p, 158000, null, ["nro"]).ok && decidir(p, 158000, null, ["nro"]), { ok: true, motivo: "oferta_pago_anticipado", pendiente: 158000, coincidencia: "nro" });
  assertEquals((decidir(p, 158000, null, ["telefono"]) as { coincidencia: string }).coincidencia, "telefono");
  assertEquals((decidir(p, 158000, null, ["titular"]) as { coincidencia: string }).coincidencia, "nombre");
  for (const s of [["comprobante"], ["hora"], []] as const) assertEquals(decidir(p, 158000, null, [...s]).ok, false);
  assertEquals(decidir(p, 150000, null, ["nro"]).ok, false); // el monto manda siempre
});
