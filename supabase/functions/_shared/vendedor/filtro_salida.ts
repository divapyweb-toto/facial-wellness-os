// _shared/vendedor/filtro_salida.ts · Dueño: G1 (ola 2)
// Regla dura del servidor sobre TODO texto que el vendedor con IA le va a mandar al cliente.
// No depende del modelo: si falla, el orquestador regenera una vez y, si vuelve a fallar, deriva a Enrique.
//
// Revisa: palabras prohibidas (config_wa.palabras_prohibidas), precios que no salieron del catálogo
// de ESTA conversación, promesas de salud, más de 3 líneas, más de 1 pregunta, más de 1 emoji.
import { contienePalabraProhibida } from "../filtro.ts";

export type OpcionesFiltro = {
  /** Montos en guaraníes que la herramienta devolvió en esta conversación (precios, ofertas, envío, totales). */
  catalogo: number[];
  /** config_wa.palabras_prohibidas */
  prohibidas: string[];
  /** Afirmaciones permitidas (se usan para no marcar como promesa de salud una frase permitida). */
  afirmaciones?: string[];
  /** Frases que cuentan como promesa de salud (config_wa.vendedor_promesas_salud). */
  promesasSalud?: string[];
  maxLineas?: number;
  maxPreguntas?: number;
  maxEmojis?: number;
  maxCaracteres?: number;
};

export type ResultadoFiltro = { ok: boolean; motivos: string[] };

/** Si config_wa no trae la lista, se usa esta (se reporta en el log quien la usa). */
export const PROMESAS_SALUD_DEFAULT = [
  "dejás de roncar", "dejas de roncar", "deja de roncar", "dejar de roncar",
  "elimina el ronquido", "elimina los ronquidos", "eliminá el ronquido", "adiós al ronquido", "chau ronquido",
  "más oxígeno", "mas oxigeno", "oxigena",
  "resultados garantizados", "100% efectivo", "100 % efectivo", "efectividad comprobada", "clínicamente comprobado",
  "sin efectos secundarios", "mejora tu salud", "mejora la salud", "sana ", "sanar", "previene enfermedades",
  "recomendado por médicos", "aprobado por médicos", "te soluciona la apnea", "para la apnea", "quita la apnea",
];

function normalizar(s: string): string {
  return s.normalize("NFD").replace(/\p{M}/gu, "").toLowerCase();
}

// ---------- precios ----------

/**
 * Encuentra montos en guaraníes dentro de un texto. Cuenta como precio:
 *  - números con separador de miles: 79.000 · 125,000 · 1.250.000 · 79 000
 *  - números con marca de moneda: Gs 79000, ₲79000, 79000 gs, 79000 guaraníes
 *  - "79 mil", "79mil", "125k"
 *  - números sueltos de 5 a 7 cifras (79000, 125000) que no son parte de un teléfono, pedido (#1001) ni fecha
 * No cuenta: años sueltos de 4 cifras sin moneda (2026), cantidades (x2, 30 unidades), horas (15:30), fechas (6/10).
 */
export function extraerMontos(texto: string): number[] {
  const t = normalizar(texto);
  const montos: number[] = [];
  const usados: Array<[number, number]> = [];
  const marcar = (i: number, f: number) => usados.push([i, f]);
  const libre = (i: number, f: number) => !usados.some(([a, b]) => i < b && f > a);

  // "79 mil", "1,5 millones" no se usa; "125k"
  for (const m of t.matchAll(/(\d{1,4}(?:[.,]\d{1,3})?)\s*(mil\b|k\b)/g)) {
    const base = Number(m[1].replace(",", "."));
    if (Number.isFinite(base)) {
      montos.push(Math.round(base * 1000));
      marcar(m.index!, m.index! + m[0].length);
    }
  }
  // Con separador de miles (punto o coma).
  for (const m of t.matchAll(/(?<![\d#/:+])(\d{1,3}(?:[.,]\d{3})+)(?![\d/:])/g)) {
    if (!libre(m.index!, m.index! + m[0].length)) continue;
    const n = Number(m[1].replace(/[.,]/g, ""));
    if (m[1].startsWith("0")) continue;
    montos.push(n);
    marcar(m.index!, m.index! + m[0].length);
  }
  // Con marca de moneda delante o detrás (incluye 4 cifras: "Gs 5000").
  for (const m of t.matchAll(/(?:gs\.?|g\$|₲|pyg)\s*(\d{3,9})(?!\d)|(?<![\d#/:+])(\d{3,9})\s*(?:gs\b|guaranies\b|₲)/g)) {
    const i = m.index!, f = i + m[0].length;
    if (!libre(i, f)) continue;
    montos.push(Number(m[1] ?? m[2]));
    marcar(i, f);
  }
  // Sueltos de 5 a 7 cifras que no arrancan con 0 (los teléfonos paraguayos arrancan con 0 o 595 y tienen 9+ cifras).
  for (const m of t.matchAll(/(?<![\d#/:+.,])([1-9]\d{4,6})(?![\d/:.,])/g)) {
    const i = m.index!, f = i + m[0].length;
    if (!libre(i, f)) continue;
    montos.push(Number(m[1]));
    marcar(i, f);
  }
  return montos.filter((n) => Number.isFinite(n) && n >= 1000);
}

/** Junta todos los montos (≥ 1000) que aparecen en un resultado de herramienta (JSON o texto). */
export function montosDeResultado(resultado: unknown): number[] {
  const out: number[] = [];
  const visitar = (x: unknown) => {
    if (typeof x === "number" && Number.isFinite(x) && x >= 1000) out.push(Math.round(x));
    else if (typeof x === "string") out.push(...extraerMontos(x));
    else if (Array.isArray(x)) x.forEach(visitar);
    else if (x && typeof x === "object") Object.values(x as Record<string, unknown>).forEach(visitar);
  };
  visitar(resultado);
  return [...new Set(out)];
}

// ---------- emojis, líneas, preguntas ----------

export function contarEmojis(texto: string): number {
  // Extended_Pictographic cubre los emojis; se ignoran ©®™ y los dígitos.
  const m = texto.match(/\p{Extended_Pictographic}/gu) ?? [];
  return m.filter((c) => !/[©®™]/.test(c)).length;
}

export function contarLineas(texto: string): number {
  return texto.split(/\n/).map((l) => l.trim()).filter(Boolean).length;
}

export function contarPreguntas(texto: string): number {
  // Cada "?" cierra una pregunta; "¿" sin cierre también cuenta.
  const cierres = (texto.match(/\?/g) ?? []).length;
  const aperturas = (texto.match(/¿/g) ?? []).length;
  return Math.max(cierres, aperturas);
}

// ---------- revisión ----------

export function revisarRespuesta(texto: string, op: OpcionesFiltro): ResultadoFiltro {
  const motivos: string[] = [];
  const t = (texto ?? "").trim();
  if (!t) return { ok: false, motivos: ["respuesta_vacia"] };

  const p = contienePalabraProhibida(t, op.prohibidas ?? []);
  if (p) motivos.push(`palabra_prohibida:${p}`);

  const permitidos = new Set((op.catalogo ?? []).map((n) => Math.round(n)));
  const inventados = [...new Set(extraerMontos(t))].filter((n) => !permitidos.has(n));
  if (inventados.length) motivos.push(`precio_no_catalogo:${inventados.join(",")}`);

  // Promesas de salud: una afirmación permitida textual no se marca.
  let paraSalud = normalizar(t);
  for (const a of op.afirmaciones ?? []) {
    const na = normalizar(a).trim();
    if (na) paraSalud = paraSalud.split(na).join(" ");
  }
  const salud = contienePalabraProhibida(paraSalud, op.promesasSalud ?? PROMESAS_SALUD_DEFAULT);
  if (salud) motivos.push(`promesa_salud:${salud.trim()}`);

  const lineas = contarLineas(t);
  if (lineas > (op.maxLineas ?? 3)) motivos.push(`mas_de_${op.maxLineas ?? 3}_lineas:${lineas}`);
  const preguntas = contarPreguntas(t);
  if (preguntas > (op.maxPreguntas ?? 1)) motivos.push(`mas_de_${op.maxPreguntas ?? 1}_pregunta:${preguntas}`);
  const emojis = contarEmojis(t);
  if (emojis > (op.maxEmojis ?? 1)) motivos.push(`mas_de_${op.maxEmojis ?? 1}_emoji:${emojis}`);
  if (op.maxCaracteres && t.length > op.maxCaracteres) motivos.push(`mas_de_${op.maxCaracteres}_caracteres:${t.length}`);

  return { ok: motivos.length === 0, motivos };
}
