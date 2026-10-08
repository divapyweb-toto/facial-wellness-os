// Edge Function preparar-pedidos: Despacho (src/lib/prepararShopify.js) la llama al generar
// el Excel / las guías de pedidos de Voltra. Marca cada pedido como PREPARADO en Shopify
// (fulfillment sin aviso al cliente). Idempotente. verify_jwt activo + se valida el usuario.
import { db } from "../_shared/db.ts";
import { marcarPreparado } from "../_shared/shopify_preparar.ts";
import { nombresDeRefs } from "./logica.ts";

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

  let cuerpo: { refs?: unknown };
  try { cuerpo = await req.json(); } catch { return json({ ok: false, error: "El cuerpo no es JSON" }, 400); }
  const nombres = nombresDeRefs(cuerpo?.refs);
  if (!nombres.length) return json({ ok: true, preparados: 0, ya: 0, sin_pedido: [], errores: [] });

  const { data, error } = await db().from("shopify_pedidos").select("shopify_order_id, nombre")
    .in("nombre", nombres).eq("es_borrador", false);
  if (error) return json({ ok: false, error: `shopify_pedidos: ${error.message}` }, 500);
  const porNombre = new Map((data ?? []).map((p) => [p.nombre as string, p.shopify_order_id as number]));

  let preparados = 0, ya = 0;
  const sin_pedido: string[] = [], errores: string[] = [];
  for (const n of nombres) {
    const id = porNombre.get(n);
    if (!id) { sin_pedido.push(n); continue; }
    const r = await marcarPreparado(id);
    if (!r.ok) errores.push(`${n}: ${r.error}`);
    else if (r.ya_preparado) ya++;
    else preparados++;
  }
  return json({ ok: errores.length === 0, preparados, ya, sin_pedido, errores });
});
