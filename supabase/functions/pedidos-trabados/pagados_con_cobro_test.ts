// 16-11 (paquete a): pagados por adelantado con guía a cobrar. Datos inventados (N.º 9xxx, guías falsas).
import { assert, assertEquals, assertStringIncludes } from "@std/assert";
import {
  armarFilas, CANDADO_BASE_PAGADO_COBRO, casoPagadoCobro, claveCandadoPagadoCobro, configPagadoCobro, type DepsPagadoCobro,
  type FilaPagadoCobro, procesarPagadosConCobro, senalPago, textoCobrado, textoEnCamino, textoResumenInicial,
} from "./pagados_con_cobro.ts";

// Lunes 16-11-2026, 11:00 en Paraguay.
const AHORA = new Date("2026-11-16T14:00:00Z");
const CFG = configPagadoCobro(null);
const F = (o: Partial<FilaPagadoCobro> = {}): FilaPagadoCobro => ({
  ref: "VT-9001", courier: "lucero", categoria: "en_proceso", importe: 158000, cobrado: 0, guia: "77001", ciudad: "Luque",
  fechaEntrega: null, senal: "pagado", saldo: null, ...o,
});

function deps(o: { base?: boolean; avisadoAlVerificar?: string[]; falla?: number } = {}) {
  const candados = new Set<string>(o.base ? [CANDADO_BASE_PAGADO_COBRO] : []), telegram: { t: string; tipo?: string }[] = [];
  let fallas = o.falla ?? 0;
  const d: DepsPagadoCobro = {
    tomarCandado: (id) => Promise.resolve(candados.has(id) ? false : (candados.add(id), true)),
    soltarCandado: (id) => Promise.resolve(void candados.delete(id)),
    existeCandado: (id) => Promise.resolve(candados.has(id)),
    avisar: (t, _b, opts) => Promise.resolve(fallas > 0 ? (fallas--, { ok: false, error: "caído" }) : (telegram.push({ t, tipo: opts?.tipo }), { ok: true })),
    esperar: () => Promise.resolve(),
    yaAvisadoAlVerificar: (p) => Promise.resolve((o.avisadoAlVerificar ?? []).includes(p)),
  };
  return { d, candados, telegram };
}

Deno.test("señal de pago: mismo criterio que Despacho ('paid' suelto NO cuenta)", () => {
  assertEquals(senalPago({ tags: ["PAGO_VERIFICADO"] }), "pagado");
  assertEquals(senalPago({ tags: ["pagado"] }), "pagado");
  assertEquals(senalPago({ tags: ["PAGADO_QR"] }), "pagado");
  assertEquals(senalPago({ tags: ["CREDITO"] }), "credito");
  assertEquals(senalPago({ tags: [], pagoAnticipado: true }), "pagado");
  assertEquals(senalPago({ tags: ["PAGO_ANTICIPADO_COMPROBANTE"], financiero: "paid" }), "pagado");
  assertEquals(senalPago({ tags: ["PAGO_ANTICIPADO_COMPROBANTE"], financiero: "pending" }), null); // comprobante sin verificar
  assertEquals(senalPago({ tags: ["CONFIRMADO"], financiero: "paid" }), null); // contra entrega: Shopify pone paid al entregar
  assertEquals(senalPago({ tags: ["SALDO_PENDIENTE", "SALDO_52000"], pagoAnticipado: true }), "parcial");
  assertEquals(senalPago({ tags: null }), null);
});

Deno.test("caso: en camino con monto → en_camino; entregado con monto → cobrado; ₲0, devuelto o sin señal → nada", () => {
  assertEquals(casoPagadoCobro(F()), "en_camino");
  assertEquals(casoPagadoCobro(F({ categoria: "entregado", cobrado: 158000 })), "cobrado");
  assertEquals(casoPagadoCobro(F({ categoria: "entregado", importe: 158000, cobrado: 0 })), "cobrado"); // guía con monto
  assertEquals(casoPagadoCobro(F({ importe: 0, cobrado: 0 })), null); // pagó antes de la planilla: salió con ₲0
  assertEquals(casoPagadoCobro(F({ categoria: "devuelto" })), null);
  assertEquals(casoPagadoCobro(F({ categoria: "no_despachado" })), null);
  assertEquals(casoPagadoCobro(F({ senal: null })), null);
  // pago parcial: solo si la guía supera el saldo conocido
  assertEquals(casoPagadoCobro(F({ senal: "parcial", saldo: 52000, importe: 112000 })), "en_camino");
  assertEquals(casoPagadoCobro(F({ senal: "parcial", saldo: 52000, importe: 52000 })), null);
});

Deno.test("armarFilas: cruza entregas → venta (venta_id o n_referencia) → pedido de Shopify; solo Voltra desde la fecha", () => {
  const entregas = [
    { nro_guia_pap: "L-VT-9001", guia_transportadora: "77001", transportadora: "lucero", categoria: "entregado", importe: 158000, cobrado: 158000, fecha_entrega: "2026-11-05", ciudad: "Luque", n_referencia: "VT-9001", venta_id: "v1", created_at: "2026-11-04T18:00:00Z", tienda: "voltra" },
    { nro_guia_pap: "99887766", guia_transportadora: null, transportadora: "pap", categoria: "en_proceso", importe: 112000, cobrado: 0, fecha_entrega: null, ciudad: "Itá", n_referencia: null, venta_id: "v2", created_at: "2026-11-15T18:00:00Z", tienda: "voltra" },
    { nro_guia_pap: "L-VT-9003", guia_transportadora: null, transportadora: "lucero", categoria: "entregado", importe: 99000, cobrado: 99000, fecha_entrega: "2026-11-10", ciudad: "CDE", n_referencia: "VT-9003", venta_id: null, created_at: "2026-11-09T18:00:00Z", tienda: "voltra" },
    { nro_guia_pap: "L-VT-9004", guia_transportadora: "77004", transportadora: "lucero", categoria: "entregado", importe: 99000, cobrado: 99000, fecha_entrega: "2026-09-10", ciudad: "CDE", n_referencia: "VT-9004", venta_id: null, created_at: "2026-09-09T18:00:00Z", tienda: "voltra" },
    { nro_guia_pap: "L-VT-9005", guia_transportadora: "77005", transportadora: "lucero", categoria: "entregado", importe: 99000, cobrado: 99000, fecha_entrega: "2026-11-10", ciudad: "CDE", n_referencia: "VT-9005", venta_id: null, created_at: "2026-11-09T18:00:00Z", tienda: "fw" },
    { nro_guia_pap: "L-VT-9006", guia_transportadora: "77006", transportadora: "lucero", categoria: "entregado", importe: 99000, cobrado: 99000, fecha_entrega: "2026-11-10", ciudad: "CDE", n_referencia: "VT-9006", venta_id: "v6", created_at: "2026-11-09T18:00:00Z", tienda: "voltra" },
  ];
  const ventas = [
    { id: "v1", n_referencia: "VT-9001", pago_anticipado: false, deleted_at: null },
    { id: "v2", n_referencia: "VT-9002", pago_anticipado: true, deleted_at: null },
    { id: "v6", n_referencia: "VT-9006", pago_anticipado: true, deleted_at: "2026-11-11T00:00:00Z" }, // venta borrada
  ];
  const pedidos = [
    { nombre: "#9001", tags: ["CONFIRMADO", "PAGO_VERIFICADO", "PAGADO"], financiero: "paid" },
    { nombre: "#9002", tags: ["CONFIRMADO"], financiero: "pending" },
    { nombre: "#9003", tags: ["CONFIRMADO", "ENTREGADO"], financiero: "paid" }, // contra entrega normal
  ];
  const filas = armarFilas(entregas, ventas, pedidos, "2026-10-07");
  assertEquals(filas.map((f) => [f.ref, f.senal, f.guia]), [["VT-9001", "pagado", "77001"], ["VT-9002", "pagado", "99887766"], ["VT-9003", null, null]]);
});

Deno.test("textos: guía, courier, monto y texto listo para reenviar; sin datos del cliente", () => {
  const t = textoEnCamino(F());
  assertStringIncludes(t, "#9001");
  assertStringIncludes(t, "pedile a Lucero que la guía 77001 pase a ₲0");
  assertStringIncludes(t, "Reenviale esto a Lucero");
  assertStringIncludes(t, "ya está pagado por transferencia: entregar SIN COBRAR (Gs 0)");
  const c = textoCobrado(F({ categoria: "entregado", cobrado: 188000, fechaEntrega: "2026-11-06", courier: "pap", guia: "99887766" }));
  assertStringIncludes(c, "#9001 pagado y figura cobrado ₲188.000");
  assertStringIncludes(c, "posible doble cobro, confirmar con Punto a Punto");
  assertStringIncludes(c, "entregado el 06/11/2026");
  assert(!/Luque|Ana|0981/.test(c), c); // la ciudad solo va en el texto de en camino; nunca nombre ni teléfono
  const p = textoEnCamino(F({ senal: "parcial", saldo: 52000, importe: 112000 }));
  assertStringIncludes(p, "pago parcial");
  assertStringIncludes(p, "₲52.000");
  const r = textoResumenInicial([F({ categoria: "entregado", cobrado: 112000, fechaEntrega: "2026-10-19", ref: "VT-9010" }), F({ categoria: "entregado", cobrado: 153000, fechaEntrega: "2026-10-20", ref: "VT-9011" })]);
  assertStringIncludes(r, "2 pedidos");
  assertStringIncludes(r, "₲265.000");
  assertStringIncludes(r, "#9010");
  assertStringIncludes(r, "#9011");
});

Deno.test("config: sin fila = prendido desde 07-10 con resumen de +14 días; 'apagado' o activo:false lo apaga", () => {
  assertEquals(configPagadoCobro(null), { activo: true, desde: "2026-10-07", diasResumen: 14 });
  assertEquals(configPagadoCobro("apagado").activo, false);
  assertEquals(configPagadoCobro(JSON.stringify({ activo: false })).activo, false);
  assertEquals(configPagadoCobro(JSON.stringify({ desde: "2026-11-01", dias_resumen: 7 })), { activo: true, desde: "2026-11-01", diasResumen: 7 });
  assertEquals(configPagadoCobro("{basura").activo, true);
});

Deno.test("primera corrida: entregados de +14 días van en UN resumen; los recientes, uno por pedido; después, nada repetido", async () => {
  const filas = [
    F({ ref: "VT-9010", categoria: "entregado", cobrado: 112000, fechaEntrega: "2026-10-19" }),
    F({ ref: "VT-9011", categoria: "entregado", cobrado: 153000, fechaEntrega: "2026-10-20" }),
    F({ ref: "VT-9012", categoria: "entregado", cobrado: 158000, fechaEntrega: "2026-11-05" }), // 11 días: individual
    F({ ref: "VT-9013" }), // en camino: individual
    F({ ref: "VT-9014", importe: 0 }), // pagó antes: nada
  ];
  const { d, candados, telegram } = deps();
  const h = await procesarPagadosConCobro(filas, AHORA, CFG, d);
  assertEquals(telegram.length, 3);
  assertStringIncludes(telegram[0].t, "2 pedidos");
  assert(telegram.every((x) => x.tipo === "pagado_con_cobro"));
  assertStringIncludes(telegram[1].t, "#9012 pagado y figura cobrado ₲158.000");
  assertStringIncludes(telegram[2].t, "#9013 pagado: pedile a Lucero");
  assert(candados.has(CANDADO_BASE_PAGADO_COBRO));
  for (const r of ["VT-9010", "VT-9011", "VT-9012"]) assert(candados.has(claveCandadoPagadoCobro("cobrado", r)), r);
  assert(candados.has(claveCandadoPagadoCobro("en_camino", "VT-9013")));
  assertEquals(h.filter((x) => x.resultado === "resumen_inicial").length, 2);
  // segunda corrida: nada nuevo
  const h2 = await procesarPagadosConCobro(filas, AHORA, CFG, d);
  assertEquals(telegram.length, 3);
  assert(h2.every((x) => x.resultado === "ya_avisado"), JSON.stringify(h2));
  // el que estaba en camino se entrega y figura cobrado: segundo caso, un aviso más
  await procesarPagadosConCobro([F({ ref: "VT-9013", categoria: "entregado", cobrado: 158000, fechaEntrega: "2026-11-16" })], AHORA, CFG, d);
  assertEquals(telegram.length, 4);
  assertStringIncludes(telegram[3].t, "posible doble cobro");
});

Deno.test("después de la primera corrida, un entregado viejo nuevo sale solo (no en resumen)", async () => {
  const { d, telegram } = deps({ base: true });
  await procesarPagadosConCobro([F({ ref: "VT-9020", categoria: "entregado", cobrado: 99000, fechaEntrega: "2026-10-01" })], AHORA, CFG, d);
  assertEquals(telegram.length, 1);
  assertStringIncludes(telegram[0].t, "#9020 pagado y figura cobrado");
});

Deno.test("en camino ya avisado al verificar el pago (pago_courier_no_cobrar): no se repite, queda el candado", async () => {
  const { d, candados, telegram } = deps({ base: true, avisadoAlVerificar: ["#9030"] });
  const h = await procesarPagadosConCobro([F({ ref: "VT-9030" })], AHORA, CFG, d);
  assertEquals(telegram.length, 0);
  assertEquals(h[0].resultado, "ya_avisado_al_verificar");
  assert(candados.has(claveCandadoPagadoCobro("en_camino", "VT-9030")));
});

Deno.test("apagado: no hace nada; simular: no toca candados ni Telegram", async () => {
  const filas = [F({ ref: "VT-9040" }), F({ ref: "VT-9041", categoria: "entregado", cobrado: 99000, fechaEntrega: "2026-10-01" })];
  const a = deps();
  assertEquals(await procesarPagadosConCobro(filas, AHORA, { ...CFG, activo: false }, a.d), []);
  assertEquals(a.telegram.length + a.candados.size, 0);
  const s = deps();
  const h = await procesarPagadosConCobro(filas, AHORA, CFG, s.d, true);
  assertEquals(s.telegram.length + s.candados.size, 0);
  assertEquals(h.map((x) => x.resultado), ["simulado", "resumen_inicial (simulado)"]);
});

Deno.test("Telegram caído: el resumen no toma candados (se reintenta en 10 min); el individual suelta el suyo", async () => {
  const filas = [F({ ref: "VT-9050", categoria: "entregado", cobrado: 99000, fechaEntrega: "2026-10-01" }), F({ ref: "VT-9051" })];
  const { d, candados, telegram } = deps({ falla: 6 });
  const h = await procesarPagadosConCobro(filas, AHORA, CFG, d);
  assertEquals(telegram.length, 0);
  assertEquals(candados.size, 0);
  assert(h.every((x) => x.resultado.startsWith("error")), JSON.stringify(h));
});
