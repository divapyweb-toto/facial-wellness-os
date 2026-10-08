// Edge Function wa-enviar-manual · integración ola 1.
// La bandeja (src/pages/bandeja/api.js) la llama con supabase.functions.invoke y el JWT del usuario.
// verify_jwt queda activo (default) y además se valida el usuario con db().auth.getUser.
// La lógica está en logica.ts; acá solo el I/O.
import { db } from "../_shared/db.ts";
import { enviarTexto } from "../_shared/wa.ts";
import { type ConversacionManual, type Deps, enviarManual, tokenDeHeader } from "./logica.ts";

const CORS = {
  "Access-Control-Allow-Origin": "*",
  "Access-Control-Allow-Headers": "authorization, x-client-info, apikey, content-type",
  "Access-Control-Allow-Methods": "POST, OPTIONS",
};

const json = (body: unknown, status = 200) =>
  new Response(JSON.stringify(body), { status, headers: { ...CORS, "Content-Type": "application/json" } });

const deps: Deps = {
  ahora: () => new Date(),
  async usuario(token) {
    const { data, error } = await db().auth.getUser(token);
    return error || !data?.user ? null : { id: data.user.id };
  },
  async buscarConversacion(id) {
    const { data, error } = await db().from("wa_conversaciones")
      .select("id,cliente_id,estado,ultima_entrada_en,wa_clientes(telefono,wa_user_id)").eq("id", id).maybeSingle();
    if (error) throw new Error(`buscar conversación: ${error.message}`);
    if (!data) return null;
    const c = (Array.isArray(data.wa_clientes) ? data.wa_clientes[0] : data.wa_clientes) as
      | { telefono: string | null; wa_user_id: string | null }
      | null;
    return {
      id: data.id,
      cliente_id: data.cliente_id,
      estado: data.estado,
      ultima_entrada_en: data.ultima_entrada_en,
      telefono: c?.telefono ?? null,
      wa_user_id: c?.wa_user_id ?? null,
    } as ConversacionManual;
  },
  async tomarConversacion(id) {
    const { error } = await db().from("wa_conversaciones").update({ estado: "humano", asignado_a: "enrique" }).eq("id", id);
    if (error) throw new Error(`tomar conversación: ${error.message}`);
  },
  // origen 'manual': wa-webhook no le devuelve a la IA un chat que Enrique atendió hace poco.
  enviarTexto: (to, texto, op) => enviarTexto(to, texto, { ...op, origen: "manual" }),
};

Deno.serve(async (req) => {
  if (req.method === "OPTIONS") return new Response("ok", { headers: CORS });
  if (req.method !== "POST") return json({ ok: false, error: "Usá POST" }, 405);
  let cuerpo: unknown;
  try {
    cuerpo = await req.json();
  } catch {
    return json({ ok: false, error: "El cuerpo no es JSON" }, 400);
  }
  try {
    const r = await enviarManual(tokenDeHeader(req.headers.get("Authorization")), cuerpo, deps);
    return json(r.body, r.status);
  } catch (e) {
    console.error("wa-enviar-manual:", e);
    return json({ ok: false, error: `No se pudo enviar: ${e instanceof Error ? e.message : String(e)}` }, 500);
  }
});
