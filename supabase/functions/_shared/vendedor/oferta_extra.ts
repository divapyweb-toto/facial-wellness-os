// _shared/vendedor/oferta_extra.ts · 26-10 (Enrique): oferta extra DESPUÉS de la compra.
// Parches por ₲49.000 al que compra Raspador (y Botella al que compra JawFlex, apagada hasta el 06-11).
// Reglas: recién cuando el pedido principal ya quedó creado y confirmado, una sola vez, en un mensaje aparte (nunca en
// la confirmación ni antes). No se le ofrece a quien ya lleva el extra o un pack, ni sin stock (más de stock_min).
// "Sí" → la modificación ya armada se ejecuta por el camino de siempre (reemplazo, modificar_pedido) con la etiqueta de
// la oferta. "No" o no contesta → el pedido sigue igual y no se vuelve a ofrecer. Precio y textos: config_wa.vendedor.
// ofertas_extra (nunca los escribe la IA). Cada oferta tiene su `activo` (interruptor).
import { botonesSiNo } from "../wa_interactivos.ts";
import type { OfertaExtraCfg } from "./config.ts";
import { gs } from "./herramientas.ts";
import type { DatosModificacion, ModificacionPedido } from "./pedidos_web.ts";
import type { LineaPedido, PedidoChat, ProductoShopify } from "./tipos.ts";

export const PREFIJO_NO_EXTRA = "vend_extra_no:";
export const TEXTO_NO_EXTRA = "Dale, tu pedido queda como estaba 🙌";
export const TEXTO_EXTRA_VENCIDA = "Esa oferta ya venció, tu pedido sigue igual 🙌";
export const TEXTO_EXTRA_EN_PROCESO = "Dale, lo sumo y te confirmo por acá en un ratito 🙌";
export const TITULOS_EXTRA = { si: "Sí, quiero", no: "No, gracias" };

export type ExtraElegida = { clave: string; cfg: OfertaExtraCfg; producto: ProductoShopify; variante_id: string };

/** La primera oferta activa que corresponde a estas líneas, con stock suficiente del extra; null = ninguna. */
export function elegirOfertaExtra(
  lineas: Pick<LineaPedido, "handle">[],
  ofertas: Record<string, OfertaExtraCfg>,
  productos: ProductoShopify[],
): ExtraElegida | null {
  const handles = lineas.map((l) => l.handle.toLowerCase());
  for (const [clave, o] of Object.entries(ofertas)) {
    if (!o.activo) continue;
    if (!handles.some((h) => new RegExp(o.si_lleva).test(h))) continue;
    if (o.no_si_lleva && handles.some((h) => new RegExp(o.no_si_lleva).test(h))) continue;
    const prod = productos.find((p) => p.handle === o.extra);
    const v = prod?.variantes.find((x) => x.disponible);
    if (!prod || !v || typeof prod.stock !== "number" || prod.stock <= o.stock_min) continue;
    return { clave, cfg: o, producto: prod, variante_id: v.id };
  }
  return null;
}

export const textoOfertaExtra = (o: Pick<OfertaExtraCfg, "texto" | "precio">) => o.texto.replaceAll("{precio}", `₲${gs(o.precio)}`);

/** Modificación ya calculada: el pedido tal cual + 1 del extra al precio de la oferta, mismo envío. */
export function datosModificacionExtra(pc: PedidoChat, nombrePedido: string, e: ExtraElegida): DatosModificacion {
  const d = pc.datos;
  const extra: LineaPedido = { handle: e.producto.handle, titulo: e.producto.title, variante_id: e.variante_id, cantidad: 1, total: e.cfg.precio };
  return {
    pedido_nombre: nombrePedido,
    camino: "reemplazar",
    lineas_antes: d.lineas.map((l) => ({ titulo: l.titulo, cantidad: l.cantidad, total: l.total })),
    total_antes: d.total,
    lineas: [...d.lineas, extra],
    envio: d.envio,
    total: d.total + e.cfg.precio,
    oferta_extra: e.clave,
    tags_extra: [e.cfg.tag],
  };
}

/** Interactivo de la oferta: "Sí, quiero" ejecuta la modificación (vend_mod:<id>), "No, gracias" la descarta. */
export const interactivoOfertaExtra = (o: OfertaExtraCfg, modificacionId: string) =>
  botonesSiNo(textoOfertaExtra(o), `vend_mod:${modificacionId}`, `${PREFIJO_NO_EXTRA}${modificacionId}`, TITULOS_EXTRA);

/** Botón de la oferta en el texto que llega al vendedor ("[botón …] (vend_mod:<id>)"); null = no es un botón. */
export function botonOfertaExtra(texto: string): { tipo: "si" | "no"; id: string } | null {
  const no = /\(vend_extra_no:([^)\s]+)\)/.exec(texto);
  if (no) return { tipo: "no", id: no[1] };
  const si = /\(vend_mod:([^)\s]+)\)/.exec(texto);
  return si ? { tipo: "si", id: si[1] } : null;
}

/** ¿Esta modificación es una oferta extra? (los "Confirmo" de un cambio pedido por el cliente siguen por el modelo). */
export const esModificacionExtra = (m: ModificacionPedido | null): m is ModificacionPedido => !!m?.datos?.oferta_extra;

/** Texto para el cliente según lo que devolvió modificar_pedido (confirmar=true). */
export function textoTrasSi(r: { resultado: Record<string, unknown>; esError?: boolean }): string {
  if (typeof r.resultado.texto_respuesta === "string" && r.resultado.texto_respuesta.trim()) return r.resultado.texto_respuesta.trim();
  const err = String(r.resultado.error ?? "");
  if (/resumen_vencido|resumen_en_estado/.test(err)) return TEXTO_EXTRA_VENCIDA;
  return TEXTO_EXTRA_EN_PROCESO; // falló el reemplazo: modificar_pedido ya le avisó a Enrique por Telegram
}
