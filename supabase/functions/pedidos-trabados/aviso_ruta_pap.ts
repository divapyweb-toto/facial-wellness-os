// pedidos-trabados · aviso "en recorrido de reparto" para PaP (Enrique 19-10-2026).
// Cuando PaP pasa un pedido a "Asignado a ruta": UNA vez por pedido (clave courier:<id>:EN_RUTA, aunque PaP reasigne),
// solo PaP y confirmados. Plantilla aprobada voltra_entrega_proxima ("ya está por llegar. Tené listo Gs X…").
// Si el "ya está por llegar" fijo del 2.º día (courier:<id>:ENTREGA_HOY) sigue pendiente, se cancela: lo reemplaza este,
// que llega cuando el paquete realmente sale a reparto. Si ese salió hace < 24 h, no se repite el mismo texto.
// Interruptor: config 'aviso_ruta_pap' {"activo": true|false}.
import { db } from "../_shared/db.ts";

export const PLANTILLA_RUTA = "voltra_entrega_proxima";
export const claveRuta = (orderId: number) => `courier:${orderId}:EN_RUTA`;
const TERMINALES = ["ENTREGADO", "NO_ENTREGADO", "CANCELADO", "RENDIDO", "DEVUELTO"];

export interface CandidatoRuta {
  shopifyOrderId: number; clienteId: string | null; nombre: string | null; total: number | null;
  estadoConfirmacion: string | null; estadoEnvio: string | null; tags: string[]; cancelado: boolean;
  envios: Array<{ clave: string; plantilla: string; estado: string; creadoEn: string }>;
}
export type DecisionRuta =
  | { accion: "omitir"; motivo: string }
  | { accion: "registrar_sin_enviar"; motivo: string }
  | { accion: "enviar"; cancelarProxima: boolean };

export function decidirRuta(c: CandidatoRuta, ahora: Date): DecisionRuta {
  if (c.envios.some((e) => e.clave === claveRuta(c.shopifyOrderId))) return { accion: "omitir", motivo: "ya_avisado" };
  if (c.cancelado || (c.estadoConfirmacion ?? "").startsWith("cancelado")) return { accion: "omitir", motivo: "cancelado" };
  if (c.estadoConfirmacion !== "confirmado") return { accion: "omitir", motivo: "sin_confirmar" };
  if (TERMINALES.includes(c.estadoEnvio ?? "")) return { accion: "omitir", motivo: "terminal" };
  if (c.tags.some((t) => /RETIRO_EN_CASA/i.test(t))) return { accion: "omitir", motivo: "retiro" };
  if (!c.clienteId) return { accion: "omitir", motivo: "sin_cliente" };
  const prox = c.envios.find((e) => e.clave === `courier:${c.shopifyOrderId}:ENTREGA_HOY` && e.plantilla === PLANTILLA_RUTA);
  if (prox?.estado === "enviado" && ahora.getTime() - Date.parse(prox.creadoEn) < 24 * 3_600_000) {
    return { accion: "registrar_sin_enviar", motivo: "mismo_aviso_hace_menos_de_24h" };
  }
  return { accion: "enviar", cancelarProxima: prox?.estado === "pendiente" };
}

type Obj = Record<string, unknown>;
const primerNombre = (s: unknown) => {
  const n = String(s ?? "").trim().split(/\s+/)[0] ?? "";
  return n ? n.charAt(0).toUpperCase() + n.slice(1).toLowerCase() : null;
};

export async function avisoRutaPap(ahora = new Date(), simular = false) {
  const s = db();
  const { data: cfg } = await s.from("config").select("valor").eq("clave", "aviso_ruta_pap").maybeSingle();
  let activo = false;
  try { activo = JSON.parse(String(cfg?.valor ?? "{}")).activo === true; } catch { /* config inválida = apagado */ }
  if (!activo) return { activo: false, hechos: [] };
  const { data: ent, error } = await s.from("entregas").select("n_referencia").eq("transportadora", "pap").eq("tienda", "voltra").ilike("estado_pap", "%asignado a ruta%");
  if (error) throw new Error(`entregas: ${error.message}`);
  const nombres = (ent ?? []).map((e: Obj) => `#${String(e.n_referencia).replace(/^VT-/, "")}`);
  if (!nombres.length) return { activo: true, hechos: [] };
  const { data: peds, error: e2 } = await s.from("shopify_pedidos")
    .select("shopify_order_id,nombre,cliente_id,total,estado_confirmacion,estado_envio,tags,raw->>cancelled_at,raw->shipping_address->>name").in("nombre", nombres);
  if (e2) throw new Error(`shopify_pedidos: ${e2.message}`);
  const ids = (peds ?? []).map((p: Obj) => Number(p.shopify_order_id));
  const { data: envs } = await s.from("envios_programados").select("shopify_order_id,clave_unica,plantilla,estado,creado_en").in("shopify_order_id", ids);
  const hechos: Array<{ pedido: string; resultado: string }> = [];
  for (const p of (peds ?? []) as Obj[]) {
    const id = Number(p.shopify_order_id);
    const c: CandidatoRuta = {
      shopifyOrderId: id, clienteId: (p.cliente_id as string) ?? null, nombre: primerNombre(p.name), total: Number(p.total) || null,
      estadoConfirmacion: (p.estado_confirmacion as string) ?? null, estadoEnvio: (p.estado_envio as string) ?? null,
      tags: (p.tags ?? []) as string[], cancelado: !!p.cancelled_at,
      envios: ((envs ?? []) as Obj[]).filter((e) => Number(e.shopify_order_id) === id)
        .map((e) => ({ clave: String(e.clave_unica), plantilla: String(e.plantilla), estado: String(e.estado), creadoEn: String(e.creado_en) })),
    };
    const d = decidirRuta(c, ahora);
    if (d.accion === "omitir") continue;
    hechos.push({ pedido: String(p.nombre), resultado: d.accion === "enviar" ? (d.cancelarProxima ? "enviar (reemplaza el del 2.º día)" : "enviar") : d.motivo });
    if (simular) continue;
    const fila = {
      cliente_id: c.clienteId, shopify_order_id: id, plantilla: PLANTILLA_RUTA, categoria: "utilidad",
      variables: { nombre: c.nombre, total: (c.total ?? 0).toLocaleString("es-PY") },
      enviar_desde: ahora.toISOString(), clave_unica: claveRuta(id),
      estado: d.accion === "enviar" ? "pendiente" : "cancelado",
      ...(d.accion === "registrar_sin_enviar" ? { ultimo_error: d.motivo } : {}),
    };
    const { error: e3 } = await s.from("envios_programados").upsert(fila, { onConflict: "clave_unica", ignoreDuplicates: true });
    if (e3) { hechos[hechos.length - 1].resultado = `error: ${e3.message}`; continue; }
    if (d.accion === "enviar" && d.cancelarProxima) {
      await s.from("envios_programados").update({ estado: "cancelado", ultimo_error: "reemplazado por el aviso de ruta (EN_RUTA)" })
        .eq("clave_unica", `courier:${id}:ENTREGA_HOY`).eq("estado", "pendiente");
    }
  }
  return { activo: true, hechos };
}
