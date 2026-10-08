// Tests de _shared/wa.ts con fetch y base simulados. Datos inventados (repo público).
import { assert, assertEquals, assertFalse } from "jsr:@std/assert@1";
import {
  _configurarWA,
  destinatario,
  enviarBotones,
  enviarPlantilla,
  enviarTexto,
  type FilaMensajeSaliente,
  marcarLeidoYEscribiendo,
  verificarFirmaMeta,
} from "./wa.ts";

const SECRETO = "secreto-de-prueba";

async function firmar(body: string, secreto = SECRETO): Promise<string> {
  const k = await crypto.subtle.importKey("raw", new TextEncoder().encode(secreto), { name: "HMAC", hash: "SHA-256" }, false, ["sign"]);
  const s = new Uint8Array(await crypto.subtle.sign("HMAC", k, new TextEncoder().encode(body)));
  return "sha256=" + Array.from(s, (b) => b.toString(16).padStart(2, "0")).join("");
}

type Llamada = { url: string; body: Record<string, unknown>; auth: string | null };

function simular(respuesta: unknown = { messaging_product: "whatsapp", messages: [{ id: "wamid.OUT1" }] }, status = 200) {
  const llamadas: Llamada[] = [];
  const registros: FilaMensajeSaliente[] = [];
  _configurarWA({
    token: () => "token-de-prueba",
    phoneNumberId: () => "PHONE_ID",
    palabrasProhibidas: () => Promise.resolve(["garantía", "sin riesgo", "cura"]),
    registrar: (f) => (registros.push(f), Promise.resolve()),
    resolverDestino: () => Promise.resolve({ clienteId: "cli-1", conversacionId: "conv-1" }),
    fetch: (input, init) => {
      llamadas.push({
        url: String(input),
        body: JSON.parse(String(init?.body ?? "{}")),
        auth: new Headers(init?.headers).get("authorization"),
      });
      return Promise.resolve(new Response(JSON.stringify(respuesta), { status }));
    },
  });
  return { llamadas, registros };
}

Deno.test("verificarFirmaMeta: válida, inválida, ausente y mal formada", async () => {
  const body = JSON.stringify({ object: "whatsapp_business_account", entry: [] });
  assert(await verificarFirmaMeta(body, await firmar(body), SECRETO));
  assert(await verificarFirmaMeta(new TextEncoder().encode(body), await firmar(body), SECRETO));
  assertFalse(await verificarFirmaMeta(body, await firmar(body, "otro"), SECRETO));
  assertFalse(await verificarFirmaMeta(body + " ", await firmar(body), SECRETO));
  assertFalse(await verificarFirmaMeta(body, null, SECRETO));
  assertFalse(await verificarFirmaMeta(body, "sha1=abc", SECRETO));
  assertFalse(await verificarFirmaMeta(body, await firmar(body), ""));
});

Deno.test("destinatario: teléfono → to, BSUID → recipient, local sin código → error", () => {
  assertEquals(destinatario("+595981000000"), { to: "595981000000" });
  assertEquals(destinatario("595981000000"), { to: "595981000000" });
  assertEquals(destinatario("PY.1234567890123"), { recipient: "PY.1234567890123" });
  assertEquals(destinatario("0981000000"), { error: "telefono_sin_codigo_pais" });
});

Deno.test("enviarTexto: arma el POST a v25.0, devuelve wamid y registra en wa_mensajes", async () => {
  const { llamadas, registros } = simular();
  const r = await enviarTexto("+595981000000", "Hola Ana, tu pedido está en camino.");
  assertEquals(r, { ok: true, wa_message_id: "wamid.OUT1" });
  assertEquals(llamadas[0].url, "https://graph.facebook.com/v25.0/PHONE_ID/messages");
  assertEquals(llamadas[0].auth, "Bearer token-de-prueba");
  assertEquals(llamadas[0].body.to, "595981000000");
  assertEquals(llamadas[0].body.type, "text");
  assertEquals((llamadas[0].body.text as { body: string }).body, "Hola Ana, tu pedido está en camino.");
  assertEquals(registros[0].direccion, "out");
  assertEquals(registros[0].estado, "enviado");
  assertEquals(registros[0].wa_message_id, "wamid.OUT1");
  assertEquals(registros[0].conversacion_id, "conv-1");
  _configurarWA();
});

Deno.test("enviarTexto a BSUID usa el campo recipient", async () => {
  const { llamadas } = simular();
  await enviarTexto("PY.1234567890123", "Hola");
  assertEquals(llamadas[0].body.recipient, "PY.1234567890123");
  assertFalse("to" in llamadas[0].body);
  _configurarWA();
});

Deno.test("filtro de palabras prohibidas: no envía, registra fallido", async () => {
  const { llamadas, registros } = simular();
  const r = await enviarTexto("+595981000000", "Tiene GARANTIA total");
  assertEquals(r.ok, false);
  assertEquals(r.error, "palabra_prohibida:garantía");
  assertEquals(llamadas.length, 0);
  assertEquals(registros[0].estado, "fallido");
  const r2 = await enviarBotones("+595981000000", "¿Seguimos?", [{ id: "a", titulo: "Sin riesgo" }]);
  assertEquals(r2.error, "palabra_prohibida:sin riesgo");
  const r3 = await enviarPlantilla("+595981000000", "voltra_x", "es", [{ type: "body", parameters: [{ type: "text", text: "te cura" }] }]);
  assertEquals(r3.error, "palabra_prohibida:cura");
  assertEquals(llamadas.length, 0);
  _configurarWA();
});

Deno.test("sin lista de palabras en config: falla cerrado", async () => {
  const { llamadas } = simular();
  _configurarWA({
    token: () => "t",
    phoneNumberId: () => "P",
    palabrasProhibidas: () => Promise.resolve(null),
    registrar: () => Promise.resolve(),
    resolverDestino: () => Promise.resolve({ clienteId: null, conversacionId: null }),
  });
  const r = await enviarTexto("+595981000000", "Hola");
  assertEquals(r.error, "config_palabras_prohibidas_no_disponible");
  assertEquals(llamadas.length, 0);
  _configurarWA();
});

Deno.test("enviarBotones: formato interactive/button y límites de Meta", async () => {
  const { llamadas } = simular();
  const r = await enviarBotones("+595981000000", "¿Confirmás tu pedido?", [
    { id: "conf_si:1", titulo: "Confirmar" },
    { id: "conf_corregir:1", titulo: "Corregir datos" },
    { id: "conf_cancelar:1", titulo: "Cancelar" },
  ]);
  assert(r.ok);
  const it = llamadas[0].body.interactive as { type: string; action: { buttons: { type: string; reply: { id: string; title: string } }[] } };
  assertEquals(it.type, "button");
  assertEquals(it.action.buttons[1], { type: "reply", reply: { id: "conf_corregir:1", title: "Corregir datos" } });
  assertEquals((await enviarBotones("+595981000000", "x", [])).error, "botones_1_a_3");
  assertEquals((await enviarBotones("+595981000000", "x", [{ id: "a", titulo: "Un título demasiado largo" }])).ok, false);
  _configurarWA();
});

Deno.test("enviarPlantilla: name, language y components", async () => {
  const { llamadas } = simular();
  const comp = [{ type: "body", parameters: [{ type: "text", text: "Ana" }] }];
  await enviarPlantilla("+595981000000", "voltra_confirmacion_pedido", "es", comp);
  assertEquals(llamadas[0].body.type, "template");
  assertEquals(llamadas[0].body.template, { name: "voltra_confirmacion_pedido", language: { code: "es" }, components: comp });
  _configurarWA();
});

Deno.test("error de Graph: ok false con código y registro fallido", async () => {
  const { registros } = simular({ error: { code: 131047, message: "Re-engagement message" } }, 400);
  const r = await enviarTexto("+595981000000", "Hola");
  assertEquals(r, { ok: false, error: "131047: Re-engagement message" });
  assertEquals(registros[0].estado, "fallido");
  _configurarWA();
});

Deno.test("marcarLeidoYEscribiendo: status read + typing_indicator", async () => {
  const { llamadas, registros } = simular({ success: true });
  const r = await marcarLeidoYEscribiendo("wamid.IN1");
  assert(r.ok);
  assertEquals(llamadas[0].body, { messaging_product: "whatsapp", status: "read", message_id: "wamid.IN1", typing_indicator: { type: "text" } });
  assertEquals(registros.length, 0);
  _configurarWA();
});

Deno.test("enviarTexto con origen 'manual': queda en contenido.origen del registro y NO viaja a Meta", async () => {
  const { llamadas, registros } = simular();
  await enviarTexto("+595981000000", "Hola, soy Enrique.", { clienteId: "cli-1", conversacionId: "conv-1", origen: "manual" });
  assertEquals((registros[0].contenido as Record<string, unknown>).origen, "manual");
  assertFalse("origen" in llamadas[0].body);
  await enviarTexto("+595981000000", "Automático.");
  assertFalse("origen" in (registros[1].contenido as Record<string, unknown>));
  _configurarWA();
});
