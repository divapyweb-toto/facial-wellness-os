// lista-despacho · Edge Function (solo service role). 27-10-2026.
// Cron L-V 12:30 PY (15:30 UTC, migración 20261027000001): UN mensaje a Enrique con lo confirmado y despachable,
// agrupado por courier, con la nota de armado. Sin pedidos, no manda nada. Una vez por día (telegram_enviados).
// Interruptor: config.lista_despacho {"activo": true|false}. Body {prueba:true}: arma el texto con los pedidos reales y NO lo manda.
import { conServiceRole } from "../_shared/auth_servicio.ts";
import { db } from "../_shared/db.ts";
import { avisar } from "../_shared/telegram.ts";
import { textoLista } from "./logica.ts";
// 05-11: la carga vive en carga.ts (la usa también seguimiento-chat/pedidos_48h: mismo motivo que la lista).
import { cargarListaDespacho } from "./carga.ts";

async function activa(): Promise<boolean> {
  const { data } = await db().from("config").select("valor").eq("clave", "lista_despacho").maybeSingle();
  try { return JSON.parse(String(data?.valor ?? "{}"))?.activo === true; } catch { return false; }
}

Deno.serve(conServiceRole(async (req: Request) => {
  try {
    const b = await req.json().catch(() => ({})) as { prueba?: boolean };
    const prueba = b.prueba === true;
    if (!prueba && !(await activa())) return Response.json({ ok: true, omitido: "apagada" });
    const ahora = new Date();
    const { lista } = await cargarListaDespacho(ahora);
    const texto = textoLista(lista, ahora, prueba);
    const resumen = { despachar: [...lista.porCourier.values()].reduce((s, l) => s + l.length, 0), retiros: lista.retiros.length, no_despachar: lista.noDespachar.length, sin_confirmar: lista.sinConfirmar };
    if (prueba || !texto) return Response.json({ ok: true, prueba, enviado: false, ...resumen, texto });
    const hoy = new Date(ahora.getTime() - 3 * 3600_000).toISOString().slice(0, 10);
    const r = await avisar(texto, undefined, { tipo: "lista_despacho", destino: "enrique", unaVezPorDia: true, clave: hoy });
    console.log("lista-despacho", JSON.stringify({ hoy, ...resumen, ok: r.ok }));
    return Response.json({ ok: r.ok, enviado: r.ok, ...resumen, error: r.error, texto });
  } catch (e) {
    const msg = e instanceof Error ? e.message : String(e);
    console.error("lista-despacho:", msg);
    await avisar(`<b>Lista de despacho: falló</b>\n${msg.replace(/[<>&]/g, " ").slice(0, 400)}`, undefined, { tipo: "lista_despacho_error", destino: "enrique", unaVezPorDia: true, clave: "corrida" }).catch(() => {});
    return Response.json({ ok: false, error: msg }, { status: 500 });
  }
}));
