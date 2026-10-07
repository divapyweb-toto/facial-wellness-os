// Conciliación horaria (cron): pedidos de Shopify de las últimas 72 h que no están en
// shopify_pedidos se procesan con el mismo código que el webhook.
// Shopify no garantiza entrega ni orden de sus webhooks; esto cubre los perdidos.
// Se invoca con el JWT de service role (verify_jwt queda activo por defecto).
import { gql } from "../_shared/shopify.ts";
import { conServiceRole } from "../_shared/auth_servicio.ts";
import { db } from "../_shared/db.ts";
import { normalizarDesdeGraphQL, procesarPedido } from "../shopify-webhook/procesar.ts";
import { depsReales } from "../shopify-webhook/io.ts";

const VENTANA_H = 72;

// Campos validados contra el esquema Admin GraphQL 2026-10 (06-10-2026).
// Customer.phone está deprecado: se usa defaultPhoneNumber.phoneNumber.
const QUERY = `query($q: String!, $after: String) {
  orders(first: 100, after: $after, query: $q, sortKey: CREATED_AT) {
    pageInfo { hasNextPage endCursor }
    nodes {
      id legacyResourceId name createdAt cancelledAt phone tags
      customAttributes { key value }
      totalPriceSet { shopMoney { amount } }
      lineItems(first: 20) { nodes { quantity title } }
      shippingAddress { phone name firstName lastName address1 address2 city }
      billingAddress { phone }
      customer { firstName lastName defaultPhoneNumber { phoneNumber } }
    }
  }
}`;

type Nodo = Record<string, unknown> & { legacyResourceId: string };
type Pagina = { orders: { pageInfo: { hasNextPage: boolean; endCursor: string | null }; nodes: Nodo[] } };

Deno.serve(conServiceRole(async () => {
  const desde = new Date(Date.now() - VENTANA_H * 3_600_000).toISOString();
  const nodos: Nodo[] = [];
  let after: string | null = null;
  try {
    do {
      const d: Pagina = await gql<Pagina>(QUERY, { q: `created_at:>='${desde}'`, after });
      nodos.push(...d.orders.nodes);
      after = d.orders.pageInfo.hasNextPage ? d.orders.pageInfo.endCursor : null;
    } while (after);
  } catch (e) {
    console.error("shopify-conciliar: Shopify", (e as Error).message);
    return Response.json({ ok: false, error: (e as Error).message }, { status: 502 });
  }

  const ids = nodos.map((n) => Number(n.legacyResourceId));
  const existentes = new Set<number>();
  for (let i = 0; i < ids.length; i += 200) {
    const { data, error } = await db().from("shopify_pedidos")
      .select("shopify_order_id").in("shopify_order_id", ids.slice(i, i + 200));
    if (error) return Response.json({ ok: false, error: error.message }, { status: 500 });
    for (const r of data ?? []) existentes.add(Number(r.shopify_order_id));
  }

  const faltan = nodos.filter((n) => !existentes.has(Number(n.legacyResourceId)));
  const deps = depsReales();
  const resultados: Array<{ id: number; accion?: string; error?: string }> = [];
  for (const n of faltan) {
    try {
      const r = await procesarPedido(normalizarDesdeGraphQL(n), deps);
      resultados.push({ id: r.shopifyOrderId, accion: r.accion });
    } catch (e) {
      resultados.push({ id: Number(n.legacyResourceId), error: (e as Error).message });
    }
  }
  console.log("shopify-conciliar", { revisados: nodos.length, faltaban: faltan.length });
  return Response.json({ ok: true, revisados: nodos.length, faltaban: faltan.length, resultados });
}));
