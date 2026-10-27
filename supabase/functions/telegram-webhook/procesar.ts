// telegram-webhook/procesar.ts · Dueño: D (Telegram)
// Lógica pura de los botones de decisión. Todo el I/O entra por `Dependencias`
// (index.ts las conecta a Supabase, Shopify, WhatsApp y Telegram; los tests,
// a dobles en memoria).
//
// Callbacks (contrato): cancelar:<shopify_order_id>, reponer:<id>, escribo:<id>,
// pagado:<id> (Enrique verificó en ueno el pago anticipado por transferencia → Shopify
// pagado + tag PAGO_VERIFICADO + aviso al cliente si la ventana de 24 h está abierta).
// 12-10 (botón "Recibido" del pago con prioridad): además tags PRIORIDAD y PAGADO (Shopify y Voltra OS), la venta
// queda como pago anticipado y, si el pedido ya estaba preparado o en camino, a Enrique le llega el texto para el
// courier con "YA PAGADO" (cobrar 0). El aviso del comprobante es una foto: se edita la leyenda, no el texto.
// Mejora mensual (M3): mej_aplicar:<ciclo>, mej_descartar:<ciclo>, mej_detalle:<ciclo>,
// mej_volver:<numero de versión> → lógica en ../mejora-mensual/aprobacion.ts.
// Idempotencia en dos capas:
//   1. update_id en eventos_crudos → un reintento de Telegram no se procesa dos veces.
//   2. "acción reclamada" (fuente telegram, id_externo = `accion:<data>`) →
//      tocar el mismo botón dos veces no hace dos cosas.
import {
  type AccionTelegram,
  type BotonTelegram,
  enlaceWaMe,
  textoConDecision,
} from "../_shared/telegram_formato.ts";
import type { ResultadoPago } from "../_shared/shopify_pagos.ts";
import { LIMITE_LEYENDA_TELEGRAM, LIMITE_TEXTO_TELEGRAM } from "../_shared/telegram_formato.ts";
import type { OpcionesAviso } from "../_shared/telegram_politica.ts";
import { avisoParaCourier, datosCourierDesdeRaw } from "../_shared/texto_courier.ts";
import { TAG_PAGADO, TAG_PRIORIDAD } from "../_shared/pago_anticipado.ts";
import { decidirMejora, type DepsDecision, type ResultadoDecision } from "../mejora-mensual/aprobacion.ts";

// AccionTelegram (en _shared) cubre los botones genéricos; "pagado" es propio de este webhook.
export type AccionCallback = AccionTelegram | "pagado";

/** Tag de Shopify: Enrique verificó el pago anticipado en ueno. */
export const TAG_PAGO_VERIFICADO = "PAGO_VERIFICADO";
/** 12-10: tags que deja "Recibido" (pago con prioridad). PAGO_VERIFICADO sigue por compatibilidad (factura, Despacho). */
export const TAGS_PAGO_RECIBIDO = [TAG_PAGO_VERIFICADO, TAG_PRIORIDAD, TAG_PAGADO];

/** Texto por defecto al cliente tras verificar el pago (se pisa con textos_decisiones.pagado en config_wa). */
export const TEXTO_PAGADO_DEFECTO =
  "Listo {nombre}, recibimos tu pago ✅ Tu pedido {pedido} sale primero y no pagás nada al recibir.";

// ─── Tipos mínimos de la Bot API que usamos ─────────────────
export interface TgBotonCrudo {
  text: string;
  callback_data?: string;
  url?: string;
}
export interface TgMensaje {
  message_id: number;
  date: number; // 0 si el mensaje ya no es accesible
  chat: { id: number };
  text?: string;
  /** 12-10: aviso con foto o documento (comprobante): el texto va en la leyenda. */
  caption?: string;
  photo?: unknown[];
  document?: unknown;
  reply_markup?: { inline_keyboard: TgBotonCrudo[][] };
}
export interface TgCallbackQuery {
  id: string;
  from: { id: number };
  message?: TgMensaje;
  data?: string;
}
export interface TgUpdate {
  update_id: number;
  callback_query?: TgCallbackQuery;
}

// ─── Lo que index.ts tiene que proveer ─────────────────────
export interface PedidoContexto {
  shopify_order_id: number;
  nombre: string | null; // '#1001'
  estado_confirmacion: string;
  estado_envio: string | null;
  tags?: string[] | null;
  cliente: {
    id: string;
    nombre: string | null;
    telefono: string | null;
    wa_user_id: string | null;
    wa_username: string | null;
  } | null;
  conversacion: { id: string; estado: string; ultima_entrada_en: string | null } | null;
  /** 12-10: pedido guardado (shopify_pedidos.raw), para el texto del courier. */
  raw?: Record<string, unknown> | null;
  /** 12-10: 'lucero' | 'pap' | … (shopify_pedidos.courier o la transportadora de la venta). */
  courier?: string | null;
  /** 12-10: teléfono del pedido (shopify_pedidos.telefono). */
  telefono?: string | null;
}

export type ClaveTextoCliente = "cancelado" | "reposicion" | "escribo" | "pagado";

export interface Dependencias {
  chatIdPermitido: string;
  ahora: () => Date;
  /** eventos_crudos (fuente 'telegram'); false si ya existía. */
  guardarEventoCrudo(idExterno: string, payload: unknown): Promise<boolean>;
  marcarEventoProcesado(idExterno: string, error?: string): Promise<void>;
  /** Inserta la fila-candado de la acción; false si ya estaba hecha. */
  reclamarAccion(clave: string, payload: Record<string, unknown>): Promise<boolean>;
  /** Borra el candado cuando la acción falló, para poder reintentar. */
  liberarAccion(clave: string): Promise<void>;
  obtenerPedido(shopifyOrderId: number): Promise<PedidoContexto | null>;
  cancelarEnShopify(shopifyOrderId: number): Promise<{ ok: boolean; error?: string }>;
  marcarPedidoCancelado(shopifyOrderId: number, clienteAvisado: boolean): Promise<void>;
  cancelarEnviosPendientes(shopifyOrderId: number): Promise<void>;
  pasarAHumano(conversacionId: string): Promise<void>;
  /** orderMarkAsPaid (idempotente: si ya estaba PAID devuelve ok + ya_pagado). */
  marcarPagadoEnShopify(shopifyOrderId: number): Promise<ResultadoPago>;
  agregarTagsShopify(shopifyOrderId: number, tags: string[]): Promise<{ ok: boolean; error?: string }>;
  /** Pisa shopify_pedidos.tags con la lista completa. */
  guardarTagsPedido(shopifyOrderId: number, tags: string[]): Promise<void>;
  /** Plantilla de texto libre desde config_wa; null si no está cargada. */
  textoCliente(clave: ClaveTextoCliente): Promise<string | null>;
  enviarTextoCliente(pedido: PedidoContexto, destino: string, texto: string): Promise<{ ok: boolean; error?: string }>;
  responderCallback(callbackQueryId: string, texto: string): Promise<void>;
  editarMensaje(chatId: number, messageId: number, textoHtml: string, botones: BotonTelegram[][]): Promise<void>;
  /** 12-10: edita la leyenda de un aviso con foto o documento (editMessageCaption). Sin esto se usa editarMensaje. */
  editarLeyenda?(chatId: number, messageId: number, textoHtml: string, botones: BotonTelegram[][]): Promise<void>;
  /** 12-10: mensaje nuevo a Enrique (HTML ya escapado): el texto para el courier. */
  /** 27-10: opts = tipo/destino (el texto para el courier va a Enrique). */
  avisar?(textoHtml: string, botones?: BotonTelegram[][], opts?: OpcionesAviso): Promise<unknown>;
  /** 12-10: la venta del pedido (VT-<n>) queda como pago anticipado; devuelve cuántas filas cambió. */
  marcarVentaPagada?(pedido: PedidoContexto): Promise<number>;
  /** Botones mej_* del ciclo mensual de mejora. Sin esto, se responden como desconocidos. */
  mejora?: DepsDecision;
}

export type Resultado =
  | { tipo: "ignorado"; motivo: string }
  | { tipo: "repetido" }
  | { tipo: "ya_hecho"; accion: AccionCallback; id: number }
  | { tipo: "hecho"; accion: AccionCallback; id: number; notas: string[] }
  | { tipo: "error"; accion: AccionCallback; id: number; error: string }
  | { tipo: "mejora"; data: string; resultado: ResultadoDecision["tipo"]; error?: string };

const VENTANA_MS = 24 * 60 * 60 * 1000;

export function parsearCallback(data: string | undefined): { accion: AccionCallback; id: number } | null {
  const m = /^(cancelar|reponer|escribo|pagado):(\d{1,19})$/.exec(data ?? "");
  if (!m) return null;
  const id = Number(m[2]);
  if (!Number.isSafeInteger(id) || id <= 0) return null;
  return { accion: m[1] as AccionCallback, id };
}

/** Ventana de 24 h de WhatsApp: abierta si el último entrante fue hace menos de 24 h. */
export function ventanaAbierta(ultimaEntrada: string | null | undefined, ahora: Date): boolean {
  if (!ultimaEntrada) return false;
  const t = Date.parse(ultimaEntrada);
  return Number.isFinite(t) && ahora.getTime() - t < VENTANA_MS && ahora.getTime() >= t - 60_000;
}

/** Reemplaza {nombre} y {pedido} en las plantillas de config_wa. */
export function rellenar(plantilla: string, p: PedidoContexto): string {
  const nombre = (p.cliente?.nombre ?? "").trim().split(/\s+/)[0] ?? "";
  return plantilla
    .replaceAll("{nombre}", nombre)
    .replaceAll("{pedido}", p.nombre ?? String(p.shopify_order_id))
    .replace(/[ \t]+([,.!?])/g, "$1")
    .trim();
}

/** Botones que quedan tras la decisión: siempre los enlaces; los callbacks según la acción. */
export function botonesTrasDecision(
  originales: TgBotonCrudo[][] | undefined,
  accion: AccionCallback,
  extra: BotonTelegram[] = [],
): BotonTelegram[][] {
  const filas: BotonTelegram[][] = [];
  for (const fila of originales ?? []) {
    const nueva: BotonTelegram[] = [];
    for (const b of fila) {
      if (b.url) {
        nueva.push({ texto: b.text, url: b.url });
        continue;
      }
      const p = parsearCallback(b.callback_data);
      if (!p) continue;
      if (accion === "cancelar") continue; // pedido cancelado: no queda nada por decidir
      if (p.accion === accion) continue; // la acción ya hecha
      if (accion === "reponer" && p.accion === "cancelar") continue; // reponer y cancelar se excluyen
      nueva.push({ texto: b.text, callback: b.callback_data });
    }
    if (nueva.length) filas.push(nueva);
  }
  const urls = new Set(filas.flat().map((b) => b.url).filter(Boolean));
  const extras = extra.filter((b) => !b.url || !urls.has(b.url));
  if (extras.length) filas.push(extras);
  return filas;
}

function enlaceOriginal(originales: TgBotonCrudo[][] | undefined): string | null {
  for (const b of (originales ?? []).flat()) if (b.url?.startsWith("https://wa.me/")) return b.url;
  return null;
}

const DECISION: Record<AccionCallback, string> = {
  cancelar: "pedido cancelado",
  reponer: "reponer el producto",
  escribo: "le escribo yo",
  pagado: "pago verificado",
};

const YA_HECHO: Record<AccionCallback, string> = {
  cancelar: "Ese pedido ya estaba cancelado.",
  reponer: "La reposición ya estaba registrada.",
  escribo: "Ese chat ya estaba en tus manos.",
  pagado: "Ese pago ya estaba verificado.",
};

/** 12-10: el paquete ya está preparado o con el courier (todavía sin entregar): hay que avisarle que no cobre. */
const ENVIO_EN_CAMINO = new Set(["EN_PREPARACION", "DESPACHADO", "INTENTO_FALLIDO", "NO_ENTREGADO_RESCATABLE"]);
const ENVIO_TERMINADO = new Set(["ENTREGADO", "RENDIDO", "NO_ENTREGADO", "CANCELADO"]);

/** Preparado en Shopify (fulfilled, REST o GraphQL) o ya con el courier. */
export function pedidoEnCamino(p: Pick<PedidoContexto, "raw" | "estado_envio">): boolean {
  const r = p.raw ?? {};
  const preparado = String(r.fulfillment_status ?? "").toLowerCase() === "fulfilled" ||
    String(r.displayFulfillmentStatus ?? "").toUpperCase() === "FULFILLED";
  const envio = String(p.estado_envio ?? "").toUpperCase();
  return !ENVIO_TERMINADO.has(envio) && (preparado || ENVIO_EN_CAMINO.has(envio));
}

/** Texto para el courier de un pedido que el cliente ya pagó (cobrar 0). */
export function avisoCourierPagado(p: PedidoContexto): string {
  const d = { ...datosCourierDesdeRaw(p.nombre ?? `#${p.shopify_order_id}`, p.raw ?? null, p.telefono ?? p.cliente?.telefono ?? null), pagado: true };
  return avisoParaCourier(d, "El cliente ya pagó por transferencia: entregar SIN COBRAR (Gs 0).", p.courier);
}

/** Texto por defecto cuando config_wa no trae la clave (solo las claves nuevas tienen). */
const TEXTO_DEFECTO: Partial<Record<ClaveTextoCliente, string>> = { pagado: TEXTO_PAGADO_DEFECTO };

/** Avisa al cliente con texto libre si la ventana está abierta; si no, deja la nota. */
async function avisarCliente(
  deps: Dependencias,
  pedido: PedidoContexto,
  clave: ClaveTextoCliente,
  notas: string[],
): Promise<boolean> {
  const destino = pedido.cliente?.telefono ?? pedido.cliente?.wa_user_id ?? null;
  if (!destino) {
    notas.push("No avisé al cliente: el pedido no tiene cliente de WhatsApp asociado. Avisale vos.");
    return false;
  }
  if (!ventanaAbierta(pedido.conversacion?.ultima_entrada_en, deps.ahora())) {
    notas.push("No avisé al cliente: la ventana de 24 h de WhatsApp está cerrada. Avisale vos desde tu número.");
    return false;
  }
  const plantilla = (await deps.textoCliente(clave)) ?? TEXTO_DEFECTO[clave] ?? null;
  if (!plantilla) {
    notas.push(`No avisé al cliente: falta el texto '${clave}' en config_wa (clave textos_decisiones).`);
    return false;
  }
  const r = await deps.enviarTextoCliente(pedido, destino, rellenar(plantilla, pedido));
  if (!r.ok) {
    notas.push(`No se pudo avisar al cliente por WhatsApp (${r.error ?? "error"}). Avisale vos.`);
    return false;
  }
  notas.push("Cliente avisado por WhatsApp.");
  return true;
}

/**
 * Paso 1 (sincrónico, antes de responder 200): filtra el chat y guarda el update
 * en eventos_crudos. Si la base falla, tira excepción → index.ts responde 500 y
 * Telegram reintenta.
 */
export async function recibirUpdate(
  update: TgUpdate,
  deps: Pick<Dependencias, "chatIdPermitido" | "guardarEventoCrudo">,
): Promise<{ tipo: "nuevo" } | { tipo: "ignorado"; motivo: string } | { tipo: "repetido" }> {
  const cq = update.callback_query;
  if (!cq) return { tipo: "ignorado", motivo: "no es un callback" };
  // Solo el chat de Enrique. Se mira el chat del mensaje (privado o grupo) y,
  // si el mensaje no viene, quién tocó el botón.
  const chatId = cq.message?.chat.id ?? cq.from.id;
  if (String(chatId) !== String(deps.chatIdPermitido)) {
    return { tipo: "ignorado", motivo: "chat no autorizado" };
  }
  if (!(await deps.guardarEventoCrudo(idEventoDe(update), update))) return { tipo: "repetido" };
  return { tipo: "nuevo" };
}

export function idEventoDe(update: TgUpdate): string {
  return `update:${update.update_id}`;
}

/** Recibe y procesa en un solo paso (lo usan los tests). */
export async function procesarUpdate(update: TgUpdate, deps: Dependencias): Promise<Resultado> {
  const r = await recibirUpdate(update, deps);
  if (r.tipo !== "nuevo") return r;
  return procesarCallback(update, deps);
}

/** Paso 2 (en segundo plano): ejecuta la decisión de un update ya guardado. */
export async function procesarCallback(update: TgUpdate, deps: Dependencias): Promise<Resultado> {
  const cq = update.callback_query;
  if (!cq) return { tipo: "ignorado", motivo: "no es un callback" };
  const idEvento = idEventoDe(update);

  if (deps.mejora && /^mej_[a-z]+:/.test(cq.data ?? "")) return procesarMejora(cq, idEvento, deps, deps.mejora);

  const cb = parsearCallback(cq.data);
  if (!cb) {
    await deps.responderCallback(cq.id, "Botón desconocido.");
    await deps.marcarEventoProcesado(idEvento, "callback desconocido");
    return { tipo: "ignorado", motivo: "callback desconocido" };
  }
  const { accion, id } = cb;
  const ahora = deps.ahora();
  const clave = `accion:${accion}:${id}`;

  const cerrar = async (r: Resultado, textoCallback: string, error?: string) => {
    await deps.responderCallback(cq.id, textoCallback);
    await deps.marcarEventoProcesado(idEvento, error);
    return r;
  };

  const reclamado = await deps.reclamarAccion(clave, {
    tipo: accion === "reponer" ? "reclamo_reposicion" : `decision_${accion}`,
    shopify_order_id: id,
    decidido_en: ahora.toISOString(),
    origen: "telegram",
    update_id: update.update_id,
  });
  if (!reclamado) return cerrar({ tipo: "ya_hecho", accion, id }, YA_HECHO[accion]);

  const fallar = async (error: string) => {
    await deps.liberarAccion(clave);
    return cerrar({ tipo: "error", accion, id, error }, `No se pudo: ${error}`, error);
  };

  let pedido: PedidoContexto | null;
  try {
    pedido = await deps.obtenerPedido(id);
  } catch (e) {
    return fallar(`error leyendo el pedido (${e instanceof Error ? e.message : e})`);
  }
  if (!pedido) return fallar("no encontré el pedido en Voltra OS");

  const notas: string[] = [];
  const extra: BotonTelegram[] = [];

  try {
    if (accion === "cancelar") {
      const yaCancelado = pedido.estado_envio === "CANCELADO" ||
        pedido.estado_confirmacion.startsWith("cancelado");
      if (yaCancelado) {
        notas.push("Ya figuraba cancelado en Voltra OS; no toqué Shopify.");
      } else {
        const r = await deps.cancelarEnShopify(id);
        if (!r.ok) return fallar(`Shopify no lo canceló (${r.error ?? "error"})`);
        notas.push("Cancelado en Shopify.");
        // Desde acá Shopify ya canceló: un error no libera el candado
        // (reintentar volvería a cancelar). Se anota y se sigue.
        const paso = async (nombre: string, f: () => Promise<unknown>) => {
          try {
            await f();
          } catch (e) {
            notas.push(`Falló "${nombre}" (${e instanceof Error ? e.message : e}); revisalo en Voltra OS.`);
          }
        };
        await paso("cancelar mensajes programados", () => deps.cancelarEnviosPendientes(id));
        let avisado = false;
        await paso("avisar al cliente", async () => {
          avisado = await avisarCliente(deps, pedido!, "cancelado", notas);
        });
        await paso("marcar cancelado", () => deps.marcarPedidoCancelado(id, avisado));
      }
    } else if (accion === "pagado") {
      // Si Shopify no lo marca pagado, no se agrega el tag (fallar libera el candado para reintentar).
      const r = await deps.marcarPagadoEnShopify(id);
      if (!r.ok) return fallar(`Shopify no lo marcó pagado (${r.error ?? "error"})`);
      notas.push(r.ya_pagado ? "Ya figuraba pagado en Shopify." : "Marcado como pagado en Shopify.");
      // Desde acá Shopify ya está pagado: un error no libera el candado; se anota y se sigue.
      // 12-10: PAGO_VERIFICADO + PRIORIDAD + PAGADO (Despacho lo pone primero y con cobro 0).
      const nombresTags = TAGS_PAGO_RECIBIDO.join(", ");
      try {
        const t = await deps.agregarTagsShopify(id, TAGS_PAGO_RECIBIDO);
        if (!t.ok) notas.push(`No se agregaron los tags ${nombresTags} en Shopify (${t.error ?? "error"}).`);
      } catch (e) {
        notas.push(`No se agregaron los tags ${nombresTags} en Shopify (${e instanceof Error ? e.message : e}).`);
      }
      try {
        const tags = [...(pedido.tags ?? []), ...TAGS_PAGO_RECIBIDO].filter((t, i, a) => a.indexOf(t) === i);
        await deps.guardarTagsPedido(id, tags);
      } catch (e) {
        notas.push(`Falló "guardar tags en Voltra OS" (${e instanceof Error ? e.message : e}); revisalo.`);
      }
      const envio = String(pedido.estado_envio ?? "").toUpperCase();
      if (deps.marcarVentaPagada && !ENVIO_TERMINADO.has(envio)) {
        try {
          const n = await deps.marcarVentaPagada(pedido);
          if (n > 0) notas.push("La venta quedó como pago anticipado (la rendición no espera cobro del courier).");
        } catch (e) {
          notas.push(`Falló "marcar la venta como pago anticipado" (${e instanceof Error ? e.message : e}); revisalo en Ventas.`);
        }
      }
      try {
        await avisarCliente(deps, pedido, "pagado", notas);
      } catch (e) {
        notas.push(`Falló "avisar al cliente" (${e instanceof Error ? e.message : e}); avisale vos.`);
      }
      // 12-10: ya preparado o en camino → el courier no tiene que cobrar: texto listo para reenviar.
      if (envio === "ENTREGADO" || envio === "RENDIDO") {
        notas.push("Ojo: el pedido ya figura ENTREGADO. Si además pagó al recibir, hay que devolverle la transferencia.");
      } else if (envio === "NO_ENTREGADO" || envio === "CANCELADO") {
        notas.push(`Ojo: el pedido figura ${envio}. Revisá si corresponde reenviarlo o devolver la transferencia.`);
      } else if (pedidoEnCamino(pedido)) {
        if (deps.avisar) {
          try {
            const t = await deps.avisar(avisoCourierPagado(pedido), undefined, {
              tipo: "pago_courier_no_cobrar", destino: "enrique", pedido: pedido.nombre ?? String(pedido.shopify_order_id),
            }) as { ok?: boolean; error?: string } | undefined;
            notas.push(t?.ok === false
              ? `No pude mandarte el texto para el courier (${t.error ?? "error"}): avisale que NO cobre.`
              : "Ya estaba preparado: te mandé el texto para el courier (YA PAGADO, cobrar 0).");
          } catch (e) {
            notas.push(`No pude mandarte el texto para el courier (${e instanceof Error ? e.message : e}): avisale que NO cobre.`);
          }
        } else notas.push("Ya estaba preparado: avisale al courier que NO cobre.");
      }
    } else if (accion === "reponer") {
      // El candado (eventos_crudos, tipo 'reclamo_reposicion') es el registro del reclamo:
      // no existe una tabla de reclamos en Voltra OS.
      notas.push("Reclamo registrado. Falta crear el pedido de reenvío en Shopify.");
      await avisarCliente(deps, pedido, "reposicion", notas);
    } else {
      if (pedido.conversacion) {
        await deps.pasarAHumano(pedido.conversacion.id);
        notas.push("La IA deja de responder este chat.");
      } else {
        notas.push("Este cliente no tiene conversación abierta en WhatsApp.");
      }
      let enlace = enlaceOriginal(cq.message?.reply_markup?.inline_keyboard);
      if (!enlace) {
        const saludo = await deps.textoCliente("escribo");
        enlace = enlaceWaMe(pedido.cliente?.telefono, saludo ? rellenar(saludo, pedido) : null);
      }
      if (enlace) extra.push({ texto: "Abrir chat con el cliente", url: enlace });
      else notas.push("El cliente no tiene teléfono: respondele desde la bandeja de Voltra OS.");
    }
  } catch (e) {
    return fallar(e instanceof Error ? e.message : String(e));
  }

  // Constancia en el mensaje de Telegram. 12-10: el aviso del comprobante es una foto o un documento (leyenda).
  if (cq.message && cq.message.date !== 0) {
    const botones = botonesTrasDecision(cq.message.reply_markup?.inline_keyboard, accion, extra);
    if (esMensajeConArchivo(cq.message) && deps.editarLeyenda) {
      const html = textoConDecision(cq.message.caption ?? "", DECISION[accion], notas, ahora, LIMITE_LEYENDA_TELEGRAM);
      await deps.editarLeyenda(cq.message.chat.id, cq.message.message_id, html, botones);
    } else {
      const html = textoConDecision(cq.message.text ?? cq.message.caption ?? "", DECISION[accion], notas, ahora, LIMITE_TEXTO_TELEGRAM);
      await deps.editarMensaje(cq.message.chat.id, cq.message.message_id, html, botones);
    }
  }
  const resumen = `Listo: ${DECISION[accion]}.`;
  return cerrar({ tipo: "hecho", accion, id, notas }, resumen);
}

/** Aviso con foto o documento (sin texto propio): se edita con editMessageCaption. */
export function esMensajeConArchivo(m: TgMensaje): boolean {
  return m.text === undefined && (m.caption !== undefined || Array.isArray(m.photo) || m.document !== undefined);
}

/** Botones del ciclo mensual de mejora (mej_*). La idempotencia la resuelve decidirMejora. */
async function procesarMejora(
  cq: TgCallbackQuery,
  idEvento: string,
  deps: Dependencias,
  mejora: DepsDecision,
): Promise<Resultado> {
  const data = cq.data ?? "";
  let r: ResultadoDecision;
  try {
    r = await decidirMejora(data, cq.message?.text ?? "", mejora);
  } catch (e) {
    const msg = e instanceof Error ? e.message : String(e);
    r = { tipo: "error", aviso: `No se pudo: ${msg}`, error: msg };
  }
  if (r.edicion && cq.message && cq.message.date !== 0) {
    await deps.editarMensaje(cq.message.chat.id, cq.message.message_id, r.edicion.html, r.edicion.botones);
  }
  await deps.responderCallback(cq.id, r.aviso);
  await deps.marcarEventoProcesado(idEvento, r.tipo === "error" ? r.error ?? "error" : undefined);
  return { tipo: "mejora", data, resultado: r.tipo, ...(r.error ? { error: r.error } : {}) };
}
