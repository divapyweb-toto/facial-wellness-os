// factura · I/O. Desde 08-10-2026 delega en la cola SIFEN (sistema propio o FacturaSend según config_wa['sifen'].emisor).
// Exporta las dos funciones que usan otros módulos (firmas sin cambios):
//   - facturarPedidoEntregado(orderId)   → la llama post-entrega cuando el pedido pasa a ENTREGADO.
//   - envioSeguimientoParaPedido(orderId) → la llama procesar-envios (mejora 7) antes de voltra_seguimiento_entrega.
// La lógica vieja (facturar.ts, FacturaSend directo) queda como LEGADO y ya no se llama desde acá.

import { db } from "../_shared/db.ts";
import { armarSeguimientoConFactura } from "../_shared/facturacion.ts";

// Se invoca la Edge Function sifen-cola (y no su código) para que la emisión corra con su bundle: XSD y fuentes
// del KuDE van como static_files solo en sifen-cola (config.toml). El cliente db() manda la service role.
async function invocarCola(cuerpo: Record<string, unknown>): Promise<Record<string, unknown>> {
  const { data, error } = await db().functions.invoke("sifen-cola", { body: cuerpo });
  if (error) throw new Error(`sifen-cola: ${error.message}`);
  return (data ?? {}) as Record<string, unknown>;
}

async function sifenActivo(): Promise<boolean> {
  const { data, error } = await db().from("config_wa").select("valor").eq("clave", "sifen").maybeSingle();
  if (error) throw new Error(`config_wa sifen: ${error.message}`);
  return (data?.valor as { activo?: unknown } | null)?.activo === true;
}

export interface ResultadoFacturarIo {
  orderId: number;
  accion: string;
  error?: string;
}

/**
 * Punto de enganche para post-entrega. No tira excepción: devuelve el resultado.
 * `entregadoEn`: fecha de entrega recién calculada por post-entrega (todavía sin guardar); la cola la usa para el corte
 * facturar_desde. Pedido anterior al corte → accion 'retenido' (queda en facturas_retenidas, no se factura).
 */
export async function facturarPedidoEntregado(orderId: number, entregadoEn?: string | null): Promise<ResultadoFacturarIo> {
  try {
    const r = await invocarCola({ shopify_order_id: orderId, ...(entregadoEn ? { entregado_en: entregadoEn } : {}) });
    const accion = String(r.accion ?? (r.ok === false ? "error" : "sin_detalle"));
    const detalle = (r.detalle ?? r.error) as string | undefined;
    return { orderId, accion, ...(accion === "error" || accion === "revisar" || accion === "sin_corte" ? { error: detalle ?? "sin detalle" } : {}) };
  } catch (e) {
    return { orderId, accion: "error", error: e instanceof Error ? e.message : String(e) };
  }
}

/** Reintentos (el cron viejo wa-factura-reintentos se reemplazó por sifen-cola; esto queda por compatibilidad). */
export async function facturarPendientes() {
  return await invocarCola({ origen: "factura" });
}

/**
 * Mejora 7. Para procesar-envios: si la factura (FE) del pedido está APROBADA con KuDE y todavía no se mandó
 * por WhatsApp (kude_enviado_en vacío), devuelve la plantilla del seguimiento con la factura adjunta; si no, null.
 * Si la cola ya la mandó con voltra_factura, sale el seguimiento normal (no se duplica el PDF).
 */
export async function envioSeguimientoParaPedido(
  orderId: number,
  variables: { nombre?: string | null; productos?: string | null },
): Promise<{ plantilla: string; idioma: string; componentes: unknown[] } | null> {
  if (!(await sifenActivo())) return null;
  const { data } = await db().from("facturas").select("estado,kude_path,numero_completo,kude_enviado_en")
    .eq("shopify_order_id", orderId).eq("tipo_documento", 1)
    // Puede haber una de prueba ('test') y la real ('prod'): se toma la real primero.
    .order("ambiente", { ascending: true }).limit(1).maybeSingle();
  if (!data || data.estado !== "aprobada" || !data.kude_path || !data.numero_completo || data.kude_enviado_en) return null;
  return armarSeguimientoConFactura({
    orderId,
    nombre: variables.nombre ?? null,
    productos: variables.productos ?? null,
    pdfUrl: await urlFirmada(data.kude_path as string),
    numeroCompleto: data.numero_completo as string,
  });
}

async function urlFirmada(path: string): Promise<string> {
  const s = await db().storage.from("facturas").createSignedUrl(path, 7 * 86_400);
  if (s.error || !s.data?.signedUrl) throw new Error(`url firmada: ${s.error?.message ?? "vacía"}`);
  return s.data.signedUrl;
}
