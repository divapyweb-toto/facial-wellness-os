// meta-lead-reenviar · prueba y reenvío del LeadSubmitted de pedidos que vinieron de un anuncio de WhatsApp (12-10-2026).
// Hasta el 12-10 los pedidos del vendedor IA no mandaban el evento (ver shopify-webhook/procesar.ts). Modos:
//   listar  (por defecto) → qué pedidos de los últimos 7 días tienen ctwa_clid y si ya se mandaron. No envía nada.
//   prueba  → manda UN evento con test_event_code (aparece en "Probar eventos"); sin candado: no consume el pedido.
//   enviar  → manda el LeadSubmitted de cada pedido pendiente con el mismo camino que shopify-webhook (candado incluido).
// `pedidos` (opcional) limita a esos nombres ("#1032"). Nada de teléfonos ni ctwa_clid en la respuesta.
// `evento`: LeadSubmitted (por defecto) o Purchase. Purchase (12-10, decisión de Enrique) = pedido CONFIRMADO (por
// WhatsApp o web) que vino de un anuncio: mismo ctwa_clid, valor del pedido en PYG, candado propio (meta_purchase:<id>),
// así no se repite ni se mezcla con el LeadSubmitted. El cron (body {origen:"pg_cron"}) corre `automatico`: manda los dos.
import { type ConfigLead, dentroDePlazo, EVENTO_LEAD, EVENTO_PURCHASE, type EventoMensajeria, type ResultadoEnvio } from "../_shared/meta_capi.ts";
import { type DepsLeadMeta, idCandado, notificarLeadMeta, type PedidoLead, VENTANA_CTWA_DIAS } from "../shopify-webhook/lead_meta.ts";

export type Modo = "listar" | "prueba" | "enviar";
export type Candidato = PedidoLead & { nombre: string; confirmado: boolean };

export interface DepsReenvio {
  lead: DepsLeadMeta;
  /** Pedidos no borrador ni PRUEBA_E2E creados desde `desdeISO`, con cliente. */
  candidatos(desdeISO: string): Promise<Candidato[]>;
  existeCandado(idExterno: string): Promise<boolean>;
}

export interface Fila {
  pedido: string;
  creado: string | null;
  estado: "enviado" | "ya_enviado" | "sin_ctwa_clid" | "fuera_de_plazo_7_dias" | "pendiente" | "error";
  detalle?: string;
}

export async function reenviar(
  modo: Modo,
  op: { testEventCode?: string | null; pedidos?: string[]; evento?: EventoMensajeria },
  d: DepsReenvio,
): Promise<{ modo: Modo; evento: EventoMensajeria; filas: Fila[]; prueba?: ResultadoEnvio & { pedido?: string } }> {
  const evento = op.evento ?? EVENTO_LEAD;
  const cfg = d.lead.config();
  if (!cfg) throw new Error("Falta META_CAPI_TOKEN, META_DATASET_MENSAJERIA_ID o WA_WABA_ID, o está MODO_SIMULADO=1.");
  if (modo === "prueba" && !op.testEventCode?.trim()) throw new Error("Modo prueba: falta test_event_code.");
  const ahora = d.lead.ahora();
  const desde = new Date(ahora.getTime() - 7 * 24 * 3_600_000).toISOString();
  let lista = await d.candidatos(desde);
  if (op.pedidos?.length) {
    // En el orden pedido (los que vencen antes, primero).
    lista = op.pedidos.map((n) => lista.find((c) => c.nombre === n)).filter((c): c is Candidato => !!c);
  }
  if (evento === EVENTO_PURCHASE) lista = lista.filter((c) => c.confirmado);

  const filas: Fila[] = [];
  for (const c of lista) {
    const creado = c.creadoEn && Number.isFinite(Date.parse(c.creadoEn)) ? new Date(c.creadoEn) : ahora;
    const fila: Fila = { pedido: c.nombre, creado: c.creadoEn, estado: "pendiente" };
    filas.push(fila);
    if (!dentroDePlazo(creado.toISOString(), ahora)) {
      fila.estado = "fuera_de_plazo_7_dias";
      continue;
    }
    const hasta = new Date(Math.min(creado.getTime(), ahora.getTime()) + 60_000).toISOString();
    const desdeCtwa = new Date(creado.getTime() - VENTANA_CTWA_DIAS * 24 * 3_600_000).toISOString();
    const origen = await d.lead.origenAnuncio(c.clienteId, desdeCtwa, hasta);
    if (!origen?.ctwa_clid?.trim()) {
      fila.estado = "sin_ctwa_clid";
      continue;
    }
    if (await d.existeCandado(idCandado(evento, c.shopifyOrderId))) {
      fila.estado = "ya_enviado";
      continue;
    }
    if (modo === "enviar") {
      const r = await notificarLeadMeta(c, d.lead, evento);
      fila.estado = r.accion === "enviado" ? "enviado" : r.accion === "error" ? "error" : (r.motivo as Fila["estado"]);
      if (r.accion === "error") fila.detalle = r.motivo;
    }
  }

  if (modo !== "prueba") return { modo, evento, filas };
  // Prueba: el primer pedido con ctwa_clid (pendiente o ya enviado), con test_event_code y sin candado.
  const elegido = filas.find((f) => f.estado === "pendiente" || f.estado === "ya_enviado");
  if (!elegido) return { modo, evento, filas, prueba: { ok: false, error: "Ningún pedido de los últimos 7 días tiene ctwa_clid." } };
  const c = lista.find((x) => x.nombre === elegido.pedido)!;
  const creado = c.creadoEn ? new Date(c.creadoEn) : ahora;
  const origen = await d.lead.origenAnuncio(c.clienteId, new Date(creado.getTime() - VENTANA_CTWA_DIAS * 24 * 3_600_000).toISOString(), new Date(Math.min(creado.getTime(), ahora.getTime()) + 60_000).toISOString());
  const cfgPrueba: ConfigLead = { ...cfg, testEventCode: op.testEventCode!.trim() };
  const r = await d.lead.enviar({ shopify_order_id: c.shopifyOrderId, creado_en: creado.toISOString(), valor: Number(c.total ?? 0), moneda: "PYG", ctwa_clid: origen!.ctwa_clid, evento }, cfgPrueba);
  return { modo, evento, filas, prueba: { ...r, pedido: c.nombre } };
}

/** Cron: manda lo pendiente de los dos eventos (LeadSubmitted de pedidos de anuncio y Purchase de los confirmados). */
export async function automatico(d: DepsReenvio) {
  const lead = await reenviar("enviar", { evento: EVENTO_LEAD }, d);
  const purchase = await reenviar("enviar", { evento: EVENTO_PURCHASE }, d);
  const enviados = (r: { filas: Fila[] }) => r.filas.filter((f) => f.estado === "enviado").map((f) => f.pedido);
  const errores = (r: { filas: Fila[] }) => r.filas.filter((f) => f.estado === "error").map((f) => `${f.pedido}: ${f.detalle}`);
  return { lead: { enviados: enviados(lead), errores: errores(lead) }, purchase: { enviados: enviados(purchase), errores: errores(purchase) } };
}
