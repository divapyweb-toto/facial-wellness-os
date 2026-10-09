// sifen-cola · I/O real (Supabase, Storage, WhatsApp, Telegram) para la lógica pura de _shared/sifen/cola.ts.
// Exporta:
//   - ejecutarCola()            → corrida completa (cron cada 10 min).
//   - facturarUnPedido(orderId) → lo llama factura/io.ts (post-entrega) al quedar ENTREGADO.
//   - urlKude(path, dias)       → URL firmada del KuDE (procesar-envios, sifen-reenviar).
//   - enviarKudeWhatsApp(...)   → plantilla voltra_factura con el PDF (cola y sifen-reenviar).

import { db } from "../_shared/db.ts";
import { avisar } from "../_shared/telegram.ts";
import { escaparHtml } from "../_shared/telegram_formato.ts";
import { enviarPlantilla } from "../_shared/wa.ts";
import { partesAsuncion } from "../_shared/horario.ts";
import type { DatosEmisor, TipoDE } from "../_shared/sifen/tipos.ts";
import { codigoSeguridadAleatorio, fechaSifen, type PedidoSifen } from "../_shared/sifen/desde_pedido.ts";
import { type ConfigSifen, configSifen, type DepsCola, type FilaFactura, facturarPedido, procesarCola, type ResultadoItem } from "../_shared/sifen/cola.ts";
import { crearEmisorPropioDesdeEntorno, type EmisorCola, emisorDesdeConfig } from "../_shared/sifen/emisor.ts";

const COLS_PEDIDO = "shopify_order_id,nombre,total,estado_envio,tags,raw,telefono,entregado_en,es_borrador,estado_confirmacion";
const BUCKET = "facturas";

export async function leerConfigSifen(): Promise<ConfigSifen> {
  const { data, error } = await db().from("config_wa").select("valor").eq("clave", "sifen").maybeSingle();
  if (error) throw new Error(`config_wa sifen: ${error.message}`);
  return configSifen(data?.valor);
}

/** Clave de la serie en sifen_numeracion: en test no se consumen números de producción. */
export function claveTimbrado(timbrado: string, ambiente: "test" | "prod"): string {
  return ambiente === "prod" ? timbrado : `${timbrado}-test`;
}

function aPedido(p: Record<string, unknown>, rendidos: Set<number>): PedidoSifen {
  return {
    ...(p as unknown as PedidoSifen),
    shopify_order_id: Number(p.shopify_order_id),
    total: p.total == null ? null : Number(p.total),
    tags: (p.tags as string[] | null) ?? [],
    rendido: rendidos.has(Number(p.shopify_order_id)) || p.estado_envio === "RENDIDO",
  };
}

async function rendidosDe(ids: number[]): Promise<Set<number>> {
  if (!ids.length) return new Set();
  const { data, error } = await db().from("pedido_estados").select("shopify_order_id").in("shopify_order_id", ids).eq("estado", "RENDIDO");
  if (error) throw new Error(`pedido_estados: ${error.message}`);
  return new Set((data ?? []).map((x) => Number(x.shopify_order_id)));
}

export async function urlKude(path: string, dias = 7): Promise<string> {
  const s = await db().storage.from(BUCKET).createSignedUrl(path, dias * 86_400);
  if (s.error || !s.data?.signedUrl) throw new Error(`url firmada: ${s.error?.message ?? "vacía"}`);
  return s.data.signedUrl;
}

/** Componentes de la plantilla voltra_factura (header DOCUMENT + nombre + número). */
export function componentesFactura(args: { pdfUrl: string; numeroCompleto: string; nombre: string | null }): unknown[] {
  const nombre = (args.nombre ?? "").replace(/[\n\r\t]+/g, " ").replace(/ {2,}/g, " ").trim().split(" ")[0] || "qué tal";
  return [
    { type: "header", parameters: [{ type: "document", document: { link: args.pdfUrl, filename: `Factura ${args.numeroCompleto}.pdf` } }] },
    { type: "body", parameters: [{ type: "text", text: nombre }, { type: "text", text: args.numeroCompleto }] },
  ];
}

function nombreDePedido(p: PedidoSifen | null): string | null {
  const r = (p?.raw ?? {}) as Record<string, Record<string, unknown>>;
  return (r.shipping_address?.first_name as string) ?? (r.customer?.first_name as string) ?? (r.shipping_address?.name as string) ?? null;
}

export async function enviarKudeWhatsApp(f: Pick<FilaFactura, "kude_path" | "numero_completo">, ped: PedidoSifen | null, plantilla = "voltra_factura") {
  if (!f.kude_path || !f.numero_completo) return { ok: false, error: "sin KuDE" };
  if (!ped?.telefono) return { ok: false, error: "el pedido no tiene teléfono" };
  const pdfUrl = await urlKude(f.kude_path);
  return await enviarPlantilla(ped.telefono, plantilla, "es", componentesFactura({ pdfUrl, numeroCompleto: f.numero_completo, nombre: nombreDePedido(ped) }));
}

async function datosEmisor(cfg: ConfigSifen): Promise<DatosEmisor | null> {
  const v = (cfg as unknown as { datos_emisor?: unknown }).datos_emisor;
  return v && typeof v === "object" ? v as DatosEmisor : null;
}

async function siguienteNumero(timbrado: string, est: string, pun: string, tipo: TipoDE, ambiente: "test" | "prod"): Promise<number> {
  const { data, error } = await db().rpc("sifen_siguiente_numero", { p_timbrado: claveTimbrado(timbrado, ambiente), p_est: est, p_pun: pun, p_tipo: tipo });
  if (error) throw new Error(`sifen_siguiente_numero: ${error.message}`);
  return Number(data);
}

export async function construirEmisor(cfg: ConfigSifen): Promise<{ emisor: EmisorCola; simulado: boolean; ambiente: "test" | "prod"; timbrado: string; motivo?: string }> {
  let info = { simulado: false, ambiente: "test" as "test" | "prod", timbrado: Deno.env.get("SIFEN_TIMBRADO") ?? "12345678", motivo: undefined as string | undefined };
  const emisor = await emisorDesdeConfig(cfg.emisor, {
    propio: async () => {
      const r = await crearEmisorPropioDesdeEntorno({
        emisor: await datosEmisor(cfg),
        siguienteNumero: (t, e, p, tipo) => siguienteNumero(t, e, p, tipo, r.cred.ambiente),
      });
      info = { simulado: r.simulado, ambiente: r.cred.ambiente, timbrado: r.cred.timbrado, motivo: r.motivo };
      if (r.simulado) console.log(`sifen: MODO SIMULADO (${r.motivo}); módulos simulados: ${r.modulosSimulados.join(", ") || "ninguno"}`);
      return r.emisor;
    },
  });
  if (emisor.nombre === "facturasend") info.simulado = Deno.env.get("MODO_SIMULADO") === "1" || !Deno.env.get("FACTURASEND_API_KEY");
  return { emisor, ...info };
}

export async function depsReales(cfg: ConfigSifen): Promise<DepsCola> {
  const sb = db();
  const e = await construirEmisor(cfg);
  const fila = (x: unknown) => x as FilaFactura;
  return {
    ahora: () => new Date(),
    aleatorio: Math.random,
    cfg,
    ambiente: e.ambiente,
    simulado: e.simulado,
    timbrado: e.timbrado,
    emisor: e.emisor,
    fechaSifen,
    codigoSeguridad: () => codigoSeguridadAleatorio(),
    async pedidosSinFactura(desde, limite) {
      const { data, error } = await sb.from("shopify_pedidos").select(COLS_PEDIDO)
        .in("estado_envio", ["ENTREGADO", "RENDIDO"]).eq("es_borrador", false)
        .or(`entregado_en.gte.${desde},and(entregado_en.is.null,actualizado_en.gte.${desde})`)
        .order("entregado_en", { ascending: true }).limit(limite * 3);
      if (error) throw new Error(`pedidos entregados: ${error.message}`);
      const ids = (data ?? []).map((p) => Number(p.shopify_order_id));
      if (!ids.length) return [];
      const { data: ya, error: e2 } = await sb.from("facturas").select("shopify_order_id").eq("tipo_documento", 1).in("shopify_order_id", ids);
      if (e2) throw new Error(`facturas existentes: ${e2.message}`);
      const con = new Set((ya ?? []).map((f) => Number(f.shopify_order_id)));
      const rend = await rendidosDe(ids);
      return (data ?? []).filter((p) => !con.has(Number(p.shopify_order_id))).slice(0, limite).map((p) => aPedido(p, rend));
    },
    async facturasVencidas(ahoraIso, limite) {
      const { data, error } = await sb.from("facturas").select("*")
        .in("estado", ["pendiente", "enviada", "error", "aprobada"]).lte("proximo_intento", ahoraIso)
        .eq("ambiente", e.ambiente).order("proximo_intento").limit(limite);
      if (error) throw new Error(`facturas vencidas: ${error.message}`);
      return (data ?? []).map(fila);
    },
    async facturasDevueltas(limite) {
      const desde = new Date(Date.now() - 60 * 86_400_000).toISOString();
      const { data: peds, error } = await sb.from("shopify_pedidos").select(COLS_PEDIDO)
        .in("estado_envio", ["NO_ENTREGADO", "CANCELADO"]).gte("actualizado_en", desde).limit(500);
      if (error) throw new Error(`pedidos devueltos: ${error.message}`);
      const ids = (peds ?? []).map((p) => Number(p.shopify_order_id));
      if (!ids.length) return [];
      const { data: fs, error: e2 } = await sb.from("facturas").select("*").eq("tipo_documento", 1).eq("estado", "aprobada")
        .eq("ambiente", e.ambiente).in("shopify_order_id", ids).limit(limite);
      if (e2) throw new Error(`facturas de devueltos: ${e2.message}`);
      const rend = await rendidosDe(ids);
      const porId = new Map((peds ?? []).map((p) => [Number(p.shopify_order_id), aPedido(p, rend)]));
      return (fs ?? []).map((f) => ({ factura: fila(f), pedido: porId.get(Number(f.shopify_order_id))! })).filter((x) => x.pedido);
    },
    async leerPedido(id) {
      const { data, error } = await sb.from("shopify_pedidos").select(COLS_PEDIDO).eq("shopify_order_id", id).maybeSingle();
      if (error) throw new Error(`leerPedido: ${error.message}`);
      return data ? aPedido(data, await rendidosDe([id])) : null;
    },
    async leerFactura(id) {
      const { data, error } = await sb.from("facturas").select("*").eq("id", id).maybeSingle();
      if (error) throw new Error(`leerFactura: ${error.message}`);
      return data ? fila(data) : null;
    },
    async facturaDePedido(orderId) {
      const { data, error } = await sb.from("facturas").select("*").eq("shopify_order_id", orderId).eq("tipo_documento", 1).maybeSingle();
      if (error) throw new Error(`facturaDePedido: ${error.message}`);
      return data ? fila(data) : null;
    },
    async notasDeFactura(id) {
      const { data, error } = await sb.from("facturas").select("*").eq("factura_original_id", id).eq("tipo_documento", 5);
      if (error) throw new Error(`notasDeFactura: ${error.message}`);
      return (data ?? []).map(fila);
    },
    async crearFactura(f) {
      const { data, error } = await sb.from("facturas").insert(f).select("*").single();
      if (error?.code === "23505") return null; // índice único parcial: ya existe
      if (error) throw new Error(`crearFactura: ${error.message}`);
      return fila(data);
    },
    async tomarLease(id) {
      const { data, error } = await sb.rpc("tomar_factura", { p_factura: id, p_lease_min: cfg.lease_min });
      if (error) throw new Error(`tomar_factura: ${error.message}`);
      const r = (Array.isArray(data) ? data[0] : data) as { tomada: boolean } | null;
      return r?.tomada === true;
    },
    async asignarNumero(id, a) {
      const { data, error } = await sb.rpc("sifen_asignar_numero", {
        p_factura: id,
        p_clave_timbrado: claveTimbrado(e.timbrado, e.ambiente),
        p_codigo_seguridad: a.codigoSeguridad,
        p_fecha: a.fechaEmision,
      });
      if (error) throw new Error(`sifen_asignar_numero: ${error.message}`);
      return (Array.isArray(data) ? data[0] : data) as { numero: number; numero_completo: string; codigo_seguridad: string; fecha_emision: string };
    },
    async actualizar(id, cambios) {
      const { error } = await sb.from("facturas").update(cambios).eq("id", id);
      if (error) throw new Error(`actualizar factura: ${error.message}`);
    },
    async registrarEvento(ev) {
      const { error } = await sb.from("eventos_sifen").insert(ev);
      if (error) throw new Error(`eventos_sifen: ${error.message}`);
    },
    async subirKude(f, pdf) {
      const mes = partesAsuncion(new Date(f.fecha_emision ?? Date.now()));
      const ruta = `sifen/${f.ambiente}/${mes.anio}-${String(mes.mes).padStart(2, "0")}/${f.numero_completo}-${f.tipo_documento}-${f.cdc ?? f.id}.pdf`;
      const up = await sb.storage.from(BUCKET).upload(ruta, pdf, { contentType: "application/pdf", upsert: true });
      if (up.error) throw new Error(`storage: ${up.error.message}`);
      return ruta;
    },
    enviarKude: (f, ped) => enviarKudeWhatsApp(f, ped, cfg.plantilla_factura),
    avisar: (t) => avisar(t),
    escapar: escaparHtml,
  };
}

export async function ejecutarCola() {
  const cfg = await leerConfigSifen();
  if (!cfg.activo) return { accion: "bandera_apagada" };
  const d = await depsReales(cfg);
  return { simulado: d.simulado, ambiente: d.ambiente, emisor: d.emisor.nombre, ...(await procesarCola(d)) };
}

/** Para post-entrega (vía factura/io.ts). No tira excepción. */
export async function facturarUnPedido(orderId: number): Promise<ResultadoItem> {
  try {
    const cfg = await leerConfigSifen();
    if (!cfg.activo) return { ref: `pedido ${orderId}`, accion: "bandera_apagada" };
    return await facturarPedido(orderId, await depsReales(cfg));
  } catch (e) {
    console.error("facturarUnPedido:", e);
    return { ref: `pedido ${orderId}`, accion: "error", detalle: e instanceof Error ? e.message : String(e) };
  }
}
