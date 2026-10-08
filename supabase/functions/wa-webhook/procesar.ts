// Lógica del webhook de WhatsApp (sin I/O directo: todo entra por `Deps`).
// Dueño: subagente B (ola 1). El I/O real está en index.ts.

import { detectarLinkMapas, type LinkMapas, textoLinkMapas } from "../_shared/link_mapas.ts";
import { enlaceWaMe } from "../_shared/telegram_formato.ts";
import { datosFormularioPedido, parsearContacto, parsearFlow, parsearUbicacion } from "../_shared/wa_interactivos.ts";
import { aTextoPlano, textoDeEntrante } from "../_shared/vendedor/interactivos.ts";
import { esDerivacionDeVenta } from "../_shared/vendedor/herramientas.ts";
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
  referral?: { source_id?: string };
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
  conversacionActiva(clienteId: string, origenAnuncioId: string | null): Promise<{ id: string; estado: string }>;
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
}

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

export type EntradaVendedor = { conversacion_id: string; cliente_id: string; wa_message_id: string; texto: string };
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

const PLAZO_DEFAULT = "2 a 5 días hábiles";

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
  ayuda: "Dale {nombre}, contame qué necesitás con tu pedido {pedido} y una persona del equipo te responde por acá.",
  ne_reintentar: "Listo {nombre}, coordinamos con el courier para intentar de nuevo la entrega de tu pedido {pedido}. Te avisamos el día que pase.",
  ne_direccion: "Dale {nombre}, escribime acá la dirección nueva (calle, número, ciudad y una referencia) y la cambiamos.",
  ne_cancelar: "Entendido {nombre}, le pasamos tu pedido {pedido} al equipo para cancelarlo. Si cambiás de idea, escribinos por acá.",
  seg_problema: "Entiendo {nombre}. Contame qué pasó con el producto y lo vemos ahora. Si me mandás una foto, lo resolvemos más rápido.",
  seg_bien_ya: "Gracias {nombre}, qué bueno que llegó todo bien.",
  consentimiento: "¡Qué bueno {nombre}! ¿Te puedo avisar por acá cuando se te estén por acabar y cuando haya novedades de Voltra?",
  consentimiento_si: "Sí, avisame",
  consentimiento_no: "No, gracias",
  cons_si: "Listo, te avisamos por acá. Si en algún momento no querés más avisos, escribí BAJA.",
  cons_no: "Entendido, no te mandamos novedades. Seguimos por acá para lo que necesites con tus pedidos.",
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
  else if (producto) que = `quiere otra bolsa de ${productoDeHandle(producto)} (handle ${producto}; el precio sale del catálogo, ofrecé también el ×2)`;
  else que = "aceptó una oferta de recompra, pero no encontré cuál: preguntale qué quiere";
  return `[oferta aceptada] Tocó "${boton}" en el mensaje de recompra: ${que}. ` +
    "Armá el pedido con crear_pedido_cod (mostrá el resumen y pedí confirmación); si faltan datos de entrega, pedilos.";
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

/** true si el mensaje es solo aceptación: cada palabra pertenece a la lista ("si dale", "ok", "mandame katu"). */
export function esAceptacion(texto: string, aceptaciones: string[]): boolean {
  const n = normalizarTexto(texto);
  if (!n) return false;
  const frases = new Set(aceptaciones.map(normalizarTexto).filter(Boolean));
  if (frases.has(n)) return true;
  const palabras = new Set([...frases].flatMap((f) => f.split(" ")));
  return n.split(" ").every((w) => palabras.has(w));
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
      const texto = textoDeAudio(t);
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
  if (mediaChat && deps.copiarMediaChat) {
    const ruta = `media/${cliente.id}/${m.id}.${EXTENSION_CHAT[mediaChat.mime.split(";")[0].trim().toLowerCase()] ?? "bin"}`;
    const c = await deps.copiarMediaChat(mediaChat.id, ruta)
      .catch((e) => ({ ok: false, error: e instanceof Error ? e.message : String(e) } as { ok: boolean; ruta?: string; mime?: string; error?: string }));
    await deps.completarContenidoMensaje(m.id, c.ok ? { storage_path: c.ruta ?? ruta, mime: c.mime ?? mediaChat.mime } : { storage_error: c.error ?? "no se pudo copiar" })
      .catch(() => {});
  }

  const ctx: Ctx = { deps, m, clienteId: cliente.id, conv, telefono, destino: telefono ?? userId!, nombreWa: contacto?.profile?.name ?? cliente.nombre ?? null };

  const boton = leerBotonConfirmacion(m);
  if (boton) {
    await aplicarRespuestaConfirmacion(ctx, boton.accion, boton.orderId);
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
    if (esAceptacion(m.text.body, aceptaciones)) {
      const conf = (await deps.config("confirmacion")) as { cancelar_h?: number } | null;
      const horas = conf?.cancelar_h ?? 72;
      const desde = new Date(deps.ahora().getTime() - horas * 3600_000).toISOString();
      const pendientes = await deps.pedidosPorEstado(cliente.id, telefono, "pendiente", desde);
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
    if (m.type !== "text") await deps.completarContenidoMensaje(m.id, { texto_vendedor: texto });
    await deps.pasarAlVendedor({ conversacion_id: conv.id, cliente_id: cliente.id, wa_message_id: m.id, texto });
  }
}

// ---------- retomar un chat en 'humano' ----------

export const RETOMAR_HUMANO_H_DEFAULT = CFG_VENDEDOR_DEFAULT.retomar_humano_h ?? 3;
const POSTVENTA_A_HUMANO = new Set(["ayuda", "ne_direccion", "seg_problema"]);

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
  conv: { id: string; estado: string };
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
  const resp = await deps.config("respuestas_confirmacion") as Record<string, string> | null;
  const textoResp = resp?.[CLAVE_RESPUESTA[accion]] ?? resp?.[accion];
  if (!textoResp) avisoDefault("respuestas_confirmacion");
  const plazos = await deps.config("plazos_courier") as Record<string, string> | null;
  const plazo = (pedido.courier && plazos?.[pedido.courier.toLowerCase()]) || PLAZO_DEFAULT;
  const texto = renderizar(textoResp ?? RESPUESTAS_DEFAULT[accion], {
    nombre: primerNombre(nombreDePedido(pedido), ctx.nombreWa),
    plazo,
    pedido: etiqueta,
  });
  await deps.marcarLeidoYEscribiendo(ctx.m.id).catch(() => {});
  const envio = await deps.enviarTexto(ctx.destino, texto, { clienteId: ctx.clienteId, conversacionId: ctx.conv.id });
  if (!envio.ok) fallas.push(`respuesta al cliente: ${envio.error}`);

  // Pago anticipado por transferencia (decisión del 07-10). Con la bandera prendida reemplaza la oferta QR:
  // al cliente le llega un solo ofrecimiento de pago.
  const pa = accion === "conf_si" ? await leerCfgPagoAnticipado(deps) : null;
  const lineasPago: string[] = [];
  if (pa?.activo) {
    const r = await ofrecerPagoAnticipado(ctx, pedido, orderId, objetivo, tags, pa);
    if (r.falla) fallas.push(r.falla);
    if (r.enviada) lineasPago.push(`💸 Se le ofreció pagar ahora por transferencia (Gs ${r.total}).`);
  }

  // Ola 4: oferta de pago por QR después de confirmar, solo con config_wa['ola4.qr'].activo.
  if (accion === "conf_si" && !pa?.activo && deps.ofrecerCobroQR) {
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

  // 5) Aviso a Enrique por Telegram.
  const titulo = accion === "conf_si"
    ? `✅ ${etiqueta} confirmado por el cliente`
    : accion === "conf_corregir"
    ? `✏️ ${etiqueta}: el cliente quiere corregir datos. El chat pasó a humano.`
    : `❌ ${etiqueta}: el cliente canceló. Cancelalo en Shopify si corresponde.`;
  const botones = accion === "conf_corregir"
    ? [[{ texto: "Le escribo yo", callback: `escribo:${orderId}` }]]
    : accion === "conf_cancelar"
    ? [[{ texto: "Cancelar pedido", callback: `cancelar:${orderId}` }]]
    : undefined;
  await deps.avisar([titulo, ...lineasPago, ...fallas.map((f) => `Falla: ${f}`)].join("\n"), botones);
}

// ---------- pago anticipado por transferencia (decisión del dueño, 07-10) ----------
// Después de "Confirmar", se le ofrece al cliente pagar ahora por transferencia para que su pedido salga primero.
// Honesto: sin urgencia inventada; si no paga, sigue contra entrega como siempre. Config: config_wa['pago_anticipado']
// (supabase/seed_pago_anticipado.sql). Enrique verifica cada comprobante en ueno antes de despachar.

export const TAG_OFERTA_PAGO = "OFERTA_PAGO_ANTICIPADO";
export const TAG_COMPROBANTE_PAGO = "PAGO_ANTICIPADO_COMPROBANTE";
export const TAG_PRIORIDAD = "PRIORIDAD";
/** Tags que dicen que el pedido ya está pagado o con comprobante: no se vuelve a ofrecer. */
const TAGS_YA_PAGADO = ["PAGADO_QR"];

export const PAGO_ANTICIPADO_DEFAULT = {
  texto: "📦 ¡Tu pedido {pedido} ya está en preparación!\n\n¿Querés recibirlo antes? Priorizamos tu envío si lo pagás ahora por transferencia:\n\n💳 ueno bank · Caja de ahorro 6193162880\nVOLTRA E.A.S. UNIPERSONAL · RUC 80177762-3\nTotal: Gs {total}\n\nMandanos el comprobante por acá. Si no, pagás al recibir como siempre.\n\nGracias por confiar en nosotros 🙌",
  texto_recibido: "Recibido, gracias. Lo verificamos y tu pedido sale en el primer despacho.",
  dias_comprobante: 7,
};

type CfgPagoAnticipado = { activo: boolean; texto: string; texto_recibido: string; dias_comprobante: number };

async function leerCfgPagoAnticipado(deps: Deps): Promise<CfgPagoAnticipado> {
  const c = await deps.config("pago_anticipado") as Record<string, unknown> | null;
  const txt = (v: unknown, d: string) => (typeof v === "string" && v.trim() ? v : d);
  const dias = Number(c?.dias_comprobante);
  return {
    activo: c?.activo === true,
    texto: txt(c?.texto, PAGO_ANTICIPADO_DEFAULT.texto),
    texto_recibido: txt(c?.texto_recibido, PAGO_ANTICIPADO_DEFAULT.texto_recibido),
    dias_comprobante: Number.isFinite(dias) && dias > 0 ? dias : PAGO_ANTICIPADO_DEFAULT.dias_comprobante,
  };
}

/** true si el pedido ya tiene un tag PAGO_ANTICIPADO_* o está pagado por QR. */
export function pedidoYaPagado(tags: string[] | null | undefined): boolean {
  return (tags ?? []).some((t) => t.startsWith("PAGO_ANTICIPADO_") || TAGS_YA_PAGADO.includes(t));
}

function totalGs(p: Pedido): string | null {
  const n = Math.round(Number(p.total));
  return Number.isFinite(n) && n > 0 ? precioGs(n) : null;
}

/** Manda la oferta y deja el tag OFERTA_PAGO_ANTICIPADO (DB + Shopify) solo si el mensaje salió. */
async function ofrecerPagoAnticipado(
  ctx: Ctx,
  pedido: Pedido,
  orderId: string,
  estado: string,
  tags: string[],
  cfg: CfgPagoAnticipado,
): Promise<{ enviada: boolean; total?: string; falla?: string }> {
  const { deps } = ctx;
  if (pedidoYaPagado(tags) || tags.includes(TAG_OFERTA_PAGO)) return { enviada: false };
  const total = totalGs(pedido);
  if (!total) return { enviada: false, falla: "oferta de pago anticipado: el pedido no tiene total, no la mandé" };
  const texto = renderizar(cfg.texto, {
    nombre: primerNombre(nombreDePedido(pedido), ctx.nombreWa),
    total,
    pedido: pedido.nombre ?? `#${orderId}`,
  });
  const e = await deps.enviarTexto(ctx.destino, texto, { clienteId: ctx.clienteId, conversacionId: ctx.conv.id });
  if (!e.ok) return { enviada: false, falla: `oferta de pago anticipado: ${e.error}` };
  await deps.actualizarPedido(orderId, { estado_confirmacion: estado, tags: [...tags, TAG_OFERTA_PAGO] });
  try {
    const r = await deps.agregarTags(`gid://shopify/Order/${orderId}`, [TAG_OFERTA_PAGO]) as { ok?: boolean; error?: string } | undefined;
    if (r?.ok === false) return { enviada: true, total, falla: `tag ${TAG_OFERTA_PAGO} en Shopify: ${r.error}` };
  } catch (err) {
    return { enviada: true, total, falla: `tag ${TAG_OFERTA_PAGO} en Shopify: ${err instanceof Error ? err.message : err}` };
  }
  return { enviada: true, total };
}

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
 * (tag OFERTA_PAGO_ANTICIPADO), sin comprobante previo y de los últimos `dias_comprobante` días (default 7).
 * Tags PAGO_ANTICIPADO_COMPROBANTE + PRIORIDAD (DB + Shopify), respuesta al cliente y aviso a Enrique.
 * Con el chat en 'humano' que Enrique atiende (mismo criterio que debeRetomarHumano) no se le responde al cliente.
 * Devuelve false si no aplica: el mensaje sigue el flujo normal.
 */
export async function aplicarComprobantePago(ctx: Ctx): Promise<boolean> {
  const { deps, m } = ctx;
  const media = mediaDeComprobante(m);
  if (!media) return false;
  // No depende de `activo`: si la bandera se apagó después de ofrecer, el comprobante igual se registra.
  const cfg = await leerCfgPagoAnticipado(deps);
  const desde = new Date(deps.ahora().getTime() - cfg.dias_comprobante * 86_400_000).toISOString();
  const confirmados = await deps.pedidosPorEstado(ctx.clienteId, ctx.telefono, "confirmado", desde);
  const p = confirmados.find((x) => (x.tags ?? []).includes(TAG_OFERTA_PAGO) && !(x.tags ?? []).includes(TAG_COMPROBANTE_PAGO));
  if (!p) return false;

  const orderId = String(p.shopify_order_id);
  const etiqueta = p.nombre ?? `#${orderId}`;
  const total = totalGs(p) ?? "?";
  const fallas: string[] = [];

  // 1) Base de datos y Shopify.
  const nuevos = [TAG_COMPROBANTE_PAGO, TAG_PRIORIDAD];
  const tags = [...(p.tags ?? []), ...nuevos].filter((t, i, a) => a.indexOf(t) === i);
  await deps.actualizarPedido(orderId, { estado_confirmacion: p.estado_confirmacion, tags });
  try {
    const r = await deps.agregarTags(`gid://shopify/Order/${orderId}`, nuevos) as { ok?: boolean; error?: string } | undefined;
    if (r?.ok === false) fallas.push(`tags Shopify: ${r.error}`);
  } catch (e) {
    fallas.push(`tags Shopify: ${e instanceof Error ? e.message : e}`);
  }

  // 2) Copia del comprobante a Storage (la URL de Meta vence), para que Enrique lo vea desde la bandeja.
  let ruta: string | null = null;
  if (deps.copiarMedia) {
    const destino = `comprobantes/${ctx.clienteId}/${m.id}.${EXTENSION[media.mime.split(";")[0].trim()] ?? "bin"}`;
    const c = await deps.copiarMedia(media.id, destino).catch((e) => ({ ok: false, error: e instanceof Error ? e.message : String(e) } as { ok: boolean; ruta?: string; error?: string }));
    if (c.ok) ruta = c.ruta ?? destino;
    else fallas.push(`copia del comprobante: ${c.error}`);
  }
  await deps.completarContenidoMensaje(m.id, {
    comprobante_pago_anticipado: orderId,
    ...(ruta ? { storage_path: ruta } : {}),
  });

  // 3) Respuesta al cliente, salvo que Enrique tenga el chat.
  const responder = ctx.conv.estado !== "humano" || await debeRetomarHumano(ctx.conv.id, ctx.clienteId, deps);
  if (responder) {
    await deps.marcarLeidoYEscribiendo(m.id).catch(() => {});
    const texto = renderizar(cfg.texto_recibido, { nombre: primerNombre(nombreDePedido(p), ctx.nombreWa), pedido: etiqueta, total });
    const e = await deps.enviarTexto(ctx.destino, texto, { clienteId: ctx.clienteId, conversacionId: ctx.conv.id });
    if (!e.ok) fallas.push(`respuesta al cliente: ${e.error}`);
  }

  // 4) Aviso a Enrique (no hay helper para reenviar el archivo a Telegram: va la ruta en Storage y el media id).
  const lineas = [
    `💸 ${etiqueta}: el cliente mandó comprobante de pago anticipado (Gs ${total}). Verificalo en ueno y despachalo primero.`,
    ruta ? `Comprobante: Storage wa-media/${ruta}` : `Comprobante: media de WhatsApp ${media.id} (wamid ${m.id})`,
  ];
  if (!responder) lineas.push("El chat está con vos: no le respondí al cliente.");
  lineas.push(...fallas.map((f) => `Falla: ${f}`));
  await deps.avisar(lineas.join("\n"), [[{ texto: "Le escribo yo", callback: `escribo:${orderId}` }]]);
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
    return;
  }

  // El resto: respuesta al cliente + aviso a Enrique.
  const pasaAHumano = accion === "ayuda" || accion === "ne_direccion" || accion === "seg_problema";
  if (pasaAHumano) await deps.actualizarConversacion(ctx.conv.id, { estado: "humano" });

  const respuesta = await deps.enviarTexto(ctx.destino, renderizar(await textoBoton(deps, accion), vars), opts);

  const quien = `${ctx.nombreWa || nombre || "Cliente"}${ctx.telefono ? ` (${ctx.telefono})` : ""}`;
  const envio = pedido?.estado_envio ? ` Estado del envío: ${pedido.estado_envio}.` : "";
  const courier = pedido?.courier ? ` con ${pedido.courier}` : "";
  const titulo: Record<string, string> = {
    ayuda: `🆘 ${etiqueta}: ${quien} tocó "Necesito ayuda".${envio} El chat pasó a humano.`,
    ne_reintentar: `🔁 ${etiqueta}: ${quien} pidió volver a intentar la entrega. Coordiná el reintento${courier}.${envio}`,
    ne_direccion: `📍 ${etiqueta}: ${quien} quiere cambiar la dirección de entrega. Le pedí la nueva; el chat pasó a humano.`,
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
  await deps.avisar(lineas.join("\n"), filas);
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
    await deps.marcarLeidoYEscribiendo(ctx.m.id).catch(() => {});
    const e = await deps.enviarTexto(ctx.destino, await textoMarketing(deps, "mas_adelante"), opts);
    if (!e.ok) console.error(`respuesta "más adelante" a ${ctx.clienteId}: ${e.error}`);
    return;
  }
  const oferta = deps.ofertaMarketing ? await deps.ofertaMarketing(ctx.clienteId, orderId) : null;
  const texto = contextoOfertaAceptada(accion, oferta, producto);
  await deps.completarContenidoMensaje(ctx.m.id, { texto_vendedor: texto });
  if (ctx.conv.estado === "humano" || !deps.pasarAlVendedor) {
    await deps.avisar(`🛒 ${ctx.nombreWa ?? "Cliente"}${ctx.telefono ? ` (${ctx.telefono})` : ""} aceptó una oferta de recompra. ${texto}`);
    return;
  }
  if (ctx.conv.estado !== "ia") await deps.actualizarConversacion(ctx.conv.id, { estado: "ia" });
  await deps.pasarAlVendedor({ conversacion_id: ctx.conv.id, cliente_id: ctx.clienteId, wa_message_id: ctx.m.id, texto });
}
