// _shared/vendedor/enviar_wa.ts · Dueño: G1 (ola 2)
// Multimedia saliente (imagen / video por enlace), que ni _shared/wa.ts (B) ni _shared/wa_interactivos.ts (G2)
// exponen. Mismas reglas: filtro de palabras prohibidas sobre el texto visible (falla cerrado si no hay
// lista) y registro en wa_mensajes (dirección 'out'), también de lo bloqueado o fallido.
// Los interactivos salen con enviarInteractivo de _shared/wa_interactivos.ts (G2).
import { contienePalabraProhibida } from "../filtro.ts";
import { db } from "../db.ts";
import { destinatario, GRAPH_URL, type OpcionesEnvio, type ResultadoEnvio } from "../wa.ts";

async function palabrasProhibidas(): Promise<string[] | null> {
  const { data, error } = await db().from("config_wa").select("valor").eq("clave", "palabras_prohibidas").maybeSingle();
  if (error) return null;
  const v = data?.valor as unknown;
  return Array.isArray(v) ? v.filter((x) => typeof x === "string") : null;
}

/** Imagen o video por enlace público (por ejemplo, el CDN de Shopify). */
export async function enviarMedia(
  to: string,
  tipo: "image" | "video",
  link: string,
  caption: string | null,
  opciones?: OpcionesEnvio,
): Promise<ResultadoEnvio> {
  const dest = destinatario(to);
  const media: Record<string, unknown> = { link };
  if (caption) media.caption = caption;
  const payload = { messaging_product: "whatsapp", recipient_type: "individual", ...dest, type: tipo, [tipo]: media };
  let bloqueo: string | null = "error" in dest ? dest.error : null;
  if (!bloqueo && caption) {
    const lista = await palabrasProhibidas();
    if (!lista) bloqueo = "config_palabras_prohibidas_no_disponible";
    else {
      const p = contienePalabraProhibida(caption, lista);
      if (p) bloqueo = `palabra_prohibida:${p}`;
    }
  }
  let r: ResultadoEnvio & { raw?: unknown } = { ok: false, error: bloqueo ?? undefined };
  if (!bloqueo) {
    const token = Deno.env.get("WA_TOKEN");
    const phoneId = Deno.env.get("WA_PHONE_NUMBER_ID");
    if (!token || !phoneId) r = { ok: false, error: "faltan_WA_TOKEN_o_WA_PHONE_NUMBER_ID" };
    else {
      try {
        const resp = await fetch(`${GRAPH_URL}/${phoneId}/messages`, {
          method: "POST",
          headers: { Authorization: `Bearer ${token}`, "Content-Type": "application/json" },
          body: JSON.stringify(payload),
        });
        const j = await resp.json().catch(() => ({}));
        r = !resp.ok || j?.error
          ? { ok: false, error: `${j?.error?.code ?? resp.status}: ${j?.error?.message ?? "error_graph"}`, raw: j }
          : { ok: true, wa_message_id: j?.messages?.[0]?.id };
      } catch (e) {
        r = { ok: false, error: `red: ${e instanceof Error ? e.message : String(e)}` };
      }
    }
  }
  const { error } = await db().from("wa_mensajes").insert({
    conversacion_id: opciones?.conversacionId ?? null,
    cliente_id: opciones?.clienteId ?? null,
    direccion: "out",
    wa_message_id: r.wa_message_id ?? null,
    tipo,
    texto: caption ? `[${tipo}] ${caption}` : `[${tipo}]`,
    contenido: payload,
    estado: r.ok ? "enviado" : "fallido",
    error: r.ok ? null : { motivo: r.error, respuesta: r.raw ?? null },
  });
  if (error) console.error("wa_mensajes insert (media vendedor):", error.message);
  return r.ok ? { ok: true, wa_message_id: r.wa_message_id } : { ok: false, error: r.error };
}
