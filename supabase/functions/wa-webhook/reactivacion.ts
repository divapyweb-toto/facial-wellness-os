// wa-webhook · reactivación de un pedido cancelado sin pedido nuevo (21-10-2026, Enrique). Reglas en
// _shared/reactivaciones.ts. Corre antes de los botones de confirmación y del vendedor: si el cliente tiene una
// reactivación vigente (config_wa.reactivaciones) y todavía no decidió, un "sí" (escrito, el Confirmo de un resumen o
// el Confirmo de la confirmación vieja) reactiva ESE pedido y un "no" lo deja para pedidos-trabados. Cualquier otra
// cosa va al vendedor con una marca para que no arme un pedido nuevo. Si algo falla, el mensaje sigue su camino normal.
import type { Deps } from "./procesar.ts";
import {
  idDecisionReactivacion,
  leerReactivaciones,
  marcaVendedorReactivacion,
  type Reactivacion,
  reactivacionVigente,
  respuestaReactivacion,
  telegramSi,
  textoClienteNo,
  textoClienteSi,
} from "../_shared/reactivaciones.ts";

export type ResultadoReactivacion = { manejado: true } | { manejado: false; marca?: string };

const gid = (id: string) => `gid://shopify/Order/${id}`;

/**
 * `texto`: lo que le llegaría al vendedor ("[botón] Confirmo (…)" incluido). `botonConfirmacion`: el botón de la
 * plantilla de confirmación ({accion, orderId}) si es eso lo que tocó.
 */
export async function atenderReactivacion(
  deps: Deps,
  d: { clienteId: string; conversacionId: string; destino: string; texto: string; botonConfirmacion?: { accion: string; orderId: string } | null },
): Promise<ResultadoReactivacion> {
  if (!deps.eventoCrudoExiste) return { manejado: false };
  const r = reactivacionVigente(leerReactivaciones(await deps.config("reactivaciones")), d.clienteId, deps.ahora());
  if (!r) return { manejado: false };
  if (await deps.eventoCrudoExiste(idDecisionReactivacion(r.shopify_order_id))) return { manejado: false }; // ya decidió
  let resp = respuestaReactivacion(d.texto);
  if (d.botonConfirmacion) {
    if (String(d.botonConfirmacion.orderId) !== r.shopify_order_id) return { manejado: false };
    resp = d.botonConfirmacion.accion === "conf_si" ? "si" : d.botonConfirmacion.accion === "conf_cancelar" ? "no" : null;
    if (!resp) return { manejado: false };
  }
  // El texto (motivo, duda) queda en wa_mensajes; la decisión guarda lo que dijo al decidir (mejora del 28-10).
  if (!resp) return { manejado: false, marca: marcaVendedorReactivacion(r) };
  // Una sola decisión por pedido (insert único): si dos mensajes llegan juntos, gana el primero.
  if (!(await deps.guardarEventoCrudo(idDecisionReactivacion(r.shopify_order_id), { resultado: resp, cliente_id: r.cliente_id, en: deps.ahora().toISOString(), texto: d.texto.slice(0, 300) }))) {
    return { manejado: false };
  }
  const opts = { clienteId: d.clienteId, conversacionId: d.conversacionId };
  if (resp === "no") {
    await deps.enviarTexto(d.destino, textoClienteNo(r), opts);
    return { manejado: true }; // el cierre (Telegram o cancelar en Shopify) lo hace seguimiento-chat
  }
  await reactivar(deps, r);
  await deps.enviarTexto(d.destino, textoClienteSi(r), opts);
  await deps.avisar(telegramSi(r)).catch((e) => console.error("reactivación: Telegram:", e));
  return { manejado: true };
}

/** El mismo pedido vuelve a confirmado (Voltra OS y Shopify). Nunca crea un pedido. */
async function reactivar(deps: Deps, r: Reactivacion): Promise<void> {
  const p = await deps.buscarPedido(r.shopify_order_id);
  const tags = [...new Set([...(p?.tags ?? []).filter((t) => t.toUpperCase() !== "CANCELADO_CLIENTE"), "CONFIRMADO", "REACTIVADO"])];
  await deps.actualizarPedido(r.shopify_order_id, { estado_confirmacion: "confirmado", tags });
  // En Shopify: el anulado (en_courier) acepta etiquetas; Despacho igual lo ve cancelado por cancelled_at, así no se duplica.
  await deps.quitarTags(gid(r.shopify_order_id), ["CANCELADO_CLIENTE"]).catch((e) => console.error("reactivación: quitar tag:", e));
  await deps.agregarTags(gid(r.shopify_order_id), ["CONFIRMADO", "REACTIVADO"]).catch((e) => console.error("reactivación: agregar tags:", e));
}
