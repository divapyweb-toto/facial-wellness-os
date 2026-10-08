// _shared/shopify_preparar.ts
// Marca un pedido como PREPARADO en Shopify (fulfillment) sin avisarle al cliente.
// Idempotente: si ya tiene fulfillment o no queda nada por preparar, es éxito.
// Requiere write_merchant_managed_fulfillment_orders (ya aprobado en la app Voltra OS).
import { gql as gqlReal, orderGid } from "./shopify.ts";

export type Gql = <T = Record<string, unknown>>(q: string, v?: Record<string, unknown>) => Promise<T>;

export interface ResultadoPreparar {
  ok: boolean;
  ya_preparado?: boolean;
  error?: string;
}

export async function marcarPreparado(orderGidStr: string | number, gql: Gql = gqlReal): Promise<ResultadoPreparar> {
  try {
    const d = await gql<{
      order: {
        displayFulfillmentStatus: string | null;
        cancelledAt: string | null;
        fulfillmentOrders: { nodes: Array<{ id: string; status: string }> };
      } | null;
    }>(
      `query($id: ID!) { order(id: $id) { displayFulfillmentStatus cancelledAt fulfillmentOrders(first: 10) { nodes { id status } } } }`,
      { id: orderGid(orderGidStr) },
    );
    if (!d.order) return { ok: false, error: "Pedido no encontrado en Shopify" };
    if (d.order.cancelledAt) return { ok: false, error: "El pedido está cancelado en Shopify" };
    const abiertos = d.order.fulfillmentOrders.nodes.filter((fo) => fo.status === "OPEN" || fo.status === "IN_PROGRESS");
    if (!abiertos.length) return { ok: true, ya_preparado: true };
    const c = await gql<{
      fulfillmentCreate: { fulfillment: { id: string } | null; userErrors: Array<{ message: string }> };
    }>(
      `mutation($f: FulfillmentInput!) { fulfillmentCreate(fulfillment: $f) { fulfillment { id } userErrors { field message } } }`,
      { f: { notifyCustomer: false, lineItemsByFulfillmentOrder: abiertos.map((fo) => ({ fulfillmentOrderId: fo.id })) } },
    );
    const ue = c.fulfillmentCreate.userErrors ?? [];
    if (ue.length || !c.fulfillmentCreate.fulfillment) {
      return { ok: false, error: ue.map((e) => e.message).join("; ") || "fulfillmentCreate sin resultado" };
    }
    return { ok: true };
  } catch (err) {
    return { ok: false, error: String((err as Error)?.message ?? err) };
  }
}
