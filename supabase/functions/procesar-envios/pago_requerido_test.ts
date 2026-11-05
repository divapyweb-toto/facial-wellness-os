// 05-11: pago anticipado OBLIGATORIO en el prio:<id> de los pedidos del bot (cliente con devoluciones previas).
// Datos inventados.
import { assert, assertEquals } from "jsr:@std/assert@1";
import { type Config, CONFIG_DEFECTO, configDesdeFilas, type Contexto, type Deps, type Envio, type Horario, procesarLote } from "./procesar.ts";

const AHORA = new Date("2026-10-12T15:00:00Z");
const ABIERTA = new Date("2026-10-12T10:00:00Z");
const horario: Horario = { dentro: () => true, proxima: () => new Date("2026-10-13T11:00:00Z") };
const PP_ON = { activo: true, alias: "alias@ejemplo.com", titular: "Voltra E.A.S." };
const REQ_ON = { activo: true, min_devoluciones: 1 };
const cfg = (x: Partial<Config> = {}): Config => ({ ...CONFIG_DEFECTO, pagoPrioridad: PP_ON, pagoRequerido: REQ_ON, ...x });

const TEXTO_OFERTA = "📦 ¡Tu pedido quedó confirmado!\nSi querés recibirlo antes, podés pagarlo ahora por transferencia y sale con prioridad en el primer despacho.\n💳 Transferí a: alias@ejemplo.com — Voltra E.A.S.\nSi preferís, pagás al recibir como siempre 👍";
const TEXTO_REQ = "📦 ¡Tu pedido #9001 quedó confirmado! Esta vez te pedimos pagarlo por adelantado por transferencia (Gs 129.000) y sale en el primer despacho.\n💳 Transferí a: alias@ejemplo.com — Voltra E.A.S.\nMandanos la foto del comprobante por acá 🙌";

const prio = (): Envio => ({
  id: "p1", cliente_id: "c1", shopify_order_id: 9001, plantilla: "voltra_pago_prioridad", variables: {}, categoria: "utilidad",
  enviar_desde: AHORA.toISOString(), estado: "pendiente", clave_unica: "prio:9001", intentos: 0, ultimo_error: null,
});
const ctx = (tags: string[] = ["ORIGEN_WHATSAPP", "CONFIRMADO", "OFERTA_PAGO_ANTICIPADO"], x: Partial<Contexto> = {}): Contexto => ({
  cliente: { telefono: "+595981000111", wa_user_id: null, nombre: "Ana Prueba" },
  pedido: { shopify_order_id: 9001, nombre: "#9001", estado_confirmacion: "confirmado", tags, total: 129000, raw: { shipping_address: { city: "Ciudad Prueba" } } },
  consentimientoMarketing: null,
  ultimaEntrada: ABIERTA,
  conversacionId: "conv1",
  ...x,
});

type Op = { config?: Config; contexto?: Contexto; devoluciones?: number | Error; falla?: (t: string) => boolean };
async function correr(op: Op = {}) {
  const log = {
    textos: [] as string[], cambios: [] as unknown[], oferta: [] as number[], requerido: [] as [number, Record<string, unknown>][],
    conteos: 0, avisos: [] as string[], orden: [] as string[],
  };
  const d: Deps = {
    ahora: () => AHORA,
    cfg: op.config ?? cfg(),
    horario,
    reclamar: () => Promise.resolve([prio()]),
    contexto: () => Promise.resolve(op.contexto ?? ctx()),
    actualizarEnvio: (_id, c) => (log.cambios.push(c), Promise.resolve()),
    enviarPlantilla: () => Promise.resolve({ ok: true }),
    enviarTexto: (_to, t) => {
      log.orden.push(t.startsWith("📦 ¡Tu pedido #") ? "envio:requerido" : "envio:oferta");
      if (op.falla?.(t)) return Promise.resolve({ ok: false, error: "131026: undeliverable" });
      log.textos.push(t);
      return Promise.resolve({ ok: true, wa_message_id: "wamid.P" });
    },
    enviarBotones: () => Promise.resolve({ ok: true }),
    retenerPedido: () => Promise.resolve({ ok: true }),
    cancelarPedidoSinRespuesta: () => Promise.resolve({ ok: true }),
    avisar: (t) => (log.avisos.push(t), Promise.resolve({ ok: true })),
    escapar: (x) => String(x ?? ""),
    marcarOfertaPrioridad: (id) => (log.oferta.push(id), log.orden.push("tag:oferta"), Promise.resolve({ ok: true })),
    devolucionesPrevias: () => {
      log.conteos++;
      return op.devoluciones instanceof Error ? Promise.reject(op.devoluciones) : Promise.resolve(op.devoluciones ?? 0);
    },
    marcarPagoRequerido: (id, p) => (log.requerido.push([id, p]), log.orden.push("candado+tags:requerido"), Promise.resolve({ ok: true })),
  };
  const r = await procesarLote(d);
  return { r, log };
}

Deno.test("requerido: apagado por defecto → exactamente la oferta de siempre (ni cuenta devoluciones)", async () => {
  assertEquals(configDesdeFilas([]).pagoRequerido, { activo: false, min_devoluciones: 1 });
  assertEquals(configDesdeFilas([{ clave: "pago_anticipado", valor: { texto_recibido: "x" } }]).pagoRequerido.activo, false);
  const { log } = await correr({ config: cfg({ pagoRequerido: { activo: false, min_devoluciones: 1 } }), devoluciones: 3 });
  assertEquals(log.textos, [TEXTO_OFERTA]);
  assertEquals(log.conteos, 0);
  assertEquals(log.oferta, [9001]);
  assertEquals(log.requerido, []);
});

Deno.test("requerido: >= 1 devolución → texto obligatorio; candado + tags recién después del envío OK; sin la oferta", async () => {
  assertEquals(configDesdeFilas([{ clave: "pago_anticipado", valor: { requerido: { activo: true } } }]).pagoRequerido, REQ_ON);
  const { r, log } = await correr({ devoluciones: 2 });
  assertEquals(r.enviados, 1);
  assertEquals(log.textos, [TEXTO_REQ]);
  assertEquals(log.orden, ["envio:requerido", "candado+tags:requerido"]);
  assertEquals(log.requerido.length, 1);
  assertEquals(log.requerido[0][0], 9001);
  assertEquals(log.requerido[0][1].devoluciones, 2);
  assertEquals(log.oferta, []); // el tag OFERTA va dentro de marcarPagoRequerido
  assertEquals(log.cambios, [{ estado: "enviado", intentos: 1, ultimo_error: null, wa_message_id: "wamid.P" }]);
});

Deno.test("requerido: 0 devoluciones, por debajo del mínimo o no se pudo contar → oferta normal, sin candado", async () => {
  for (const [nombre, op] of [
    ["cero", { devoluciones: 0 }],
    ["mínimo 2", { devoluciones: 1, config: cfg({ pagoRequerido: { activo: true, min_devoluciones: 2 } }) }],
    ["falla el conteo", { devoluciones: new Error("db caída") }],
  ] as [string, Op][]) {
    const { log } = await correr(op);
    assertEquals(log.textos, [TEXTO_OFERTA], nombre);
    assertEquals(log.requerido, [], nombre);
    assertEquals(log.oferta, [9001], nombre);
  }
});

Deno.test("requerido: ventana cerrada → no sale nada (como siempre), ni se cuenta ni se marca", async () => {
  const { r, log } = await correr({ devoluciones: 3, contexto: ctx(undefined, { ultimaEntrada: null }) });
  assertEquals(r.cancelados, 1);
  assertEquals(log.textos, []);
  assertEquals(log.conteos, 0);
  assertEquals(log.requerido, []);
});

Deno.test("requerido: ya pagado → nada; SIN_COBERTURA o retiro → nada nuevo (comportamiento de hoy)", async () => {
  const pagado = await correr({ devoluciones: 3, contexto: ctx(["ORIGEN_WHATSAPP", "CONFIRMADO", "PAGADO"]) });
  assertEquals(pagado.log.textos, []);
  assertEquals(pagado.log.requerido, []);
  const sc = await correr({ devoluciones: 3, contexto: ctx(["ORIGEN_WHATSAPP", "CONFIRMADO", "OFERTA_PAGO_ANTICIPADO", "SIN_COBERTURA"]) });
  assertEquals(sc.log.textos, [TEXTO_OFERTA]);
  assertEquals(sc.log.requerido, []);
  const ret = await correr({ devoluciones: 3, contexto: ctx(["ORIGEN_WHATSAPP", "CONFIRMADO", "RETIRO_EN_CASA"]) });
  assertEquals(ret.log.textos, []);
  assertEquals(ret.log.requerido, []);
});

Deno.test("requerido: si el envío del obligatorio falla → ni tag ni candado; sale la oferta normal", async () => {
  const { r, log } = await correr({ devoluciones: 2, falla: (t) => t.startsWith("📦 ¡Tu pedido #") });
  assertEquals(log.orden, ["envio:requerido", "envio:oferta", "tag:oferta"]);
  assertEquals(log.textos, [TEXTO_OFERTA]);
  assertEquals(log.requerido, []);
  assertEquals(r.enviados, 1);
  // Fallan los dos: ni tag ni candado; reintento normal.
  const dos = await correr({ devoluciones: 2, falla: () => true });
  assertEquals(dos.log.requerido, []);
  assertEquals(dos.log.oferta, []);
  assertEquals(dos.r.reintentos, 1);
});

Deno.test("requerido: si no se pudo registrar candado/tags, aviso al admin (el mensaje ya salió)", async () => {
  assertEquals((await correr({ devoluciones: 1 })).log.avisos, []);
  const r2 = await (async () => {
    const out = { avisos: [] as string[] };
    const d: Deps = {
      ahora: () => AHORA, cfg: cfg(), horario, reclamar: () => Promise.resolve([prio()]), contexto: () => Promise.resolve(ctx()),
      actualizarEnvio: () => Promise.resolve(), enviarPlantilla: () => Promise.resolve({ ok: true }),
      enviarTexto: () => Promise.resolve({ ok: true }), enviarBotones: () => Promise.resolve({ ok: true }),
      retenerPedido: () => Promise.resolve({ ok: true }), cancelarPedidoSinRespuesta: () => Promise.resolve({ ok: true }),
      avisar: (t) => (out.avisos.push(t), Promise.resolve({ ok: true })), escapar: (x) => String(x ?? ""),
      devolucionesPrevias: () => Promise.resolve(1),
      marcarPagoRequerido: () => Promise.resolve({ ok: false, error: "Shopify: sin permiso" }),
    };
    await procesarLote(d);
    return out;
  })();
  assertEquals(r2.avisos.length, 1);
  assert(r2.avisos[0].includes("PAGO_ANTICIPADO_REQUERIDO") && r2.avisos[0].includes("sin permiso"));
});
