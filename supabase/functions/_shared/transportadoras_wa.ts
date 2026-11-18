// 18-11 · Modo transportadora (WhatsApp API Voltra 3, pedido de administración). Lógica pura, sin I/O.
// Los números de las transportadoras (Lucero del Este, Punto a Punto) viven en config_wa.transportadoras (editable,
// nunca en el repo). Para esos números: el vendedor IA nunca responde, no hay seguimientos ni marketing, el chat queda
// en 'humano' (asignado_a 'transportadora') y lo que escriben lo atiende administración (reportes/transportadoras).
// config_wa.transportadoras = { activo, numeros: [{ telefono, nombre, empresa }], aviso_telegram_horas, aviso_desde, aviso_hasta }
// activo = false (o sin la fila) = todo como antes.
import { normalizarTelefonoPY } from "./telefono.ts";

export type Transportadora = { telefono: string; nombre: string; empresa: string; /** recibe los avisos automáticos (default sí) */ avisos: boolean };
export type CfgTransportadoras = {
  activo: boolean;
  numeros: Transportadora[];
  /** Telegram a Enrique si un mensaje sigue sin respuesta estas horas (0 = nunca). */
  aviso_telegram_horas: number;
  /** Franja (hora de Asunción) en la que puede salir ese Telegram. */
  aviso_desde: number;
  aviso_hasta: number;
  /** El bot responde lo que puede resolver con la base (reglas + Haiku). false = solo se guarda (como el 18-11). */
  agente_activo: boolean;
  /** Teléfono al que se deriva todo tema de plata o tarifas. Vive SOLO en la base (personal de Enrique). */
  contacto_plata: string | null;
  /** Llamadas de IA por número y por día (Paraguay). */
  tope_ia_dia: number;
  /** Mensajes automáticos (avisos + respuestas) por número y por día. */
  tope_envios_dia: number;
};

export const CFG_TRANSPORTADORAS_DEFAULT: CfgTransportadoras = {
  activo: false,
  numeros: [],
  aviso_telegram_horas: 2,
  aviso_desde: 7,
  aviso_hasta: 22,
  agente_activo: false,
  contacto_plata: null,
  tope_ia_dia: 15,
  tope_envios_dia: 40,
};

const esObj = (v: unknown): v is Record<string, unknown> => !!v && typeof v === "object" && !Array.isArray(v);
const num = (v: unknown, d: number) => (typeof v === "number" && Number.isFinite(v) && v >= 0 ? v : d);

/** config_wa.transportadoras → config completa. Cualquier cosa rara = apagado (como antes). */
export function leerCfgTransportadoras(valor: unknown): CfgTransportadoras {
  if (!esObj(valor)) return CFG_TRANSPORTADORAS_DEFAULT;
  const numeros: Transportadora[] = [];
  for (const n of Array.isArray(valor.numeros) ? valor.numeros : []) {
    if (!esObj(n)) continue;
    const tel = normalizarTelefonoPY(String(n.telefono ?? ""));
    if (!tel) continue;
    numeros.push({ telefono: tel, nombre: String(n.nombre ?? "").trim() || tel, empresa: String(n.empresa ?? "").trim(), avisos: n.avisos !== false });
  }
  const d = CFG_TRANSPORTADORAS_DEFAULT;
  return {
    activo: valor.activo === true,
    numeros,
    aviso_telegram_horas: num(valor.aviso_telegram_horas, d.aviso_telegram_horas),
    aviso_desde: num(valor.aviso_desde, d.aviso_desde),
    aviso_hasta: num(valor.aviso_hasta, d.aviso_hasta),
    agente_activo: valor.agente_activo === true,
    contacto_plata: typeof valor.contacto_plata === "string" && valor.contacto_plata.trim() ? valor.contacto_plata.trim() : null,
    tope_ia_dia: num(valor.tope_ia_dia, d.tope_ia_dia),
    tope_envios_dia: num(valor.tope_envios_dia, d.tope_envios_dia),
  };
}

/** La transportadora de ese teléfono (cualquier formato PY), o null. Con el modo apagado, siempre null. */
export function transportadoraDe(valor: unknown, telefono: string | null | undefined): Transportadora | null {
  const cfg = leerCfgTransportadoras(valor);
  if (!cfg.activo || !telefono) return null;
  const tel = normalizarTelefonoPY(telefono);
  if (!tel) return null;
  return cfg.numeros.find((n) => n.telefono === tel) ?? null;
}

/** Teléfonos (E.164) de las transportadoras; vacío con el modo apagado. */
export function telefonosTransportadoras(valor: unknown): Set<string> {
  const cfg = leerCfgTransportadoras(valor);
  return new Set(cfg.activo ? cfg.numeros.map((n) => n.telefono) : []);
}

export type MensajeChat = { direccion: "in" | "out"; estado?: string | null; creado_en: string; wa_message_id?: string | null; texto?: string | null; tipo?: string | null };

/**
 * Mensajes de la transportadora todavía sin respuesta: los entrantes posteriores al último saliente que salió (no
 * fallido) y a la última marca "visto" de administración. Devuelve del más viejo al más nuevo.
 */
export function pendientesDe(mensajes: MensajeChat[], vistoEn: string | null = null): MensajeChat[] {
  const t = (s: string) => Date.parse(s);
  let corte = vistoEn ? t(vistoEn) : -Infinity;
  for (const m of mensajes) if (m.direccion === "out" && m.estado !== "fallido" && t(m.creado_en) > corte) corte = t(m.creado_en);
  return mensajes.filter((m) => m.direccion === "in" && t(m.creado_en) > corte).sort((a, b) => t(a.creado_en) - t(b.creado_en));
}

/** ¿Corresponde el Telegram a Enrique? El más viejo sin responder supera las horas y estamos en la franja. */
export function debeAvisar(cfg: CfgTransportadoras, pendientes: MensajeChat[], ahora: Date, horaAsuncion: number): boolean {
  if (!cfg.activo || cfg.aviso_telegram_horas <= 0 || !pendientes.length) return false;
  if (horaAsuncion < cfg.aviso_desde || horaAsuncion >= cfg.aviso_hasta) return false;
  return ahora.getTime() - Date.parse(pendientes[0].creado_en) >= cfg.aviso_telegram_horas * 3_600_000;
}

/** Ventana de 24 h: abierta si el último entrante de la transportadora fue hace menos de 24 h. */
export function ventanaAbierta(mensajes: MensajeChat[], ahora: Date): boolean {
  const ultimoIn = mensajes.filter((m) => m.direccion === "in").map((m) => Date.parse(m.creado_en)).sort((a, b) => b - a)[0];
  return Number.isFinite(ultimoIn) && ahora.getTime() - ultimoIn < 24 * 3_600_000;
}

/** "lucero" | "pap" según el nombre de la empresa (el mismo par que casos_courier). */
export function courierDe(t: Pick<Transportadora, "empresa" | "nombre">): "lucero" | "pap" | null {
  const x = `${t.empresa} ${t.nombre}`.toLowerCase();
  if (/lucero/.test(x)) return "lucero";
  if (/punto a punto|\bpap\b/.test(x)) return "pap";
  return null;
}
