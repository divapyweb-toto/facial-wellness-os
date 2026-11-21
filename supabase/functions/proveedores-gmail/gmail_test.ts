// Pruebas de gmail.ts: leer correos (multiparte, GBK, citado en/es/zh), armar respuestas y el cliente con fetch falso.
// Nunca se toca Google: todo fetch es falso. Datos DEMO.
import { assert, assertEquals, assertMatch, assertStringIncludes } from "@std/assert";
import {
  armarCorreo, armarRespuesta, asuntoRespuesta, base64url, bytesDeBase64url, codificarAsunto, crearClienteGmail, credencialesDesdeEntorno,
  decodificarRfc2047, direccionDe, extraerTexto, htmlATexto, type MensajeGmail, quitarCitado, TOKEN_URL, GMAIL_API, adjuntosDe,
} from "./gmail.ts";

const dec = (s: string) => new TextDecoder().decode(bytesDeBase64url(s));

Deno.test("base64url: ida y vuelta con chino, sin + / =", () => {
  const s = "你好 Voltra ¿precio? ~~~>>>???";
  const b = base64url(s);
  assert(!/[+/=]/.test(b));
  assertEquals(dec(b), s);
});

Deno.test("direccionDe: nombre y mayúsculas", () => {
  assertEquals(direccionDe('"Demo Factory" <Proveedor@Example.com>'), "proveedor@example.com");
  assertEquals(direccionDe("ventas@example.com"), "ventas@example.com");
  assertEquals(direccionDe("sin correo"), "");
});

Deno.test("quitarCitado: inglés (On … wrote: en dos líneas, '>')", () => {
  const t = "Price is 1.20 USD for 1000 pcs.\nBest regards\n\nOn Mon, Nov 23, 2026 at 10:00 AM Voltra <demo@example.com>\nwrote:\n> Hi, what is the price?\n> Thanks";
  assertEquals(quitarCitado(t), "Price is 1.20 USD for 1000 pcs.\nBest regards");
});

Deno.test("quitarCitado: español (El … escribió:) y firma 'Enviado desde mi'", () => {
  const t = "Te paso el precio: 1,10 USD.\n\nEnviado desde mi iPhone\n\nEl lun, 23 nov 2026 a las 10:00, Voltra <demo@example.com> escribió:\n> Hola";
  assertEquals(quitarCitado(t), "Te paso el precio: 1,10 USD.");
});

Deno.test("quitarCitado: chino (写道：, 原始邮件, 发件人/发送时间)", () => {
  assertEquals(quitarCitado("您好，1000个单价1.2美元。\n\n在 2026年11月23日 10:00，Voltra <demo@example.com> 写道：\n> 你好"), "您好，1000个单价1.2美元。");
  assertEquals(quitarCitado("好的，可以做蓝色。\n------------------ 原始邮件 ------------------\n发件人: demo"), "好的，可以做蓝色。");
  assertEquals(quitarCitado("OK.\n发件人: Voltra <demo@example.com>\n发送时间: 2026年11月23日\n主题: 询价"), "OK.");
  assertEquals(quitarCitado("Sure.\n\nFrom: Voltra <demo@example.com>\nSent: Monday\nTo: x\n\nHi"), "Sure.");
});

Deno.test("htmlATexto: corta el bloque gmail_quote y blockquote, decodifica entidades", () => {
  const h = '<div dir="ltr">Price: 1.20&nbsp;USD &amp; MOQ 500<br>Thanks</div><div class="gmail_quote"><div>On Mon wrote:</div><blockquote>old</blockquote></div>';
  assertEquals(htmlATexto(h), "Price: 1.20 USD & MOQ 500\nThanks");
  assertEquals(htmlATexto("<p>你好</p><blockquote>旧的</blockquote>"), "你好");
});

const parte = (mimeType: string, texto: string, charset = "UTF-8", bytes?: Uint8Array) => ({
  mimeType, headers: [{ name: "Content-Type", value: `${mimeType}; charset="${charset}"` }], body: { data: base64url(bytes ?? texto) },
});

Deno.test("extraerTexto: prefiere text/plain sobre HTML y saca lo citado", () => {
  const p = { mimeType: "multipart/alternative", parts: [parte("text/plain", "Plain 1.20\n> viejo"), parte("text/html", "<b>HTML</b>")] };
  assertEquals(extraerTexto(p), "Plain 1.20");
});

Deno.test("extraerTexto: solo HTML (multipart/mixed anidado) y adjuntos", () => {
  const p = {
    mimeType: "multipart/mixed",
    parts: [
      { mimeType: "multipart/alternative", parts: [parte("text/html", '<div>Ver cotización adjunta</div><div class="gmail_quote">x</div>')] },
      { mimeType: "application/pdf", filename: "quote-demo.pdf", body: { attachmentId: "ATT1", size: 1000 } },
    ],
  };
  assertEquals(extraerTexto(p), "Ver cotización adjunta");
  assertEquals(adjuntosDe(p), ["quote-demo.pdf"]);
});

Deno.test("extraerTexto: cuerpo en GBK (proveedor chino)", () => {
  const gbk = new Uint8Array([0xc4, 0xe3, 0xba, 0xc3]); // 你好
  assertEquals(extraerTexto(parte("text/plain", "", "gb2312", gbk)), "你好");
});

Deno.test("codificarAsunto: ASCII queda igual; chino en RFC 2047 en trozos y vuelve igual", () => {
  assertEquals(codificarAsunto("Quote request"), "Quote request");
  const zh = "询价：鼻贴 1000 个，请报价并告知包装尺寸和重量，谢谢您的帮助";
  const c = codificarAsunto(zh);
  for (const palabra of c.split("\r\n ")) {
    assertMatch(palabra, /^=\?UTF-8\?B\?[A-Za-z0-9+/=]+\?=$/);
    assert(palabra.length <= 75, `${palabra.length}`);
  }
  assertEquals(decodificarRfc2047(c.replace(/\r\n /g, " ")), zh);
  assertEquals(codificarAsunto("Hola\r\nBcc: x@example.com"), "Hola Bcc: x@example.com"); // sin inyección de encabezados
});

Deno.test("asuntoRespuesta: no duplica Re: / 回复:", () => {
  assertEquals(asuntoRespuesta("Price"), "Re: Price");
  assertEquals(asuntoRespuesta("RE: Price"), "RE: Price");
  assertEquals(asuntoRespuesta("回复：询价"), "回复：询价");
});

const ENTRANTE: MensajeGmail = {
  id: "m1", threadId: "t1",
  payload: {
    headers: [
      { name: "From", value: "Demo Factory <proveedor@example.com>" },
      { name: "Subject", value: "询价" },
      { name: "Message-ID", value: "<abc@example.com>" },
      { name: "References", value: "<root@example.com>" },
    ],
  },
};

Deno.test("armarRespuesta: mismo hilo, Re:, In-Reply-To, References, To, cuerpo UTF-8 base64, raw base64url", () => {
  const r = armarRespuesta(ENTRANTE, "您好，请问1000个的价格？\nVoltra (Paraguay)", "demo@example.com");
  assertEquals(r.threadId, "t1");
  assertEquals(r.para, "proveedor@example.com");
  assertEquals(r.asunto, "Re: 询价");
  assert(!/[+/=]/.test(r.raw));
  const raw = dec(r.raw);
  assertStringIncludes(raw, "From: demo@example.com\r\n");
  assertStringIncludes(raw, "To: proveedor@example.com\r\n");
  assertStringIncludes(raw, "In-Reply-To: <abc@example.com>\r\n");
  assertStringIncludes(raw, "References: <root@example.com> <abc@example.com>\r\n");
  assertStringIncludes(raw, "Content-Type: text/plain; charset=UTF-8\r\n");
  assertMatch(raw, /Subject: =\?UTF-8\?B\?/);
  const cuerpo = raw.split("\r\n\r\n")[1].replace(/\r\n/g, "");
  assertEquals(new TextDecoder().decode(Uint8Array.from(atob(cuerpo), (c) => c.charCodeAt(0))), "您好，请问1000个的价格？\r\nVoltra (Paraguay)");
});

Deno.test("armarRespuesta: usa Reply-To si existe", () => {
  const m = { ...ENTRANTE, payload: { headers: [...ENTRANTE.payload!.headers!, { name: "Reply-To", value: "ventas@example.com" }] } };
  assertEquals(armarRespuesta(m, "ok").para, "ventas@example.com");
});

Deno.test("armarCorreo: primer contacto sin In-Reply-To", () => {
  const raw = armarCorreo({ para: "proveedor@example.com", asunto: "Inquiry", texto: "Hi" });
  assert(!raw.includes("In-Reply-To"));
  assert(!raw.includes("From:"));
});

// ─── Cliente con fetch falso ───
function fetchFalso(respuestas: Array<{ status?: number; body: unknown } | Error>) {
  const llamadas: Array<{ url: string; init?: RequestInit }> = [];
  const f = (url: string | URL | Request, init?: RequestInit) => {
    llamadas.push({ url: String(url), init });
    const r = respuestas.shift();
    if (!r) throw new Error("sin respuesta preparada");
    if (r instanceof Error) return Promise.reject(r);
    return Promise.resolve(new Response(JSON.stringify(r.body), { status: r.status ?? 200 }));
  };
  return { f: f as typeof fetch, llamadas };
}
const CRED = { clientId: "id-demo", clientSecret: "secreto-demo", refreshToken: "refresh-demo" };

Deno.test("cliente: refresca el token una vez y lista con la consulta", async () => {
  const { f, llamadas } = fetchFalso([{ body: { access_token: "acc", expires_in: 3600 } }, { body: { messages: [{ id: "a" }, { id: "b" }] } }, { body: { emailAddress: "Demo@Example.com" } }]);
  const g = crearClienteGmail(CRED, f);
  assertEquals(await g.listar("in:inbox newer_than:2d -from:me", 50), ["a", "b"]);
  assertEquals(await g.perfil(), "demo@example.com");
  assertEquals(llamadas.length, 3); // un solo pedido de token
  assertEquals(llamadas[0].url, TOKEN_URL);
  const cuerpo = new URLSearchParams(String(llamadas[0].init?.body));
  assertEquals(cuerpo.get("grant_type"), "refresh_token");
  assertEquals(cuerpo.get("refresh_token"), "refresh-demo");
  assertEquals(llamadas[1].url, `${GMAIL_API}/messages?q=in%3Ainbox%20newer_than%3A2d%20-from%3Ame&maxResults=50`);
  assertEquals((llamadas[1].init?.headers as Record<string, string>).authorization, "Bearer acc");
});

Deno.test("cliente: enviar manda raw + threadId; error de Google = FAILED seguro; corte de red = no se sabe", async () => {
  const { f, llamadas } = fetchFalso([
    { body: { access_token: "acc" } },
    { body: { id: "s1", threadId: "t1" } },
    { status: 400, body: { error: { message: "Invalid To header" } } },
    new TypeError("connection reset"),
  ]);
  const g = crearClienteGmail(CRED, f);
  assertEquals(await g.enviar("UkFX", "t1"), { ok: true, id: "s1", threadId: "t1" });
  assertEquals(JSON.parse(String(llamadas[1].init?.body)), { raw: "UkFX", threadId: "t1" });
  assertEquals(llamadas[1].url, `${GMAIL_API}/messages/send`);
  const r2 = await g.enviar("UkFX", null);
  assertEquals(r2.ok, false);
  assert(!r2.ok && r2.seguro && r2.error.includes("Invalid To header"));
  const r3 = await g.enviar("UkFX", null);
  assert(!r3.ok && !r3.seguro);
});

Deno.test("cliente: token rechazado (invalid_grant) → enviar falla seguro, sin mandar", async () => {
  const { f, llamadas } = fetchFalso([{ status: 400, body: { error: "invalid_grant" } }]);
  const r = await crearClienteGmail(CRED, f).enviar("UkFX", null);
  assert(!r.ok && r.seguro && r.error.includes("invalid_grant"));
  assertEquals(llamadas.length, 1);
});

Deno.test("credencialesDesdeEntorno: null si falta alguna", () => {
  assertEquals(credencialesDesdeEntorno(() => undefined), null);
  const env: Record<string, string> = { GMAIL_CLIENT_ID: "a", GMAIL_CLIENT_SECRET: "b", GMAIL_REFRESH_TOKEN: "c" };
  assertEquals(credencialesDesdeEntorno((n) => env[n]), { clientId: "a", clientSecret: "b", refreshToken: "c" });
});
