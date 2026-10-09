// Datos inventados (repo público). Nunca llama a Meta: fetch falso o modo simulado.
import { assert, assertEquals, assertFalse } from "jsr:@std/assert@1";
import {
  armarPayloadMensajeria,
  armarPayloadPrincipal,
  datosClienteDesdeRaw,
  dentroDePlazo,
  enviarEventoEntregado,
  eventTime,
  normalizarCiudadCapi,
  normalizarNombreCapi,
  normalizarTelefonoCapi,
  sha256Hex,
  validarIp,
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

Deno.test("lead: configLead null si falta token, dataset de mensajería o WABA, o en modo simulado", async () => {
  const { configLead, armarPayloadLead, EVENTO_LEAD } = await import("./meta_capi.ts");
  const base = { token: "t", datasetMensajeriaId: "d", wabaId: "w", testEventCode: null, simulado: false };
  assertEquals(configLead(base), { token: "t", datasetMensajeriaId: "d", wabaId: "w", testEventCode: null });
  assertEquals(configLead({ ...base, token: null }), null);
  assertEquals(configLead({ ...base, datasetMensajeriaId: null }), null);
  assertEquals(configLead({ ...base, wabaId: null }), null);
  assertEquals(configLead({ ...base, simulado: true }), null);
  assertEquals(EVENTO_LEAD, "LeadSubmitted");
  assertEquals(armarPayloadLead({ shopify_order_id: 1, valor: 1, moneda: "PYG", ctwa_clid: "" }, { ahora: AHORA, wabaId: "w" }), null);
  const p = armarPayloadLead({ shopify_order_id: 1, valor: 129000.4, moneda: "PYG", ctwa_clid: "c", creado_en: "2030-01-01T00:00:00Z" }, { ahora: AHORA, wabaId: "w", testEventCode: "TEST1" });
  const ev = (p!.data as Record<string, unknown>[])[0];
  assertEquals(ev.event_time, Math.floor(AHORA.getTime() / 1000), "nunca en el futuro");
  assertEquals(ev.custom_data, { currency: "PYG", value: 129000 });
  assertEquals(p!.test_event_code, "TEST1");
});

// ─── 09-10: fn, ln, ct, client_ip_address, fbc (datos inventados) ─────────

Deno.test("nombre: ejemplo de la doc ('Valéry' → 'valéry', conserva tilde) y ñ", () => {
  assertEquals(normalizarNombreCapi("Valéry"), "valéry");
  assertEquals(normalizarNombreCapi("  NÚÑEZ  "), "núñez");
  assertEquals(normalizarNombreCapi("O'Brien-López"), "o");
  assertEquals(normalizarNombreCapi("María José"), "maría");
  assertEquals(normalizarNombreCapi("Jose\u0301"), "josé"); // NFD → NFC: mismo hash que la forma compuesta
  assertEquals(normalizarNombreCapi(""), null);
  assertEquals(normalizarNombreCapi("..."), null);
});

Deno.test("ciudad: sin espacios, sin tildes, sin puntuación (doc: 'newyork')", () => {
  assertEquals(normalizarCiudadCapi("New York."), "newyork");
  assertEquals(normalizarCiudadCapi("Ciudad del Este"), "ciudaddeleste");
  assertEquals(normalizarCiudadCapi("Asunción"), "asuncion");
  assertEquals(normalizarCiudadCapi("Ñemby"), "nemby");
  assertEquals(normalizarCiudadCapi("Pdte. Franco"), "pdtefranco");
  assertEquals(normalizarCiudadCapi("  "), null);
});

Deno.test("IP: IPv4/IPv6 válidas pasan; inválidas no", () => {
  assertEquals(validarIp("203.0.113.7"), "203.0.113.7");
  assertEquals(validarIp(" 2001:DB8::1 "), "2001:db8::1");
  assertEquals(validarIp("256.1.1.1"), null);
  assertEquals(validarIp("1.2.3"), null);
  assertEquals(validarIp("2001:db8:::1:zz"), null);
  assertEquals(validarIp("hola"), null);
  assertEquals(validarIp(null), null);
});

const RAW_WEB = {
  created_at: "2026-10-05T12:00:00-03:00",
  shipping_address: { first_name: "Ana María", last_name: "", city: "Ciudad del Este" },
  note_attributes: [
    { name: "NOMBRE COMPLETO", value: "Ana María Pérez" },
    { name: "IP address", value: "198.51.100.23" },
  ],
  landing_site: "/products/x?utm_source=fb&fbclid=AbC123",
};

Deno.test("raw web: nombre partido, ciudad, IP y fbc desde fbclid", () => {
  const d = datosClienteDesdeRaw(RAW_WEB);
  assertEquals(d.nombre, "Ana");
  assertEquals(d.apellido, "María");
  assertEquals(d.ciudad, "Ciudad del Este");
  assertEquals(d.ip, "198.51.100.23");
  assertEquals(d.fbc, `fb.1.${new Date("2026-10-05T12:00:00-03:00").getTime()}.AbC123`);
});

Deno.test("raw: sin shipping usa NOMBRE COMPLETO y nota Ciudad; _fbc armado gana; IP inválida se descarta", () => {
  const d = datosClienteDesdeRaw({
    created_at: "2026-10-05T12:00:00Z",
    note_attributes: [
      { name: "NOMBRE COMPLETO", value: "Íñigo Báez" },
      { name: "Ciudad", value: "Luque" },
      { name: "IP address", value: "999.1.1.1" },
      { name: "_fbc", value: "fb.1.1554763741205.ZzZ" },
    ],
  });
  assertEquals([d.nombre, d.apellido, d.ciudad, d.ip, d.fbc], ["Íñigo", "Báez", "Luque", null, "fb.1.1554763741205.ZzZ"]);
});

Deno.test("raw de pedido de WhatsApp: sin IP ni fbc", () => {
  const d = datosClienteDesdeRaw({
    created_at: "2026-10-05T12:00:00Z",
    shipping_address: { first_name: "Carlos", last_name: "Gómez", city: "Hernandarias" },
    note_attributes: [{ name: "origen", value: "whatsapp" }],
  });
  assertEquals(d.ip, null);
  assertEquals(d.fbc, null);
  assertEquals(datosClienteDesdeRaw(null), {});
});

Deno.test("payload principal con cliente: fn/ln/ct con hash, IP y fbc sin hash", async () => {
  const p = await armarPayloadPrincipal(
    { ...ENTRADA, cliente: { nombre: "José", apellido: "Núñez", ciudad: "Ciudad del Este", ip: "203.0.113.7", fbc: "fb.1.1554763741205.AbC" } },
    { ahora: AHORA },
  );
  const ud = (p.data as { user_data: Record<string, unknown> }[])[0].user_data;
  assertEquals(ud.fn, [await sha256Hex("josé")]);
  assertEquals(ud.ln, [await sha256Hex("núñez")]);
  assertEquals(ud.ct, [await sha256Hex("ciudaddeleste")]);
  assertEquals(ud.client_ip_address, "203.0.113.7");
  assertEquals(ud.fbc, "fb.1.1554763741205.AbC");
  assertEquals(ud.country, [await sha256Hex("py")]);
  assert(Array.isArray(ud.ph) && Array.isArray(ud.external_id));
});

Deno.test("payload principal sin cliente / pedido WhatsApp: sin IP ni fbc; fbc mal formado se descarta", async () => {
  const a = await armarPayloadPrincipal(ENTRADA, { ahora: AHORA });
  const ua = (a.data as { user_data: Record<string, unknown> }[])[0].user_data;
  assertEquals(Object.keys(ua).sort(), ["country", "external_id", "ph"]);
  const b = await armarPayloadPrincipal(
    { ...ENTRADA, cliente: { nombre: "Ana", ip: "no-ip", fbc: "AbC123" } },
    { ahora: AHORA },
  );
  const ub = (b.data as { user_data: Record<string, unknown> }[])[0].user_data;
  assertFalse("client_ip_address" in ub);
  assertFalse("fbc" in ub);
  assert("fn" in ub);
});

Deno.test("test_event_code: va en los dos payloads si está; no va si falta", async () => {
  const conCod = await armarPayloadPrincipal(ENTRADA, { ahora: AHORA, testEventCode: "TEST123" });
  assertEquals(conCod.test_event_code, "TEST123");
  const sinCod = await armarPayloadPrincipal(ENTRADA, { ahora: AHORA });
  assertFalse("test_event_code" in sinCod);
  const e = { ...ENTRADA, origenAnuncio: { ctwa_clid: "clid-x" } };
  assertEquals(armarPayloadMensajeria(e, { ahora: AHORA, wabaId: "1", testEventCode: "TEST123" })!.test_event_code, "TEST123");
  assertFalse("test_event_code" in armarPayloadMensajeria(e, { ahora: AHORA, wabaId: "1" })!);
});

Deno.test("enviarEventoEntregado lee META_TEST_EVENT_CODE del entorno y lo manda (fetch falso)", async () => {
  const prev = Deno.env.get("META_TEST_EVENT_CODE");
  Deno.env.set("META_TEST_EVENT_CODE", "TEST999");
  const cuerpos: Record<string, unknown>[] = [];
  const f = ((_u: string, init: RequestInit) => {
    cuerpos.push(JSON.parse(String(init.body)));
    return Promise.resolve(new Response(JSON.stringify({ events_received: 1 }), { status: 200 }));
  }) as unknown as typeof fetch;
  try {
    const r = await enviarEventoEntregado(
      { ...ENTRADA, origenAnuncio: { ctwa_clid: "clid-x" } },
      { token: "t", datasetId: "1", datasetMensajeriaId: "2", wabaId: "3", simulado: false, ahora: AHORA, fetch: f },
    );
    assert(r.ok);
    assertEquals(cuerpos.length, 2);
    assert(cuerpos.every((c) => c.test_event_code === "TEST999"));
  } finally {
    if (prev === undefined) Deno.env.delete("META_TEST_EVENT_CODE");
    else Deno.env.set("META_TEST_EVENT_CODE", prev);
  }
});
