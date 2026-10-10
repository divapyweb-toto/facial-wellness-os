// 10-10 confirmación rápida: avi (Telegram), ult (último aviso), canc (≥ 24 h, 8 a 20 h), cmsg (tras cancelar OK).
// Datos inventados (0981000000, "Ana"). Correr: cd supabase/functions && deno test --no-check -A procesar-envios/
import { assert, assertEquals, assertMatch } from "jsr:@std/assert@1";
import { dentroHorarioMarketing, proximaAperturaMarketing } from "../_shared/horario.ts";
import { CONFIG_DEFECTO, type Contexto, decidir, type Deps, type Envio, type FilaNueva, procesarLote, tipoEnvio } from "./procesar.ts";

const horario = { dentro: dentroHorarioMarketing, proxima: proximaAperturaMarketing };
const cfg = { ...CONFIG_DEFECTO };
const CREADO = "2026-10-08T12:00:00Z"; // 09:00 en Asunción
const h = (n: number) => new Date(new Date(CREADO).getTime() + n * 3_600_000);

const VARS = { nombre: "Ana María", productos: "1 Tiras nasales", total: 129000, total_texto: "129.000", pedido: "#1001", telefono: "+595981000000" };
const envio = (clave: string, plantilla: string, x: Partial<Envio> = {}): Envio => ({
  id: clave, cliente_id: "c1", shopify_order_id: 1001, plantilla, variables: VARS, categoria: "utilidad",
  enviar_desde: CREADO, estado: "pendiente", clave_unica: `${clave}:1001`, intentos: 0, ultimo_error: null, ...x,
});
const ctx = (estado = "pendiente"): Contexto => ({
  cliente: { telefono: "+595981000000", wa_user_id: null, nombre: "Ana" },
  pedido: { shopify_order_id: 1001, nombre: "#1001", estado_confirmacion: estado, tags: [], total: 129000, raw: { created_at: "2026-10-08T09:00:00-03:00" }, creado_en: CREADO },
  consentimientoMarketing: null, ultimaEntrada: null, conversacionId: "conv1",
});

const AVI = envio("avi", "accion:aviso_enrique");
const ULT = envio("ult", "voltra_ultimo_aviso_confirmacion");
const CANC = envio("canc", "accion:cancelar");
const CMSG = envio("cmsg", "voltra_pedido_cancelado_sin_respuesta");

Deno.test("ult: body nombre/productos/total y botones conf_si:<id> / conf_cancelar:<id>; de noche se corre a las 8:00", () => {
  const d = decidir(ULT, ctx(), cfg, h(24), horario); // 09:00 PY
  assert(d.accion === "plantilla");
  assertEquals(d.nombre, "voltra_ultimo_aviso_confirmacion");
  assertEquals(d.valores, ["Ana", "1 Tiras nasales", "129.000"]);
  const pay = (d.componentes as { type: string; parameters: { payload?: string }[] }[]).filter((c) => c.type === "button")
    .map((c) => c.parameters[0].payload);
  assertEquals(pay, ["conf_si:1001", "conf_cancelar:1001"]);
  const noche = decidir(ULT, ctx(), cfg, new Date("2026-10-09T02:00:00Z"), horario); // 23:00 PY
  assertEquals(noche.accion === "reprogramar" && noche.enviar_desde.toISOString(), "2026-10-09T11:00:00.000Z");
  assertEquals(decidir(ULT, ctx("confirmado"), cfg, h(24), horario).accion, "cancelar");
});

Deno.test("cmsg: payload reactivar:<id>, body nombre/productos; solo si quedó cancelado_sin_respuesta", () => {
  const d = decidir(CMSG, ctx("cancelado_sin_respuesta"), cfg, h(49), horario);
  assert(d.accion === "plantilla");
  assertEquals(d.valores, ["Ana", "1 Tiras nasales"]);
  const pay = (d.componentes as { type: string; parameters: { payload?: string }[] }[]).filter((c) => c.type === "button")
    .map((c) => c.parameters[0].payload);
  assertEquals(pay, ["reactivar:1001"]);
  for (const est of ["pendiente", "confirmado", "cancelado_cliente"]) assertEquals(decidir(CMSG, ctx(est), cfg, h(49), horario).accion, "cancelar");
});

Deno.test("canc: nunca antes de 24 h del pedido; de noche a las 8:00; de día cancela", () => {
  assertEquals(tipoEnvio(CANC), "canc");
  const temprano = decidir(CANC, ctx(), cfg, h(5), horario);
  assertEquals(temprano.accion === "reprogramar" && temprano.enviar_desde.toISOString(), h(24).toISOString());
  const noche = decidir(CANC, ctx(), cfg, new Date("2026-10-10T03:00:00Z"), horario); // 00:00 PY, 63 h
  assertEquals(noche.accion === "reprogramar" && noche.enviar_desde.toISOString(), "2026-10-10T11:00:00.000Z");
  assertEquals(decidir(CANC, ctx(), cfg, h(48), horario), { accion: "cancelar_pedido" }); // 09:00 PY
  assertEquals(decidir(CANC, ctx("retenido"), cfg, h(48), horario), { accion: "cancelar_pedido" });
});

Deno.test("avi: Telegram a Enrique solo si sigue pendiente (link wa.me, hora PY, botones escribo/cancelar)", () => {
  assertEquals(decidir(AVI, ctx(), cfg, h(3), horario), { accion: "aviso_enrique" });
  assertEquals(decidir(AVI, ctx("confirmado"), cfg, h(3), horario).accion, "cancelar");
});

function fakes(envios: Envio[], estado: string, cancelaOk = true) {
  const log = { cambios: {} as Record<string, unknown>, avisos: [] as { t: string; b?: unknown }[], cancelados: [] as number[], programados: [] as FilaNueva[], wa: [] as string[] };
  const d: Deps = {
    ahora: () => h(48), cfg, horario,
    reclamar: () => Promise.resolve(envios),
    contexto: () => Promise.resolve(ctx(estado)),
    actualizarEnvio: (id, c) => { log.cambios[id] = c; return Promise.resolve(); },
    enviarPlantilla: (_t, n) => { log.wa.push(n); return Promise.resolve({ ok: true }); },
    enviarTexto: () => Promise.resolve({ ok: true }),
    enviarBotones: () => Promise.resolve({ ok: true }),
    retenerPedido: () => Promise.resolve({ ok: true }),
    cancelarPedidoSinRespuesta: (id) => { log.cancelados.push(id); return Promise.resolve(cancelaOk ? { ok: true } : { ok: false, error: "Shopify 503" }); },
    avisar: (t, b) => { log.avisos.push({ t, b }); return Promise.resolve({ ok: true }); },
    escapar: (s) => String(s ?? ""),
    programarEnvio: (f) => { log.programados.push(f); return Promise.resolve(); },
  };
  return { d, log };
}

Deno.test("procesarLote: aviso a Enrique con datos del pedido; sin WhatsApp", async () => {
  const { d, log } = fakes([AVI], "pendiente");
  d.ahora = () => h(3);
  await procesarLote(d);
  assertEquals(log.wa, []);
  assertEquals(log.avisos.length, 1);
  const t = log.avisos[0].t;
  for (const x of ["#1001", "1 Tiras nasales", "129.000", "08/10 09:00", "https://wa.me/595981000000"]) assertMatch(t, new RegExp(x.replace(/[.\/]/g, "\\$&")));
  assertEquals(JSON.stringify(log.avisos[0].b).includes("escribo:1001") && JSON.stringify(log.avisos[0].b).includes("cancelar:1001"), true);
  assertEquals((log.cambios.avi as { estado: string }).estado, "enviado");
});

Deno.test("cliente respondió a las 47 h (confirmado): avi/ult/canc se cancelan y el pedido NO se cancela", async () => {
  const { d, log } = fakes([AVI, ULT, CANC], "confirmado");
  const r = await procesarLote(d);
  assertEquals(r.cancelados, 3);
  assertEquals(log.cancelados, []);
  assertEquals(log.avisos, []);
  assertEquals(log.programados, []);
});

Deno.test("cancelación OK → Telegram '48 h' y se programa cmsg:<id>; si Shopify falla, no hay cmsg", async () => {
  const ok = fakes([CANC], "pendiente");
  await procesarLote(ok.d);
  assertEquals(ok.log.cancelados, [1001]);
  assertMatch(ok.log.avisos[0].t, /Pedido #1001 cancelado: 48 h sin confirmar/);
  assertEquals(ok.log.programados.map((f) => [f.clave_unica, f.plantilla, f.cliente_id]), [["cmsg:1001", "voltra_pedido_cancelado_sin_respuesta", "c1"]]);
  const mal = fakes([CANC], "pendiente", false);
  await procesarLote(mal.d);
  assertEquals(mal.log.programados, []);
  assertEquals((mal.log.cambios.canc as { estado: string }).estado, "pendiente");
  // Si programar el cmsg falla, la cancelación queda igual (solo aviso).
  const rompe = fakes([CANC], "pendiente");
  rompe.d.programarEnvio = () => Promise.reject(new Error("db"));
  await procesarLote(rompe.d);
  assertEquals((rompe.log.cambios.canc as { estado: string }).estado, "enviado");
  assertMatch(rompe.log.avisos[1].t, /No se programó el aviso de baja/);
});
