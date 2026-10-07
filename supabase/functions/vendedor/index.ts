// Edge Function vendedor · Dueño: G1 (ola 2).
// La llama wa-webhook (EdgeRuntime.waitUntil + fetch) con la service role por cada mensaje de una
// conversación en estado 'ia'. Responde 202 enseguida y procesa el turno en segundo plano.
// POST {conversacion_id, wa_message_id, texto} · solo service role (_shared/auth_servicio.ts).
import { conServiceRole } from "../_shared/auth_servicio.ts";
import { procesarTurno } from "../_shared/vendedor/orquestador.ts";
import { depsOrquestadorReales } from "../_shared/vendedor/io.ts";
import { validarEntrada } from "./validar.ts";

declare const EdgeRuntime: { waitUntil(p: Promise<unknown>): void } | undefined;

Deno.serve(conServiceRole(async (req) => {
  if (req.method !== "POST") return new Response("método no permitido", { status: 405 });
  const cuerpo = await req.json().catch(() => null);
  const v = validarEntrada(cuerpo);
  if (!v.ok) return Response.json({ ok: false, error: v.error }, { status: 400 });

  const tarea = procesarTurno(v.entrada, depsOrquestadorReales)
    .then((r) => console.log("vendedor:", JSON.stringify({ conversacion: v.entrada.conversacion_id, ...r })))
    .catch((e) => console.error("vendedor: turno falló:", e instanceof Error ? e.message : e));
  if (typeof EdgeRuntime !== "undefined" && EdgeRuntime?.waitUntil) EdgeRuntime.waitUntil(tarea);
  else await tarea;
  return Response.json({ ok: true, aceptado: true }, { status: 202 });
}));
