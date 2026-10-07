// marcarPagado con un gql falso: nunca llama a Shopify.
import { assert, assertEquals } from "jsr:@std/assert@1";
import { type Gql, marcarPagado } from "./shopify_pagos.ts";

function gqlFalso(respuestas: unknown[], log: { query: string; vars: unknown }[] = []): Gql {
  let i = 0;
  return (<T>(query: string, vars?: Record<string, unknown>) => {
    log.push({ query, vars });
    const r = respuestas[i++];
    return r instanceof Error ? Promise.reject(r) : Promise.resolve(r as T);
  }) as Gql;
}

Deno.test("marcarPagado: manda orderMarkAsPaid con el GID del pedido", async () => {
  const log: { query: string; vars: unknown }[] = [];
  const r = await marcarPagado(9001, gqlFalso([
    { orderMarkAsPaid: { order: { id: "gid://shopify/Order/9001", displayFinancialStatus: "PAID" }, userErrors: [] } },
  ], log));
  assertEquals(r, { ok: true, estado_financiero: "PAID" });
  assert(log[0].query.includes("orderMarkAsPaid"));
  assertEquals(log[0].vars, { input: { id: "gid://shopify/Order/9001" } });
});

Deno.test("marcarPagado: si ya estaba pagado (userError) cuenta como éxito", async () => {
  const r = await marcarPagado("gid://shopify/Order/9001", gqlFalso([
    { orderMarkAsPaid: { order: null, userErrors: [{ field: ["id"], message: "Order cannot be marked as paid" }] } },
    { order: { displayFinancialStatus: "PAID" } },
  ]));
  assertEquals(r.ok, true);
  assertEquals(r.ya_pagado, true);
});

Deno.test("marcarPagado: userError y no está pagado → error", async () => {
  const r = await marcarPagado(9001, gqlFalso([
    { orderMarkAsPaid: { order: null, userErrors: [{ message: "Order is cancelled" }] } },
    { order: { displayFinancialStatus: "VOIDED" } },
  ]));
  assertEquals(r.ok, false);
  assertEquals(r.error, "Order is cancelled");
  assertEquals(r.estado_financiero, "VOIDED");
});

Deno.test("marcarPagado: excepción de red → ok false, no tira", async () => {
  const r = await marcarPagado(9001, gqlFalso([new Error("Shopify GraphQL HTTP 500")]));
  assertEquals(r, { ok: false, error: "Shopify GraphQL HTTP 500" });
});
