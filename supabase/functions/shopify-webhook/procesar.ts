// Lógica pura del webhook de Shopify y de la conciliación horaria.
// Todo el I/O (base de datos, reloj, normalizador de teléfono) entra por `Deps`,
// así los tests no tocan Supabase ni Shopify.

import { inicioDespacho, plazoPorCiudad } from "../_shared/plazo_zona.ts";
import { verificarHmacShopify } from "../_shared/shopify.ts";
import { envioTerminal } from "../procesar-envios/procesar.ts";

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
} as const;

/** Tags de Shopify que fijan estado_confirmacion (si alguien los pone a mano o desde otro módulo). */
const TAG_A_ESTADO: Array<[string, string]> = [
  ["CANCELADO_CLIENTE", "cancelado_cliente"],
  ["RETENIDO_SIN_RESPUESTA", "retenido"],
  ["A_CORREGIR", "a_corregir"],
  ["CONFIRMADO", "confirmado"],
];

export type ConfigConfirmacion = {
  confirmar_min?: number; // demora de la confirmación; si no está en config_wa sale al instante (07-10: Enrique la quiere lo más rápido posible)
  recordatorio_h: number;
  retener_h: number;
  cancelar_h: number;
};

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
  /** pasa a 'cancelado' los envíos 'pendiente' del pedido; los avisos de envío (courier:…) solo con `incluirAvisos`. */
  cancelarEnviosPendientes(id: number, opts?: { incluirAvisos?: boolean }): Promise<void>;
  /** Dispara procesar-envios ya, sin esperar al cron del minuto (opcional; si falla, el cron lo manda igual). */
  dispararEnvios?(): Promise<void>;
  /**
   * Pedido nuevo → evento temprano a Meta si el cliente vino de un anuncio de WhatsApp (lead_meta.ts).
   * Fire-and-forget: procesarPedido NO lo espera (io.ts lo deja vivo con EdgeRuntime.waitUntil). Opcional: solo
   * lo pasa shopify-webhook (la conciliación horaria no lo manda).
   */
  notificarPedidoMeta?(p: { shopifyOrderId: number; clienteId: string; total: number | null; creadoEn: string | null }): Promise<unknown>;
  /** Transportadora que se le asignó en Despacho (ventas.transportadora: 'lucero' | 'pap' | …), o null. Opcional (08-10). */
  courierDePedido?(nombrePedido: string | null): Promise<string | null>;
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
): FilaEnvio[] {
  const base = ahora.getTime();
  const min = 60_000, h = 3_600_000;
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
  };
  const fila = (tipo: keyof typeof PLANTILLAS, ms: number): FilaEnvio => ({
    cliente_id: clienteId,
    shopify_order_id: ped.shopifyOrderId,
    plantilla: PLANTILLAS[tipo],
    variables,
    categoria: "utilidad",
    enviar_desde: new Date(base + ms).toISOString(),
    clave_unica: `${tipo}:${ped.shopifyOrderId}`,
  });
  return [
    fila("conf", (cfg.confirmar_min ?? 0) * min),
    fila("rec", cfg.recordatorio_h * h),
    fila("ret", cfg.retener_h * h),
    fila("canc", cfg.cancelar_h * h),
  ];
}

/** El pedido figura como preparado (fulfilled) en Shopify: REST (webhook) o GraphQL (conciliación). */
export function estaPreparado(raw: unknown): boolean {
  const r = obj(raw);
  return s(r.fulfillment_status)?.toLowerCase() === "fulfilled" || s(r.displayFulfillmentStatus)?.toUpperCase() === "FULFILLED";
}

const NOMBRE_COURIER: Record<string, string> = { lucero: "Lucero del Este", pap: "Punto a Punto" };

export function armarAvisoPreparado(ped: PedidoNormalizado, clienteId: string, courier: string | null, ahora: Date): FilaEnvio {
  const c = courier?.toLowerCase() ?? "";
  const plazo = plazoPorCiudad(ped.ciudad) ?? (c === "lucero" ? "1 a 3 días hábiles" : "2 a 5 días hábiles");
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

/**
 * 09-10: un aviso más después del "ya salió", para bajar los "no estaba / no tenía la plata". Todas las ciudades,
 * contando desde el despacho (fin de semana → lunes 8:00):
 * - CDE y alrededores (hoy o mañana): "ya está por llegar" (voltra_entrega_proxima) 2 h después del despacho.
 * - Asunción y Central: "hoy te llega" (voltra_entrega_hoy) a las 8:00 de Asunción del día siguiente.
 * - Interior (no se sabe el día exacto): "ya está por llegar" a las 8:00 del segundo día.
 */
export function armarRecordatorioEntrega(ped: PedidoNormalizado, clienteId: string, ahoraReal: Date): FilaEnvio | null {
  const ahora = inicioDespacho(ahoraReal);
  const plazo = plazoPorCiudad(ped.ciudad);
  // 8:00 de Asunción (UTC−3) = 11:00 UTC, `dias` días después.
  const local = new Date(ahora.getTime() - 3 * 3_600_000);
  const alas8 = (dias: number) => new Date(Date.UTC(local.getUTCFullYear(), local.getUTCMonth(), local.getUTCDate() + dias, 11, 0, 0));
  const cde = plazo === "hoy mismo o en 24 h";
  const metro = plazo === "24 a 48 h" || plazo === "24 a 72 h";
  const enviar = cde ? new Date(ahora.getTime() + 2 * 3_600_000) : metro ? alas8(1) : alas8(2);
  return {
    cliente_id: clienteId,
    shopify_order_id: ped.shopifyOrderId,
    plantilla: metro ? "voltra_entrega_hoy" : "voltra_entrega_proxima",
    variables: { nombre: conMayuscula(ped.nombreCliente?.trim().split(/\s+/)[0] ?? null), total: formatoGs(ped.total) },
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
  if (!existente && !ped.cancelado && !esPruebaE2E && clienteId && deps.notificarPedidoMeta) {
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
  if (!ped.cancelado && !esPruebaE2E && clienteId && estaPreparado(ped.raw) && !envioTerminal(existente?.estado_envio)) {
    const courier = deps.courierDePedido ? await deps.courierDePedido(ped.nombre).catch(() => null) : null;
    const recordatorio = armarRecordatorioEntrega(ped, clienteId, deps.ahora());
    await deps.programarEnvios([armarAvisoPreparado(ped, clienteId, courier, deps.ahora()), ...(recordatorio ? [recordatorio] : [])]);
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
  const envios = armarEnvios(ped, clienteId, telefono, cfg, deps.ahora());
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
