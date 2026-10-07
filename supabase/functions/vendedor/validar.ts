// Validación pura del cuerpo que manda wa-webhook a la función vendedor.
import type { EntradaTurno } from "../_shared/vendedor/orquestador.ts";

const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

export function validarEntrada(x: unknown): { ok: true; entrada: EntradaTurno } | { ok: false; error: string } {
  const o = (x && typeof x === "object" ? x : {}) as Record<string, unknown>;
  if (typeof o.conversacion_id !== "string" || !UUID.test(o.conversacion_id)) return { ok: false, error: "conversacion_id inválido" };
  if (typeof o.wa_message_id !== "string" || !o.wa_message_id.trim()) return { ok: false, error: "falta wa_message_id" };
  if (typeof o.texto !== "string" || !o.texto.trim()) return { ok: false, error: "falta texto" };
  return { ok: true, entrada: { conversacion_id: o.conversacion_id, wa_message_id: o.wa_message_id.trim(), texto: o.texto.trim().slice(0, 4000) } };
}
