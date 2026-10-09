// factura · Edge Function (solo service role). Compatibilidad: delega en la cola SIFEN.
//   POST {"shopify_order_id": 123}  → factura ese pedido (si config_wa['sifen'].activo).
//   POST {} / {"origen":"pg_cron"}  → corrida de la cola (igual que sifen-cola).
import { conServiceRole } from "../_shared/auth_servicio.ts";
import { facturarPedidoEntregado, facturarPendientes } from "./io.ts";

Deno.serve(conServiceRole(async (req) => {
  try {
    const cuerpo = await req.json().catch(() => ({})) as { shopify_order_id?: number | string };
    const id = Number(cuerpo.shopify_order_id);
    if (cuerpo.shopify_order_id != null) {
      if (!Number.isFinite(id)) return Response.json({ ok: false, error: "shopify_order_id inválido" }, { status: 400 });
      return Response.json({ ok: true, ...(await facturarPedidoEntregado(id)) });
    }
    return Response.json({ ok: true, ...(await facturarPendientes()) });
  } catch (e) {
    console.error("factura:", e);
    return Response.json({ ok: false, error: e instanceof Error ? e.message : String(e) }, { status: 500 });
  }
}));
