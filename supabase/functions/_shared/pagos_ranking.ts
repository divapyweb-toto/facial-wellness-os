// _shared/pagos_ranking.ts · 29-10-2026. Ranking puro de "¿a qué pedido corresponde esta transferencia?".
// Caso que lo originó: una transferencia de Gs 112.000 (29-10 15:30 PY, sin número ni titular) no se asoció a #1164
// porque había 17 pedidos esperando ese monto, aunque el cliente de #1164 mandó el comprobante por WhatsApp desde el
// celular del pedido ese mismo minuto. Sin red: pago-verificado (modo sin pedido) trae los candidatos y ejecuta.
//
// Orden de señales (regla de Enrique 29-10: "hay que matchear numero de celular con nro de transferencia del
// comprobante con nombre y apellido"). Cada una achica la lista; si queda UNO, es ese:
//   1. nro:       el nro. de transacción (o una referencia) que se leyó del comprobante del chat del pedido = el del
//                 aviso de ueno → certeza (aunque el titular sea otro, p. ej. un familiar);
//   2. telefono:  comprobante mandado desde el WhatsApp con el MISMO celular del pedido, con monto exacto (si se leyó)
//                 y en la ventana horaria (por defecto de 3 h antes a 1 h después de la transferencia, o la hora leída
//                 del comprobante a ±30 min) → certeza;
//   3. titular:   el titular (del aviso de ueno) comparte al menos 2 palabras con el nombre del cliente (sin tildes,
//                 sin mayúsculas, en cualquier orden) + un solo pedido así → suficiente;
//   4. hora:      cercanía entre comprobante y transferencia → SOLO desempata entre los que ya tienen señal 1-3.
// Un comprobante marcado para el pedido pero desde otro celular ("comprobante") solo ordena y desempata.
// El "más reciente con OFERTA_PAGO_ANTICIPADO" solo ordena la lista (no alcanza para marcar plata solo).
// Si no queda uno solo con señal → ambiguo: aviso a Enrique con los 3 más probables y un botón "Es este" en cada uno
// (callback es_este:<orderId>:<ref>, telegram-webhook lo trata igual que "Recibido").
// Rendiciones de los couriers (Punto a Punto, Lucero del Este) llegan a la misma cuenta: nunca se asocian ni avisan.
// Nada de datos personales hacia afuera: nombres y teléfonos solo se comparan acá; el aviso lleva pedido, total,
// ciudad y hace cuánto.

import { normalizarTelefonoPY } from "./telefono.ts";
import { type BotonTelegram, escaparHtml, formatearGuaranies, horaCortaAsuncion, LIMITE_CALLBACK_BYTES } from "./telegram_formato.ts";

export interface TransferenciaRecibida {
  monto: number;
  /** Hora de la transferencia (ISO). */
  fecha: string;
  /** Número de transacción (si el aviso lo trae). */
  nro_transaccion?: string | null;
  /** Titular de la cuenta que debita (si el aviso lo trae). */
  titular?: string | null;
  /** Teléfono del chat de WhatsApp que mandó el comprobante (si la transferencia llegó por ahí). */
  telefonoChat?: string | null;
  banco?: string | null;
}

/** Un comprobante que llegó por WhatsApp (wa_mensajes) con lo que se leyó de la imagen. */
export interface ComprobanteChat {
  /** Hora en que llegó el mensaje (ISO). */
  en: string;
  /** Celular del chat que lo mandó (solo para comparar). */
  telefono?: string | null;
  /** Lo leído del comprobante (null = no se leyó). */
  monto?: number | null;
  nro_transaccion?: string | null;
  /** Otros números de operación/referencia del comprobante. */
  referencias?: string[] | null;
  titular?: string | null;
  banco?: string | null;
  /** Fecha y hora que figura en el comprobante (ISO), si se leyó. */
  fecha?: string | null;
}

export interface CandidatoPago {
  shopify_order_id: number;
  /** "#1164" */
  pedido: string;
  /** Lo que espera cobrar (total o SALDO_<monto>). */
  monto_pendiente: number;
  total: number | null;
  ciudad: string | null;
  creado_en: string;
  tags: string[];
  /** Solo para comparar; nunca sale de acá. */
  telefono?: string | null;
  /** Solo para comparar; nunca sale de acá. */
  nombresCliente?: string[];
  /** Comprobantes del cliente de este pedido (llegados después de crearlo). */
  comprobantes?: ComprobanteChat[];
}

export type SenalPago = "nro" | "telefono" | "titular" | "comprobante" | "hora";

export interface CandidatoRankeado {
  candidato: CandidatoPago;
  senales: SenalPago[];
  puntaje: number;
  /** Minutos entre la transferencia y el comprobante más cercano que cuenta (null = sin comprobante en ventana). */
  distanciaMin: number | null;
}

export type ResultadoRanking =
  | { tipo: "unico"; candidato: CandidatoPago; senales: SenalPago[]; top: CandidatoRankeado[]; total: number }
  | { tipo: "ambiguo"; top: CandidatoRankeado[]; total: number }
  | { tipo: "ninguno" };

export interface OpcionesRanking {
  /** Minutos antes de la transferencia en los que un comprobante del chat cuenta (default 180). */
  comprobanteAntesMin?: number;
  /** Minutos después (el cliente a veces manda la captura un rato más tarde; default 60). */
  comprobanteDespuesMin?: number;
  /** Tolerancia entre la hora leída del comprobante y la de la transferencia (default 30). */
  horaLeidaMin?: number;
  /** Para desempatar por hora, el más cercano tiene que estar al menos esto más cerca que el segundo (default 30). */
  desempateMin?: number;
  /** Cuántos candidatos lleva el aviso (default 3). */
  maxTop?: number;
}

const ETIQUETAS_PAGADO = ["PAGADO", "PAGO_VERIFICADO", "PAGADO_QR"];
const VACIAS = new Set(["DEL", "LOS", "LAS", "SRL", "EAS", "SAE"]);
const MIN = 60_000;

/** Palabras de un nombre: sin tildes, en mayúsculas, solo letras, de 3+ letras y sin conectores. */
export function palabrasNombre(s: string | null | undefined): string[] {
  return [
    ...new Set(
      String(s ?? "").normalize("NFD").replace(/[\u0300-\u036f]/g, "").toUpperCase().replace(/[^A-Z ]/g, " ").split(/\s+/)
        .filter((w) => w.length >= 3 && !VACIAS.has(w)),
    ),
  ];
}

/** Cuántas palabras del titular aparecen en los nombres del cliente (en cualquier orden). */
export function palabrasEnComun(titular: string | null | undefined, nombres: string[]): number {
  const cliente = new Set(nombres.flatMap((n) => palabrasNombre(n)));
  return palabrasNombre(titular).filter((w) => cliente.has(w)).length;
}

/** Mismo celular de Paraguay (normalizado a +5959…). */
export function mismoTelefono(a: string | null | undefined, b: string | null | undefined): boolean {
  const x = a ? normalizarTelefonoPY(a) : null;
  const y = b ? normalizarTelefonoPY(b) : null;
  return !!x && x === y;
}

/** Nro. de transacción comparable: solo letras y números, mayúsculas, sin ceros a la izquierda. */
export function normalizarNro(s: string | null | undefined): string {
  return String(s ?? "").toUpperCase().replace(/[^A-Z0-9]/g, "").replace(/^0+/, "");
}

/** Mismo nro.: iguales, o uno termina con el otro y el más corto tiene 6+ caracteres (bancos que agregan prefijo). */
export function mismoNro(a: string | null | undefined, b: string | null | undefined): boolean {
  const x = normalizarNro(a);
  const y = normalizarNro(b);
  if (x.length < 4 || y.length < 4) return false;
  if (x === y) return true;
  const [corto, largo] = x.length <= y.length ? [x, y] : [y, x];
  return corto.length >= 6 && largo.endsWith(corto);
}

/** Rendición de un courier (Punto a Punto, Lucero del Este) que llega a la misma cuenta: nunca es de un pedido. */
export const TITULARES_COURIER = [/PUNTO\s*A\s*PUNTO/, /LUCERO\s+DEL\s+ESTE/];

export function esRendicionCourier(titular: string | null | undefined, extra: string[] = []): boolean {
  const t = String(titular ?? "").normalize("NFD").replace(/[\u0300-\u036f]/g, "").toUpperCase().replace(/[^A-Z0-9 ]/g, " ").replace(/\s+/g, " ").trim();
  if (!t) return false;
  if (TITULARES_COURIER.some((r) => r.test(t))) return true;
  return extra.some((e) => {
    const x = String(e ?? "").normalize("NFD").replace(/[\u0300-\u036f]/g, "").toUpperCase().replace(/[^A-Z0-9 ]/g, " ").replace(/\s+/g, " ").trim();
    return x.length >= 4 && t.includes(x);
  });
}

type Req = Required<OpcionesRanking>;

/** Minutos entre el comprobante y la transferencia si cae en la ventana (por hora de llegada o por la hora leída). */
function distanciaComprobante(cp: ComprobanteChat, t: TransferenciaRecibida, o: Req): number | null {
  const tt = Date.parse(t.fecha);
  const dif = (Date.parse(cp.en) - tt) / MIN; // < 0: el comprobante llegó antes
  const enVentana = Number.isFinite(dif) && dif >= -o.comprobanteAntesMin && dif <= o.comprobanteDespuesMin;
  const leida = cp.fecha ? (Date.parse(cp.fecha) - tt) / MIN : NaN;
  const porLeida = Number.isFinite(leida) && Math.abs(leida) <= o.horaLeidaMin;
  if (!enVentana && !porLeida) return null;
  return Math.min(enVentana ? Math.abs(dif) : Infinity, porLeida ? Math.abs(leida) : Infinity);
}

/** El monto leído del comprobante no contradice la transferencia (si no se leyó, no contradice). */
const montoCompatible = (cp: ComprobanteChat, monto: number) => cp.monto == null || Math.round(Number(cp.monto)) === monto;

function evaluar(c: CandidatoPago, t: TransferenciaRecibida, o: Req): CandidatoRankeado {
  const senales: SenalPago[] = [];
  let puntaje = 0;
  const monto = Math.round(t.monto);
  const comps = (c.comprobantes ?? []).filter((cp) => montoCompatible(cp, monto));
  // 1. nro. de transacción leído del comprobante (cualquier comprobante del cliente del pedido, sin ventana).
  if (t.nro_transaccion && comps.some((cp) => [cp.nro_transaccion, ...(cp.referencias ?? [])].some((n) => mismoNro(n, t.nro_transaccion)))) {
    senales.push("nro");
    puntaje += 2000;
  }
  // 2. comprobante desde el celular del pedido, en la ventana (o la transferencia llegó desde ese chat).
  let distanciaMin: number | null = null;
  let telefono = !!t.telefonoChat && mismoTelefono(t.telefonoChat, c.telefono);
  let distanciaOtro: number | null = null;
  for (const cp of comps) {
    const d = distanciaComprobante(cp, t, o);
    if (d === null) continue;
    if (mismoTelefono(cp.telefono, c.telefono)) {
      telefono = true;
      distanciaMin = distanciaMin === null ? d : Math.min(distanciaMin, d);
    } else distanciaOtro = distanciaOtro === null ? d : Math.min(distanciaOtro, d);
  }
  if (telefono) {
    senales.push("telefono");
    puntaje += 1000 - Math.min(distanciaMin ?? 0, 240);
  } else if (distanciaOtro !== null) {
    // Marcado para el pedido pero desde otro celular: ordena, no alcanza solo.
    senales.push("comprobante");
    distanciaMin = distanciaOtro;
    puntaje += 100 - Math.min(distanciaOtro, 90);
  }
  // 3. titular.
  const comunes = palabrasEnComun(t.titular, c.nombresCliente ?? []);
  if (comunes >= 2) {
    senales.push("titular");
    puntaje += 300 + comunes * 10;
  } else if (comunes === 1) puntaje += 5; // una sola palabra no alcanza, pero ordena
  const tags = c.tags.map((x) => x.toUpperCase());
  if (tags.includes("OFERTA_PAGO_ANTICIPADO")) puntaje += 2;
  // Desempate: el más reciente primero (fracción < 1 para no pisar las señales).
  const edadH = Math.max(0, (Date.parse(t.fecha) - Date.parse(c.creado_en)) / 3_600_000);
  puntaje += 1 / (1 + (Number.isFinite(edadH) ? edadH : 1e6));
  return { candidato: c, senales, puntaje, distanciaMin };
}

/** Señales que alcanzan para asociar (en este orden). "comprobante" y "hora" solo desempatan. */
export const SENALES_DECISIVAS: SenalPago[] = ["nro", "telefono", "titular"];

/**
 * Candidatos de la transferencia, ordenados. "unico" = un solo pedido con señal fuerte (se asocia como "Recibido");
 * "ambiguo" = hay pedidos con ese monto pero ninguno se destaca solo (aviso con botones); "ninguno" = nadie espera
 * ese monto.
 */
export function rankearCandidatos(t: TransferenciaRecibida, candidatos: CandidatoPago[], opciones: OpcionesRanking = {}): ResultadoRanking {
  const o: Req = { comprobanteAntesMin: 180, comprobanteDespuesMin: 60, horaLeidaMin: 30, desempateMin: 30, maxTop: 3, ...opciones };
  const monto = Math.round(t.monto);
  const exactos = candidatos.filter((c) =>
    Math.round(c.monto_pendiente) === monto && !c.tags.some((x) => ETIQUETAS_PAGADO.includes(x.toUpperCase()))
  );
  if (!exactos.length) return { tipo: "ninguno" };
  const evaluados = exactos.map((c) => evaluar(c, t, o)).sort((a, b) => b.puntaje - a.puntaje);
  const top = evaluados.slice(0, o.maxTop);
  const unico = (e: CandidatoRankeado, extra: SenalPago[] = []): ResultadoRanking =>
    ({ tipo: "unico", candidato: e.candidato, senales: [...e.senales, ...extra], top, total: exactos.length });
  let grupo = evaluados;
  let conSenal = false;
  for (const s of SENALES_DECISIVAS) {
    const con = grupo.filter((e) => e.senales.includes(s));
    if (con.length === 1) return unico(con[0]);
    if (con.length > 1) {
      grupo = con; // la señal no alcanza sola: la siguiente desempata entre estos
      conSenal = true;
    }
  }
  // 4. Varios con señal fuerte: desempata la hora, solo si el más cercano se destaca claramente.
  if (conSenal) {
    const porHora = [...grupo].sort((a, b) => (a.distanciaMin ?? Infinity) - (b.distanciaMin ?? Infinity));
    const d1 = porHora[0].distanciaMin ?? Infinity;
    const d2 = porHora[1]?.distanciaMin ?? Infinity;
    if (Number.isFinite(d1) && d2 - d1 >= o.desempateMin) return unico(porHora[0], ["hora"]);
  }
  // Los que tienen señal ya quedan arriba por puntaje.
  return { tipo: "ambiguo", top, total: exactos.length };
}

// ---------- aviso a Enrique ----------

export const ACCION_ES_ESTE = "es_este";

export type BotonesAviso = BotonTelegram[][];

/** Referencia corta del pago para el botón: el nro. de transacción (últimos 20) o la hora "t2610291530". */
export function refTransferencia(t: TransferenciaRecibida): string {
  const nro = String(t.nro_transaccion ?? "").replace(/[^A-Za-z0-9_-]/g, "");
  if (nro) return nro.slice(-20);
  const d = new Date(Date.parse(t.fecha) - 3 * 3_600_000); // hora de Paraguay (UTC−3)
  if (Number.isNaN(d.getTime())) return "sinref";
  const z = (n: number) => String(n).padStart(2, "0");
  return `t${String(d.getUTCFullYear()).slice(2)}${z(d.getUTCMonth() + 1)}${z(d.getUTCDate())}${z(d.getUTCHours())}${z(d.getUTCMinutes())}`;
}

/** es_este:<orderId>:<ref> (Telegram admite 64 bytes de callback_data). */
export function callbackEsEste(orderId: number, ref: string): string {
  const limpio = String(ref).replace(/[^A-Za-z0-9_-]/g, "").slice(0, 30) || "sinref";
  const cb = `${ACCION_ES_ESTE}:${orderId}:${limpio}`;
  return new TextEncoder().encode(cb).length <= LIMITE_CALLBACK_BYTES ? cb : cb.slice(0, LIMITE_CALLBACK_BYTES);
}

/** "hace 6 min", "hace 3 h", "hace 2 días". */
export function haceCuanto(desdeISO: string, ahora: Date): string {
  const m = Math.max(0, Math.round((ahora.getTime() - Date.parse(desdeISO)) / MIN));
  if (!Number.isFinite(m)) return "";
  if (m < 60) return `hace ${m} min`;
  const h = Math.round(m / 60);
  if (h < 48) return `hace ${h} h`;
  return `hace ${Math.round(h / 24)} días`;
}

const SENAL_TEXTO: Record<SenalPago, string> = {
  nro: "nro. de transacción del comprobante coincide",
  telefono: "mandó comprobante desde el celular del pedido",
  titular: "titular coincide",
  comprobante: "comprobante marcado para el pedido (otro celular)",
  hora: "comprobante más cerca de la hora",
};

/** Aviso HTML (escapado) para Telegram cuando la transferencia es ambigua: los más probables con "Es este". */
export function avisoCandidatos(
  t: TransferenciaRecibida,
  r: { top: CandidatoRankeado[]; total: number },
  ahora: Date,
): { texto: string; botones: BotonTelegram[][] } {
  const ref = refTransferencia(t);
  const tx = t.nro_transaccion ? `tx …${escaparHtml(String(t.nro_transaccion).slice(-3))}` : "sin nro. de transacción";
  const banco = t.banco ? `, ${escaparHtml(t.banco)}` : "";
  const cab = `💸 Transferencia de Gs ${formatearGuaranies(t.monto).replace("₲", "")} (${horaCortaAsuncion(new Date(t.fecha))}, ${tx}${banco}) sin pedido claro: ` +
    `${r.total === 1 ? "hay 1 pedido" : `hay ${r.total} pedidos`} esperando ese monto.`;
  const lineas = [cab, r.top.length > 1 ? `Los ${r.top.length} más probables:` : "El más probable:"];
  r.top.forEach((e, i) => {
    const c = e.candidato;
    const partes = [
      `<b>${escaparHtml(c.pedido)}</b>`,
      `Gs ${formatearGuaranies(c.total ?? c.monto_pendiente).replace("₲", "")}`,
      c.ciudad ? escaparHtml(c.ciudad) : "sin ciudad",
      haceCuanto(c.creado_en, ahora),
      ...e.senales.map((s) => SENAL_TEXTO[s]),
    ].filter(Boolean);
    lineas.push(`${i + 1}. ${partes.join(" · ")}`);
  });
  lineas.push("Verificalo en el banco y tocá el que corresponda (hace lo mismo que Recibido).");
  const botones: BotonTelegram[][] = r.top.map((e) => [{ texto: `Es este: ${e.candidato.pedido}`, callback: callbackEsEste(e.candidato.shopify_order_id, ref) }]);
  return { texto: lineas.join("\n"), botones };
}

/** Aviso HTML cuando nadie espera ese monto (para que Enrique lo revise en el banco). */
export function avisoSinCandidatos(t: TransferenciaRecibida): string {
  const tx = t.nro_transaccion ? `tx …${escaparHtml(String(t.nro_transaccion).slice(-3))}` : "sin nro. de transacción";
  const banco = t.banco ? `, ${escaparHtml(t.banco)}` : "";
  return `💸 Transferencia de Gs ${formatearGuaranies(t.monto).replace("₲", "")} (${horaCortaAsuncion(new Date(t.fecha))}, ${tx}${banco}) ` +
    "sin pedido que espere ese monto: revisala.";
}
