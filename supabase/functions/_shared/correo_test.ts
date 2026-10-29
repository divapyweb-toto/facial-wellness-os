// Tests de _shared/correo.ts (Resend) con fetch falso. Datos inventados (repo público).
import { assert, assertEquals, assertFalse, assertStringIncludes } from "@std/assert";
import { correoFactura, emailValido, enviarCorreo, formatoGs, REMITENTE_POR_DEFECTO, RESEND_URL } from "./correo.ts";

type Llamada = { url: string; body: Record<string, unknown>; auth: string | null };

function falso(respuesta: unknown = { id: "re-1" }, status = 200) {
  const llamadas: Llamada[] = [];
  const f: typeof fetch = (input, init) => {
    llamadas.push({ url: String(input), body: JSON.parse(String(init?.body ?? "{}")), auth: new Headers(init?.headers).get("authorization") });
    return Promise.resolve(new Response(JSON.stringify(respuesta), { status }));
  };
  return { f, llamadas };
}

const CORREO = { para: "ana@ejemplo.com", asunto: "Asunto", texto: "Hola", adjuntos: [{ filename: "F.pdf", path: "https://ejemplo.com/f.pdf" }] };

Deno.test("sin RESEND_API_KEY: simulado y sin red", async () => {
  const { f, llamadas } = falso();
  const r = await enviarCorreo(CORREO, { fetch: f, clave: () => undefined });
  assertEquals(r, { ok: true, simulado: true });
  assertEquals(llamadas.length, 0);
});

Deno.test("con clave: POST a Resend con Bearer, remitente por defecto y adjunto por path", async () => {
  const { f, llamadas } = falso();
  const r = await enviarCorreo(CORREO, { fetch: f, clave: () => "re_prueba", remitente: () => undefined, responderA: () => undefined });
  assertEquals(r, { ok: true, id: "re-1" });
  assertEquals(llamadas[0].url, RESEND_URL);
  assertEquals(llamadas[0].auth, "Bearer re_prueba");
  assertEquals(llamadas[0].body, {
    from: REMITENTE_POR_DEFECTO,
    to: ["ana@ejemplo.com"],
    subject: "Asunto",
    text: "Hola",
    attachments: [{ filename: "F.pdf", path: "https://ejemplo.com/f.pdf" }],
  });
});

Deno.test("RESEND_FROM y RESEND_REPLY_TO se respetan; adjunto en base64 va como content", async () => {
  const { f, llamadas } = falso();
  await enviarCorreo({ ...CORREO, adjuntos: [{ filename: "F.pdf", content: "JVBERi0=" }] }, {
    fetch: f, clave: () => "k", remitente: () => "Facturas <f@ejemplo.com>", responderA: () => "resp@ejemplo.com",
  });
  assertEquals(llamadas[0].body.from, "Facturas <f@ejemplo.com>");
  assertEquals(llamadas[0].body.reply_to, "resp@ejemplo.com");
  assertEquals(llamadas[0].body.attachments, [{ filename: "F.pdf", content: "JVBERi0=" }]);
});

Deno.test("error de Resend y de red: ok false, sin excepción", async () => {
  const { f } = falso({ name: "validation_error", message: "Invalid from" }, 422);
  const r = await enviarCorreo(CORREO, { fetch: f, clave: () => "k" });
  assertFalse(r.ok);
  assertStringIncludes(r.error ?? "", "422");
  assertStringIncludes(r.error ?? "", "Invalid from");
  const r2 = await enviarCorreo(CORREO, { fetch: () => Promise.reject(new Error("dns")), clave: () => "k" });
  assertEquals(r2, { ok: false, error: "red: dns" });
});

Deno.test("validaciones antes de la red", async () => {
  const { f, llamadas } = falso();
  const e = { fetch: f, clave: () => "k" };
  assertEquals((await enviarCorreo({ ...CORREO, para: "no-es-email" }, e)).error, "destinatario_invalido");
  assertEquals((await enviarCorreo({ ...CORREO, asunto: " " }, e)).error, "asunto_vacio");
  assertEquals((await enviarCorreo({ ...CORREO, texto: "" }, e)).error, "cuerpo_vacio");
  assertEquals((await enviarCorreo({ ...CORREO, adjuntos: [{ filename: "F.pdf" }] }, e)).error, "adjunto_invalido");
  assertEquals(llamadas.length, 0);
  assert(emailValido("a.b@c.com.py"));
  assertFalse(emailValido("a b@c.com"));
});

Deno.test("formatoGs: separador de miles con punto", () => {
  assertEquals(formatoGs(112000), "112.000");
  assertEquals(formatoGs(1250000), "1.250.000");
  assertEquals(formatoGs(999), "999");
  assertEquals(formatoGs(0), "0");
});

Deno.test("correoFactura: asunto, nombre, número y total en guaraníes", () => {
  const c = correoFactura({ nombre: "Ana", numeroCompleto: "001-001-0000007", total: 112000 });
  assertEquals(c.asunto, "Tu factura de Voltra N.º 001-001-0000007");
  assertEquals(c.texto, "Hola, Ana:\n\nGracias por tu compra. Te adjuntamos tu factura electrónica N.º 001-001-0000007 por un total de Gs. 112.000.\n\nPodés verificarla en la SET con el código QR impreso en la factura.\n\nVoltra");
  assertStringIncludes(c.html, "<p>Hola, Ana:</p>");
  const sin = correoFactura({ nombre: null, numeroCompleto: "001-001-0000008", total: null });
  assert(sin.texto.startsWith("Hola:\n"));
  assertFalse(sin.texto.includes("total"));
  assertStringIncludes(correoFactura({ nombre: "<b>", numeroCompleto: "n", total: 1 }).html, "&lt;b&gt;");
});
