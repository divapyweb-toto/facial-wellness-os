// shopify-webhook · evento temprano a Meta para pedidos que nacen de un chat de anuncio (08-10-2026).
// Pedido nuevo (no borrador, no cancelado, no PRUEBA_E2E) cuyo cliente tiene un mensaje entrante con ctwa_clid
// en los 7 días anteriores → UN "LeadSubmitted" al dataset de mensajería (_shared/meta_capi.ts).
// Meta no deduplica los eventos de Business Messaging: el candado es una fila en eventos_crudos
// (fuente 'shopify', id_externo 'meta_lead:<order_id>'), el mismo patrón que usan Telegram y mejora-mensual.
// Si el envío falla, el candado queda con el error (no se reintenta: es una señal extra, no la venta).
// Todo el I/O entra por DepsLeadMeta (io.ts en producción) para poder probarlo sin red.
import { dentroDePlazo, type ConfigLead, type EntradaLead, type ResultadoEnvio } from "../_shared/meta_capi.ts";

export const VENTANA_CTWA_DIAS = 7;
export const idCandadoLead = (orderId: number | string) => `meta_lead:${orderId}`;

export type PedidoLead = {
  shopifyOrderId: number;
  clienteId: string;
  total: number | null;
  creadoEn: string | null;
};

export interface DepsLeadMeta {
  /** null = faltan variables o modo simulado → no se hace nada. */
  config(): ConfigLead | null;
  /** ctwa_clid del último mensaje entrante del cliente que vino de un anuncio, entre desde y hasta. */
  origenAnuncio(clienteId: string, desdeISO: string, hastaISO: string): Promise<{ ctwa_clid: string } | null>;
  /** Inserta el candado; false si ya existía (ya se mandó o se está mandando). */
  reservar(idExterno: string, payload: unknown): Promise<boolean>;
  /** Guarda el resultado en el candado (procesado_en + error). */
  registrar(idExterno: string, error: string | null): Promise<void>;
  enviar(e: EntradaLead, cfg: ConfigLead): Promise<ResultadoEnvio>;
  ahora(): Date;
}

export type ResultadoLead =
  | { accion: "enviado" }
  | { accion: "omitido"; motivo: string }
  | { accion: "error"; motivo: string };

export async function notificarLeadMeta(p: PedidoLead, d: DepsLeadMeta): Promise<ResultadoLead> {
  const cfg = d.config();
  if (!cfg) return { accion: "omitido", motivo: "sin_config" };
  const ahora = d.ahora();
  const creado = p.creadoEn && Number.isFinite(Date.parse(p.creadoEn)) ? new Date(p.creadoEn) : ahora;
  if (!dentroDePlazo(creado.toISOString(), ahora)) return { accion: "omitido", motivo: "fuera_de_plazo_7_dias" };
  const hasta = new Date(Math.min(creado.getTime(), ahora.getTime()) + 60_000).toISOString();
  const desde = new Date(creado.getTime() - VENTANA_CTWA_DIAS * 24 * 3_600_000).toISOString();
  const origen = await d.origenAnuncio(p.clienteId, desde, hasta);
  if (!origen?.ctwa_clid?.trim()) return { accion: "omitido", motivo: "sin_ctwa_clid" };

  const id = idCandadoLead(p.shopifyOrderId);
  const entrada: EntradaLead = {
    shopify_order_id: p.shopifyOrderId,
    creado_en: creado.toISOString(),
    valor: Number(p.total ?? 0),
    moneda: "PYG",
    ctwa_clid: origen.ctwa_clid,
  };
  // Sin el ctwa_clid en el registro (es un identificador de Meta; con el order id alcanza para rastrearlo).
  const nuevo = await d.reservar(id, { tipo: "meta_lead", evento: "LeadSubmitted", shopify_order_id: p.shopifyOrderId, valor: entrada.valor });
  if (!nuevo) return { accion: "omitido", motivo: "ya_enviado" };

  const r = await d.enviar(entrada, cfg);
  const error = r.ok ? null : (r.error ?? "error desconocido");
  await d.registrar(id, error).catch((e) => console.warn("meta_lead registrar:", e instanceof Error ? e.message : e));
  return error ? { accion: "error", motivo: error } : { accion: "enviado" };
}
