// Tests del evento temprano a Meta (LeadSubmitted) para pedidos que nacen de un chat de anuncio.
// Datos inventados (repo público). Nunca llama a Meta: fetch simulado.
import { assert, assertEquals } from "jsr:@std/assert@1";
import { type ConfigLead, enviarEventoLead } from "../_shared/meta_capi.ts";
import { type DepsLeadMeta, idCandadoLead, notificarLeadMeta, type PedidoLead } from "./lead_meta.ts";

const AHORA = new Date("2026-10-08T15:00:00Z");
const CFG: ConfigLead = { token: "tok-falso", datasetMensajeriaId: "ds-msj", wabaId: "waba-1", testEventCode: null };
const PEDIDO: PedidoLead = { shopifyOrderId: 5550001, clienteId: "cli-1", total: 199000, creadoEn: "2026-10-08T14:59:00Z" };

function escenario(op: { clid?: string | null; cfg?: ConfigLead | null; respuesta?: { status: number; body: unknown } } = {}) {
  const llamadas: Array<{ url: string; init: RequestInit; body: Record<string, unknown> }> = [];
  const candados = new Map<string, { payload: unknown; error?: string | null; procesado?: boolean }>();
  const consultas: Array<[string, string, string]> = [];
  const fetchFalso = ((url: string, init: RequestInit) => {
    llamadas.push({ url, init, body: JSON.parse(String(init.body)) });
    const r = op.respuesta ?? { status: 200, body: { events_received: 1 } };
    return Promise.resolve(new Response(JSON.stringify(r.body), { status: r.status }));
  }) as unknown as typeof fetch;
  const deps: DepsLeadMeta = {
    config: () => (op.cfg === undefined ? CFG : op.cfg),
    ahora: () => AHORA,
    origenAnuncio: (cliente, desde, hasta) => {
      consultas.push([cliente, desde, hasta]);
      const clid = op.clid === undefined ? "ARAkLkA8rmlFeiCktEJQ-QTwRiyYHAFDLMNDBH0CD3qpjd0HR4irJ6LEkR7JwFF4XvnO2E4Nx0-eM-GABDLOPaOdRMv-_zfUQ2a" : op.clid;
      return Promise.resolve(clid ? { ctwa_clid: clid } : null);
    },
    reservar: (id, payload) => {
      if (candados.has(id)) return Promise.resolve(false);
      candados.set(id, { payload });
      return Promise.resolve(true);
    },
    registrar: (id, error) => {
      candados.set(id, { ...candados.get(id)!, error, procesado: true });
      return Promise.resolve();
    },
    enviar: (e, cfg) => enviarEventoLead(e, cfg, { ahora: AHORA, fetch: fetchFalso }),
  };
  return { deps, llamadas, candados, consultas };
}

Deno.test("LeadSubmitted: payload correcto al dataset de mensajería, token en el header", async () => {
  const x = escenario();
  assertEquals(await notificarLeadMeta(PEDIDO, x.deps), { accion: "enviado" });
  assertEquals(x.llamadas.length, 1);
  const { url, init, body } = x.llamadas[0];
  assert(url.endsWith("/ds-msj/events"));
  assert(!url.includes("tok-falso"), "el token no va en la URL");
  assertEquals((init.headers as Record<string, string>).Authorization, "Bearer tok-falso");
  assert(init.signal, "con timeout");
  assertEquals(body, {
    data: [{
      event_name: "LeadSubmitted",
      event_time: Math.floor(Date.parse("2026-10-08T14:59:00Z") / 1000),
      event_id: "lead:5550001",
      action_source: "business_messaging",
      messaging_channel: "whatsapp",
      user_data: {
        whatsapp_business_account_id: "waba-1",
        ctwa_clid: "ARAkLkA8rmlFeiCktEJQ-QTwRiyYHAFDLMNDBH0CD3qpjd0HR4irJ6LEkR7JwFF4XvnO2E4Nx0-eM-GABDLOPaOdRMv-_zfUQ2a",
      },
      custom_data: { currency: "PYG", value: 199000 },
    }],
  });
  // Busca el ctwa_clid en los 7 días anteriores al pedido.
  const [cli, desde, hasta] = x.consultas[0];
  assertEquals(cli, "cli-1");
  assertEquals(desde, "2026-10-01T14:59:00.000Z");
  assertEquals(hasta, "2026-10-08T15:00:00.000Z");
  // Queda registrado en el candado, sin error y sin el ctwa_clid.
  const c = x.candados.get(idCandadoLead(5550001))!;
  assertEquals([c.procesado, c.error], [true, null]);
  assert(!JSON.stringify(c.payload).includes("ARAk"));
});

Deno.test("LeadSubmitted: manda UNA sola vez (candado) aunque el pedido llegue dos veces", async () => {
  const x = escenario();
  await notificarLeadMeta(PEDIDO, x.deps);
  assertEquals(await notificarLeadMeta(PEDIDO, x.deps), { accion: "omitido", motivo: "ya_enviado" });
  assertEquals(x.llamadas.length, 1);
});

Deno.test("LeadSubmitted: sin ctwa_clid, sin variables o pedido viejo no manda ni toma el candado", async () => {
  for (const [op, motivo] of [[{ clid: null }, "sin_ctwa_clid"], [{ clid: "  " }, "sin_ctwa_clid"], [{ cfg: null }, "sin_config"]] as const) {
    const x = escenario(op);
    assertEquals(await notificarLeadMeta(PEDIDO, x.deps), { accion: "omitido", motivo });
    assertEquals(x.llamadas.length, 0);
    assertEquals(x.candados.size, 0);
  }
  const v = escenario();
  assertEquals(await notificarLeadMeta({ ...PEDIDO, creadoEn: "2026-09-28T12:00:00Z" }, v.deps), { accion: "omitido", motivo: "fuera_de_plazo_7_dias" });
  assertEquals(v.llamadas.length, 0);
});

Deno.test("LeadSubmitted: error de Meta queda registrado en el candado y no tira", async () => {
  const x = escenario({ respuesta: { status: 400, body: { error: { message: "Invalid parameter" } } } });
  assertEquals(await notificarLeadMeta(PEDIDO, x.deps), { accion: "error", motivo: "Invalid parameter" });
  assertEquals(x.candados.get(idCandadoLead(5550001))!.error, "Invalid parameter");
});
