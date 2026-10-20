// Lógica del webhook de WhatsApp (sin I/O directo: todo entra por `Deps`).
// Dueño: subagente B (ola 1). El I/O real está en index.ts.

import { avisoParaCourier, datosCourierDesdeRaw } from "../_shared/texto_courier.ts";
import { esAceptacion as esAceptacionVendedor } from "../_shared/vendedor/herramientas.ts";
import { diaEntrega, leerEntregaProgramada, plazoParaEnDesdeHoy, textoEntregaProgramada } from "../_shared/plazo_zona.ts";
import {
  CLAVE_CONFIG_PRIORIDAD,
  type CfgPagoPrioridad,
  leerConfigPagoPrioridad,
  motivoSinOfertaPrioridad,
  pedidoPagado,
  TAG_COMPROBANTE_PAGO,
  TAG_OFERTA_PAGO,
  TAG_PRIORIDAD,
  textoOfertaPrioridad,
} from "../_shared/pago_anticipado.ts";
import { deducirProductoAnuncio, marcaAnuncio, marcaTextoAnuncio, textoDelAnuncio, type ReferralMeta } from "../_shared/anuncios.ts";
import { detectarLinkMapas, type LinkMapas, textoLinkMapas } from "../_shared/link_mapas.ts";
import { enlaceWaMe, escaparHtml } from "../_shared/telegram_formato.ts";
import {
  botonesPermisoOfertas,
  datosFormularioPedido,
  type Interactivo,
  parsearContacto,
  parsearFlow,
  parsearUbicacion,
  TEXTO_PERMISO_OFERTAS,
} from "../_shared/wa_interactivos.ts";
import { aTextoPlano, textoDeEntrante } from "../_shared/vendedor/interactivos.ts";
import { esDerivacionDeVenta } from "../_shared/vendedor/herramientas.ts";
import { esImagenVisible, mimeBase, textoImagenNoVista } from "../_shared/vendedor/imagenes.ts";
import { CFG_VENDEDOR_DEFAULT } from "../_shared/vendedor/tipos.ts";
import { esPedidoDeBaja, PLANTILLAS_RECOMPRA } from "../recompra/calendario.ts";

// ---------- tipos ----------

export type Contacto = {
  wa_id?: string;
  user_id?: string;
  parent_user_id?: string;
  profile?: { name?: string; username?: string };
};

export type MensajeMeta = {
  id: string;
  from?: string;
  from_user_id?: string;
  timestamp?: string;
  type: string;
  text?: { body?: string };
  audio?: { id?: string; mime_type?: string; voice?: boolean };
  image?: { id?: string; mime_type?: string; caption?: string };
  sticker?: { id?: string; mime_type?: string; animated?: boolean };
  video?: { id?: string; mime_type?: string; caption?: string };
  document?: { id?: string; mime_type?: string; filename?: string; caption?: string };
  button?: { payload?: string; text?: string };
  interactive?: {
    type?: string;
    button_reply?: { id?: string; title?: string };
    list_reply?: { id?: string; title?: string };
    nfm_reply?: { response_json?: string; body?: string; name?: string }; // WhatsApp Flow (ola 2)
  };
  /** Click-to-WhatsApp: anuncio de Meta por el que entró (source_id = id del anuncio, headline, body, source_url, ctwa_clid). */
  referral?: ReferralMeta;
  [k: string]: unknown;
};

export type EstadoMeta = {
  id: string;
  status: "sent" | "delivered" | "read" | "failed" | string;
  timestamp?: string;
  recipient_id?: string;
  recipient_user_id?: string;
  pricing?: { billable?: boolean; pricing_model?: string; category?: string; type?: string };
  errors?: unknown[];
};

export type Evento =
  | { clase: "mensaje"; idExterno: string; mensaje: MensajeMeta; contacto: Contacto | null }
  | { clase: "estado"; idExterno: string; estado: EstadoMeta }
  // Cambios de webhook que no son `messages` (calidad del número, cuenta, plantillas).
  // Solo se guardan en eventos_crudos (los lee salud-canal); idExterno se calcula en recibirPayload.
  | { clase: "cambio"; idExterno: string; cambio: CambioMeta };

export type CambioMeta = { field: string; value: unknown; entry_id: string | null; time: number | null };

export type Pedido = {
  shopify_order_id: number | string;
  nombre?: string | null;
  cliente_id?: string | null;
  telefono?: string | null;
  estado_confirmacion: string;
  estado_envio?: string | null;
  tags?: string[] | null;
  courier?: string | null;
  creado_en?: string | null;
  raw?: Record<string, unknown> | null;
  total?: number | string | null;
};

export type AccionConf = "conf_si" | "conf_corregir" | "conf_cancelar";

export type ResultadoEnvio = { ok: boolean; wa_message_id?: string; error?: string };
export type BotonAviso = { texto: string; callback?: string; url?: string };

export interface Deps {
  ahora(): Date;
  config(clave: string): Promise<unknown | null>;
  // eventos crudos
  guardarEventoCrudo(idExterno: string, payload: unknown): Promise<boolean>;
  marcarEventoProcesado(idExterno: string, error: string | null): Promise<void>;
  // clientes y conversaciones
  upsertCliente(d: { wa_user_id: string | null; telefono: string | null; wa_username: string | null; nombre: string | null }): Promise<{ id: string; nombre?: string | null }>;
  conversacionActiva(clienteId: string, origenAnuncioId: string | null): Promise<Conversacion>;
  actualizarConversacion(id: string, cambios: { estado?: string; ultima_entrada_en?: string }): Promise<void>;
  // mensajes
  insertarMensajeEntrante(fila: Record<string, unknown>): Promise<boolean>; // false = repetido
  completarContenidoMensaje(waMessageId: string, extra: Record<string, unknown>): Promise<void>;
  estadoMensaje(waMessageId: string): Promise<string | null | undefined>; // undefined = no existe
  actualizarMensaje(waMessageId: string, cambios: Record<string, unknown>): Promise<void>;
  copiarAudio(mediaId: string, ruta: string): Promise<{ ok: boolean; ruta?: string; mime?: string; error?: string }>;
  // pedidos
  buscarPedido(orderId: string): Promise<Pedido | null>;
  pedidosPorEstado(clienteId: string, telefono: string | null, estado: string, desdeISO: string | null): Promise<Pedido[]>;
  actualizarPedido(orderId: string, cambios: { estado_confirmacion: string; tags: string[] }): Promise<void>;
  cancelarEnviosPendientes(orderId: string, patrones: string[]): Promise<number>;
  // externos (C, D y wa.ts)
  agregarTags(orderGid: string, tags: string[]): Promise<unknown>;
  quitarTags(orderGid: string, tags: string[]): Promise<unknown>;
  avisar(texto: string, botones?: BotonAviso[][]): Promise<unknown>;
  enviarTexto(to: string, texto: string, opts: { clienteId: string; conversacionId: string }): Promise<ResultadoEnvio>;
  enviarBotones(
    to: string,
    texto: string,
    botones: { id: string; titulo: string }[],
    opts: { clienteId: string; conversacionId: string },
  ): Promise<ResultadoEnvio>;
  // consentimiento de marketing (día 0)
  consentimientoMarketing(clienteId: string): Promise<"si" | "no" | "baja" | null>;
  registrarConsentimiento(clienteId: string, estado: "si" | "no", origen: string): Promise<void>;
  marcarLeidoYEscribiendo(messageId: string): Promise<unknown>;
  normalizarTelefono(x: string): string | null;
  // ---- ola 2 (G1): vendedor con IA. Opcionales: sin ellas el webhook se comporta como en la ola 1. ----
  /** Pasa el mensaje a la función vendedor (en producción: EdgeRuntime.waitUntil + fetch con service role). */
  pasarAlVendedor?(d: EntradaVendedor): Promise<void>;
  /** Transcribe el audio ya copiado a Storage (_shared/transcripcion.ts, G2). */
  transcribirAudio?(ruta: string, mime: string | null): Promise<Transcripcion>;
  /** Sigue el link corto de Google Maps y saca coordenadas/lugar (_shared/link_mapas.ts). */
  resolverLinkMapas?(url: string): Promise<LinkMapas>;
  /** Guarda el teléfono que el cliente compartió con el botón REQUEST_CONTACT_INFO (si no tenía). */
  guardarTelefonoCliente?(clienteId: string, telefono: string): Promise<void>;
  // ---- integración olas 3-4. Opcionales: sin ellas, los botones mk_* y la baja solo avisan a Enrique. ----
  /** recompra/baja.ts: baja de marketing (consentimiento 'baja' + cancela envíos y planes). */
  registrarBaja?(clienteId: string, origen: "boton" | "chat" | "meta_131050"): Promise<{ ok: boolean; error?: string }>;
  /** Último envío de marketing ya enviado al cliente (del pedido si viene) → qué oferta aceptó. */
  ofertaMarketing?(clienteId: string, orderId: string | null): Promise<OfertaEnviada | null>;
  /** 08-10: "Más adelante" → la conversación queda como si ya tuviera los 2 recontactos (no se insiste por 7 días). */
  bloquearSeguimientos?(conversacionId: string): Promise<void>;
  /** 08-10: contexto de clientes de Facial Wellness que recibieron la recompra (config_wa.recompra_fw_contexto). */
  contextoRecompraFw?(telefono: string | null): Promise<{ producto: string; dias: number; entrega?: { nombre: string; ciudad: string; direccion: string } } | null>;
  /** pago-qr-webhook/io.ts ofrecerCobroQR (solo se llama con config_wa['ola4.qr'].activo). */
  ofrecerCobroQR?(orderId: number): Promise<{ ok: true; texto: string } | { ok: false; motivo: string }>;
  /** cliente_id del mensaje saliente (para el 131050 que llega en el estado 'failed'). */
  clienteDeMensaje?(waMessageId: string): Promise<string | null>;
  /**
   * Señales de que Enrique (o una derivación dura) tiene el chat desde `desdeISO` (ver motivoParaNoRetomar).
   * Sin esto, un chat en 'humano' nunca vuelve solo a la IA (comportamiento de la ola 1).
   */
  actividadHumana?(d: { conversacionId: string; clienteId: string; desdeISO: string }): Promise<ActividadHumana>;
  /** Copia una imagen o PDF de Meta a Storage wa-media (comprobante de pago anticipado). Sin esto, solo va el media id. */
  copiarMedia?(mediaId: string, ruta: string): Promise<{ ok: boolean; ruta?: string; mime?: string; error?: string }>;
  /** Copia a Storage wa-media la imagen, el sticker, el video o el documento que manda el cliente, para poder verlo en la Bandeja (la URL de Meta vence a los 5 min). Aparte de copiarMedia: eso es solo para comprobantes. */
  copiarMediaChat?(mediaId: string, ruta: string): Promise<{ ok: boolean; ruta?: string; mime?: string; error?: string }>;
  /**
   * 08-10: perfil del vendedor de la conversación (wa_conversaciones.perfil_vendedor; null = sin perfil). Para no
   * repetir la marca del anuncio cuando ya se sabe el producto. Si falla (o no está), la marca va solo en el mensaje
   * que trae el referral del anuncio.
   */
  perfilConversacion?(conversacionId: string): Promise<{ producto?: unknown; pidio_testimonio_en?: unknown; testimonio_pedido?: unknown } | null>;
  /** Texto del último mensaje que mandamos en la conversación (para saber si el "no" responde a una confirmación). 10-10. */
  ultimoTextoNuestro?(conversacionId: string): Promise<string | null>;
  /**
   * 19-10 (#1072): último mensaje que le mandamos a este cliente, en cualquier conversación y sin los fallidos (la
   * plantilla de confirmación de un cliente nuevo queda sin conversación). Para saber si un "sí" escrito responde a la
   * confirmación del pedido o a otra pregunta. Sin esto (o si falla), el "sí" se toma como antes.
   */
  ultimoSalienteCliente?(clienteId: string): Promise<Saliente | null>;
  /** Escribe (o borra con null) una clave del perfil de la conversación sin tocar el resto. 09-10. */
  marcarPerfil?(conversacionId: string, clave: string, valor: string | null): Promise<void>;
  /** 12-10: manda un `interactive` armado con _shared/wa_interactivos.ts (permiso para ofertas). Sin esto, enviarBotones. */
  enviarInteractivo?(to: string, interactivo: Interactivo, opts: { clienteId: string; conversacionId: string }): Promise<ResultadoEnvio>;
  /** 12-10: ¿ya se le mandaron alguna vez los botones de permiso para ofertas (cons_si:<cliente_id>)? */
  permisoOfertasPedido?(clienteId: string): Promise<boolean>;
  /**
   * 12-10: reserva la oferta de pago con prioridad del pedido (envios_programados `prio:<id>`, ya 'enviado').
   * false = ya existía (salió por otra vía): no se manda de nuevo.
   */
  reservarOfertaPrioridad?(orderId: string, clienteId: string): Promise<boolean>;
  /** 12-10: resultado del envío de la oferta reservada (guarda el wa_message_id, o 'fallido' con el error). */
  cerrarOfertaPrioridad?(orderId: string, r: ResultadoEnvio): Promise<void>;
  /** 12-10: ¿ya llegó un comprobante para este pedido? (wa_mensajes.contenido.comprobante_pago_anticipado) */
  comprobanteRecibido?(orderId: string): Promise<boolean>;
  /**
   * 12-10: aviso a Enrique por Telegram con el archivo (foto o PDF del comprobante) y botones. `texto` es plano (se
   * escapa en index.ts). `ruta`: copia en Storage wa-media (si no, se baja de Meta con el media id).
   */
  avisarConArchivo?(
    texto: string,
    botones: BotonAviso[][],
    archivo: { mediaId: string; ruta: string | null; mime: string; nombre: string },
  ): Promise<{ ok: boolean; error?: string }>;
  // ---- 13-10: testimonios (tabla testimonios, migración 20261013000010). Opcionales: sin ellas, como el 09-10. ----
  /** Guarda el testimonio. null = ya estaba (mismo wa_message_id). */
  guardarTestimonio?(t: TestimonioNuevo): Promise<{ id: string } | null>;
  /** Respuesta al permiso: solo si es del cliente y todavía no respondió (autorizado null). true si cambió. */
  responderPermisoTestimonio?(id: string, clienteId: string, autorizado: boolean): Promise<boolean>;
  /** Cuántos testimonios autorizados hay (para los hitos de 5 en 5). */
  contarTestimoniosAutorizados?(): Promise<number>;
  /** Registra el hito (5, 10, 15…) UNA vez. true si es nuevo: recién ahí se avisa a Enrique. */
  registrarHitoTestimonios?(hito: number): Promise<boolean>;
  /**
   * 13-10: ¿le mandamos (no fallido: después pasa a entregado o leído) la oferta de rescate antes de cancelar este pedido en esta conversación
   * desde `desdeISO`? (wa_mensajes saliente con el botón resc_prog:<id>). Sin esto, solo "Cancelar igual" cancela.
   */
  ofertaRescateDesde?(conversacionId: string, orderId: string, desdeISO: string): Promise<boolean>;
}

/** 13-10: fila nueva de `testimonios`. Nunca se publica nada solo: Enrique elige qué usar. */
export type TestimonioNuevo = {
  cliente_id: string;
  shopify_order_id: number | null;
  tipo: "foto" | "video" | "texto";
  /** Copia en Storage wa-media (la que ya hace copiarMediaChat para la Bandeja); null en los de texto o si falló. */
  ruta_storage: string | null;
  texto: string | null;
  producto: string | null;
  wa_message_id: string;
};

/** Conversación activa. `origen_anuncio_id`: anuncio por el que entró (se guarda al crearla). */
export type Conversacion = { id: string; estado: string; origen_anuncio_id?: string | null };

/** Lo que pasó en el chat en las últimas `retomar_humano_h` horas que indica que Enrique lo está atendiendo. */
export type ActividadHumana = {
  /** Mensajes que Enrique mandó desde el número de la tienda (bandeja → wa-enviar-manual, marcados origen 'manual'). */
  salidasManuales: number;
  /** Tocó "Le escribo yo" en Telegram por un pedido de este cliente (tomó el chat explícitamente). */
  escribo: boolean;
  /** Motivos de derivar_a_enrique del vendedor IA (vendedor_turnos). */
  derivaciones: string[];
  /** Mensajes entrantes del período (para ver botones que pasan el chat a humano: conf_*, ayuda, ne_direccion, seg_problema). */
  entrantes: MensajeMeta[];
};

export type OfertaEnviada = { plantilla: string; variables: unknown };

export type EntradaVendedor = {
  conversacion_id: string;
  cliente_id: string;
  wa_message_id: string;
  texto: string;
  /** 08-10: foto del cliente ya copiada a Storage wa-media (el vendedor la descarga y el modelo la ve). */
  imagen?: { ruta: string; mime: string };
};
export type Transcripcion = {
  ok: boolean;
  texto: string;
  confianza?: number;
  confianzaBaja?: boolean;
  simulado?: boolean;
  error?: string;
};

// ---------- defaults (se usan solo si falta la clave en config_wa; se reportan en el log) ----------

export const ACEPTACIONES_DEFAULT = ["si", "sí", "ok", "okay", "dale", "ya", "katu", "mandame katu", "si luego", "confirmo"];

// Claves de config_wa.respuestas_confirmacion (se acepta también la acción: conf_si, ...).
export const CLAVE_RESPUESTA: Record<AccionConf, string> = {
  conf_si: "confirmado",
  conf_corregir: "a_corregir",
  conf_cancelar: "cancelado",
};

export const RESPUESTAS_DEFAULT: Record<AccionConf, string> = {
  conf_si: "Listo {nombre}, quedó confirmado. Te llega en {plazo}; te avisamos cuando lo preparemos.",
  conf_corregir: "Dale, escribime acá el dato correcto (dirección, ciudad o referencia) y lo cambiamos.",
  conf_cancelar: "Entendido, cancelamos tu pedido. Si más adelante lo querés, escribinos por acá.",
};

// Coinciden por subcadena con envios_programados.plantilla. C programa:
// 'voltra_recordatorio_confirmacion', 'accion:retener' y 'accion:cancelar'.
export const PATRONES_CANCELABLES_DEFAULT = ["recordatorio", "retener", "cancelar"];


// Botones de las plantillas de F (procesar-envios) y del consentimiento del día 0.
export type AccionBoton =
  | "ayuda"
  | "ne_reintentar"
  | "ne_direccion"
  | "ne_cancelar"
  | "seg_bien"
  | "seg_problema"
  | "cons_si"
  | "cons_no";

// Textos de config_wa.textos_botones. {nombre} y {pedido} se reemplazan.
export const TEXTOS_BOTONES_DEFAULT: Record<string, string> = {
  ayuda: "Dale {nombre}, contame qué necesitás con tu pedido {pedido} y te ayudo por acá.",
  ne_reintentar: "Listo {nombre}, coordinamos con el courier para intentar de nuevo la entrega de tu pedido {pedido}. Te avisamos el día que pase.",
  ne_direccion: "Dale {nombre}, escribime acá la dirección nueva (calle, número, ciudad y una referencia) y la cambiamos.",
  ne_cancelar: "Entendido {nombre}, le pasamos tu pedido {pedido} al equipo para cancelarlo. Si cambiás de idea, escribinos por acá.",
  seg_problema: "Entiendo {nombre}. Contame qué pasó con el producto y lo vemos ahora. Si me mandás una foto, lo resolvemos más rápido.",
  seg_bien_ya: "Gracias {nombre}, qué bueno que llegó todo bien.",
  // 13-10: también un comentario corto; el permiso para mostrarlo se pide aparte (botones tst_si / tst_no).
  pedir_testimonio: "Una cosita más 🙏 ¿Nos mandás una foto o un video cortito usándolo, o nos contás en una frase qué te pareció? Nos ayuda muchísimo a que otros se animen a probar.",
  gracias_testimonio: "¡Gracias {nombre}! Nos ayuda un montón 🙌",
  permiso_testimonio: "¡Gracias {nombre}! Nos ayuda un montón 🙌\n¿Podemos mostrar {que} en nuestras redes? Va sin tu nombre ni tu número.",
  // Etiquetas de botón: máximo 20 caracteres.
  permiso_testimonio_si: "Sí, podés usarla",
  permiso_testimonio_no: "No, prefiero que no",
  tst_si: "¡Genial, gracias {nombre}! Va sin tu nombre ni tu número.",
  tst_no: "Perfecto {nombre}, queda solo para nosotros. ¡Gracias igual!",
  consentimiento: "¡Qué bueno {nombre}! ¿Te puedo avisar por acá cuando se te estén por acabar y cuando haya novedades de Voltra?",
  consentimiento_si: "Sí, avisame",
  consentimiento_no: "No, gracias",
  cons_si: "Listo, te avisamos por acá. Si en algún momento no querés más avisos, escribí BAJA.",
  cons_no: "Entendido, no te mandamos novedades. Seguimos por acá para lo que necesites con tus pedidos.",
  // 12-10: botones del aviso de la víspera y del pago anticipado opcional.
  ent_ok: "Genial, gracias {nombre}!",
  reprogramar_sin_vendedor: "Dale {nombre}, ¿qué día te queda mejor para recibirlo? El repartidor te contacta antes de salir para coordinar.",
  corregir_sin_vendedor: "Dale {nombre}, escribime acá el dato correcto (dirección, ciudad o referencia) y lo cambiamos.",
  pago_al_recibir: "Por ahora el pago es al recibir: pagás en efectivo cuando te llega tu pedido {pedido} 🙌",
  pago_ya_hecho: "Tu pedido {pedido} ya figura pagado ✅ No pagás nada al recibir.",
  // 13-10: rescate antes de cancelar (botones resc_prog / resc_cancel:<id>). Títulos ≤ 20 caracteres.
  rescate_cancelar: "Antes de cancelar: ¿te sirve que te lo llevemos otro día, en otro horario o que lo reciba otra persona? Decime y lo programamos 🙌",
  rescate_boton_programar: "Programar otro día",
  rescate_boton_cancelar: "Cancelar igual",
  programar_sin_vendedor: "Dale {nombre}, ¿qué día y en qué horario te queda bien recibir tu pedido {pedido}? Lo programamos.",
  ya_cancelado: "Tu pedido {pedido} ya está cancelado. Si lo querés de nuevo, escribime por acá y lo armamos 🙌",
  ya_entregado: "Tu pedido {pedido} ya figura entregado, así que no se puede cancelar. Si tuviste algún problema con el producto, contame y lo vemos 🙏",
};

// config_wa.textos_marketing (supabase/seed_integracion.sql).
export const TEXTOS_MARKETING_DEFAULT: Record<string, string> = {
  baja_confirmada: "Listo, no te vamos a mandar más ofertas. Si necesitás algo de tu pedido, escribinos por acá.",
  mas_adelante: "Dale, sin problema. Cuando quieras, escribinos por acá.",
};

export type AccionMk = "mk_si" | "mk_luego" | "mk_pack" | "mk_una" | "mk_quiero" | "mk_baja";

const TAG: Record<AccionConf, string> = {
  conf_si: "CONFIRMADO",
  conf_corregir: "A_CORREGIR",
  conf_cancelar: "CANCELADO_CLIENTE",
};
const ESTADO: Record<AccionConf, string> = {
  conf_si: "confirmado",
  conf_corregir: "a_corregir",
  conf_cancelar: "cancelado_cliente",
};
const TAGS_CONF = Object.values(TAG);

// ---------- funciones puras ----------

/** Separa el payload de Meta en eventos con su id externo (para deduplicar en eventos_crudos). */
export function extraerEventos(payload: unknown): Evento[] {
  const out: Evento[] = [];
  const entries = (payload as { entry?: unknown[] })?.entry;
  if (!Array.isArray(entries)) return out;
  for (const entry of entries) {
    for (const ch of ((entry as { changes?: unknown[] }).changes ?? []) as { field?: string; value?: Record<string, unknown> }[]) {
      if (ch.field && ch.field !== "messages") {
        const e = entry as { id?: unknown; time?: unknown };
        out.push({
          clase: "cambio",
          idExterno: "",
          cambio: {
            field: ch.field,
            value: ch.value ?? null,
            entry_id: typeof e.id === "string" ? e.id : null,
            time: typeof e.time === "number" ? e.time : null,
          },
        });
        continue;
      }
      if (ch.field !== "messages" || !ch.value) continue;
      const contactos = (ch.value.contacts ?? []) as Contacto[];
      for (const m of (ch.value.messages ?? []) as MensajeMeta[]) {
        if (!m?.id) continue;
        const c = contactos.find((x) =>
          (m.from_user_id && x.user_id === m.from_user_id) || (m.from && x.wa_id === m.from)
        ) ?? (contactos.length === 1 ? contactos[0] : null);
        out.push({ clase: "mensaje", idExterno: `msg:${m.id}`, mensaje: m, contacto: c });
      }
      for (const s of (ch.value.statuses ?? []) as EstadoMeta[]) {
        if (!s?.id) continue;
        out.push({ clase: "estado", idExterno: `st:${s.id}:${s.status}`, estado: s });
      }
    }
  }
  return out;
}

function idDeBoton(m: MensajeMeta): string {
  const id = m.type === "interactive"
    ? m.interactive?.button_reply?.id
    : m.type === "button"
    ? m.button?.payload
    : undefined;
  return (id ?? "").trim();
}

/** Botón de confirmación: interactivo (button_reply.id) o de plantilla (button.payload). */
export function leerBotonConfirmacion(m: MensajeMeta): { accion: AccionConf; orderId: string } | null {
  const r = /^(conf_si|conf_corregir|conf_cancelar):(\d+)$/.exec(idDeBoton(m));
  return r ? { accion: r[1] as AccionConf, orderId: r[2] } : null;
}

/** Botones post-venta: `<accion>:<shopify_order_id>` y consentimiento `cons_si|cons_no:<cliente_id>`. */
export function leerBotonPostventa(m: MensajeMeta): { accion: AccionBoton; id: string } | null {
  const id = idDeBoton(m);
  const r = /^(ayuda|ne_reintentar|ne_direccion|ne_cancelar|seg_bien|seg_problema):(\d+)$/.exec(id);
  if (r) return { accion: r[1] as AccionBoton, id: r[2] };
  const c = /^(cons_si|cons_no):([A-Za-z0-9-]{1,64})$/.exec(id);
  return c ? { accion: c[1] as AccionBoton, id: c[2] } : null;
}

/** 12-10: botones de entrega y pago (sin Telegram a Enrique). */
export type AccionEntrega = "ent_ok" | "reprogramar" | "corregir" | "pago_ant";

/**
 * 12-10: `ent_ok` / `reprogramar` (aviso de la víspera, voltra_entrega_manana), `corregir` (confirmación v4) y
 * `pago_ant` (pago anticipado opcional), todos `<accion>:<shopify_order_id>`.
 */
export function leerBotonEntrega(m: MensajeMeta): { accion: AccionEntrega; id: string } | null {
  const r = /^(ent_ok|reprogramar|corregir|pago_ant):(\d+)$/.exec(idDeBoton(m));
  return r ? { accion: r[1] as AccionEntrega, id: r[2] } : null;
}

/** 13-10: botones de la oferta de rescate antes de cancelar: resc_prog / resc_cancel:<shopify_order_id>. */
export type AccionRescate = "resc_prog" | "resc_cancel";
export function leerBotonRescate(m: MensajeMeta): { accion: AccionRescate; orderId: string } | null {
  const r = /^(resc_prog|resc_cancel):(\d+)$/.exec(idDeBoton(m));
  return r ? { accion: r[1] as AccionRescate, orderId: r[2] } : null;
}

/**
 * Botones de las plantillas de recompra (voltra_mk_*): `<accion>:<shopify_order_id>` (0 = sin pedido).
 * Si la plantilla salió sin payload, Meta manda el texto del botón: "No quiero ofertas" también es baja.
 */
export function leerBotonMarketing(
  m: MensajeMeta,
  palabrasBaja?: string[],
): { accion: AccionMk; orderId: string | null; producto?: string } | null {
  const r = /^(mk_si|mk_luego|mk_pack|mk_una|mk_quiero|mk_baja)(?::(\d+))?$/.exec(idDeBoton(m));
  if (r) return { accion: r[1] as AccionMk, orderId: r[2] && r[2] !== "0" ? r[2] : null };
  // 07-10: campañas enviadas por fuera de la cola (recompra FW): el producto va en el botón, `mk_si:p-<handle>`.
  const p = /^(mk_si|mk_luego|mk_pack|mk_una|mk_quiero|mk_baja):p-([a-z0-9-]{2,80})$/.exec(idDeBoton(m));
  if (p) return { accion: p[1] as AccionMk, orderId: null, producto: p[2] };
  if (m.type === "button" && m.button?.text && esPedidoDeBaja(m.button.text, palabrasBaja)) {
    return { accion: "mk_baja", orderId: null };
  }
  return null;
}

const TITULO_MK: Record<string, string> = Object.fromEntries(
  Object.values(PLANTILLAS_RECOMPRA).flatMap((p) => p.botones.map((b) => [b.prefijo, b.titulo])),
);

/** "125000" o 125000 → "125.000"; un texto ya formateado queda igual. */
function precioGs(x: unknown): string {
  const s = String(x ?? "").trim();
  return /^\d+$/.test(s) ? s.replace(/\B(?=(\d{3})+(?!\d))/g, ".") : s;
}

/**
 * Lo que recibe el vendedor cuando el cliente acepta una oferta de recompra: qué tocó y qué oferta era
 * (variables del envío según PLANTILLAS_RECOMPRA), para que arme el pedido con crear_pedido_cod.
 */
const RE_AUTOMATICA = [
  /gracias por (comunicarte|comunicarse|contactarnos|escribirnos|tu mensaje|su mensaje)/u,
  /(te|le|les) (responder[eé]mos|contestar[eé]mos|atender[eé]mos)/u,
  /(me|nos) comunic(o|amos|ar[eé]) (a la brevedad|en breve|lo antes posible|pronto)/u,
  /(en este momento|ahora mismo) no (puedo|podemos|estoy|estamos)/u,
  /(fuera de|nuestro) horario de atenci[oó]n/u,
  /respuesta autom[aá]tica|mensaje autom[aá]tico/u,
  /si es (algo )?urgente,? (por favor )?(ll[aá]m|comunic)/u,
  /le saluda .{2,60}(asesor|atenci[oó]n|equipo)/u,
];

/** ¿Es un mensaje automático de bienvenida/ausencia del WhatsApp Business del cliente? (conservador: necesita 1 señal fuerte y algo de largo) */
export function esRespuestaAutomatica(texto: string): boolean {
  const t = (texto ?? "").toLowerCase();
  if (t.length < 40) return false;
  return RE_AUTOMATICA.some((re) => re.test(t));
}

/** "tiras-nasales-gudair-30-unidades" → "tiras nasales" (para el contexto del vendedor). */
export function productoDeHandle(handle: string): string {
  return handle.replace(/-(gudair|de-acero-inoxidable|\d+-unidades|\d+-ml|3-niveles)\b/g, "").replace(/-/g, " ").trim();
}

export function contextoOfertaAceptada(accion: AccionMk, oferta: OfertaEnviada | null, producto?: string): string {
  const boton = TITULO_MK[accion] ?? accion;
  const def = oferta ? PLANTILLAS_RECOMPRA[oferta.plantilla] : undefined;
  let v: Record<string, unknown> = {};
  if (oferta && def) {
    if (Array.isArray(oferta.variables)) def.vars.forEach((k, i) => (v[k] = (oferta.variables as unknown[])[i]));
    else if (oferta.variables && typeof oferta.variables === "object") v = oferta.variables as Record<string, unknown>;
  }
  const precio = (x: unknown) => (x == null || x === "" ? "" : ` a Gs ${precioGs(x)}`);
  let que = "";
  if (accion === "mk_una") que = `quiere solo 1 bolsa de ${v.producto ?? "lo que compró"} (no el pack; el precio sale del catálogo)`;
  else if (oferta?.plantilla === "voltra_mk_cruzada") que = `quiere ${v.producto_afin ?? "el producto ofrecido"}${precio(v.precio)}`;
  else if (oferta?.plantilla === "voltra_mk_lanzamiento") que = `quiere ${v.producto_nuevo ?? "el producto nuevo"}${precio(v.precio_cliente)}`;
  else if (def) que = `quiere ${v.oferta ?? "la oferta"} de ${v.producto ?? "lo que compró"}${precio(v.precio)}`;
  else if (producto) que = `quiere otra bolsa de ${productoDeHandle(producto)} (handle ${producto}; el precio sale del catálogo)`;
  else que = "aceptó una oferta de recompra, pero no encontré cuál: preguntale qué quiere";
  // 08-10: cierre directo. Ya dijo que sí: nada de preguntas antes de los datos.
  return `[oferta aceptada] Tocó "${boton}" en el mensaje de recompra: ${que}. ` +
    "Ya decidió comprar: en UN solo mensaje confirmá el producto, el precio con frase_precio y pedile nombre, ciudad y " +
    "dirección con referencia (si ya los tenés, armá el resumen con crear_pedido_cod). El ×2 va como una línea opcional, " +
    "nunca como pregunta antes de los datos. No expliques el producto: ya lo conoce.";
}

/** Texto legible de cualquier mensaje entrante. */
export function textoDeMensaje(m: MensajeMeta): string | null {
  switch (m.type) {
    case "text":
      return m.text?.body ?? null;
    case "button":
      return m.button?.text ?? null;
    case "interactive":
      return m.interactive?.button_reply?.title ?? m.interactive?.list_reply?.title ?? null;
    default:
      return null;
  }
}

export function normalizarTexto(t: string): string {
  return t.toLowerCase().normalize("NFD").replace(/[̀-ͯ]/g, "")
    .replace(/[^a-z0-9ñ\s]/g, " ").replace(/\s+/g, " ").trim();
}

/**
 * true si el mensaje es solo aceptación ("si dale", "ok", "mandame katu"). 08-10: misma regla que el vendedor
 * (también "Siiii", "sii dale", "dale amigo", "ya confirmé", "listo"); "no", "después", "pero" siguen sin contar.
 */
export function esAceptacion(texto: string, aceptaciones: string[]): boolean {
  return esAceptacionVendedor(texto, aceptaciones);
}

const RANGO: Record<string, number> = { enviado: 1, entregado: 2, leido: 3 };
const ESTADO_META: Record<string, string> = { sent: "enviado", delivered: "entregado", read: "leido", failed: "fallido" };

/** Estado nuevo del mensaje sin retroceder (Meta puede mandar los estados desordenados). null = no cambiar. */
export function siguienteEstado(actual: string | null | undefined, statusMeta: string): string | null {
  const nuevo = ESTADO_META[statusMeta];
  if (!nuevo) return null;
  if (nuevo === "fallido") return actual === "fallido" ? null : "fallido";
  if (actual === "fallido") return null;
  if ((RANGO[actual ?? ""] ?? 0) >= RANGO[nuevo]) return null;
  return nuevo;
}

/** Costo en USD según pricing del webhook y config_wa.tarifas_usd. null = sin dato. */
export function calcularCostoUsd(pricing: EstadoMeta["pricing"], tarifas: Record<string, number> | null): number | null {
  if (!pricing) return null;
  if (pricing.billable === false || (pricing.type ?? "").startsWith("free")) return 0;
  if (!tarifas) return null;
  const cat = pricing.category ?? "";
  const clave = cat === "utility"
    ? "utilidad"
    : cat === "marketing" || cat === "marketing_lite"
    ? "marketing"
    : cat === "service"
    ? (tarifas.servicio !== undefined ? "servicio" : "utilidad")
    : cat.startsWith("authentication")
    ? "autenticacion"
    : "";
  const v = tarifas[clave];
  return typeof v === "number" ? v : null;
}

export function renderizar(plantilla: string, vars: Record<string, string>): string {
  let t = plantilla.replace(/\s*\{nombre\}/g, vars.nombre ? ` ${vars.nombre}` : "");
  for (const [k, v] of Object.entries(vars)) t = t.replaceAll(`{${k}}`, v);
  return t;
}

export function primerNombre(...candidatos: unknown[]): string {
  for (const c of candidatos) {
    if (typeof c === "string" && c.trim()) return c.trim().split(/\s+/)[0];
  }
  return "";
}

function nombreDePedido(p: Pedido): unknown {
  const r = p.raw ?? {};
  const cust = r.customer as Record<string, unknown> | undefined;
  const ship = r.shipping_address as Record<string, unknown> | undefined;
  return ship?.first_name ?? cust?.first_name ?? cust?.firstName ?? null;
}

// ---------- HTTP ----------

export type EntornoHttp = {
  verifyToken: string;
  appSecret: string;
  verificarFirma: (raw: string, header: string | null, secret: string) => Promise<boolean>;
  enSegundoPlano: (p: Promise<unknown>) => void;
};

export async function manejarRequest(req: Request, deps: Deps, env: EntornoHttp): Promise<Response> {
  if (req.method === "GET") {
    const u = new URL(req.url);
    const ok = u.searchParams.get("hub.mode") === "subscribe" && !!env.verifyToken &&
      u.searchParams.get("hub.verify_token") === env.verifyToken;
    return ok ? new Response(u.searchParams.get("hub.challenge") ?? "", { status: 200 }) : new Response("forbidden", { status: 403 });
  }
  if (req.method !== "POST") return new Response("method not allowed", { status: 405 });

  const raw = await req.text();
  if (!(await env.verificarFirma(raw, req.headers.get("x-hub-signature-256"), env.appSecret))) {
    return new Response("firma inválida", { status: 401 });
  }
  let payload: unknown;
  try {
    payload = JSON.parse(raw);
  } catch {
    return new Response("json inválido", { status: 400 });
  }
  const r = await recibirPayload(payload, deps);
  if (!r.ok) return new Response("error guardando", { status: 500 }); // Meta reintenta
  env.enSegundoPlano(procesarEventos(r.nuevos, deps));
  return new Response("ok", { status: 200 });
}

/** Guarda cada evento en eventos_crudos ANTES de procesar y devuelve solo los nuevos. */
export async function recibirPayload(payload: unknown, deps: Deps): Promise<{ ok: boolean; nuevos: Evento[] }> {
  const nuevos: Evento[] = [];
  try {
    for (const ev of extraerEventos(payload)) {
      if (ev.clase === "cambio") ev.idExterno = await idDeCambio(ev.cambio);
      const crudo = ev.clase === "mensaje"
        ? { mensaje: ev.mensaje, contacto: ev.contacto }
        : ev.clase === "estado"
        ? { estado: ev.estado }
        : ev.cambio; // {field, value, ...}: la forma que lee salud-canal (salud.ts)
      if (await deps.guardarEventoCrudo(ev.idExterno, crudo)) nuevos.push(ev);
    }
    return { ok: true, nuevos };
  } catch (e) {
    console.error("guardarEventoCrudo:", e);
    return { ok: false, nuevos };
  }
}

export async function procesarEventos(eventos: Evento[], deps: Deps): Promise<void> {
  // Audios primero: la URL de Meta vence a los 5 min.
  const orden = [...eventos].sort((a, b) => peso(a) - peso(b));
  for (const ev of orden) {
    let error: string | null = null;
    try {
      if (ev.clase === "mensaje") await procesarMensaje(ev.mensaje, ev.contacto, deps);
      else if (ev.clase === "estado") await procesarEstado(ev.estado, deps);
      // "cambio": no se procesa acá; queda en eventos_crudos para salud-canal.
    } catch (e) {
      error = e instanceof Error ? e.message : String(e);
      console.error(`evento ${ev.idExterno}:`, error);
    }
    await deps.marcarEventoProcesado(ev.idExterno, error).catch(() => {});
  }
}

/** id_externo de un cambio que no es `messages`: `chg:<field>:<sha256>` (nunca empieza con msg: ni st:). */
export async function idDeCambio(c: CambioMeta): Promise<string> {
  const datos = new TextEncoder().encode(JSON.stringify([c.entry_id, c.time, c.field, c.value]));
  const hash = new Uint8Array(await crypto.subtle.digest("SHA-256", datos));
  return `chg:${c.field}:${[...hash].map((b) => b.toString(16).padStart(2, "0")).join("")}`;
}

function peso(ev: Evento): number {
  return ev.clase === "mensaje" && ev.mensaje.type === "audio" ? 0 : 1;
}

// ---------- estados (sent/delivered/read/failed) ----------

export async function procesarEstado(s: EstadoMeta, deps: Deps): Promise<void> {
  const actual = await deps.estadoMensaje(s.id);
  if (actual === undefined) throw new Error(`mensaje ${s.id} no está en wa_mensajes`);
  const cambios: Record<string, unknown> = {};
  const nuevo = siguienteEstado(actual, s.status);
  if (nuevo) cambios.estado = nuevo;
  if (s.pricing) {
    const tarifas = await deps.config("tarifas_usd") as Record<string, number> | null;
    cambios.categoria_precio = s.pricing.category ?? null;
    cambios.costo_usd = calcularCostoUsd(s.pricing, tarifas);
  }
  if (s.status === "failed" && s.errors) cambios.error = s.errors;
  if (Object.keys(cambios).length) await deps.actualizarMensaje(s.id, cambios);
  // 131050: el cliente apagó las ofertas en WhatsApp → baja de marketing (llega en el estado 'failed').
  if (s.status === "failed" && tieneCodigo(s.errors, 131050) && deps.registrarBaja && deps.clienteDeMensaje) {
    const cliente = await deps.clienteDeMensaje(s.id);
    if (cliente) {
      const r = await deps.registrarBaja(cliente, "meta_131050");
      if (!r.ok) throw new Error(`registrarBaja (131050): ${r.error}`);
    }
  }
}

function tieneCodigo(errores: unknown[] | undefined, codigo: number): boolean {
  return Array.isArray(errores) && errores.some((e) => Number((e as { code?: unknown })?.code) === codigo);
}

// ---------- mensajes entrantes ----------

export async function procesarMensaje(m: MensajeMeta, contacto: Contacto | null, deps: Deps): Promise<void> {
  const waId = m.from ?? contacto?.wa_id ?? null;
  const userId = m.from_user_id ?? contacto?.user_id ?? null;
  if (!waId && !userId) throw new Error("mensaje sin teléfono ni user_id");
  const telefono = waId ? (deps.normalizarTelefono(waId) ?? `+${waId.replace(/^\+/, "")}`) : null;

  const cliente = await deps.upsertCliente({
    wa_user_id: userId,
    telefono,
    wa_username: contacto?.profile?.username ?? null,
    nombre: contacto?.profile?.name ?? null,
  });
  const conv = await deps.conversacionActiva(cliente.id, m.referral?.source_id ?? null);
  const fechaMsg = m.timestamp ? new Date(Number(m.timestamp) * 1000) : deps.ahora();

  const nuevo = await deps.insertarMensajeEntrante({
    conversacion_id: conv.id,
    cliente_id: cliente.id,
    direccion: "in",
    wa_message_id: m.id,
    tipo: m.type,
    texto: textoDeMensaje(m),
    contenido: m,
    estado: "recibido",
  });
  if (!nuevo) return; // ya procesado
  await deps.actualizarConversacion(conv.id, { ultima_entrada_en: fechaMsg.toISOString() });

  if (m.type === "audio" && m.audio?.id) {
    const ruta = `audio/${cliente.id}/${m.id}.ogg`;
    const r = await deps.copiarAudio(m.audio.id, ruta);
    await deps.completarContenidoMensaje(m.id, r.ok ? { storage_path: r.ruta ?? ruta, mime: r.mime } : { storage_error: r.error });
    // Ola 2: conversación en 'ia' → transcribir y pasar al vendedor (aunque la copia haya fallado, el cliente recibe respuesta).
    if (conv.estado === "ia" && deps.pasarAlVendedor) {
      let t: Transcripcion = { ok: false, texto: "", error: r.ok ? "sin_transcriptor" : `audio_no_copiado: ${r.error}` };
      if (r.ok && deps.transcribirAudio) {
        t = await deps.transcribirAudio(r.ruta ?? ruta, r.mime ?? m.audio.mime_type ?? null)
          .catch((e) => ({ ok: false, texto: "", error: e instanceof Error ? e.message : String(e) }));
      }
      // 19-10: también el pedido abierto (sin esto, al que mandaba audios le volvía a pedir todos los datos).
      const texto = await conPedidoAbierto(
        deps,
        cliente.id,
        telefono,
        await conContextoRecompraFw(deps, telefono, await conMarcaDeAnuncio({ deps, m, conv, clienteId: cliente.id }, textoDeAudio(t))),
      );
      await deps.completarContenidoMensaje(m.id, {
        transcripcion: t.texto || null,
        confianza: t.confianza ?? null,
        transcripcion_simulada: !!t.simulado,
        transcripcion_error: t.ok ? null : (t.error ?? null),
        texto_vendedor: texto,
      });
      await deps.pasarAlVendedor({ conversacion_id: conv.id, cliente_id: cliente.id, wa_message_id: m.id, texto });
    }
    if (!r.ok) throw new Error(`audio no copiado: ${r.error}`);
    return;
  }

  // Bandeja: guarda lo que el cliente manda (foto, sticker, video, documento) para poder mostrarlo.
  // Si falla, el chat sigue igual: no se corta la conversación por no poder copiar un archivo.
  const mediaChat = mediaDeChat(m);
  let copiaChat: { ok: boolean; ruta?: string; mime?: string } | null = null;
  if (mediaChat && deps.copiarMediaChat) {
    const ruta = `media/${cliente.id}/${m.id}.${EXTENSION_CHAT[mediaChat.mime.split(";")[0].trim().toLowerCase()] ?? "bin"}`;
    const c = await deps.copiarMediaChat(mediaChat.id, ruta)
      .catch((e) => ({ ok: false, error: e instanceof Error ? e.message : String(e) } as { ok: boolean; ruta?: string; mime?: string; error?: string }));
    await deps.completarContenidoMensaje(m.id, c.ok ? { storage_path: c.ruta ?? ruta, mime: c.mime ?? mediaChat.mime } : { storage_error: c.error ?? "no se pudo copiar" })
      .catch(() => {});
    copiaChat = c.ok ? { ok: true, ruta: c.ruta ?? ruta, mime: c.mime ?? mediaChat.mime } : { ok: false };
  }

  const ctx: Ctx = { deps, m, clienteId: cliente.id, conv, telefono, destino: telefono ?? userId!, nombreWa: contacto?.profile?.name ?? cliente.nombre ?? null };

  // 09-10: foto o video después de pedirle testimonio (7 días) → gracias; no va al vendedor.
  // 13-10: se guarda en `testimonios` (con la copia de Storage de arriba) y se pide permiso para mostrarlo.
  if ((m.type === "image" || m.type === "video") && deps.perfilConversacion && deps.marcarPerfil) {
    const pt = await pedidoDeTestimonio(ctx);
    if (pt) {
      const caption = (m.type === "image" ? m.image?.caption : m.video?.caption)?.trim() || null;
      await aplicarTestimonio(ctx, pt, m.type === "video" ? "video" : "foto", copiaChat?.ok ? copiaChat.ruta ?? null : null, caption);
      return;
    }
  }

  // 13-10: botones del permiso para mostrar el testimonio (tst_si / tst_no:<id del testimonio>).
  const permiso = leerBotonTestimonio(m);
  if (permiso) {
    await aplicarPermisoTestimonio(ctx, permiso.autorizado, permiso.id);
    return;
  }

  const boton = leerBotonConfirmacion(m);
  if (boton) {
    // 13-10: "Cancelar pedido" ya no cancela al toque: primero la oferta de rescate (pedirCancelacion).
    if (boton.accion === "conf_cancelar") await pedirCancelacion(ctx, boton.orderId);
    else await aplicarRespuestaConfirmacion(ctx, boton.accion, boton.orderId);
    return;
  }
  const rescate = leerBotonRescate(m);
  if (rescate) {
    await aplicarBotonRescate(ctx, rescate.accion, rescate.orderId);
    return;
  }
  // 10-10: "Lo quiero igual" en el aviso de pedido dado de baja → el vendedor arma el resumen con los mismos datos.
  const reactivar = /^reactivar:(\d+)$/.exec(idDeBoton(m));
  if (reactivar) {
    await reactivarPedido(ctx, reactivar[1]);
    return;
  }
  const entrega = leerBotonEntrega(m);
  if (entrega) {
    await aplicarBotonEntrega(ctx, entrega.accion, entrega.id);
    return;
  }
  const post = leerBotonPostventa(m);
  if (post) {
    await aplicarBotonPostventa(ctx, post.accion, post.id);
    return;
  }

  // Ola 3: botones de recompra y pedido de baja (botón o texto "BAJA" / "No quiero ofertas").
  const recompra = await deps.config("recompra") as { palabras_baja?: unknown } | null;
  const palabrasBaja = Array.isArray(recompra?.palabras_baja) ? recompra!.palabras_baja as string[] : undefined;
  const mk = leerBotonMarketing(m, palabrasBaja);
  if (mk) {
    await aplicarBotonMarketing(ctx, mk.accion, mk.orderId, mk.producto);
    return;
  }
  if (m.type === "text" && m.text?.body && esPedidoDeBaja(m.text.body, palabrasBaja)) {
    await aplicarBaja(ctx, "chat");
    return;
  }

  if (m.type === "text" && m.text?.body) {
    const lista = await deps.config("aceptaciones");
    const aceptaciones = Array.isArray(lista) ? lista as string[] : (avisoDefault("aceptaciones"), ACEPTACIONES_DEFAULT);
    // 13-10: pedido de cancelar por texto. Con la oferta de rescate vigente (24 h), un segundo "cancelá" / "no"
    // cancela; si no, va la oferta de rescate (nunca se cancela al primer pedido).
    if (await cancelacionPorTexto(ctx, m.text.body)) return;
    // 10-10: "no", "ya no", "cancelá" justo después de un mensaje de confirmación → igual que el botón Cancelar.
    // 13-10: igual que el botón: oferta de rescate primero.
    // 19-10: el último mensaje al cliente se lee una sola vez (lo usan el "no" y el "sí").
    let saliente: Saliente | null | undefined;
    let salienteLeido = false;
    const ultimoSaliente = async () => {
      if (!salienteLeido) [saliente, salienteLeido] = [await leerUltimoSaliente(deps, cliente.id), true];
      return saliente;
    };
    const pideNo = esNoAConfirmacion(m.text.body);
    let ultimoEsConfirmacion = false;
    if (pideNo) {
      const u = await ultimoSaliente();
      if (u !== undefined) ultimoEsConfirmacion = !!u && esConfirmacionNuestra(u);
      else if (deps.ultimoTextoNuestro) {
        const t = await deps.ultimoTextoNuestro(conv.id).catch(() => null);
        ultimoEsConfirmacion = !!t && RE_PLANTILLA_CONF.test(t);
      }
    }
    if (ultimoEsConfirmacion) {
      const conf = (await deps.config("confirmacion")) as { cancelar_h?: number } | null;
      const desde = new Date(deps.ahora().getTime() - (conf?.cancelar_h ?? 72) * 3600_000).toISOString();
      const pendientes = await deps.pedidosPorEstado(cliente.id, telefono, "pendiente", desde);
      if (pendientes.length === 1) {
        await pedirCancelacion(ctx, String(pendientes[0].shopify_order_id), pendientes[0]);
        return;
      }
    }
    // 19-10 (#1072): el "sí" escrito confirma el pedido pendiente solo si responde a la confirmación (plantilla o
    // botones conf_si) o a un mensaje que pide confirmar el pedido tal cual. Si responde a otra pregunta ("¿te lo
    // cambio a 2?"), pasa al vendedor. Sin el dato (dependencia ausente o falla) o sin ningún mensaje nuestro, como antes.
    const acepta = esAceptacion(m.text.body, aceptaciones);
    const s = acepta ? await ultimoSaliente() : undefined;
    if (acepta && (s == null || siConfirmaPedido(s))) {
      const conf = (await deps.config("confirmacion")) as { cancelar_h?: number } | null;
      const horas = conf?.cancelar_h ?? 72;
      const desde = new Date(deps.ahora().getTime() - horas * 3600_000).toISOString();
      let pendientes = await deps.pedidosPorEstado(cliente.id, telefono, "pendiente", desde);
      // Si la confirmación era de otro pedido (el de los botones), no se confirma este: lo ve el vendedor.
      const idConf = s ? pedidoDeConfirmacion(s) : null;
      if (idConf) pendientes = pendientes.filter((p) => String(p.shopify_order_id) === idConf);
      if (pendientes.length === 1) {
        await aplicarRespuestaConfirmacion(ctx, "conf_si", String(pendientes[0].shopify_order_id), pendientes[0]);
        return;
      }
      if (pendientes.length > 1) {
        await deps.avisar(
          `Cliente ${ctx.nombreWa ?? ""} respondió "${m.text.body}" y tiene ${pendientes.length} pedidos pendientes (${
            pendientes.map((p) => p.nombre ?? p.shopify_order_id).join(", ")
          }). No confirmé ninguno solo: revisalo.`,
        );
        return;
      }
    }
    // Dato corregido: el cliente tenía un pedido a corregir → aviso a Enrique con el texto.
    const aCorregir = await deps.pedidosPorEstado(cliente.id, telefono, "a_corregir", null);
    if (aCorregir.length) {
      const p = aCorregir[0];
      await deps.avisar(`Corrección para ${p.nombre ?? p.shopify_order_id}: "${m.text.body}"`, [
        [{ texto: "Le escribo yo", callback: `escribo:${p.shopify_order_id}` }],
      ]);
      return;
    }
  }

  // 13-10: comentario corto después de pedirle testimonio (7 días) → testimonio de texto; no va al vendedor.
  if (m.type === "text" && m.text?.body && esComentarioTestimonio(m.text.body) && deps.perfilConversacion && deps.marcarPerfil &&
    deps.guardarTestimonio) {
    const pt = await pedidoDeTestimonio(ctx);
    if (pt) {
      await aplicarTestimonio(ctx, pt, "texto", null, m.text.body.trim().slice(0, 1000));
      return;
    }
  }

  // Pago anticipado: imagen o PDF de un cliente al que se le ofreció pagar por transferencia = comprobante.
  // Si no aplica, devuelve false y el mensaje sigue el camino de siempre (vendedor IA).
  if (await aplicarComprobantePago(ctx)) return;

  // Chat en 'humano' que nadie atiende en el número de la tienda: vuelve a la IA (regla en debeRetomarHumano).
  let estado = conv.estado;
  if (estado === "humano" && m.type === "text" && m.text?.body && deps.pasarAlVendedor && await debeRetomarHumano(conv.id, cliente.id, deps)) {
    await deps.actualizarConversacion(conv.id, { estado: "ia" });
    estado = "ia";
  }

  // Ola 2: el resto de los mensajes de una conversación en 'ia' va al vendedor con IA.
  if (estado === "ia" && deps.pasarAlVendedor) {
    const contacto = parsearContacto(m);
    if (contacto?.esPedidoDeContacto && contacto.telefonoE164 && !telefono && deps.guardarTelefonoCliente) {
      const tel = deps.normalizarTelefono(contacto.telefonoE164);
      if (tel) await deps.guardarTelefonoCliente(cliente.id, tel).catch((e) => console.error("guardar teléfono:", e));
    }
    let texto = textoParaVendedor(m);
    if (!texto) return;
    // 07-10: los mensajes automáticos del WhatsApp Business del cliente ("Gracias por comunicarte…", "me comunico a
    // la brevedad") no se contestan: quedan guardados y el vendedor no gasta ni responde algo raro.
    if (m.type === "text" && esRespuestaAutomatica(texto)) return;
    // 07-10: link de Google Maps pegado como texto → coordenadas y lugar, igual que el pin de WhatsApp.
    const link = m.type === "text" ? detectarLinkMapas(texto) : null;
    if (link && deps.resolverLinkMapas) {
      const l = await deps.resolverLinkMapas(link).catch(() => null);
      if (l) {
        texto = `${texto}\n${textoLinkMapas(l)}`;
        await deps.completarContenidoMensaje(m.id, { texto_vendedor: texto }).catch(() => {});
      }
    }
    // 08-10: foto (o documento imagen/*) → el vendedor la ve. Si no se pudo copiar, se lo dice el texto.
    let imagen: { ruta: string; mime: string } | undefined;
    if (esFotoParaVendedor(m, mediaChat)) {
      if (copiaChat?.ok && copiaChat.ruta && esImagenVisible(copiaChat.mime)) imagen = { ruta: copiaChat.ruta, mime: mimeBase(copiaChat.mime) };
      else texto = textoImagenNoVista(texto);
    }
    texto = await conMarcaDeAnuncio(ctx, texto);
    texto = await conContextoRecompraFw(deps, telefono, texto);
    texto = await conPedidoAbierto(deps, cliente.id, telefono, texto);
    if (m.type !== "text") await deps.completarContenidoMensaje(m.id, { texto_vendedor: texto });
    await deps.pasarAlVendedor({ conversacion_id: conv.id, cliente_id: cliente.id, wa_message_id: m.id, texto, ...(imagen ? { imagen } : {}) });
  }
}

/** Foto del cliente que el vendedor tiene que ver: imagen, o documento con mime image/* (los stickers no). */
export function esFotoParaVendedor(m: MensajeMeta, media: { mime: string } | null): boolean {
  if (!media) return false;
  if (m.type === "image") return true;
  return m.type === "document" && mimeBase(media.mime).startsWith("image/");
}

/**
 * 08-10: marca del anuncio ("[vino del anuncio de …, handle …]", _shared/anuncios.ts) antes del texto del cliente.
 * Va una vez por conversación: en el mensaje que trae el referral del anuncio, o (si la conversación nació de un
 * anuncio) mientras el perfil del vendedor todavía no tenga producto. Queda también en contenido.marca_anuncio
 * para que el orquestador la conserve en el historial. Si no se puede deducir el producto, el texto va igual.
 */
/**
 * 08-10: clientes de Facial Wellness que recibieron la recompra desde Voltra. Sin esto el bot les decía "no me
 * aparece ningún pedido a tu nombre" (las ventas de FW no están en la tienda de Voltra).
 */
export async function conContextoRecompraFw(deps: Deps, telefono: string | null, texto: string): Promise<string> {
  if (!deps.contextoRecompraFw) return texto;
  try {
    const c = await deps.contextoRecompraFw(telefono);
    if (!c) return texto;
    return `[cliente de Facial Wellness: compró ${c.producto} hace ~${c.dias} días; le ofrecimos otra bolsa por recompra]\n${texto}`;
  } catch {
    return texto;
  }
}

/** 19-10: un mensaje que le mandamos al cliente (wa_mensajes, direccion 'out'). */
export type Saliente = { tipo?: string | null; texto?: string | null; contenido?: unknown };

/** Plantillas de la secuencia de confirmación (texto guardado por _shared/wa.ts: "[plantilla <nombre>] …"). */
export const RE_PLANTILLA_CONF = /^\[plantilla voltra_(confirmacion_pedido|recordatorio_confirmacion|ultimo_aviso_confirmacion)/;

/** Último mensaje al cliente. undefined = no se pudo saber (sin dependencia o falló); null = nunca le escribimos. */
export async function leerUltimoSaliente(deps: Deps, clienteId: string): Promise<Saliente | null | undefined> {
  if (!deps.ultimoSalienteCliente) return undefined;
  try {
    return await deps.ultimoSalienteCliente(clienteId);
  } catch (e) {
    console.error("último mensaje al cliente:", e instanceof Error ? e.message : e);
    return undefined;
  }
}

/** ids de los botones de un mensaje nuestro: interactivo (reply.id) o plantilla (payload de cada botón). */
export function idsDeBotonesSalientes(s: Saliente): string[] {
  type O = Record<string, unknown>;
  const o = (x: unknown): O => (x && typeof x === "object" ? x as O : {});
  const lista = (x: unknown): unknown[] => (Array.isArray(x) ? x : []);
  const c = o(s.contenido);
  const ids: string[] = [];
  for (const b of lista(o(o(c.interactive).action).buttons)) {
    const id = o(o(b).reply).id;
    if (typeof id === "string") ids.push(id);
  }
  for (const k of lista(o(c.template).components)) {
    if (o(k).type !== "button") continue;
    for (const p of lista(o(k).parameters)) if (typeof o(p).payload === "string") ids.push(o(p).payload as string);
  }
  return ids;
}

/** ¿Es la confirmación del pedido (plantilla de la secuencia o mensaje con el botón conf_si:<id>, p. ej. la v4 en ventana)? */
export function esConfirmacionNuestra(s: Saliente): boolean {
  if (RE_PLANTILLA_CONF.test(s.texto ?? "")) return true;
  return idsDeBotonesSalientes(s).some((id) => /^conf_si:\d+$/.test(id));
}

/** Pedido de los botones conf_si:<id> del mensaje (null si no los trae). */
export function pedidoDeConfirmacion(s: Saliente): string | null {
  for (const id of idsDeBotonesSalientes(s)) {
    const r = /^conf_si:(\d+)$/.exec(id);
    if (r) return r[1];
  }
  return null;
}

/**
 * 19-10: el vendedor (o Enrique) le pidió confirmar el pedido TAL CUAL en un texto ("¿me confirmás el pedido? respondé
 * sí"). El vendedor no tiene herramienta para confirmar un pedido web: sin esto, después de responderle una duda el
 * "sí" quedaría dando vueltas. Si el texto propone un cambio (#1072: "¿te lo cambio a 2? … respondeme sí y lo
 * confirmo"), no cuenta: ese "sí" lo resuelve el vendedor con modificar_pedido.
 */
export function pideConfirmarTalCual(s: Saliente): boolean {
  if ((s.tipo ?? "text") !== "text") return false;
  const n = normalizarTexto(s.texto ?? "");
  if (!/\bconfirm/.test(n)) return false;
  return !RE_PROPONE_CAMBIO.test(n);
}

/** Palabras de un mensaje que propone cambiar el pedido (cantidad, producto, agregar o sacar algo). */
const RE_PROPONE_CAMBIO =
  /\b(?:cambi\w*|agreg\w*|sum(?:o|amos|ar|arle|ale|arte)|modific\w*|reemplaz\w*|actualiz\w*|aument\w*|quit\w*|sac(?:o|amos|ar|arle)|en vez|en lugar|(?:los|las) [2-9]|[2-9] (?:unidades|cajas|bolsas|packs?)|x ?[2-9]|combo|pack)\b/;

/** ¿El "sí" escrito confirma el pedido pendiente? Solo si responde a la confirmación o a un pedido de confirmar tal cual. */
export function siConfirmaPedido(s: Saliente): boolean {
  return esConfirmacionNuestra(s) || pideConfirmarTalCual(s);
}

/** "no", "ya no", "no gracias", "cancelalo", "mejor no"… como respuesta completa (nada más en el mensaje). 10-10. */
export function esNoAConfirmacion(texto: string): boolean {
  const n = normalizarTexto(texto);
  return /^(?:no+|nop|ya no|no gracias|no quiero|ya no quiero|no lo quiero|ya no lo quiero|mejor no|cancela(?:lo|r)?|cancelalo por favor|cancelar pedido|deja nomas|dejalo nomas|ya no gracias)$/.test(n);
}

/** "Lo quiero igual" (reactivar:<order_id>): el vendedor recibe el pedido dado de baja y arma el resumen nuevo. */
export async function reactivarPedido(ctx: Ctx, orderId: string): Promise<void> {
  const { deps } = ctx;
  const p = await deps.buscarPedido(orderId).catch(() => null);
  const r = (p?.raw ?? {}) as Record<string, unknown>;
  const a = (r.shipping_address ?? {}) as Record<string, unknown>;
  const items = (Array.isArray(r.line_items) ? r.line_items : []) as Array<Record<string, unknown>>;
  const prods = items.map((i) => `${i.quantity ?? 1} ${i.title ?? i.name ?? ""}`.trim()).join(", ") || "lo que había pedido";
  const nombre = [a.first_name, a.last_name].filter((x) => typeof x === "string" && x.trim()).join(" ") || ctx.nombreWa || "";
  const texto = `[reactivar] Tocó "Lo quiero igual" para reactivar su pedido ${p?.nombre ?? ""} que se dio de baja por no confirmar: ` +
    `${prods}; nombre ${nombre || "?"}, ciudad ${a.city ?? "?"}, dirección "${[a.address1, a.address2].filter(Boolean).join(", ") || "?"}". ` +
    "Ya decidió: en UN mensaje preguntale si se lo mandás a la misma dirección y, sin esperar, armá el resumen con crear_pedido_cod " +
    "(confirmar=false) con esos productos (handles de consultar_catalogo) y esos datos. Si cambia algo, corregilo.";
  await deps.completarContenidoMensaje(ctx.m.id, { texto_vendedor: texto }).catch(() => {});
  if (ctx.conv.estado !== "ia") await deps.actualizarConversacion(ctx.conv.id, { estado: "ia" });
  if (!deps.pasarAlVendedor) {
    await deps.avisar(`🔁 ${ctx.nombreWa ?? "Un cliente"} quiere reactivar el pedido ${p?.nombre ?? orderId} (dado de baja por no confirmar).`);
    return;
  }
  await deps.pasarAlVendedor({ conversacion_id: ctx.conv.id, cliente_id: ctx.clienteId, wa_message_id: ctx.m.id, texto });
}

/**
 * 09-10: el cliente tiene un pedido de la tienda (Releasit o del bot) sin despachar en las últimas 72 h. Sin esto el
 * bot no lo sabía: a "Dirección casa nro 4237" le contestó "¿Qué producto viste?". El "sí" lo sigue tomando el
 * webhook (esAceptacion → Confirmar); acá el vendedor se entera para corregir datos con actualizar_direccion.
 */
export async function conPedidoAbierto(deps: Deps, clienteId: string, telefono: string | null, texto: string): Promise<string> {
  try {
    const ahoraMs = deps.ahora().getTime();
    const desde = new Date(ahoraMs - 10 * 86_400_000).toISOString();
    // 13-10: un pedido con intento de entrega fallido puede tener más de 10 días (interior, reintentos): se mira 30.
    const desdeFallo = new Date(ahoraMs - DIAS_PEDIDO_EN_REINTENTO * 86_400_000).toISOString();
    const [pend, conf] = await Promise.all([
      deps.pedidosPorEstado(clienteId, telefono, "pendiente", desde),
      deps.pedidosPorEstado(clienteId, telefono, "confirmado", desdeFallo),
    ]);
    // 10-10: también los ya despachados (en camino): sin esto el bot le dijo a un cliente con el pedido en viaje que
    // "no quedó registrado" y le volvió a pedir todos los datos.
    const abiertos = [...pend, ...conf].filter((p) => {
      const r = p.raw ?? {};
      if (r.cancelled_at || ["ENTREGADO", "NO_ENTREGADO", "RENDIDO", "CANCELADO"].includes(String(p.estado_envio ?? "").toUpperCase())) return false;
      return enReintento(p) || String(p.creado_en ?? "") >= desde || !p.creado_en;
    }).sort((a, b) => String(b.creado_en ?? "").localeCompare(String(a.creado_en ?? "")));
    // 13-10: si hay uno con intento fallido, ese manda (es el que el cliente viene a coordinar).
    const abierto = abiertos.find(enReintento) ?? abiertos[0];
    if (!abierto) return esAvisoDePedidoHecho(texto) ? `${PISTA_PEDIDO_OTRO_NUMERO}\n${texto}` : texto;
    if (enReintento(abierto)) return `${textoPedidoEnReintento(abierto)}\n${texto}`;
    const despachado = (abierto.raw ?? {}).fulfillment_status === "fulfilled";
    const r = abierto.raw ?? {};
    const a = (r.shipping_address ?? {}) as Record<string, unknown>;
    const items = (Array.isArray(r.line_items) ? r.line_items : []) as Array<Record<string, unknown>>;
    const prods = items.map((i) => `${i.quantity ?? 1} ${i.title ?? i.name ?? ""}`.trim()).join(", ");
    const dir = [a.address1, a.address2].filter((x) => typeof x === "string" && x.trim()).join(", ");
    const estado = despachado ? "YA DESPACHADO, en camino con el courier (los datos están bien cargados: no se los vuelvas a pedir)"
      : abierto.estado_confirmacion === "pendiente" ? "PENDIENTE DE CONFIRMAR" : "confirmado, sin despachar";
    // 13-10: entrega programada → el vendedor sabe el día pedido y no promete otro.
    const prog = leerEntregaProgramada(r);
    const programada = prog ? `, ENTREGA PROGRAMADA ${textoEntregaProgramada(prog)} (no prometas otro día; si pide cambiarla, programar_entrega)` : "";
    return `[pedido ${abierto.nombre ?? ""} de la tienda, ${estado}${programada}: ${prods || "productos sin detalle"}, total Gs ${r.total_price ?? "?"}, ` +
      `dirección "${dir || "sin dirección"}", ciudad ${a.city ?? "?"}. Si el cliente corrige o agrega un dato de la dirección, ` +
      `llamá actualizar_direccion; si está pendiente y pregunta algo (precio, día de entrega, dirección), respondé y volvé a pedir que confirme el pedido tal cual respondiendo "sí" en 1 línea. No le preguntes qué producto quiere. ` +
      `${REGLA_CAMBIOS_PEDIDO}]\n${texto}`;
  } catch {
    return texto;
  }
}

/** 19-10 (#1072): el vendedor no puede cambiar un pedido con palabras; la herramienta muestra el resumen con Confirmo. */
export const REGLA_CAMBIOS_PEDIDO = "No podés cambiar productos ni cantidades con palabras: usá modificar_pedido (muestra un resumen con Confirmo). " +
  "Nunca digas que lo cambiaste si la herramienta no lo hizo.";

/** 19-10 (#1067): "acabo de hacer un pedido" sin pedido a este número → el pedido web puede estar con otro teléfono. */
export const PISTA_PEDIDO_OTRO_NUMERO = "[posible pedido web con otro número: usá buscar_pedido (por número, nombre o pedidos web de la última hora)]";

/** "Acabo de hacer un pedido", "ya pedí por la web", "hice un pedido", "ya compré en la página"… */
export function esAvisoDePedidoHecho(texto: string): boolean {
  const n = normalizarTexto(texto);
  return /\b(?:acabo de (?:hacer|realizar|mandar|enviar) (?:un|el|mi) pedido|(?:ya )?(?:hice|realice|mande|envie) (?:un|el|mi) pedido|ya (?:pedi|compre|hice la compra|hice el pedido)|(?:pedi|compre) (?:por|en|desde) (?:la )?(?:web|pagina|tienda))\b/
    .test(n);
}

/** 13-10: días hacia atrás en que se busca un pedido con intento de entrega fallido para darle contexto al vendedor. */
export const DIAS_PEDIDO_EN_REINTENTO = 30;

/** 13-10: el courier fue y no pudo entregar (se reintenta siempre). */
export const enReintento = (p: Pedido) => ["INTENTO_FALLIDO", "NO_ENTREGADO_RESCATABLE"].includes(String(p.estado_envio ?? "").toUpperCase());

/**
 * 13-10: contexto para el vendedor cuando el cliente responde al aviso de reintento (voltra_reintento_entrega_v2) con
 * un día, un horario o una dirección: que coordine (regla COORDINAR UNA ENTREGA), lo anote con actualizar_direccion
 * (día, horario y dónde recibe van en la referencia) y no ofrezca cancelar ni prometa una hora.
 */
export function textoPedidoEnReintento(p: Pedido): string {
  const r = p.raw ?? {};
  const a = (r.shipping_address ?? {}) as Record<string, unknown>;
  const items = (Array.isArray(r.line_items) ? r.line_items : []) as Array<Record<string, unknown>>;
  const prods = items.map((i) => `${i.quantity ?? 1} ${i.title ?? i.name ?? ""}`.trim()).join(", ");
  const dir = [a.address1, a.address2].filter((x) => typeof x === "string" && x.trim()).join(", ");
  return `[pedido ${p.nombre ?? ""} de la tienda, INTENTO DE ENTREGA FALLIDO: el repartidor fue y no pudo entregar; se vuelve a intentar. ` +
    `${prods || "productos sin detalle"}, total Gs ${r.total_price ?? "?"}, dirección "${dir || "sin dirección"}", ciudad ${a.city ?? "?"}. ` +
    "Coordiná como dice COORDINAR UNA ENTREGA: preguntale qué día le queda bien y que confirme la dirección y una referencia. " +
    "Cuando te diga día, horario, dirección o referencia, llamá actualizar_direccion (día, horario y dónde recibe van en referencia) " +
    "y confirmale corto que se lo pasamos al repartidor, que lo contacta antes de salir. No prometas una hora ni ofrezcas cancelar.]";
}

export async function conMarcaDeAnuncio(
  c: { deps: Deps; m: MensajeMeta; conv: Conversacion; clienteId: string },
  texto: string,
): Promise<string> {
  const { deps, m, conv } = c;
  const referral = m.referral && typeof m.referral === "object" ? m.referral : null;
  const adId = referral?.source_id ?? conv.origen_anuncio_id ?? null;
  if (!adId && !referral) return texto;
  try {
    if (!referral) {
      if (!deps.perfilConversacion) return texto;
      const perfil = await deps.perfilConversacion(conv.id);
      if (typeof perfil?.producto === "string" && perfil.producto.trim()) return texto;
    }
    const mapeo = await deps.config("anuncios_producto");
    const p = deducirProductoAnuncio({ adId, referral, mapeo });
    if (!p) return texto;
    const texAnuncio = textoDelAnuncio(referral);
    // 21-10: debajo de la marca, lo que prometió el anuncio (el vendedor arranca con ESA promesa).
    const marca = texAnuncio ? `${marcaAnuncio(p)}\n${marcaTextoAnuncio(texAnuncio)}` : marcaAnuncio(p);
    if (texto.includes(marcaAnuncio(p))) return texto;
    await deps.completarContenidoMensaje(m.id, { marca_anuncio: marca, producto_anuncio: p.handle, producto_anuncio_fuente: p.fuente }).catch(() => {});
    return `${marca}\n${texto}`;
  } catch (e) {
    console.error("marca del anuncio:", e instanceof Error ? e.message : e);
    return texto;
  }
}

// ---------- retomar un chat en 'humano' ----------

export const RETOMAR_HUMANO_H_DEFAULT = CFG_VENDEDOR_DEFAULT.retomar_humano_h ?? 3;
const POSTVENTA_A_HUMANO = new Set<string>(); // 12-10: ningún botón de postventa pasa el chat a Enrique

/** ¿Este mensaje entrante es un botón que pasa el chat a humano (confirmación o postventa)? */
export function botonPasaAHumano(m: MensajeMeta): boolean {
  if (leerBotonConfirmacion(m)) return true;
  const p = leerBotonPostventa(m);
  return !!p && POSTVENTA_A_HUMANO.has(p.accion);
}

/**
 * Por qué NO se retoma un chat en 'humano' (null = se puede retomar). Mira solo las últimas N horas:
 * Enrique tocó "Le escribo yo", le escribió al cliente desde la bandeja, hubo una derivación dura del vendedor
 * (reclamo, salud, devolución, enojo, otro, fallas del sistema) o el cliente tocó un botón que pasa a humano.
 * Las derivaciones de venta (mayorista, pide_persona…) no frenan: esas ya no pasan el chat a 'humano'.
 */
export function motivoParaNoRetomar(a: ActividadHumana): string | null {
  if (a.escribo) return "enrique_tomo_el_chat";
  if (a.salidasManuales > 0) return "enrique_escribio";
  const dura = a.derivaciones.find((mo) => !esDerivacionDeVenta(mo));
  if (dura) return `derivacion:${dura}`;
  if (a.entrantes.some(botonPasaAHumano)) return "boton_a_humano";
  return null;
}

/**
 * Regla para retomar (el botón de derivación lleva al WhatsApp personal de Enrique, así que en el número de la
 * tienda un chat en 'humano' puede quedar sin nadie): si en las últimas config_wa.vendedor.retomar_humano_h
 * horas (default 3; 0 = nunca) no hubo ninguna señal de que Enrique lo tenga (motivoParaNoRetomar), el chat
 * vuelve a 'ia' y el mensaje pasa al vendedor. Sin la dependencia actividadHumana o si la consulta falla, no se retoma.
 */
export async function debeRetomarHumano(conversacionId: string, clienteId: string, deps: Deps): Promise<boolean> {
  if (!deps.actividadHumana) return false;
  const v = await deps.config("vendedor") as { retomar_humano_h?: unknown } | null;
  const h = typeof v?.retomar_humano_h === "number" && Number.isFinite(v.retomar_humano_h) ? v.retomar_humano_h : RETOMAR_HUMANO_H_DEFAULT;
  if (h <= 0) return false;
  const desdeISO = new Date(deps.ahora().getTime() - h * 3600_000).toISOString();
  try {
    const a = await deps.actividadHumana({ conversacionId, clienteId, desdeISO });
    return motivoParaNoRetomar(a) === null;
  } catch (e) {
    console.error("retomar chat en humano: no pude leer la actividad, lo dejo en humano:", e instanceof Error ? e.message : e);
    return false;
  }
}

/** Texto del audio para el vendedor: transcripción con la marca [audio], o el aviso de que no se entendió. */
export function textoDeAudio(t: Transcripcion): string {
  if (!t.ok || !t.texto.trim()) return "[audio] (no se pudo transcribir: pedile que lo escriba)";
  return `[audio] ${t.texto.trim()}${t.confianzaBaja ? " (transcripción dudosa: si no se entiende, pedile que lo escriba)" : ""}`;
}

/**
 * Lo que ve el vendedor por cada mensaje: texto tal cual; ubicación, formulario (Flow) y contacto con los
 * parsers de _shared/wa_interactivos.ts (G2); botones, imágenes y el resto con marcas ([botón], [imagen]...).
 */
export function textoParaVendedor(m: MensajeMeta): string | null {
  const u = parsearUbicacion(m);
  if (u) return `[ubicación] ${[`${u.latitud},${u.longitud}`, u.nombre, u.direccion, u.mapsUrl].filter(Boolean).join(" · ")}`;
  const f = parsearFlow(m);
  if (f) {
    const d = datosFormularioPedido(f.datos);
    if (d.ok) {
      const p = d.pedido;
      return `[formulario] nombre: ${p.nombre} · ciudad: ${p.ciudad} · dirección: ${p.direccion}` +
        `${p.referencia ? ` · referencia: ${p.referencia}` : ""} · cantidad: ${p.cantidad}`;
    }
    return `[formulario] ${aTextoPlano(f.datos)}${d.faltan.length ? ` (faltan: ${d.faltan.join(", ")})` : ""}`;
  }
  const c = parsearContacto(m);
  if (c) {
    const quien = c.esPedidoDeContacto ? "compartió su número" : "compartió un contacto (puede no ser el suyo)";
    return `[contacto] ${quien}: ${[c.nombre, c.telefonoE164].filter(Boolean).join(" ")}`;
  }
  return textoDeEntrante(m as Record<string, unknown>);
}

type Ctx = {
  deps: Deps;
  m: MensajeMeta;
  clienteId: string;
  conv: Conversacion;
  telefono: string | null;
  destino: string;
  nombreWa: string | null;
};

function avisoDefault(clave: string) {
  console.warn(`config_wa.${clave} no existe: uso el valor por defecto del código`);
}

export async function aplicarRespuestaConfirmacion(ctx: Ctx, accion: AccionConf, orderId: string, pedidoYa?: Pedido): Promise<void> {
  const { deps } = ctx;
  const pedido = pedidoYa ?? await deps.buscarPedido(orderId);
  if (!pedido) {
    await deps.avisar(`Botón ${accion} de un pedido que no está en la base (${orderId}). Revisalo.`);
    return;
  }
  const etiqueta = pedido.nombre ?? `#${orderId}`;

  // El botón tiene que venir del cliente dueño del pedido.
  const dueño = (pedido.cliente_id && pedido.cliente_id === ctx.clienteId) ||
    (pedido.telefono && ctx.telefono && pedido.telefono === ctx.telefono) ||
    (!pedido.cliente_id && !pedido.telefono);
  if (!dueño) {
    await deps.avisar(`Botón ${accion} en ${etiqueta} tocado por otro cliente (${ctx.telefono ?? ctx.destino}). No hice nada.`);
    return;
  }

  const objetivo = ESTADO[accion];
  if (pedido.estado_confirmacion === objetivo) return; // toque repetido
  if (pedido.estado_confirmacion.startsWith("cancelado") && accion !== "conf_cancelar") {
    await deps.actualizarConversacion(ctx.conv.id, { estado: "humano" });
    await deps.avisar(`${etiqueta} ya estaba ${pedido.estado_confirmacion} y el cliente tocó ${accion}. Decidí vos.`, [
      [{ texto: "Le escribo yo", callback: `escribo:${orderId}` }],
    ]);
    return;
  }

  // 1) Base de datos
  const tagsPrevios = pedido.tags ?? [];
  const sacar = TAGS_CONF.filter((t) => t !== TAG[accion] && tagsPrevios.includes(t));
  const tags = [...tagsPrevios.filter((t) => !sacar.includes(t)), TAG[accion]].filter((t, i, a) => a.indexOf(t) === i);
  await deps.actualizarPedido(orderId, { estado_confirmacion: objetivo, tags });

  // 2) Shopify (tag). Si falla, se avisa pero se sigue con el cliente.
  const gid = `gid://shopify/Order/${orderId}`;
  const fallas: string[] = [];
  try {
    const r1 = await deps.agregarTags(gid, [TAG[accion]]) as { ok?: boolean; error?: string } | undefined;
    if (r1?.ok === false) fallas.push(`tag Shopify: ${r1.error}`);
    if (sacar.length) {
      const r2 = await deps.quitarTags(gid, sacar) as { ok?: boolean; error?: string } | undefined;
      if (r2?.ok === false) fallas.push(`quitar tags Shopify: ${r2.error}`);
    }
  } catch (e) {
    fallas.push(`tag Shopify: ${e instanceof Error ? e.message : e}`);
  }

  // 3) Envíos programados (recordatorio / retención / cancelación) ya no van.
  if (accion !== "conf_corregir") {
    const pat = await deps.config("plantillas_cancelables_al_responder");
    const patrones = Array.isArray(pat) ? pat as string[] : (avisoDefault("plantillas_cancelables_al_responder"), PATRONES_CANCELABLES_DEFAULT);
    await deps.cancelarEnviosPendientes(orderId, patrones);
  }
  if (accion === "conf_corregir") await deps.actualizarConversacion(ctx.conv.id, { estado: "humano" });

  // 4) Respuesta al cliente (ventana de 24 h abierta: el cliente acaba de escribir).
  const lineasPago: string[] = [];
  const resp = await deps.config("respuestas_confirmacion") as Record<string, string> | null;
  const textoResp = resp?.[CLAVE_RESPUESTA[accion]] ?? resp?.[accion];
  if (!textoResp) avisoDefault("respuestas_confirmacion");
  const ciudad = (pedido.raw?.shipping_address as Record<string, unknown> | undefined)?.city;
  // 09-10: pedidos del sábado y domingo salen el lunes.
  const retira = (pedido.tags ?? []).some((t) => String(t).toUpperCase() === "RETIRO_EN_CASA");
  const plazo = retira
    ? "la oficina de Ciudad del Este cuando lo retires (coordinamos día y hora por acá)"
    // 10-10: días reales desde hoy (el courier no trabaja sábado ni domingo); sin "sale el lunes".
    // 12-10: con el courier del pedido, así {plazo} y {dia} dicen lo mismo (ruteo oficial, _shared/plazo_zona.ts).
    : plazoParaEnDesdeHoy(ciudad, deps.ahora(), pedido.courier);
  const texto = renderizar(textoResp ?? RESPUESTAS_DEFAULT[accion], {
    nombre: primerNombre(nombreDePedido(pedido), ctx.nombreWa),
    plazo,
    pedido: etiqueta,
    // 12-10: {dia} disponible para respuestas_confirmacion ("Te llega {dia}" → "hoy o mañana martes 13/10").
    dia: retira ? plazo : diaEntrega(ciudad, deps.ahora(), pedido.courier).texto,
  });
  await deps.marcarLeidoYEscribiendo(ctx.m.id).catch(() => {});
  const envio = await deps.enviarTexto(ctx.destino, texto, { clienteId: ctx.clienteId, conversacionId: ctx.conv.id });
  if (!envio.ok) fallas.push(`respuesta al cliente: ${envio.error}`);

  // 12-10 (decisión del dueño): al confirmar sale la oferta de pagar antes por transferencia y salir con prioridad
  // (sin descuento, nunca obligatoria), justo después de nuestra respuesta y antes del permiso para ofertas. Una sola
  // vez por pedido (_shared/pago_anticipado.ts). La oferta vieja (07-10) y la del descuento ya no existen. Con
  // pago_prioridad prendido tampoco sale el QR: al cliente le llega un solo ofrecimiento de pago.
  const cfgPrioridad = accion === "conf_si" ? leerConfigPagoPrioridad(await deps.config(CLAVE_CONFIG_PRIORIDAD).catch(() => null)) : null;
  const prioridad = !!cfgPrioridad?.activo;
  if (cfgPrioridad?.activo && envio.ok) {
    const r = await ofrecerPagoPrioridad(ctx, pedido, orderId, objetivo, tags, cfgPrioridad);
    if (r.falla) fallas.push(r.falla);
    if (r.enviada) lineasPago.push(`💸 Se le ofreció pagar antes por transferencia, con prioridad${totalGs(pedido) ? ` (Gs ${totalGs(pedido)})` : ""}.`);
  }

  // Ola 4: oferta de pago por QR después de confirmar, solo con config_wa['ola4.qr'].activo.
  if (accion === "conf_si" && !prioridad && deps.ofrecerCobroQR) {
    const qr = await deps.config("ola4.qr") as { activo?: unknown } | null;
    if (qr?.activo === true) {
      try {
        const r = await deps.ofrecerCobroQR(Number(orderId));
        if (r.ok) {
          const e2 = await deps.enviarTexto(ctx.destino, r.texto, { clienteId: ctx.clienteId, conversacionId: ctx.conv.id });
          if (!e2.ok) fallas.push(`oferta QR: ${e2.error}`);
        } else if (r.motivo !== "bandera_apagada" && r.motivo !== "ya_pagado") fallas.push(`oferta QR: ${r.motivo}`);
      } catch (e) {
        fallas.push(`oferta QR: ${e instanceof Error ? e.message : e}`);
      }
    }
  }

  // 12-10: permiso para ofertas (opt-in de Meta) después de la respuesta de la confirmación, una sola vez por cliente:
  // solo si nunca respondió (sí o no) y nunca se le preguntó. Nunca es el primer mensaje del chat: va después de
  // nuestra respuesta a su "Confirmo".
  if (accion === "conf_si" && envio.ok) {
    const f = await pedirPermisoOfertas(ctx);
    if (f) fallas.push(f);
  }

  // 5) Aviso a Enrique por Telegram.
  const titulo = accion === "conf_si"
    ? `✅ ${etiqueta} confirmado por el cliente`
    : accion === "conf_corregir"
    ? `✏️ ${etiqueta}: el cliente quiere corregir datos. El chat pasó a humano.`
    : `❌ ${etiqueta}: el cliente canceló. Cancelalo en Shopify si corresponde.${
      despachado(pedido) ? " Ya estaba despachado: avisale al courier que no lo entregue." : ""
    }`;
  const botones = accion === "conf_corregir"
    ? [[{ texto: "Le escribo yo", callback: `escribo:${orderId}` }]]
    : accion === "conf_cancelar"
    ? [[{ texto: "Cancelar pedido", callback: `cancelar:${orderId}` }]]
    : undefined;
  await deps.avisar([titulo, ...lineasPago, ...fallas.map((f) => `Falla: ${f}`)].join("\n"), botones);
}

/**
 * 12-10: oferta de pago con prioridad al confirmar un pedido web. Solo dentro de la ventana de 24 h (el cliente
 * acaba de escribir; si el mensaje llegó tarde y la ventana se cerró, no sale nada). No sale si el pedido no
 * corresponde (pagado, retiro, prueba, mayorista, cancelado, ya preparado o con el courier, oferta ya enviada).
 * Reserva `prio:<id>` antes de mandar (si ya existe, otra vía la mandó: no se repite) y, si salió, deja el tag
 * OFERTA_PAGO_ANTICIPADO (DB + Shopify) para reconocer el comprobante.
 */
async function ofrecerPagoPrioridad(
  ctx: Ctx,
  pedido: Pedido,
  orderId: string,
  estado: string,
  tags: string[],
  cfg: CfgPagoPrioridad,
): Promise<{ enviada: boolean; falla?: string }> {
  const { deps } = ctx;
  if (motivoSinOfertaPrioridad({ tags, raw: pedido.raw, estado_confirmacion: estado, estado_envio: pedido.estado_envio })) return { enviada: false };
  const ts = Number(ctx.m.timestamp) * 1000;
  if (Number.isFinite(ts) && ts > 0 && deps.ahora().getTime() - ts >= 24 * 3_600_000) return { enviada: false }; // ventana cerrada
  if (deps.reservarOfertaPrioridad) {
    const ok = await deps.reservarOfertaPrioridad(orderId, ctx.clienteId).catch((e) => {
      console.error("oferta prioridad: no pude reservar prio:", e instanceof Error ? e.message : e);
      return false; // ante la duda no se manda (nunca dos veces)
    });
    if (!ok) return { enviada: false };
  }
  const e = await deps.enviarTexto(ctx.destino, textoOfertaPrioridad(cfg), { clienteId: ctx.clienteId, conversacionId: ctx.conv.id });
  await deps.cerrarOfertaPrioridad?.(orderId, e).catch((err) => console.error("oferta prioridad: cerrar prio:", err instanceof Error ? err.message : err));
  if (!e.ok) return { enviada: false, falla: `oferta de pago con prioridad: ${e.error}` };
  if (!tags.includes(TAG_OFERTA_PAGO)) {
    await deps.actualizarPedido(orderId, { estado_confirmacion: estado, tags: [...tags, TAG_OFERTA_PAGO] });
    try {
      const r = await deps.agregarTags(`gid://shopify/Order/${orderId}`, [TAG_OFERTA_PAGO]) as { ok?: boolean; error?: string } | undefined;
      if (r?.ok === false) return { enviada: true, falla: `tag ${TAG_OFERTA_PAGO} en Shopify: ${r.error}` };
    } catch (err) {
      return { enviada: true, falla: `tag ${TAG_OFERTA_PAGO} en Shopify: ${err instanceof Error ? err.message : err}` };
    }
  }
  return { enviada: true };
}

/**
 * 12-10: botones "Sí, avisame" / "No, gracias" (cons_si / cons_no:<cliente_id>, los registra aplicarBotonPostventa).
 * No se manda si ya respondió (sí, no o baja), si ya se le preguntó (vendedor, "Todo bien" o una confirmación
 * anterior) o si no se puede saber (falla la lectura). Devuelve la falla para el aviso a Enrique, o null.
 */
async function pedirPermisoOfertas(ctx: Ctx): Promise<string | null> {
  const { deps } = ctx;
  const previo = await deps.consentimientoMarketing(ctx.clienteId).catch(() => "error" as const);
  if (previo !== null) return null;
  if (deps.permisoOfertasPedido) {
    const ya = await deps.permisoOfertasPedido(ctx.clienteId).catch((e) => {
      console.error("permiso de ofertas: no pude ver si ya se le preguntó:", e instanceof Error ? e.message : e);
      return true; // ante la duda no se repite
    });
    if (ya) return null;
  }
  const opts = { clienteId: ctx.clienteId, conversacionId: ctx.conv.id };
  const interactivo = botonesPermisoOfertas(ctx.clienteId);
  const r = deps.enviarInteractivo
    ? await deps.enviarInteractivo(ctx.destino, interactivo, opts)
    : await deps.enviarBotones(ctx.destino, TEXTO_PERMISO_OFERTAS, [
      { id: `cons_si:${ctx.clienteId}`, titulo: "Sí, avisame" },
      { id: `cons_no:${ctx.clienteId}`, titulo: "No, gracias" },
    ], opts);
  return r.ok ? null : `permiso para ofertas: ${r.error}`;
}

// ---------- 13-10: rescate antes de cancelar ----------
// Caso real (13-10): un cliente de CDE pidió "viernes 16/10 antes de las 12", el pedido salió el martes, le llegó "ya
// salió" y tocó el "Cancelar pedido" viejo de la confirmación, que cancelaba al toque. Ahora ningún "Cancelar" cancela
// al primer toque: sale UNA respuesta con la oferta de programar otro día, otro horario u otra persona y dos botones:
// "Programar otro día" (resc_prog:<id> → el chat sigue con el vendedor, que tiene programar_entrega) y "Cancelar
// igual" (resc_cancel:<id> → la cancelación de siempre, aplicarRespuestaConfirmacion). Un segundo pedido explícito de
// cancelar (botón o texto) dentro de las 24 h de la oferta también cancela. Pedido ya cancelado → se le dice una vez;
// pedido entregado → nunca se cancela. El chat queda en 'ia'.

/** Horas en que vale la oferta de rescate: un segundo "cancelá" en ese lapso cancela. */
export const RESCATE_H = 24;

/** Estados de envío en que el pedido ya fue entregado (nunca se cancela). */
const ENVIO_ENTREGADO = ["ENTREGADO", "RENDIDO"];
/** Estados de envío en que el pedido ya no está abierto (no se busca para cancelar por texto). */
const ENVIO_CERRADO = ["ENTREGADO", "RENDIDO", "NO_ENTREGADO", "CANCELADO"];

const despachado = (p: Pedido) => String((p.raw ?? {}).fulfillment_status ?? "").toLowerCase() === "fulfilled";
const pedidoCancelado = (p: Pedido) => p.estado_confirmacion.startsWith("cancelado") || !!(p.raw ?? {}).cancelled_at;
const pedidoEntregado = (p: Pedido) => ENVIO_ENTREGADO.includes(String(p.estado_envio ?? "").toUpperCase());

/**
 * 13-10: el mensaje entero es un pedido de cancelar el pedido ("cancelar pedido", "quiero cancelar", "cancelámelo",
 * "anulá mi pedido", "ya no lo quiero", "cancelar igual"). Negaciones ("no lo cancelen") y mensajes largos no cuentan:
 * esos los atiende el vendedor.
 */
export function esPedidoCancelar(texto: string): boolean {
  const n = normalizarTexto(texto);
  if (!n || n.length > 60) return false;
  if (/\bno (lo |la |me )?(cancel|anul)/.test(n)) return false;
  const cortesia = "(?:(?:hola|buenas|buen dia|buenas tardes|buenas noches|por favor|porfa|disculpa|perdon)\\s+)*";
  const fin = "(?:\\s+(?:por favor|porfa|gracias|nomas|igual|ya))*";
  const verbo = "(?:quiero |quisiera |necesito |deseo |me gustaria |podes |podrias |pueden |puede |vamos a )?" +
    "(?:cancelar|cancela|cancelen|cancelalo|cancelala|cancelame|cancelamelo|anular|anula|anulen|anulalo|cancelarlo|anularlo)";
  const objeto = "(?:\\s+(?:el|mi|mis|ese|este|los|la|nomas))?(?:\\s+(?:pedido|pedidos|compra|orden|envio))?";
  const re = [
    new RegExp(`^${cortesia}${verbo}${objeto}${fin}$`),
    new RegExp(`^${cortesia}(?:ya )?no (?:lo |la )?quiero(?: mas)?(?: (?:el|mi) (?:pedido|producto))?${fin}$`),
  ];
  return re.some((r) => r.test(n));
}

/** 13-10: ¿la oferta de rescate de este pedido salió en esta conversación en las últimas RESCATE_H horas? */
async function rescateVigente(ctx: Ctx, orderId: string): Promise<boolean> {
  if (!ctx.deps.ofertaRescateDesde) return false;
  const desde = new Date(ctx.deps.ahora().getTime() - RESCATE_H * 3_600_000).toISOString();
  return await ctx.deps.ofertaRescateDesde(ctx.conv.id, orderId, desde).catch((e) => {
    console.error("rescate: no pude ver si ya se ofreció:", e instanceof Error ? e.message : e);
    return false; // ante la duda, otra oferta (nunca cancelar sin estar seguros)
  });
}

const esDueño = (p: Pedido, ctx: Ctx) =>
  (p.cliente_id && p.cliente_id === ctx.clienteId) || (p.telefono && ctx.telefono && p.telefono === ctx.telefono) ||
  (!p.cliente_id && !p.telefono);

/**
 * 13-10: respuesta única para un pedido que no se puede cancelar ni programar (ya cancelado o entregado). Un pedido
 * ya cancelado se dice una sola vez: si nuestro último mensaje ya era ese, no se repite. true si respondió (o calló a
 * propósito); false si el pedido sigue abierto.
 */
async function responderSiCerrado(ctx: Ctx, pedido: Pedido, etiqueta: string): Promise<boolean> {
  const clave = pedidoEntregado(pedido) ? "ya_entregado" : pedidoCancelado(pedido) ? "ya_cancelado" : null;
  if (!clave) return false;
  const { deps } = ctx;
  const texto = renderizar(await textoBoton(deps, clave), { nombre: primerNombre(nombreDePedido(pedido), ctx.nombreWa), pedido: etiqueta });
  const ultimo = deps.ultimoTextoNuestro ? await deps.ultimoTextoNuestro(ctx.conv.id).catch(() => null) : null;
  if (ultimo?.trim() === texto.trim()) return true;
  await deps.marcarLeidoYEscribiendo(ctx.m.id).catch(() => {});
  const r = await deps.enviarTexto(ctx.destino, texto, { clienteId: ctx.clienteId, conversacionId: ctx.conv.id });
  if (!r.ok) console.error(`respuesta ${clave} (${ctx.clienteId}): ${r.error}`);
  return true;
}

/**
 * 13-10: el cliente pidió cancelar (botón conf_cancelar, "no" a la confirmación o texto "cancelar pedido"). Con la
 * oferta de rescate vigente para ese pedido (segundo pedido explícito) → cancela; si no → oferta de rescate. Exactamente
 * una respuesta al cliente. El vendedor no recibe este mensaje.
 */
export async function pedirCancelacion(ctx: Ctx, orderId: string, pedidoYa?: Pedido): Promise<void> {
  const { deps } = ctx;
  const pedido = pedidoYa ?? await deps.buscarPedido(orderId);
  if (!pedido) {
    await deps.avisar(`Botón conf_cancelar de un pedido que no está en la base (${orderId}). Revisalo.`);
    return;
  }
  const etiqueta = pedido.nombre ?? `#${orderId}`;
  if (!esDueño(pedido, ctx)) {
    await deps.avisar(`Botón conf_cancelar en ${etiqueta} tocado por otro cliente (${ctx.telefono ?? ctx.destino}). No hice nada.`);
    return;
  }
  if (await responderSiCerrado(ctx, pedido, etiqueta)) return;
  if (await rescateVigente(ctx, orderId)) return cancelarPedidoCliente(ctx, orderId, pedido);
  await ofrecerRescate(ctx, orderId, pedido, etiqueta);
}

async function ofrecerRescate(ctx: Ctx, orderId: string, pedido: Pedido, etiqueta: string): Promise<void> {
  const { deps } = ctx;
  if (ctx.conv.estado !== "ia") await deps.actualizarConversacion(ctx.conv.id, { estado: "ia" });
  await deps.marcarLeidoYEscribiendo(ctx.m.id).catch(() => {});
  const vars = { nombre: primerNombre(nombreDePedido(pedido), ctx.nombreWa), pedido: etiqueta };
  const r = await deps.enviarBotones(ctx.destino, renderizar(await textoBoton(deps, "rescate_cancelar"), vars), [
    { id: `resc_prog:${orderId}`, titulo: (await textoBoton(deps, "rescate_boton_programar")).slice(0, 20) },
    { id: `resc_cancel:${orderId}`, titulo: (await textoBoton(deps, "rescate_boton_cancelar")).slice(0, 20) },
  ], { clienteId: ctx.clienteId, conversacionId: ctx.conv.id });
  if (!r.ok) {
    // Sin la oferta no se cancela nada: Enrique decide.
    await deps.avisar(`⚠️ ${etiqueta}: el cliente quiere cancelar y no le pude mandar la oferta de programar otro día (${r.error}). No cancelé nada.`, [
      [{ texto: "Le escribo yo", callback: `escribo:${orderId}` }, { texto: "Cancelar pedido", callback: `cancelar:${orderId}` }],
    ]);
    return;
  }
  // Ya despachado: el courier puede llegar mientras tanto; Enrique se entera sin tener que hacer nada todavía.
  if (despachado(pedido)) {
    await deps.avisar(`⚠️ ${etiqueta} (ya despachado): el cliente quiere cancelar. Le ofrecí programar otro día; si cancela igual te aviso.`);
  }
}

/** 13-10: cancelación pedida por el cliente (la de siempre: estado cancelado_cliente, tag, envíos, respuesta y Telegram). */
async function cancelarPedidoCliente(ctx: Ctx, orderId: string, pedido: Pedido): Promise<void> {
  await aplicarRespuestaConfirmacion(ctx, "conf_cancelar", orderId, pedido);
}

/**
 * 13-10: "Programar otro día" → el chat sigue con el vendedor con la marca "[programar entrega pedido #X]" (programa con
 * programar_entrega). "Cancelar igual" → cancela. Pedido ya cancelado o entregado → se le dice (una vez).
 */
export async function aplicarBotonRescate(ctx: Ctx, accion: AccionRescate, orderId: string): Promise<void> {
  const { deps } = ctx;
  const pedido = await deps.buscarPedido(orderId).catch(() => null);
  if (!pedido) {
    await deps.avisar(`Botón ${accion} de un pedido que no está en la base (${orderId}). Revisalo.`);
    return;
  }
  const etiqueta = pedido.nombre ?? `#${orderId}`;
  if (!esDueño(pedido, ctx)) {
    await deps.avisar(`Botón ${accion} en ${etiqueta} tocado por otro cliente (${ctx.telefono ?? ctx.destino}). No hice nada.`);
    return;
  }
  if (await responderSiCerrado(ctx, pedido, etiqueta)) return;
  if (accion === "resc_cancel") return cancelarPedidoCliente(ctx, orderId, pedido);

  await deps.marcarLeidoYEscribiendo(ctx.m.id).catch(() => {});
  if (ctx.conv.estado !== "ia") await deps.actualizarConversacion(ctx.conv.id, { estado: "ia" });
  const contexto = `[programar entrega pedido ${etiqueta}] El cliente quiere otro día/horario. ` +
    "Preguntale en 1 línea qué día y en qué horario le queda bien (o quién lo recibe) y programalo con programar_entrega " +
    "(nunca antes de la fecha mínima); si cambia quién recibe o el lugar, actualizar_direccion.";
  const texto = await conPedidoAbierto(deps, ctx.clienteId, ctx.telefono, contexto);
  await deps.completarContenidoMensaje(ctx.m.id, { texto_vendedor: texto }).catch(() => {});
  if (!deps.pasarAlVendedor) {
    const r = await deps.enviarTexto(ctx.destino, renderizar(await textoBoton(deps, "programar_sin_vendedor"), {
      nombre: primerNombre(nombreDePedido(pedido), ctx.nombreWa),
      pedido: etiqueta,
    }), { clienteId: ctx.clienteId, conversacionId: ctx.conv.id });
    if (!r.ok) console.error(`respuesta a resc_prog (${ctx.clienteId}): ${r.error}`);
    return;
  }
  await deps.pasarAlVendedor({ conversacion_id: ctx.conv.id, cliente_id: ctx.clienteId, wa_message_id: ctx.m.id, texto });
}

/**
 * 13-10: texto que pide cancelar. (1) Oferta de rescate vigente (24 h) y el texto es un pedido de cancelar o un "no"
 * → cancela ese pedido. (2) Chat con el vendedor ('ia') y el texto es un pedido de cancelar con UN solo pedido
 * abierto (pendiente o confirmado, sin cancelar ni entregar) → oferta de rescate. Si no, false (sigue el camino de
 * siempre: el vendedor).
 */
async function cancelacionPorTexto(ctx: Ctx, texto: string): Promise<boolean> {
  const { deps } = ctx;
  const cancelar = esPedidoCancelar(texto);
  if (!cancelar && !esNoAConfirmacion(texto)) return false;
  const ahora = deps.ahora().getTime();
  const [pend, conf] = await Promise.all([
    deps.pedidosPorEstado(ctx.clienteId, ctx.telefono, "pendiente", new Date(ahora - 10 * 86_400_000).toISOString()),
    deps.pedidosPorEstado(ctx.clienteId, ctx.telefono, "confirmado", new Date(ahora - DIAS_PEDIDO_EN_REINTENTO * 86_400_000).toISOString()),
  ]).catch((e) => {
    console.error("cancelar por texto: no pude leer los pedidos:", e instanceof Error ? e.message : e);
    return [[], []] as Pedido[][];
  });
  const abiertos = [...pend, ...conf].filter((p) => !pedidoCancelado(p) && !ENVIO_CERRADO.includes(String(p.estado_envio ?? "").toUpperCase()));
  for (const p of abiertos) {
    if (await rescateVigente(ctx, String(p.shopify_order_id))) {
      await cancelarPedidoCliente(ctx, String(p.shopify_order_id), p);
      return true;
    }
  }
  if (!cancelar || ctx.conv.estado !== "ia" || abiertos.length !== 1) return false;
  await pedirCancelacion(ctx, String(abiertos[0].shopify_order_id), abiertos[0]);
  return true;
}

// ---------- pago anticipado con prioridad (decisión del dueño, 07-10; flujo del 12-10) ----------
// La oferta sale al confirmar (ofrecerPagoPrioridad; pedidos del bot: shopify-webhook → procesar-envios).
// El comprobante: imagen o PDF de un cliente con un pedido que recibió la oferta → Telegram a Enrique con
// el archivo, el monto a verificar y el botón "Recibido" (pagado:<id>, telegram-webhook). El pedido no cambia hasta
// que lo toca. Config opcional: config_wa['pago_anticipado'].texto_recibido y dias_comprobante (sin datos de la cuenta:
// esos van solo en la base, nunca en el código).

export { TAG_COMPROBANTE_PAGO, TAG_OFERTA_PAGO, TAG_PRIORIDAD };

export const PAGO_ANTICIPADO_DEFAULT = {
  texto_recibido: "Recibido, gracias. Lo verificamos y tu pedido sale en el primer despacho.",
  dias_comprobante: 7,
};

type CfgComprobante = { texto_recibido: string; dias_comprobante: number };

async function leerCfgComprobante(deps: Deps): Promise<CfgComprobante> {
  const c = await deps.config("pago_anticipado").catch(() => null) as Record<string, unknown> | null;
  const txt = (v: unknown, d: string) => (typeof v === "string" && v.trim() ? v : d);
  const dias = Number(c?.dias_comprobante);
  return {
    texto_recibido: txt(c?.texto_recibido, PAGO_ANTICIPADO_DEFAULT.texto_recibido),
    dias_comprobante: Number.isFinite(dias) && dias > 0 ? dias : PAGO_ANTICIPADO_DEFAULT.dias_comprobante,
  };
}

function totalGs(p: Pedido): string | null {
  const n = Math.round(Number(p.total));
  return Number.isFinite(n) && n > 0 ? precioGs(n) : null;
}

/** Estados de envío en los que una imagen ya no puede ser el comprobante del pago anticipado. */
const ENVIO_SIN_COMPROBANTE = ["ENTREGADO", "NO_ENTREGADO", "RENDIDO", "CANCELADO"];

/** Imagen, o documento PDF/imagen: lo que puede ser un comprobante de transferencia. */
export function mediaDeComprobante(m: MensajeMeta): { id: string; mime: string } | null {
  if (m.type === "image" && m.image?.id) return { id: m.image.id, mime: m.image.mime_type ?? "image/jpeg" };
  if (m.type === "document" && m.document?.id) {
    const mime = (m.document.mime_type ?? "").toLowerCase();
    if (mime === "application/pdf" || mime.startsWith("image/")) return { id: m.document.id, mime };
  }
  return null;
}

/** Archivo del cliente que la Bandeja puede mostrar: imagen, sticker, video o documento. */
export function mediaDeChat(m: MensajeMeta): { id: string; mime: string } | null {
  if (m.type === "image" && m.image?.id) return { id: m.image.id, mime: m.image.mime_type ?? "image/jpeg" };
  if (m.type === "sticker" && m.sticker?.id) return { id: m.sticker.id, mime: m.sticker.mime_type ?? "image/webp" };
  if (m.type === "video" && m.video?.id) return { id: m.video.id, mime: m.video.mime_type ?? "video/mp4" };
  if (m.type === "document" && m.document?.id) return { id: m.document.id, mime: m.document.mime_type ?? "application/octet-stream" };
  return null;
}

const EXTENSION_CHAT: Record<string, string> = {
  "image/jpeg": "jpg", "image/png": "png", "image/webp": "webp", "image/gif": "gif",
  "video/mp4": "mp4", "video/3gpp": "3gp", "application/pdf": "pdf",
};

const EXTENSION: Record<string, string> = { "image/jpeg": "jpg", "image/png": "png", "image/webp": "webp", "application/pdf": "pdf" };

/**
 * Comprobante de pago anticipado: imagen o PDF de un cliente con un pedido confirmado que recibió la oferta
 * (tag OFERTA_PAGO_ANTICIPADO), sin pagar todavía, sin comprobante previo, sin entregar y de los últimos
 * `dias_comprobante` días (default 7). 12-10: el pedido NO cambia (ni tags ni estado) hasta que Enrique toca
 * "Recibido" en Telegram. Copia a Storage, respuesta al cliente y aviso a Enrique con el archivo (foto o PDF), el
 * monto a verificar (total del pedido) y el botón. Con el chat en 'humano' que Enrique atiende (mismo criterio que
 * debeRetomarHumano) no se le responde al cliente. Devuelve false si no aplica: el mensaje sigue el flujo normal.
 */
export async function aplicarComprobantePago(ctx: Ctx): Promise<boolean> {
  const { deps, m } = ctx;
  const media = mediaDeComprobante(m);
  if (!media) return false;
  // No depende de pago_prioridad.activo: si se apagó después de ofrecer, el comprobante igual le llega a Enrique.
  const cfg = await leerCfgComprobante(deps);
  const desde = new Date(deps.ahora().getTime() - cfg.dias_comprobante * 86_400_000).toISOString();
  const confirmados = await deps.pedidosPorEstado(ctx.clienteId, ctx.telefono, "confirmado", desde);
  const candidatos = confirmados.filter((x) => {
    const t = x.tags ?? [];
    return t.includes(TAG_OFERTA_PAGO) && !t.includes(TAG_COMPROBANTE_PAGO) && !pedidoPagado(x) &&
      !ENVIO_SIN_COMPROBANTE.includes(String(x.estado_envio ?? "").toUpperCase());
  });
  let p: Pedido | null = null;
  for (const x of candidatos) {
    // Una segunda imagen del mismo pedido ya no es comprobante: va al flujo normal (vendedor).
    const ya = deps.comprobanteRecibido
      ? await deps.comprobanteRecibido(String(x.shopify_order_id)).catch((e) => {
        console.error("comprobante: no pude ver si ya había uno:", e instanceof Error ? e.message : e);
        return false;
      })
      : false;
    if (!ya) {
      p = x;
      break;
    }
  }
  if (!p) return false;

  const orderId = String(p.shopify_order_id);
  const etiqueta = p.nombre ?? `#${orderId}`;
  const total = totalGs(p) ?? "?";
  const fallas: string[] = [];

  // 1) Copia del comprobante a Storage (la URL de Meta vence), para la bandeja y para mandarlo a Telegram.
  let ruta: string | null = null;
  const extension = EXTENSION[media.mime.split(";")[0].trim()] ?? "bin";
  if (deps.copiarMedia) {
    const destino = `comprobantes/${ctx.clienteId}/${m.id}.${extension}`;
    const c = await deps.copiarMedia(media.id, destino).catch((e) => ({ ok: false, error: e instanceof Error ? e.message : String(e) } as { ok: boolean; ruta?: string; error?: string }));
    if (c.ok) ruta = c.ruta ?? destino;
    else fallas.push(`copia del comprobante: ${c.error}`);
  }
  // La marca del mensaje es el registro del comprobante (no se toca el pedido).
  await deps.completarContenidoMensaje(m.id, {
    comprobante_pago_anticipado: orderId,
    ...(ruta ? { storage_path: ruta } : {}),
  });

  // 2) Respuesta al cliente, salvo que Enrique tenga el chat.
  const responder = ctx.conv.estado !== "humano" || await debeRetomarHumano(ctx.conv.id, ctx.clienteId, deps);
  if (responder) {
    await deps.marcarLeidoYEscribiendo(m.id).catch(() => {});
    const texto = renderizar(cfg.texto_recibido, { nombre: primerNombre(nombreDePedido(p), ctx.nombreWa), pedido: etiqueta, total });
    const e = await deps.enviarTexto(ctx.destino, texto, { clienteId: ctx.clienteId, conversacionId: ctx.conv.id });
    if (!e.ok) fallas.push(`respuesta al cliente: ${e.error}`);
  }

  // 3) Aviso a Enrique con el archivo. pagado:<id> → telegram-webhook marca pagado en Shopify, tags PAGO_VERIFICADO +
  // PRIORIDAD + PAGADO y, si ya estaba preparado, el texto para el courier (cobrar 0).
  const lineas = [
    `💸 ${etiqueta}: el cliente mandó el comprobante del pago anticipado (prioridad).`,
    `Monto a verificar: Gs ${total} (total del pedido).`,
    "Verificalo en el banco y tocá Recibido. Hasta que lo toques, el pedido no cambia.",
  ];
  if (!responder) lineas.push("El chat está con vos: no le respondí al cliente.");
  const botones: BotonAviso[][] = [
    [{ texto: "Recibido", callback: `pagado:${orderId}` }],
    [{ texto: "Le escribo yo", callback: `escribo:${orderId}` }],
  ];
  let conArchivo = false;
  if (deps.avisarConArchivo) {
    const r = await deps.avisarConArchivo([...lineas, ...fallas.map((f) => `Falla: ${f}`)].join("\n"), botones, {
      mediaId: media.id,
      ruta,
      mime: media.mime,
      nombre: `comprobante-${etiqueta.replace(/\W/g, "")}.${extension}`,
    }).catch((e) => ({ ok: false, error: e instanceof Error ? e.message : String(e) }));
    conArchivo = r.ok;
    if (!r.ok) fallas.push(`no pude mandarte el archivo a Telegram: ${r.error}`);
  }
  if (!conArchivo) {
    // Sin el archivo: el aviso de texto con dónde verlo (Storage o media id de WhatsApp).
    lineas.push(ruta ? `Comprobante: Storage wa-media/${ruta}` : `Comprobante: media de WhatsApp ${media.id} (wamid ${m.id})`);
    await deps.avisar([...lineas, ...fallas.map((f) => `Falla: ${f}`)].join("\n"), botones);
  }
  return true;
}

// ---------- botones post-venta (plantillas de F) y consentimiento del día 0 ----------

const BOTON_LEGIBLE: Record<AccionBoton, string> = {
  ayuda: "Necesito ayuda",
  ne_reintentar: "Volver a intentar",
  ne_direccion: "Cambiar dirección",
  ne_cancelar: "Cancelar (no entregado)",
  seg_bien: "Todo bien",
  seg_problema: "Tuve un problema",
  cons_si: "Sí, avisame",
  cons_no: "No, gracias",
};

async function textoBoton(deps: Deps, clave: string): Promise<string> {
  const t = await deps.config("textos_botones") as Record<string, unknown> | null;
  const v = t?.[clave];
  if (typeof v === "string" && v.trim()) return v;
  avisoDefault(`textos_botones.${clave}`);
  return TEXTOS_BOTONES_DEFAULT[clave] ?? "";
}

export async function aplicarBotonPostventa(ctx: Ctx, accion: AccionBoton, id: string): Promise<void> {
  const { deps } = ctx;
  const opts = { clienteId: ctx.clienteId, conversacionId: ctx.conv.id };
  await deps.marcarLeidoYEscribiendo(ctx.m.id).catch(() => {});

  // Consentimiento: el id es el cliente_id; tiene que ser el mismo que tocó.
  if (accion === "cons_si" || accion === "cons_no") {
    if (id !== ctx.clienteId) {
      await deps.avisar(`Botón ${accion} con cliente_id de otra persona (${id}) tocado por ${ctx.telefono ?? ctx.destino}. No registré nada.`);
      return;
    }
    await deps.registrarConsentimiento(ctx.clienteId, accion === "cons_si" ? "si" : "no", "boton");
    const r = await deps.enviarTexto(ctx.destino, renderizar(await textoBoton(deps, accion), { nombre: "" }), opts);
    if (!r.ok) await deps.avisar(`No pude responder el consentimiento (${accion}) a ${ctx.nombreWa ?? ctx.destino}: ${r.error}`);
    return;
  }

  // Botones de pedido: el pedido (si está en la base) tiene que ser del cliente que toca.
  const pedido = await deps.buscarPedido(id);
  const etiqueta = pedido?.nombre ?? `#${id}`;
  if (pedido) {
    const dueño = (pedido.cliente_id && pedido.cliente_id === ctx.clienteId) ||
      (pedido.telefono && ctx.telefono && pedido.telefono === ctx.telefono) ||
      (!pedido.cliente_id && !pedido.telefono);
    if (!dueño) {
      await deps.avisar(`Botón ${accion} en ${etiqueta} tocado por otro cliente (${ctx.telefono ?? ctx.destino}). No hice nada.`);
      return;
    }
  }
  const nombre = primerNombre(pedido ? nombreDePedido(pedido) : null, ctx.nombreWa);
  const vars = { nombre, pedido: etiqueta };

  if (accion === "seg_bien") {
    // Solo se pregunta a quien nunca respondió: un "no" o una baja no se vuelven a preguntar.
    const previo = await deps.consentimientoMarketing(ctx.clienteId);
    const r = previo === null
      ? await deps.enviarBotones(ctx.destino, renderizar(await textoBoton(deps, "consentimiento"), vars), [
        { id: `cons_si:${ctx.clienteId}`, titulo: await textoBoton(deps, "consentimiento_si") },
        { id: `cons_no:${ctx.clienteId}`, titulo: await textoBoton(deps, "consentimiento_no") },
      ], opts)
      : await deps.enviarTexto(ctx.destino, renderizar(await textoBoton(deps, "seg_bien_ya"), vars), opts);
    if (!r.ok) await deps.avisar(`No pude mandar el mensaje de "Todo bien" en ${etiqueta}: ${r.error}`);
    // 09-10: cliente contento → pedido de foto/video (prueba social real). Gratis: ventana abierta por el botón.
    if (r.ok && deps.marcarPerfil) {
      const t = await deps.enviarTexto(ctx.destino, renderizar(await textoBoton(deps, "pedir_testimonio"), vars), opts);
      if (t.ok) {
        await deps.marcarPerfil(ctx.conv.id, "pidio_testimonio_en", deps.ahora().toISOString()).catch(() => {});
        // 13-10: de qué pedido es (el testimonio se guarda con el pedido y el producto).
        await deps.marcarPerfil(ctx.conv.id, "testimonio_pedido", id).catch(() => {});
      }
    }
    return;
  }

  // El resto: respuesta al cliente + aviso a Enrique.
  // 12-10: nada de estos botones pasa el chat a Enrique (decisión de Enrique: el bot escucha y resuelve; Enrique
  // es la última opción). El vendedor sigue y deriva solo si hace falta (reclamo grave, devolución, enojo, mayorista).
  if (ctx.conv.estado !== "ia") await deps.actualizarConversacion(ctx.conv.id, { estado: "ia" });

  const respuesta = await deps.enviarTexto(ctx.destino, renderizar(await textoBoton(deps, accion), vars), opts);

  const quien = `${ctx.nombreWa || nombre || "Cliente"}${ctx.telefono ? ` (${ctx.telefono})` : ""}`;
  const envio = pedido?.estado_envio ? ` Estado del envío: ${pedido.estado_envio}.` : "";
  const courier = pedido?.courier ? ` con ${pedido.courier}` : "";
  const titulo: Record<string, string> = {
    ayuda: `🆘 ${etiqueta}: ${quien} tocó "Necesito ayuda".${envio} El chat pasó a humano.`,
    ne_reintentar: `🔁 ${etiqueta}: ${quien} pidió volver a intentar la entrega. Coordiná el reintento${courier}.${envio}`,
    ne_direccion: `📍 ${etiqueta}: ${quien} quiere cambiar la dirección de entrega. Le pedí la nueva; cuando la mande te llega el texto para el courier.`,
    ne_cancelar: `❌ ${etiqueta}: ${quien} no quiere el pedido que no se pudo entregar. Cancelalo si corresponde.`,
    seg_problema: `⚠️ Reclamo en ${etiqueta}: ${quien} tocó "Tuve un problema" después de la entrega. El chat pasó a humano.`,
  };
  const wa = enlaceWaMe(ctx.telefono, `Hola ${nombre}, te escribo por tu pedido ${etiqueta} de Voltra.`.replace(/ {2,}/g, " "));
  const filas: BotonAviso[][] = [];
  if (accion === "ne_cancelar") filas.push([{ texto: "Cancelar pedido", callback: `cancelar:${id}` }]);
  if (accion === "seg_problema") filas.push([{ texto: "Reponer", callback: `reponer:${id}` }]);
  filas.push([{ texto: "Le escribo yo", callback: `escribo:${id}` }]);
  if (wa) filas.push([{ texto: "Abrir WhatsApp", url: wa }]);
  const lineas = [titulo[accion] ?? `${etiqueta}: botón ${BOTON_LEGIBLE[accion]}`];
  if (!respuesta.ok) lineas.push(`Falla: respuesta al cliente: ${respuesta.error}`);
  // 12-10: "Necesito ayuda" y "Tuve un problema" ya no avisan a Enrique (lo atiende el bot; si deriva, ahí sí avisa).
  if (accion !== "ayuda" && accion !== "seg_problema") await deps.avisar(lineas.join("\n"), filas);
  // 10-10: el texto listo para reenviar al courier (la API no puede entrar a su grupo).
  if (accion === "ne_reintentar" && pedido) {
    const d = datosCourierDesdeRaw(etiqueta, pedido.raw ?? null, pedido.telefono ?? ctx.telefono);
    await deps.avisar(avisoParaCourier(d, "Volver a intentar la entrega (el cliente lo pidió). Coordinar día, hora y lugar con el cliente.", pedido.courier)).catch(() => {});
  }
}

// ---------- 13-10: testimonios después de la entrega ----------
// "Todo bien" → se pide foto, video o un comentario corto (7 días). Lo que llega se guarda en `testimonios` y se
// pide permiso para mostrarlo sin nombre ni número (tst_si / tst_no). Nunca se publica nada solo. A Enrique le
// llega UN aviso cuando hay 5 autorizados, y otro cada 5 más (hitos guardados en testimonios_hitos).

/** Días que espera el pedido de testimonio. */
export const DIAS_TESTIMONIO = 7;
/** Cada cuántos testimonios autorizados se avisa a Enrique. */
export const PASO_HITO_TESTIMONIOS = 5;

/**
 * Comentario corto que sirve de testimonio: una opinión (3+ palabras, sin preguntas, links ni números largos).
 * Un "no", "después", un reclamo o una pregunta siguen al vendedor como siempre.
 */
export function esComentarioTestimonio(texto: string): boolean {
  const t = String(texto ?? "").trim();
  if (t.length < 12 || t.length > 600) return false;
  if (/[?¿]/.test(t) || /https?:\/\/|www\.|\d{6,}/i.test(t)) return false;
  const n = normalizarTexto(t);
  if (n.split(" ").length < 3) return false;
  if (/^(no|nop|ahora no|despues|luego|mas tarde|otro dia|todavia)\b/.test(n)) return false;
  if (/\b(cancel\w*|devol\w*|reclam\w*|roto|rota|falta\w*|no (me )?(llego|funciona|sirve|sirvio|anda|gusto)|quiero (otro|otra|mas|comprar|pedir)|precio|cuanto)\b/.test(n)) {
    return false;
  }
  return true;
}

/** Pedido de testimonio vigente en la conversación (≤ 7 días), o null. */
async function pedidoDeTestimonio(ctx: Ctx): Promise<{ orderId: string | null } | null> {
  const p = await ctx.deps.perfilConversacion!(ctx.conv.id).catch(() => null);
  const en = typeof p?.pidio_testimonio_en === "string" ? Date.parse(p.pidio_testimonio_en) : NaN;
  if (!Number.isFinite(en) || ctx.deps.ahora().getTime() - en >= DIAS_TESTIMONIO * 86_400_000) return null;
  const id = p?.testimonio_pedido;
  return { orderId: typeof id === "string" && /^\d+$/.test(id) ? id : typeof id === "number" ? String(id) : null };
}

/** Productos del pedido para la columna `producto` ("1 Tiras nasales Gudair"). */
export function productoDePedido(p: Pedido | null): string | null {
  const items = (Array.isArray(p?.raw?.line_items) ? p!.raw!.line_items : []) as Array<Record<string, unknown>>;
  const t = items.map((i) => `${i.quantity ?? 1} ${i.title ?? i.name ?? ""}`.trim()).filter((x) => /\D/.test(x)).join(", ");
  return t || null;
}

const QUE_TESTIMONIO: Record<TestimonioNuevo["tipo"], string> = { foto: "tu foto", video: "tu video", texto: "tu comentario" };

async function aplicarTestimonio(
  ctx: Ctx,
  pt: { orderId: string | null },
  tipo: TestimonioNuevo["tipo"],
  ruta: string | null,
  texto: string | null,
): Promise<void> {
  const { deps } = ctx;
  const opts = { clienteId: ctx.clienteId, conversacionId: ctx.conv.id };
  await deps.marcarPerfil!(ctx.conv.id, "pidio_testimonio_en", null).catch(() => {});
  await deps.marcarPerfil!(ctx.conv.id, "testimonio_pedido", null).catch(() => {});
  const pedido = pt.orderId ? await deps.buscarPedido(pt.orderId).catch(() => null) : null;
  const nombre = primerNombre(pedido ? nombreDePedido(pedido) : null, ctx.nombreWa);

  // Sin la tabla (deps sin guardarTestimonio): como el 09-10, gracias + aviso a Enrique para que no se pierda.
  if (!deps.guardarTestimonio) {
    await deps.enviarTexto(ctx.destino, renderizar(await textoBoton(deps, "gracias_testimonio"), { nombre, pedido: "" }), opts);
    await deps.avisar(`📸 <b>${escaparHtml(ctx.nombreWa ?? "Un cliente")}</b> mandó ${tipo === "video" ? "un video" : tipo === "foto" ? "una foto" : "un comentario"} usando el producto (testimonio). Miralo en la Bandeja de Voltra OS.`);
    return;
  }
  let guardado: { id: string } | null;
  try {
    guardado = await deps.guardarTestimonio({
      cliente_id: ctx.clienteId,
      shopify_order_id: pedido ? Number(pedido.shopify_order_id) : pt.orderId ? Number(pt.orderId) : null,
      tipo,
      ruta_storage: ruta,
      texto,
      producto: productoDePedido(pedido),
      wa_message_id: ctx.m.id,
    });
  } catch (e) {
    // No se pudo guardar: el cliente igual recibe el gracias; no se le pide un permiso que no quedaría registrado.
    console.error("guardar testimonio:", e instanceof Error ? e.message : e);
    await deps.enviarTexto(ctx.destino, renderizar(await textoBoton(deps, "gracias_testimonio"), { nombre, pedido: "" }), opts);
    return;
  }
  if (!guardado) return; // ya estaba (mismo mensaje)
  const r = await deps.enviarBotones(
    ctx.destino,
    renderizar(await textoBoton(deps, "permiso_testimonio"), { nombre, pedido: "", que: QUE_TESTIMONIO[tipo] }),
    [
      { id: `tst_si:${guardado.id}`, titulo: await textoBoton(deps, "permiso_testimonio_si") },
      { id: `tst_no:${guardado.id}`, titulo: await textoBoton(deps, "permiso_testimonio_no") },
    ],
    opts,
  );
  if (!r.ok) console.error(`permiso de testimonio a ${ctx.clienteId}: ${r.error}`);
}

/** Botón del permiso: tst_si:<uuid> / tst_no:<uuid>. */
export function leerBotonTestimonio(m: MensajeMeta): { autorizado: boolean; id: string } | null {
  const r = /^tst_(si|no):([0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12})$/i.exec(idDeBoton(m));
  return r ? { autorizado: r[1].toLowerCase() === "si", id: r[2].toLowerCase() } : null;
}

/** Hito alcanzado con `n` autorizados (5, 10, 15…), o null si todavía no llega a 5. */
export function hitoTestimonios(n: number, paso = PASO_HITO_TESTIMONIOS): number | null {
  const h = Math.floor(n / paso) * paso;
  return h >= paso ? h : null;
}

export async function aplicarPermisoTestimonio(ctx: Ctx, autorizado: boolean, id: string): Promise<void> {
  const { deps } = ctx;
  await deps.marcarLeidoYEscribiendo(ctx.m.id).catch(() => {});
  // Solo cambia si el testimonio es de este cliente y todavía no respondió (un segundo toque no lo da vuelta).
  const cambio = deps.responderPermisoTestimonio
    ? await deps.responderPermisoTestimonio(id, ctx.clienteId, autorizado)
    : false;
  const nombre = primerNombre(null, ctx.nombreWa);
  const r = await deps.enviarTexto(ctx.destino, renderizar(await textoBoton(deps, autorizado ? "tst_si" : "tst_no"), { nombre, pedido: "" }), {
    clienteId: ctx.clienteId,
    conversacionId: ctx.conv.id,
  });
  if (!r.ok) console.error(`respuesta al permiso de testimonio (${ctx.clienteId}): ${r.error}`);
  if (!autorizado || !cambio || !deps.contarTestimoniosAutorizados || !deps.registrarHitoTestimonios) return;
  const n = await deps.contarTestimoniosAutorizados();
  const hito = hitoTestimonios(n);
  if (hito && await deps.registrarHitoTestimonios(hito)) {
    await deps.avisar(
      `⭐ Ya tenés <b>${hito} testimonios</b> de clientes con permiso para mostrarlos (sin nombre ni número). ` +
        "Están en la tabla testimonios (fotos y videos en Storage wa-media). No se publica nada solo: elegí vos cuáles usar.",
    );
  }
}

// ---------- 12-10: botones de entrega y pago (ninguno avisa a Enrique por Telegram) ----------

/**
 * ent_ok → "Genial, gracias {nombre}!" y nada más. reprogramar (aviso de la víspera) → el chat sigue con el vendedor
 * (estado 'ia', como ne_direccion) y le llega el contexto para coordinar el día nuevo (regla COORDINAR UNA ENTREGA).
 * corregir (confirmación v4) → igual, para que pregunte qué dato cambia; el pedido sigue pendiente hasta el "sí".
 * pago_ant → (12-10: descuento retirado) le dice que paga al recibir, o que ya está pagado.
 */
export async function aplicarBotonEntrega(ctx: Ctx, accion: AccionEntrega, id: string): Promise<void> {
  const { deps } = ctx;
  await deps.marcarLeidoYEscribiendo(ctx.m.id).catch(() => {});
  const pedido = await deps.buscarPedido(id).catch(() => null);
  if (pedido) {
    const dueño = (pedido.cliente_id && pedido.cliente_id === ctx.clienteId) ||
      (pedido.telefono && ctx.telefono && pedido.telefono === ctx.telefono) ||
      (!pedido.cliente_id && !pedido.telefono);
    if (!dueño) {
      console.warn(`botón ${accion}:${id} de un pedido de otro cliente (${ctx.clienteId}): no hice nada`);
      return;
    }
  }
  const etiqueta = pedido?.nombre ?? `#${id}`;
  const vars = { nombre: primerNombre(pedido ? nombreDePedido(pedido) : null, ctx.nombreWa), pedido: etiqueta };
  const responder = async (clave: string) => {
    const r = await deps.enviarTexto(ctx.destino, renderizar(await textoBoton(deps, clave), vars), { clienteId: ctx.clienteId, conversacionId: ctx.conv.id });
    if (!r.ok) console.error(`respuesta al botón ${accion} (${ctx.clienteId}): ${r.error}`);
    return r.ok;
  };

  if (accion === "ent_ok") {
    await responder("ent_ok");
    return;
  }
  if (accion === "pago_ant") return aplicarPagoElegido(ctx, pedido, id, responder);

  // reprogramar y corregir: los atiende el vendedor (Enrique es el último recurso).
  if (ctx.conv.estado !== "ia") await deps.actualizarConversacion(ctx.conv.id, { estado: "ia" });
  // Corregir es una respuesta: el recordatorio de confirmación ya no hace falta (sigue pendiente hasta el "sí").
  if (accion === "corregir") await deps.cancelarEnviosPendientes(id, ["recordatorio"]).catch((e) => console.error("cancelar recordatorio:", e));
  const contexto = accion === "reprogramar"
    ? `[reprogramar entrega pedido ${etiqueta}] El cliente tocó Reprogramar en el aviso de entrega. ` +
      "Preguntale qué día le queda mejor y coordiná como dice COORDINAR UNA ENTREGA (sin prometer hora)."
    : `[corregir pedido ${etiqueta}] El cliente tocó Corregir en la confirmación del pedido (todavía sin confirmar). ` +
      "Preguntale en 1 línea qué dato cambia; dirección, referencia o pin van con actualizar_direccion. " +
      'Después pedile que confirme respondiendo "sí".';
  const texto = await conPedidoAbierto(deps, ctx.clienteId, ctx.telefono, contexto);
  await deps.completarContenidoMensaje(ctx.m.id, { texto_vendedor: texto }).catch(() => {});
  if (!deps.pasarAlVendedor) {
    await responder(accion === "reprogramar" ? "reprogramar_sin_vendedor" : "corregir_sin_vendedor");
    return;
  }
  await deps.pasarAlVendedor({ conversacion_id: ctx.conv.id, cliente_id: ctx.clienteId, wa_message_id: ctx.m.id, texto });
}

/**
 * "Pagar ahora" (pago_ant:<id>) de la oferta con descuento, que quedó retirada el 12-10 (ningún camino la manda ni
 * la ofrece). Si llega un toque viejo: ya pagado → que no paga nada; si no → que paga al recibir. No se mandan datos
 * de la cuenta ni montos con descuento.
 */
async function aplicarPagoElegido(_ctx: Ctx, pedido: Pedido | null, _id: string, responder: (clave: string) => Promise<boolean>): Promise<void> {
  await responder(pedido && pedidoPagado(pedido) ? "pago_ya_hecho" : "pago_al_recibir");
}

// ---------- ola 3: recompra (botones mk_*) y baja de marketing ----------

async function textoMarketing(deps: Deps, clave: string): Promise<string> {
  const t = await deps.config("textos_marketing") as Record<string, unknown> | null;
  const v = t?.[clave];
  if (typeof v === "string" && v.trim()) return v;
  avisoDefault(`textos_marketing.${clave}`);
  return TEXTOS_MARKETING_DEFAULT[clave] ?? "";
}

/** Baja de marketing: registra (recompra/baja.ts) y confirma al cliente con config_wa.textos_marketing.baja_confirmada. */
export async function aplicarBaja(ctx: Ctx, origen: "boton" | "chat"): Promise<void> {
  const { deps } = ctx;
  const opts = { clienteId: ctx.clienteId, conversacionId: ctx.conv.id };
  await deps.marcarLeidoYEscribiendo(ctx.m.id).catch(() => {});
  if (!deps.registrarBaja) {
    await deps.avisar(`${ctx.nombreWa ?? ctx.destino} pidió la baja de ofertas y no la pude registrar (falta registrarBaja). Hacelo a mano.`);
    return;
  }
  const r = await deps.registrarBaja(ctx.clienteId, origen);
  if (!r.ok) {
    await deps.avisar(`No pude registrar la baja de ofertas de ${ctx.nombreWa ?? ctx.destino}: ${r.error}. Revisalo.`);
    throw new Error(`registrarBaja: ${r.error}`);
  }
  const e = await deps.enviarTexto(ctx.destino, await textoMarketing(deps, "baja_confirmada"), opts);
  if (!e.ok) console.error(`confirmación de baja a ${ctx.clienteId}: ${e.error}`);
}

/**
 * mk_baja → baja. mk_luego → respuesta corta y nada más. mk_si / mk_pack / mk_una / mk_quiero → la
 * conversación sigue en 'ia' y el vendedor recibe qué oferta aceptó (arma el pedido con crear_pedido_cod).
 * Si Enrique tiene el chat ('humano'), no se le saca: le llega el aviso con la oferta.
 */
export async function aplicarBotonMarketing(ctx: Ctx, accion: AccionMk, orderId: string | null, producto?: string): Promise<void> {
  const { deps } = ctx;
  if (accion === "mk_baja") return aplicarBaja(ctx, "boton");
  const opts = { clienteId: ctx.clienteId, conversacionId: ctx.conv.id };
  if (accion === "mk_luego") {
    if (deps.bloquearSeguimientos) await deps.bloquearSeguimientos(ctx.conv.id).catch((e) => console.error("bloquear seguimientos:", e));
    await deps.marcarLeidoYEscribiendo(ctx.m.id).catch(() => {});
    const e = await deps.enviarTexto(ctx.destino, await textoMarketing(deps, "mas_adelante"), opts);
    if (!e.ok) console.error(`respuesta "más adelante" a ${ctx.clienteId}: ${e.error}`);
    return;
  }
  const oferta = deps.ofertaMarketing ? await deps.ofertaMarketing(ctx.clienteId, orderId) : null;
  let texto = contextoOfertaAceptada(accion, oferta, producto);
  // 08-10: recompra de Facial Wellness con dirección conocida → el resumen sale al toque (un toque más en Confirmar y listo).
  if (producto && deps.contextoRecompraFw) {
    const c = await deps.contextoRecompraFw(ctx.telefono).catch(() => null);
    if (c?.entrega) texto += ` Datos de su última entrega: nombre ${c.entrega.nombre}, ciudad ${c.entrega.ciudad}, dirección ${c.entrega.direccion}. ` +
      `Llamá YA crear_pedido_cod con confirmar=false, 1 unidad del handle ${producto} y esos datos, sin escribir nada antes: ` +
      "le llega el resumen con Confirmar / Corregir y él decide.";
  }
  await deps.completarContenidoMensaje(ctx.m.id, { texto_vendedor: texto });
  if (ctx.conv.estado === "humano" || !deps.pasarAlVendedor) {
    await deps.avisar(`🛒 ${ctx.nombreWa ?? "Cliente"}${ctx.telefono ? ` (${ctx.telefono})` : ""} aceptó una oferta de recompra. ${texto}`);
    return;
  }
  if (ctx.conv.estado !== "ia") await deps.actualizarConversacion(ctx.conv.id, { estado: "ia" });
  await deps.pasarAlVendedor({ conversacion_id: ctx.conv.id, cliente_id: ctx.clienteId, wa_message_id: ctx.m.id, texto });
}
