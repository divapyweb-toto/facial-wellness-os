// Conexión con Shopify Admin GraphQL (2026-10) para Voltra OS.
// Dueño: subagente C. Sin dependencias externas: se puede importar en tests.
//
// Secretos que lee (los carga Enrique con `supabase secrets set`):
//   SHOPIFY_STORE (ej. "mitienda" o "mitienda.myshopify.com"),
//   SHOPIFY_CLIENT_ID, SHOPIFY_CLIENT_SECRET.

export const SHOPIFY_API_VERSION = "2026-10";

export type Resultado = { ok: boolean; error?: string; [k: string]: unknown };

// ---------------------------------------------------------------------------
// Token por client credentials (apps del Dev Dashboard). Dura 24 h (expires_in 86399).
// Se cachea en memoria del worker y se renueva 5 min antes de vencer.
// ---------------------------------------------------------------------------

let cacheToken: { token: string; venceEn: number } | null = null;

function env(nombre: string): string {
  const v = Deno.env.get(nombre);
  if (!v) throw new Error(`Falta el secreto ${nombre}`);
  return v;
}

export function dominioTienda(store = env("SHOPIFY_STORE")): string {
  const limpio = store.trim().replace(/^https?:\/\//, "").replace(/\/.*$/, "");
  return limpio.endsWith(".myshopify.com") ? limpio : `${limpio}.myshopify.com`;
}

export async function tokenShopify(forzar = false): Promise<string> {
  const ahora = Date.now();
  if (!forzar && cacheToken && cacheToken.venceEn - 5 * 60_000 > ahora) {
    return cacheToken.token;
  }
  const body = new URLSearchParams({
    grant_type: "client_credentials",
    client_id: env("SHOPIFY_CLIENT_ID"),
    client_secret: env("SHOPIFY_CLIENT_SECRET"),
  });
  const r = await fetch(`https://${dominioTienda()}/admin/oauth/access_token`, {
    method: "POST",
    headers: { "Content-Type": "application/x-www-form-urlencoded" },
    body,
  });
  if (!r.ok) {
    // No se incluye el cuerpo de la respuesta para no filtrar nada sensible a logs.
    throw new Error(`Shopify no entregó token (HTTP ${r.status})`);
  }
  const d = await r.json() as { access_token: string; expires_in?: number };
  cacheToken = {
    token: d.access_token,
    venceEn: ahora + (d.expires_in ?? 86399) * 1000,
  };
  return cacheToken.token;
}

/** Solo para tests. */
export function _limpiarCacheToken() {
  cacheToken = null;
}

// ---------------------------------------------------------------------------
// GraphQL
// ---------------------------------------------------------------------------

export class ErrorShopify extends Error {
  constructor(mensaje: string, public detalle?: unknown) {
    super(mensaje);
  }
}

/**
 * Ejecuta una consulta o mutación. Devuelve `data`.
 * Reintenta una vez si el token venció (401) o si Shopify limita la tasa (429 / THROTTLED).
 * Lanza ErrorShopify si hay `errors` a nivel GraphQL.
 */
export async function gql<T = Record<string, unknown>>(
  query: string,
  vars: Record<string, unknown> = {},
  _intento = 0,
): Promise<T> {
  const token = await tokenShopify(_intento > 0);
  const r = await fetch(
    `https://${dominioTienda()}/admin/api/${SHOPIFY_API_VERSION}/graphql.json`,
    {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
        "X-Shopify-Access-Token": token,
      },
      body: JSON.stringify({ query, variables: vars }),
    },
  );
  if ((r.status === 401 || r.status === 429) && _intento === 0) {
    if (r.status === 429) await new Promise((res) => setTimeout(res, 1000));
    return gql<T>(query, vars, 1);
  }
  if (!r.ok) throw new ErrorShopify(`Shopify GraphQL HTTP ${r.status}`);
  const j = await r.json() as { data?: T; errors?: Array<{ message: string; extensions?: { code?: string } }> };
  if (j.errors?.length) {
    const throttled = j.errors.some((e) => e.extensions?.code === "THROTTLED");
    if (throttled && _intento === 0) {
      await new Promise((res) => setTimeout(res, 1000));
      return gql<T>(query, vars, 1);
    }
    throw new ErrorShopify(j.errors.map((e) => e.message).join("; "), j.errors);
  }
  return j.data as T;
}

// ---------------------------------------------------------------------------
// HMAC de webhooks: X-Shopify-Hmac-Sha256 = base64(HMAC-SHA256(cuerpo crudo, client secret))
// ---------------------------------------------------------------------------

function base64ABytes(b64: string): Uint8Array | null {
  try {
    const bin = atob(b64.trim());
    const out = new Uint8Array(bin.length);
    for (let i = 0; i < bin.length; i++) out[i] = bin.charCodeAt(i);
    return out;
  } catch {
    return null;
  }
}

export async function calcularHmacShopify(
  rawBody: string | Uint8Array,
  secret: string,
): Promise<string> {
  const enc = new TextEncoder();
  const key = await crypto.subtle.importKey(
    "raw",
    enc.encode(secret),
    { name: "HMAC", hash: "SHA-256" },
    false,
    ["sign"],
  );
  const datos = typeof rawBody === "string" ? enc.encode(rawBody) : rawBody;
  const firma = new Uint8Array(await crypto.subtle.sign("HMAC", key, datos as BufferSource));
  let bin = "";
  for (const b of firma) bin += String.fromCharCode(b);
  return btoa(bin);
}

/** Comparación en tiempo constante. `rawBody` tiene que ser el cuerpo exacto, sin re-serializar. */
export async function verificarHmacShopify(
  rawBody: string | Uint8Array,
  header: string | null | undefined,
  secret: string,
): Promise<boolean> {
  if (!header || !secret) return false;
  const recibido = base64ABytes(header);
  const esperado = base64ABytes(await calcularHmacShopify(rawBody, secret));
  if (!recibido || !esperado || recibido.length !== esperado.length) return false;
  let diff = 0;
  for (let i = 0; i < esperado.length; i++) diff |= recibido[i] ^ esperado[i];
  return diff === 0;
}

// ---------------------------------------------------------------------------
// IDs
// ---------------------------------------------------------------------------

export function orderGid(id: number | string): string {
  const s = String(id);
  return s.startsWith("gid://") ? s : `gid://shopify/Order/${s}`;
}

export function idDesdeGid(gid: string): number {
  return Number(gid.split("/").pop());
}

// ---------------------------------------------------------------------------
// Tags (tagsAdd / tagsRemove sirven para Order y DraftOrder)
// ---------------------------------------------------------------------------

type UserError = { field?: string[] | null; message: string };

function errores(ue: UserError[] | undefined | null): string | null {
  return ue && ue.length ? ue.map((e) => e.message).join("; ") : null;
}

export async function agregarTags(orderGidStr: string, tags: string[]): Promise<Resultado> {
  try {
    const d = await gql<{ tagsAdd: { userErrors: UserError[] } }>(
      `mutation($id: ID!, $tags: [String!]!) {
        tagsAdd(id: $id, tags: $tags) { node { id } userErrors { field message } }
      }`,
      { id: orderGid(orderGidStr), tags },
    );
    const e = errores(d.tagsAdd.userErrors);
    return e ? { ok: false, error: e } : { ok: true };
  } catch (err) {
    return { ok: false, error: String((err as Error).message ?? err) };
  }
}

export async function quitarTags(orderGidStr: string, tags: string[]): Promise<Resultado> {
  try {
    const d = await gql<{ tagsRemove: { userErrors: UserError[] } }>(
      `mutation($id: ID!, $tags: [String!]!) {
        tagsRemove(id: $id, tags: $tags) { node { id } userErrors { field message } }
      }`,
      { id: orderGid(orderGidStr), tags },
    );
    const e = errores(d.tagsRemove.userErrors);
    return e ? { ok: false, error: e } : { ok: true };
  } catch (err) {
    return { ok: false, error: String((err as Error).message ?? err) };
  }
}

// ---------------------------------------------------------------------------
// Cancelación (orderCancel es asíncrona: devuelve un job). Irreversible.
// ---------------------------------------------------------------------------

// Valores verificados por introspección del esquema 2026-10 (06-10-2026).
const MOTIVOS_SHOPIFY = ["CUSTOMER", "DECLINED", "FRAUD", "INVENTORY", "STAFF", "OTHER"] as const;

/**
 * `motivo`: uno de los valores de OrderCancelReason, o un texto libre
 * (en ese caso va como reason OTHER y el texto como staffNote, máx. 255).
 * Siempre: restock true, notifyCustomer false, sin refundMethod (contra entrega, no hay cobro).
 */
export async function cancelarPedido(orderGidStr: string, motivo: string): Promise<Resultado> {
  const esEnum = (MOTIVOS_SHOPIFY as readonly string[]).includes(motivo);
  try {
    const d = await gql<{
      orderCancel: { job: { id: string } | null; orderCancelUserErrors: UserError[] };
    }>(
      `mutation($orderId: ID!, $reason: OrderCancelReason!, $staffNote: String) {
        orderCancel(orderId: $orderId, reason: $reason, restock: true,
                    notifyCustomer: false, staffNote: $staffNote) {
          job { id }
          orderCancelUserErrors { field message code }
        }
      }`,
      {
        orderId: orderGid(orderGidStr),
        reason: esEnum ? motivo : "OTHER",
        staffNote: esEnum ? null : motivo.slice(0, 255),
      },
    );
    const e = errores(d.orderCancel.orderCancelUserErrors);
    return e ? { ok: false, error: e } : { ok: true, job_id: d.orderCancel.job?.id };
  } catch (err) {
    return { ok: false, error: String((err as Error).message ?? err) };
  }
}

// ---------------------------------------------------------------------------
// Eventos de envío
// ---------------------------------------------------------------------------

export type FulfillmentEventStatus =
  | "ATTEMPTED_DELIVERY" | "CARRIER_PICKED_UP" | "CONFIRMED" | "DELAYED" | "DELIVERED"
  | "FAILURE" | "IN_TRANSIT" | "LABEL_PRINTED" | "LABEL_PURCHASED" | "OUT_FOR_DELIVERY"
  | "READY_FOR_PICKUP";

const ESTADOS_SHOPIFY: FulfillmentEventStatus[] = [
  "ATTEMPTED_DELIVERY", "CARRIER_PICKED_UP", "CONFIRMED", "DELAYED", "DELIVERED",
  "FAILURE", "IN_TRANSIT", "LABEL_PRINTED", "LABEL_PURCHASED", "OUT_FOR_DELIVERY",
  "READY_FOR_PICKUP",
];

/**
 * Traduce EstadoEnvio (tipos.ts) al enum de Shopify. Devuelve null cuando el estado
 * no se carga en Shopify (EN_PREPARACION todavía no salió; CANCELADO y RENDIDO no son eventos de envío).
 * También acepta directamente un valor de FulfillmentEventStatus.
 */
export function estadoAShopify(estado: string): FulfillmentEventStatus | null {
  if ((ESTADOS_SHOPIFY as string[]).includes(estado)) return estado as FulfillmentEventStatus;
  switch (estado) {
    case "DESPACHADO": return "IN_TRANSIT";
    case "INTENTO_FALLIDO": return "ATTEMPTED_DELIVERY";
    case "NO_ENTREGADO_RESCATABLE": return "ATTEMPTED_DELIVERY";
    case "ENTREGADO": return "DELIVERED";
    case "NO_ENTREGADO": return "FAILURE";
    default: return null; // EN_PREPARACION, CANCELADO, RENDIDO
  }
}

/**
 * Carga un evento de envío en el pedido. Si el pedido no tiene fulfillment, primero lo crea
 * con notifyCustomer:false (fulfillmentEventCreate necesita un fulfillment existente).
 * Ojo: DELIVERED / OUT_FOR_DELIVERY pueden disparar emails de Shopify según
 * Configuración → Notificaciones; fulfillmentEventCreate no tiene opción para evitarlo.
 */
export async function crearEventoEnvio(orderGidStr: string, estado: string): Promise<Resultado> {
  const status = estadoAShopify(estado);
  if (!status) return { ok: true, omitido: true };
  try {
    const d = await gql<{
      order: {
        fulfillments: Array<{ id: string; status: string }>;
        fulfillmentOrders: { nodes: Array<{ id: string; status: string }> };
      } | null;
    }>(
      `query($id: ID!) {
        order(id: $id) {
          fulfillments(first: 10) { id status }
          fulfillmentOrders(first: 10) { nodes { id status } }
        }
      }`,
      { id: orderGid(orderGidStr) },
    );
    if (!d.order) return { ok: false, error: "Pedido no encontrado en Shopify" };

    let fulfillmentId = d.order.fulfillments.find((f) => f.status === "SUCCESS")?.id ??
      d.order.fulfillments[0]?.id;

    if (!fulfillmentId) {
      const abiertos = d.order.fulfillmentOrders.nodes.filter((fo) =>
        fo.status === "OPEN" || fo.status === "IN_PROGRESS"
      );
      if (!abiertos.length) {
        return { ok: false, error: "El pedido no tiene órdenes de envío abiertas para crear el fulfillment" };
      }
      const c = await gql<{
        fulfillmentCreate: { fulfillment: { id: string } | null; userErrors: UserError[] };
      }>(
        `mutation($f: FulfillmentInput!) {
          fulfillmentCreate(fulfillment: $f) { fulfillment { id } userErrors { field message } }
        }`,
        {
          f: {
            notifyCustomer: false,
            lineItemsByFulfillmentOrder: abiertos.map((fo) => ({ fulfillmentOrderId: fo.id })),
          },
        },
      );
      const e = errores(c.fulfillmentCreate.userErrors);
      if (e || !c.fulfillmentCreate.fulfillment) return { ok: false, error: e ?? "fulfillmentCreate sin resultado" };
      fulfillmentId = c.fulfillmentCreate.fulfillment.id;
    }

    const ev = await gql<{
      fulfillmentEventCreate: { fulfillmentEvent: { id: string } | null; userErrors: UserError[] };
    }>(
      `mutation($e: FulfillmentEventInput!) {
        fulfillmentEventCreate(fulfillmentEvent: $e) {
          fulfillmentEvent { id status }
          userErrors { field message }
        }
      }`,
      { e: { fulfillmentId, status, happenedAt: new Date().toISOString() } },
    );
    const e2 = errores(ev.fulfillmentEventCreate.userErrors);
    return e2
      ? { ok: false, error: e2, fulfillment_id: fulfillmentId }
      : { ok: true, fulfillment_id: fulfillmentId, evento_id: ev.fulfillmentEventCreate.fulfillmentEvent?.id };
  } catch (err) {
    return { ok: false, error: String((err as Error).message ?? err) };
  }
}
