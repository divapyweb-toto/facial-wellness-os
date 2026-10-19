// resumen-diario · Edge Function (solo service role). 16-10-2026.
// Cron 21:30 Paraguay (00:30 UTC, migración 20261016000001): 1 mensaje por Telegram a Enrique con cómo fue el día.
// Solo LEE datos del negocio; no toca pedidos, stock ni Meta. Body {prueba:true}: manda 1 mensaje marcado PRUEBA.
// Reintenta el envío 2 veces y deja el resultado en eventos_crudos ('telegram', 'resumen_diario:<día>').
import { conServiceRole } from "../_shared/auth_servicio.ts";
import { avisar } from "../_shared/telegram.ts";
import { cansados, chatsAnuncio, chatsBotV33, entregaGrupos, luceroEnGestion, papCustodia, guardarCandado, leerCandado, leerMeta, leerPedidos, stock } from "./io.ts";
import { armarResumen, diaParaguay } from "./logica.ts";

Deno.serve(conServiceRole(async (req: Request) => {
  try {
    const b = await req.json().catch(() => ({})) as { prueba?: boolean };
    const prueba = b.prueba === true;
    const ahora = new Date();
    const hoy = diaParaguay(ahora);
    const idEnvio = prueba ? `resumen_diario_prueba:${ahora.toISOString()}` : `resumen_diario:${hoy}`;
    if (!prueba) {
      const previo = await leerCandado(idEnvio);
      if (previo && !previo.error) return Response.json({ ok: true, omitido: "ya_enviado_hoy" });
    }
    const inicioDia = new Date(`${hoy}T03:00:00Z`).toISOString(); // 00:00 Paraguay
    const desde15 = new Date(ahora.getTime() - 15 * 24 * 3_600_000).toISOString();
    const [pedidos, chats, botV33, prods, v33] = await Promise.all([
      leerPedidos(desde15), chatsAnuncio(inicioDia), chatsBotV33(), stock(), leerCandado("resumen_v33_listo"),
    ]);
    const ent7 = await entregaGrupos(new Date(ahora.getTime() - 14 * 24 * 3_600_000).toISOString())
      .catch((e) => (console.warn("resumen-diario entrega:", e instanceof Error ? e.message : e), null));
    const [lucGest, custodia] = await Promise.all([
      luceroEnGestion().catch(() => []), papCustodia().catch(() => []),
    ]);
    const cans = await cansados().catch((e) => (console.warn("resumen-diario cansados:", e instanceof Error ? e.message : e), []));
    let meta = null;
    try {
      meta = await leerMeta(hoy);
    } catch (e) {
      console.warn("resumen-diario Meta:", e instanceof Error ? e.message : e);
    }
    const { texto, botV33Listo } = armarResumen({
      hoy, ahora, pedidos, meta, chatsAnuncioHoy: chats, chatsBotV33: botV33,
      botV33YaAvisado: (v33?.payload?.dia as string) ?? null, stock: prods, entrega7d: ent7, cansados: cans, luceroGestion: lucGest, papCustodia: custodia, prueba,
    });
    let r = await avisar(texto);
    for (let i = 0; i < 2 && !r.ok; i++) {
      await new Promise((z) => setTimeout(z, 3000));
      r = await avisar(texto);
    }
    await guardarCandado(idEnvio, { tipo: "resumen_diario", dia: hoy, prueba, meta_ok: meta !== null }, r.ok ? null : (r.error ?? "error"));
    if (r.ok && botV33Listo && !prueba && !v33) await guardarCandado("resumen_v33_listo", { dia: hoy }, null);
    console.log("resumen-diario", JSON.stringify({ hoy, prueba, ok: r.ok, meta_ok: meta !== null }));
    return Response.json({ ok: r.ok, hoy, prueba, meta_ok: meta !== null, error: r.ok ? undefined : r.error, texto });
  } catch (e) {
    const msg = e instanceof Error ? e.message : String(e);
    console.error("resumen-diario:", msg);
    return Response.json({ ok: false, error: msg }, { status: 500 });
  }
}));
