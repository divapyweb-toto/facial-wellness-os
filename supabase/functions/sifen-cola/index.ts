// sifen-cola · Edge Function (solo service role / cron). Cola de facturación electrónica SIFEN.
//   POST {} o {"origen":"pg_cron"}      → corrida completa (cron cada 10 min, migración 20261008000010).
//   POST {"shopify_order_id": 123}       → factura ese pedido ya (idempotente; respeta facturar_desde y retenciones).
//        (+ "entregado_en" opcional: lo manda post-entrega cuando la fecha todavía no está guardada)
//   POST {"shopify_order_id": 123, "motivo": "pagado"} → 29-10 factura al cobrar: lo manda factura/io.ts facturarAlCobrar
//        apenas el pedido queda pagado por adelantado (sin esperar la entrega). Mismo camino idempotente: si ya tiene
//        factura responde ya_existe; si el pago es parcial o falta pagado_en responde no_facturable (lo toma la cola).
// Con config_wa['sifen'].activo = false responde {accion:"bandera_apagada"} sin hacer nada.
import { conServiceRole } from "../_shared/auth_servicio.ts";
import { ejecutarCola, facturarUnPedido } from "./io.ts";

Deno.serve(conServiceRole(async (req) => {
  try {
    const cuerpo = await req.json().catch(() => ({})) as { shopify_order_id?: number | string; entregado_en?: string; motivo?: string };
    if (cuerpo.shopify_order_id != null) {
      const id = Number(cuerpo.shopify_order_id);
      if (!Number.isFinite(id)) return Response.json({ ok: false, error: "shopify_order_id inválido" }, { status: 400 });
      // entregado_en (opcional, de post-entrega): solo se usa si la fila todavía no tiene fecha de entrega.
      const ent = typeof cuerpo.entregado_en === "string" && !Number.isNaN(new Date(cuerpo.entregado_en).getTime()) ? cuerpo.entregado_en : null;
      const motivo = typeof cuerpo.motivo === "string" && /^[a-z_]{1,30}$/.test(cuerpo.motivo) ? cuerpo.motivo : null;
      return Response.json({ ok: true, ...(await facturarUnPedido(id, ent, motivo)) });
    }
    return Response.json({ ok: true, ...(await ejecutarCola()) });
  } catch (e) {
    console.error("sifen-cola:", e);
    return Response.json({ ok: false, error: e instanceof Error ? e.message : String(e) }, { status: 500 });
  }
}));
