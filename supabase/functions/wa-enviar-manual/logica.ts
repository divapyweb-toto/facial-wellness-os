// wa-enviar-manual · lógica pura (sin red ni base: todo el I/O entra por `Deps`).
// La llama la bandeja de Voltra OS (src/pages/bandeja/api.js → enviarMensajeManual).
// POST { conversacion_id, texto } con el JWT del usuario logueado.
// Solo manda si la ventana de 24 h está abierta (fuera de ella Meta solo acepta plantillas).
// El filtro de palabras prohibidas y el registro en wa_mensajes los hace enviarTexto (_shared/wa.ts).

export type ResultadoEnvio = { ok: boolean; wa_message_id?: string; error?: string };

export interface ConversacionManual {
  id: string;
  cliente_id: string;
  estado: string;
  ultima_entrada_en: string | null;
  telefono: string | null;
  wa_user_id: string | null;
}

export interface Deps {
  ahora(): Date;
  /** Usuario de Supabase Auth dueño del JWT, o null si el token no sirve. */
  usuario(token: string): Promise<{ id: string } | null>;
  buscarConversacion(id: string): Promise<ConversacionManual | null>;
  tomarConversacion(id: string): Promise<void>;
  enviarTexto(to: string, texto: string, op: { clienteId: string; conversacionId: string }): Promise<ResultadoEnvio>;
}

export type Respuesta = { status: number; body: ResultadoEnvio };

const VENTANA_MS = 24 * 3_600_000;
const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

export function ventanaAbierta(ultimaEntrada: string | null, ahora: Date): boolean {
  if (!ultimaEntrada) return false;
  const t = new Date(ultimaEntrada).getTime();
  return Number.isFinite(t) && ahora.getTime() - t < VENTANA_MS;
}

export function tokenDeHeader(h: string | null): string {
  return (h ?? "").replace(/^Bearer\s+/i, "").trim();
}

export function validarCuerpo(x: unknown): { ok: true; conversacionId: string; texto: string } | { ok: false; error: string } {
  const b = (x && typeof x === "object" ? x : {}) as Record<string, unknown>;
  const conversacionId = typeof b.conversacion_id === "string" ? b.conversacion_id.trim() : "";
  const texto = typeof b.texto === "string" ? b.texto.trim() : "";
  if (!UUID.test(conversacionId)) return { ok: false, error: "conversacion_id inválido" };
  if (!texto) return { ok: false, error: "El mensaje está vacío" };
  if (texto.length > 4096) return { ok: false, error: "El mensaje supera 4096 caracteres" };
  return { ok: true, conversacionId, texto };
}

export async function enviarManual(token: string, cuerpo: unknown, d: Deps): Promise<Respuesta> {
  if (!token) return { status: 401, body: { ok: false, error: "Falta iniciar sesión en Voltra OS" } };
  const u = await d.usuario(token);
  if (!u) return { status: 401, body: { ok: false, error: "Sesión vencida: volvé a entrar a Voltra OS" } };

  const v = validarCuerpo(cuerpo);
  if (!v.ok) return { status: 400, body: { ok: false, error: v.error } };

  const conv = await d.buscarConversacion(v.conversacionId);
  if (!conv) return { status: 404, body: { ok: false, error: "La conversación no existe" } };
  if (!ventanaAbierta(conv.ultima_entrada_en, d.ahora())) {
    return {
      status: 200,
      body: { ok: false, error: "La ventana de 24 h está cerrada: WhatsApp solo deja mandar plantillas aprobadas." },
    };
  }
  const destino = conv.telefono ?? conv.wa_user_id;
  if (!destino) return { status: 200, body: { ok: false, error: "El cliente no tiene teléfono ni usuario de WhatsApp" } };

  // Enrique toma el chat antes de mandar, así la IA (fase 2) no contesta encima.
  await d.tomarConversacion(conv.id);
  const r = await d.enviarTexto(destino, v.texto, { clienteId: conv.cliente_id, conversacionId: conv.id });
  return { status: 200, body: r.ok ? { ok: true, wa_message_id: r.wa_message_id } : { ok: false, error: r.error } };
}
