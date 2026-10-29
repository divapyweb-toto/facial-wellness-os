// sifen-cola · I/O real (Supabase, Storage, WhatsApp, Telegram) para la lógica pura de _shared/sifen/cola.ts.
// Exporta:
//   - ejecutarCola()            → corrida completa (cron cada 10 min).
//   - facturarUnPedido(orderId) → lo llama factura/io.ts: post-entrega al quedar ENTREGADO y, desde el 29-10,
//                                 facturarAlCobrar al pagarse por adelantado (motivo "pagado").
//   - urlKude(path, dias)       → URL firmada del KuDE (procesar-envios, sifen-reenviar).
//   - enviarKudeWhatsApp(...)   → plantilla voltra_factura con el PDF (cola y sifen-reenviar).

import { datosEntregaKude } from "../_shared/sifen/entrega_kude.ts";
import { entregarKudeReal } from "../_shared/sifen/entrega_kude_io.ts";
import { db } from "../_shared/db.ts";
import { avisar } from "../_shared/telegram.ts";
import { escaparHtml } from "../_shared/telegram_formato.ts";
import { enviarPlantilla } from "../_shared/wa.ts";
import { partesAsuncion } from "../_shared/horario.ts";
import { horarioAvisos, puedeMandarKude } from "./horario_kude.ts";
import type { DatosEmisor, TipoDE } from "../_shared/sifen/tipos.ts";
import {
  codigoSeguridadAleatorio,
  type DatosFiscalesPedido,
  fechaCobro,
  fechaSifen,
  motivoAnulacion,
  motivoNoFacturable,
  type PedidoSifen,
} from "../_shared/sifen/desde_pedido.ts";
import { type ConfigSifen, configSifen, type DepsCola, type FilaFactura, facturarPedido, procesarCola, type ResultadoItem } from "../_shared/sifen/cola.ts";
import { crearEmisorPropioDesdeEntorno, type EmisorCola, emisorDesdeConfig } from "../_shared/sifen/emisor.ts";
import { modoSimuladoFactura } from "../_shared/facturacion.ts";

const COLS_BASE = "shopify_order_id,nombre,total,estado_envio,tags,raw,telefono,entregado_en,es_borrador,estado_confirmacion";
// 29-10: pagado_en llega con la migración 20261029000001. Si la función se despliega antes de aplicarla, la primera
// consulta falla con 42703 y desde ahí se lee sin la columna (se sigue facturando solo al entregar, como antes).
let tienePagadoEn = true;
const colsPedido = () => (tienePagadoEn ? `${COLS_BASE},pagado_en` : COLS_BASE);
type Resp = { data: unknown; error: { code?: string; message?: string } | null };
export const esFaltaPagadoEn = (e: { code?: string; message?: string } | null | undefined) =>
  !!e && (e.code === "42703" || e.code === "PGRST204") && /pagado_en/.test(e.message ?? "");
/** Corre la consulta con las columnas del pedido; si falta pagado_en, la repite sin ella. */
async function conColsPedido(q: (cols: string) => PromiseLike<Resp>): Promise<Resp> {
  const r = await q(colsPedido());
  if (tienePagadoEn && esFaltaPagadoEn(r.error)) {
    console.warn("sifen-cola: falta shopify_pedidos.pagado_en (migración 20261029000001 sin aplicar): se factura solo al entregar");
    tienePagadoEn = false;
    return await q(colsPedido());
  }
  return r;
}
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

function aPedido(p: Record<string, unknown>, rendidos: Set<number>, fiscales: Map<number, DatosFiscalesPedido> = new Map()): PedidoSifen {
  return {
    ...(p as unknown as PedidoSifen),
    shopify_order_id: Number(p.shopify_order_id),
    total: p.total == null ? null : Number(p.total),
    tags: (p.tags as string[] | null) ?? [],
    rendido: rendidos.has(Number(p.shopify_order_id)) || p.estado_envio === "RENDIDO",
    datos_fiscales: fiscales.get(Number(p.shopify_order_id)) ?? null,
  };
}

/** La tabla todavía no existe (migración de P2 sin aplicar): PostgREST 42P01 / PGRST205. */
export function esTablaInexistente(e: { code?: string; message?: string } | null | undefined): boolean {
  return !!e && (e.code === "42P01" || e.code === "PGRST205" || /does not exist|could not find the table/i.test(e.message ?? ""));
}

/**
 * Filas de pedido_datos_fiscales (P2). Tolera que la tabla no exista todavía: devuelve vacío. Sin caché a propósito:
 * apenas se aplique la migración de P2, la próxima corrida ya respeta los datos fiscales.
 */
export async function datosFiscalesDe(ids: number[]): Promise<Map<number, DatosFiscalesPedido>> {
  if (!ids.length) return new Map();
  const { data, error } = await db().from("pedido_datos_fiscales")
    .select("shopify_order_id,ruc,dv,razon_social,email,condicion,plazo_dias,origen").in("shopify_order_id", ids);
  if (esTablaInexistente(error)) return new Map();
  if (error) throw new Error(`pedido_datos_fiscales: ${error.message}`);
  return new Map((data ?? []).map((r) => [Number(r.shopify_order_id), r as unknown as DatosFiscalesPedido]));
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

/**
 * 29-10: entrega del KuDE por cadena de respaldo (_shared/sifen/entrega_kude.ts): plantilla aprobada → documento por
 * WhatsApp con ventana de 24 h → correo (Resend) → Telegram a Enrique. Devuelve el canal por el que salió.
 */
export async function enviarKudeWhatsApp(f: Pick<FilaFactura, "kude_path" | "numero_completo" | "total">, ped: PedidoSifen | null, plantilla = "voltra_factura") {
  if (!f.kude_path || !f.numero_completo) return { ok: false, error: "sin KuDE" };
  return await entregarKudeReal(datosEntregaKude(f, ped, await urlKude(f.kude_path)), plantilla);
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
  // Misma regla que el adaptador: sin SIFEN_PRODUCCION_AUTORIZADA=si, FacturaSend queda simulado (blindaje 10-10).
  if (emisor.nombre === "facturasend") {
    const m = modoSimuladoFactura();
    info.simulado = m.simulado;
    info.motivo = m.motivo;
  }
  return { emisor, ...info };
}

export async function depsReales(cfg: ConfigSifen): Promise<DepsCola> {
  const sb = db();
  const e = await construirEmisor(cfg);
  // Solo cuenta la factura del MISMO ambiente: una de prueba (test) no tapa la real (prod).
  const conFactura = async (ids: number[]): Promise<Set<number>> => {
    const { data, error } = await sb.from("facturas").select("shopify_order_id").eq("tipo_documento", 1)
      .eq("ambiente", e.ambiente).in("shopify_order_id", ids);
    if (error) throw new Error(`facturas existentes: ${error.message}`);
    return new Set((data ?? []).map((f) => Number(f.shopify_order_id)));
  };
  // Cualquier retención (liberada o no): las liberadas entran por liberadosSinFactura, no por la ventana.
  const retenidos = async (ids: number[]): Promise<Set<number>> => {
    const { data, error } = await sb.from("facturas_retenidas").select("shopify_order_id").in("shopify_order_id", ids);
    if (error) throw new Error(`facturas_retenidas: ${error.message}`);
    return new Set((data ?? []).map((r) => Number(r.shopify_order_id)));
  };
  const fila = (x: unknown) => x as FilaFactura;
  const { data: ha } = await sb.from("config_wa").select("valor").eq("clave", "horario_avisos_envio").maybeSingle();
  const horario = horarioAvisos(ha?.valor);
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
    // 29-10 FACTURA AL COBRAR: dos caminos, cada uno paginado hasta juntar `limite` pedidos facturables (los que ya
    // tienen FE o están en facturas_retenidas no tapan el lote):
    //   1. pagado_en ≥ desde (pago anticipado completo, entregado o no; sin devueltos). La lógica pura confirma con
    //      las tags (pagadoCompleto) y descarta cancelados.
    //   2. ENTREGADO/RENDIDO con entregado_en ≥ desde (contra entrega y pago parcial; sin fecha de entrega no entra).
    async pedidosSinFactura(desde, limite) {
      const out: Record<string, unknown>[] = [];
      const vistos = new Set<number>();
      const PAG = 200;
      const juntar = async (nombre: string, pagina: (pag: number) => PromiseLike<Resp>) => {
        for (let pag = 0; pag < 10 && out.length < limite; pag++) {
          const { data, error } = await pagina(pag);
          if (error) throw new Error(`${nombre}: ${error.message}`);
          // Solo los cobrados y facturables: un pagado que después se canceló (o perdió la tag) no ocupa lugar en el lote.
          const filas = ((data ?? []) as Record<string, unknown>[]).filter((p) => {
            const ped = p as unknown as PedidoSifen;
            return !vistos.has(Number(p.shopify_order_id)) && !!fechaCobro(ped) && !motivoNoFacturable(ped, cfg);
          });
          const ids = filas.map((p) => Number(p.shopify_order_id));
          if (ids.length) {
            const fuera = new Set([...(await conFactura(ids)), ...(await retenidos(ids))]);
            for (const p of filas) {
              vistos.add(Number(p.shopify_order_id));
              if (!fuera.has(Number(p.shopify_order_id))) out.push(p);
            }
          }
          if (((data ?? []) as unknown[]).length < PAG) break;
        }
      };
      // Camino 1 (antes, para que un pagado salga apenas se paga). Sin la columna (migración pendiente) se saltea.
      await conColsPedido((c) => sb.from("shopify_pedidos").select(c).limit(1));
      if (tienePagadoEn) {
        await juntar("pedidos pagados", (pag) =>
          conColsPedido((c) =>
            sb.from("shopify_pedidos").select(c)
              .not("pagado_en", "is", null).gte("pagado_en", desde).eq("es_borrador", false)
              .or("estado_envio.is.null,estado_envio.not.in.(NO_ENTREGADO,CANCELADO)")
              .order("pagado_en", { ascending: true }).order("shopify_order_id", { ascending: true })
              .range(pag * PAG, pag * PAG + PAG - 1)
          ));
      }
      // Camino 2: entregados (igual que antes del 29-10).
      await juntar("pedidos entregados", (pag) =>
        conColsPedido((c) =>
          sb.from("shopify_pedidos").select(c)
            .in("estado_envio", ["ENTREGADO", "RENDIDO"]).eq("es_borrador", false).gte("entregado_en", desde)
            .order("entregado_en", { ascending: true }).order("shopify_order_id", { ascending: true })
            .range(pag * PAG, pag * PAG + PAG - 1)
        ));
      const lista = out.slice(0, limite);
      const ids = lista.map((p) => Number(p.shopify_order_id));
      const [rend, fisc] = await Promise.all([rendidosDe(ids), datosFiscalesDe(ids)]);
      return lista.map((p) => aPedido(p, rend, fisc));
    },
    async liberadosSinFactura(limite) {
      const { data, error } = await sb.from("facturas_retenidas").select("shopify_order_id")
        .not("liberado_en", "is", null).not("shopify_order_id", "is", null).order("liberado_en").limit(500);
      if (error) throw new Error(`retenidos liberados: ${error.message}`);
      const ids = (data ?? []).map((r) => Number(r.shopify_order_id));
      if (!ids.length) return [];
      const con = await conFactura(ids);
      const faltan = ids.filter((id) => !con.has(id)).slice(0, limite);
      if (!faltan.length) return [];
      const { data: peds, error: e2 } = await conColsPedido((c) => sb.from("shopify_pedidos").select(c).in("shopify_order_id", faltan));
      if (e2) throw new Error(`pedidos liberados: ${e2.message}`);
      const [rend, fisc] = await Promise.all([rendidosDe(faltan), datosFiscalesDe(faltan)]);
      return ((peds ?? []) as Record<string, unknown>[]).map((p) => aPedido(p, rend, fisc));
    },
    async retencion(orderId) {
      const { data, error } = await sb.from("facturas_retenidas").select("motivo,liberado_en").eq("shopify_order_id", orderId).maybeSingle();
      if (error) throw new Error(`facturas_retenidas: ${error.message}`);
      return data ? { motivo: String(data.motivo), liberado_en: (data.liberado_en as string | null) ?? null } : null;
    },
    async retener(orderId, motivo, nota) {
      const { error } = await sb.from("facturas_retenidas")
        .upsert({ shopify_order_id: orderId, motivo, nota }, { onConflict: "shopify_order_id", ignoreDuplicates: true });
      if (error) throw new Error(`retener: ${error.message}`);
    },
    async facturasVencidas(ahoraIso, limite) {
      const { data, error } = await sb.from("facturas").select("*")
        .in("estado", ["pendiente", "enviada", "error", "aprobada"]).lte("proximo_intento", ahoraIso)
        .eq("ambiente", e.ambiente).order("proximo_intento").limit(limite);
      if (error) throw new Error(`facturas vencidas: ${error.message}`);
      return (data ?? []).map(fila);
    },
    // 29-10: además de NO_ENTREGADO/CANCELADO, el pagado (y facturado) que se cancela sin entregarse: cancelado en
    // Shopify (raw.cancelled_at), estado_confirmacion cancelado_* o tag CANCELADO_CLIENTE. motivoAnulacion filtra
    // (un entregado con tag vieja no se anula). Reenvíos (INTENTO_FALLIDO, NO_ENTREGADO_RESCATABLE…) no entran.
    async facturasDevueltas(limite) {
      const desde = new Date(Date.now() - 60 * 86_400_000).toISOString();
      const consultas = await Promise.all([
        conColsPedido((c) => sb.from("shopify_pedidos").select(c).gte("actualizado_en", desde).limit(500)
          .or("estado_envio.in.(NO_ENTREGADO,CANCELADO),estado_confirmacion.like.cancelado*,tags.cs.{CANCELADO_CLIENTE}")),
        conColsPedido((c) => sb.from("shopify_pedidos").select(c).gte("actualizado_en", desde).limit(500)
          .not("raw->>cancelled_at", "is", null)),
      ]);
      const porIdCrudo = new Map<number, Record<string, unknown>>();
      for (const { data, error } of consultas) {
        if (error) throw new Error(`pedidos devueltos: ${error.message}`);
        for (const p of (data ?? []) as Record<string, unknown>[]) porIdCrudo.set(Number(p.shopify_order_id), p);
      }
      const peds = [...porIdCrudo.values()];
      const ids = peds.map((p) => Number(p.shopify_order_id));
      if (!ids.length) return [];
      const { data: fs, error: e2 } = await sb.from("facturas").select("*").eq("tipo_documento", 1).eq("estado", "aprobada")
        .eq("ambiente", e.ambiente).in("shopify_order_id", ids).limit(limite);
      if (e2) throw new Error(`facturas de devueltos: ${e2.message}`);
      const [rend, fisc] = await Promise.all([rendidosDe(ids), datosFiscalesDe(ids)]);
      const porId = new Map(peds.map((p) => [Number(p.shopify_order_id), aPedido(p, rend, fisc)]));
      return (fs ?? []).map((f) => ({ factura: fila(f), pedido: porId.get(Number(f.shopify_order_id))! }))
        .filter((x) => x.pedido && motivoAnulacion(x.pedido));
    },
    async leerPedido(id) {
      const { data, error } = await conColsPedido((c) => sb.from("shopify_pedidos").select(c).eq("shopify_order_id", id).maybeSingle());
      if (error) throw new Error(`leerPedido: ${error.message}`);
      if (!data) return null;
      const [rend, fisc] = await Promise.all([rendidosDe([id]), datosFiscalesDe([id])]);
      return aPedido(data as Record<string, unknown>, rend, fisc);
    },
    async leerFactura(id) {
      const { data, error } = await sb.from("facturas").select("*").eq("id", id).maybeSingle();
      if (error) throw new Error(`leerFactura: ${error.message}`);
      return data ? fila(data) : null;
    },
    async facturaDePedido(orderId) {
      const { data, error } = await sb.from("facturas").select("*").eq("shopify_order_id", orderId).eq("tipo_documento", 1)
        .eq("ambiente", e.ambiente).maybeSingle();
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
    // Fuera de horario no sale: devuelve error y la cola lo reprograma para una corrida posterior.
    enviarKude: async (f, ped) =>
      puedeMandarKude(new Date(), horario)
        ? await enviarKudeWhatsApp(f, ped, cfg.plantilla_factura)
        : { ok: false, error: "fuera de horario de avisos; sale en una corrida posterior" },
    avisar: (t, b, o) => avisar(t, b, o),
    escapar: escaparHtml,
  };
}

export async function ejecutarCola() {
  const cfg = await leerConfigSifen();
  if (!cfg.activo) return { accion: "bandera_apagada" };
  const d = await depsReales(cfg);
  return { simulado: d.simulado, ambiente: d.ambiente, emisor: d.emisor.nombre, ...(await procesarCola(d)) };
}

/**
 * Para post-entrega y el pago (vía factura/io.ts) y la llamada manual. No tira excepción. Respeta el corte
 * (facturar_desde) y las retenciones igual que la cola. `entregadoEn`: la fecha que post-entrega calculó y todavía no
 * guardó. `motivo` ("pagado" | "entregado" | manual): solo informativo; la lógica decide por fechaCobro, así que
 * {motivo:"pagado"} factura un pedido pagado no entregado y no hace nada (ya_existe) si ya estaba facturado.
 */
export async function facturarUnPedido(orderId: number, entregadoEn?: string | null, motivo?: string | null): Promise<ResultadoItem & { motivo?: string }> {
  try {
    const cfg = await leerConfigSifen();
    if (!cfg.activo) return { ref: `pedido ${orderId}`, accion: "bandera_apagada" };
    const r = await facturarPedido(orderId, await depsReales(cfg), { entregadoEn });
    return motivo ? { ...r, motivo } : r;
  } catch (e) {
    console.error("facturarUnPedido:", e);
    return { ref: `pedido ${orderId}`, accion: "error", detalle: e instanceof Error ? e.message : String(e) };
  }
}
