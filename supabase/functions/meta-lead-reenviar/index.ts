// meta-lead-reenviar · Edge Function (solo service role).
// Cron cada 10 min (body {origen:"pg_cron"}): manda lo pendiente de LeadSubmitted y Purchase (logica.ts → automatico).
// A mano: {modo?: "listar"|"prueba"|"enviar", evento?: "LeadSubmitted"|"Purchase", test_event_code?, pedidos?: ["#1032"]}.
import { conServiceRole } from "../_shared/auth_servicio.ts";
import { depsReales } from "./io.ts";
import { automatico, type Modo, reenviar } from "./logica.ts";
import { enviarConfirmadosWeb, depsReales as depsConfirmado } from "./confirmado_web.ts";
import { armarPayloadLead, configLead, EVENTO_PURCHASE, GRAPH_VERSION } from "../_shared/meta_capi.ts";
import { db } from "../_shared/db.ts";

Deno.serve(conServiceRole(async (req: Request) => {
  try {
    const b = await req.json().catch(() => ({})) as { modo?: Modo; evento?: string; test_event_code?: string; pedidos?: string[]; origen?: string; forzar?: boolean };
    if ((b as { modo?: string }).modo === "diagnostico") {
      // Solo lectura: qué dataset tiene vinculado la WABA (GET /{waba}/dataset, CAPI for Business Messaging).
      const token = Deno.env.get("META_CAPI_TOKEN"), waba = Deno.env.get("WA_WABA_ID");
      const r = await fetch(`https://graph.facebook.com/${GRAPH_VERSION}/${waba}/dataset`, { headers: { Authorization: `Bearer ${token}` } });
      const j = await r.json().catch(() => ({}));
      // Permisos del token (scopes y a qué WABA/dataset alcanzan). Nunca se devuelve el token.
      const dt = await fetch(`https://graph.facebook.com/${GRAPH_VERSION}/debug_token?input_token=${token}`, { headers: { Authorization: `Bearer ${token}` } });
      const dj = await dt.json().catch(() => ({})) as { data?: Record<string, unknown> };
      const d = dj.data ?? {};
      const permisos = { app_id: d.app_id, tipo: d.type, valido: d.is_valid, vence: d.expires_at, scopes: d.scopes, granular_scopes: d.granular_scopes, error: d.error };
      return Response.json({ ok: r.ok, waba_dataset: j, dataset_configurado: Deno.env.get("META_DATASET_MENSAJERIA_ID"), permisos });
    }
    if ((b as { modo?: string }).modo === "prueba_cruda") {
      // 12-10: envío literal de `data` (solo con test_event_code). "ahora" en event_time → ahora; "RECIENTE" en
      // ctwa_clid → el del clic de anuncio más reciente. Devuelve la respuesta completa de Meta.
      const cfg = configLead();
      const datos = (b as { data?: Record<string, unknown>[] }).data;
      if (!cfg || !b.test_event_code || !Array.isArray(datos)) return Response.json({ ok: false, error: "falta config, test_event_code o data" }, { status: 400 });
      let reciente = "";
      if (JSON.stringify(datos).includes('"RECIENTE"')) {
        const { data } = await db().from("wa_mensajes").select("contenido").eq("direccion", "in")
          .not("contenido->referral->>ctwa_clid", "is", null).order("creado_en", { ascending: false }).limit(1);
        reciente = (data?.[0]?.contenido as { referral?: { ctwa_clid?: string } })?.referral?.ctwa_clid ?? "";
      }
      const ahora = Math.floor(Date.now() / 1000);
      const data = datos.map((e) => ({
        ...e,
        ...(e.event_time === "ahora" ? { event_time: ahora } : {}),
        user_data: { ...(e.user_data as Record<string, unknown>), ...((e.user_data as { ctwa_clid?: string })?.ctwa_clid === "RECIENTE" ? { ctwa_clid: reciente } : {}) },
      }));
      const r = await fetch(`https://graph.facebook.com/${GRAPH_VERSION}/${cfg.datasetMensajeriaId}/events`, {
        method: "POST", headers: { "Content-Type": "application/json", Authorization: `Bearer ${cfg.token}` },
        body: JSON.stringify({ data, test_event_code: b.test_event_code }),
      });
      const j = await r.json().catch(() => ({}));
      const visible = data.map((e) => ({ ...e, user_data: { ...e.user_data, ctwa_clid: `${String(e.user_data.ctwa_clid).slice(0, 4)}…(${String(e.user_data.ctwa_clid).length})` } }));
      return Response.json({ ok: r.ok, http: r.status, meta: j, enviado: { data: visible, test_event_code: b.test_event_code } });
    }
    if ((b as { modo?: string }).modo === "prueba_reciente") {
      // 12-10: prueba con el ctwa_clid del clic de anuncio MÁS RECIENTE (event_time = ahora), con test_event_code.
      const cfg = configLead();
      if (!cfg || !b.test_event_code) return Response.json({ ok: false, error: "falta config de Meta o test_event_code" }, { status: 400 });
      const { data, error } = await db().from("wa_mensajes").select("creado_en,contenido").eq("direccion", "in")
        .not("contenido->referral->>ctwa_clid", "is", null).order("creado_en", { ascending: false }).limit(1);
      if (error || !data?.length) return Response.json({ ok: false, error: error?.message ?? "sin clics de anuncio" }, { status: 500 });
      const ref = (data[0].contenido as { referral: { ctwa_clid: string; source_id?: string } }).referral;
      const ahora = new Date();
      const payload = armarPayloadLead({ shopify_order_id: `prueba-${ahora.getTime()}`, creado_en: ahora.toISOString(), valor: 129000, moneda: "PYG", ctwa_clid: ref.ctwa_clid },
        { ahora, wabaId: cfg.wabaId, testEventCode: b.test_event_code.trim() })!;
      const r = await fetch(`https://graph.facebook.com/${GRAPH_VERSION}/${cfg.datasetMensajeriaId}/events`, {
        method: "POST", headers: { "Content-Type": "application/json", Authorization: `Bearer ${cfg.token}` }, body: JSON.stringify(payload),
      });
      const j = await r.json().catch(() => ({}));
      const ev = (payload.data as Record<string, unknown>[])[0];
      const enviado = { ...ev, user_data: { ...(ev.user_data as object), ctwa_clid: `${ref.ctwa_clid.slice(0, 4)}…(${ref.ctwa_clid.length})` } };
      return Response.json({ ok: r.ok, http: r.status, meta: j, clic: { hora: data[0].creado_en, anuncio: ref.source_id }, enviado });
    }
    // 22-10: PedidoConfirmado (web). A mano: {modo:"confirmado_web", simular?, test_event_code?}.
    if ((b as { modo?: string }).modo === "confirmado_web") {
      const o = b as { simular?: boolean; test_event_code?: string };
      return Response.json({ ok: true, confirmado_web: await enviarConfirmadosWeb(depsConfirmado, new Date(), { simular: o.simular === true, testEventCode: o.test_event_code ?? null }) });
    }
    if (b.origen === "pg_cron") {
      const confirmadoWeb = await enviarConfirmadosWeb(depsConfirmado).catch((e) => [{ pedido: "-", resultado: `error: ${e instanceof Error ? e.message : String(e)}` }]);
      const r = { ...(await automatico(depsReales())), confirmado_web: confirmadoWeb };
      console.log("meta-lead-reenviar cron", JSON.stringify(r));
      return Response.json({ ok: true, ...r });
    }
    const evento = b.evento === EVENTO_PURCHASE ? EVENTO_PURCHASE : "LeadSubmitted";
    const modo: Modo = b.modo === "prueba" || b.modo === "enviar" ? b.modo : "listar";
    const r = await reenviar(modo, { testEventCode: b.test_event_code ?? null, pedidos: b.pedidos, evento, forzar: b.forzar === true }, depsReales());
    console.log("meta-lead-reenviar", JSON.stringify({ modo, filas: r.filas, prueba: r.prueba }));
    return Response.json({ ok: true, ...r });
  } catch (e) {
    const msg = e instanceof Error ? e.message : String(e);
    console.error("meta-lead-reenviar:", msg);
    return Response.json({ ok: false, error: msg }, { status: 500 });
  }
}));
