// proveedores-gmail · Edge Function (solo service role). 21-11-2026. Charla con proveedores por el Gmail de Voltra.
// Reglas en logica.ts, Gmail en gmail.ts, base y agente en io.ts. Contrato: ~/Negocios/reportes/proveedores-automatico/CONTRATO.md.
// Cron cada 10 min (body {origen:"pg_cron"}, migración 20261124000002). Interruptor: config.proveedores.activo
// (apagado → no hace nada). A mano: {modo:"simular"} (por defecto) lee la bandeja y dice qué haría, sin escribir ni
// mandar; {modo:"aplicar"} corre de verdad (igual respeta el interruptor).
import { conServiceRole } from "../_shared/auth_servicio.ts";
import { depsReales, ioGmail } from "./io.ts";
import { procesarCorrida } from "./logica.ts";

Deno.serve(conServiceRole(async (req: Request) => {
  const b = await req.json().catch(() => ({})) as { origen?: string; modo?: string };
  const simular = b.origen !== "pg_cron" && b.modo !== "aplicar";
  try {
    const cfg = await ioGmail.config();
    if (!cfg.activo && !simular) return Response.json({ ok: true, activo: false });
    const deps = depsReales();
    if (!deps) {
      await ioGmail.avisarAdministracion("⚠️ Correo de proveedores: faltan los secretos GMAIL_* (correr scripts/gmail-autorizar.mjs).", { tipo: "proveedor_frena", clave: "gmail_secretos" }).catch(() => null);
      return Response.json({ ok: false, error: "faltan los secretos GMAIL_CLIENT_ID / GMAIL_CLIENT_SECRET / GMAIL_REFRESH_TOKEN" }, { status: 500 });
    }
    const r = await procesarCorrida(deps, { simular });
    console.log("proveedores-gmail", JSON.stringify({ ...r, hechos: r.hechos.length }));
    return Response.json({ ok: true, ...r });
  } catch (e) {
    const msg = e instanceof Error ? e.message : String(e);
    console.error("proveedores-gmail:", msg);
    // invalid_grant = el permiso de Google se revocó o venció: avisa una vez por día.
    if (!simular && /token de Gmail/.test(msg)) {
      await ioGmail.avisarAdministracion(`⚠️ Correo de proveedores: Google rechazó el permiso (${msg}). Volver a correr scripts/gmail-autorizar.mjs.`, { tipo: "proveedor_frena", clave: "gmail_token" }).catch(() => null);
    }
    return Response.json({ ok: false, error: msg }, { status: 500 });
  }
}));
