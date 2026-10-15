// recuperar-borradores · I/O real (Supabase, WhatsApp, Telegram).
import { db } from "../_shared/db.ts";
import { enviarPlantilla, GRAPH_URL } from "../_shared/wa.ts";
import { avisar } from "../_shared/telegram.ts";
import { nombreDeHandle, productoPorPalabras } from "../_shared/anuncios.ts";
import { depsHerramientasReales, depsOrquestadorReales } from "../_shared/vendedor/io.ts";
import {
  type Borrador,
  configRecuperacion,
  type ConsentimientoCliente,
  type DepsRecuperar,
  type EstadoConsentimiento,
  type PreciosRecuperar,
  TAG_BORRADOR_RELEASIT,
} from "./logica.ts";

const CLAVE_ALERTA = "ola4.recuperacion_alerta";

async function estadoVigente(clienteId: string, tipo: "utilidad" | "marketing"): Promise<EstadoConsentimiento> {
  const { data, error } = await db().from("wa_consentimientos").select("estado")
    .eq("cliente_id", clienteId).eq("tipo", tipo).order("creado_en", { ascending: false }).limit(1).maybeSingle();
  if (error) throw new Error(`consentimiento: ${error.message}`);
  return (data?.estado as EstadoConsentimiento) ?? null;
}

/** "+595981…" (formato de wa_clientes y shopify_pedidos) → "595981…" (formato de la API de WhatsApp). */
const sinMas = (t: string) => t.replace(/\D/g, "");

export const depsReales: DepsRecuperar = {
  ahora: () => new Date(),
  config: async () => {
    const { data, error } = await db().from("config_wa").select("valor").eq("clave", "ola4.recuperacion").maybeSingle();
    if (error) throw new Error(`config_wa ola4.recuperacion: ${error.message}`);
    if (!data) console.log("recuperar-borradores: falta config_wa['ola4.recuperacion'] → bandera apagada");
    return configRecuperacion(data?.valor);
  },
  borradores: async (limite) => {
    const sb = db();
    const desde = new Date(Date.now() - 6 * 3_600_000).toISOString();
    const { data, error } = await sb.from("shopify_pedidos")
      .select("shopify_order_id,nombre,cliente_id,telefono,tags,raw,creado_en")
      .eq("es_borrador", true).contains("tags", [TAG_BORRADOR_RELEASIT]).gte("creado_en", desde)
      .order("creado_en", { ascending: true }).limit(limite);
    if (error) throw new Error(`borradores: ${error.message}`);
    const filas = (data ?? []) as Borrador[];
    if (!filas.length) return [];
    const { data: ya, error: e2 } = await sb.from("recuperacion_borradores").select("draft_id")
      .in("draft_id", filas.map((f) => f.shopify_order_id));
    if (e2) throw new Error(`recuperacion_borradores: ${e2.message}`);
    const vistos = new Set((ya ?? []).map((r) => Number(r.draft_id)));
    return filas.filter((f) => !vistos.has(Number(f.shopify_order_id))).map((f) => ({ ...f, tags: f.tags ?? [] }));
  },
  intentadosDesde: async (desde) => {
    const { count, error } = await db().from("recuperacion_borradores").select("draft_id", { count: "exact", head: true })
      .gte("creado_en", desde.toISOString());
    if (error) throw new Error(`intentadosDesde: ${error.message}`);
    return count ?? 0;
  },
  consentimiento: async (clienteId): Promise<ConsentimientoCliente> => {
    if (!clienteId) return { utilidad: null, marketing: null };
    return { utilidad: await estadoVigente(clienteId, "utilidad"), marketing: await estadoVigente(clienteId, "marketing") };
  },
  pedidoDesde: async (telefono, desde) => {
    const { data, error } = await db().from("shopify_pedidos").select("shopify_order_id")
      .eq("telefono", telefono).eq("es_borrador", false).gte("creado_en", desde.toISOString()).limit(1);
    if (error) throw new Error(`pedidoDesde: ${error.message}`);
    return (data ?? []).length > 0;
  },
  chatAbierto: async (clienteId, desde) => {
    if (!clienteId) return false;
    const { data, error } = await db().from("wa_conversaciones").select("id,estado,ultima_entrada_en")
      .eq("cliente_id", clienteId).neq("estado", "cerrada");
    if (error) throw new Error(`chatAbierto: ${error.message}`);
    return (data ?? []).some((c) => c.estado === "humano" || (c.ultima_entrada_en && Date.parse(c.ultima_entrada_en) >= desde.getTime()));
  },
  contactadoReciente: async (clienteId, telefono, desde) => {
    const sb = db();
    const { data: ids, error: e1 } = await sb.from("shopify_pedidos").select("shopify_order_id")
      .eq("telefono", telefono).eq("es_borrador", true).gte("creado_en", desde.toISOString()).limit(200);
    if (e1) throw new Error(`contactadoReciente: ${e1.message}`);
    const drafts = (ids ?? []).map((r) => r.shopify_order_id);
    let q = sb.from("recuperacion_borradores").select("draft_id").gte("creado_en", desde.toISOString()).limit(1);
    q = clienteId
      ? q.or(`cliente_id.eq.${clienteId}${drafts.length ? `,draft_id.in.(${drafts.join(",")})` : ""}`)
      : drafts.length ? q.in("draft_id", drafts) : q.eq("draft_id", -1);
    const { data, error } = await q;
    if (error) throw new Error(`contactadoReciente: ${error.message}`);
    return (data ?? []).length > 0;
  },
  precios: async (): Promise<PreciosRecuperar> => {
    // Los mismos precios que ve el vendedor: config_wa (ofertas, envío) + catálogo de Shopify.
    const cfg = await depsOrquestadorReales.config();
    const productos = await depsHerramientasReales.catalogoShopify(cfg.vendedor.catalogo_estado || "ACTIVE");
    const unidad: PreciosRecuperar["unidad"] = {};
    for (const p of productos) {
      const v = p.variantes.find((x) => x.disponible) ?? p.variantes[0];
      if (v) unidad[p.handle] = { precio: v.price, disponible: p.variantes.some((x) => x.disponible) };
    }
    return { unidad, ofertas: cfg.ofertas as PreciosRecuperar["ofertas"], envio: cfg.envio.costo_gs };
  },
  productoPorPalabras,
  nombreProducto: nombreDeHandle,
  calidadNumero: async () => {
    const token = Deno.env.get("WA_TOKEN"), phoneId = Deno.env.get("WA_PHONE_NUMBER_ID");
    if (!token || !phoneId) return null;
    try {
      const r = await fetch(`${GRAPH_URL}/${phoneId}?fields=quality_rating`, {
        headers: { Authorization: `Bearer ${token}` },
        signal: AbortSignal.timeout(10_000),
      });
      if (!r.ok) return null;
      const j = await r.json() as { quality_rating?: string };
      return typeof j.quality_rating === "string" ? j.quality_rating.toUpperCase() : null;
    } catch {
      return null;
    }
  },
  alertarCalidad: async (calidad, cadaH) => {
    const sb = db();
    const { data } = await sb.from("config_wa").select("valor").eq("clave", CLAVE_ALERTA).maybeSingle();
    const ultima = Date.parse(String((data?.valor as { en?: string } | null)?.en ?? ""));
    if (Number.isFinite(ultima) && Date.now() - ultima < cadaH * 3_600_000) return;
    const que = calidad ? `la calidad del número está en <b>${calidad}</b>` : "no pude leer la calidad del número en Meta";
    const r = await avisar(
      `⛔ Recuperación de formularios abandonados FRENADA: ${que}. No se manda ningún mensaje hasta que vuelva a GREEN ` +
        "(se revisa sola cada 5 minutos).",
    );
    if (!r.ok) { console.error("recuperar-borradores: Telegram falló:", r.error); return; }
    await sb.from("config_wa").upsert({ clave: CLAVE_ALERTA, valor: { en: new Date().toISOString(), calidad } }, { onConflict: "clave" });
  },
  reclamar: async (b) => {
    const { data, error } = await db().from("recuperacion_borradores")
      .upsert({ draft_id: b.shopify_order_id, estado: "enviando", cliente_id: b.cliente_id }, { onConflict: "draft_id", ignoreDuplicates: true })
      .select("draft_id");
    if (error) throw new Error(`reclamar: ${error.message}`);
    return Array.isArray(data) && data.length > 0;
  },
  prepararConversacion: async (b) => {
    // La plantilla tiene que quedar en la conversación que va a usar wa-webhook cuando el cliente responda
    // (la última no cerrada del cliente): así el vendedor ve qué producto y qué precio se le ofreció.
    const sb = db();
    let clienteId = b.cliente_id;
    if (!clienteId && b.telefono) {
      const tel = `+${sinMas(b.telefono)}`;
      const { data } = await sb.from("wa_clientes").select("id").eq("telefono", tel).maybeSingle();
      clienteId = data?.id ?? null;
      if (!clienteId) {
        const { data: nuevo, error } = await sb.from("wa_clientes").insert({ telefono: tel }).select("id").single();
        if (error) throw new Error(`wa_clientes: ${error.message}`);
        clienteId = nuevo.id;
      }
    }
    if (!clienteId) return { clienteId: null, conversacionId: null };
    const { data: conv } = await sb.from("wa_conversaciones").select("id").eq("cliente_id", clienteId)
      .neq("estado", "cerrada").order("creado_en", { ascending: false }).limit(1).maybeSingle();
    if (conv?.id) return { clienteId, conversacionId: conv.id };
    const { data: nueva, error } = await sb.from("wa_conversaciones").insert({ cliente_id: clienteId, estado: "ia" }).select("id").single();
    if (error) throw new Error(`wa_conversaciones: ${error.message}`);
    return { clienteId, conversacionId: nueva.id };
  },
  enviar: async (telefono, plantilla, m, destino) => {
    const r = await enviarPlantilla(sinMas(telefono), plantilla, "es", m.componentes, {
      clienteId: destino.clienteId,
      conversacionId: destino.conversacionId,
    });
    // El registro estándar guarda solo las variables ("[plantilla x] Ana | …"): se reemplaza por el texto entero.
    if (r.wa_message_id) {
      await db().from("wa_mensajes").update({ texto: m.texto }).eq("wa_message_id", r.wa_message_id);
    }
    return r;
  },
  cerrar: async (b, estado, extra) => {
    await db().from("recuperacion_borradores").update({
      estado,
      enviado_en: estado === "enviado" ? new Date().toISOString() : null,
      wa_message_id: extra.wa_message_id ?? null,
      error: extra.error ?? null,
      conversacion_id: extra.conversacion_id ?? null,
    }).eq("draft_id", b.shopify_order_id);
  },
};
