// _shared/telegram_politica.ts · 27-10: a quién va cada aviso (regla de Enrique: "por Telegram a mí se me escriba lo menos posible").
// Puro, sin red ni base: lo usa telegram.ts y se prueba solo.
//
// Contrato: avisar(texto, botones?, { tipo, destino, pedido?, unaVezPorDia?, clave? }).
// La política vive en config.telegram_politica:
//   "todos"                                   → todo por Telegram, como antes del 27-10 (vuelta atrás).
//   { enrique: [...], resumen: [...], descartar: [...] }
//     enrique   → Telegram inmediato
//     resumen   → cola avisos_admin (destino 'resumen'); avisos-resumen lo manda junto 09:00 y 15:00 PY
//     descartar → no sale ni se guarda
//   Un tipo que no figura en ninguna lista sigue el destino del código ('enrique' → Telegram, 'admin' → avisos_admin).
// Sin opciones (código viejo) → Telegram, igual que siempre.

export type DestinoAviso = "enrique" | "admin";

export interface OpcionesAviso {
  /** snake_case estable, uno por aviso (ver TIPOS_AVISO). */
  tipo: string;
  /** Destino por defecto del código, si la política no lo nombra. */
  destino: DestinoAviso;
  /** '#1135' o 'VT-1135', si el aviso es de un pedido. */
  pedido?: string | null;
  /** Errores: si ya salió ese tipo (+ clave) hoy (día de PY), no se repite. */
  unaVezPorDia?: boolean;
  /** Distingue avisos del mismo tipo para unaVezPorDia (p. ej. el pedido). */
  clave?: string | null;
}

export type RutaAviso = "telegram" | "resumen" | "admin" | "descartar";

export interface PoliticaTelegram {
  enrique: string[];
  resumen: string[];
  descartar: string[];
}

/** "todos" = como antes; null = no se pudo leer (rige el destino del código). */
export type PoliticaLeida = PoliticaTelegram | "todos" | null;

/** config.valor (texto) → política. Cualquier cosa rara → null (rige el código; nunca se pierde un aviso de Enrique). */
export function leerPolitica(valor: unknown): PoliticaLeida {
  if (valor == null) return null;
  let v: unknown = valor;
  if (typeof v === "string") {
    const t = v.trim();
    if (/^"?todos"?$/i.test(t)) return "todos";
    try { v = JSON.parse(t); } catch { return null; }
  }
  if (v === "todos") return "todos";
  if (!v || typeof v !== "object") return null;
  const o = v as Record<string, unknown>;
  const lista = (x: unknown) => Array.isArray(x) ? x.map(String) : [];
  return { enrique: lista(o.enrique), resumen: lista(o.resumen), descartar: lista(o.descartar) };
}

/** Ruta de un aviso. Orden: sin opciones → telegram; "todos" → telegram; enrique > resumen > descartar; si no, el código. */
export function decidirRuta(politica: PoliticaLeida, opts?: OpcionesAviso | null): RutaAviso {
  if (!opts?.tipo) return "telegram";
  if (politica === "todos") return "telegram";
  if (politica) {
    if (politica.enrique.includes(opts.tipo)) return "telegram";
    if (politica.resumen.includes(opts.tipo)) return "resumen";
    if (politica.descartar.includes(opts.tipo)) return "descartar";
  }
  return opts.destino === "enrique" ? "telegram" : "admin";
}

/** Inicio del día de Paraguay (UTC−3 fijo desde oct-2024) para un instante, en ISO UTC. */
export function inicioDiaPY(d: Date): string {
  const py = new Date(d.getTime() - 3 * 3600_000);
  return new Date(Date.UTC(py.getUTCFullYear(), py.getUTCMonth(), py.getUTCDate(), 3, 0, 0)).toISOString();
}
