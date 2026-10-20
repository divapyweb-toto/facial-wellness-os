// _shared/vendedor/pedidos_web.ts · Dueño: W2 (19-10, vendedor v35 paquete 1, ítems 3, 4 y 5-factura)
// Tres herramientas del vendedor sobre pedidos YA hechos (web/Releasit o del bot), sin depender del teléfono del chat:
//   - buscar_pedido: por número, por teléfono, por nombre (sin tildes, últimos 30 días) o "pedido web recién hecho"
//     (pendiente de la última hora y sin chat vinculado). Máximo 3 resultados, teléfono enmascarado.
//   - modificar_pedido: cambia cantidades o productos en dos pasos, igual que crear_pedido_cod: resumen con
//     Confirmo/Corregir (vend_mod:<id> / vend_modc:<id>, prefijos distintos para que el regex de Confirmo nunca
//     agarre Corregir) y, SOLO con Confirmo de ESE resumen o un sí claro escrito después de él (< 24 h), ejecuta: edición directa si el pedido lo creó Voltra OS; si es de Releasit (no editable), pedido nuevo
//     desde borrador (taxExempt, pago pendiente) + cancelación del original con reposición.
//   - guardar_factura: RUC + razón social en un pedido existente (atributo "factura", mezclando los que ya tiene).
// Lógica pura: todo el I/O entra por `DepsPedidosWeb` (pedidos_web_io.ts en producción, dobles en los tests).
// OJO (import circular): herramientas.ts va a importar este archivo. Acá NO se usa nada de herramientas.ts al cargar
// el módulo (solo dentro de funciones), así el orden de evaluación no rompe.
import type { Herramienta } from "../claude.ts";
import { validarRuc } from "../sifen/cdc.ts";
import { botonesSiNo } from "../wa_interactivos.ts";
import { escaparHtml } from "../telegram_formato.ts";
import {
  catalogo,
  type Ejecutor,
  esAceptacion,
  gs,
  itemsCatalogo,
  lineasShopify,
  mensajeSinStock,
  parsearFactura,
  precioPorCantidad,
  type ResultadoHerramienta,
} from "./herramientas.ts";
import type { CtxTurno, DepsHerramientas, LineaPedido, ProductoShopify } from "./tipos.ts";

// ---------- tipos y dependencias ----------

export type Atributo = { key: string; value: string };

export type DireccionPedido = {
  firstName: string | null;
  lastName: string | null;
  address1: string | null;
  address2: string | null;
  city: string | null;
  countryCode: string | null;
  phone: string | null;
};

export type LineaPedidoWeb = {
  /** gid del LineItem (para la edición directa). */
  line_item_id?: string | null;
  variante_id: string | null;
  handle: string | null;
  titulo: string;
  cantidad: number;
  /** Total de la línea ya con descuentos (lo que paga el cliente por esa línea). */
  total: number;
};

/** Pedido completo y fresco, leído de Shopify GraphQL (pedidoCompleto). */
export type PedidoWeb = {
  shopify_order_id: number;
  gid: string;
  /** "#1072" */
  nombre: string;
  creado_en: string;
  telefono: string | null;
  email?: string | null;
  cliente_id: string | null;
  customer_gid?: string | null;
  nombre_cliente: string | null;
  total: number;
  envio: number;
  cancelado: boolean;
  /** Preparado/despachado (fulfillment parcial o total) o con estado de courier: ya no se toca. */
  despachado: boolean;
  estado_confirmacion: string | null;
  /** Nombre de la app que lo creó (Order.app.name): "Voltra OS", "Releasit COD Form", "Online Store"… */
  app: string | null;
  merchant_editable: boolean | null;
  tags: string[];
  atributos: Atributo[];
  nota: string | null;
  direccion: DireccionPedido | null;
  lineas: LineaPedidoWeb[];
};

/** Fila liviana de shopify_pedidos para buscar (después se completa con pedidoCompleto). */
export type CandidatoPedido = {
  shopify_order_id: number;
  nombre: string;
  telefono: string | null;
  cliente_id: string | null;
  nombre_cliente: string | null;
  creado_en: string;
  estado_confirmacion: string | null;
  total: number | null;
  cancelado: boolean;
  /** customAttribute conversacion_id / chat_vinculado, si lo tiene. */
  conversacion_id: string | null;
};

export type EstadoModificacion = "resumen" | "ejecutando" | "hecho" | "parcial" | "fallido" | "corregido";
export type CaminoModificacion = "editar" | "reemplazar";

export type DatosModificacion = {
  pedido_nombre: string;
  camino: CaminoModificacion;
  lineas_antes: Array<{ titulo: string; cantidad: number; total: number }>;
  total_antes: number;
  lineas: LineaPedido[];
  envio: number;
  total: number;
};

export type ModificacionPedido = {
  id: string;
  conversacion_id: string;
  cliente_id: string | null;
  shopify_order_id: number;
  estado: EstadoModificacion;
  datos: DatosModificacion;
  nuevo_order_id: number | null;
  nuevo_nombre: string | null;
  error: string | null;
  creado_en: string;
  actualizado_en?: string;
};

export type FuenteVinculo = "busqueda" | "confirmado" | "modificacion" | "factura";

/** Unidad a agregar en la edición directa (de a 1 unidad: el descuento fijo queda sin ambigüedad). */
export type UnidadEdicion = { variante_id: string; precio: number; titulo: string };
export type PlanEdicion = { quitar: string[]; agregar: UnidadEdicion[] };

export type ResultadoOperacion = { ok: boolean; error?: string };
export type ResultadoEdicion = ResultadoOperacion & { total?: number | null; no_editable?: boolean };
export type ResultadoBorrador = ResultadoOperacion & { shopify_order_id?: number; nombre?: string; total?: number | null };

export interface DepsPedidosWeb {
  /** Candidatos de shopify_pedidos (sin borradores), del más nuevo al más viejo. */
  candidatos(f: { numero?: number; telefono?: string; desdeISO?: string; limite?: number }): Promise<CandidatoPedido[]>;
  /** Pedido completo y fresco desde Shopify (estado, app, líneas con handle). null si no existe. */
  pedidoCompleto(orderId: number): Promise<PedidoWeb | null>;
  /** Pedidos vinculados a esta conversación (buscados o confirmados), del más nuevo al más viejo. */
  vinculados(conversacionId: string): Promise<number[]>;
  /** De estos pedidos, cuáles ya tienen un chat vinculado (cualquier conversación). */
  pedidosConChat(orderIds: number[]): Promise<number[]>;
  /** Vínculo chat ↔ pedido (tabla wa_pedidos_vinculados; con fuente ≠ busqueda también el atributo en Shopify). */
  vincular(conversacionId: string, orderId: number, fuente: FuenteVinculo): Promise<void>;
  guardarModificacion(fila: Omit<ModificacionPedido, "id" | "creado_en"> & { id?: string }): Promise<ModificacionPedido>;
  modificacion(id: string): Promise<ModificacionPedido | null>;
  /** Último resumen de modificación de la conversación (cualquier estado). */
  ultimaModificacion(conversacionId: string): Promise<ModificacionPedido | null>;
  /** resumen → ejecutando, atómico (UPDATE … WHERE estado='resumen'). false si otro turno ya lo tomó. */
  tomarModificacion(id: string): Promise<boolean>;
  /** Edición directa (orderEditBegin → SetQuantity/AddVariant + descuento → Commit), solo si el total calculado da. */
  editarOrden(gid: string, plan: PlanEdicion, totalEsperado: number): Promise<ResultadoEdicion>;
  /** Pedido nuevo desde borrador: draftOrderCreate(input) → draftOrderComplete(paymentPending). */
  crearDesdeBorrador(input: Record<string, unknown>): Promise<ResultadoBorrador>;
  /** Reemplazo ya creado para este pedido (tag REEMPLAZA_A_#xxxx sin cancelar), para no duplicar. */
  reemplazoExistente(nombreOriginal: string): Promise<{ shopify_order_id: number; nombre: string } | null>;
  etiquetar(gid: string, tags: string[]): Promise<ResultadoOperacion>;
  /** orderCancel: restock, sin aviso al cliente, sin reembolso. */
  cancelarOrden(gid: string, nota: string): Promise<ResultadoOperacion>;
  /** Mezcla atributos (los que vienen pisan los de la misma clave; el resto queda). */
  actualizarAtributos(gid: string, nuevos: Atributo[]): Promise<ResultadoOperacion>;
  /**
   * CAPI (Meta no deduplica mensajería): copia los candados meta_lead:/meta_purchase: del pedido viejo al nuevo en
   * eventos_crudos, para que ni el webhook ni el cron manden otro LeadSubmitted/Purchase por la misma compra.
   * Devuelve qué candados copió. Opcional: sin esto el integrador tiene que filtrar REEMPLAZA_A_ en los emisores.
   */
  transferirCandadosMeta?(viejoId: number, nuevoId: number): Promise<string[]>;
  /**
   * 19-10: id del pedido buscado por número directo en Shopify, para cuando todavía no llegó a shopify_pedidos
   * (el webhook tarda 1-3 s; la prueba real dio "pedido_no_encontrado" en un pedido recién creado).
   */
  idPorNumero?(numero: number): Promise<number | null>;
}

/** El integrador suma `pedidosWeb?: DepsPedidosWeb` a DepsHerramientas; mientras tanto se lee así. */
type DepsConPedidosWeb = DepsHerramientas & { pedidosWeb?: DepsPedidosWeb };
const pw = (deps: DepsHerramientas): DepsPedidosWeb | undefined => (deps as DepsConPedidosWeb).pedidosWeb;

// ---------- utilidades puras ----------

const error = (mensaje: string, extra: Record<string, unknown> = {}): ResultadoHerramienta => ({
  resultado: { ok: false, error: mensaje, ...extra },
  esError: true,
});

export function normalizarTexto(s: string | null | undefined): string {
  return String(s ?? "").normalize("NFD").replace(/\p{M}/gu, "").toLowerCase().replace(/[^a-z0-9ñ\s]/g, " ").replace(/\s+/g, " ").trim();
}

/** Últimos 9 dígitos (0981… / +595981… / 595981… comparan igual). */
export function claveTelefono(t: string | null | undefined): string | null {
  const d = String(t ?? "").replace(/\D/g, "");
  return d.length >= 7 ? d.slice(-9) : null;
}

/** "+595981000123" → "termina en 123". Nunca el número entero (el modelo no lo repite). */
export function telefonoEnmascarado(t: string | null | undefined): string | null {
  const d = String(t ?? "").replace(/\D/g, "");
  return d.length >= 3 ? `termina en ${d.slice(-3)}` : null;
}

/** "Ana María Prueba" → "Ana P." (para preguntar "¿es tuyo?" sin exponer el nombre completo). */
export function nombreCorto(n: string | null | undefined): string | null {
  const p = String(n ?? "").trim().split(/\s+/).filter(Boolean);
  if (!p.length) return null;
  return p.length === 1 ? p[0] : `${p[0]} ${p[p.length - 1][0].toUpperCase()}.`;
}

/** "#1067", "1067", "pedido 1067" → 1067. */
export function numeroPedido(x: unknown): number | null {
  const m = /(\d{3,7})/.exec(String(x ?? ""));
  return m ? Number(m[1]) : null;
}

function levenshtein1(a: string, b: string): boolean {
  if (a === b) return true;
  if (Math.abs(a.length - b.length) > 1) return false;
  let i = 0, j = 0, dif = 0;
  while (i < a.length && j < b.length) {
    if (a[i] === b[j]) { i++; j++; continue; }
    if (++dif > 1) return false;
    if (a.length > b.length) i++;
    else if (b.length > a.length) j++;
    else { i++; j++; }
  }
  return dif + (a.length - i) + (b.length - j) <= 1;
}

/**
 * Coincidencia de nombre sin tildes ni mayúsculas: cada palabra buscada (≥ 2 letras) tiene que aparecer en el nombre
 * (igual, como prefijo de ≥ 3 letras, o con 1 letra de diferencia si tiene ≥ 4). Devuelve 0 si no coincide; más alto,
 * mejor (palabras exactas suman más).
 */
export function puntajeNombre(buscado: string, nombre: string | null | undefined): number {
  const q = normalizarTexto(buscado).split(" ").filter((w) => w.length >= 2);
  const n = normalizarTexto(nombre).split(" ").filter(Boolean);
  if (!q.length || !n.length) return 0;
  let puntos = 0;
  for (const w of q) {
    if (n.includes(w)) puntos += 3;
    else if (w.length >= 3 && n.some((x) => x.startsWith(w))) puntos += 2;
    else if (w.length >= 4 && n.some((x) => levenshtein1(w, x))) puntos += 1;
    else return 0;
  }
  return puntos;
}

export const ESTADOS_PENDIENTES = new Set(["pendiente", "sin_confirmar", "esperando", "enviado", "recordado", "", "null"]);

/** Pedido web recién hecho sin chat: pendiente de confirmar, sin cancelar, no lo creó el bot y nadie lo vinculó. */
export function esPendienteSinChat(c: CandidatoPedido, conChat: Set<number>): boolean {
  if (c.cancelado || c.conversacion_id || conChat.has(c.shopify_order_id)) return false;
  const e = normalizarTexto(c.estado_confirmacion ?? "");
  return ESTADOS_PENDIENTES.has(e) || e.startsWith("pend");
}

/** Mezcla atributos: los nuevos pisan los de la misma clave (sin mayúsculas/espacios), el resto queda en su orden. */
export function mezclarAtributos(previos: Atributo[], nuevos: Atributo[]): Atributo[] {
  const k = (s: string) => s.trim().toLowerCase();
  const claves = new Set(nuevos.map((a) => k(a.key)));
  return [...previos.filter((a) => !claves.has(k(a.key))), ...nuevos];
}

export const esNuestraApp = (app: string | null | undefined, nombreApp = "Voltra OS") =>
  normalizarTexto(app) === normalizarTexto(nombreApp);

/** Apps cuyos pedidos puede editar cualquier app con write_order_edits (no los creó una app de terceros). */
const APPS_EDITABLES = new Set(["online store", "tienda online", "draft orders", "borradores", "shopify", "point of sale", ""]);

/**
 * Edición directa solo si el pedido lo creó Voltra OS, o salió de la tienda/borrador y Shopify dice merchantEditable.
 * Releasit (y cualquier otra app de terceros): pedido nuevo desde borrador + cancelar el original.
 */
/**
 * 20-10: la edición directa deja en Shopify total_price ≠ current_total_price (pedidos de prueba #1080/#1083:
 * 237.000 contra 158.000) y Voltra OS/Despacho leen total_price → la planilla cobraría de más. Hasta leer el total
 * actual en todos lados, siempre se reemplaza (borrador → pedido nuevo con el total exacto, como el #1085).
 */
export const EDICION_DIRECTA_ACTIVA = false;

export function elegirCamino(p: Pick<PedidoWeb, "app" | "merchant_editable">, nombreApp = "Voltra OS"): CaminoModificacion {
  if (!EDICION_DIRECTA_ACTIVA) return "reemplazar";
  if (esNuestraApp(p.app, nombreApp)) return "editar";
  if (p.merchant_editable === true && APPS_EDITABLES.has(normalizarTexto(p.app))) return "editar";
  return "reemplazar";
}

export const TAG_REEMPLAZA = "REEMPLAZA_A_";
export const TAG_REEMPLAZADO = "REEMPLAZADO_POR_";
export const tagReemplaza = (nombreViejo: string) => `${TAG_REEMPLAZA}${nombreConNumeral(nombreViejo)}`;
export const tagReemplazado = (nombreNuevo: string) => `${TAG_REEMPLAZADO}${nombreConNumeral(nombreNuevo)}`;
const nombreConNumeral = (n: string) => (String(n).startsWith("#") ? String(n) : `#${n}`);

/** "#yyyy reemplaza a #xxxx" (primera línea del Telegram, pedido de Enrique). */
export const textoReemplazo = (nuevo: string, viejo: string) => `${nombreConNumeral(nuevo)} reemplaza a ${nombreConNumeral(viejo)}`;

/** ¿Por qué este pedido ya no se puede tocar? null = se puede. */
export function motivoNoModificable(p: PedidoWeb): string | null {
  const reemplazado = p.tags.find((t) => t.toUpperCase().startsWith(TAG_REEMPLAZADO));
  if (reemplazado) return `ya_reemplazado: este pedido ya fue reemplazado por ${reemplazado.slice(TAG_REEMPLAZADO.length)}. Trabajá sobre ese.`;
  if (p.cancelado) return "pedido_cancelado: ese pedido está cancelado. Si quiere el producto, armá un pedido nuevo con crear_pedido_cod.";
  if (p.despachado) {
    return "ya_despachado: el pedido ya salió y no se puede cambiar. Decíselo en la primera línea y ofrecé un pedido aparte con crear_pedido_cod para lo que quiere agregar.";
  }
  return null;
}

/** El pedido es de este chat: mismo cliente, mismo teléfono, el bot lo vinculó o buscar_pedido lo encontró acá. */
export function esDelChat(p: Pick<PedidoWeb, "shopify_order_id" | "cliente_id" | "telefono" | "atributos">, ctx: CtxTurno, vinculados: number[]): boolean {
  if (p.cliente_id && p.cliente_id === ctx.clienteId) return true;
  const a = claveTelefono(p.telefono), b = claveTelefono(ctx.telefono);
  if (a && b && a === b) return true;
  if (vinculados.includes(p.shopify_order_id)) return true;
  return p.atributos.some((x) => (x.key === "conversacion_id" || x.key === "chat_vinculado") && x.value === ctx.conversacionId);
}

const titulosLineas = (ls: Array<{ titulo: string; cantidad: number }>) => ls.map((l) => `${l.titulo} x${l.cantidad}`).join(", ");

/**
 * Líneas nuevas con los precios del catálogo (misma regla que crear_pedido_cod: oferta por cantidad o lista × cantidad)
 * + envío de config (0 si retira en la oficina). `items` es la lista COMPLETA de cómo queda el pedido.
 */
export function calcularModificacion(
  items: Array<{ handle: string; cantidad: number }>,
  p: PedidoWeb,
  productos: ProductoShopify[],
  ctx: CtxTurno,
): { ok: true; lineas: LineaPedido[]; envio: number; total: number } | { ok: false; error: string } {
  if (!items.length) return { ok: false, error: "faltan_items: mandá la lista COMPLETA de cómo queda el pedido (handle y cantidad de cada producto)." };
  const cat = itemsCatalogo(productos, ctx);
  const lineas: LineaPedido[] = [];
  const vistos = new Set<string>();
  for (const it of items) {
    const handle = String(it.handle ?? "");
    const cantidad = Number(it.cantidad);
    const prod = cat.find((x) => x.handle === handle) ??
      cat.find((x) => normalizarTexto(x.titulo).includes(normalizarTexto(handle)) && normalizarTexto(handle).length > 3);
    if (!prod) return { ok: false, error: `producto_desconocido:${handle}. Usá un handle de consultar_catalogo.` };
    if (vistos.has(prod.handle)) return { ok: false, error: `producto_repetido:${prod.handle}. Mandá cada producto una sola vez con la cantidad total.` };
    vistos.add(prod.handle);
    if (!Number.isInteger(cantidad) || cantidad < 1 || cantidad > ctx.cfg.vendedor.cantidad_max) {
      return { ok: false, error: `cantidad_invalida:${cantidad} (1 a ${ctx.cfg.vendedor.cantidad_max}; más es mayorista: derivá)` };
    }
    // Se mantiene la variante que ya tenía el pedido (color del JawFlex); si es un producto nuevo, la del catálogo.
    const previa = p.lineas.find((l) => l.handle === prod.handle && l.variante_id);
    const varianteId = previa?.variante_id ?? prod.variante_id;
    const cantidadAntes = p.lineas.filter((l) => l.handle === prod.handle).reduce((a, l) => a + l.cantidad, 0);
    const variante = productos.find((x) => x.handle === prod.handle)?.variantes.find((v) => v.id === varianteId);
    const disponible = variante ? variante.disponible : prod.disponible;
    if (cantidad > cantidadAntes && !disponible) return { ok: false, error: mensajeSinStock(prod, cat) };
    lineas.push({
      handle: prod.handle,
      titulo: prod.titulo,
      variante_id: varianteId,
      cantidad,
      total: precioPorCantidad(prod.precio, cantidad, ctx.cfg.ofertas[prod.handle]),
    });
  }
  const retiro = p.tags.some((t) => t.toUpperCase() === "RETIRO_EN_CASA");
  const envio = retiro ? 0 : ctx.cfg.envio.costo_gs;
  const total = lineas.reduce((a, l) => a + l.total, 0) + envio;
  const igual = lineas.length === p.lineas.length && lineas.every((l) => {
    const prev = p.lineas.find((x) => x.handle === l.handle);
    return prev && prev.cantidad === l.cantidad;
  });
  if (igual && total === p.total) return { ok: false, error: "sin_cambios: el pedido ya está así. No llames de nuevo; preguntale qué quiere cambiar." };
  return { ok: true, lineas, envio, total };
}

/** Texto del resumen del cambio (lo arma el sistema; el modelo no escribe montos). */
export function textoResumenModificacion(p: PedidoWeb, d: DatosModificacion): string {
  const gratis = d.envio > 0 && d.lineas.length === 1 && d.lineas[0].cantidad >= 2;
  const ahora = gratis
    ? `${d.lineas[0].titulo} x${d.lineas[0].cantidad}, envío gratis`
    : `${d.lineas.map((l) => `${l.titulo} x${l.cantidad} (Gs ${gs(l.total)})`).join(", ")}${d.envio > 0 ? `. Envío Gs ${gs(d.envio)}` : ""}`;
  const partes = [
    `Te resumo el cambio de tu pedido ${p.nombre}:`,
    `Antes: ${titulosLineas(d.lineas_antes)} · Gs ${gs(d.total_antes)}`,
    `Ahora: ${ahora} · Total Gs ${gs(d.total)}, pagás al recibir.`,
  ];
  if (d.camino === "reemplazar") partes.push("🔁 Queda con un número de pedido nuevo: es el mismo envío a la misma dirección.");
  partes.push("¿Confirmás el cambio?");
  return partes.join("\n");
}

/** Plan de edición directa: se quitan las líneas que cambian y se agregan de a 1 unidad con su precio exacto. */
export function planEdicion(p: PedidoWeb, lineas: LineaPedido[]): { ok: true; plan: PlanEdicion } | { ok: false; error: string } {
  const quitar: string[] = [];
  const agregar: UnidadEdicion[] = [];
  const quedan = new Set<string>();
  for (const l of lineas) {
    const prev = p.lineas.filter((x) => x.handle === l.handle);
    // Sin cambios (misma variante, cantidad y total): la línea queda como está.
    if (prev.length === 1 && prev[0].variante_id === l.variante_id && prev[0].cantidad === l.cantidad && prev[0].total === l.total) {
      quedan.add(prev[0].line_item_id ?? "");
      continue;
    }
    for (const u of lineasShopify([l])) {
      const precio = Number(((u.priceSet as { shopMoney: { amount: string } }).shopMoney).amount);
      for (let i = 0; i < Number(u.quantity); i++) agregar.push({ variante_id: l.variante_id, precio, titulo: l.titulo });
    }
  }
  for (const x of p.lineas) {
    if (x.cantidad <= 0) continue;
    if (!x.line_item_id) return { ok: false, error: "linea_sin_id" };
    if (!quedan.has(x.line_item_id)) quitar.push(x.line_item_id);
  }
  return { ok: true, plan: { quitar, agregar } };
}

/**
 * Etiquetas que NO pasan al pedido nuevo: las de reemplazo, las de estado que le ganan a CONFIRMADO en
 * shopify-webhook (estadoDesdeTags: CANCELADO_CLIENTE > RETENIDO_SIN_RESPUESTA > A_CORREGIR > CONFIRMADO), cualquier
 * "cancelado" (Despacho lo toma como cancelado) y META_ENTREGA_ENVIADA (frenaría el evento de entrega del pedido
 * nuevo). CONFIRMADO se agrega una sola vez. PRUEBA / PRUEBA_E2E SÍ pasan (los pedidos de prueba siguen siéndolo).
 */
export function tagNoSeCopia(t: string): boolean {
  const u = t.trim().toUpperCase();
  return u.startsWith(TAG_REEMPLAZA) || u.startsWith(TAG_REEMPLAZADO) || u.includes("CANCELADO") ||
    ["A_CORREGIR", "RETENIDO_SIN_RESPUESTA", "CONFIRMADO", "META_ENTREGA_ENVIADA", "CAMBIO_A_2_UNIDADES"].includes(u);
}

/** Atributos que NO se copian al pedido nuevo (los pone de nuevo el reemplazo o son del pedido viejo). */
const ATRIBUTOS_NO_COPIAR = new Set(["reemplaza_a", "modificacion_id"]);

/**
 * Input de draftOrderCreate para reemplazar un pedido de Releasit: mismas dirección, teléfono, nota, etiquetas y
 * atributos; precios fijos por línea (priceOverride) y taxExempt (los precios de Voltra ya incluyen IVA: sin esto
 * Shopify suma 10% encima). Etiquetas: CONFIRMADO (no se le vuelve a pedir confirmación) + REEMPLAZA_A_#xxxx.
 */
export function inputBorradorReemplazo(p: PedidoWeb, d: DatosModificacion, modificacionId: string): Record<string, unknown> {
  const money = (n: number) => ({ amount: String(Math.round(n)), currencyCode: "PYG" });
  const lineItems = lineasShopify(d.lineas).map((l) => ({
    variantId: l.variantId,
    quantity: l.quantity,
    priceOverride: money(Number(((l.priceSet as { shopMoney: { amount: string } }).shopMoney).amount)),
  }));
  const tags = [...new Set([...p.tags.filter((t) => !tagNoSeCopia(t)), "CONFIRMADO", tagReemplaza(p.nombre)])];
  const atributos = mezclarAtributos(
    p.atributos.filter((a) => !ATRIBUTOS_NO_COPIAR.has(a.key.trim().toLowerCase())),
    [{ key: "reemplaza_a", value: nombreConNumeral(p.nombre) }, { key: "modificacion_id", value: modificacionId }],
  );
  const nota = [
    p.nota?.trim() || null,
    `Reemplaza al pedido ${nombreConNumeral(p.nombre)}: el cliente cambió el pedido por WhatsApp (${titulosLineas(d.lineas)}). Ya confirmado.`,
  ].filter(Boolean).join("\n");
  const input: Record<string, unknown> = {
    lineItems,
    taxExempt: true,
    note: nota,
    tags,
    customAttributes: atributos,
    ...(d.envio > 0 ? { shippingLine: { title: "Envío", priceWithCurrency: money(d.envio) } } : {}),
    ...(p.telefono ? { phone: p.telefono } : {}),
    ...(p.email ? { email: p.email } : {}),
    ...(p.customer_gid ? { purchasingEntity: { customerId: p.customer_gid } } : {}),
  };
  if (p.direccion) {
    const a = p.direccion;
    input.shippingAddress = {
      firstName: a.firstName ?? "",
      // 15-10 (#1055): con el apellido vacío Shopify descarta la dirección entera.
      lastName: a.lastName || "-",
      address1: a.address1 ?? "",
      address2: a.address2 ?? null,
      city: a.city ?? "",
      countryCode: a.countryCode || "PY",
      phone: a.phone ?? p.telefono ?? null,
    };
  }
  return { input };
}

/** Telegram a Enrique. Primera línea fija: "#yyyy reemplaza a #xxxx" o "#xxxx modificado". */
export function textoTelegramModificacion(o: {
  camino: CaminoModificacion;
  viejo: string;
  nuevo?: string | null;
  cliente: string;
  d: DatosModificacion;
  avisos?: string[];
}): string {
  const titulo = o.camino === "reemplazar" && o.nuevo ? `🔁 <b>${escaparHtml(textoReemplazo(o.nuevo, o.viejo))}</b>` : `✏️ <b>${escaparHtml(o.viejo)} modificado</b>`;
  const lineas = [
    titulo,
    `Cliente: ${escaparHtml(o.cliente)}`,
    `Antes: ${escaparHtml(titulosLineas(o.d.lineas_antes))} · Gs ${gs(o.d.total_antes)}`,
    `Ahora: ${escaparHtml(titulosLineas(o.d.lineas))} · Gs ${gs(o.d.total)}`,
  ];
  if (o.camino === "reemplazar" && o.nuevo) lineas.push(`${escaparHtml(o.viejo)} cancelado con reposición de stock. Despachá solo ${escaparHtml(o.nuevo)}.`);
  for (const a of o.avisos ?? []) lineas.push(`• ${escaparHtml(a)}`);
  return lineas.join("\n");
}

// ---------- resolución del pedido ----------

/** Pedido de trabajo: el que nombra el modelo, o el último del chat (bot creado → vinculado → de la tienda). */
async function resolverPedido(
  ref: unknown,
  ctx: CtxTurno,
  deps: DepsHerramientas,
  p: DepsPedidosWeb,
): Promise<{ ok: true; pedido: PedidoWeb; vinculados: number[] } | { ok: false; r: ResultadoHerramienta }> {
  const vinculados = await p.vinculados(ctx.conversacionId).catch(() => [] as number[]);
  let orderId: number | null = null;
  const numero = numeroPedido(ref);
  if (numero !== null) {
    // Un número largo (> 7 cifras) es un shopify_order_id; uno corto, el número visible (#1072).
    const largo = /\d{8,}/.exec(String(ref ?? ""));
    if (largo) orderId = Number(largo[0]);
    else {
      const c = await p.candidatos({ numero, limite: 1 }).catch(() => [] as CandidatoPedido[]);
      orderId = c[0]?.shopify_order_id ?? (p.idPorNumero ? await p.idPorNumero(numero).catch(() => null) : null);
    }
    if (!orderId) return { ok: false, r: error(`pedido_no_encontrado:${String(ref)}. Pedile "el número de pedido o el teléfono que pusiste" y usá buscar_pedido.`) };
  } else {
    const chat = await deps.ultimoPedidoChat(ctx.conversacionId).catch(() => null);
    const tienda = deps.pedidoTiendaAbierto ? await deps.pedidoTiendaAbierto(ctx.clienteId).catch(() => null) : null;
    const opciones: Array<{ id: number; fecha: string }> = [];
    if (chat?.estado === "creado" && chat.shopify_order_id) opciones.push({ id: chat.shopify_order_id, fecha: chat.creado_en });
    if (tienda) opciones.push({ id: tienda.shopify_order_id, fecha: tienda.creado_en });
    opciones.sort((a, b) => Date.parse(b.fecha) - Date.parse(a.fecha));
    orderId = opciones[0]?.id ?? vinculados[0] ?? null;
    if (!orderId) return { ok: false, r: error("sin_pedido: no encontré un pedido de este chat. Usá buscar_pedido (número, teléfono que puso o nombre).") };
  }
  const pedido = await p.pedidoCompleto(orderId).catch(() => null);
  if (!pedido) return { ok: false, r: error(`pedido_no_encontrado:${orderId}. Pedile "el número de pedido o el teléfono que pusiste" y usá buscar_pedido.`) };
  if (!esDelChat(pedido, ctx, vinculados)) {
    return { ok: false, r: error("pedido_de_otro_cliente: ese pedido no es de este chat. Buscalo con buscar_pedido y que el cliente confirme que es suyo antes de tocarlo.") };
  }
  return { ok: true, pedido, vinculados };
}

// ---------- 1. buscar_pedido ----------

function defBuscarPedido(): Herramienta {
  return {
    name: "buscar_pedido",
    description:
      "Busca un pedido ya hecho (web o del bot) aunque el cliente escriba desde otro número: por número de pedido, por el teléfono que puso, por nombre (últimos 30 días) o recien_hecho=true (\"acabo de hacer un pedido\": pedidos web pendientes de la última hora sin chat). Devuelve hasta 3. Preguntale al cliente si es el suyo (\"¿Es el #1067 de Ejercitador x1 a nombre de Ana P.?\") antes de cambiarlo. Nunca le digas el teléfono.",
    input_schema: {
      type: "object",
      properties: {
        numero: { type: "string", description: "Número de pedido (\"#1067\" o \"1067\")." },
        telefono: { type: "string", description: "Teléfono que el cliente dice que puso en el pedido." },
        nombre: { type: "string", description: "Nombre y/o apellido con el que hizo el pedido." },
        recien_hecho: { type: "boolean", description: "true si dice que acaba de hacer un pedido en la web." },
      },
    },
  };
}
export const definicionBuscarPedido: Herramienta = defBuscarPedido();

const ventanaNombreDias = 30;
const ventanaRecienMin = 60;

async function buscarPedido(input: Record<string, unknown>, ctx: CtxTurno, deps: DepsHerramientas): Promise<ResultadoHerramienta> {
  const p = pw(deps);
  if (!p) return error("no_disponible: pedile el número de pedido y avisá a Enrique con derivar_a_enrique motivo falla_herramienta.");
  const s = (k: string) => (typeof input[k] === "string" ? (input[k] as string).trim() : "");
  const numero = numeroPedido(s("numero"));
  const tel = s("telefono") ? (deps.normalizarTelefono(s("telefono")) ?? s("telefono")) : "";
  const nombre = s("nombre");
  const recien = input.recien_hecho === true || (!numero && !tel && !nombre);
  const ahora = ctx.ahora.getTime();
  let encontrados: CandidatoPedido[] = [];
  let criterio = "";
  try {
    if (numero) {
      criterio = "numero";
      encontrados = await p.candidatos({ numero, limite: 3 });
    } else if (tel) {
      criterio = "telefono";
      const clave = claveTelefono(tel);
      encontrados = (await p.candidatos({ telefono: tel, desdeISO: new Date(ahora - 60 * 86_400_000).toISOString(), limite: 10 }))
        .filter((c) => !clave || claveTelefono(c.telefono) === clave);
    } else if (nombre) {
      criterio = "nombre";
      const lista = await p.candidatos({ desdeISO: new Date(ahora - ventanaNombreDias * 86_400_000).toISOString(), limite: 600 });
      encontrados = lista.map((c) => ({ c, puntos: puntajeNombre(nombre, c.nombre_cliente) }))
        .filter((x) => x.puntos > 0)
        .sort((a, b) => b.puntos - a.puntos || Date.parse(b.c.creado_en) - Date.parse(a.c.creado_en))
        .map((x) => x.c);
    }
    if (recien && !encontrados.length) {
      criterio = criterio || "recien_hecho";
      const lista = await p.candidatos({ desdeISO: new Date(ahora - ventanaRecienMin * 60_000).toISOString(), limite: 30 });
      const conChat = new Set(await p.pedidosConChat(lista.map((c) => c.shopify_order_id)).catch(() => [] as number[]));
      encontrados = lista.filter((c) => esPendienteSinChat(c, conChat));
    }
  } catch (e) {
    return error(`busqueda_fallida: ${e instanceof Error ? e.message : e}. Pedile el número de pedido y probá de nuevo.`);
  }
  const top = encontrados.slice(0, 3);
  if (!top.length) {
    return {
      resultado: {
        ok: true,
        pedidos: [],
        criterio,
        nota: "No lo encontré. Pedile en una línea \"el número de pedido o el teléfono que pusiste\" y volvé a buscar con eso. No digas que no existe.",
      },
    };
  }
  const completos = await Promise.all(top.map((c) => p.pedidoCompleto(c.shopify_order_id).catch(() => null)));
  const pedidos = top.map((c, i) => {
    const x = completos[i];
    return {
      pedido: x?.nombre ?? c.nombre,
      shopify_order_id: c.shopify_order_id,
      productos: x ? titulosLineas(x.lineas) : null,
      total: x?.total ?? c.total,
      total_texto: gs(Number(x?.total ?? c.total ?? 0)),
      estado: x?.cancelado || c.cancelado ? "cancelado" : (x?.estado_confirmacion ?? c.estado_confirmacion ?? "sin dato"),
      creado_en: x?.creado_en ?? c.creado_en,
      despachado: x?.despachado ?? null,
      origen: x ? (esNuestraApp(x.app) ? "bot (Voltra OS)" : x.app ? `web (${x.app})` : "web") : "sin dato",
      a_nombre_de: nombreCorto(x?.nombre_cliente ?? c.nombre_cliente),
      telefono: telefonoEnmascarado(x?.telefono ?? c.telefono),
    };
  });
  // Quedan como "encontrados en este chat" (habilita modificar_pedido / guardar_factura): por número o teléfono
  // siempre; por nombre o recién hecho solo si hay uno (con varios, que el cliente diga el número y se busca por ahí).
  const fuerte = criterio === "numero" || criterio === "telefono" || top.length === 1;
  if (fuerte) for (const c of top) await p.vincular(ctx.conversacionId, c.shopify_order_id, "busqueda").catch(() => {});
  return {
    resultado: {
      ok: true,
      criterio,
      pedidos,
      nota: fuerte
        ? "Preguntale si es el suyo con número, productos y nombre (sin el teléfono). Si dice que sí, ya podés usar modificar_pedido o guardar_factura con ese pedido."
        : "Hay varios: preguntale cuál es (el número de pedido) y buscá de nuevo con numero antes de cambiar nada.",
    },
  };
}

// ---------- 2. modificar_pedido ----------

function defModificarPedido(): Herramienta {
  return {
    name: "modificar_pedido",
    description:
      "Cambia un pedido YA HECHO que no salió: cantidades, cambiar un producto por otro o agregar uno. confirmar=false: valida, calcula el total nuevo con los precios del catálogo y le muestra al cliente el resumen del cambio con botones Confirmo/Corregir (no escribas nada después). confirmar=true: SOLO después del botón Confirmo de ese resumen o de un sí claro escrito después de él; ejecuta el cambio y devuelve el texto para responder. Nunca digas que lo cambiaste sin el ok=true de confirmar=true.",
    input_schema: {
      type: "object",
      properties: {
        confirmar: { type: "boolean" },
        pedido: { type: "string", description: "Número del pedido (\"#1072\"). Si no lo mandás, se usa el último pedido de este chat." },
        items: {
          type: "array",
          description: "Lista COMPLETA de cómo queda el pedido (no solo lo que cambia). Ej. de 1 a 2: [{handle, cantidad: 2}].",
          items: {
            type: "object",
            properties: { handle: { type: "string" }, cantidad: { type: "integer", minimum: 1 } },
            required: ["handle", "cantidad"],
          },
        },
      },
      required: ["confirmar"],
    },
  };
}
export const definicionModificarPedido: Herramienta = defModificarPedido();

const VENCE_MS = 24 * 3600_000;
const escRe = (x: string) => x.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
/** Toque de Confirmo de ESE resumen: "[botón] Confirmo (vend_mod:<id>)". */
export const reConfirmo = (id: string) => new RegExp(`\\(vend_mod:${escRe(id)}\\)`);
const reCorregir = /\(vend_modc:[^)\s]+\)/;
const reBotonCualquiera = /\(vend_[a-z_]+:[^)\s]+\)/;

/**
 * Último renglón escrito por el cliente (el webhook antepone marcas "[pedido #… de la tienda…]" o "[anuncio…]").
 * Los toques de botón ("[botón] …") se tratan aparte.
 */
export function textoPropio(t: string): string {
  const ls = String(t ?? "").split("\n").map((x) => x.trim()).filter(Boolean);
  return ls.filter((x) => !/^\[/.test(x)).pop() ?? "";
}

/**
 * ¿El cliente confirmó ESTE resumen? Sí con el botón Confirmo de ese id, o con un sí claro escrito (misma regla que
 * crear_pedido_cod: esAceptacion) en el mensaje actual o en un mensaje desde el resumen, siempre que después no haya
 * tocado Corregir. Otro botón (de otro resumen o de otra cosa) no cuenta como sí.
 */
export function confirmoResumen(id: string, actual: string, desde: string[], aceptaciones: string[]): boolean {
  const ok = (t: string) => reConfirmo(id).test(t) || (!reBotonCualquiera.test(t) && esAceptacion(textoPropio(t), aceptaciones));
  if (reCorregir.test(actual)) return false;
  if (ok(actual)) return true;
  const iCorr = desde.findLastIndex((t) => reCorregir.test(t));
  return desde.slice(iCorr + 1).some(ok);
}

async function modificarPedido(input: Record<string, unknown>, ctx: CtxTurno, deps: DepsHerramientas): Promise<ResultadoHerramienta> {
  const p = pw(deps);
  if (!p) return error("no_disponible: no puedo cambiar pedidos ahora. Decíselo y derivá a Enrique con motivo falla_herramienta.");
  return input.confirmar === true ? await ejecutarModificacion(ctx, deps, p) : await resumenModificacion(input, ctx, deps, p);
}

async function resumenModificacion(input: Record<string, unknown>, ctx: CtxTurno, deps: DepsHerramientas, p: DepsPedidosWeb): Promise<ResultadoHerramienta> {
  const r = await resolverPedido(input.pedido, ctx, deps, p);
  if (!r.ok) return r.r;
  const pedido = r.pedido;
  const motivo = motivoNoModificable(pedido);
  if (motivo) return error(motivo);
  let productos: ProductoShopify[];
  try {
    productos = await catalogo(deps, ctx);
  } catch (e) {
    return error(`catalogo_no_disponible: ${e instanceof Error ? e.message : e}. Derivá a Enrique.`);
  }
  const items = Array.isArray(input.items) ? (input.items as Array<Record<string, unknown>>).map((i) => ({ handle: String(i.handle ?? ""), cantidad: Number(i.cantidad) })) : [];
  const c = calcularModificacion(items, pedido, productos, ctx);
  if (!c.ok) return error(c.error);
  const datos: DatosModificacion = {
    pedido_nombre: pedido.nombre,
    camino: elegirCamino(pedido),
    lineas_antes: pedido.lineas.map((l) => ({ titulo: l.titulo, cantidad: l.cantidad, total: l.total })),
    total_antes: pedido.total,
    lineas: c.lineas,
    envio: c.envio,
    total: c.total,
  };
  const fila = await p.guardarModificacion({
    conversacion_id: ctx.conversacionId,
    cliente_id: ctx.clienteId,
    shopify_order_id: pedido.shopify_order_id,
    estado: "resumen",
    datos,
    nuevo_order_id: null,
    nuevo_nombre: null,
    error: null,
  });
  const env = await deps.enviarInteractivo(
    ctx.destino,
    botonesSiNo(textoResumenModificacion(pedido, datos), `vend_mod:${fila.id}`, `vend_modc:${fila.id}`, { si: "Confirmo", no: "Corregir" }),
    { clienteId: ctx.clienteId, conversacionId: ctx.conversacionId },
  );
  if (!env.ok) return error(`no_se_pudo_mostrar_el_resumen: ${env.error}. Derivá a Enrique con motivo falla_herramienta.`);
  return {
    resultado: {
      ok: true,
      resumen_enviado: true,
      pedido: pedido.nombre,
      total_antes: pedido.total,
      total: c.total,
      total_texto: gs(c.total),
      cambia_numero: datos.camino === "reemplazar",
      modificacion_id: fila.id,
      nota: "Ya se le mandó el resumen con Confirmo/Corregir. No escribas nada más. El cambio NO está hecho hasta que toque Confirmo y llames confirmar=true.",
    },
    terminal: true,
  };
}

async function ejecutarModificacion(ctx: CtxTurno, deps: DepsHerramientas, p: DepsPedidosWeb): Promise<ResultadoHerramienta> {
  const mod = await p.ultimaModificacion(ctx.conversacionId);
  if (!mod) return error("no_hay_resumen: primero llamá modificar_pedido con confirmar=false.");
  if (mod.estado === "hecho") {
    return {
      resultado: {
        ok: true,
        ya_hecho: true,
        pedido: mod.nuevo_nombre ?? mod.datos.pedido_nombre,
        total: mod.datos.total,
        texto_respuesta: `Ese cambio ya quedó hecho: tu pedido es el ${mod.nuevo_nombre ?? mod.datos.pedido_nombre}, total Gs ${gs(mod.datos.total)}.`,
      },
    };
  }
  if (mod.estado === "ejecutando") return error("en_proceso: el cambio se está haciendo. No llames de nuevo; decile que en un momento queda.");
  if (mod.estado !== "resumen") return error(`resumen_en_estado_${mod.estado}: si todavía quiere el cambio, armá un resumen nuevo con confirmar=false.`);
  if (ctx.ahora.getTime() - Date.parse(mod.creado_en) > VENCE_MS) return error("resumen_vencido: mostrá el resumen del cambio de nuevo con confirmar=false.");
  // Confirmo de ESTE resumen, o un sí claro escrito DESPUÉS de él (#1072: el "sí" anterior al resumen no vale).
  const desde = deps.entradasDesde ? await deps.entradasDesde(ctx.conversacionId, mod.creado_en).catch(() => [] as string[]) : [];
  if (!confirmoResumen(mod.id, ctx.textoEntrada, desde, ctx.cfg.aceptaciones)) {
    return error("falta_confirmo: el cliente no tocó Confirmo ni dijo un sí claro después del resumen del cambio. No digas que está cambiado: preguntale si confirma (o armá el resumen de nuevo con confirmar=false).");
  }
  if (!(await p.tomarModificacion(mod.id))) {
    const ya = await p.modificacion(mod.id).catch(() => null);
    if (ya?.estado === "hecho") {
      return { resultado: { ok: true, ya_hecho: true, pedido: ya.nuevo_nombre ?? ya.datos.pedido_nombre, total: ya.datos.total, texto_respuesta: `Ya quedó hecho: tu pedido es el ${ya.nuevo_nombre ?? ya.datos.pedido_nombre}.` } };
    }
    return error("en_proceso: el cambio ya se está haciendo. No llames de nuevo.");
  }
  const d = mod.datos;
  const guardar = (extra: Partial<ModificacionPedido>) => p.guardarModificacion({ ...mod, ...extra }).catch((e) => {
    console.error(`modificar_pedido: no se guardó el estado de ${mod.id}:`, e instanceof Error ? e.message : e);
    return mod;
  });
  const cliente = `${ctx.nombreCliente ?? "Cliente"} · ${ctx.telefono ?? ctx.destino}`;
  const fallar = async (codigo: string, detalle: string, extra: Partial<ModificacionPedido> = {}) => {
    await guardar({ estado: "fallido", error: `${codigo}: ${detalle}`.slice(0, 500), ...extra });
    await deps.avisar(`⚠️ <b>Falló un cambio de pedido ${escaparHtml(d.pedido_nombre)}</b>\nCliente: ${escaparHtml(cliente)}\nPidió: ${escaparHtml(titulosLineas(d.lineas))} · Gs ${gs(d.total)}\nError: ${escaparHtml(detalle)}\nHacelo a mano o escribile.`).catch(() => {});
    return error(`${codigo}: ${detalle}. Decile que lo vemos y derivá a Enrique con motivo falla_herramienta. No digas que quedó cambiado.`);
  };

  // Se vuelve a leer el pedido: pudo salir o cancelarse desde el resumen.
  const pedido = await p.pedidoCompleto(mod.shopify_order_id).catch(() => null);
  if (!pedido) return await fallar("pedido_no_encontrado", `no pude leer ${d.pedido_nombre}`);
  const motivo = motivoNoModificable(pedido);
  if (motivo) {
    await guardar({ estado: "fallido", error: motivo.slice(0, 500) });
    return error(motivo);
  }
  let camino = elegirCamino(pedido);
  const avisos: string[] = [];

  if (camino === "editar") {
    const plan = planEdicion(pedido, d.lineas);
    if (!plan.ok) camino = "reemplazar";
    else {
      const e = await p.editarOrden(pedido.gid, plan.plan, d.total).catch((x) => ({ ok: false, error: x instanceof Error ? x.message : String(x) } as ResultadoEdicion));
      if (e.ok) {
        await guardar({ estado: "hecho", nuevo_order_id: null, nuevo_nombre: null, error: null });
        await p.vincular(ctx.conversacionId, pedido.shopify_order_id, "modificacion").catch(() => {});
        if (typeof e.total === "number" && Math.round(e.total) !== Math.round(d.total)) avisos.push(`Ojo: Shopify quedó en Gs ${gs(e.total)} y el chat dijo Gs ${gs(d.total)}.`);
        const tg = await deps.avisar(textoTelegramModificacion({ camino: "editar", viejo: pedido.nombre, cliente, d, avisos })).catch(() => ({ ok: false }));
        const primer = (ctx.nombreCliente ?? "").split(/\s+/)[0] ?? "";
        return {
          resultado: {
            ok: true,
            modificado: true,
            pedido: pedido.nombre,
            total: d.total,
            aviso_telegram: tg.ok,
            texto_respuesta: `Listo${primer ? ` ${primer}` : ""}, quedó cambiado tu pedido ${pedido.nombre}: ${titulosLineas(d.lineas)}. Total Gs ${gs(d.total)}, pagás al recibir.`,
          },
        };
      }
      // Shopify no deja editarlo (p. ej. lo creó otra app): mismo cambio por reemplazo.
      if (!e.no_editable) return await fallar("edicion_fallida", e.error ?? "sin detalle");
      avisos.push(`No se pudo editar directo (${e.error ?? "no editable"}): se reemplazó.`);
      camino = "reemplazar";
    }
  }

  // Reemplazo (Releasit): pedido nuevo → etiqueta en el viejo → cancelar el viejo.
  let nuevo = await p.reemplazoExistente(pedido.nombre).catch(() => null);
  if (nuevo) avisos.push(`Ya existía ${nuevo.nombre} como reemplazo: no se creó otro.`);
  else {
    const b = await p.crearDesdeBorrador(inputBorradorReemplazo(pedido, { ...d, camino }, mod.id))
      .catch((x) => ({ ok: false, error: x instanceof Error ? x.message : String(x) } as ResultadoBorrador));
    if (!b.ok || !b.shopify_order_id || !b.nombre) return await fallar("reemplazo_fallido", b.error ?? "draftOrderComplete sin pedido");
    nuevo = { shopify_order_id: b.shopify_order_id, nombre: b.nombre };
    if (typeof b.total === "number" && Math.round(b.total) !== Math.round(d.total)) avisos.push(`Ojo: Shopify calculó Gs ${gs(b.total)} y el chat dijo Gs ${gs(d.total)}.`);
  }
  // Desde acá el pedido nuevo existe: se guarda ya, para que nada lo vuelva a crear.
  await guardar({ estado: "ejecutando", nuevo_order_id: nuevo.shopify_order_id, nuevo_nombre: nuevo.nombre });
  // CAPI: la compra es la misma; si el viejo ya mandó Lead/Purchase, el nuevo hereda los candados y no se repiten.
  if (p.transferirCandadosMeta) {
    await p.transferirCandadosMeta(pedido.shopify_order_id, nuevo.shopify_order_id)
      .catch((x) => avisos.push(`No se copiaron los candados de Meta: ${x instanceof Error ? x.message : x}. Revisá que no salga otro Purchase.`));
  }
  const t = await p.etiquetar(pedido.gid, [tagReemplazado(nuevo.nombre)]).catch((x) => ({ ok: false, error: String(x) }));
  if (!t.ok) avisos.push(`No se pudo etiquetar ${pedido.nombre} con ${tagReemplazado(nuevo.nombre)}: ${t.error ?? ""}`);
  const c = await p.cancelarOrden(pedido.gid, `Reemplazado por ${nuevo.nombre} (cambio pedido por el cliente por WhatsApp).`)
    .catch((x) => ({ ok: false, error: x instanceof Error ? x.message : String(x) }));
  await p.vincular(ctx.conversacionId, nuevo.shopify_order_id, "modificacion").catch(() => {});
  if (!c.ok) {
    await guardar({ estado: "parcial", nuevo_order_id: nuevo.shopify_order_id, nuevo_nombre: nuevo.nombre, error: `cancelar: ${c.error ?? ""}`.slice(0, 500) });
    await deps.avisar(`🚨 <b>${escaparHtml(textoReemplazo(nuevo.nombre, pedido.nombre))}</b>, pero NO se pudo cancelar ${escaparHtml(pedido.nombre)}: ${escaparHtml(c.error ?? "")}\nCancelalo a mano (con reposición, sin avisar al cliente). NO despaches ${escaparHtml(pedido.nombre)}.`).catch(() => {});
  } else {
    await guardar({ estado: "hecho", nuevo_order_id: nuevo.shopify_order_id, nuevo_nombre: nuevo.nombre, error: null });
  }
  const tg = await deps.avisar(textoTelegramModificacion({ camino: "reemplazar", viejo: pedido.nombre, nuevo: nuevo.nombre, cliente, d, avisos }))
    .catch(() => ({ ok: false }));
  const primer = (ctx.nombreCliente ?? "").split(/\s+/)[0] ?? "";
  return {
    resultado: {
      ok: true,
      modificado: true,
      reemplazado: true,
      pedido: nuevo.nombre,
      pedido_anterior: pedido.nombre,
      total: d.total,
      cancelado_original: c.ok,
      aviso_telegram: tg.ok,
      texto_respuesta: `Listo${primer ? ` ${primer}` : ""}, quedó cambiado: ${titulosLineas(d.lineas)}. Total Gs ${gs(d.total)}, pagás al recibir. Tu pedido ahora es el ${nuevo.nombre} (reemplaza al ${pedido.nombre}).`,
    },
  };
}

// ---------- 3. guardar_factura ----------

function defGuardarFactura(): Herramienta {
  return {
    name: "guardar_factura",
    description:
      "Guarda RUC y razón social para la factura en un pedido YA HECHO (el último del cliente o el que encontraste con buscar_pedido). No derives a Enrique por esto. Si el RUC no da, pedíselo de nuevo una vez.",
    input_schema: {
      type: "object",
      properties: {
        factura: { type: "string", description: "RUC con guion y razón social, ej. \"4012344-3 Carlos Benítez\"." },
        pedido: { type: "string", description: "Número del pedido (\"#1075\"). Si no lo mandás, el último pedido de este chat." },
        factura_sin_validar: {
          type: "boolean",
          description: "Solo si ya le volviste a pedir el RUC una vez y sigue sin dar: true para guardarlo igual (Enrique lo revisa antes de facturar).",
        },
      },
      required: ["factura"],
    },
  };
}
export const definicionGuardarFactura: Herramienta = defGuardarFactura();

/** Misma validación que crear_pedido_cod (parsearFactura) + el validador de SIFEN (validarRuc) como segunda llave. */
export function validarFactura(textoFactura: string, sinValidar: boolean):
  | { ok: true; texto: string; ruc: string | null; razon: string | null; invalida: boolean }
  | { ok: false; error: string; faltan?: string[] } {
  const t = String(textoFactura ?? "").trim();
  if (!t) return { ok: false, error: "faltan_datos: RUC con guion y razón social.", faltan: ["RUC con guion (ej. 1234567-8)", "razón social"] };
  const f = parsearFactura(t);
  if (f.ok) {
    const [base, dv] = f.ruc.split("-");
    if (validarRuc(base, dv) || base.length > 8) return { ok: true, texto: `${f.ruc} ${f.razon}`, ruc: f.ruc, razon: f.razon, invalida: false };
  }
  if (sinValidar) return { ok: true, texto: t, ruc: null, razon: null, invalida: true };
  if (!f.ok && f.motivo === "sin_dv") {
    return { ok: false, error: `ruc_sin_dv: preguntale "¿Tu RUC es ${f.sugerido}?" y solo si confirma mandá factura "${f.sugerido} ${f.razon || "<razón social>"}".` };
  }
  if (f.ok || f.motivo === "dv_invalido") {
    return { ok: false, error: "ruc_invalido: el número después del guion no da. Pedíselo de nuevo UNA sola vez: \"Ese RUC no me da, ¿me lo pasás de nuevo con el número después del guion?\". Si ya se lo pediste y vuelve a fallar, llamá guardar_factura con la misma factura y factura_sin_validar=true." };
  }
  if (f.motivo === "sin_razon") return { ok: false, error: "faltan_datos: razón social (a nombre de quién va la factura).", faltan: ["razón social (a nombre de quién va la factura)"] };
  return { ok: false, error: "faltan_datos: RUC con guion (ej. 1234567-8).", faltan: ["RUC con guion (ej. 1234567-8)"] };
}

/** Atributos de factura (mismos nombres que crear_pedido_cod y Releasit: la facturación lee Ruc / Razon social / factura). */
export function atributosFactura(v: { texto: string; ruc: string | null; razon: string | null }): Atributo[] {
  return [
    { key: "factura", value: v.texto },
    ...(v.ruc ? [{ key: "Ruc", value: v.ruc }, { key: "Razon social", value: v.razon ?? "" }] : []),
  ];
}

async function guardarFactura(input: Record<string, unknown>, ctx: CtxTurno, deps: DepsHerramientas): Promise<ResultadoHerramienta> {
  const p = pw(deps);
  if (!p) return error("no_disponible: anotá el RUC en tu respuesta y avisá a Enrique con derivar_a_enrique motivo falla_herramienta.");
  const v = validarFactura(String(input.factura ?? ""), input.factura_sin_validar === true);
  if (!v.ok) return error(v.error, v.faltan ? { faltan: v.faltan } : {});
  const r = await resolverPedido(input.pedido, ctx, deps, p);
  if (!r.ok) return r.r;
  const pedido = r.pedido;
  const reemplazado = pedido.tags.find((t) => t.toUpperCase().startsWith(TAG_REEMPLAZADO));
  if (reemplazado) return error(`ya_reemplazado: ese pedido fue reemplazado por ${reemplazado.slice(TAG_REEMPLAZADO.length)}. Guardá la factura en ese (pedido="${reemplazado.slice(TAG_REEMPLAZADO.length)}").`);
  if (pedido.cancelado) return error("pedido_cancelado: ese pedido está cancelado; la factura va en el pedido vigente.");
  // Si ya tenía otra factura cargada, se pisa y se avisa (la factura se emite recién al cobrar).
  const previa = pedido.atributos.find((a) => a.key.trim().toLowerCase() === "factura")?.value ?? null;
  const u = await p.actualizarAtributos(pedido.gid, atributosFactura(v)).catch((e) => ({ ok: false, error: e instanceof Error ? e.message : String(e) }));
  if (!u.ok) return error(`no_se_pudo_guardar: ${u.error}. Decile que lo anotaste y avisá a Enrique con derivar_a_enrique motivo falla_herramienta.`);
  await p.vincular(ctx.conversacionId, pedido.shopify_order_id, "factura").catch(() => {});
  const aviso = v.invalida
    ? `🧾 ${escaparHtml(pedido.nombre)} pide factura pero el RUC no es válido ("${escaparHtml(v.texto)}"). Pedile el dato correcto antes de facturar.`
    : `🧾 ${escaparHtml(pedido.nombre)}: factura a ${escaparHtml(v.texto)} (guardada por el vendedor).${previa && previa !== v.texto ? ` Antes decía: ${escaparHtml(previa)}.` : ""} Se factura recién cuando esté cobrado.`;
  await deps.avisar(aviso).catch(() => {});
  return {
    resultado: {
      ok: true,
      guardado: true,
      pedido: pedido.nombre,
      factura: v.texto,
      nota: v.invalida
        ? "Quedó anotado; Enrique revisa el RUC antes de facturar. Confirmale corto que lo anotaste."
        : "Listo, quedó en el pedido. Confirmale corto que la factura sale a ese nombre cuando reciba el pedido.",
    },
  };
}

// ---------- exportación para el integrador ----------

export const buscarPedidoHerr: { definicion: Herramienta; ejecutor: Ejecutor } = { definicion: definicionBuscarPedido, ejecutor: buscarPedido };
export const modificarPedidoHerr: { definicion: Herramienta; ejecutor: Ejecutor } = { definicion: definicionModificarPedido, ejecutor: modificarPedido };
export const guardarFacturaHerr: { definicion: Herramienta; ejecutor: Ejecutor } = { definicion: definicionGuardarFactura, ejecutor: guardarFactura };

/**
 * Para registrar en herramientas.ts SIN problemas de import circular: es una declaración de función (Deno/ESM la
 * inicializa antes de evaluar cualquier módulo del ciclo) y arma todo al llamarla, así sirve aunque este archivo
 * todavía no se haya evaluado cuando herramientas.ts arma HERRAMIENTAS / EJECUTORES.
 */
export function herramientasPedidosWeb(): Array<{ definicion: Herramienta; ejecutor: Ejecutor }> {
  return [
    { definicion: defBuscarPedido(), ejecutor: buscarPedido },
    { definicion: defModificarPedido(), ejecutor: modificarPedido },
    { definicion: defGuardarFactura(), ejecutor: guardarFactura },
  ];
}
