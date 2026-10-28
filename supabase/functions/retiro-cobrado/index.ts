// retiro-cobrado · Edge Function. 28-10. Botón "Retirado y cobrado" de Despacho (retiros en la oficina).
// Hace en Shopify lo mismo que el registro a mano de #1089: pagado (orderMarkAsPaid), etiquetas PAGADO (+ PAGO_VERIFICADO
// si fue transferencia) y RETIRADO_<dd_mm>, y preparado (fulfillment SIN aviso al cliente). La venta la carga Despacho.
// No toca pedido_estados (post-entrega no le escribe al cliente). verify_jwt activo + se valida el usuario.
// Vuelta atrás: sacar las etiquetas en Shopify; la venta se borra desde Ventas (devuelve el stock).
import { db } from "../_shared/db.ts";
import { agregarTags, orderGid } from "../_shared/shopify.ts";
import { marcarPagado } from "../_shared/shopify_pagos.ts";
import { marcarPreparado } from "../_shared/shopify_preparar.ts";
import { partesAsuncion } from "../_shared/horario.ts";
import { etiquetas, motivoNoMarcar, validar } from "./logica.ts";

const CORS = {
  "Access-Control-Allow-Origin": "*",
  "Access-Control-Allow-Headers": "authorization, x-client-info, apikey, content-type",
  "Access-Control-Allow-Methods": "POST, OPTIONS",
};
const json = (body: unknown, status = 200) =>
  new Response(JSON.stringify(body), { status, headers: { ...CORS, "Content-Type": "application/json" } });

Deno.serve(async (req) => {
  if (req.method === "OPTIONS") return new Response("ok", { headers: CORS });
  if (req.method !== "POST") return json({ ok: false, error: "Usá POST" }, 405);
  const token = (req.headers.get("Authorization") ?? "").replace(/^Bearer\s+/i, "");
  const { data: u, error: eu } = await db().auth.getUser(token);
  if (eu || !u?.user) return json({ ok: false, error: "Sesión inválida" }, 401);

  const v = validar(await req.json().catch(() => null), partesAsuncion(new Date()).diaISO);
  if (!v.ok) return json({ ok: false, error: v.error }, 400);
  const e = v.e;
  const { data: p, error } = await db().from("shopify_pedidos").select("shopify_order_id, nombre, tags, es_borrador, raw")
    .eq("nombre", e.pedido).maybeSingle();
  if (error) return json({ ok: false, error: `shopify_pedidos: ${error.message}` }, 500);
  const motivo = motivoNoMarcar(p ? { tags: (p.tags as string[] | null) ?? [], cancelado: !!(p.raw as Record<string, unknown>)?.cancelled_at, borrador: !!p.es_borrador } : null);
  if (motivo) return json({ ok: false, error: motivo }, 422);

  const id = Number(p!.shopify_order_id);
  const pago = await marcarPagado(id);
  if (!pago.ok) return json({ ok: false, error: `Shopify no lo marcó pagado: ${pago.error ?? "error"}` }, 502);
  const notas: string[] = [];
  const t = await agregarTags(orderGid(id), etiquetas(e)).catch((x) => ({ ok: false, error: x instanceof Error ? x.message : String(x) }));
  if (!t.ok) notas.push(`no se agregaron las etiquetas (${(t as { error?: string }).error ?? "error"})`);
  const prep = await marcarPreparado(id);
  if (!prep.ok) notas.push(`no se marcó preparado (${prep.error ?? "error"})`);
  console.log("retiro-cobrado", JSON.stringify({ pedido: e.pedido, medio: e.medio, fecha: e.fecha, usuario: u.user.id, notas }));
  return json({ ok: true, pedido: e.pedido, shopify_order_id: id, etiquetas: etiquetas(e), notas });
});
