// Lógica pura del webhook de Shopify y de la conciliación horaria.
// Todo el I/O (base de datos, reloj, normalizador de teléfono) entra por `Deps`,
// así los tests no tocan Supabase ni Shopify.

import { alas8HabilDespues, diaEntrega, horaLocal, inicioDespacho, plazoParaEnDesdeHoy, plazoPorCiudad, rangoEntrega, visperaEntrega } from "../_shared/plazo_zona.ts";
import { verificarHmacShopify } from "../_shared/shopify.ts";
import { claveOfertaPrioridad, motivoSinOfertaPrioridad, pedidoPagado, PLANTILLA_PAGO_PRIORIDAD } from "../_shared/pago_anticipado.ts";
import { CONFIG_DEFECTO, envioTerminal, PLANTILLA_ENTREGA_MANANA } from "../procesar-envios/procesar.ts";

export const TAG_BORRADOR_RELEASIT = "abandoned_checkout_releasit_cod_form";

/** Tópicos que procesa esta función (header X-Shopify-Topic). */
export const TOPICOS = ["orders/create", "orders/updated", "draft_orders/create"] as const;

/**
 * Nombres de plantilla por tipo de envío programado. La función procesar-envios (subagente F)
 * decide qué hace con cada una; "ret" y "canc" son acciones (retener / cancelar) además de aviso.
 */
/** "enrique ramirez" → "Enrique Ramirez" (Releasit guarda lo que tipea el cliente). */
export function conMayuscula(n: string | null): string | null {
  if (!n) return n;
  return n.trim().split(/\s+/).map((p) => p ? p[0].toLocaleUpperCase("es") + p.slice(1) : p).join(" ");
}

export const PLANTILLAS = {
  conf: "voltra_confirmacion_pedido_v3", // 07-10: formato Facial Wellness con etiquetas en negrita, aprobada por Meta
  rec: "voltra_recordatorio_confirmacion", // supabase/plantillas/voltra_recordatorio_confirmacion.json (F)
  ret: "accion:retener", // no es plantilla: tag RETENIDO_SIN_RESPUESTA + estado 'retenido'
  canc: "accion:cancelar", // no es plantilla: orderCancel + estado 'cancelado_sin_respuesta'
  // 10-10 (confirmación rápida): aviso a Enrique por Telegram (no es WhatsApp) y último aviso al cliente.
  avi: "accion:aviso_enrique",
  ult: "voltra_ultimo_aviso_confirmacion",
} as const;

/** 10-10: la cancelación automática nunca sale antes de 24 h desde el pedido. */
export const CANCELAR_MIN_H = 24;

// ---------- 12-10: plantillas nuevas que salen solo después de que Meta las aprueba ----------
// config_wa.plantillas_activas = {"voltra_confirmacion_pedido_v4": false, "voltra_entrega_manana": false}
// (también vale una lista de nombres). Sin la clave, apagada o si falla la lectura, sigue lo de siempre (v3 y
// voltra_entrega_hoy). Enrique (o el implementador) la prende cuando Meta aprueba cada una.

/** Confirmación con el día de entrega ("Te llega: …") y botones Confirmo / Corregir / Cancelar pedido. */
export const PLANTILLA_CONF_V4 = "voltra_confirmacion_pedido_v4";
// PLANTILLA_ENTREGA_MANANA (procesar-envios): aviso de la víspera para Asunción y Central con Ok, lo espero / Reprogramar.

export type PlantillasActivas = Record<string, boolean>;

/** config_wa.plantillas_activas → {nombre: true}. Acepta objeto de booleanos o lista de nombres; lo demás, apagado. */
export function plantillasActivasDesde(v: unknown): PlantillasActivas {
  if (Array.isArray(v)) return Object.fromEntries(v.filter((x): x is string => typeof x === "string").map((x) => [x.trim(), true]));
  if (!v || typeof v !== "object") return {};
  return Object.fromEntries(Object.entries(v as Record<string, unknown>).filter(([, x]) => x === true).map(([k]) => [k, true]));
}

export const plantillaActiva = (a: PlantillasActivas | undefined, nombre: string) => a?.[nombre] === true;

/** Tags de Shopify que fijan estado_confirmacion (si alguien los pone a mano o desde otro módulo). */
const TAG_A_ESTADO: Array<[string, string]> = [
  ["CANCELADO_CLIENTE", "cancelado_cliente"],
  ["RETENIDO_SIN_RESPUESTA", "retenido"],
  ["A_CORREGIR", "a_corregir"],
  ["CONFIRMADO", "confirmado"],
];

export type ConfigConfirmacion = {
  confirmar_min?: number; // demora de la confirmación; si no está en config_wa sale al instante (07-10: Enrique la quiere lo más rápido posible)
  // 10-10 (contrato con la pantalla de Config): recordatorio_min, aviso_enrique_h, ultimo_aviso_h, cancelar_h.
  recordatorio_min?: number;
  aviso_enrique_h?: number;
  ultimo_aviso_h?: number;
  cancelar_h: number;
  // Claves viejas (antes del 10-10): se aceptan si falta recordatorio_min. retener_h solo vale con la config vieja.
  recordatorio_h?: number;
  retener_h?: number;
};

/** true si la config es la del contrato del 10-10 (sin retención a las 48 h). */
export function esConfigNueva(cfg: ConfigConfirmacion): boolean {
  return typeof cfg.recordatorio_min === "number" || typeof cfg.aviso_enrique_h === "number" ||
    typeof cfg.ultimo_aviso_h === "number";
}

/** config_wa.confirmacion usable: cancelar_h y un recordatorio (recordatorio_min o, viejo, recordatorio_h). */
export function configConfirmacionValida(v: unknown): v is ConfigConfirmacion {
  if (!v || typeof v !== "object") return false;
  const c = v as ConfigConfirmacion;
  return typeof c.cancelar_h === "number" && minutosRecordatorio(c) !== null;
}

/** Minutos hasta el recordatorio: recordatorio_min, o recordatorio_h × 60 (config vieja). null = no se programa. */
export function minutosRecordatorio(cfg: ConfigConfirmacion): number | null {
  if (typeof cfg.recordatorio_min === "number") return cfg.recordatorio_min;
  if (typeof cfg.recordatorio_h === "number") return cfg.recordatorio_h * 60;
  return null;
}

/** Forma común de un pedido, venga del webhook (REST) o de la conciliación (GraphQL). */
export type PedidoNormalizado = {
  shopifyOrderId: number;
  gid: string;
  nombre: string | null;
  telefonoCrudo: string | null;
  nombreCliente: string | null;
  total: number | null;
  productos: string | null; // "1 Tiras nasales, 2 Parches"
  direccion: string | null;
  ciudad: string | null;
  tags: string[];
  esBorrador: boolean;
  cancelado: boolean;
  creadoEn: string | null;
  raw: unknown;
};

export type FilaPedido = {
  shopify_order_id: number;
  nombre: string | null;
  cliente_id: string | null;
  telefono: string | null;
  total: number | null;
  tags: string[];
  es_borrador: boolean;
  raw: unknown;
  estado_confirmacion?: string; // solo se manda cuando hay que cambiarlo
};

export type FilaEnvio = {
  cliente_id: string;
  shopify_order_id: number;
  plantilla: string;
  variables: Record<string, unknown>;
  categoria: "utilidad";
  enviar_desde: string;
  clave_unica: string;
};

export type PedidoExistente = { estado_confirmacion: string; es_borrador: boolean; estado_envio?: string | null } | null;

export interface Deps {
  normalizarTelefono(x: string): string | null;
  ahora(): Date;
  leerConfigConfirmacion(): Promise<ConfigConfirmacion>;
  buscarPedido(id: number): Promise<PedidoExistente>;
  /** upsert por teléfono; devuelve el id del cliente. */
  upsertCliente(c: { telefono: string; nombre: string | null }): Promise<string>;
  /** upsert por shopify_order_id; si `estado_confirmacion` no viene, no se toca. */
  upsertPedido(p: FilaPedido): Promise<void>;
  /** insert ... on conflict (clave_unica) do nothing. */
  programarEnvios(filas: FilaEnvio[]): Promise<void>;
  /**
   * pasa a 'cancelado' los envíos 'pendiente' del pedido; los avisos de envío (courier:…) y la oferta de pago con
   * prioridad (prio:…, 12-10) solo con `incluirAvisos` (pedido cancelado).
   */
  cancelarEnviosPendientes(id: number, opts?: { incluirAvisos?: boolean }): Promise<void>;
  /** Dispara procesar-envios ya, sin esperar al cron del minuto (opcional; si falla, el cron lo manda igual). */
  dispararEnvios?(): Promise<void>;
  /**
   * Pedido nuevo → evento temprano a Meta si el cliente vino de un anuncio de WhatsApp (lead_meta.ts).
   * Fire-and-forget: procesarPedido NO lo espera (io.ts lo deja vivo con EdgeRuntime.waitUntil). Opcional: solo
   * lo pasa shopify-webhook (la conciliación horaria no lo manda).
   */
  notificarPedidoMeta?(p: { shopifyOrderId: number; clienteId: string; total: number | null; creadoEn: string | null }): Promise<unknown>;
  /** Deshace el "preparado" (cancela los fulfillments) de un pedido que no se podía despachar. Opcional (09-10). */
  revertirPreparado?(orderId: number): Promise<{ ok: boolean; error?: string }>;
  /** Aviso a Enrique por Telegram (HTML). Opcional (09-10). */
  avisar?(textoHtml: string): Promise<unknown>;
  /** Transportadora que se le asignó en Despacho (ventas.transportadora: 'lucero' | 'pap' | …), o null. Opcional (08-10). */
  courierDePedido?(nombrePedido: string | null): Promise<string | null>;
  /** 12-10: config_wa.plantillas_activas ya parseada. Opcional: sin esto (o si falla) van las plantillas de siempre. */
  leerPlantillasActivas?(): Promise<PlantillasActivas>;
}

export type ResultadoProceso = {
  shopifyOrderId: number;
  accion: "borrador_guardado" | "programado" | "actualizado" | "sin_telefono";
  telefono: string | null;
  estadoConfirmacion?: string;
  enviosProgramados: number;
  enviosCancelados: boolean;
};

// ---------------------------------------------------------------------------
// Normalización de entrada
// ---------------------------------------------------------------------------

type Dict = Record<string, unknown>;
const s = (v: unknown): string | null => (typeof v === "string" && v.trim() ? v.trim() : null);
const obj = (v: unknown): Dict => (v && typeof v === "object" ? v as Dict : {});

function tagsDe(v: unknown): string[] {
  if (Array.isArray(v)) return v.map(String).map((t) => t.trim()).filter(Boolean);
  if (typeof v === "string") return v.split(",").map((t) => t.trim()).filter(Boolean);
  return [];
}

function numero(v: unknown): number | null {
  const n = typeof v === "number" ? v : typeof v === "string" ? Number(v) : NaN;
  return Number.isFinite(n) ? n : null;
}

const CLAVE_TELEFONO = /tel|phone|whats|celu|cel\b|movil|móvil|numero|número/i;

/** Candidatos de teléfono en orden de preferencia. */
function candidatosTelefono(c: {
  phone?: unknown;
  envio?: unknown;
  facturacion?: unknown;
  cliente?: unknown;
  clienteDir?: unknown;
  atributos?: Array<{ k: string; v: unknown }>;
}): string[] {
  const lista = [c.phone, c.envio, c.facturacion, c.cliente, c.clienteDir];
  for (const a of c.atributos ?? []) if (CLAVE_TELEFONO.test(a.k)) lista.push(a.v);
  return lista.map(s).filter((x): x is string => !!x);
}

function productosDe(items: unknown): string | null {
  if (!Array.isArray(items)) return null;
  const t = items.map((i) => {
    const o = obj(i);
    const titulo = s(o.title) ?? s(o.name);
    return titulo ? `${numero(o.quantity) ?? 1} ${titulo}` : null;
  }).filter(Boolean).join(", ");
  return t || null;
}

/** 129000 → "129.000" (miles con punto, sin decimales). */
export function formatoGs(n: number | null): string | null {
  if (n === null) return null;
  return Math.round(n).toString().replace(/\B(?=(\d{3})+(?!\d))/g, ".");
}

function nombreDe(...partes: unknown[]): string | null {
  for (const p of partes) {
    if (Array.isArray(p)) {
      const j = p.map(s).filter(Boolean).join(" ").trim();
      if (j) return j;
    } else if (s(p)) return s(p);
  }
  return null;
}

/** Payload REST de orders/create, orders/updated o draft_orders/create. */
export function normalizarDesdeWebhook(topic: string, p: Dict): PedidoNormalizado {
  const esBorrador = topic.startsWith("draft_orders/");
  const ship = obj(p.shipping_address);
  const bill = obj(p.billing_address);
  const cust = obj(p.customer);
  const atributos = (Array.isArray(p.note_attributes) ? p.note_attributes : [])
    .map((a) => ({ k: String(obj(a).name ?? ""), v: obj(a).value }));
  const tels = candidatosTelefono({
    phone: p.phone,
    envio: ship.phone,
    facturacion: bill.phone,
    cliente: cust.phone,
    clienteDir: obj(cust.default_address).phone,
    atributos,
  });
  const id = Number(p.id);
  return {
    shopifyOrderId: id,
    gid: s(p.admin_graphql_api_id) ?? `gid://shopify/${esBorrador ? "DraftOrder" : "Order"}/${id}`,
    nombre: s(p.name),
    telefonoCrudo: tels[0] ?? null,
    nombreCliente: nombreDe(s(ship.name), [ship.first_name, ship.last_name], [cust.first_name, cust.last_name]),
    total: numero(p.total_price),
    productos: productosDe(p.line_items),
    direccion: nombreDe([ship.address1, ship.address2]),
    ciudad: s(ship.city),
    tags: tagsDe(p.tags),
    esBorrador,
    cancelado: !!p.cancelled_at,
    creadoEn: s(p.created_at),
    raw: p,
  };
}

/** Nodo de `orders` (GraphQL 2026-10) tal como lo pide shopify-conciliar. */
export function normalizarDesdeGraphQL(n: Dict): PedidoNormalizado {
  const ship = obj(n.shippingAddress);
  const bill = obj(n.billingAddress);
  const cust = obj(n.customer);
  const atributos = (Array.isArray(n.customAttributes) ? n.customAttributes : [])
    .map((a) => ({ k: String(obj(a).key ?? ""), v: obj(a).value }));
  const tels = candidatosTelefono({
    phone: n.phone,
    envio: ship.phone,
    facturacion: bill.phone,
    cliente: obj(cust.defaultPhoneNumber).phoneNumber,
    atributos,
  });
  const gid = String(n.id);
  const esBorrador = gid.includes("/DraftOrder/");
  return {
    shopifyOrderId: Number(n.legacyResourceId ?? gid.split("/").pop()),
    gid,
    nombre: s(n.name),
    telefonoCrudo: tels[0] ?? null,
    nombreCliente: nombreDe(s(ship.name), [ship.firstName, ship.lastName], [cust.firstName, cust.lastName]),
    total: numero(obj(obj(n.totalPriceSet).shopMoney).amount),
    productos: productosDe(obj(n.lineItems).nodes),
    direccion: nombreDe([ship.address1, ship.address2]),
    ciudad: s(ship.city),
    tags: tagsDe(n.tags),
    esBorrador,
    cancelado: !!n.cancelledAt,
    creadoEn: s(n.createdAt),
    raw: n,
  };
}

// ---------------------------------------------------------------------------
// Reglas
// ---------------------------------------------------------------------------

export function estadoDesdeTags(tags: string[]): string | null {
  const set = new Set(tags.map((t) => t.toUpperCase()));
  for (const [tag, estado] of TAG_A_ESTADO) if (set.has(tag)) return estado;
  return null;
}

export function armarEnvios(
  ped: PedidoNormalizado,
  clienteId: string,
  telefono: string,
  cfg: ConfigConfirmacion,
  ahora: Date,
  activas?: PlantillasActivas,
): FilaEnvio[] {
  const base = ahora.getTime();
  const min = 60_000, h = 3_600_000;
  // 12-10: con la v4 aprobada, la confirmación dice el día de entrega ("Te llega: hoy o mañana martes 13/10").
  const v4 = plantillaActiva(activas, PLANTILLA_CONF_V4);
  const variables = {
    // Plantilla voltra_confirmacion_pedido_v2: pedido, nombre, productos, total_texto, direccion, ciudad.
    nombre: conMayuscula(ped.nombreCliente),
    productos: ped.productos,
    total: ped.total,
    total_texto: formatoGs(ped.total),
    direccion: ped.direccion,
    ciudad: ped.ciudad,
    pedido: ped.nombre,
    telefono,
    order_gid: ped.gid,
    ...(v4 ? { dia_entrega: diaEntrega(ped.ciudad, ahora).texto } : {}),
  };
  const fila = (tipo: keyof typeof PLANTILLAS, ms: number): FilaEnvio => ({
    cliente_id: clienteId,
    shopify_order_id: ped.shopifyOrderId,
    plantilla: tipo === "conf" && v4 ? PLANTILLA_CONF_V4 : PLANTILLAS[tipo],
    variables,
    categoria: "utilidad",
    // 10-10: el pedido de prueba del despliegue no puede salir antes de que la prueba lo cancele (le llegaba a Enrique).
    enviar_desde: new Date(base + ms + ((ped.tags ?? []).some((t) => t.toUpperCase() === "PRUEBA_E2E") ? 30 * 60_000 : 0)).toISOString(),
    clave_unica: `${tipo}:${ped.shopifyOrderId}`,
  });
  // 10-10: conf → rec (+recordatorio_min) → avi (Telegram a Enrique) → ult (último aviso) → canc (≥ 24 h).
  // La noche (ult y canc a las 8:00) y el "solo si sigue pendiente" los resuelve procesar-envios al ejecutar.
  const filas = [fila("conf", (cfg.confirmar_min ?? 0) * min)];
  const recMin = minutosRecordatorio(cfg);
  if (recMin !== null) filas.push(fila("rec", recMin * min));
  if (typeof cfg.aviso_enrique_h === "number") filas.push(fila("avi", cfg.aviso_enrique_h * h));
  if (typeof cfg.ultimo_aviso_h === "number") filas.push(fila("ult", cfg.ultimo_aviso_h * h));
  // Retención: solo con la config vieja (el contrato del 10-10 la saca).
  if (!esConfigNueva(cfg) && typeof cfg.retener_h === "number") filas.push(fila("ret", cfg.retener_h * h));
  filas.push(fila("canc", Math.max(cfg.cancelar_h, CANCELAR_MIN_H) * h));
  return filas;
}

/** Por qué un pedido marcado preparado no se podía despachar (null = se podía). 09-10. */
export function motivoParaNoDespachar(ped: PedidoNormalizado, estadoConfirmacion: string | undefined): string | null {
  const t = ped.tags.map((x) => x.toUpperCase());
  if (t.includes("FALTAN_DATOS")) return "le faltan datos de la dirección";
  if (estadoConfirmacion !== "confirmado" && !t.includes("CONFIRMADO")) return "el cliente todavía no confirmó";
  if (t.includes("PAGO_ANTICIPADO_COMPROBANTE") && !estaPagado(ped)) return "mandó comprobante de pago y todavía no lo verificaste en ueno";
  return null;
}

/**
 * Pagado antes de la entrega: Shopify "paid" (REST o GraphQL) o tag PAGO_VERIFICADO (transferencia verificada).
 * 12-10: también PAGADO (botón "Recibido" del pago con prioridad) y PAGADO_QR (_shared/pago_anticipado.ts).
 */
export function estaPagado(ped: PedidoNormalizado): boolean {
  return pedidoPagado({ tags: ped.tags, raw: ped.raw });
}

/** El pedido figura como preparado (fulfilled) en Shopify: REST (webhook) o GraphQL (conciliación). */
export function estaPreparado(raw: unknown): boolean {
  const r = obj(raw);
  return s(r.fulfillment_status)?.toLowerCase() === "fulfilled" || s(r.displayFulfillmentStatus)?.toUpperCase() === "FULFILLED";
}

const NOMBRE_COURIER: Record<string, string> = { lucero: "Lucero del Este", pap: "Punto a Punto" };

export function armarAvisoPreparado(ped: PedidoNormalizado, clienteId: string, courier: string | null, ahora: Date): FilaEnvio {
  const c = courier?.toLowerCase() ?? "";
  // 10-10: días reales desde el despacho (sin sábados ni domingos), igual que lo que dice el vendedor.
  const plazo = plazoParaEnDesdeHoy(ped.ciudad, inicioDespacho(ahora), courier);
  return {
    cliente_id: clienteId,
    shopify_order_id: ped.shopifyOrderId,
    plantilla: "voltra_pedido_despachado",
    // Plantilla: Hola {{nombre}}, tu pedido de Voltra ({{productos}}) ya salió con {{courier}}. Te llega en {{plazo}}…{{total}}
    variables: {
      nombre: conMayuscula(ped.nombreCliente?.trim().split(/\s+/)[0] ?? null),
      productos: ped.productos,
      courier: NOMBRE_COURIER[c] ?? "nuestro courier",
      plazo,
      total: formatoGs(ped.total),
    },
    categoria: "utilidad",
    // Fin de semana: sale el lunes, y el "ya salió" también (09-10).
    enviar_desde: inicioDespacho(ahora).toISOString(),
    clave_unica: `courier:${ped.shopifyOrderId}:DESPACHADO`,
  };
}

/** Minutos desde que Shopify creó el pedido del bot: un orders/updated de un pedido viejo no dispara la oferta. */
export const OFERTA_WHATSAPP_MAX_MIN = 30;

/**
 * 12-10 (decisión del dueño): la oferta de pagar antes y salir con prioridad sale al CONFIRMAR. Los pedidos web la
 * reciben en wa-webhook cuando el cliente toca Confirmo. Los del bot de WhatsApp nacen confirmados (crear_pedido_cod
 * los crea con ORIGEN_WHATSAPP + CONFIRMADO): acá se programa `prio:<id>` cuando llega el pedido recién creado.
 * Una sola vez por pedido (misma clave que usa wa-webhook). null si no es del bot, no está confirmado, no es reciente
 * o no corresponde (pagado, retiro, prueba, mayorista, cancelado, ya preparado). procesar-envios lo manda como texto
 * libre solo con la ventana de 24 h abierta y pago_prioridad activo con alias.
 */
export function armarOfertaPrioridad(
  ped: PedidoNormalizado,
  clienteId: string,
  ahora: Date,
  estadoEnvio?: string | null,
): FilaEnvio | null {
  const t = ped.tags.map((x) => x.toUpperCase());
  if (ped.esBorrador || ped.cancelado || !t.includes("ORIGEN_WHATSAPP") || !t.includes("CONFIRMADO")) return null;
  if (!creadoHaceMenosDe(ped.creadoEn, ahora, OFERTA_WHATSAPP_MAX_MIN)) return null;
  if (motivoSinOfertaPrioridad({ tags: ped.tags, raw: ped.raw, estado_envio: estadoEnvio })) return null;
  return {
    cliente_id: clienteId,
    shopify_order_id: ped.shopifyOrderId,
    plantilla: PLANTILLA_PAGO_PRIORIDAD,
    variables: { pedido: ped.nombre },
    categoria: "utilidad",
    enviar_desde: ahora.toISOString(),
    clave_unica: claveOfertaPrioridad(ped.shopifyOrderId),
  };
}

/**
 * 09-10: un aviso más después del "ya salió", para bajar los "no estaba / no tenía la plata". Todas las ciudades,
 * contando desde el despacho (fin de semana → lunes 8:00):
 * - CDE y alrededores (hoy o mañana): "ya está por llegar" (voltra_entrega_proxima) 2 h después del despacho.
 * - Asunción y Central: "hoy te llega" (voltra_entrega_hoy) a las 8:00 de Asunción del día siguiente.
 * - Interior (no se sabe el día exacto): "ya está por llegar" a las 8:00 del segundo día.
 * 12-10: con voltra_entrega_manana aprobada (plantillas_activas), Asunción y Central reciben en cambio el aviso de la
 * víspera a las 18:00 del día de despacho ("mañana martes 13/10" / el viernes "el lunes 19/10") con Ok / Reprogramar.
 * Misma clave: no se duplica y se cancela igual si se cancela el pedido. Pedidos ya pagados siguen con el de antes
 * (el nuevo dice "Tené Gs …"). Si el despacho se marca después del horario de avisos, también sigue el de antes.
 */
export function armarRecordatorioEntrega(
  ped: PedidoNormalizado,
  clienteId: string,
  ahoraReal: Date,
  activas?: PlantillasActivas,
  courier?: string | null,
): FilaEnvio | null {
  const ahora = inicioDespacho(ahoraReal);
  const plazo = plazoPorCiudad(ped.ciudad);
  // 10-10: 8:00 de Asunción del n-ésimo día HÁBIL (antes contaba días corridos y un despacho del viernes avisaba
  // "hoy te llega" el sábado, que la transportadora no trabaja).
  const alas8 = (dias: number) => alas8HabilDespues(ahora, dias);
  const cde = plazo === "hoy mismo o en 24 h";
  // 12-10: solo si el courier entrega al día siguiente (Itá, Guarambaré, Ypacaraí van con Lucero programada: sin
  // "mañana / hoy te llega").
  const metro = (plazo === "24 a 48 h" || plazo === "24 a 72 h") && rangoEntrega(ped.ciudad, courier).rango[0] === 1;
  const nombre = conMayuscula(ped.nombreCliente?.trim().split(/\s+/)[0] ?? null);
  if (metro && plantillaActiva(activas, PLANTILLA_ENTREGA_MANANA) && !estaPagado(ped)) {
    const v = visperaEntrega(ahoraReal);
    if (horaLocal(v.enviar) < CONFIG_DEFECTO.horarioAvisosEnvio.hasta) {
      return {
        cliente_id: clienteId,
        shopify_order_id: ped.shopifyOrderId,
        plantilla: PLANTILLA_ENTREGA_MANANA,
        // fecha_entrega: procesar-envios no lo manda si ya llegó ese día (un "mañana" atrasado sería falso).
        variables: { nombre, dia_entrega: v.dia, total: formatoGs(ped.total), fecha_entrega: v.entrega },
        categoria: "utilidad",
        enviar_desde: v.enviar.toISOString(),
        clave_unica: `courier:${ped.shopifyOrderId}:ENTREGA_HOY`,
      };
    }
  }
  const enviar = cde ? new Date(ahora.getTime() + 2 * 3_600_000) : metro ? alas8(1) : alas8(2);
  return {
    cliente_id: clienteId,
    shopify_order_id: ped.shopifyOrderId,
    plantilla: metro ? "voltra_entrega_hoy" : "voltra_entrega_proxima",
    variables: { nombre, total: formatoGs(ped.total) },
    categoria: "utilidad",
    enviar_desde: enviar.toISOString(),
    clave_unica: `courier:${ped.shopifyOrderId}:ENTREGA_HOY`,
  };
}

/**
 * Mismo camino para webhook y conciliación.
 * - Borrador: guarda cliente (si hay teléfono) y pedido con es_borrador=true; no programa nada.
 * - Pedido: upsert de cliente y pedido. Programa los 4 envíos solo si el pedido sigue 'pendiente',
 *   no está cancelado y tiene teléfono válido. Repetir no duplica (clave_unica).
 * - Si Shopify trae una tag de estado (CONFIRMADO, etc.) o el pedido fue cancelado, actualiza
 *   estado_confirmacion y cancela los envíos pendientes.
 */
/** true si Shopify creó el pedido hace menos de `min` minutos (fecha inválida o ausente → false). */
export function creadoHaceMenosDe(creadoEn: string | null | undefined, ahora: Date, min: number): boolean {
  const t = creadoEn ? Date.parse(creadoEn) : NaN;
  return Number.isFinite(t) && ahora.getTime() - t < min * 60_000;
}

/** 12-10: plantillas aprobadas; si no se puede leer, ninguna nueva (sigue lo de siempre) y no frena el webhook. */
async function plantillasActivas(deps: Deps): Promise<PlantillasActivas> {
  if (!deps.leerPlantillasActivas) return {};
  return await deps.leerPlantillasActivas().catch((e) => {
    console.warn("plantillas_activas:", e instanceof Error ? e.message : e);
    return {};
  });
}

export async function procesarPedido(ped: PedidoNormalizado, deps: Deps): Promise<ResultadoProceso> {
  if (!Number.isFinite(ped.shopifyOrderId)) throw new Error("Pedido sin id");
  const telefono = ped.telefonoCrudo ? deps.normalizarTelefono(ped.telefonoCrudo) : null;
  const clienteId = telefono
    ? await deps.upsertCliente({ telefono, nombre: ped.nombreCliente })
    : null;

  const fila: FilaPedido = {
    shopify_order_id: ped.shopifyOrderId,
    nombre: ped.nombre,
    cliente_id: clienteId,
    telefono,
    total: ped.total,
    tags: ped.tags,
    es_borrador: ped.esBorrador,
    raw: ped.raw,
  };

  if (ped.esBorrador) {
    await deps.upsertPedido(fila);
    return {
      shopifyOrderId: ped.shopifyOrderId,
      accion: "borrador_guardado",
      telefono,
      enviosProgramados: 0,
      enviosCancelados: false,
    };
  }

  const existente = await deps.buscarPedido(ped.shopifyOrderId);
  const estadoTag = estadoDesdeTags(ped.tags);
  // Un pedido cancelado en Shopify sin tag no cambia estado_confirmacion: solo frena los envíos.
  if (estadoTag && estadoTag !== existente?.estado_confirmacion) fila.estado_confirmacion = estadoTag;
  await deps.upsertPedido(fila);
  const esPruebaE2E = ped.tags.some((t) => t.toUpperCase() === "PRUEBA_E2E");

  // Pedido nuevo: señal temprana a Meta (sin esperar; un error acá nunca frena el webhook).
  // 12-10: "nuevo" = no estaba guardado O Shopify lo creó hace menos de 15 min. El vendedor IA guarda el pedido apenas
  // lo crea (registrarComoReleasit, sin envío a Meta) y el webhook llega segundos después con el pedido ya guardado:
  // con solo `!existente` esos pedidos nunca mandaban el evento. El candado de eventos_crudos evita el doble envío.
  if ((!existente || creadoHaceMenosDe(ped.creadoEn, deps.ahora(), 15)) && !ped.cancelado && !esPruebaE2E && clienteId && deps.notificarPedidoMeta) {
    try {
      deps.notificarPedidoMeta({ shopifyOrderId: ped.shopifyOrderId, clienteId, total: ped.total, creadoEn: ped.creadoEn })
        ?.catch?.((e) => console.warn("notificarPedidoMeta:", e instanceof Error ? e.message : e));
    } catch (e) {
      console.warn("notificarPedidoMeta:", e instanceof Error ? e.message : e);
    }
  }

  // 08-10: marcado como PREPARADO en Shopify (fulfillment) → aviso "tu pedido ya salió" (voltra_pedido_despachado).
  // Misma clave que usa importar-courier para DESPACHADO: si después se importa el reporte del courier, no se repite.
  // 09-10: si el courier ya lo entregó o devolvió (estado_envio terminal), no se programan avisos de entrega.
  // Retiro en persona (RETIRO_EN_CASA): no hay courier, no van los avisos de "ya salió" ni "hoy te llega".
  const retira = ped.tags.some((t) => t.toUpperCase() === "RETIRO_EN_CASA");
  // 09-10: Enrique marca "preparado" a todos los "No preparado" de una. Si entre ellos hay uno que no se podía
  // despachar, se devuelve a "No preparado", no se avisa al cliente y se le avisa a él.
  const motivoNoDespachar = estaPreparado(ped.raw) && !ped.cancelado && !esPruebaE2E && !retira ? motivoParaNoDespachar(ped, fila.estado_confirmacion ?? existente?.estado_confirmacion) : null;
  if (motivoNoDespachar && deps.revertirPreparado) {
    const r = await deps.revertirPreparado(ped.shopifyOrderId).catch((e) => ({ ok: false, error: e instanceof Error ? e.message : String(e) }));
    await deps.avisar?.(r.ok
      ? `↩️ <b>${ped.nombre ?? ped.shopifyOrderId}</b> lo marcaste preparado pero ${motivoNoDespachar}. Lo devolví a "No preparado" y no le avisé al cliente. No lo despaches todavía.`
      : `⚠️ <b>${ped.nombre ?? ped.shopifyOrderId}</b> lo marcaste preparado pero ${motivoNoDespachar}. No pude devolverlo a "No preparado" (${r.error}): sacalo a mano y no lo despaches.`)?.catch?.(() => {});
  }
  if (!motivoNoDespachar && !ped.cancelado && !esPruebaE2E && !retira && clienteId && estaPreparado(ped.raw) && !envioTerminal(existente?.estado_envio)) {
    const courier = deps.courierDePedido ? await deps.courierDePedido(ped.nombre).catch(() => null) : null;
    const recordatorio = armarRecordatorioEntrega(ped, clienteId, deps.ahora(), await plantillasActivas(deps), courier);
    await deps.programarEnvios([armarAvisoPreparado(ped, clienteId, courier, deps.ahora()), ...(recordatorio ? [recordatorio] : [])]);
    if (deps.dispararEnvios) await deps.dispararEnvios().catch((e) => console.warn("dispararEnvios:", e instanceof Error ? e.message : e));
  }

  // 12-10: pedido del bot de WhatsApp recién creado (ya confirmado) → oferta de pago con prioridad, una sola vez.
  const oferta = clienteId ? armarOfertaPrioridad(ped, clienteId, deps.ahora(), existente?.estado_envio) : null;
  if (oferta) {
    await deps.programarEnvios([oferta]);
    if (deps.dispararEnvios) await deps.dispararEnvios().catch((e) => console.warn("dispararEnvios:", e instanceof Error ? e.message : e));
  }

  const estadoFinal = fila.estado_confirmacion ?? existente?.estado_confirmacion ?? "pendiente";
  const frenar = ped.cancelado || estadoFinal !== "pendiente";

  if (frenar) {
    if (existente) await deps.cancelarEnviosPendientes(ped.shopifyOrderId, { incluirAvisos: ped.cancelado });
    return {
      shopifyOrderId: ped.shopifyOrderId,
      accion: "actualizado",
      telefono,
      estadoConfirmacion: estadoFinal,
      enviosProgramados: 0,
      enviosCancelados: !!existente,
    };
  }

  if (!telefono || !clienteId) {
    return {
      shopifyOrderId: ped.shopifyOrderId,
      accion: "sin_telefono",
      telefono: null,
      estadoConfirmacion: estadoFinal,
      enviosProgramados: 0,
      enviosCancelados: false,
    };
  }

  const cfg = await deps.leerConfigConfirmacion();
  const envios = armarEnvios(ped, clienteId, telefono, cfg, deps.ahora(), await plantillasActivas(deps));
  await deps.programarEnvios(envios); // on conflict do nothing → idempotente
  // Confirmación lo más rápido posible: no espera al cron. El pedido de prueba del despliegue (PRUEBA_E2E)
  // no dispara nada: esa prueba cancela sus envíos antes de que salgan.
  if (deps.dispararEnvios && !esPruebaE2E && (cfg.confirmar_min ?? 0) <= 0) {
    await deps.dispararEnvios().catch((e) => console.warn("dispararEnvios:", e instanceof Error ? e.message : e));
  }
  return {
    shopifyOrderId: ped.shopifyOrderId,
    accion: existente ? "actualizado" : "programado",
    telefono,
    estadoConfirmacion: estadoFinal,
    enviosProgramados: envios.length,
    enviosCancelados: false,
  };
}

// ---------------------------------------------------------------------------
// Manejo HTTP del webhook (sin I/O propio: todo por parámetros)
// ---------------------------------------------------------------------------

export interface DepsWebhook {
  secreto: string;
  guardarEventoCrudo(fuente: "shopify", idExterno: string, payload: unknown): Promise<boolean>;
  /** Se llama con EdgeRuntime.waitUntil en producción; en tests se espera directo. */
  enSegundoPlano(tarea: Promise<unknown>): void;
  procesar(topic: string, payload: Dict, idExterno: string): Promise<unknown>;
}

export async function manejarWebhook(req: Request, d: DepsWebhook): Promise<Response> {
  if (req.method !== "POST") return new Response("método no permitido", { status: 405 });
  const bytes = new Uint8Array(await req.arrayBuffer());
  const hmac = req.headers.get("x-shopify-hmac-sha256");
  if (!(await verificarHmacShopify(bytes, hmac, d.secreto))) {
    return new Response("firma inválida", { status: 401 });
  }
  const topic = req.headers.get("x-shopify-topic") ?? "";
  const webhookId = req.headers.get("x-shopify-webhook-id");
  if (!webhookId) return new Response("falta X-Shopify-Webhook-Id", { status: 400 });

  let payload: Dict;
  try {
    payload = JSON.parse(new TextDecoder().decode(bytes));
  } catch {
    return new Response("json inválido", { status: 400 });
  }

  const nuevo = await d.guardarEventoCrudo("shopify", webhookId, {
    topic,
    shop: req.headers.get("x-shopify-shop-domain"),
    event_id: req.headers.get("x-shopify-event-id"),
    body: payload,
  });
  if (!nuevo) return new Response("repetido", { status: 200 });

  if ((TOPICOS as readonly string[]).includes(topic)) {
    d.enSegundoPlano(d.procesar(topic, payload, webhookId));
  }
  return new Response("ok", { status: 200 });
}
