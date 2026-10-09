// sifen-reenviar · lógica pura. Reenvía el KuDE de una factura APROBADA por WhatsApp (plantilla voltra_factura).
// La llama el panel de facturas (F) con el JWT del usuario: { factura_id: uuid }.
export interface FacturaReenvio {
  id: string;
  estado: string;
  kude_path: string | null;
  numero_completo: string | null;
  shopify_order_id: number | null;
}
export interface DepsReenviar {
  usuario(token: string): Promise<{ id: string } | null>;
  leerFactura(id: string): Promise<FacturaReenvio | null>;
  enviar(f: FacturaReenvio): Promise<{ ok: boolean; error?: string; wa_message_id?: string }>;
  marcarEnviado(id: string): Promise<void>;
}

const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

export async function reenviarKude(token: string, cuerpo: unknown, d: DepsReenviar): Promise<{ status: number; body: Record<string, unknown> }> {
  if (!token) return { status: 401, body: { ok: false, error: "Falta iniciar sesión" } };
  const u = await d.usuario(token);
  if (!u) return { status: 401, body: { ok: false, error: "Sesión inválida" } };
  const id = String((cuerpo as Record<string, unknown> | null)?.factura_id ?? "").trim();
  if (!UUID.test(id)) return { status: 400, body: { ok: false, error: "factura_id inválido" } };
  const f = await d.leerFactura(id);
  if (!f) return { status: 404, body: { ok: false, error: "No existe la factura" } };
  if (f.estado !== "aprobada") return { status: 409, body: { ok: false, error: `La factura está ${f.estado}: solo se reenvían aprobadas` } };
  if (!f.kude_path) return { status: 409, body: { ok: false, error: "La factura todavía no tiene KuDE (PDF)" } };
  const r = await d.enviar(f);
  if (!r.ok) return { status: 502, body: { ok: false, error: `WhatsApp: ${r.error ?? "falló"}` } };
  await d.marcarEnviado(f.id);
  return { status: 200, body: { ok: true, wa_message_id: r.wa_message_id ?? null } };
}
