// _shared/shopify_pagos.ts · Dueño: H2 (ola 3)
// Marca un pedido contra entrega como pagado cuando el courier lo entregó.
//
// orderMarkAsPaid (Admin GraphQL 2026-10): input {id}; requiere el scope write_orders.
// Solo funciona si el pedido tiene saldo pendiente positivo y no está PAID; crea una
// transacción de venta por el saldo. No tiene parámetro notifyCustomer: la doc oficial
// no dice que mande email (la comunidad reporta que en pedidos comunes no lo hace).
// Probar con un pedido de prueba antes de activar en producción.
//
// Si Shopify responde con userErrors, se consulta el estado financiero: si ya está
// PAID se toma como éxito (idempotente: correrlo dos veces no rompe nada).
import { gql as gqlReal, orderGid } from "./shopify.ts";

export type Gql = <T = Record<string, unknown>>(q: string, v?: Record<string, unknown>) => Promise<T>;

export interface ResultadoPago {
  ok: boolean;
  ya_pagado?: boolean;
  estado_financiero?: string | null;
  error?: string;
}

export const MUTACION_MARCAR_PAGADO = `mutation($input: OrderMarkAsPaidInput!) {
  orderMarkAsPaid(input: $input) {
    order { id displayFinancialStatus }
    userErrors { field message }
  }
}`;

export const CONSULTA_ESTADO_FINANCIERO = `query($id: ID!) {
  order(id: $id) { id displayFinancialStatus }
}`;

export async function marcarPagado(orderGidStr: string | number, gql: Gql = gqlReal): Promise<ResultadoPago> {
  const id = orderGid(orderGidStr);
  try {
    const d = await gql<{
      orderMarkAsPaid: {
        order: { id: string; displayFinancialStatus: string | null } | null;
        userErrors: Array<{ field?: string[] | null; message: string }>;
      };
    }>(MUTACION_MARCAR_PAGADO, { input: { id } });
    const ue = d.orderMarkAsPaid.userErrors ?? [];
    if (!ue.length) {
      return { ok: true, estado_financiero: d.orderMarkAsPaid.order?.displayFinancialStatus ?? null };
    }
    const msg = ue.map((e) => e.message).join("; ");
    // ¿Ya estaba pagado? Entonces no es un error.
    const q = await gql<{ order: { displayFinancialStatus: string | null } | null }>(
      CONSULTA_ESTADO_FINANCIERO,
      { id },
    );
    const est = q.order?.displayFinancialStatus ?? null;
    if (est === "PAID") return { ok: true, ya_pagado: true, estado_financiero: est };
    return { ok: false, error: msg, estado_financiero: est };
  } catch (err) {
    return { ok: false, error: String((err as Error)?.message ?? err) };
  }
}
