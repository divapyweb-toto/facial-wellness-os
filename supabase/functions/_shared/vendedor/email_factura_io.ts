// _shared/vendedor/email_factura_io.ts · Dueño: E (29-10). I/O real de guardar_email_factura (lógica en email_factura.ts).
// Supabase: pedido_email_factura (migración 20261029000009, SIN aplicar al 29-10), pedido_datos_fiscales (solo el email,
// si el pedido ya tiene fila), facturas (lectura), storage "facturas" (URL firmada) y wa_mensajes (textos del bot).
// Correo: la Dep enviarCorreo de la cadena de entrega del agente B (_shared/sifen/entrega_kude_io.ts), forzando ese canal.
// Nada de esto corre en los tests.
import { db } from "../db.ts";
import { depsEntregaKude } from "../sifen/entrega_kude_io.ts";
import type { DatosEntregaKude } from "../sifen/entrega_kude.ts";
import type { DepsEmailFactura, FacturaParaReenvio } from "./email_factura.ts";

const BUCKET_FACTURAS = "facturas";
/** Tabla que todavía no existe (migración sin aplicar): se trata como vacía, no como error. */
const tablaInexistente = (e: { code?: string; message?: string } | null | undefined) =>
  !!e && (e.code === "42P01" || e.code === "PGRST205" || /does not exist|could not find the table/i.test(e.message ?? ""));

/**
 * Emails pedidos por WhatsApp para estos pedidos (shopify_order_id → email). Para la cadena de entrega del KuDE
 * (sifen-cola/io.ts): `d.email = (await emailsFacturaDe([id])).get(id) ?? d.email`. Tolera la tabla sin crear.
 */
export async function emailsFacturaDe(ids: number[]): Promise<Map<number, string>> {
  if (!ids.length) return new Map();
  const { data, error } = await db().from("pedido_email_factura").select("shopify_order_id,email").in("shopify_order_id", ids);
  if (tablaInexistente(error)) return new Map();
  if (error) throw new Error(`pedido_email_factura: ${error.message}`);
  return new Map((data ?? []).map((r) => [Number(r.shopify_order_id), String(r.email)]));
}

export const depsEmailFacturaReales: DepsEmailFactura = {
  async guardar(orderId, email, meta) {
    const sb = db();
    const t = await sb.from("pedido_email_factura").upsert({
      shopify_order_id: orderId,
      email,
      origen: "whatsapp",
      conversacion_id: meta.conversacionId,
      cliente_id: meta.clienteId,
    }, { onConflict: "shopify_order_id" });
    // pedido_datos_fiscales: solo si el pedido YA tiene fila (mayorista / web con RUC). Nunca se crea una: ruc, dv y
    // razon_social son NOT NULL con checks, y una fila sin RUC mandaría la factura a 'revisar' (desde_pedido.ts).
    // Con factura de producción emitida el trigger de bloqueo rechaza el UPDATE (P0001): queda solo en la tabla nueva.
    const df = await sb.from("pedido_datos_fiscales").update({ email }).eq("shopify_order_id", orderId).select("shopify_order_id");
    const dfOk = !df.error && (df.data?.length ?? 0) > 0;
    if (df.error && !tablaInexistente(df.error) && df.error.code !== "P0001") console.warn("email factura → datos fiscales:", df.error.message);
    if (!t.error || dfOk) return { ok: true };
    return { ok: false, error: tablaInexistente(t.error) ? "falta aplicar la migración pedido_email_factura" : t.error.message };
  },

  async facturaAprobada(orderId) {
    const { data, error } = await db().from("facturas").select("id,numero_completo,total,kude_path")
      .eq("shopify_order_id", orderId).eq("tipo_documento", 1).eq("estado", "aprobada").eq("ambiente", "prod").eq("simulado", false)
      .not("kude_path", "is", null).not("numero_completo", "is", null)
      .order("creado_en", { ascending: false }).limit(1).maybeSingle();
    if (error) throw new Error(`facturas: ${error.message}`);
    return (data ?? null) as FacturaParaReenvio | null;
  },

  async enviarFactura({ factura, email, pedido, nombre }) {
    const s = await db().storage.from(BUCKET_FACTURAS).createSignedUrl(factura.kude_path, 7 * 86_400);
    if (s.error || !s.data?.signedUrl) return { ok: false, error: `url firmada: ${s.error?.message ?? "vacía"}` };
    const d: DatosEntregaKude = {
      pdfUrl: s.data.signedUrl,
      numeroCompleto: factura.numero_completo,
      total: factura.total,
      nombre,
      telefono: null,
      email,
      pedido,
    };
    return await depsEntregaKude().enviarCorreo(d);
  },

  async estadoConversacion(conversacionId) {
    const sb = db();
    const [g, m] = await Promise.all([
      sb.from("pedido_email_factura").select("email").eq("conversacion_id", conversacionId).limit(1).maybeSingle(),
      sb.from("wa_mensajes").select("texto").eq("conversacion_id", conversacionId).eq("direccion", "out")
        .order("creado_en", { ascending: false }).limit(60),
    ]);
    if (g.error && !tablaInexistente(g.error)) throw new Error(`pedido_email_factura: ${g.error.message}`);
    if (m.error) throw new Error(`wa_mensajes: ${m.error.message}`);
    return {
      email: (g.data?.email as string | undefined) ?? null,
      textosBot: (m.data ?? []).map((x) => String(x.texto ?? "")).filter(Boolean),
    };
  },
};
