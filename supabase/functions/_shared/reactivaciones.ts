// _shared/reactivaciones.ts · 21-10-2026 (Enrique) · recuperar un pedido que el cliente canceló, SIN pedido nuevo.
// Caso: le escribimos al cliente que canceló ("¿lo reactivamos?"). Si contesta que sí, no se arma otro pedido (Despacho
// vería dos ventas para lo mismo): se reusa el que ya había.
//   · en_courier: el paquete ya está en el courier (el pedido de Shopify ya se anuló). Se deja constancia, la venta VT
//     sigue viva y se avisa a Enrique para que el courier lo entregue. Nunca se crea un pedido en Shopify.
//   · reabrir: el pedido sigue abierto en Shopify con CANCELADO_CLIENTE → se le saca esa etiqueta y sigue el mismo.
// Si dice que no o no contesta hasta `vence`: en_courier → Telegram para pedirle al courier que lo devuelva; reabrir →
// se cancela de verdad en Shopify (pedidos-trabados).
// La lista vive en config_wa.reactivaciones ({lista: [...]}), nunca en el repo (datos de clientes). La decisión queda
// en eventos_crudos (id `reactivacion:<shopify_order_id>`, payload {resultado}), que inserta una sola vez.
// Puro: sin I/O.

export type ModoReactivacion = "en_courier" | "reabrir";

export type Reactivacion = {
  cliente_id: string;
  shopify_order_id: string;
  /** "#9001" */
  pedido: string;
  /** Venta de Voltra OS ("VT-9001"), si ya existe. */
  venta?: string | null;
  /** Primer nombre del cliente (textos). */
  nombre: string;
  total: number;
  /** "Lucero", "PaP" (en_courier). */
  courier?: string | null;
  modo: ModoReactivacion;
  /** ISO: hasta cuándo vale un "sí". */
  vence: string;
};

export type ResultadoReactivacion = "si" | "no" | "vencido";

export const idDecisionReactivacion = (orderId: string | number) => `reactivacion:${orderId}`;
export const idCierreReactivacion = (orderId: string | number) => `reactivacion_cierre:${orderId}`;

const esObj = (v: unknown): v is Record<string, unknown> => !!v && typeof v === "object" && !Array.isArray(v);

/** config_wa.reactivaciones → lista válida (lo raro se descarta). */
export function leerReactivaciones(v: unknown): Reactivacion[] {
  const lista = esObj(v) && Array.isArray(v.lista) ? v.lista : [];
  return lista.flatMap((x): Reactivacion[] => {
    if (!esObj(x)) return [];
    const s = (k: string) => (typeof x[k] === "string" ? (x[k] as string).trim() : "");
    const modo = s("modo");
    const total = Number(x.total);
    if (!s("cliente_id") || !s("shopify_order_id") || !s("pedido") || !Number.isFinite(Date.parse(s("vence")))) return [];
    if ((modo !== "en_courier" && modo !== "reabrir") || !(total > 0)) return [];
    return [{
      cliente_id: s("cliente_id"), shopify_order_id: s("shopify_order_id"), pedido: s("pedido"), venta: s("venta") || null,
      nombre: s("nombre") || "", total, courier: s("courier") || null, modo, vence: s("vence"),
    }];
  });
}

/** La reactivación vigente de este cliente (antes de `vence`), o null. */
export function reactivacionVigente(lista: Reactivacion[], clienteId: string, ahora: Date): Reactivacion | null {
  return lista.find((r) => r.cliente_id === clienteId && ahora.getTime() < Date.parse(r.vence)) ?? null;
}

function limpiar(s: string): string {
  return String(s ?? "").normalize("NFD").replace(/\p{M}/gu, "").toLowerCase()
    .replace(/[\p{Extended_Pictographic}\u{1F3FB}-\u{1F3FF}\u{FE0F}\u{200D}]/gu, " ")
    .replace(/[!.,;:¡…"'()]+/g, " ").replace(/\s+/g, " ").trim();
}

const RE_NO = /^(?:no+|nop|nel|ya no|no gracias|gracias no|no quiero|no lo quiero|ya no lo quiero|ya no quiero|no me interesa|ya no me interesa|dejalo asi|dejalo nomas|cancelalo|cancelado|que lo devuelvan|no ya no)(?: (?:gracias|nomas|ya|por ahora|che|amigo|amiga))*$/;
const RE_NO_DENTRO = /\b(?:ya no lo quiero|no lo quiero|no lo voy a querer|ya compre|ya lo compre|no me interesa)\b/;
const RE_SI = /^(?:si+|sip|dale|ok|okey|okay|bueno|listo|de una|perfecto|claro|joya|genial|confirmo|lo quiero|quiero|si quiero|si lo quiero|mandalo|mandamelo|traemelo|dejalo en camino|que lo entreguen|que me lo traigan|reactivalo|si reactivalo)\b/;

/**
 * Respuesta a "¿lo reactivamos?": "si", "no" o null (pregunta, condición o algo que no se entiende: lo ve el vendedor).
 * Un "sí, pero el viernes" o cualquier "?" no es un sí directo.
 */
export function respuestaReactivacion(texto: string): "si" | "no" | null {
  const crudo = String(texto ?? "");
  if (/^\s*\[bot[oó]n\]\s*confirmo\b/i.test(crudo)) return "si";
  if (/^\s*\[/.test(crudo)) return null; // otro botón o marca del sistema
  const t = limpiar(crudo);
  if (!t) return null;
  if (RE_NO.test(t) || RE_NO_DENTRO.test(t)) return "no";
  if (/[?¿]/.test(crudo) || /\b(?:pero|aunque|si no|cuando|antes|despues|recien)\b/.test(t)) return null;
  if (/\bno\b/.test(t)) return null;
  return RE_SI.test(t) && t.length <= 60 ? "si" : null;
}

const gs = (n: number) => Math.round(n).toLocaleString("es-PY").replace(/,/g, ".");

export function telegramSi(r: Reactivacion): string {
  return r.modo === "en_courier"
    ? `✅ ${r.nombre || "El cliente"} reactivó ${r.pedido}: el paquete ${r.venta ?? r.pedido} ya está en ${r.courier ?? "el courier"}, avisar que lo entreguen`
    : `✅ ${r.nombre || "El cliente"} reactivó ${r.pedido}: sigue el mismo pedido (sin pedido nuevo), ya está confirmado`;
}

export function telegramNo(r: Reactivacion, motivo: "no" | "vencido"): string {
  const quien = r.nombre || "El cliente";
  const por = motivo === "no" ? "dijo que no" : "no contestó";
  return r.modo === "en_courier"
    ? `❌ ${quien} no reactivó (${por}): pedir a ${r.courier ?? "el courier"} que devuelva ${r.venta ?? r.pedido}`
    : `❌ ${quien} no reactivó ${r.pedido} (${por}): quedó cancelado en Shopify`;
}

export function textoClienteSi(r: Reactivacion): string {
  const nombre = r.nombre ? ` ${r.nombre}` : "";
  return r.modo === "en_courier"
    ? `¡Genial${nombre}! Queda en camino con ${r.courier ?? "el courier"}: el repartidor te llama antes de ir y pagás ${gs(r.total)} al recibir 🙌`
    : `¡Genial${nombre}! Lo reactivé tal cual: ${gs(r.total)} y pagás al recibir. Te avisamos por acá cuando salga 🙌`;
}

export function textoClienteNo(r: Reactivacion): string {
  return `Dale, sin problema${r.nombre ? ` ${r.nombre}` : ""}. Si más adelante lo querés, escribinos por acá 🙌`;
}

/** Marca para el vendedor cuando la respuesta no es un sí ni un no directo (pregunta, condición). */
export function marcaVendedorReactivacion(r: Reactivacion): string {
  return `[pedido ${r.pedido} CANCELADO por el cliente que le ofrecimos reactivar tal cual (${gs(r.total)}). NO armes un pedido nuevo ni ` +
    `llames crear_pedido_cod: respondé su duda corto y cerrá con "¿Lo reactivamos? Respondeme sí 🙌". El sistema lo reactiva cuando dice que sí.]`;
}
