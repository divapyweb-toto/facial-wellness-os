// Edge Function wa-webhook · dueño: subagente B (ola 1).
// GET: verificación de Meta (hub.mode / hub.verify_token / hub.challenge).
// POST: firma X-Hub-Signature-256 → eventos_crudos → 200 → procesar en segundo plano.
// La lógica está en procesar.ts; acá solo el I/O real (Supabase, Meta, Shopify, Telegram).

import { db, guardarEventoCrudo } from "../_shared/db.ts";
import { normalizarTelefonoPY } from "../_shared/telefono.ts";
import { agregarTags, quitarTags } from "../_shared/shopify.ts";
import { avisar, avisarConArchivo } from "../_shared/telegram.ts";
import { enviarInteractivo } from "../_shared/wa_interactivos.ts";
import { claveOfertaPrioridad, PLANTILLA_PAGO_PRIORIDAD } from "../_shared/pago_anticipado.ts";
import { escaparHtml } from "../_shared/telegram_formato.ts";
import { descargarMedia, enviarBotones, enviarTexto, marcarLeidoYEscribiendo, verificarFirmaMeta } from "../_shared/wa.ts";
import { transcribirAudio } from "../_shared/transcripcion.ts";
import { resolverLinkMapas } from "../_shared/link_mapas.ts";
import { registrarBaja } from "../recompra/baja.ts";
import { ofrecerCobroQR } from "../pago-qr-webhook/io.ts";
import { cargarTarifasCourier, consultarCourierCiudad } from "../_shared/plazo_zona.ts";
import { candidatosWhatsapp, type Deps, manejarRequest, type MensajeMeta, type Pedido, telefonoLocal } from "./procesar.ts";

declare const EdgeRuntime: { waitUntil(p: Promise<unknown>): void } | undefined;

const FUENTE = "whatsapp" as const;

function falla(contexto: string, error: { message: string } | null): void {
  if (error) throw new Error(`${contexto}: ${error.message}`);
}

/** Descarga un archivo de Meta (la URL vence a los 5 min) y lo sube a Storage wa-media. */
async function copiarAStorage(mediaId: string, ruta: string): Promise<{ ok: boolean; ruta?: string; mime?: string; error?: string }> {
  const m = await descargarMedia(mediaId);
  if (!m.ok) return { ok: false, error: m.error };
  const { error } = await db().storage.from("wa-media").upload(ruta, m.bytes, { contentType: m.mime, upsert: true });
  return error ? { ok: false, error: error.message } : { ok: true, ruta, mime: m.mime };
}

const configCache = new Map<string, { valor: unknown; hasta: number }>();

export const depsReales: Deps = {
  consultarCourier: (ciudad) => consultarCourierCiudad(db(), ciudad),
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

  async eventoCrudoExiste(id) {
    const { data, error } = await db().from("eventos_crudos").select("id").eq("id_externo", id).limit(1);
    falla(`eventos_crudos ${id}`, error);
    return (data ?? []).length > 0;
  },

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
    const { data, error } = await db().from("wa_conversaciones").select("id,estado,origen_anuncio_id").eq("cliente_id", clienteId)
      .neq("estado", "cerrada").order("creado_en", { ascending: false }).limit(1).maybeSingle();
    falla("buscar conversación", error);
    if (data) return data;
    const { data: nueva, error: e2 } = await db().from("wa_conversaciones")
      .insert({ cliente_id: clienteId, estado: "ia", origen_anuncio_id: origenAnuncioId }).select("id,estado,origen_anuncio_id").single();
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

  copiarAudio: (mediaId, ruta) => copiarAStorage(mediaId, ruta),

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

  resolverLinkMapas: (url) => resolverLinkMapas(url),

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

  async bloquearSeguimientos(conversacionId) {
    const { error } = await db().rpc("vendedor_marcar_seguimiento", { p_conversacion: conversacionId, p_seguimientos: 2, p_en: new Date().toISOString() });
    if (error) throw new Error(error.message);
  },

  async contextoRecompraFw(telefono) {
    if (!telefono) return null;
    const { data } = await db().from("config_wa").select("valor").eq("clave", "recompra_fw_contexto").maybeSingle();
    const v = (data?.valor ?? {}) as Record<string, { producto?: string; dias?: number; enviado_en?: string }>;
    const c = v[telefono.replace(/^\+/, "")] ?? v[telefono];
    if (!c?.producto) return null;
    // Solo durante 30 días desde el envío de la recompra.
    if (c.enviado_en && Date.now() - Date.parse(c.enviado_en) > 30 * 86_400_000) return null;
    const extra = c.enviado_en ? Math.floor((Date.now() - Date.parse(c.enviado_en)) / 86_400_000) : 0;
    // 08-10: datos de su última entrega de Facial Wellness (ventas), para armarle el resumen sin pedirle nada.
    const local = "0" + telefono.replace(/\D/g, "").replace(/^595/, "").replace(/^0/, "");
    const { data: v2 } = await db().from("ventas").select("cliente_nombre,ciudad,cliente_direccion")
      .eq("cliente_telefono", local).eq("estado", "entregado").is("deleted_at", null)
      .order("fecha", { ascending: false }).limit(1).maybeSingle();
    const entrega = v2?.cliente_nombre && v2?.ciudad && v2?.cliente_direccion
      ? { nombre: String(v2.cliente_nombre), ciudad: String(v2.ciudad), direccion: String(v2.cliente_direccion) }
      : undefined;
    return { producto: c.producto, dias: Number(c.dias ?? 0) + extra, ...(entrega ? { entrega } : {}) };
  },

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

  // Señales de que Enrique atiende el chat (wa-webhook/procesar.ts → motivoParaNoRetomar).
  async actividadHumana({ conversacionId, clienteId, desdeISO }) {
    const [manuales, turnos, entrantes, escribos] = await Promise.all([
      db().from("wa_mensajes").select("id", { count: "exact", head: true }).eq("conversacion_id", conversacionId)
        .eq("direccion", "out").eq("contenido->>origen", "manual").gte("creado_en", desdeISO),
      db().from("vendedor_turnos").select("herramientas").eq("conversacion_id", conversacionId).eq("derivado", true)
        .gte("creado_en", desdeISO).limit(50),
      db().from("wa_mensajes").select("contenido").eq("conversacion_id", conversacionId).eq("direccion", "in")
        .in("tipo", ["button", "interactive"]).gte("creado_en", desdeISO).limit(50),
      db().from("eventos_crudos").select("id_externo").eq("fuente", "telegram").like("id_externo", "accion:escribo:%")
        .gte("recibido_en", desdeISO).limit(100),
    ]);
    falla("salidas manuales", manuales.error);
    falla("turnos derivados", turnos.error);
    falla("entrantes con botón", entrantes.error);
    falla("botones escribo", escribos.error);
    const derivaciones: string[] = [];
    for (const t of turnos.data ?? []) {
      for (const h of (Array.isArray(t.herramientas) ? t.herramientas : []) as Array<{ nombre?: string; input?: { motivo?: unknown } }>) {
        if (String(h?.nombre ?? "").startsWith("derivar_a_enrique")) derivaciones.push(String(h?.input?.motivo ?? "otro"));
      }
    }
    // "Le escribo yo" va por pedido (accion:escribo:<shopify_order_id>): cuenta si el pedido es de este cliente.
    const ids = (escribos.data ?? []).map((e) => Number(String(e.id_externo).split(":")[2])).filter((n) => Number.isFinite(n) && n > 0);
    let escribo = false;
    if (ids.length) {
      const { count, error } = await db().from("shopify_pedidos").select("shopify_order_id", { count: "exact", head: true })
        .in("shopify_order_id", ids).eq("cliente_id", clienteId);
      falla("pedidos de los botones escribo", error);
      escribo = (count ?? 0) > 0;
    }
    return {
      salidasManuales: manuales.count ?? 0,
      escribo,
      derivaciones,
      entrantes: (entrantes.data ?? []).map((f) => f.contenido as MensajeMeta).filter(Boolean),
    };
  },

  // Pago anticipado: comprobante (imagen o PDF) a Storage wa-media/comprobantes/...
  copiarMedia: (mediaId, ruta) => copiarAStorage(mediaId, ruta),
  copiarMediaChat: (mediaId, ruta) => copiarAStorage(mediaId, ruta),

  // 08-10: perfil del vendedor (marca del anuncio una sola vez). Sin la columna (migración 0011) tira error y
  // procesar.ts deja la marca solo en el mensaje con referral.
  async perfilConversacion(conversacionId) {
    const { data, error } = await db().from("wa_conversaciones").select("perfil_vendedor").eq("id", conversacionId).maybeSingle();
    falla("perfil de la conversación", error);
    const p = data?.perfil_vendedor;
    return p && typeof p === "object" && !Array.isArray(p) ? p as { producto?: unknown; pidio_testimonio_en?: unknown; testimonio_pedido?: unknown } : null;
  },

  async ofertaRescateDesde(conversacionId, orderId, desdeISO) {
    // 13-10: la oferta de rescate es un mensaje interactivo con el botón resc_prog:<id> (el primero).
    const { data, error } = await db().from("wa_mensajes").select("id").eq("conversacion_id", conversacionId)
      .eq("direccion", "out").neq("estado", "fallido").gte("creado_en", desdeISO)
      .filter("contenido->interactive->action->buttons->0->reply->>id", "eq", `resc_prog:${orderId}`).limit(1);
    falla("oferta de rescate", error);
    return (data?.length ?? 0) > 0;
  },

  async ultimoTextoNuestro(conversacionId) {
    const { data, error } = await db().from("wa_mensajes").select("texto").eq("conversacion_id", conversacionId)
      .eq("direccion", "out").order("creado_en", { ascending: false }).limit(1).maybeSingle();
    falla("último mensaje nuestro", error);
    return (data?.texto as string | null) ?? null;
  },

  // 19-10 (#1072): por cliente y no por conversación: la plantilla de confirmación de un cliente nuevo (o con el chat
  // cerrado) queda sin conversación o en otra. Los fallidos no cuentan: el cliente nunca los vio.
  async ultimoSalienteCliente(clienteId) {
    const { data, error } = await db().from("wa_mensajes").select("tipo,texto,contenido").eq("cliente_id", clienteId)
      .eq("direccion", "out").or("estado.is.null,estado.neq.fallido").order("creado_en", { ascending: false }).limit(1).maybeSingle();
    falla("último mensaje al cliente", error);
    return data ?? null;
  },

  async marcarPerfil(conversacionId, clave, valor) {
    const sb = db();
    const { data, error } = await sb.from("wa_conversaciones").select("perfil_vendedor").eq("id", conversacionId).maybeSingle();
    falla("leer perfil", error);
    const p = data?.perfil_vendedor && typeof data.perfil_vendedor === "object" && !Array.isArray(data.perfil_vendedor)
      ? { ...(data.perfil_vendedor as Record<string, unknown>) } : {};
    if (valor === null) delete p[clave];
    else p[clave] = valor;
    const r = await sb.from("wa_conversaciones").update({ perfil_vendedor: p }).eq("id", conversacionId);
    falla("marcar perfil", r.error);
  },

  // 12-10: permiso para ofertas después de la confirmación (botones de _shared/wa_interactivos.ts).
  enviarInteractivo: (to, interactivo, opts) => enviarInteractivo(to, interactivo, opts),

  // 12-10: ¿ya se le mandaron los botones cons_si:<cliente_id> alguna vez? (vendedor, "Todo bien" o una confirmación)
  async permisoOfertasPedido(clienteId) {
    const { count, error } = await db().from("wa_mensajes").select("id", { count: "exact", head: true })
      .eq("cliente_id", clienteId).eq("direccion", "out").eq("tipo", "interactive").neq("estado", "fallido")
      .like("contenido->>interactive", `%cons_si:${clienteId}%`);
    falla("permiso de ofertas ya pedido", error);
    return (count ?? 0) > 0;
  },

  // 12-10: oferta de pago con prioridad al confirmar: la fila prio:<id> se inserta ya 'enviado' (procesar-envios no
  // la toma) y su clave única impide mandarla dos veces, venga por wa-webhook o por shopify-webhook (pedidos del bot).
  async reservarOfertaPrioridad(orderId, clienteId) {
    const { data, error } = await db().from("envios_programados").upsert({
      cliente_id: clienteId,
      shopify_order_id: Number(orderId),
      plantilla: PLANTILLA_PAGO_PRIORIDAD,
      variables: { origen: "wa-webhook" },
      categoria: "utilidad",
      enviar_desde: new Date().toISOString(),
      estado: "enviado",
      intentos: 1,
      clave_unica: claveOfertaPrioridad(orderId),
    }, { onConflict: "clave_unica", ignoreDuplicates: true }).select("id");
    falla("reservar oferta de pago con prioridad", error);
    return (data?.length ?? 0) > 0;
  },

  async cerrarOfertaPrioridad(orderId, r) {
    const cambios = r.ok
      ? { ultimo_error: null, ...(r.wa_message_id ? { wa_message_id: r.wa_message_id } : {}) }
      : { estado: "fallido", ultimo_error: String(r.error ?? "error").slice(0, 500) };
    let { error } = await db().from("envios_programados").update(cambios).eq("clave_unica", claveOfertaPrioridad(orderId));
    // Sin la columna wa_message_id (base vieja), se guarda el resto.
    if (error && /wa_message_id/.test(error.message)) {
      ({ error } = await db().from("envios_programados").update({ ultimo_error: null }).eq("clave_unica", claveOfertaPrioridad(orderId)));
    }
    falla("cerrar oferta de pago con prioridad", error);
  },

  // 12-10: comprobante ya recibido para el pedido (marca que deja aplicarComprobantePago en el mensaje entrante).
  async comprobanteRecibido(orderId) {
    const { count, error } = await db().from("wa_mensajes").select("id", { count: "exact", head: true })
      .eq("direccion", "in").eq("contenido->>comprobante_pago_anticipado", orderId);
    falla("comprobantes previos", error);
    return (count ?? 0) > 0;
  },

  // 12-10: el comprobante va a Telegram como foto o documento (copia de Storage o, si no hay, de Meta).
  async avisarConArchivo(texto, botones, a) {
    let bytes: Uint8Array | null = null;
    let mime = a.mime;
    if (a.ruta) {
      const { data, error } = await db().storage.from("wa-media").download(a.ruta);
      if (!error && data) {
        bytes = new Uint8Array(await data.arrayBuffer());
        mime = data.type || mime;
      }
    }
    if (!bytes) {
      const m = await descargarMedia(a.mediaId);
      if (!m.ok) return { ok: false, error: m.error };
      bytes = m.bytes;
      mime = m.mime;
    }
    const r = await avisarConArchivo(escaparHtml(texto), { bytes, mime, nombre: a.nombre }, botones);
    return r.ok ? { ok: true } : { ok: false, error: r.error };
  },

  // 13-10: testimonios (migración 20261013000010_testimonios.sql). Solo service role.
  async guardarTestimonio(t) {
    const { data, error } = await db().from("testimonios")
      .upsert(t, { onConflict: "wa_message_id", ignoreDuplicates: true }).select("id");
    falla("guardar testimonio", error);
    return data && data.length ? { id: String((data[0] as { id: string }).id) } : null;
  },

  async responderPermisoTestimonio(id, clienteId, autorizado) {
    const { data, error } = await db().from("testimonios")
      .update({ autorizado, autorizado_en: new Date().toISOString() })
      .eq("id", id).eq("cliente_id", clienteId).is("autorizado", null).select("id");
    falla("permiso del testimonio", error);
    return (data?.length ?? 0) > 0;
  },

  async contarTestimoniosAutorizados() {
    const { count, error } = await db().from("testimonios").select("id", { count: "exact", head: true }).eq("autorizado", true);
    falla("contar testimonios", error);
    return count ?? 0;
  },

  async registrarHitoTestimonios(hito) {
    const { data, error } = await db().from("testimonios_hitos")
      .upsert({ hito }, { onConflict: "hito", ignoreDuplicates: true }).select("hito");
    falla("hito de testimonios", error);
    return (data?.length ?? 0) > 0;
  },

  // 23-10 (Enrique): número sin WhatsApp en un mensaje del pedido → Telegram para llamar (una vez por pedido).
  async avisarSinWhatsapp(waMessageId) {
    const sb = db();
    const { data: msg } = await sb.from("wa_mensajes").select("cliente_id,plantilla:contenido->template->>name").eq("wa_message_id", waMessageId).maybeSingle();
    const plantilla = String(msg?.plantilla ?? "");
    if (!msg?.cliente_id || !/^voltra_(confirmacion_pedido|recordatorio_confirmacion|ultimo_aviso_confirmacion)/.test(plantilla)) return;
    const { data: ped } = await sb.from("shopify_pedidos").select("shopify_order_id,nombre,telefono,total,creado_en,raw")
      .eq("cliente_id", msg.cliente_id).eq("es_borrador", false).order("creado_en", { ascending: false }).limit(1).maybeSingle();
    if (!ped?.telefono) return;
    if (!(await guardarEventoCrudo(FUENTE, `sin_whatsapp:${ped.shopify_order_id}`, { wamid: waMessageId }))) return; // ya avisado
    const raw = (ped.raw ?? {}) as { shipping_address?: { first_name?: string; city?: string }; line_items?: Array<{ title?: string; quantity?: number }> };
    const nombre = raw.shipping_address?.first_name ?? "";
    const desde = new Date(Date.now() - 7 * 86_400_000).toISOString();
    const [todos, convs] = await Promise.all([
      sb.from("wa_clientes").select("id,telefono,nombre").not("telefono", "is", null).limit(20000),
      sb.from("wa_conversaciones").select("cliente_id,ultima_entrada_en").gte("ultima_entrada_en", desde).limit(5000),
    ]);
    const ultima = new Map<string, string>();
    for (const c of convs.data ?? []) if (c.ultima_entrada_en && (!ultima.has(c.cliente_id) || c.ultima_entrada_en > ultima.get(c.cliente_id)!)) ultima.set(c.cliente_id, c.ultima_entrada_en);
    const cands = candidatosWhatsapp(ped.telefono, nombre, (todos.data ?? []).map((c) => ({ telefono: c.telefono, nombre: c.nombre, ultima_vez: ultima.get(c.id) ?? null })), new Date());
    const productos = (raw.line_items ?? []).map((l) => `${l.quantity ?? 1} ${(l.title ?? "").split(":")[0]}`).join(" + ");
    const hora = new Date(ped.creado_en).toLocaleTimeString("es-PY", { timeZone: "America/Asuncion", hour: "2-digit", minute: "2-digit" });
    const lineasCand = cands.map((c) => `• ${telefonoLocal(c.telefono)} — ${c.motivo === "un_digito" ? "número a 1 dígito del que cargó" : "mismo nombre, escribió esta semana"}`);
    await avisar(escaparHtml(
      `📵 ${ped.nombre} sin WhatsApp — ${nombre}, ${raw.shipping_address?.city ?? ""}, ${productos}, ${Number(ped.total).toLocaleString("es-PY")} (${hora}).\n` +
      `WhatsApp no entrega al número que cargó: ${telefonoLocal(ped.telefono)}\n👉 Llamalo o mandale SMS para confirmar.` +
      (lineasCand.length ? `\nPosible WhatsApp real:\n${lineasCand.join("\n")}\nSi es él, pasame el OK y le mando la confirmación ahí.` : ""),
    ));
  },

  async clienteDeMensaje(waMessageId) {
    const { data, error } = await db().from("wa_mensajes").select("cliente_id").eq("wa_message_id", waMessageId).maybeSingle();
    falla("cliente del mensaje", error);
    return (data?.cliente_id as string | null) ?? null;
  },
};

// 20-10: plazos con la tabla de tarifas por courier (caché de 10 min; nunca lanza, tope 4 s; si falla, los de siempre).
Deno.serve(async (req) => {
  await cargarTarifasCourier(db());
  return manejarRequest(req, depsReales, {
    verifyToken: Deno.env.get("WA_VERIFY_TOKEN") ?? "",
    appSecret: Deno.env.get("WA_APP_SECRET") ?? "",
    verificarFirma: verificarFirmaMeta,
    enSegundoPlano: (p) => {
      if (typeof EdgeRuntime !== "undefined" && EdgeRuntime?.waitUntil) EdgeRuntime.waitUntil(p);
      else p.catch((e) => console.error(e));
    },
  });
});
