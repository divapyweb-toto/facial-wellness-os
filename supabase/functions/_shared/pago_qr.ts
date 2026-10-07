// _shared/pago_qr.ts · Dueño: I1 (ola 4, mejora 2: pagar antes con QR)
// Adaptadores de cobro QR por pedido + verificación de webhooks. Sin dependencias externas.
//
// Proveedores (verificado en la documentación pública, 06-10-2026):
//   - AdamsPay: https://wiki.adamspay.com/devzone:api (deudas) y devzone:concepts:webhook.
//       POST {base}/debts, headers `apikey` y `x-if-exists: update`, cuerpo {debt:{docId,label,amount:{currency,value},validPeriod:{start,end}}}
//       (fechas en UTC), respuesta debt.payUrl. Base staging https://staging.adamspay.com/api/v1,
//       producción https://checkout.adamspay.com/api/v1.
//       Webhook: header x-adams-notify-hash = md5('adams' + cuerpo crudo + secreto de la app); debt.payStatus.status 'paid'.
//   - arnipay: https://github.com/arnipay/gateway-documentation (payment-links.md).
//       POST https://arnipay.com.py/api/v1/payment, headers X-Client-ID, X-Timestamp, X-Signature
//       = hex(HMAC-SHA256(METHOD\nURI\nTIMESTAMP\nCLIENT_ID\nbase64(sha256(cuerpo)), clave privada)).
//       Respuesta data.id y data.url. Webhook con la misma firma (secreto del webhook) + X-Webhook-ID;
//       evento payment.completed con data.status 'paid' y data.link_id.
//   - upay: su portal de desarrolladores (desarrolladores.upay.com.py) no se pudo leer sin navegador:
//       queda SOLO el simulador hasta tener la documentación.
//
// Modo simulado (CONTRATO-OLAS2-4): si MODO_SIMULADO=1, si falta QR_API_KEY o si el proveedor
// no tiene adaptador, se usa un simulador determinista y la respuesta dice `simulado: true`.
//
// Secretos (nombres; los valores los carga Enrique): QR_PROVEEDOR ('adamspay'|'arnipay'|'upay'),
// QR_API_KEY (AdamsPay: apikey · arnipay: clave privada), QR_CLIENT_ID (solo arnipay),
// QR_WEBHOOK_SECRET (AdamsPay: secreto de la app · arnipay: secreto del webhook),
// QR_AMBIENTE ('produccion' para AdamsPay real; cualquier otro valor = staging).

export type ProveedorQR = "adamspay" | "arnipay" | "upay" | "simulado";

export interface PedidoCobro {
  shopify_order_id: number;
  nombre: string | null; // '#1001'
  total: number; // guaraníes, sin decimales
}

export interface OpcionesCobro {
  validezHoras?: number; // default 48
  etiqueta?: string; // default "Pedido Voltra #1001"
}

export interface ResultadoCobro {
  ok: boolean;
  proveedor: ProveedorQR;
  url?: string;
  qr_texto?: string;
  /** Con lo que vuelve el webhook: AdamsPay = docId; arnipay = id del link de pago. */
  id_externo?: string;
  simulado: boolean;
  error?: string;
}

export interface EventoPagoQR {
  id_evento: string;
  id_externo: string;
  pagado: boolean;
  monto: number | null;
  estado_crudo: string;
}

export interface ResultadoWebhookQR {
  ok: boolean;
  proveedor?: ProveedorQR;
  evento?: EventoPagoQR;
  error?: string;
}

export interface EntornoQR {
  fetch: typeof fetch;
  env: (nombre: string) => string | undefined;
  ahora: () => Date;
}

const entornoPorDefecto: EntornoQR = {
  fetch: (...a) => fetch(...a),
  env: (n) => Deno.env.get(n) ?? undefined,
  ahora: () => new Date(),
};
let entorno: EntornoQR = entornoPorDefecto;

/** Solo para tests: reemplaza fetch, variables de entorno y reloj. */
export function _configurarQR(parcial?: Partial<EntornoQR>): void {
  entorno = parcial ? { ...entornoPorDefecto, ...parcial } : entornoPorDefecto;
}

export const ADAMSPAY_STAGING = "https://staging.adamspay.com/api/v1";
export const ADAMSPAY_PRODUCCION = "https://checkout.adamspay.com/api/v1";
export const ARNIPAY_BASE = "https://arnipay.com.py";
export const ARNIPAY_RUTA_PAGO = "/api/v1/payment";
const VENTANA_FIRMA_ARNIPAY_S = 15 * 60;

/** id que se manda al proveedor como referencia del pedido. */
export function referenciaPedido(orderId: number): string {
  return `voltra-${orderId}`;
}

export function orderIdDesdeReferencia(ref: string): number | null {
  const m = /^voltra-(\d+)$/.exec(ref ?? "");
  return m ? Number(m[1]) : null;
}

function proveedorConfigurado(): ProveedorQR {
  const p = (entorno.env("QR_PROVEEDOR") ?? "").trim().toLowerCase();
  return p === "adamspay" || p === "arnipay" || p === "upay" ? p : "simulado";
}

/** Proveedor que se usa de verdad (o 'simulado') y por qué. */
export function proveedorEfectivo(): { proveedor: ProveedorQR; simulado: boolean; motivo?: string } {
  const p = proveedorConfigurado();
  if (entorno.env("MODO_SIMULADO") === "1") return { proveedor: "simulado", simulado: true, motivo: "MODO_SIMULADO=1" };
  if (p === "simulado") return { proveedor: "simulado", simulado: true, motivo: "QR_PROVEEDOR vacío" };
  if (p === "upay") return { proveedor: "simulado", simulado: true, motivo: "upay sin adaptador (documentación no disponible)" };
  if (!entorno.env("QR_API_KEY")) return { proveedor: "simulado", simulado: true, motivo: "falta QR_API_KEY" };
  if (p === "arnipay" && !entorno.env("QR_CLIENT_ID")) {
    return { proveedor: "simulado", simulado: true, motivo: "falta QR_CLIENT_ID" };
  }
  return { proveedor: p, simulado: false };
}

// ─── Crear cobro ─────────────────────────────────────────────

/** Fecha UTC sin zona, como pide AdamsPay ("2024-01-15T10:30:00"). */
export function fechaUtcSinZona(d: Date): string {
  return d.toISOString().slice(0, 19);
}

export async function crearCobroQR(pedido: PedidoCobro, opciones: OpcionesCobro = {}): Promise<ResultadoCobro> {
  const total = Math.round(Number(pedido.total));
  if (!Number.isFinite(total) || total < 1) {
    return { ok: false, proveedor: proveedorConfigurado(), simulado: false, error: "monto_invalido" };
  }
  const ef = proveedorEfectivo();
  const etiqueta = (opciones.etiqueta ?? `Pedido Voltra ${pedido.nombre ?? pedido.shopify_order_id}`).slice(0, 255);
  const validezMs = (opciones.validezHoras ?? 48) * 3_600_000;
  const ref = referenciaPedido(pedido.shopify_order_id);

  if (ef.simulado) {
    console.log(`pago_qr: simulador (${ef.motivo}) para ${ref}`);
    return {
      ok: true,
      proveedor: "simulado",
      url: `https://pago-simulado.invalid/voltra/${pedido.shopify_order_id}`,
      qr_texto: `SIMULADO|${ref}|${total}`,
      id_externo: ref,
      simulado: true,
    };
  }
  try {
    return ef.proveedor === "adamspay"
      ? await crearAdamsPay(ref, etiqueta, total, validezMs)
      : await crearArnipay(ref, etiqueta, total, validezMs);
  } catch (e) {
    return { ok: false, proveedor: ef.proveedor, simulado: false, error: `red: ${e instanceof Error ? e.message : e}` };
  }
}

async function crearAdamsPay(ref: string, etiqueta: string, total: number, validezMs: number): Promise<ResultadoCobro> {
  const base = entorno.env("QR_AMBIENTE") === "produccion" ? ADAMSPAY_PRODUCCION : ADAMSPAY_STAGING;
  const ahora = entorno.ahora();
  const cuerpo = {
    debt: {
      docId: ref,
      label: etiqueta,
      amount: { currency: "PYG", value: String(total) },
      validPeriod: { start: fechaUtcSinZona(ahora), end: fechaUtcSinZona(new Date(ahora.getTime() + validezMs)) },
    },
  };
  const r = await entorno.fetch(`${base}/debts`, {
    method: "POST",
    headers: { "apikey": entorno.env("QR_API_KEY")!, "Content-Type": "application/json", "x-if-exists": "update" },
    body: JSON.stringify(cuerpo),
  });
  const j = await r.json().catch(() => ({})) as { debt?: { payUrl?: string; docId?: string }; meta?: { description?: string } };
  if (!r.ok || !j?.debt?.payUrl) {
    return { ok: false, proveedor: "adamspay", simulado: false, error: `adamspay HTTP ${r.status}: ${j?.meta?.description ?? "sin payUrl"}` };
  }
  return { ok: true, proveedor: "adamspay", url: j.debt.payUrl, id_externo: j.debt.docId ?? ref, simulado: false };
}

async function crearArnipay(ref: string, etiqueta: string, total: number, validezMs: number): Promise<ResultadoCobro> {
  const vence = new Date(entorno.ahora().getTime() + validezMs);
  const cuerpo = JSON.stringify({
    price: total,
    title: etiqueta,
    reference: ref,
    payment_methods: ["qr"],
    // La documentación dice "date"; se manda AAAA-MM-DD. [VERIFICAR con arnipay si acepta hora]
    expiration_date: vence.toISOString().slice(0, 10),
  });
  const clientId = entorno.env("QR_CLIENT_ID")!;
  const ts = String(Math.floor(entorno.ahora().getTime() / 1000));
  const firma = await firmaArnipay("POST", ARNIPAY_RUTA_PAGO, ts, clientId, cuerpo, entorno.env("QR_API_KEY")!);
  const r = await entorno.fetch(`${ARNIPAY_BASE}${ARNIPAY_RUTA_PAGO}`, {
    method: "POST",
    headers: { "X-Client-ID": clientId, "X-Timestamp": ts, "X-Signature": firma, "Content-Type": "application/json" },
    body: cuerpo,
  });
  const j = await r.json().catch(() => ({})) as { status?: string; message?: string; data?: { id?: string; url?: string } };
  if (!r.ok || j?.status !== "success" || !j.data?.url || !j.data?.id) {
    return { ok: false, proveedor: "arnipay", simulado: false, error: `arnipay HTTP ${r.status}: ${j?.message ?? "sin url"}` };
  }
  return { ok: true, proveedor: "arnipay", url: j.data.url, id_externo: j.data.id, simulado: false };
}

// ─── Firmas ──────────────────────────────────────────────────

const enc = new TextEncoder();

function aHex(b: Uint8Array): string {
  return [...b].map((x) => x.toString(16).padStart(2, "0")).join("");
}

function aBase64(b: Uint8Array): string {
  let s = "";
  for (const x of b) s += String.fromCharCode(x);
  return btoa(s);
}

export async function hmacSha256Hex(mensaje: string, clave: string): Promise<string> {
  const k = await crypto.subtle.importKey("raw", enc.encode(clave), { name: "HMAC", hash: "SHA-256" }, false, ["sign"]);
  return aHex(new Uint8Array(await crypto.subtle.sign("HMAC", k, enc.encode(mensaje))));
}

export async function sha256Base64(texto: string): Promise<string> {
  return aBase64(new Uint8Array(await crypto.subtle.digest("SHA-256", enc.encode(texto))));
}

export async function firmaArnipay(
  metodo: string,
  uri: string,
  timestamp: string,
  clientId: string,
  cuerpoCrudo: string,
  clave: string,
): Promise<string> {
  const canonica = [metodo.toUpperCase(), uri, timestamp, clientId, await sha256Base64(cuerpoCrudo)].join("\n");
  return await hmacSha256Hex(canonica, clave);
}

/** Comparación en tiempo constante. */
export function igualesConstante(a: string, b: string): boolean {
  const ea = enc.encode(a), eb = enc.encode(b);
  let d = ea.length ^ eb.length;
  for (let i = 0; i < Math.max(ea.length, eb.length); i++) d |= (ea[i] ?? 0) ^ (eb[i] ?? 0);
  return d === 0;
}

/** MD5 (RFC 1321) en hex. Web Crypto no lo trae y AdamsPay firma sus webhooks con MD5. */
export function md5Hex(texto: string): string {
  const datos = enc.encode(texto);
  const largoBits = datos.length * 8;
  const n = (((datos.length + 8) >>> 6) + 1) * 64;
  const buf = new Uint8Array(n);
  buf.set(datos);
  buf[datos.length] = 0x80;
  const dv = new DataView(buf.buffer);
  dv.setUint32(n - 8, largoBits >>> 0, true);
  dv.setUint32(n - 4, Math.floor(largoBits / 2 ** 32), true);

  const S = [7, 12, 17, 22, 5, 9, 14, 20, 4, 11, 16, 23, 6, 10, 15, 21];
  const K = Array.from({ length: 64 }, (_, i) => Math.floor(Math.abs(Math.sin(i + 1)) * 2 ** 32) >>> 0);
  let a0 = 0x67452301, b0 = 0xefcdab89, c0 = 0x98badcfe, d0 = 0x10325476;
  for (let off = 0; off < n; off += 64) {
    const M = Array.from({ length: 16 }, (_, i) => dv.getUint32(off + i * 4, true));
    let A = a0, B = b0, C = c0, D = d0;
    for (let i = 0; i < 64; i++) {
      let F: number, g: number;
      if (i < 16) { F = (B & C) | (~B & D); g = i; }
      else if (i < 32) { F = (D & B) | (~D & C); g = (5 * i + 1) % 16; }
      else if (i < 48) { F = B ^ C ^ D; g = (3 * i + 5) % 16; }
      else { F = C ^ (B | ~D); g = (7 * i) % 16; }
      const s = S[(i >> 4) * 4 + (i % 4)];
      const tmp = D;
      D = C;
      C = B;
      const x = (A + F + K[i] + M[g]) >>> 0;
      B = (B + ((x << s) | (x >>> (32 - s)))) >>> 0;
      A = tmp;
    }
    a0 = (a0 + A) >>> 0; b0 = (b0 + B) >>> 0; c0 = (c0 + C) >>> 0; d0 = (d0 + D) >>> 0;
  }
  const out = new Uint8Array(16);
  const ov = new DataView(out.buffer);
  [a0, b0, c0, d0].forEach((v, i) => ov.setUint32(i * 4, v, true));
  return aHex(out);
}

// ─── Webhook ─────────────────────────────────────────────────

export interface OpcionesWebhook {
  metodo?: string; // default POST
  /** URIs (ruta + query) con las que el proveedor pudo firmar; se acepta si coincide con alguna. */
  uris?: string[];
}

type Obj = Record<string, unknown>;
const obj = (x: unknown): Obj => (x && typeof x === "object" && !Array.isArray(x) ? x as Obj : {});
const num = (x: unknown): number | null => {
  const n = typeof x === "number" ? x : typeof x === "string" && x.trim() ? Number(x) : NaN;
  return Number.isFinite(n) ? n : null;
};

/**
 * Verifica la firma del webhook y lo traduce a un evento común.
 * El proveedor se detecta por los headers. Nunca acepta un webhook sin firma válida.
 */
export async function verificarWebhookQR(
  raw: string,
  headers: Headers,
  opciones: OpcionesWebhook = {},
): Promise<ResultadoWebhookQR> {
  const secreto = entorno.env("QR_WEBHOOK_SECRET");
  let cuerpo: Obj;
  const parsear = () => {
    try {
      cuerpo = obj(JSON.parse(raw));
      return true;
    } catch {
      return false;
    }
  };

  // AdamsPay
  const hashAdams = headers.get("x-adams-notify-hash");
  if (hashAdams) {
    if (!secreto) return { ok: false, proveedor: "adamspay", error: "falta QR_WEBHOOK_SECRET" };
    if (!igualesConstante(md5Hex("adams" + raw + secreto), hashAdams.trim().toLowerCase())) {
      return { ok: false, proveedor: "adamspay", error: "firma_invalida" };
    }
    if (!parsear()) return { ok: false, proveedor: "adamspay", error: "json_invalido" };
    const notify = obj(cuerpo!.notify);
    const debt = obj(cuerpo!.debt);
    const docId = String(debt.docId ?? "");
    if (notify.type !== "debtStatus" || !docId) {
      return { ok: false, proveedor: "adamspay", error: `evento_no_soportado:${String(notify.type ?? "")}` };
    }
    const pay = String(obj(debt.payStatus).status ?? "");
    return {
      ok: true,
      proveedor: "adamspay",
      evento: {
        id_evento: String(notify.id ?? md5Hex(raw)),
        id_externo: docId,
        pagado: pay === "paid",
        monto: num(obj(debt.amount).value), // [VERIFICAR] el ejemplo público no muestra amount en la notificación
        estado_crudo: `${pay}/${String(obj(debt.objStatus).status ?? "")}`,
      },
    };
  }

  // arnipay
  const firma = headers.get("x-signature");
  const clientIdHdr = headers.get("x-client-id");
  if (firma && clientIdHdr) {
    if (!secreto) return { ok: false, proveedor: "arnipay", error: "falta QR_WEBHOOK_SECRET" };
    const esperado = entorno.env("QR_CLIENT_ID");
    if (esperado && !igualesConstante(esperado, clientIdHdr)) return { ok: false, proveedor: "arnipay", error: "client_id_distinto" };
    const ts = headers.get("x-timestamp") ?? "";
    const tsN = Number(ts);
    if (!Number.isFinite(tsN) || Math.abs(entorno.ahora().getTime() / 1000 - tsN) > VENTANA_FIRMA_ARNIPAY_S) {
      return { ok: false, proveedor: "arnipay", error: "timestamp_vencido" };
    }
    let valida = false;
    for (const uri of opciones.uris ?? []) {
      const f = await firmaArnipay(opciones.metodo ?? "POST", uri, ts, clientIdHdr, raw, secreto);
      if (igualesConstante(f, firma.trim().toLowerCase())) valida = true;
    }
    if (!valida) return { ok: false, proveedor: "arnipay", error: "firma_invalida" };
    if (!parsear()) return { ok: false, proveedor: "arnipay", error: "json_invalido" };
    const data = obj(cuerpo!.data);
    const linkId = String(data.link_id ?? "");
    if (!linkId) return { ok: false, proveedor: "arnipay", error: "sin_link_id" };
    const ev = String(cuerpo!.event ?? "");
    return {
      ok: true,
      proveedor: "arnipay",
      evento: {
        id_evento: headers.get("x-webhook-id") ?? `${linkId}:${String(data.payment_id ?? "")}:${ev}`,
        id_externo: linkId,
        pagado: ev === "payment.completed" && data.status === "paid",
        monto: num(data.amount),
        estado_crudo: `${ev}/${String(data.status ?? "")}`,
      },
    };
  }

  // Simulador: solo con MODO_SIMULADO=1 (nunca en producción). Firma = hex(HMAC-SHA256(cuerpo, QR_WEBHOOK_SECRET)).
  const firmaSim = headers.get("x-simulado-firma");
  if (firmaSim) {
    if (entorno.env("MODO_SIMULADO") !== "1") return { ok: false, proveedor: "simulado", error: "simulador_desactivado" };
    if (!secreto) return { ok: false, proveedor: "simulado", error: "falta QR_WEBHOOK_SECRET" };
    if (!igualesConstante(await hmacSha256Hex(raw, secreto), firmaSim.trim().toLowerCase())) {
      return { ok: false, proveedor: "simulado", error: "firma_invalida" };
    }
    if (!parsear()) return { ok: false, proveedor: "simulado", error: "json_invalido" };
    const ref = String(cuerpo!.referencia ?? "");
    if (!ref) return { ok: false, proveedor: "simulado", error: "sin_referencia" };
    return {
      ok: true,
      proveedor: "simulado",
      evento: {
        id_evento: String(cuerpo!.id ?? md5Hex(raw)),
        id_externo: ref,
        pagado: cuerpo!.estado === "pagado",
        monto: num(cuerpo!.monto),
        estado_crudo: String(cuerpo!.estado ?? ""),
      },
    };
  }

  return { ok: false, error: "sin_firma_reconocida" };
}
