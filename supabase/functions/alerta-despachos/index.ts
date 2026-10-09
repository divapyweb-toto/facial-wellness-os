// alerta-despachos · Edge Function de cron diario (8:00 Asunción; migración 20261009000001_origen_anuncio.sql).
// Solo service role. Avisa por Telegram UNA vez por día los pedidos de Voltra despachados hace más de 5 días
// sin estado final. La lógica está en logica.ts; el I/O en io.ts.
import { conServiceRole } from "../_shared/auth_servicio.ts";
import { depsReales } from "./io.ts";
import { ejecutarAlerta } from "./logica.ts";

Deno.serve(conServiceRole(async () => {
  try {
    const r = await ejecutarAlerta(depsReales);
    console.log("alerta-despachos", JSON.stringify(r));
    return Response.json({ ok: true, ...r });
  } catch (e) {
    const msg = e instanceof Error ? e.message : String(e);
    console.error("alerta-despachos:", msg);
    return Response.json({ ok: false, error: msg }, { status: 500 });
  }
}));
