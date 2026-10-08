import { assert, assertEquals } from "jsr:@std/assert@1";
import { type Gql, marcarPreparado } from "./shopify_preparar.ts";

function gqlFalso(respuestas: unknown[], log: { query: string; vars: unknown }[] = []): Gql {
  let i = 0;
  return (<T>(query: string, vars?: Record<string, unknown>) => {
    log.push({ query, vars });
    const r = respuestas[i++];
    return r instanceof Error ? Promise.reject(r) : Promise.resolve(r as T);
  }) as Gql;
}
const pedido = (nodes: Array<{ id: string; status: string }>, cancelledAt: string | null = null) =>
  ({ order: { displayFulfillmentStatus: "UNFULFILLED", cancelledAt, fulfillmentOrders: { nodes } } });

Deno.test("marcarPreparado: crea el fulfillment SIN avisar al cliente", async () => {
  const log: { query: string; vars: unknown }[] = [];
  const r = await marcarPreparado(9001, gqlFalso([
    pedido([{ id: "gid://shopify/FulfillmentOrder/1", status: "OPEN" }]),
    { fulfillmentCreate: { fulfillment: { id: "gid://shopify/Fulfillment/1" }, userErrors: [] } },
  ], log));
  assertEquals(r, { ok: true });
  assert(log[1].query.includes("fulfillmentCreate"));
  const f = (log[1].vars as { f: { notifyCustomer: boolean; lineItemsByFulfillmentOrder: unknown[] } }).f;
  assertEquals(f.notifyCustomer, false);
  assertEquals(f.lineItemsByFulfillmentOrder.length, 1);
});

Deno.test("marcarPreparado: si ya está preparado no crea nada (idempotente)", async () => {
  const log: { query: string; vars: unknown }[] = [];
  const r = await marcarPreparado("gid://shopify/Order/9001", gqlFalso([pedido([{ id: "x", status: "CLOSED" }])], log));
  assertEquals(r, { ok: true, ya_preparado: true });
  assertEquals(log.length, 1);
});

Deno.test("marcarPreparado: cancelado, no existe, userError y red caída → error sin tirar", async () => {
  assertEquals((await marcarPreparado(1, gqlFalso([pedido([], "2026-10-07")]))).ok, false);
  assertEquals((await marcarPreparado(1, gqlFalso([{ order: null }]))).error, "Pedido no encontrado en Shopify");
  const r = await marcarPreparado(1, gqlFalso([
    pedido([{ id: "a", status: "OPEN" }]),
    { fulfillmentCreate: { fulfillment: null, userErrors: [{ message: "sin permiso" }] } },
  ]));
  assertEquals(r, { ok: false, error: "sin permiso" });
  assertEquals((await marcarPreparado(1, gqlFalso([new Error("HTTP 500")]))).error, "HTTP 500");
});
