// lista-despacho/logica.ts · 27-10. Enrique: "Sacá el aviso por cada pedido. Mandame una sola lista por día de lo que
// hay que despachar, con la nota de armado." Puro, sin red: pedidos de Shopify (shopify_pedidos) → un mensaje.
// Misma regla que Despacho (DespachoPagina.jsx: clasificarEstado, esPagoAnticipado, separarPedidosVoltra):
//   confirmado/ayuda, sin comprobante sin verificar, sin FALTAN_DATOS y con courier que cubra → a despachar
//   (27-10: pagado → "courier libre" aunque nadie cobre en esa ciudad);
//   retiro en persona confirmado → sección Retiro; confirmados trabados → "No despachar" con el motivo.
// Lo que ya pasó por Despacho (EN_PREPARACION, DESPACHADO…, venta con salida o fila en entregas) no se lista.
// 29-10: la decisión "sale / no sale" es la de _shared/sale_hoy.js (la MISMA que usa la web de Despacho), con el
// motivo y quién lo resuelve. Ciudad mal escrita: si la lista vieja no encuentra courier, manda la tabla de tarifas
// (rpc sugerir_courier, misma normalización y alias que la base); una ciudad que la tabla no reconoce NO es "sin
// cobertura" sino "faltan datos: ciudad" (#1150).
import { escaparHtml, notaArmado } from "../_shared/telegram_formato.ts";
import { sugerirTransportadora } from "../_shared/transportadoras.js";
import { decidirSalida, direccionUtilizable, esCancelado, esConfirmado } from "../_shared/sale_hoy.js";

export interface PedidoShopify { nombre: string | null; estado_envio: string | null; es_borrador: boolean | null; creado_en: string; raw: Record<string, unknown> | null }
export interface VentaDespacho { n_referencia: string; transportadora: string | null; despachado_at: string | null }

export const NOTA_ARMADO_KIT = "ARMAR: 1 botella + 1 tiras";
/** Estados de shopify_pedidos que ya pasaron por Despacho (preparado o salido). */
export const YA_PROCESADO = new Set(["EN_PREPARACION", "DESPACHADO", "INTENTO_FALLIDO", "ENTREGADO", "NO_ENTREGADO_RESCATABLE", "NO_ENTREGADO", "RENDIDO", "CANCELADO"]);

const tagsDe = (raw: Record<string, unknown> | null): string[] => {
  const t = raw?.tags;
  return (Array.isArray(t) ? t.map(String) : String(t ?? "").split(",")).map((x) => x.trim().toLowerCase()).filter(Boolean);
};
const tiene = (tags: string[], t: string) => tags.includes(t);
const conPrefijo = (tags: string[], p: string) => tags.find((t) => t.startsWith(p)) ?? null;

/** '#1135' → 'VT-1135'. */
export const refVoltra = (nombre: string | null) => `VT-${String(nombre ?? "").replace(/^#/, "").trim()}`;

export function esKit(nombre: string): boolean {
  const t = nombre.toLowerCase();
  return /kit ?deporte/.test(t) || (/botella/.test(t) && /tira|nasal/.test(t));
}

interface Linea { nombre: string; cantidad: number }
export interface PedidoLista {
  nombre: string; ref: string; ciudad: string; lineas: Linea[]; total: number; pagado: boolean; prioridad: boolean;
  factura: string | null; programado: boolean; reemplaza: string | null; totalDistinto: string | null; sinPin: boolean;
  courier: string | null; armado: string[]; creado_en: string;
}
export interface NoDespachar { p: PedidoLista; motivo: string; clave: string; quien: string }
export interface ListaDespacho { porCourier: Map<string, PedidoLista[]>; retiros: PedidoLista[]; noDespachar: NoDespachar[]; sinConfirmar: number }
/** 29-10: cobertura de la tabla de tarifas (rpc sugerir_courier) por ciudad tal cual viene (sin espacios de los costados). */
export interface CoberturaCiudad { ciudad_reconocida: boolean; sin_cobertura: boolean; sugerido: string | null }

function lineaDe(nota: string, etiqueta: RegExp): string | null {
  const l = nota.split(/\n/).find((x) => etiqueta.test(x));
  return l ? l.replace(etiqueta, "").trim() || null : null;
}

function atributo(raw: Record<string, unknown>, nombre: RegExp): string | null {
  const lista = [...(Array.isArray(raw.note_attributes) ? raw.note_attributes : []), ...(Array.isArray(raw.customAttributes) ? raw.customAttributes : [])] as Record<string, unknown>[];
  const a = lista.find((x) => nombre.test(String(x?.name ?? x?.key ?? "")));
  const v = a ? String(a.value ?? "").trim() : "";
  return v || null;
}

/** Pagado antes de la entrega (igual que Despacho: 'paid' suelto con envío ya preparado NO es prepago). */
export function pagadoAntes(raw: Record<string, unknown>, tags: string[]): boolean {
  if (tiene(tags, "pago_verificado") || tiene(tags, "pagado") || tiene(tags, "pagado_qr") || tags.some((t) => t.includes("credito"))) return true;
  if (String(raw.financial_status ?? "").toLowerCase() !== "paid") return false;
  if (tiene(tags, "pago_anticipado_comprobante")) return true;
  const ff = String(raw.fulfillment_status ?? "").toLowerCase();
  return ff === "" || ff === "unfulfilled" || ff === "null";
}

function aPedido(f: PedidoShopify, venta: VentaDespacho | undefined): PedidoLista & { tags: string[]; direccionOk: boolean } {
  const raw = f.raw ?? {};
  const tags = tagsDe(raw);
  const dir = (raw.shipping_address ?? raw.billing_address ?? {}) as Record<string, unknown>;
  const lineas = (Array.isArray(raw.line_items) ? raw.line_items : []).map((li: Record<string, unknown>) => ({ nombre: String(li.name ?? li.title ?? ""), cantidad: Number(li.quantity ?? 1) || 1 }));
  const nota = String(raw.note ?? "");
  const ciudad = atributo(raw, /^ciudad$/i) ?? String(dir.city ?? "").trim();
  const pagado = pagadoAntes(raw, tags);
  const armado = [...new Set(lineas.flatMap((l) => [esKit(l.nombre) ? NOTA_ARMADO_KIT : "", notaArmado(l.nombre, l.cantidad)]).filter(Boolean))];
  const forzado = lineas.find((l) => /jaw|mand[ií]bula|ejercitador/i.test(l.nombre))?.nombre ?? lineas[0]?.nombre ?? "";
  const courier = venta?.transportadora && venta.transportadora !== "otra" ? venta.transportadora : (sugerirTransportadora(ciudad, forzado, { cod: !pagado }).transportadora ?? null);
  const direccion = [dir.address1, dir.address2].map((x) => String(x ?? "").trim()).filter(Boolean).join(", ");
  const notas = [nota, ...[...(Array.isArray(raw.note_attributes) ? raw.note_attributes : []), ...(Array.isArray(raw.customAttributes) ? raw.customAttributes : [])]
    .map((a: Record<string, unknown>) => `${a?.name ?? a?.key ?? ""}: ${a?.value ?? ""}`)].join("\n");
  return {
    direccionOk: direccionUtilizable({ direccion, notas, ciudad }),
    nombre: String(raw.name ?? f.nombre ?? ""), ref: refVoltra(String(raw.name ?? f.nombre ?? "")), ciudad, lineas,
    total: Math.round(Number(raw.total_price ?? 0)) || 0, pagado, prioridad: tiene(tags, "prioridad") || pagado,
    factura: lineaDe(nota, /^\s*factura\s*:\s*/i) ?? atributo(raw, /facturar/i), programado: tiene(tags, "entrega_programada"),
    reemplaza: conPrefijo(tags, "reemplaza_a_")?.replace("reemplaza_a_", "").toUpperCase() ?? null,
    totalDistinto: tiene(tags, "total_distinto") ? (lineaDe(nota, /^\s*total distinto\s*:\s*/i) ?? "revisar el total") : null,
    sinPin: tiene(tags, "sin_pin"), courier, armado, creado_en: f.creado_en, tags,
  };
}

/** Clasifica los pedidos de los últimos días en lo que hay que despachar hoy. `coberturas` (29-10): tabla de tarifas por ciudad. */
export function armarLista(filas: PedidoShopify[], ventas: VentaDespacho[], refsEnCourier: Set<string>, ahora = new Date(), coberturas?: ReadonlyMap<string, CoberturaCiudad>): ListaDespacho {
  const limiteRetiro = new Date(ahora.getTime() - 7 * 86400_000).toISOString();
  const ventaPorRef = new Map(ventas.map((v) => [v.n_referencia, v]));
  const out: ListaDespacho = { porCourier: new Map(), retiros: [], noDespachar: [], sinConfirmar: 0 };
  for (const f of filas) {
    const raw = f.raw ?? {};
    if (f.es_borrador || raw.test === true || !Array.isArray(raw.line_items) || !raw.line_items.length) continue;
    if (YA_PROCESADO.has(String(f.estado_envio ?? ""))) continue;
    const tags = tagsDe(raw);
    // Cancelado o anulado (cancelled_at, CANCELADO_*, voided, ANTERIOR_AL_CORTE, REEMPLAZADO_POR_): en ningún lado.
    if (esCancelado({ tags, cancelledAt: raw.cancelled_at, financialStatus: raw.financial_status })) continue;
    if (tiene(tags, "despachado") || tiene(tags, "entregado")) continue;
    // Ya preparado en Shopify (Despacho crea el fulfillment al marcar "preparado"): #1060.
    if (String(raw.fulfillment_status ?? "").toLowerCase() === "fulfilled") continue;
    const ref = refVoltra(String(raw.name ?? f.nombre ?? ""));
    const venta = ventaPorRef.get(ref);
    if (venta?.despachado_at || refsEnCourier.has(ref)) continue;
    const p = aPedido(f, venta);
    const cob = coberturas?.get(p.ciudad.trim());
    // La lista vieja no encontró courier pero la tabla sí (ciudad mal escrita que la tabla reconoce por alias o fonética).
    if (!p.courier && !p.pagado && cob?.ciudad_reconocida && !cob.sin_cobertura && cob.sugerido) p.courier = cob.sugerido;
    const r = decidirSalida({
      cancelado: false,
      retiro: tiene(tags, "retiro_en_casa"),
      confirmado: esConfirmado(tags),
      pagado: p.pagado,
      comprobante: tiene(tags, "pago_anticipado_comprobante"),
      // Enrique 27-10: "si tiene pin o solo tiene calle y ciudad sin pin igual ya se puede despachar". FALTAN_DATOS lo
      // pone pedidos-trabados con esta misma regla (direccionUtilizable); SIN_PIN solo no frena.
      faltanDatos: tiene(tags, "faltan_datos"),
      direccionOk: p.direccionOk,
      courier: tiene(tags, "sin_cobertura") && !p.pagado ? null : p.courier,
      sinCoberturaTag: tiene(tags, "sin_cobertura"),
      // Sin dato de la tabla y sin SIN_COBERTURA: la lista vieja tampoco la conoce → ciudad por confirmar, no "sin cobertura".
      ciudadReconocida: cob ? cob.ciudad_reconocida : tiene(tags, "sin_cobertura"),
    });
    if (r.retiro) {
      // Retiros: hasta 7 días (uno viejo sin marcar entregado no se repite todos los días: #1089).
      if (esConfirmado(tags) && new Date(p.creado_en).toISOString() >= limiteRetiro) out.retiros.push(p); else if (!esConfirmado(tags)) out.sinConfirmar++;
      continue;
    }
    if (!r.sale) {
      if (r.clave === "sin_confirmar") out.sinConfirmar++;
      else out.noDespachar.push({ p, clave: r.clave, quien: r.quien, motivo: `${r.motivo}: ${r.detalle} · resuelve ${r.quien}` });
      continue;
    }
    // Enrique 27-10: "ya está pagada no necesita cobranza" → pagado sin courier con cobranza: va por el que llegue.
    p.courier = r.courier;
    if (!out.porCourier.has(p.courier!)) out.porCourier.set(p.courier!, []);
    out.porCourier.get(p.courier!)!.push(p);
  }
  for (const l of out.porCourier.values()) l.sort((a, b) => Number(b.prioridad) - Number(a.prioridad) || a.creado_en.localeCompare(b.creado_en));
  return out;
}

/** 29-10: ciudades de los "no despachar" por cobertura o ciudad, para consultar la tabla de tarifas (rpc). */
export const ciudadesAConsultar = (l: ListaDespacho) =>
  [...new Set(l.noDespachar.filter((x) => x.clave === "sin_cobertura" || x.clave === "ciudad").map((x) => x.p.ciudad.trim()).filter(Boolean))];

const NOMBRE_COURIER: Record<string, string> = { lucero: "Lucero del Este", pap: "Punto a Punto", libre: "Courier libre (ya pagado)" };
const gs = (n: number) => `Gs ${n.toLocaleString("es-PY")}`;
const producto = (l: Linea) => `${escaparHtml(l.nombre.split(":")[0].trim())} ×${l.cantidad}`;
const diaCorto = (iso: string) => { const d = new Date(new Date(iso).getTime() - 3 * 3600_000); return `${String(d.getUTCDate()).padStart(2, "0")}/${String(d.getUTCMonth() + 1).padStart(2, "0")}`; };

function bloque(p: PedidoLista, hoyISO: string): string {
  const l = [`<b>${escaparHtml(p.nombre)}</b> · ${escaparHtml(p.ciudad || "sin ciudad")} · ${p.lineas.map(producto).join(" + ")}`];
  l.push(p.pagado ? "💳 PAGADO · cobrar 0 · courier libre" : `Cobrar ${gs(p.total)}`);
  for (const a of p.armado) l.push(`<b>${escaparHtml(a)}</b>`);
  const extra: string[] = [];
  if (p.prioridad) extra.push("⚡ prioridad");
  if (p.factura) extra.push(`🧾 factura: ${escaparHtml(p.factura)}`);
  if (p.programado) extra.push("📅 entrega programada (ver Despacho)");
  if (p.reemplaza) extra.push(`reemplaza a ${escaparHtml(p.reemplaza)}`);
  if (p.totalDistinto) extra.push(`⚠ total distinto: ${escaparHtml(p.totalDistinto)}`);
  if (p.sinPin) extra.push("📍 sin pin");
  if (p.creado_en.slice(0, 10) < hoyISO) extra.push(`desde ${diaCorto(p.creado_en)}`);
  if (extra.length) l.push(extra.join(" · "));
  return l.join("\n");
}

/** Texto del mensaje (null = no hay nada para despachar ni retiros ni trabados: no se manda). */
export function textoLista(lista: ListaDespacho, ahora: Date, prueba = false): string | null {
  const total = [...lista.porCourier.values()].reduce((s, l) => s + l.length, 0);
  if (!total && !lista.retiros.length && !lista.noDespachar.length) return null;
  const py = new Date(ahora.getTime() - 3 * 3600_000);
  const hoyISO = py.toISOString().slice(0, 10);
  const partes = [`${prueba ? "🧪 PRUEBA · " : ""}<b>📦 Lista de despacho · ${diaCorto(ahora.toISOString())}</b>\n${total} para despachar${lista.retiros.length ? ` · ${lista.retiros.length} retiro(s)` : ""}${lista.noDespachar.length ? ` · ${lista.noDespachar.length} no despachar` : ""}`];
  for (const [c, l] of [...lista.porCourier.entries()].sort((a, b) => b[1].length - a[1].length)) {
    partes.push(`<b>🚚 ${escaparHtml(NOMBRE_COURIER[c] ?? c)} (${l.length})</b>\n\n${l.map((p) => bloque(p, hoyISO)).join("\n\n")}`);
  }
  if (lista.retiros.length) partes.push(`<b>🏠 Retiro en persona (${lista.retiros.length})</b>\n\n${lista.retiros.map((p) => bloque(p, hoyISO)).join("\n\n")}`);
  if (lista.noDespachar.length) partes.push(`<b>⛔ No despachar (${lista.noDespachar.length})</b>\n${lista.noDespachar.map(({ p, motivo }) => `• <b>${escaparHtml(p.nombre)}</b> · ${escaparHtml(p.ciudad || "sin ciudad")}: ${escaparHtml(motivo)}`).join("\n")}`);
  if (lista.sinConfirmar) partes.push(`<i>${lista.sinConfirmar} sin confirmar todavía (no van).</i>`);
  return partes.join("\n\n");
}
