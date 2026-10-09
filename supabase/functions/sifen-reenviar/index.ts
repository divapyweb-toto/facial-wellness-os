// sifen-reenviar · Edge Function con JWT del usuario (como wa-enviar-manual): verify_jwt activo + auth.getUser.
// POST { factura_id } → reenvía el KuDE por WhatsApp con la plantilla voltra_factura.
import { db } from "../_shared/db.ts";
import { tokenDeHeader } from "../wa-enviar-manual/logica.ts";
import { enviarKudeWhatsApp, leerConfigSifen } from "../sifen-cola/io.ts";
import type { PedidoSifen } from "../_shared/sifen/desde_pedido.ts";
import { type DepsReenviar, reenviarKude } from "./logica.ts";

const CORS = {
  "Access-Control-Allow-Origin": "*",
  "Access-Control-Allow-Headers": "authorization, x-client-info, apikey, content-type",
  "Access-Control-Allow-Methods": "POST, OPTIONS",
};
const json = (body: unknown, status = 200) =>
  new Response(JSON.stringify(body), { status, headers: { ...CORS, "Content-Type": "application/json" } });

const deps: DepsReenviar = {
  async usuario(token) {
    const { data, error } = await db().auth.getUser(token);
    return error || !data?.user ? null : { id: data.user.id };
  },
  async leerFactura(id) {
    const { data, error } = await db().from("facturas").select("id,estado,kude_path,numero_completo,shopify_order_id").eq("id", id).maybeSingle();
    if (error) throw new Error(`leer factura: ${error.message}`);
    return data;
  },
  async enviar(f) {
    const { data: p } = f.shopify_order_id
      ? await db().from("shopify_pedidos").select("shopify_order_id,nombre,total,estado_envio,tags,raw,telefono").eq("shopify_order_id", f.shopify_order_id).maybeSingle()
      : { data: null };
    const cfg = await leerConfigSifen();
    return await enviarKudeWhatsApp(f, p as PedidoSifen | null, cfg.plantilla_factura);
  },
  async marcarEnviado(id) {
    const { error } = await db().from("facturas").update({ kude_enviado_en: new Date().toISOString() }).eq("id", id);
    if (error) throw new Error(`marcar enviado: ${error.message}`);
  },
};

Deno.serve(async (req) => {
  if (req.method === "OPTIONS") return new Response("ok", { headers: CORS });
  if (req.method !== "POST") return json({ ok: false, error: "Usá POST" }, 405);
  try {
    const cuerpo = await req.json().catch(() => null);
    const r = await reenviarKude(tokenDeHeader(req.headers.get("Authorization")), cuerpo, deps);
    return json(r.body, r.status);
  } catch (e) {
    console.error("sifen-reenviar:", e);
    return json({ ok: false, error: e instanceof Error ? e.message : String(e) }, 500);
  }
});
