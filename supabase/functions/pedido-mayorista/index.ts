// Edge Function pedido-mayorista · P2 (10-10-2026). La lógica está en logica.ts (+ validar.ts); acá solo el I/O.
// La pantalla src/pages/mayorista la llama con supabase.functions.invoke y el JWT del usuario.
// verify_jwt queda activo (default) y además se valida el usuario con db().auth.getUser (como wa-enviar-manual).
// Secretos: los mismos de Shopify que usa el resto (SHOPIFY_STORE, SHOPIFY_CLIENT_ID, SHOPIFY_CLIENT_SECRET).
import { db, guardarEventoCrudo } from "../_shared/db.ts";
import { gql } from "../_shared/shopify.ts";
import { marcarPagado } from "../_shared/shopify_pagos.ts";
import { normalizarDesdeGraphQL, procesarPedido } from "../shopify-webhook/procesar.ts";
import { depsReales as depsShopifyWebhook } from "../shopify-webhook/io.ts";
import { type Candado, type Deps, manejar, type ProductoCatalogo, tokenDeHeader } from "./logica.ts";

const CORS = {
  "Access-Control-Allow-Origin": "*",
  "Access-Control-Allow-Headers": "authorization, x-client-info, apikey, content-type",
  "Access-Control-Allow-Methods": "POST, OPTIONS",
};

const json = (body: unknown, status = 200) =>
  new Response(JSON.stringify(body), { status, headers: { ...CORS, "Content-Type": "application/json" } });

const idCandado = (clave: string) => `mayorista:${clave}`;

// Campos que necesita normalizarDesdeGraphQL (mismos que _shared/vendedor/io.ts CAMPOS_PEDIDO).
const CAMPOS_PEDIDO = `id legacyResourceId name phone createdAt cancelledAt tags
  customAttributes { key value }
  totalPriceSet { shopMoney { amount } }
  lineItems(first: 50) { nodes { quantity title } }
  shippingAddress { phone name firstName lastName address1 address2 city }
  billingAddress { phone }
  customer { firstName lastName defaultPhoneNumber { phoneNumber } }`;

const MUTACION_ORDER_CREATE = `mutation($order: OrderCreateOrderInput!, $options: OrderCreateOptionsInput) {
  orderCreate(order: $order, options: $options) {
    order { ${CAMPOS_PEDIDO} }
    userErrors { field message }
  }
}`;

const QUERY_CATALOGO = `query($q: String) {
  products(first: 100, query: $q, sortKey: TITLE) {
    nodes { id title status variants(first: 20) { nodes { id title price sku availableForSale } } }
  }
}`;

type NodoProducto = {
  id: string;
  title: string;
  status: string;
  variants: { nodes: Array<{ id: string; title: string; price: string; sku: string | null; availableForSale: boolean }> };
};

function falla(contexto: string, error: { message: string } | null): void {
  if (error) throw new Error(`${contexto}: ${error.message}`);
}

const deps: Deps = {
  ahora: () => new Date(),

  async usuario(token) {
    const { data, error } = await db().auth.getUser(token);
    return error || !data?.user ? null : { id: data.user.id };
  },

  async facturarDesde() {
    const { data, error } = await db().from("config_wa").select("valor").eq("clave", "sifen").maybeSingle();
    falla("config_wa.sifen", error);
    const v = (data?.valor ?? {}) as { facturar_desde?: unknown };
    return typeof v.facturar_desde === "string" && v.facturar_desde.trim() ? v.facturar_desde.trim() : null;
  },

  async catalogo() {
    // Activos y borradores: Voltra tiene productos en borrador que igual se venden por mayor.
    const d = await gql<{ products: { nodes: NodoProducto[] } }>(QUERY_CATALOGO, { q: "status:active OR status:draft" });
    return d.products.nodes.map((n): ProductoCatalogo => ({
      id: n.id,
      titulo: n.title,
      estado: n.status,
      variantes: n.variants.nodes.map((v) => ({
        id: v.id,
        titulo: v.title,
        precio: Math.round(Number(v.price)),
        disponible: v.availableForSale,
        sku: v.sku || null,
      })).filter((v) => Number.isFinite(v.precio)),
    })).filter((p) => p.variantes.length);
  },

  reservarClave: (clave, payload) => guardarEventoCrudo("shopify", idCandado(clave), payload),

  async leerClave(clave) {
    const { data, error } = await db().from("eventos_crudos").select("payload, procesado_en, error")
      .eq("fuente", "shopify").eq("id_externo", idCandado(clave)).maybeSingle();
    falla("leer candado", error);
    if (!data) return null;
    const p = (data.payload ?? {}) as Record<string, unknown>;
    return {
      shopify_order_id: typeof p.shopify_order_id === "number" ? p.shopify_order_id : undefined,
      nombre: typeof p.nombre === "string" ? p.nombre : undefined,
      total: typeof p.total === "number" ? p.total : null,
      avisos: Array.isArray(p.avisos) ? p.avisos.map(String) : [],
      procesado: !!data.procesado_en,
      error: data.error ?? null,
    } as Candado;
  },

  async cerrarClave(clave, datos, error) {
    const { error: e } = await db().from("eventos_crudos")
      .update({ payload: { tipo: "pedido_mayorista", ...datos }, procesado_en: new Date().toISOString(), error })
      .eq("fuente", "shopify").eq("id_externo", idCandado(clave));
    falla("cerrar candado", e);
  },

  async liberarClave(clave) {
    const { error } = await db().from("eventos_crudos").delete().eq("fuente", "shopify").eq("id_externo", idCandado(clave));
    falla("liberar candado", error);
  },

  async crearOrden(input) {
    try {
      const d = await gql<{
        orderCreate: { order: Record<string, unknown> | null; userErrors: Array<{ field?: string[]; message: string }> };
      }>(MUTACION_ORDER_CREATE, input);
      const errores = d.orderCreate.userErrors ?? [];
      if (errores.length || !d.orderCreate.order) {
        // userErrors = Shopify rechazó el pedido: seguro que no se creó.
        return { ok: false, definitivo: true, error: errores.map((e) => `${(e.field ?? []).join(".")}: ${e.message}`).join("; ") || "orderCreate sin pedido" };
      }
      const o = d.orderCreate.order;
      const total = Number((o.totalPriceSet as { shopMoney?: { amount?: string } } | undefined)?.shopMoney?.amount);
      return {
        ok: true,
        shopify_order_id: Number(o.legacyResourceId ?? String(o.id).split("/").pop()),
        gid: String(o.id),
        nombre: String(o.name ?? ""),
        total: Number.isFinite(total) ? total : null,
        nodo: o,
      };
    } catch (e) {
      // Error de red / HTTP / GraphQL: no se sabe si Shopify lo creó.
      return { ok: false, definitivo: false, error: e instanceof Error ? e.message : String(e) };
    }
  },

  async registrarPedido(nodo) {
    // Mismo camino que shopify-webhook / shopify-conciliar (sin el evento a Meta). Con CONFIRMADO no programa mensajes.
    await procesarPedido(normalizarDesdeGraphQL(nodo), depsShopifyWebhook());
  },

  async guardarDatosFiscales(fila) {
    const { error } = await db().from("pedido_datos_fiscales").upsert(fila, { onConflict: "shopify_order_id" });
    falla("pedido_datos_fiscales", error);
  },

  async omitirCapi(orderId, motivo) {
    const { error } = await db().from("shopify_pedidos").update({ capi_omitido: motivo })
      .eq("shopify_order_id", orderId).is("capi_omitido", null);
    falla("capi_omitido", error);
  },

  marcarPagado: (gid) => marcarPagado(gid),

  async retenerFactura(orderId, motivo, nota) {
    // RPC de P1 (migración 20261010000010_sifen_blindaje.sql): idempotente (on conflict do nothing).
    const { data, error } = await db().rpc("sifen_retener", { p_shopify_order_id: orderId, p_motivo: motivo, p_nota: nota });
    if (error) {
      const falta = error.code === "42883" || error.code === "PGRST202" || /sifen_retener|facturas_retenidas/.test(error.message) && /exist|find|schema cache/i.test(error.message);
      return { ok: false, tablaFalta: falta, error: error.message };
    }
    const r = (data ?? {}) as { ok?: boolean; motivo?: string };
    return r.ok === false ? { ok: false, error: r.motivo ?? "sifen_retener rechazó" } : { ok: true };
  },

  async marcarEntregado(orderId, instante, pagado) {
    const sb = db();
    const cambios: Record<string, unknown> = { estado_envio: "ENTREGADO", entregado_en: instante };
    if (pagado) cambios.pagado_marcado = true;
    const { data, error } = await sb.from("shopify_pedidos").update(cambios).eq("shopify_order_id", orderId).select("shopify_order_id");
    falla("shopify_pedidos (entregado)", error);
    if (!data?.length) throw new Error("el pedido todavía no está en shopify_pedidos");
    // notificado = true: ningún proceso tiene que avisar este estado (no hay mensaje de seguimiento).
    const { error: e2 } = await sb.from("pedido_estados")
      .upsert({ shopify_order_id: orderId, estado: "ENTREGADO", fuente: "manual", notificado: true, creado_en: instante },
        { onConflict: "shopify_order_id,estado", ignoreDuplicates: true });
    falla("pedido_estados", e2);
  },

  async marcarPreparado(gid) {
    try {
      const d = await gql<{ order: { fulfillmentOrders: { nodes: Array<{ id: string; status: string }> } } | null }>(
        `query($id: ID!) { order(id: $id) { fulfillmentOrders(first: 10) { nodes { id status } } } }`, { id: gid });
      const abiertos = (d.order?.fulfillmentOrders.nodes ?? []).filter((f) => f.status === "OPEN" || f.status === "IN_PROGRESS");
      if (!abiertos.length) return { ok: true };
      const c = await gql<{ fulfillmentCreate: { userErrors: Array<{ message: string }> } }>(
        `mutation($f: FulfillmentInput!) { fulfillmentCreate(fulfillment: $f) { fulfillment { id } userErrors { field message } } }`,
        { f: { notifyCustomer: false, lineItemsByFulfillmentOrder: abiertos.map((f) => ({ fulfillmentOrderId: f.id })) } },
      );
      const e = c.fulfillmentCreate.userErrors ?? [];
      return e.length ? { ok: false, error: e.map((x) => x.message).join("; ") } : { ok: true };
    } catch (e) {
      return { ok: false, error: e instanceof Error ? e.message : String(e) };
    }
  },
};

Deno.serve(async (req) => {
  if (req.method === "OPTIONS") return new Response("ok", { headers: CORS });
  if (req.method !== "POST") return json({ ok: false, error: "Usá POST" }, 405);
  let cuerpo: unknown;
  try {
    cuerpo = await req.json();
  } catch {
    return json({ ok: false, error: "El cuerpo no es JSON" }, 400);
  }
  try {
    const r = await manejar(tokenDeHeader(req.headers.get("Authorization")), cuerpo, deps);
    return json(r.body, r.status);
  } catch (e) {
    console.error("pedido-mayorista:", e);
    return json({ ok: false, error: `Error del servidor: ${e instanceof Error ? e.message : String(e)}` }, 500);
  }
});
