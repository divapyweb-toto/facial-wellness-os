// _shared/correo.ts · adaptador de correo con Resend (29-10-2026) · dueño: subagente B.
// API: POST https://api.resend.com/emails, Authorization: Bearer <RESEND_API_KEY>, JSON {from,to,subject,html,text,attachments}.
// Adjuntos: {filename, path} (URL pública que Resend descarga) o {filename, content} (base64). Respuesta ok: {id}.
// Patrón del proyecto: sin RESEND_API_KEY queda SIMULADO ({ok:true, simulado:true}) y no toca la red.
// Nunca tira excepción: el flujo que lo llama no falla por el correo.

export const RESEND_URL = "https://api.resend.com/emails";
export const REMITENTE_POR_DEFECTO = "Voltra <facturas@voltraparaguay.com>";

export interface Adjunto {
  filename: string;
  /** URL pública (https) del archivo; Resend lo descarga. */
  path?: string;
  /** Contenido en base64 (alternativa a path). */
  content?: string;
}

export interface Correo {
  para: string | string[];
  asunto: string;
  texto?: string;
  html?: string;
  adjuntos?: Adjunto[];
}

export type ResultadoCorreo = { ok: boolean; simulado?: boolean; id?: string; error?: string };

/** I/O inyectable; los tests reemplazan fetch y las variables de entorno. */
export interface EntornoCorreo {
  fetch: typeof fetch;
  clave: () => string | undefined;
  remitente: () => string | undefined;
  responderA: () => string | undefined;
}

const env = (n: string) => {
  try {
    return Deno.env.get(n) ?? undefined;
  } catch {
    return undefined;
  }
};

const entornoReal: EntornoCorreo = {
  fetch: (...a) => fetch(...a),
  clave: () => env("RESEND_API_KEY"),
  remitente: () => env("RESEND_FROM"),
  responderA: () => env("RESEND_REPLY_TO"),
};

/** Validación mínima (no RFC completa): algo@algo.tld, sin espacios. */
export function emailValido(e: string | null | undefined): boolean {
  return typeof e === "string" && /^[^\s@<>,;]+@[^\s@<>,;]+\.[a-z]{2,}$/i.test(e.trim());
}

export async function enviarCorreo(c: Correo, entorno: Partial<EntornoCorreo> = {}): Promise<ResultadoCorreo> {
  const e = { ...entornoReal, ...entorno };
  const para = (Array.isArray(c.para) ? c.para : [c.para]).map((x) => (x ?? "").trim()).filter(Boolean);
  if (!para.length || !para.every(emailValido)) return { ok: false, error: "destinatario_invalido" };
  if (!c.asunto?.trim()) return { ok: false, error: "asunto_vacio" };
  if (!c.texto?.trim() && !c.html?.trim()) return { ok: false, error: "cuerpo_vacio" };
  for (const a of c.adjuntos ?? []) {
    if (!a.filename?.trim() || (!a.path && !a.content)) return { ok: false, error: "adjunto_invalido" };
  }
  const clave = e.clave();
  if (!clave) return { ok: true, simulado: true };

  const cuerpo: Record<string, unknown> = {
    from: e.remitente()?.trim() || REMITENTE_POR_DEFECTO,
    to: para,
    subject: c.asunto.trim(),
  };
  if (c.html) cuerpo.html = c.html;
  if (c.texto) cuerpo.text = c.texto;
  const responder = e.responderA()?.trim();
  if (responder && emailValido(responder)) cuerpo.reply_to = responder;
  if (c.adjuntos?.length) {
    cuerpo.attachments = c.adjuntos.map((a) => (a.path ? { filename: a.filename, path: a.path } : { filename: a.filename, content: a.content }));
  }
  try {
    const r = await e.fetch(RESEND_URL, {
      method: "POST",
      headers: { Authorization: `Bearer ${clave}`, "Content-Type": "application/json" },
      body: JSON.stringify(cuerpo),
      signal: AbortSignal.timeout(20_000),
    });
    const j = await r.json().catch(() => ({})) as { id?: string; message?: string; name?: string };
    if (!r.ok || !j.id) return { ok: false, error: `resend ${r.status}: ${j.message ?? j.name ?? "sin id"}` };
    return { ok: true, id: j.id };
  } catch (err) {
    return { ok: false, error: `red: ${err instanceof Error ? err.message : String(err)}` };
  }
}

// ---------- contenido del correo de la factura ----------

/** 112000 → "112.000" (separador de miles de Paraguay, sin decimales). */
export function formatoGs(n: number): string {
  const v = Math.round(Math.abs(n)).toString().replace(/\B(?=(\d{3})+(?!\d))/g, ".");
  return n < 0 ? `-${v}` : v;
}

function escHtml(s: string): string {
  return s.replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;").replace(/"/g, "&quot;");
}

/** Asunto y cuerpo del correo con el KuDE. Sin datos sensibles en el asunto (solo el número de la factura). */
export function correoFactura(a: { nombre: string | null; numeroCompleto: string; total: number | null }): { asunto: string; texto: string; html: string } {
  const nombre = (a.nombre ?? "").replace(/\s+/g, " ").trim();
  const saludo = nombre ? `Hola, ${nombre}:` : "Hola:";
  const totalTxt = a.total != null && Number.isFinite(a.total) ? ` por un total de Gs. ${formatoGs(a.total)}` : "";
  const linea1 = `Gracias por tu compra. Te adjuntamos tu factura electrónica N.º ${a.numeroCompleto}${totalTxt}.`;
  const linea2 = "Podés verificarla en la SET con el código QR impreso en la factura.";
  const texto = `${saludo}\n\n${linea1}\n\n${linea2}\n\nVoltra`;
  const html = [saludo, linea1, linea2, "Voltra"].map((l) => `<p>${escHtml(l)}</p>`).join("\n");
  return { asunto: `Tu factura de Voltra N.º ${a.numeroCompleto}`, texto, html };
}
