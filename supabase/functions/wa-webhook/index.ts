// Edge Function wa-webhook · dueño: subagente B (ola 1).
// GET: verificación de Meta (hub.mode / hub.verify_token / hub.challenge).
// POST: firma X-Hub-Signature-256 → eventos_crudos → 200 → procesar en segundo plano.
// La lógica está en procesar.ts; acá solo el I/O real (Supabase, Meta, Shopify, Telegram).

import { db, guardarEventoCrudo } from "../_shared/db.ts";
import { normalizarTelefonoPY } from "../_shared/telefono.ts";
import { agregarTags, quitarTags } from "../_shared/shopify.ts";
import { avisar } from "../_shared/telegram.ts";
import { escaparHtml } from "../_shared/telegram_formato.ts";
import { descargarMedia, enviarBotones, enviarTexto, marcarLeidoYEscribiendo, verificarFirmaMeta } from "../_shared/wa.ts";
import { transcribirAudio } from "../_shared/transcripcion.ts";
import { registrarBaja } from "../recompra/baja.ts";
import { ofrecerCobroQR } from "../pago-qr-webhook/io.ts";
import { type Deps, manejarRequest, type Pedido } from "./procesar.ts";

declare const EdgeRuntime: { waitUntil(p: Promise<unknown>): void } | undefined;

const FUENTE = "whatsapp" as const;

function falla(contexto: string, error: { message: string } | null): void {
  if (error) throw new Error(`${contexto}: ${error.message}`);
}

const configCache = new Map<string, { valor: unknown; hasta: number }>();

export const depsReales: Deps = {
  ahora: () => new Date(),

  async config(clave) {
    const c = configCache.get(clave);
    if (c && c.hasta > Date.now()) return c.valor;
    const { data, error } = await db().from("config_wa").select("valor").eq("clave", clave).maybeSingle();
    falla(`config_wa.${clave}`, error);
    const valor = data?.valor ?? null;
    configCache.set(clave, { valor, hasta: Date.now() + 60_000 });
    return valor;
  },

  guardarEventoCrudo: (id, payload) => guardarEventoCrudo(FUENTE, id, payload),

  async marcarEventoProcesado(id, error) {
    await db().from("eventos_crudos").update({ procesado_en: new Date().toISOString(), error })
      .eq("fuente", FUENTE).eq("id_externo", id);
  },

  async upsertCliente(d) {
    const t = db().from("wa_clientes");
    let fila: { id: string; wa_user_id: string | null; telefono: string | null; wa_username: string | null; nombre: string | null } | null = null;
    if (d.wa_user_id) {
      const { data, error } = await t.select("id,wa_user_id,telefono,wa_username,nombre").eq("wa_user_id", d.wa_user_id).maybeSingle();
      falla("buscar cliente por user_id", error);
      fila = data;
    }
    if (!fila && d.telefono) {
      const { data, error } = await db().from("wa_clientes").select("id,wa_user_id,telefono,wa_username,nombre").eq("telefono", d.telefono).maybeSingle();
      falla("buscar cliente por teléfono", error);
      fila = data;
    }
    if (!fila) {
      const { data, error } = await db().from("wa_clientes").insert(d).select("id,nombre").single();
      if (error?.code === "23505") return this.upsertCliente(d); // otro request lo creó recién
      falla("crear cliente", error);
      return data!;
    }
    // Completar lo que falte (no pisa datos existentes).
    const cambios: Record<string, unknown> = {};
    if (!fila.wa_user_id && d.wa_user_id) cambios.wa_user_id = d.wa_user_id;
    if (!fila.telefono && d.telefono) cambios.telefono = d.telefono;
    if (d.wa_username && fila.wa_username !== d.wa_username) cambios.wa_username = d.wa_username;
    if (!fila.nombre && d.nombre) cambios.nombre = d.nombre;
    if (Object.keys(cambios).length) {
      cambios.actualizado_en = new Date().toISOString();
      const { error } = await db().from("wa_clientes").update(cambios).eq("id", fila.id);
      if (error) console.error("actualizar cliente:", error.message);
    }
    return { id: fila.id, nombre: fila.nombre ?? d.nombre };
  },

  async conversacionActiva(clienteId, origenAnuncioId) {
    const { data, error } = await db().from("wa_conversaciones").select("id,estado").eq("cliente_id", clienteId)
      .neq("estado", "cerrada").order("creado_en", { ascending: false }).limit(1).maybeSingle();
    falla("buscar conversación", error);
    if (data) return data;
    const { data: nueva, error: e2 } = await db().from("wa_conversaciones")
      .insert({ cliente_id: clienteId, estado: "ia", origen_anuncio_id: origenAnuncioId }).select("id,estado").single();
    falla("crear conversación", e2);
    return nueva!;
  },

  async actualizarConversacion(id, cambios) {
    const { error } = await db().from("wa_conversaciones").update(cambios).eq("id", id);
    falla("actualizar conversación", error);
  },

  async insertarMensajeEntrante(fila) {
    const { error } = await db().from("wa_mensajes").insert(fila);
    if (error?.code === "23505") return false; // wa_message_id repetido
    falla("insertar mensaje", error);
    return true;
  },

  async completarContenidoMensaje(waMessageId, extra) {
    const { data } = await db().from("wa_mensajes").select("contenido").eq("wa_message_id", waMessageId).maybeSingle();
    const contenido = { ...(data?.contenido as Record<string, unknown> ?? {}), ...extra };
    const { error } = await db().from("wa_mensajes").update({ contenido }).eq("wa_message_id", waMessageId);
    falla("completar contenido", error);
  },

  async estadoMensaje(waMessageId) {
    const { data, error } = await db().from("wa_mensajes").select("estado").eq("wa_message_id", waMessageId).maybeSingle();
    falla("leer estado de mensaje", error);
    return data ? data.estado : undefined;
  },

  async actualizarMensaje(waMessageId, cambios) {
    const { error } = await db().from("wa_mensajes").update(cambios).eq("wa_message_id", waMessageId);
    falla("actualizar mensaje", error);
  },

  async copiarAudio(mediaId, ruta) {
    const m = await descargarMedia(mediaId);
    if (!m.ok) return { ok: false, error: m.error };
    const { error } = await db().storage.from("wa-media").upload(ruta, m.bytes, { contentType: m.mime, upsert: true });
    return error ? { ok: false, error: error.message } : { ok: true, ruta, mime: m.mime };
  },

  async buscarPedido(orderId) {
    const { data, error } = await db().from("shopify_pedidos").select("*").eq("shopify_order_id", orderId).maybeSingle();
    falla("buscar pedido", error);
    return data as Pedido | null;
  },

  async pedidosPorEstado(clienteId, telefono, estado, desdeISO) {
    let q = db().from("shopify_pedidos").select("*").eq("estado_confirmacion", estado).eq("es_borrador", false)
      .or(telefono ? `cliente_id.eq.${clienteId},telefono.eq.${telefono}` : `cliente_id.eq.${clienteId}`)
      .order("creado_en", { ascending: false }).limit(10);
    if (desdeISO) q = q.gte("creado_en", desdeISO);
    const { data, error } = await q;
    falla("buscar pedidos", error);
    return (data ?? []) as Pedido[];
  },

  async actualizarPedido(orderId, cambios) {
    const { error } = await db().from("shopify_pedidos")
      .update({ ...cambios, actualizado_en: new Date().toISOString() }).eq("shopify_order_id", orderId);
    falla("actualizar pedido", error);
  },

  async cancelarEnviosPendientes(orderId, patrones) {
    const { data, error } = await db().from("envios_programados").select("id,plantilla,clave_unica")
      .eq("shopify_order_id", orderId).eq("estado", "pendiente");
    falla("leer envíos programados", error);
    const ids = (data ?? []).filter((e) =>
      patrones.some((p) => `${e.plantilla ?? ""}`.toLowerCase().includes(p.toLowerCase()))
    ).map((e) => e.id);
    if (!ids.length) return 0;
    const { error: e2 } = await db().from("envios_programados")
      .update({ estado: "cancelado", ultimo_error: "cliente respondió la confirmación" }).in("id", ids).eq("estado", "pendiente");
    falla("cancelar envíos programados", e2);
    return ids.length;
  },

  async consentimientoMarketing(clienteId) {
    const { data, error } = await db().from("wa_consentimientos").select("estado").eq("cliente_id", clienteId)
      .eq("tipo", "marketing").order("creado_en", { ascending: false }).limit(1).maybeSingle();
    falla("leer consentimiento", error);
    return (data?.estado ?? null) as "si" | "no" | "baja" | null;
  },

  async registrarConsentimiento(clienteId, estado, origen) {
    const { error } = await db().from("wa_consentimientos")
      .insert({ cliente_id: clienteId, tipo: "marketing", estado, origen });
    falla("registrar consentimiento", error);
  },

  agregarTags,
  quitarTags,
  // Telegram va en modo HTML: los textos de procesar.ts son planos (traen lo que escribió el cliente).
  avisar: (texto, botones) => avisar(escaparHtml(texto), botones),
  enviarTexto: (to, texto, opts) => enviarTexto(to, texto, opts),
  enviarBotones: (to, texto, botones, opts) => enviarBotones(to, texto, botones, opts),
  marcarLeidoYEscribiendo,
  normalizarTelefono: normalizarTelefonoPY,

  // ---- ola 2 (G1): vendedor con IA ----
  pasarAlVendedor(d) {
    const url = Deno.env.get("SUPABASE_URL");
    const clave = Deno.env.get("SUPABASE_SERVICE_ROLE_KEY");
    if (!url || !clave) {
      console.error("vendedor: faltan SUPABASE_URL o SUPABASE_SERVICE_ROLE_KEY");
      return Promise.resolve();
    }
    const tarea = fetch(`${url}/functions/v1/vendedor`, {
      method: "POST",
      headers: { Authorization: `Bearer ${clave}`, "Content-Type": "application/json" },
      body: JSON.stringify(d),
    }).then(async (r) => {
      if (!r.ok) console.error(`vendedor respondió ${r.status}: ${(await r.text()).slice(0, 300)}`);
    }).catch((e) => console.error("vendedor no respondió:", e instanceof Error ? e.message : e));
    if (typeof EdgeRuntime !== "undefined" && EdgeRuntime?.waitUntil) EdgeRuntime.waitUntil(tarea);
    else return tarea;
    return Promise.resolve();
  },

  async transcribirAudio(ruta, mime) {
    const { data, error } = await db().storage.from("wa-media").download(ruta);
    if (error || !data) return { ok: false, texto: "", error: `descarga: ${error?.message ?? "sin datos"}` };
    const r = await transcribirAudio(new Uint8Array(await data.arrayBuffer()), mime ?? data.type ?? "audio/ogg");
    return { ok: r.ok, texto: r.texto, confianza: r.confianza, confianzaBaja: r.confianzaBaja, simulado: r.simulado, error: r.error };
  },

  async guardarTelefonoCliente(clienteId, telefono) {
    // Solo si no tenía; si otro cliente ya tiene ese número (unique), no se pisa: queda en el log.
    const { error } = await db().from("wa_clientes").update({ telefono, actualizado_en: new Date().toISOString() })
      .eq("id", clienteId).is("telefono", null);
    if (error) console.error(`guardar teléfono del cliente ${clienteId}:`, error.message);
  },

  // ---- integración olas 3-4 ----
  registrarBaja: (clienteId, origen) => registrarBaja(clienteId, origen),

  async ofertaMarketing(clienteId, orderId) {
    let q = db().from("envios_programados").select("plantilla,variables").eq("cliente_id", clienteId)
      .eq("categoria", "marketing").eq("estado", "enviado").like("plantilla", "voltra_mk_%");
    if (orderId) q = q.eq("shopify_order_id", orderId);
    const { data, error } = await q.order("enviar_desde", { ascending: false }).limit(1).maybeSingle();
    falla("buscar oferta enviada", error);
    return data as { plantilla: string; variables: unknown } | null;
  },

  async ofrecerCobroQR(orderId) {
    const r = await ofrecerCobroQR(orderId);
    return r.ok ? { ok: true, texto: r.texto } : { ok: false, motivo: r.motivo };
  },

  async clienteDeMensaje(waMessageId) {
    const { data, error } = await db().from("wa_mensajes").select("cliente_id").eq("wa_message_id", waMessageId).maybeSingle();
    falla("cliente del mensaje", error);
    return (data?.cliente_id as string | null) ?? null;
  },
};

Deno.serve((req) =>
  manejarRequest(req, depsReales, {
    verifyToken: Deno.env.get("WA_VERIFY_TOKEN") ?? "",
    appSecret: Deno.env.get("WA_APP_SECRET") ?? "",
    verificarFirma: verificarFirmaMeta,
    enSegundoPlano: (p) => {
      if (typeof EdgeRuntime !== "undefined" && EdgeRuntime?.waitUntil) EdgeRuntime.waitUntil(p);
      else p.catch((e) => console.error(e));
    },
  })
);
