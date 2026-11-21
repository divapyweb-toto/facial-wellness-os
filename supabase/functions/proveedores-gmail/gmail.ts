// proveedores-gmail/gmail.ts · 21-11-2026. Todo lo de Gmail: leer y armar correos (funciones puras) y el cliente de la
// Gmail API (con fetch inyectable: las pruebas nunca tocan Google).
// API: users.messages.list (q), users.messages.get (format full/metadata), users.threads.get, users.messages.send
// (raw RFC 2822 en base64url + threadId), users.getProfile. Token de acceso con el refresh token en
// https://oauth2.googleapis.com/token. Secretos GMAIL_CLIENT_ID / GMAIL_CLIENT_SECRET / GMAIL_REFRESH_TOKEN (los carga
// scripts/gmail-autorizar.mjs; nunca en el código).

export const GMAIL_API = "https://gmail.googleapis.com/gmail/v1/users/me";
export const TOKEN_URL = "https://oauth2.googleapis.com/token";

// ─── Tipos de la Gmail API (lo que usamos) ───────────────────────────────────
export interface EncabezadoGmail { name: string; value: string }
export interface ParteGmail {
  mimeType?: string;
  filename?: string;
  headers?: EncabezadoGmail[];
  body?: { data?: string; size?: number; attachmentId?: string };
  parts?: ParteGmail[];
}
export interface MensajeGmail { id: string; threadId: string; labelIds?: string[]; internalDate?: string; payload?: ParteGmail }
export interface HiloGmail { id: string; messages?: MensajeGmail[] }

export type ResultadoEnvio =
  | { ok: true; id: string; threadId: string }
  // seguro = true: Google contestó con error (no salió) → FAILED. false: no sabemos si salió (red/timeout) → SEND_UNKNOWN.
  | { ok: false; error: string; seguro: boolean };

/** Lo que usa la lógica (en las pruebas se reemplaza por uno falso). */
export interface ClienteGmail {
  perfil(): Promise<string>; // correo de la cuenta autorizada
  listar(q: string, max?: number): Promise<string[]>;
  leer(id: string, formato: "full" | "metadata"): Promise<MensajeGmail>;
  hilo(id: string): Promise<HiloGmail>;
  enviar(raw: string, threadId?: string | null): Promise<ResultadoEnvio>;
}

// ─── base64url y textos ──────────────────────────────────────────────────────
export function bytesDeBase64url(s: string): Uint8Array {
  const b = s.replace(/-/g, "+").replace(/_/g, "/").replace(/\s+/g, "");
  const bin = atob(b + "=".repeat((4 - (b.length % 4)) % 4));
  return Uint8Array.from(bin, (c) => c.charCodeAt(0));
}

function bytesABase64(bytes: Uint8Array): string {
  let bin = "";
  for (let i = 0; i < bytes.length; i += 0x8000) bin += String.fromCharCode(...bytes.subarray(i, i + 0x8000));
  return btoa(bin);
}

export function base64url(entrada: string | Uint8Array): string {
  const bytes = typeof entrada === "string" ? new TextEncoder().encode(entrada) : entrada;
  return bytesABase64(bytes).replace(/\+/g, "-").replace(/\//g, "_").replace(/=+$/, "");
}

/** Decodifica con el juego de caracteres de la parte (los proveedores chinos a veces mandan GBK / GB2312). */
export function decodificar(bytes: Uint8Array, charset?: string | null): string {
  const cs = (charset ?? "utf-8").toLowerCase().replace(/^gb2312$/, "gbk");
  try {
    return new TextDecoder(cs).decode(bytes);
  } catch {
    return new TextDecoder("utf-8").decode(bytes);
  }
}

/** Decodifica palabras RFC 2047 (=?UTF-8?B?...?= / =?GBK?Q?...?=) por si un encabezado llega sin decodificar. */
export function decodificarRfc2047(v: string): string {
  return v.replace(/=\?([^?]+)\?([BbQq])\?([^?]*)\?=(\s+(?==\?))?/g, (_m, cs: string, enc: string, txt: string) => {
    try {
      const bytes = enc.toUpperCase() === "B"
        ? Uint8Array.from(atob(txt), (c) => c.charCodeAt(0))
        : Uint8Array.from(txt.replace(/_/g, " ").replace(/=([0-9A-Fa-f]{2})|./g, (x, h) => h ? String.fromCharCode(parseInt(h, 16)) : x), (c) => c.charCodeAt(0));
      return decodificar(bytes, cs);
    } catch {
      return txt;
    }
  });
}

export function encabezado(p: ParteGmail | undefined, nombre: string): string {
  const h = p?.headers?.find((x) => x.name.toLowerCase() === nombre.toLowerCase());
  return h ? decodificarRfc2047(h.value) : "";
}

/** "Nombre <Proveedor@Example.com>" → "proveedor@example.com". */
export function direccionDe(valor: string): string {
  const m = /<([^>]+)>/.exec(valor);
  const d = (m ? m[1] : valor).trim().toLowerCase();
  return /^[^\s@]+@[^\s@]+$/.test(d) ? d : "";
}

const charsetDe = (p: ParteGmail) => /charset="?([^";\s]+)"?/i.exec(encabezado(p, "Content-Type"))?.[1] ?? null;

function partes(p: ParteGmail | undefined): ParteGmail[] {
  if (!p) return [];
  return [p, ...(p.parts ?? []).flatMap(partes)];
}

/** Nombres de adjuntos (fotos, PDF, Excel de cotización). */
export function adjuntosDe(p: ParteGmail | undefined): string[] {
  return partes(p).filter((x) => x.filename && (x.body?.attachmentId || x.body?.data)).map((x) => x.filename!);
}

const entidades: Record<string, string> = { nbsp: " ", amp: "&", lt: "<", gt: ">", quot: '"', apos: "'", "#39": "'" };

/** HTML → texto, cortando lo citado (bloque gmail_quote, blockquote, respuesta de Outlook o de QQ). */
export function htmlATexto(html: string): string {
  let h = html;
  const corte = h.search(/<div[^>]*class=["']?[^"'>]*gmail_quote|<blockquote|<div[^>]*id=["']?(divRplyFwdMsg|appendonsend)|-{3,}\s*(原始邮件|Original)/i);
  if (corte >= 0) h = h.slice(0, corte);
  h = h.replace(/<(style|script|head)[\s\S]*?<\/\1>/gi, "")
    .replace(/<br\s*\/?>/gi, "\n").replace(/<\/(p|div|li|tr|h\d)>/gi, "\n").replace(/<[^>]+>/g, "")
    .replace(/&(#x[0-9a-f]+|#\d+|[a-z]+|#39);/gi, (m, e: string) => {
      if (/^#x/i.test(e)) return String.fromCodePoint(parseInt(e.slice(2), 16));
      if (/^#\d/.test(e) && e !== "#39") return String.fromCodePoint(Number(e.slice(1)));
      return entidades[e.toLowerCase()] ?? m;
    });
  return h.replace(/[ \t]+\n/g, "\n").replace(/\n{3,}/g, "\n\n").trim();
}

/** Texto del correo: primero text/plain; si no hay, el HTML pasado a texto. Sin la parte citada. */
export function extraerTexto(p: ParteGmail | undefined): string {
  const todas = partes(p).filter((x) => !x.filename && x.body?.data);
  const plano = todas.find((x) => (x.mimeType ?? "").toLowerCase() === "text/plain");
  if (plano) return quitarCitado(decodificar(bytesDeBase64url(plano.body!.data!), charsetDe(plano)));
  const html = todas.find((x) => (x.mimeType ?? "").toLowerCase() === "text/html");
  if (html) return quitarCitado(htmlATexto(decodificar(bytesDeBase64url(html.body!.data!), charsetDe(html))));
  return "";
}

// Marcas de "acá empieza lo citado" en inglés, español y chino (y los separadores de Outlook / QQ / NetEase).
const ESCRIBIO = /^(On|El|Em|Le|Am)\s.+(wrote|escribió|escreveu|a écrit|schrieb)\s*:\s*$/i;
const ESCRIBIO_ZH = /(写道|寫道)\s*[:：]?\s*$/;
const SEPARADOR = /^\s*-{2,}\s*(原始邮件|原始郵件|Original( Message)?|Mensaje original|Forwarded message|Mensaje reenviado|转发的邮件)\s*-{2,}/i;
const DE = /^\s*\**(From|De|发件人|發件人)\s*\**\s*[:：]/i;
const ENVIADO = /^\s*\**(Sent|Date|Enviado|Fecha|发送时间|發送時間|日期)\s*\**\s*[:：]/i;
const FIRMA = /^(--\s*|_{5,}|Sent from my .+|Enviado desde mi .+|Get Outlook for .+|发自我的.+)$/i;

/** Saca la parte citada de una respuesta: "On … wrote:", "El … escribió:", "…写道：", líneas con ">", firmas. */
export function quitarCitado(texto: string): string {
  const lineas = texto.replace(/\r\n?/g, "\n").split("\n");
  const out: string[] = [];
  for (let i = 0; i < lineas.length; i++) {
    const l = lineas[i].trim();
    const juntas = `${l} ${(lineas[i + 1] ?? "").trim()}`;
    if (ESCRIBIO.test(l) || (/^(On|El|Em|Le|Am)\s/i.test(l) && ESCRIBIO.test(juntas)) || ESCRIBIO_ZH.test(l)) break;
    if (SEPARADOR.test(l) || FIRMA.test(l)) break;
    if (DE.test(l) && lineas.slice(i + 1, i + 4).some((x) => ENVIADO.test(x))) break;
    if (l.startsWith(">")) continue;
    out.push(lineas[i].replace(/\s+$/, ""));
  }
  return out.join("\n").replace(/\n{3,}/g, "\n\n").trim();
}

// ─── Armar el correo (RFC 2822) ─────────────────────────────────────────────
const sinSaltos = (s: string) => s.replace(/[\r\n]+/g, " ").trim(); // un encabezado nunca puede meter otra línea

/** Asunto en RFC 2047 si no es ASCII (chino, tildes): =?UTF-8?B?...?= en trozos de ≤ 75 caracteres. */
export function codificarAsunto(asunto: string): string {
  const s = sinSaltos(asunto);
  if (/^[\x20-\x7e]*$/.test(s)) return s;
  const trozos: string[] = [];
  let actual = "";
  for (const c of s) { // por carácter (nunca corta un carácter chino a la mitad)
    if (new TextEncoder().encode(actual + c).length > 45) { trozos.push(actual); actual = ""; }
    actual += c;
  }
  if (actual) trozos.push(actual);
  return trozos.map((t) => `=?UTF-8?B?${bytesABase64(new TextEncoder().encode(t))}?=`).join("\r\n ");
}

/** "Re: asunto" sin duplicar el "Re:" (también 回复: / 答复: / RE:). */
export function asuntoRespuesta(asunto: string): string {
  const s = sinSaltos(asunto);
  if (!s) return "Re:";
  return /^(re|回复|回覆|答复)\s*[:：]/i.test(s) ? s : `Re: ${s}`;
}

export interface Correo {
  de?: string | null;
  para: string;
  asunto: string;
  texto: string;
  inReplyTo?: string | null;
  references?: string | null;
}

/** Correo RFC 2822 de texto plano UTF-8 (cuerpo en base64, líneas de 76). */
export function armarCorreo(c: Correo): string {
  const cuerpo = bytesABase64(new TextEncoder().encode(c.texto.replace(/\r?\n/g, "\r\n"))).replace(/.{76}/g, "$&\r\n");
  const h = [
    ...(c.de ? [`From: ${sinSaltos(c.de)}`] : []),
    `To: ${sinSaltos(c.para)}`,
    `Subject: ${codificarAsunto(c.asunto)}`,
    ...(c.inReplyTo ? [`In-Reply-To: ${sinSaltos(c.inReplyTo)}`] : []),
    ...(c.references ? [`References: ${sinSaltos(c.references)}`] : []),
    "MIME-Version: 1.0",
    "Content-Type: text/plain; charset=UTF-8",
    "Content-Transfer-Encoding: base64",
  ];
  return `${h.join("\r\n")}\r\n\r\n${cuerpo}`;
}

/** Respuesta en el mismo hilo a un mensaje: To = Reply-To o From, "Re: asunto", In-Reply-To y References. */
export function armarRespuesta(original: MensajeGmail, texto: string, de?: string | null): { raw: string; threadId: string; para: string; asunto: string } {
  const p = original.payload;
  const para = direccionDe(encabezado(p, "Reply-To")) || direccionDe(encabezado(p, "From"));
  const mid = encabezado(p, "Message-ID") || encabezado(p, "Message-Id");
  const refs = [encabezado(p, "References"), mid].filter(Boolean).join(" ").trim();
  const asunto = asuntoRespuesta(encabezado(p, "Subject"));
  const raw = base64url(armarCorreo({ de, para, asunto, texto, inReplyTo: mid || null, references: refs || null }));
  return { raw, threadId: original.threadId, para, asunto };
}

// ─── Cliente de la Gmail API ────────────────────────────────────────────────
export interface CredencialesGmail { clientId: string; clientSecret: string; refreshToken: string }

export class ErrorGmail extends Error {
  constructor(mensaje: string, public status?: number) {
    super(mensaje);
  }
}

/** Credenciales desde los secretos; null si falta alguno. */
export function credencialesDesdeEntorno(env: (n: string) => string | undefined = (n) => Deno.env.get(n)): CredencialesGmail | null {
  const clientId = env("GMAIL_CLIENT_ID"), clientSecret = env("GMAIL_CLIENT_SECRET"), refreshToken = env("GMAIL_REFRESH_TOKEN");
  return clientId && clientSecret && refreshToken ? { clientId, clientSecret, refreshToken } : null;
}

export function crearClienteGmail(cred: CredencialesGmail, f: typeof fetch = (...a) => fetch(...a)): ClienteGmail {
  let token: { valor: string; hasta: number } | null = null;

  async function acceso(): Promise<string> {
    if (token && token.hasta > Date.now() + 60_000) return token.valor;
    const r = await f(TOKEN_URL, {
      method: "POST",
      headers: { "content-type": "application/x-www-form-urlencoded" },
      body: new URLSearchParams({ client_id: cred.clientId, client_secret: cred.clientSecret, refresh_token: cred.refreshToken, grant_type: "refresh_token" }),
    });
    const j = await r.json().catch(() => ({})) as { access_token?: string; expires_in?: number; error?: string };
    // invalid_grant = el permiso se revocó o venció (app de Google en modo "Testing": vence a los 7 días).
    if (!r.ok || !j.access_token) throw new ErrorGmail(`token de Gmail: ${j.error ?? `HTTP ${r.status}`}`, r.status);
    token = { valor: j.access_token, hasta: Date.now() + (j.expires_in ?? 3600) * 1000 };
    return token.valor;
  }

  async function api<T>(ruta: string, init?: RequestInit): Promise<T> {
    const r = await f(`${GMAIL_API}${ruta}`, { ...init, headers: { ...(init?.headers ?? {}), authorization: `Bearer ${await acceso()}` } });
    const j = await r.json().catch(() => ({})) as T & { error?: { message?: string } };
    if (!r.ok) throw new ErrorGmail(`Gmail ${ruta.split("?")[0]}: ${j?.error?.message ?? `HTTP ${r.status}`}`, r.status);
    return j;
  }

  const META = ["From", "Reply-To", "Subject", "Message-ID", "References", "In-Reply-To"].map((h) => `metadataHeaders=${h}`).join("&");

  return {
    async perfil() {
      return (await api<{ emailAddress?: string }>("/profile")).emailAddress?.toLowerCase() ?? "";
    },
    async listar(q, max = 50) {
      const j = await api<{ messages?: Array<{ id: string }> }>(`/messages?q=${encodeURIComponent(q)}&maxResults=${max}`);
      return (j.messages ?? []).map((m) => m.id);
    },
    leer(id, formato) {
      return api<MensajeGmail>(`/messages/${encodeURIComponent(id)}?format=${formato}${formato === "metadata" ? `&${META}` : ""}`);
    },
    hilo(id) {
      return api<HiloGmail>(`/threads/${encodeURIComponent(id)}?format=metadata&${META}`);
    },
    async enviar(raw, threadId) {
      let r: Response;
      try {
        r = await f(`${GMAIL_API}/messages/send`, {
          method: "POST",
          headers: { authorization: `Bearer ${await acceso()}`, "content-type": "application/json" },
          body: JSON.stringify(threadId ? { raw, threadId } : { raw }),
        });
      } catch (e) {
        // Sin token no salió nada; un corte de red después de mandar no se sabe.
        if (e instanceof ErrorGmail) return { ok: false, error: e.message, seguro: true };
        return { ok: false, error: e instanceof Error ? e.message : String(e), seguro: false };
      }
      const j = await r.json().catch(() => ({})) as { id?: string; threadId?: string; error?: { message?: string } };
      if (r.ok && j.id) return { ok: true, id: j.id, threadId: j.threadId ?? threadId ?? "" };
      // Google contestó con error → no salió (FAILED). 200 sin id: raro, no sabemos (SEND_UNKNOWN).
      return { ok: false, error: `Gmail send: ${j.error?.message ?? `HTTP ${r.status}`}`, seguro: !r.ok };
    },
  };
}
