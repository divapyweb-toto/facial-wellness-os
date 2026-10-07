// recuperar-borradores · Edge Function de cron (cada hora, 40 min). Solo service role.
// Con la bandera ola4.recuperacion apagada responde {accion:"bandera_apagada"} y no hace nada.
import { conServiceRole } from "../_shared/auth_servicio.ts";
import { depsReales } from "./io.ts";
import { recuperarBorradores } from "./logica.ts";

Deno.serve(conServiceRole(async () => {
  try {
    const r = await recuperarBorradores(depsReales);
    console.log("recuperar-borradores", JSON.stringify(r));
    return Response.json({ ok: true, ...r });
  } catch (e) {
    console.error("recuperar-borradores:", e);
    return Response.json({ ok: false, error: e instanceof Error ? e.message : String(e) }, { status: 500 });
  }
}));
