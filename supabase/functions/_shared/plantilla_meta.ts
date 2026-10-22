// _shared/plantilla_meta.ts · estado y alta de plantillas de WhatsApp en Meta (22-10-2026).
// Usa WA_TOKEN y WA_WABA_ID del entorno de funciones (nunca archivos). El token va en el header, no en la URL.
import { GRAPH_VERSION } from "./meta_capi.ts";

export type Fetch = typeof fetch;
const env = (n: string) => {
  try {
    return Deno.env.get(n) ?? null;
  } catch {
    return null;
  }
};

/** Estado de una plantilla por nombre: APPROVED | PENDING | REJECTED | PAUSED | DISABLED… o null si no existe. */
export async function estadoPlantilla(nombre: string, f: Fetch = fetch): Promise<{ estado: string | null; error?: string }> {
  const token = env("WA_TOKEN"), waba = env("WA_WABA_ID");
  if (!token || !waba) return { estado: null, error: "faltan WA_TOKEN o WA_WABA_ID" };
  try {
    const r = await f(`https://graph.facebook.com/${GRAPH_VERSION}/${waba}/message_templates?name=${encodeURIComponent(nombre)}&fields=name,status,language`, {
      headers: { Authorization: `Bearer ${token}` }, signal: AbortSignal.timeout(15_000),
    });
    const j = await r.json().catch(() => ({})) as { data?: Array<{ name?: string; status?: string }>; error?: { message?: string } };
    if (!r.ok || j.error) return { estado: null, error: j.error?.message ?? `HTTP ${r.status}` };
    const t = (j.data ?? []).find((x) => x.name === nombre);
    return { estado: t?.status ?? null };
  } catch (e) {
    return { estado: null, error: e instanceof Error ? e.message : String(e) };
  }
}

/** Manda una plantilla a aprobación de Meta. Las claves que empiezan con "_" (notas) no se envían. */
export async function enviarPlantilla(def: Record<string, unknown>, f: Fetch = fetch): Promise<{ ok: boolean; respuesta?: unknown; error?: string }> {
  const token = env("WA_TOKEN"), waba = env("WA_WABA_ID");
  if (!token || !waba) return { ok: false, error: "faltan WA_TOKEN o WA_WABA_ID" };
  const cuerpo = Object.fromEntries(Object.entries(def).filter(([k]) => !k.startsWith("_")));
  try {
    const r = await f(`https://graph.facebook.com/${GRAPH_VERSION}/${waba}/message_templates`, {
      method: "POST", headers: { "Content-Type": "application/json", Authorization: `Bearer ${token}` },
      body: JSON.stringify(cuerpo), signal: AbortSignal.timeout(20_000),
    });
    const j = await r.json().catch(() => ({})) as { id?: string; status?: string; error?: { message?: string; error_user_msg?: string } };
    if (!r.ok || j.error) return { ok: false, error: j.error?.error_user_msg ?? j.error?.message ?? `HTTP ${r.status}` };
    return { ok: true, respuesta: { id: j.id, status: j.status } };
  } catch (e) {
    return { ok: false, error: e instanceof Error ? e.message : String(e) };
  }
}
