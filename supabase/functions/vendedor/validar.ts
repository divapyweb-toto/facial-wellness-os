// Validación pura del cuerpo que manda wa-webhook a la función vendedor.
import type { EntradaTurno } from "../_shared/vendedor/orquestador.ts";
import { esImagenVisible, mimeBase } from "../_shared/vendedor/imagenes.ts";

/** Rutas que escribe wa-webhook: media/<cliente>/<wamid>.<ext>. */
const RUTA_MEDIA = /^media\/[A-Za-z0-9-]{1,64}\/[A-Za-z0-9._=+-]{1,200}$/;
const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

export function validarEntrada(x: unknown): { ok: true; entrada: EntradaTurno } | { ok: false; error: string } {
  const o = (x && typeof x === "object" ? x : {}) as Record<string, unknown>;
  if (typeof o.conversacion_id !== "string" || !UUID.test(o.conversacion_id)) return { ok: false, error: "conversacion_id inválido" };
  if (typeof o.wa_message_id !== "string" || !o.wa_message_id.trim()) return { ok: false, error: "falta wa_message_id" };
  if (typeof o.texto !== "string" || !o.texto.trim()) return { ok: false, error: "falta texto" };
  const entrada: EntradaTurno = { conversacion_id: o.conversacion_id, wa_message_id: o.wa_message_id.trim(), texto: o.texto.trim().slice(0, 4000) };
  // 09-10: turno iniciado por el sistema (pedir datos o confirmación de un pedido): sin agrupar ni marcar leído.
  if (o.origen === "seguimiento") entrada.origen = "seguimiento";
  // 08-10: foto del cliente en Storage wa-media (opcional). Si viene rara se ignora: el turno sigue con el texto.
  const img = (o.imagen && typeof o.imagen === "object" ? o.imagen : null) as Record<string, unknown> | null;
  if (img && typeof img.ruta === "string" && RUTA_MEDIA.test(img.ruta) && !img.ruta.includes("..") && typeof img.mime === "string" && esImagenVisible(img.mime)) {
    entrada.imagen = { ruta: img.ruta, mime: mimeBase(img.mime) };
  }
  return { ok: true, entrada };
}
