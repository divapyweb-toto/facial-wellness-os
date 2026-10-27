// avisos-resumen · Edge Function (solo service role). 27-10-2026.
// Cron 09:00 y 15:00 PY (12:00 y 18:00 UTC, migración 20261027000001): manda JUNTOS los avisos de Enrique que la
// política (config.telegram_politica.resumen) dejó en avisos_admin con destino 'resumen'. Sin avisos, no manda nada.
// Body {prueba:true}: devuelve el texto sin mandar ni marcar.
import { conServiceRole } from "../_shared/auth_servicio.ts";
import { db } from "../_shared/db.ts";
import { avisar } from "../_shared/telegram.ts";
import { TITULOS_AVISO } from "../_shared/telegram_tipos.ts";
import { armarResumenAvisos, type FilaResumen } from "./logica.ts";

Deno.serve(conServiceRole(async (req: Request) => {
  try {
    const b = await req.json().catch(() => ({})) as { prueba?: boolean };
    const { data, error } = await db().from("avisos_admin").select("id, tipo, texto, pedido, creado_en")
      .eq("destino", "resumen").is("enviado_en", null).order("creado_en").limit(300);
    if (error) throw new Error(error.message);
    const mensajes = armarResumenAvisos((data ?? []) as FilaResumen[], TITULOS_AVISO, new Date());
    if (b.prueba === true) return Response.json({ ok: true, prueba: true, mensajes: mensajes.map((m) => m.texto) });
    let enviados = 0;
    const errores: string[] = [];
    for (const m of mensajes) {
      const r = await avisar(m.texto, undefined, { tipo: "resumen_avisos", destino: "enrique" });
      if (!r.ok) { errores.push(r.error ?? "error"); continue; }
      enviados++;
      const { error: e2 } = await db().from("avisos_admin").update({ enviado_en: new Date().toISOString() }).in("id", m.ids);
      if (e2) errores.push(`marcar: ${e2.message}`);
    }
    console.log("avisos-resumen", JSON.stringify({ pendientes: data?.length ?? 0, mensajes: mensajes.length, enviados, errores }));
    return Response.json({ ok: errores.length === 0, pendientes: data?.length ?? 0, mensajes: mensajes.length, enviados, errores });
  } catch (e) {
    const msg = e instanceof Error ? e.message : String(e);
    console.error("avisos-resumen:", msg);
    return Response.json({ ok: false, error: msg }, { status: 500 });
  }
}));
