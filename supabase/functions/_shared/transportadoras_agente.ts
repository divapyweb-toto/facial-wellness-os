// 18-11 · Agente de transportadoras (WhatsApp API Voltra 3, encargo de administración; Enrique: "que no salga muy caro
// que el bot hable con las transportadoras"). Lógica pura, sin I/O. Costo mínimo:
//   1. Reglas sin IA: tema de plata o tarifas → se deriva al contacto de config (nunca se discute); pedido citado
//      (VT-1234, #1234, L-VT-1234 o guía de PaP) → respuesta armada SOLO con datos de la base.
//   2. Si la regla no alcanza: Haiku 4.5 con un prompt corto que SOLO entiende de qué habla (tema + pedido). La respuesta
//      la arma igual el código con la base; la IA nunca escribe lo que se le manda al courier.
//   3. Lo que no se sabe con certeza no se contesta: queda sin responder para administración (y Telegram a las 2 h).
import { formatearGuaranies } from "./telegram_formato.ts";

export const MODELO_AGENTE = "claude-haiku-4-5-20251001";
export const PRESENTACION = "Voltra (antes Facial Wellness, es la misma empresa)";

/** Referencias en un texto: pedidos citados (VT-1234, #1234, L-VT-1234, "pedido 1234") y números sueltos de 5 a 9
 * dígitos como posibles guías (Lucero 23740, PaP 26546876). Los celulares (09…) no cuentan. */
export function extraerRefs(texto: string): { pedidos: string[]; guias: string[] } {
  const t = String(texto ?? "");
  const pedidos = new Set<string>();
  for (const m of t.matchAll(/(?:\bL-)?\bVT[-\s]?(\d{3,5})\b|#\s?(\d{3,5})\b|\bpedido\s+(?:n[°ºo.]?\s*)?(\d{3,5})\b/gi)) {
    pedidos.add(m[1] ?? m[2] ?? m[3]);
  }
  const guias = new Set<string>();
  for (const m of t.matchAll(/(?<![\d.,])(\d{5,9})(?![\d.,])/g)) if (!pedidos.has(m[1]) && !/^0/.test(m[1])) guias.add(m[1]);
  return { pedidos: [...pedidos], guias: [...guias] };
}

/**
 * Plata entre Voltra y el courier (rendiciones, depósitos, deudas, tarifas, recargos). NO es plata: "¿ya pagó el
 * cliente?" o "¿cuánto cobro?" (eso es el estado del pedido y se responde).
 */
export function esTemaPlata(texto: string): boolean {
  const t = String(texto ?? "").toLowerCase();
  return /rendici[oó]n|rendir|rendimos|liquidaci[oó]n|dep[oó]sit|transferimos|les (?:debemos|pasamos)|nos deben|me deben|deuda|saldo a favor|factura|comisi[oó]n|tarifa|aumento|recargo|costo extra|cobro extra|cargo extra|precio (?:del|de) (?:env[ií]o|flete)|nuevo precio|nuevos precios|lista de precios/
    .test(t);
}

export function textoPlata(contacto: string | null): string {
  return contacto
    ? `Eso lo ve Enrique directamente: escribile al ${contacto}. Gracias.`
    : "Eso lo ve Enrique directamente: te escribe él. Gracias.";
}

export type SenalPagoCourier = "pagado" | "credito" | "parcial" | null;
export type DatosPedidoCourier = {
  ref: string; // "VT-1234"
  nombre: string | null; // primer nombre del cliente
  ciudad: string | null;
  total: number | null;
  senal: SenalPagoCourier;
  /** Mandó comprobante y todavía no se verificó (no se le dice que cobre). */
  comprobanteEnEspera: boolean;
  cancelado: boolean;
  entregado: boolean;
  /** Último pedido del cliente al courier (casos_courier): qué pidió, horario, referencia, quién recibe. */
  pide: string | null;
  horario: string | null;
  referencia: string | null;
  recibe: string | null;
};

/**
 * Respuesta sobre un pedido, solo con datos seguros. null = no hay certeza (pago parcial, crédito, sin monto): no se
 * responde y queda para administración.
 */
export function respuestaPedido(d: DatosPedidoCourier): string | null {
  const quien = [d.ref, d.nombre, d.ciudad].filter(Boolean).join(" · ");
  let cobro: string;
  if (d.cancelado) return null; // cancelado con el paquete en el courier: lo ve Enrique (alerta de FUNCIONES)
  if (d.entregado) return null; // ya entregado: cualquier duda de cobro es plata (doble cobro) → Enrique
  if (d.senal === "pagado") cobro = "el cliente YA PAGÓ por transferencia → entregar SIN COBRAR (₲0)";
  // 18-11 (administración): comprobante sin verificar, pago parcial o crédito → sin certeza: no se responde.
  else if (d.comprobanteEnEspera || d.senal === "parcial" || d.senal === "credito") return null;
  else if (d.total && d.total > 0) cobro = `cobrar ${formatearGuaranies(d.total)} al entregar`;
  else return null;
  const extra = [
    d.pide ? `Pidió: ${d.pide}` : null,
    d.horario ? `Horario: ${d.horario}` : null,
    d.referencia ? `Referencia: ${d.referencia}` : null,
    d.recibe ? `Recibe: ${d.recibe}` : null,
  ].filter(Boolean);
  return [`${quien}: ${cobro}.`, ...extra].join("\n");
}

/** Saludo una sola vez por chat (cuando escriben sin pedir nada concreto). */
export const TEXTO_SALUDO =
  `¡Hola! Te escribe el asistente de ${PRESENTACION}. Por acá te avisamos de pedidos pagados, reprogramaciones y cambios de dirección. ` +
  "Si querés saber algo de un pedido, mandame el número (VT-1234) o la guía.";

export type TemaCourier = "pedido" | "plata" | "cobertura" | "saludo" | "otro";
export type Clasificacion = { tema: TemaCourier; ref: string | null; ciudad: string | null };

export const PROMPT_AGENTE =
  "Sos el clasificador de mensajes que una empresa de envíos (courier) de Paraguay le manda a la tienda Voltra. " +
  'Respondé SOLO un JSON: {"tema": "pedido"|"plata"|"cobertura"|"saludo"|"otro", "ref": número de pedido o guía si lo nombra o null, "ciudad": ciudad si pregunta o informa cobertura o null}. ' +
  "pedido = pregunta o avisa algo de un envío (si pagó, cuánto cobrar, horario, dirección, no atiende, rechazó). " +
  "plata = rendiciones, depósitos, deudas, facturas, tarifas o precios del courier. cobertura = si llegan a una ciudad o cuánto cuesta. " +
  "saludo = solo saluda o se presenta. otro = cualquier otra cosa.";

/** JSON de Haiku → clasificación. Cualquier cosa rara = "otro" (queda para administración). */
export function interpretarClasificacion(texto: string): Clasificacion {
  const m = /\{[\s\S]*\}/.exec(String(texto ?? ""));
  try {
    const j = JSON.parse(m?.[0] ?? "") as Record<string, unknown>;
    const temas: TemaCourier[] = ["pedido", "plata", "cobertura", "saludo", "otro"];
    const tema = temas.includes(j.tema as TemaCourier) ? j.tema as TemaCourier : "otro";
    const ref = j.ref == null ? null : String(j.ref).replace(/[^\dA-Za-z-]/g, "").slice(0, 20) || null;
    const ciudad = typeof j.ciudad === "string" && j.ciudad.trim() ? j.ciudad.trim().slice(0, 60) : null;
    return { tema, ref, ciudad };
  } catch {
    return { tema: "otro", ref: null, ciudad: null };
  }
}

/** ¿Vale la pena gastar IA? Mensajes de una o dos palabras ("ok", "dale", "gracias", 👍) no se clasifican. */
export function necesitaIA(texto: string): boolean {
  const t = String(texto ?? "").trim().toLowerCase().replace(/[!.¡¿?,👍🙏✅😊]/g, "").trim();
  if (t.length < 4) return false;
  return !/^(ok|oki|okey|dale|listo|gracias|muchas gracias|perfecto|recibido|entendido|de nada|si|sí|bueno|joya|genial)$/.test(t);
}

/** Texto para la plantilla: una línea, sin tabulaciones ni 4 espacios seguidos (reglas de Meta para variables). */
export function unaLinea(texto: string, max = 700): string {
  const t = String(texto ?? "").replace(/[\t\r]+/g, " ").replace(/\n+/g, " · ").replace(/ {2,}/g, " ").trim().replace(/[.\s]+$/, "");
  return t.length > max ? `${t.slice(0, max - 1)}…` : t;
}
