// Tests de enviarDocumento (_shared/wa.ts) con fetch y base simulados. Datos inventados (repo público).
import { assertEquals, assertFalse } from "@std/assert";
import { _configurarWA, enviarDocumento, type FilaMensajeSaliente } from "./wa.ts";

function simular(prohibidas = ["garantía"]) {
  const llamadas: Array<{ url: string; body: Record<string, unknown> }> = [];
  const registros: FilaMensajeSaliente[] = [];
  _configurarWA({
    token: () => "token-de-prueba",
    phoneNumberId: () => "PHONE_ID",
    palabrasProhibidas: () => Promise.resolve(prohibidas),
    registrar: (f) => (registros.push(f), Promise.resolve()),
    resolverDestino: () => Promise.resolve({ clienteId: "cli-1", conversacionId: "conv-1" }),
    fetch: (input, init) => {
      llamadas.push({ url: String(input), body: JSON.parse(String(init?.body ?? "{}")) });
      return Promise.resolve(new Response(JSON.stringify({ messages: [{ id: "wamid.DOC1" }] }), { status: 200 }));
    },
  });
  return { llamadas, registros };
}

const DOC = { link: "https://ejemplo.com/f.pdf?token=t", filename: "Factura 001-001-0000007.pdf", caption: "Tu factura" };

Deno.test("enviarDocumento: payload type document con link, filename y caption", async () => {
  const { llamadas, registros } = simular();
  const r = await enviarDocumento("+595981000000", DOC);
  assertEquals(r, { ok: true, wa_message_id: "wamid.DOC1" });
  assertEquals(llamadas[0].url, "https://graph.facebook.com/v25.0/PHONE_ID/messages");
  assertEquals(llamadas[0].body, {
    messaging_product: "whatsapp",
    recipient_type: "individual",
    to: "595981000000",
    type: "document",
    document: { link: DOC.link, filename: DOC.filename, caption: "Tu factura" },
  });
  assertEquals(registros[0].tipo, "document");
  assertEquals(registros[0].estado, "enviado");
  assertEquals(registros[0].texto, "[documento Factura 001-001-0000007.pdf] Tu factura");
  _configurarWA();
});

Deno.test("enviarDocumento: sin caption no manda el campo", async () => {
  const { llamadas } = simular();
  await enviarDocumento("+595981000000", { link: DOC.link, filename: DOC.filename });
  assertEquals(llamadas[0].body.document, { link: DOC.link, filename: DOC.filename });
  _configurarWA();
});

Deno.test("enviarDocumento: validaciones y filtro de palabras prohibidas en el caption", async () => {
  const { llamadas, registros } = simular();
  assertEquals((await enviarDocumento("+595981000000", { ...DOC, link: "http://x.com/f.pdf" })).error, "link_invalido");
  assertEquals((await enviarDocumento("+595981000000", { ...DOC, filename: " " })).error, "filename_invalido");
  assertEquals((await enviarDocumento("+595981000000", { ...DOC, caption: "x".repeat(1025) })).error, "caption_mayor_a_1024");
  const r = await enviarDocumento("+595981000000", { ...DOC, caption: "Con garantía" });
  assertFalse(r.ok);
  assertEquals(r.error, "palabra_prohibida:garantía");
  assertEquals(llamadas.length, 0);
  assertEquals(registros.at(-1)?.estado, "fallido");
  _configurarWA();
});
