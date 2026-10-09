// sifen-inutilizacion · Edge Function (solo service role / cron diario 09:15 Asunción).
// Detecta números saltados o rechazados definitivos por serie (timbrado, establecimiento, punto, tipo) y manda
// el evento de inutilización antes del día 15 del mes siguiente; avisa por Telegram desde el día 10.
import { conServiceRole } from "../_shared/auth_servicio.ts";
import { ejecutarInutilizacion } from "./io.ts";

Deno.serve(conServiceRole(async () => {
  try {
    return Response.json({ ok: true, ...(await ejecutarInutilizacion()) });
  } catch (e) {
    console.error("sifen-inutilizacion:", e);
    return Response.json({ ok: false, error: e instanceof Error ? e.message : String(e) }, { status: 500 });
  }
}));
