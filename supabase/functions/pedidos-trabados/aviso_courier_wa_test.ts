// 18-11: avisos directos a la transportadora por WhatsApp (interruptor config_wa.transportadoras.avisos_por_whatsapp).
// Datos inventados (N.º 9xxx, guías falsas).
import { assert, assertEquals, assertStringIncludes } from "@std/assert";
import { avisarPorCourier, avisosPorWhatsapp, claveAvisoCourier, courierWa, type EnviarACourier } from "./aviso_courier_wa.ts";
import {
  CANDADO_BASE_PAGADO_COBRO, configPagadoCobro, type DepsPagadoCobro, type FilaPagadoCobro, procesarPagadosConCobro, textoCourierEnCamino,
  textoEnCamino,
} from "./pagados_con_cobro.ts";
import { avisarCancelacion, textoCourierCancelado } from "./cancelaciones_ventas.ts";
import { type DepsCasos, enviarCasos, type EnvioCasos } from "./casos_courier_envio.ts";
import type { CasoCourier } from "../_shared/casos_courier.ts";

const AHORA = new Date("2026-11-18T14:00:00Z"); // miércoles 11:00 PY

function enviarFalso(o: { falla?: boolean } = {}) {
  const enviados: Array<{ courier: string; ref: string; texto: string; clave: string }> = [];
  const enviar: EnviarACourier = (a) => {
    enviados.push(a);
    return Promise.resolve(o.falla ? { ok: false, error: "ventana cerrada y plantilla rechazada" } : { ok: true, wamid: "wamid.DEMO" });
  };
  return { enviar, enviados };
}
function telegramFalso() {
  const tg: Array<{ t: string; tipo?: string }> = [];
  const avisar: DepsPagadoCobro["avisar"] = (t, _b, opts) => (tg.push({ t, tipo: opts?.tipo }), Promise.resolve({ ok: true }));
  return { avisar, tg };
}

Deno.test("interruptor: solo true explícito prende; falta, false u otro valor = Telegram de siempre", () => {
  assertEquals(avisosPorWhatsapp({ avisos_por_whatsapp: true }), true);
  assertEquals(avisosPorWhatsapp({ avisos_por_whatsapp: false }), false);
  assertEquals(avisosPorWhatsapp({ avisos_por_whatsapp: "true" }), false);
  assertEquals(avisosPorWhatsapp({ activo: true }), false);
  assertEquals(avisosPorWhatsapp(null), false);
  assertEquals(courierWa("Lucero"), "lucero");
  assertEquals(courierWa("pap"), "pap");
  assertEquals(courierWa("aex"), null);
  assertEquals(claveAvisoCourier("VT-9001", "pagado_no_cobrar", AHORA), "pagado_no_cobrar:VT-9001:2026-11-18");
});

Deno.test("avisarPorCourier: apagado → Telegram con el texto de Enrique; prendido → WhatsApp con el texto del courier; error → Telegram", async () => {
  const a = { courier: "lucero", ref: "VT-9001", textoCourier: "Hola, DEMO", clave: "k1" };
  // apagado
  let e = enviarFalso(), t = telegramFalso();
  let r = await avisarPorCourier({ activo: false, enviar: e.enviar }, t.avisar, a)("texto Enrique");
  assertEquals([r.ok, r.via, e.enviados.length, t.tg.length], [true, "telegram", 0, 1]);
  // prendido pero sin courier_wa conectado todavía → Telegram
  t = telegramFalso();
  r = await avisarPorCourier({ activo: true }, t.avisar, a)("texto Enrique");
  assertEquals([r.via, t.tg.length], ["telegram", 1]);
  // prendido: WhatsApp a la transportadora, nada a Enrique
  e = enviarFalso(); t = telegramFalso();
  r = await avisarPorCourier({ activo: true, enviar: e.enviar }, t.avisar, a)("texto Enrique");
  assertEquals([r.ok, r.via, t.tg.length], [true, "whatsapp", 0]);
  assertEquals(e.enviados, [{ courier: "lucero", ref: "VT-9001", texto: "Hola, DEMO", clave: "k1" }]);
  // prendido, courier que no es Lucero/PaP → Telegram
  e = enviarFalso(); t = telegramFalso();
  r = await avisarPorCourier({ activo: true, enviar: e.enviar }, t.avisar, { ...a, courier: "aex" })("texto Enrique");
  assertEquals([r.via, e.enviados.length, t.tg.length], ["telegram", 0, 1]);
  // prendido con error → Telegram de siempre (con el texto de Enrique)
  e = enviarFalso({ falla: true }); t = telegramFalso();
  r = await avisarPorCourier({ activo: true, enviar: e.enviar }, t.avisar, a)("texto Enrique");
  assertEquals([r.ok, r.via, e.enviados.length, t.tg[0]?.t], [true, "telegram", 1, "texto Enrique"]);
  assertStringIncludes(r.errorWhatsapp ?? "", "ventana cerrada");
  // enviar que tira excepción → también cae al Telegram
  t = telegramFalso();
  r = await avisarPorCourier({ activo: true, enviar: () => Promise.reject(new Error("caído")) }, t.avisar, a)("texto Enrique");
  assertEquals([r.via, t.tg.length], ["telegram", 1]);
});

// ── pagados_con_cobro ──
const F = (o: Partial<FilaPagadoCobro> = {}): FilaPagadoCobro => ({
  ref: "VT-9001", courier: "lucero", categoria: "en_proceso", importe: 158000, cobrado: 0, guia: "77001", ciudad: "Luque",
  fechaEntrega: null, senal: "pagado", saldo: null, ...o,
});
function depsPagados(canal?: DepsPagadoCobro["canalCourier"]) {
  const candados = new Set<string>([CANDADO_BASE_PAGADO_COBRO]);
  const t = telegramFalso();
  const d: DepsPagadoCobro = {
    tomarCandado: (id) => Promise.resolve(candados.has(id) ? false : (candados.add(id), true)),
    soltarCandado: (id) => Promise.resolve(void candados.delete(id)),
    existeCandado: (id) => Promise.resolve(candados.has(id)),
    avisar: t.avisar, esperar: () => Promise.resolve(), canalCourier: canal,
  };
  return { d, tg: t.tg, candados };
}

Deno.test("texto para el courier: es el bloque que hoy Enrique reenvía, sin HTML ni instrucciones internas", () => {
  const f = F({ guia: "77<01" });
  const c = textoCourierEnCamino(f);
  assertStringIncludes(c, "Hola, el pedido #9001 (guía 77<01), destino Luque, ya está pagado por transferencia: entregar SIN COBRAR (Gs 0)");
  assert(!c.includes("&lt;") && !c.includes("pedile") && !c.includes("Reenviale"));
  // el Telegram de Enrique sigue igual y contiene el mismo bloque (escapado)
  assertStringIncludes(textoEnCamino(f), "Reenviale esto a Lucero:\n\nHola, el pedido #9001 (guía 77&lt;01)");
});

Deno.test("pagados en camino: apagado = Telegram igual que antes; prendido = WhatsApp al courier con clave estable; error = Telegram", async () => {
  // apagado (sin canal)
  let x = depsPagados();
  let h = await procesarPagadosConCobro([F()], AHORA, configPagadoCobro(null), x.d);
  assertEquals([h[0].resultado, x.tg.length], ["avisado", 1]);
  assertStringIncludes(x.tg[0].t, "pedile a Lucero");
  // prendido
  const e = enviarFalso();
  x = depsPagados({ activo: true, enviar: e.enviar });
  h = await procesarPagadosConCobro([F()], AHORA, configPagadoCobro(null), x.d);
  assertEquals([h[0].resultado, x.tg.length, e.enviados.length], ["avisado", 0, 1]);
  assertEquals(e.enviados[0].courier, "lucero");
  assertEquals(e.enviados[0].clave, "pagado_no_cobrar:VT-9001:2026-11-18");
  assertEquals(e.enviados[0].texto, textoCourierEnCamino(F()));
  // una vez: la segunda corrida no repite (candado)
  await procesarPagadosConCobro([F()], AHORA, configPagadoCobro(null), x.d);
  assertEquals(e.enviados.length, 1);
  // error → Telegram
  const mal = enviarFalso({ falla: true });
  x = depsPagados({ activo: true, enviar: mal.enviar });
  h = await procesarPagadosConCobro([F()], AHORA, configPagadoCobro(null), x.d);
  assertEquals([h[0].resultado, x.tg.length], ["avisado", 1]);
  assertStringIncludes(x.tg[0].t, "pedile a Lucero");
});

Deno.test("pagados cobrado (posible doble cobro) sigue SOLO por Telegram aunque esté prendido", async () => {
  const e = enviarFalso();
  const x = depsPagados({ activo: true, enviar: e.enviar });
  await procesarPagadosConCobro([F({ categoria: "entregado", cobrado: 158000, fechaEntrega: "2026-11-17" })], AHORA, configPagadoCobro(null), x.d);
  assertEquals([e.enviados.length, x.tg.length], [0, 1]);
  assertStringIncludes(x.tg[0].t, "posible doble cobro");
});

// ── cancelaciones ──
Deno.test("cancelado ya en el courier: apagado = Telegram de siempre; prendido = WhatsApp con texto para el courier; error = Telegram", async () => {
  const f = { shopify_order_id: 5550001, nombre: "#9091", ref: "VT-9091", clase: "cancelado_en_courier" as const, courier: "lucero" };
  assertEquals(textoCourierCancelado(f), "Hola, el pedido VT-9091 fue cancelado por el cliente. Por favor no lo entreguen y devuélvanlo a Voltra. Gracias.");
  let t = telegramFalso();
  let r = await avisarCancelacion(f, { avisar: t.avisar, esperar: () => Promise.resolve() }, undefined, AHORA);
  assertEquals([r, t.tg.length], ["", 1]);
  assertStringIncludes(t.tg[0].t, "pedir que lo retengan");
  const e = enviarFalso();
  t = telegramFalso();
  r = await avisarCancelacion(f, { avisar: t.avisar, esperar: () => Promise.resolve() }, { activo: true, enviar: e.enviar }, AHORA);
  assertEquals([r, t.tg.length, e.enviados.length], ["", 0, 1]);
  assertEquals(e.enviados[0], { courier: "lucero", ref: "VT-9091", texto: textoCourierCancelado(f), clave: "cancelado_en_courier:VT-9091:2026-11-18" });
  const mal = enviarFalso({ falla: true });
  t = telegramFalso();
  r = await avisarCancelacion(f, { avisar: t.avisar, esperar: () => Promise.resolve() }, { activo: true, enviar: mal.enviar }, AHORA);
  assertEquals([r, t.tg.length], ["", 1]);
  // reemplazo en courier: siempre Telegram (necesita criterio de Enrique)
  const e2 = enviarFalso();
  t = telegramFalso();
  await avisarCancelacion({ ...f, clase: "reemplazo_en_courier" }, { avisar: t.avisar, esperar: () => Promise.resolve() }, { activo: true, enviar: e2.enviar }, AHORA);
  assertEquals([e2.enviados.length, t.tg.length], [0, 1]);
});

// ── casos_courier_envio ──
const CASO = (o: Partial<CasoCourier> = {}): CasoCourier => ({
  id: "c-demo-1", ref: "VT-9101", courier: "pap", origen: "sistema", tipo: "plazo", pide: "DEMO", estado: "pendiente", urgente: false,
  creado_en: "2026-11-18T10:00:00Z", enviado_en: null, lote: null, ...o,
} as CasoCourier);
function depsCasos(canal?: DepsCasos["canalCourier"]) {
  const candados = new Set<string>(), marcados: string[] = [];
  const t = telegramFalso();
  const d: DepsCasos = {
    tomarCandado: (id) => Promise.resolve(candados.has(id) ? false : (candados.add(id), true)),
    soltarCandado: (id) => Promise.resolve(void candados.delete(id)),
    existeCandado: (id) => Promise.resolve(candados.has(id)),
    avisar: t.avisar, esperar: () => Promise.resolve(),
    marcarEnviados: (cs) => (marcados.push(...cs.map((c) => c.ref)), Promise.resolve()),
    canalCourier: canal,
  };
  return { d, tg: t.tg, marcados };
}
const ENVIO: EnvioCasos = { clave: "auto_casos_courier:2026-11-18:am:pap", lote: "2026-11-18:am:pap", courier: "pap", urgente: false, casos: [CASO()], conRendiciones: false };

Deno.test("casos para el courier: apagado = Telegram con el bloque copiable; prendido = WhatsApp con el texto plano; error = Telegram", async () => {
  let x = depsCasos();
  let h = await enviarCasos([ENVIO], new Map(), [], AHORA, x.d);
  assertEquals([h[0].resultado, x.tg.length, x.marcados], ["enviado", 1, ["VT-9101"]]);
  assertStringIncludes(x.tg[0].t, "Copiá y pegá");
  const e = enviarFalso();
  x = depsCasos({ activo: true, enviar: e.enviar });
  h = await enviarCasos([ENVIO], new Map(), [], AHORA, x.d);
  assertEquals([h[0].resultado, x.tg.length, e.enviados.length, x.marcados], ["enviado", 0, 1, ["VT-9101"]]);
  assertEquals(e.enviados[0].courier, "pap");
  assertEquals(e.enviados[0].clave, "casos:2026-11-18:am:pap:1");
  assert(!e.enviados[0].texto.includes("<pre>") && !e.enviados[0].texto.includes("Copiá"));
  assertStringIncludes(e.enviados[0].texto, "VT-9101");
  const mal = enviarFalso({ falla: true });
  x = depsCasos({ activo: true, enviar: mal.enviar });
  h = await enviarCasos([ENVIO], new Map(), [], AHORA, x.d);
  assertEquals([h[0].resultado, x.tg.length], ["enviado", 1]);
  assertStringIncludes(x.tg[0].t, "Copiá y pegá");
});
