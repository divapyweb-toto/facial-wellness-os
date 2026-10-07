// factura · I/O real (Supabase, FacturaSend vía _shared/facturacion.ts, Telegram).
// Exporta las dos funciones que usan otros módulos:
//   - facturarPedidoEntregado(orderId)   → la llama post-entrega (H2) cuando el pedido pasa a ENTREGADO.
//   - envioSeguimientoParaPedido(orderId) → la llama procesar-envios (F) antes de mandar voltra_seguimiento_entrega:
//       si devuelve algo, se manda ESA plantilla (con la factura adjunta) en lugar del seguimiento normal.

import { db } from "../_shared/db.ts";
import { avisar } from "../_shared/telegram.ts";
import { escaparHtml } from "../_shared/telegram_formato.ts";
import { armarSeguimientoConFactura, descargarKude, emitirFactura } from "../_shared/facturacion.ts";
import {
  configFactura,
  type ConfigOla4Factura,
  type DepsFactura,
  facturarPedido,
  type FilaFactura,
  type PedidoGuardado,
  type ResultadoFacturar,
} from "./facturar.ts";

export async function leerConfigFactura(): Promise<ConfigOla4Factura> {
  const { data, error } = await db().from("config_wa").select("valor").eq("clave", "ola4.factura").maybeSingle();
  if (error) throw new Error(`config_wa ola4.factura: ${error.message}`);
  if (!data) console.log("factura: falta config_wa['ola4.factura'] → bandera apagada (valor por defecto)");
  return configFactura(data?.valor);
}

export const depsReales: DepsFactura = {
  ahora: () => new Date(),
  config: leerConfigFactura,
  leerPedido: async (id) => {
    const { data, error } = await db().from("shopify_pedidos")
      .select("shopify_order_id,nombre,total,estado_envio,tags,raw").eq("shopify_order_id", id).maybeSingle();
    if (error) throw new Error(`leerPedido: ${error.message}`);
    return data ? { ...(data as PedidoGuardado), tags: (data.tags as string[] | null) ?? [] } : null;
  },
  leerFactura: async (id) => {
    const { data, error } = await db().from("facturas").select("*").eq("shopify_order_id", id).maybeSingle();
    if (error) throw new Error(`leerFactura: ${error.message}`);
    return data as FilaFactura | null;
  },
  tomar: async (id, numeroInicial) => {
    const { data, error } = await db().rpc("tomar_factura", { p_order: id, p_numero_inicial: numeroInicial, p_lease_min: 10 });
    if (error) throw new Error(`tomar_factura: ${error.message}`);
    const f = (Array.isArray(data) ? data[0] : data) as { numero: number; tomada: boolean; estado: string; intentos: number };
    return f;
  },
  guardar: async (f) => {
    const { error } = await db().from("facturas").upsert(f, { onConflict: "shopify_order_id" });
    if (error) throw new Error(`guardar factura: ${error.message}`);
  },
  emitir: emitirFactura,
  avisar: (t) => avisar(t),
  escapar: escaparHtml,
};

/** Punto de enganche para post-entrega (H2). No tira excepción: devuelve el resultado. */
export async function facturarPedidoEntregado(orderId: number): Promise<ResultadoFacturar> {
  try {
    return await facturarPedido(orderId, depsReales);
  } catch (e) {
    console.error("facturarPedidoEntregado:", e);
    return { orderId, accion: "error", error: e instanceof Error ? e.message : String(e) };
  }
}

/** Reintentos (cron): facturas en error con intentos disponibles, emitidas sin PDF y entregados sin factura. */
export async function facturarPendientes(diasAtras = 7): Promise<{ procesados: number; resultados: ResultadoFacturar[] }> {
  const cfg = await leerConfigFactura();
  if (!cfg.activo) return { procesados: 0, resultados: [{ orderId: 0, accion: "bandera_apagada" }] };
  const sb = db();
  const desde = new Date(Date.now() - diasAtras * 86_400_000).toISOString();
  const resultados: ResultadoFacturar[] = [];

  // 1) Emitidas sin PDF: solo se vuelve a pedir el KuDE.
  const { data: sinPdf } = await sb.from("facturas").select("shopify_order_id,cdc,numero_completo")
    .eq("estado", "emitida").is("pdf_url", null).not("cdc", "is", null).limit(20);
  for (const f of sinPdf ?? []) {
    const r = await descargarKude(f.cdc as string, `${f.shopify_order_id}/${f.numero_completo}.pdf`, cfg);
    if (r.ok) await sb.from("facturas").update({ pdf_url: r.pdf_url, pdf_path: r.pdf_path, error: null }).eq("shopify_order_id", f.shopify_order_id);
  }

  // 2) Errores con intentos disponibles + entregados recientes sin fila en facturas.
  const { data: errores } = await sb.from("facturas").select("shopify_order_id")
    .eq("estado", "error").lt("intentos", cfg.maximo_intentos).limit(20);
  const { data: entregados } = await sb.from("shopify_pedidos").select("shopify_order_id")
    .eq("estado_envio", "ENTREGADO").eq("es_borrador", false).gte("actualizado_en", desde).limit(100);
  const ids = new Set<number>((errores ?? []).map((f) => Number(f.shopify_order_id)));
  if (entregados?.length) {
    const lista = entregados.map((p) => Number(p.shopify_order_id));
    const { data: ya } = await sb.from("facturas").select("shopify_order_id").in("shopify_order_id", lista);
    const conFila = new Set((ya ?? []).map((f) => Number(f.shopify_order_id)));
    for (const id of lista) if (!conFila.has(id)) ids.add(id);
  }
  for (const id of ids) resultados.push(await facturarPedidoEntregado(id));
  return { procesados: ids.size, resultados };
}

/**
 * Mejora 7. Para procesar-envios: si la bandera está activa y la factura del pedido está emitida con PDF,
 * devuelve la plantilla con el documento adjunto; si no, null (se manda el seguimiento normal).
 */
export async function envioSeguimientoParaPedido(
  orderId: number,
  variables: { nombre?: string | null; productos?: string | null },
): Promise<{ plantilla: string; idioma: string; componentes: unknown[] } | null> {
  const cfg = await leerConfigFactura();
  if (!cfg.activo) return null;
  const { data } = await db().from("facturas").select("estado,pdf_url,numero_completo").eq("shopify_order_id", orderId).maybeSingle();
  if (!data || data.estado !== "emitida" || !data.pdf_url || !data.numero_completo) return null;
  return armarSeguimientoConFactura({
    orderId,
    nombre: variables.nombre ?? null,
    productos: variables.productos ?? null,
    pdfUrl: data.pdf_url as string,
    numeroCompleto: data.numero_completo as string,
    plantilla: cfg.plantilla_seguimiento,
  });
}
