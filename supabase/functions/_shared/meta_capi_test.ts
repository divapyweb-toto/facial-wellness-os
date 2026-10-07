// Datos inventados (repo público). Nunca llama a Meta: fetch falso o modo simulado.
import { assert, assertEquals, assertFalse } from "jsr:@std/assert@1";
import {
  armarPayloadMensajeria,
  armarPayloadPrincipal,
  dentroDePlazo,
  enviarEventoEntregado,
  eventTime,
  normalizarTelefonoCapi,
  sha256Hex,
} from "./meta_capi.ts";

const AHORA = new Date("2026-10-06T15:00:00Z");
const ENTRADA = {
  pedido: { shopify_order_id: 9001, nombre: "#1001", cliente_id: "cli-1", entregado_en: "2026-10-05T15:00:00Z" },
  telefonoE164: "+595981000000",
  valor: 129000,
  moneda: "PYG" as const,
};

Deno.test("hash del teléfono: ejemplo de la documentación de Meta", async () => {
  // Doc "Customer Information Parameters": (650)555-1212 → 16505551212 → e323ec62...
  // (la doc agrega el código de país 1; acá el teléfono ya llega en E.164 con el código).
  assertEquals(normalizarTelefonoCapi("+1 (650) 555-1212"), "16505551212");
  assertEquals(
    await sha256Hex(normalizarTelefonoCapi("+1 (650) 555-1212")!),
    "e323ec626319ca94ee8bff2e4c87cf613be6ea19919ed1364124e16807ab3176",
  );
});

Deno.test("hash del país: ejemplo de la documentación ('us')", async () => {
  assertEquals(await sha256Hex("us"), "79adb2a2fce5c6ba215fe5f27f532d4e7edbac4b6a5e09e1ef3a08084a904621");
});

Deno.test("teléfono E.164 de Paraguay: sin '+', sin espacios", () => {
  assertEquals(normalizarTelefonoCapi("+595981000000"), "595981000000");
  assertEquals(normalizarTelefonoCapi("+595 981 000-000"), "595981000000");
  assertEquals(normalizarTelefonoCapi(""), null);
  assertEquals(normalizarTelefonoCapi(null), null);
});

Deno.test("payload principal: evento propio, system_generated, PYG, event_id estable", async () => {
  const p = await armarPayloadPrincipal(ENTRADA, { ahora: AHORA });
  const ev = (p.data as Record<string, unknown>[])[0];
  assertEquals(ev.event_name, "PedidoEntregado");
  assertEquals(ev.action_source, "system_generated");
  assertEquals(ev.event_id, "entregado:9001");
  assertEquals(ev.event_time, Math.floor(Date.parse("2026-10-05T15:00:00Z") / 1000));
  const ud = ev.user_data as Record<string, string[]>;
  assertEquals(ud.ph, [await sha256Hex("595981000000")]);
  assertEquals(ud.external_id, [await sha256Hex("cli-1")]);
  assertEquals(ud.country, [await sha256Hex("py")]);
  assert(!JSON.stringify(p).includes("595981000000"), "el teléfono nunca va en claro");
  assertEquals(ev.custom_data, { currency: "PYG", value: 129000, order_id: "#1001" });
  assertFalse("test_event_code" in p);
});

Deno.test("payload principal: test_event_code y action_source configurables", async () => {
  const p = await armarPayloadPrincipal(ENTRADA, { ahora: AHORA, testEventCode: "TEST123", actionSource: "other" });
  assertEquals(p.test_event_code, "TEST123");
  assertEquals((p.data as Record<string, unknown>[])[0].action_source, "other");
});

Deno.test("payload de mensajería: misma forma que el ejemplo de la doc de Business Messaging", () => {
  const p = armarPayloadMensajeria({ ...ENTRADA, origenAnuncio: { ctwa_clid: "CLID_DE_PRUEBA" } }, {
    ahora: AHORA,
    wabaId: "WABA_PRUEBA",
  })!;
  const ev = (p.data as Record<string, unknown>[])[0];
  // Claves del ejemplo oficial: event_name, event_time, action_source, messaging_channel, user_data, custom_data
  for (const k of ["event_name", "event_time", "action_source", "messaging_channel", "user_data", "custom_data"]) {
    assert(k in ev, `falta ${k}`);
  }
  assertEquals(ev.event_name, "OrderDelivered");
  assertEquals(ev.action_source, "business_messaging");
  assertEquals(ev.messaging_channel, "whatsapp");
  assertEquals(ev.user_data, { whatsapp_business_account_id: "WABA_PRUEBA", ctwa_clid: "CLID_DE_PRUEBA" });
  assertEquals(ev.custom_data, { currency: "PYG", value: 129000 });
  assertEquals(ev.event_id, "entregado:9001");
});

Deno.test("sin ctwa_clid no hay payload de mensajería", () => {
  assertEquals(armarPayloadMensajeria(ENTRADA, { ahora: AHORA, wabaId: "W" }), null);
  assertEquals(armarPayloadMensajeria({ ...ENTRADA, origenAnuncio: { ctwa_clid: "  " } }, { ahora: AHORA, wabaId: "W" }), null);
});

Deno.test("event_time nunca en el futuro y plazo de 7 días", () => {
  assertEquals(eventTime("2026-10-07T00:00:00Z", AHORA), Math.floor(AHORA.getTime() / 1000));
  assertEquals(eventTime(null, AHORA), Math.floor(AHORA.getTime() / 1000));
  assert(dentroDePlazo("2026-10-01T00:00:00Z", AHORA));
  assertFalse(dentroDePlazo("2026-09-28T00:00:00Z", AHORA));
});

Deno.test("simulado sin token: no llama a fetch", async () => {
  let llamadas = 0;
  const r = await enviarEventoEntregado(
    { ...ENTRADA, origenAnuncio: { ctwa_clid: "CLID" } },
    { token: null, ahora: AHORA, fetch: (() => { llamadas++; return Promise.reject(new Error("no")); }) as typeof fetch },
  );
  assertEquals(r.ok, true);
  assertEquals(r.simulado, true);
  assertEquals(llamadas, 0);
  assert(r.payloads?.mensajeria);
});

Deno.test("real (fetch falso): dos envíos si hay ctwa_clid, token en header, v25.0", async () => {
  const llamadas: { url: string; auth: string | null; body: Record<string, unknown> }[] = [];
  const fakeFetch = ((url: string, init: RequestInit) => {
    llamadas.push({
      url,
      auth: new Headers(init.headers).get("Authorization"),
      body: JSON.parse(String(init.body)),
    });
    return Promise.resolve(new Response(JSON.stringify({ events_received: 1 }), { status: 200 }));
  }) as unknown as typeof fetch;
  const r = await enviarEventoEntregado({ ...ENTRADA, origenAnuncio: { ctwa_clid: "CLID" } }, {
    token: "TOKEN_FALSO", datasetId: "111", datasetMensajeriaId: "222", wabaId: "333",
    testEventCode: null, simulado: false, ahora: AHORA, fetch: fakeFetch,
  });
  assertEquals(r.ok, true);
  assertEquals(llamadas.map((l) => l.url), [
    "https://graph.facebook.com/v25.0/111/events",
    "https://graph.facebook.com/v25.0/222/events",
  ]);
  assertEquals(llamadas[0].auth, "Bearer TOKEN_FALSO");
  assert(!llamadas[0].url.includes("TOKEN"));
});

Deno.test("real: sin dataset de mensajería se omite ese envío y el principal sigue", async () => {
  let n = 0;
  const fakeFetch = (() => { n++; return Promise.resolve(new Response("{}", { status: 200 })); }) as unknown as typeof fetch;
  const r = await enviarEventoEntregado({ ...ENTRADA, origenAnuncio: { ctwa_clid: "CLID" } }, {
    token: "T", datasetId: "111", datasetMensajeriaId: null, wabaId: "333", testEventCode: null,
    simulado: false, ahora: AHORA, fetch: fakeFetch,
  });
  assertEquals(n, 1);
  assertEquals(r.ok, true);
  assertEquals(r.mensajeria.omitido, "falta_META_DATASET_MENSAJERIA_ID");
});

Deno.test("real: error de Meta → ok false con el mensaje", async () => {
  const fakeFetch = (() =>
    Promise.resolve(new Response(JSON.stringify({ error: { message: "Invalid parameter" } }), { status: 400 }))) as unknown as typeof fetch;
  const r = await enviarEventoEntregado(ENTRADA, {
    token: "T", datasetId: "111", testEventCode: null, simulado: false, ahora: AHORA, fetch: fakeFetch,
  });
  assertEquals(r.ok, false);
  assertEquals(r.principal.error, "Invalid parameter");
});
