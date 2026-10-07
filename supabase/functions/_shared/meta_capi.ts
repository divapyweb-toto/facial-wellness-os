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
): Promise<ResultadoEnvio> {
  try {
    const r = await f(`https://graph.facebook.com/${GRAPH_VERSION}/${datasetId}/events`, {
      method: "POST",
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
