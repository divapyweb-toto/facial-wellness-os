// _shared/meta_capi.ts · Dueño: H2 (ola 3)
// Envía a Meta (Conversions API, Graph v25.0) el evento de "pedido entregado".
//
// Dos envíos:
//  1. Dataset de campañas ("datos de voltra", META_DATASET_ID): evento PROPIO
//     "PedidoEntregado" (sobre él se arma la conversión personalizada en el
//     Administrador de eventos), action_source "system_generated", teléfono con
//     SHA-256 (E.164 sin '+'), value en PYG.
//  2. Dataset de mensajería (META_DATASET_MENSAJERIA_ID): SOLO si el chat vino de
//     un anuncio click-to-WhatsApp (hay ctwa_clid). La doc de Business Messaging
//     no admite eventos personalizados: se usa el estándar "OrderDelivered" con
//     action_source "business_messaging", messaging_channel "whatsapp" y
//     user_data {whatsapp_business_account_id, ctwa_clid}.
//
// event_id = "entregado:<order_id>" en los dos: Meta descarta repetidos con el
// mismo event_id + event_name, así un reintento no duplica.
//
// Modo simulado (contrato olas 2-4): sin META_CAPI_TOKEN o con MODO_SIMULADO=1
// no se llama a Meta; se arma el payload, se registra en el log y vuelve
// {ok:true, simulado:true}.
//
// Secretos (nombres): META_CAPI_TOKEN, META_DATASET_ID, META_DATASET_MENSAJERIA_ID,
// WA_WABA_ID. Opcional: META_TEST_EVENT_CODE (para verlos en "Probar eventos").

export const GRAPH_VERSION = "v25.0";
export const EVENTO_PROPIO = "PedidoEntregado";
export const EVENTO_MENSAJERIA = "OrderDelivered";
/** Una venta contra entrega que se registra sola al importar el reporte del courier. */
export const ACTION_SOURCE_PRINCIPAL = "system_generated";
/** Meta rechaza todo el lote si un event_time tiene más de 7 días. */
export const MAX_ANTIGUEDAD_SEG = 7 * 24 * 3600;

export interface PedidoCapi {
  shopify_order_id: number | string;
  nombre?: string | null;
  cliente_id?: string | null;
  /** Fecha real de entrega (ISO). Si falta, se usa "ahora". */
  entregado_en?: string | null;
}

export interface OrigenAnuncio {
  ctwa_clid: string;
  source_id?: string | null;
}

export interface EntradaEvento {
  pedido: PedidoCapi;
  telefonoE164?: string | null;
  valor: number;
  moneda: "PYG";
  origenAnuncio?: OrigenAnuncio | null;
  /** Opcional (09-10): nombre/apellido/ciudad con hash; IP y fbc sin hash. Ver datosClienteDesdeRaw. */
  cliente?: DatosCliente | null;
}

export interface ResultadoEnvio {
  ok: boolean;
  omitido?: string;
  error?: string;
  respuesta?: unknown;
}

export interface ResultadoCapi {
  ok: boolean;
  simulado: boolean;
  principal: ResultadoEnvio;
  mensajeria: ResultadoEnvio;
  payloads?: { principal?: unknown; mensajeria?: unknown };
}

export interface OpcionesCapi {
  token?: string | null;
  datasetId?: string | null;
  datasetMensajeriaId?: string | null;
  wabaId?: string | null;
  testEventCode?: string | null;
  simulado?: boolean;
  actionSource?: string;
  ahora?: Date;
  fetch?: typeof fetch;
}

// ─── Hash y normalización (doc: Customer Information Parameters) ──────────

export async function sha256Hex(texto: string): Promise<string> {
  const buf = await crypto.subtle.digest("SHA-256", new TextEncoder().encode(texto));
  return [...new Uint8Array(buf)].map((b) => b.toString(16).padStart(2, "0")).join("");
}

/** "+595 981 000-000" → "595981000000": solo dígitos, sin ceros iniciales, con código de país. */
export function normalizarTelefonoCapi(tel: string | null | undefined): string | null {
  const d = String(tel ?? "").replace(/\D/g, "").replace(/^0+/, "");
  return d.length >= 8 ? d : null;
}

// ─── Datos extra del cliente (09-10-2026) ─────────────────────────────────
// Doc "Customer Information Parameters" (verificada 09-10-2026):
//  fn/ln: minúsculas, sin puntuación; se admiten caracteres especiales en UTF-8 (ej. de la doc:
//         "Valéry" → "valéry", la tilde SE CONSERVA). Hash obligatorio.
//  ct:    minúsculas, sin puntuación, sin caracteres especiales, sin espacios ("newyork"). Hash obligatorio.
//  client_ip_address: IPv4/IPv6 válida, sin espacios, NUNCA con hash.
//  fbc:   "fb.<subdomain_index>.<creation_time ms>.<fbclid>", NUNCA con hash.

export interface DatosCliente {
  nombre?: string | null;
  apellido?: string | null;
  ciudad?: string | null;
  ip?: string | null;
  fbc?: string | null;
}

/** Puntuación ASCII + signos tipográficos/españoles. Se conservan letras con tilde y la ñ. */
const PUNTUACION = /[\p{P}\p{S}]/gu;

/** fn/ln: primera palabra, minúsculas, sin puntuación, tildes conservadas (NFC). */
export function normalizarNombreCapi(x: string | null | undefined): string | null {
  const s = String(x ?? "").normalize("NFC").toLowerCase().replace(PUNTUACION, " ").replace(/\d/g, " ").trim();
  const primera = s.split(/\s+/)[0] ?? "";
  return primera.length ? primera : null;
}

/** ct: minúsculas, sin tildes (a-z), sin espacios ni puntuación. "Ciudad del Este" → "ciudaddeleste". */
export function normalizarCiudadCapi(x: string | null | undefined): string | null {
  const s = String(x ?? "").normalize("NFD").replace(/[̀-ͯ]/g, "").toLowerCase()
    .replace(/ñ/g, "n").replace(/[^a-z]/g, "");
  return s.length ? s : null;
}

const IPV4 = /^(25[0-5]|2[0-4]\d|1\d\d|[1-9]?\d)(\.(25[0-5]|2[0-4]\d|1\d\d|[1-9]?\d)){3}$/;

/** IP sin hash: devuelve la IP si es IPv4/IPv6 válida; si no, null. */
export function validarIp(x: string | null | undefined): string | null {
  const s = String(x ?? "").trim();
  if (!s || /\s/.test(s)) return null;
  if (IPV4.test(s)) return s;
  if (s.includes(":") && /^[0-9a-fA-F:.]+$/.test(s)) {
    try {
      new URL(`http://[${s}]/`); // el parser de URL valida la sintaxis IPv6
      return s.toLowerCase();
    } catch {
      return null;
    }
  }
  return null;
}

type Raw = Record<string, unknown> | null | undefined;

function notaAttr(raw: Raw, nombre: string): string | null {
  const arr = Array.isArray(raw?.note_attributes) ? raw!.note_attributes as { name?: unknown; value?: unknown }[] : [];
  const n = nombre.toLowerCase();
  const it = arr.find((a) => String(a?.name ?? "").trim().toLowerCase() === n);
  const v = it?.value == null ? "" : String(it.value).trim();
  return v || null;
}

function fbclidDe(texto: string | null | undefined): string | null {
  const m = String(texto ?? "").match(/[?&#]fbclid=([^&#\s]+)/);
  if (!m) return null;
  try {
    return decodeURIComponent(m[1]);
  } catch {
    return m[1];
  }
}

/**
 * Saca nombre, apellido, ciudad, IP y fbc del raw de Shopify (pedido de Releasit).
 * IP: solo del note_attribute "IP address" de Releasit (los pedidos de WhatsApp no lo traen → sin IP).
 * fbc: note_attribute "_fbc"/"fbc" ya armado; si no, fbclid en landing_site/referring_site/notas →
 * "fb.1.<created_at ms>.<fbclid>".
 */
export function datosClienteDesdeRaw(raw: Raw): DatosCliente {
  if (!raw || typeof raw !== "object") return {};
  const sa = (raw.shipping_address ?? raw.billing_address ?? {}) as Record<string, unknown>;
  let nombre = sa.first_name ? String(sa.first_name) : null;
  let apellido = sa.last_name ? String(sa.last_name) : null;
  const completo = notaAttr(raw, "NOMBRE COMPLETO") ?? (sa.name ? String(sa.name) : null);
  if (!nombre && !apellido && completo) {
    const p = completo.trim().split(/\s+/);
    nombre = p[0] ?? null;
    apellido = p.length > 1 ? p[1] : null;
  } else if (nombre && !apellido) {
    // Releasit a veces mete el nombre completo en first_name.
    const p = nombre.trim().split(/\s+/);
    if (p.length > 1) {
      nombre = p[0];
      apellido = p[1];
    }
  }
  const ciudad = sa.city ? String(sa.city) : notaAttr(raw, "Ciudad");
  const ip = validarIp(notaAttr(raw, "IP address"));

  let fbc = notaAttr(raw, "_fbc") ?? notaAttr(raw, "fbc");
  if (fbc && !/^fb\.\d+\.\d+\..+/.test(fbc)) fbc = null;
  if (!fbc) {
    const arr = Array.isArray(raw.note_attributes) ? raw.note_attributes as { value?: unknown }[] : [];
    const clid = notaAttr(raw, "fbclid") ??
      fbclidDe(raw.landing_site as string) ?? fbclidDe(raw.referring_site as string) ??
      arr.map((a) => fbclidDe(String(a?.value ?? ""))).find(Boolean) ?? null;
    const t = new Date(String(raw.created_at ?? "")).getTime();
    if (clid && Number.isFinite(t)) fbc = `fb.1.${t}.${clid}`;
  }
  return { nombre, apellido, ciudad, ip, fbc: fbc ?? null };
}

export function eventId(orderId: number | string): string {
  return `entregado:${orderId}`;
}

/** event_time en segundos; nunca en el futuro. */
export function eventTime(entregadoEn: string | null | undefined, ahora: Date): number {
  const ahoraSeg = Math.floor(ahora.getTime() / 1000);
  const t = entregadoEn ? Math.floor(new Date(entregadoEn).getTime() / 1000) : NaN;
  return Number.isFinite(t) ? Math.min(t, ahoraSeg) : ahoraSeg;
}

/** true si Meta todavía acepta el evento (margen de 1 h para no rozar el límite). */
export function dentroDePlazo(entregadoEn: string | null | undefined, ahora: Date): boolean {
  return Math.floor(ahora.getTime() / 1000) - eventTime(entregadoEn, ahora) < MAX_ANTIGUEDAD_SEG - 3600;
}

// ─── Armado de payloads (puro, testeable) ─────────────────────────────────

export async function armarPayloadPrincipal(
  e: EntradaEvento,
  o: { ahora: Date; actionSource?: string; testEventCode?: string | null },
): Promise<Record<string, unknown>> {
  const userData: Record<string, string[]> = {};
  const tel = normalizarTelefonoCapi(e.telefonoE164);
  if (tel) userData.ph = [await sha256Hex(tel)];
  if (e.pedido.cliente_id) userData.external_id = [await sha256Hex(String(e.pedido.cliente_id))];
  userData.country = [await sha256Hex("py")];
  const c = e.cliente ?? {};
  const fn = normalizarNombreCapi(c.nombre);
  if (fn) userData.fn = [await sha256Hex(fn)];
  const ln = normalizarNombreCapi(c.apellido);
  if (ln) userData.ln = [await sha256Hex(ln)];
  const ct = normalizarCiudadCapi(c.ciudad);
  if (ct) userData.ct = [await sha256Hex(ct)];
  // Sin hash (la doc lo prohíbe): string suelto, no arreglo.
  const ud = userData as Record<string, unknown>;
  const ip = validarIp(c.ip);
  if (ip) ud.client_ip_address = ip;
  const fbc = c.fbc?.trim();
  if (fbc && /^fb\.\d+\.\d+\..+/.test(fbc)) ud.fbc = fbc;
  const evento: Record<string, unknown> = {
    event_name: EVENTO_PROPIO,
    event_time: eventTime(e.pedido.entregado_en, o.ahora),
    event_id: eventId(e.pedido.shopify_order_id),
    action_source: o.actionSource ?? ACTION_SOURCE_PRINCIPAL,
    user_data: userData,
    custom_data: {
      currency: e.moneda,
      value: Math.round(Number(e.valor) || 0), // PYG no tiene decimales
      order_id: String(e.pedido.nombre ?? e.pedido.shopify_order_id),
    },
  };
  const p: Record<string, unknown> = { data: [evento] };
  if (o.testEventCode) p.test_event_code = o.testEventCode;
  return p;
}

export function armarPayloadMensajeria(
  e: EntradaEvento,
  o: { ahora: Date; wabaId: string; testEventCode?: string | null },
): Record<string, unknown> | null {
  const clid = e.origenAnuncio?.ctwa_clid?.trim();
  if (!clid) return null;
  const p: Record<string, unknown> = {
    data: [{
      event_name: EVENTO_MENSAJERIA,
      event_time: eventTime(e.pedido.entregado_en, o.ahora),
      event_id: eventId(e.pedido.shopify_order_id),
      action_source: "business_messaging",
      messaging_channel: "whatsapp",
      user_data: { whatsapp_business_account_id: o.wabaId, ctwa_clid: clid },
      custom_data: { currency: e.moneda, value: Math.round(Number(e.valor) || 0) },
    }],
  };
  if (o.testEventCode) p.test_event_code = o.testEventCode;
  return p;
}

// ─── Envío ────────────────────────────────────────────────────────────────

function envOpcional(n: string): string | null {
  try {
    return Deno.env.get(n) ?? null;
  } catch {
    return null;
  }
}

async function postear(
  f: typeof fetch,
  datasetId: string,
  token: string,
  payload: unknown,
  signal?: AbortSignal,
): Promise<ResultadoEnvio> {
  try {
    const r = await f(`https://graph.facebook.com/${GRAPH_VERSION}/${datasetId}/events`, {
      method: "POST",
      signal,
      // El token va en el header, no en la URL, para que no quede en logs.
      headers: { "Content-Type": "application/json", Authorization: `Bearer ${token}` },
      body: JSON.stringify(payload),
    });
    const j = await r.json().catch(() => ({})) as { events_received?: number; error?: { message?: string } };
    if (!r.ok || j.error) return { ok: false, error: j.error?.message ?? `HTTP ${r.status}` };
    return { ok: true, respuesta: { events_received: j.events_received } };
  } catch (err) {
    return { ok: false, error: err instanceof Error ? err.message : String(err) };
  }
}

export async function enviarEventoEntregado(e: EntradaEvento, opc: OpcionesCapi = {}): Promise<ResultadoCapi> {
  const ahora = opc.ahora ?? new Date();
  const token = opc.token !== undefined ? opc.token : envOpcional("META_CAPI_TOKEN");
  const datasetId = opc.datasetId !== undefined ? opc.datasetId : envOpcional("META_DATASET_ID");
  const datasetMsj = opc.datasetMensajeriaId !== undefined
    ? opc.datasetMensajeriaId
    : envOpcional("META_DATASET_MENSAJERIA_ID");
  const wabaId = opc.wabaId !== undefined ? opc.wabaId : envOpcional("WA_WABA_ID");
  const testEventCode = opc.testEventCode !== undefined ? opc.testEventCode : envOpcional("META_TEST_EVENT_CODE");
  const simulado = opc.simulado ?? (!token || envOpcional("MODO_SIMULADO") === "1");

  const principal = await armarPayloadPrincipal(e, { ahora, actionSource: opc.actionSource, testEventCode });
  const mensajeria = e.origenAnuncio?.ctwa_clid
    ? armarPayloadMensajeria(e, { ahora, wabaId: wabaId ?? "WABA_SIMULADA", testEventCode })
    : null;

  if (simulado) {
    console.log("[meta_capi] SIMULADO", JSON.stringify({ evento: eventId(e.pedido.shopify_order_id), mensajeria: !!mensajeria }));
    return {
      ok: true,
      simulado: true,
      principal: { ok: true },
      mensajeria: mensajeria ? { ok: true } : { ok: true, omitido: "sin_ctwa_clid" },
      payloads: { principal, mensajeria: mensajeria ?? undefined },
    };
  }

  const f = opc.fetch ?? fetch;
  const resPrincipal: ResultadoEnvio = datasetId
    ? await postear(f, datasetId, token!, principal)
    : { ok: false, error: "Falta el secreto META_DATASET_ID" };

  let resMsj: ResultadoEnvio;
  if (!mensajeria) resMsj = { ok: true, omitido: "sin_ctwa_clid" };
  else if (!datasetMsj) resMsj = { ok: true, omitido: "falta_META_DATASET_MENSAJERIA_ID" };
  else if (!wabaId) resMsj = { ok: true, omitido: "falta_WA_WABA_ID" };
  else resMsj = await postear(f, datasetMsj, token!, mensajeria);

  return { ok: resPrincipal.ok && resMsj.ok, simulado: false, principal: resPrincipal, mensajeria: resMsj };
}

// ─── Pedido nacido de un chat de anuncio: señal temprana (08-10-2026) ──────
// El Purchase/OrderDelivered sale recién al entregar (días después). Para que Meta optimice antes, cuando entra un
// pedido nuevo cuyo cliente llegó por un anuncio click-to-WhatsApp (ctwa_clid en los últimos 7 días) se manda UN
// evento al dataset de mensajería.
// Nombre: "LeadSubmitted" — está en la lista de eventos admitidos de Conversions API for Business Messaging
// (developers.facebook.com/docs/marketing-api/conversions-api/business-messaging, verificado 08-10-2026; la misma
// lista trae Purchase, OrderCreated, QualifiedLead, OrderDelivered…). Se eligió LeadSubmitted (y no Purchase) porque
// el pedido contra entrega todavía no es una venta: el Purchase real es la entrega.
// OJO: esa doc dice que Meta NO deduplica eventos de esta API → el que llama se encarga (shopify-webhook usa un
// candado en eventos_crudos). event_id "lead:<order_id>" igual, por trazabilidad.
// Solo al dataset de mensajería (META_DATASET_MENSAJERIA_ID): el de campañas web no corresponde a business_messaging.
// Sin META_CAPI_TOKEN, META_DATASET_MENSAJERIA_ID o WA_WABA_ID, o con MODO_SIMULADO=1: no se llama a Meta.

export const EVENTO_LEAD = "LeadSubmitted";

export function eventIdLead(orderId: number | string): string {
  return `lead:${orderId}`;
}

export interface EntradaLead {
  shopify_order_id: number | string;
  /** Creación del pedido (ISO). Si falta, "ahora". */
  creado_en?: string | null;
  valor: number;
  moneda: "PYG";
  ctwa_clid: string;
}

export function armarPayloadLead(
  e: EntradaLead,
  o: { ahora: Date; wabaId: string; testEventCode?: string | null },
): Record<string, unknown> | null {
  const clid = e.ctwa_clid?.trim();
  if (!clid) return null;
  const p: Record<string, unknown> = {
    data: [{
      event_name: EVENTO_LEAD,
      event_time: eventTime(e.creado_en, o.ahora),
      event_id: eventIdLead(e.shopify_order_id),
      action_source: "business_messaging",
      messaging_channel: "whatsapp",
      user_data: { whatsapp_business_account_id: o.wabaId, ctwa_clid: clid },
      custom_data: { currency: e.moneda, value: Math.round(Number(e.valor) || 0) },
    }],
  };
  if (o.testEventCode) p.test_event_code = o.testEventCode;
  return p;
}

export interface ConfigLead {
  token: string;
  datasetMensajeriaId: string;
  wabaId: string;
  testEventCode: string | null;
}

/** Config para el evento temprano; null si falta algo o está en modo simulado (entonces no se hace nada). */
export function configLead(opc: OpcionesCapi = {}): ConfigLead | null {
  const token = opc.token !== undefined ? opc.token : envOpcional("META_CAPI_TOKEN");
  const ds = opc.datasetMensajeriaId !== undefined ? opc.datasetMensajeriaId : envOpcional("META_DATASET_MENSAJERIA_ID");
  const waba = opc.wabaId !== undefined ? opc.wabaId : envOpcional("WA_WABA_ID");
  const simulado = opc.simulado ?? envOpcional("MODO_SIMULADO") === "1";
  if (!token || !ds || !waba || simulado) return null;
  const testEventCode = opc.testEventCode !== undefined ? opc.testEventCode : envOpcional("META_TEST_EVENT_CODE");
  return { token, datasetMensajeriaId: ds, wabaId: waba, testEventCode: testEventCode ?? null };
}

/** Manda el LeadSubmitted (una sola llamada, timeout corto). No tira excepción. */
export async function enviarEventoLead(
  e: EntradaLead,
  cfg: ConfigLead,
  opc: { ahora?: Date; fetch?: typeof fetch; timeoutMs?: number } = {},
): Promise<ResultadoEnvio> {
  const payload = armarPayloadLead(e, { ahora: opc.ahora ?? new Date(), wabaId: cfg.wabaId, testEventCode: cfg.testEventCode });
  if (!payload) return { ok: true, omitido: "sin_ctwa_clid" };
  return await postear(opc.fetch ?? fetch, cfg.datasetMensajeriaId, cfg.token, payload, AbortSignal.timeout(opc.timeoutMs ?? 5000));
}
