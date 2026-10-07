// mejora-mensual/proponer.ts · Dueño: M2 (ciclo mensual de mejora del vendedor)
//
// Convierte las sugerencias de los hallazgos en cambios concretos y versionados sobre la versión activa
// del vendedor (prompt, ejemplos, FAQ, orden de objeciones). Lógica pura.
//
// Riesgo (exacto del contrato, `mejora_cambios.tipo`):
//   bajo              → ejemplo, orden_objeciones, faq, prompt_tono  (entran en la versión propuesta)
//   requiere_decision → precio, afirmacion, palabra_prohibida, politica_reclamos, derivacion
//                       (se listan para Enrique y NO entran en la versión a aplicar)
// Además el contenido manda sobre el tipo declarado:
//   - un monto en el texto ⇒ tipo "precio" (requiere_decision): los precios salen de Shopify;
//   - compensar, reponer o reenviar (pasos 3-5 de la escalera) ⇒ "politica_reclamos";
//   - una palabra prohibida o una promesa de salud ⇒ el cambio se descarta (nunca se agrega).
// Dato débil (n < 10) ⇒ ninguna propuesta por esa conclusión.

import {
  contarLineas,
  contarPreguntas,
  extraerPrecios,
  palabrasProhibidas,
  PROHIBIDAS_POR_DEFECTO,
  promesasSalud,
} from "../auditoria-diaria/reglas.ts";
import { armarPlantillaVersion } from "../_shared/vendedor/version_activa.ts";
import { type Conclusion, type HallazgosSintesis, MIN_CASOS_DEFAULT } from "./sintetizar.ts";
import { type Cambio, type Riesgo, TIPOS_REQUIEREN_DECISION, type TipoCambio, type VersionBorrador } from "./tipos.ts";

// ------------------------------------------------------------------ tipos

export type EjemploVersion = { cliente: string; vendedor: string };
export type FaqVersion = { pregunta: string; respuesta: string };

/** Fila de `vendedor_versiones` (contrato). `objeciones` = claves en orden de prioridad. */
export type VersionVendedor = {
  id?: string;
  numero: number;
  estado: "activa" | "propuesta" | "descartada" | "archivada";
  prompt: string;
  ejemplos: EjemploVersion[];
  faq: FaqVersion[];
  objeciones: string[];
  origen: "semilla" | "mejora_mensual" | "manual";
  ciclo_id?: string | null;
  notas?: string | null;
};

export type { Riesgo };

/** Fila de `mejora_cambios` (sin id/ciclo/version, que pone M3 al guardar). */
export type CambioPropuesto = Cambio & {
  /** Lo marca M3 cuando Enrique aplica la versión. Siempre false acá. */
  aplicado: false;
  /** true solo para riesgo bajo: está dentro de la versión propuesta. */
  incluido_en_version: boolean;
  conclusion_id: string;
};

export type Descartado = { conclusion_id: string; motivo: string; detalle: string };

export type Propuesta = {
  /** null si no hay ningún cambio de riesgo bajo: no hay nada que probar ni aplicar. */
  version: VersionVendedor | null;
  cambios: CambioPropuesto[];
  descartados: Descartado[];
};

/** Riesgo por tipo: los de TIPOS_REQUIEREN_DECISION (tipos.ts) nunca se aplican solos; el resto es bajo. */
export function riesgoDeTipo(t: TipoCambio): Riesgo {
  return TIPOS_REQUIEREN_DECISION.includes(t) ? "requiere_decision" : "bajo";
}

export const MAX_EJEMPLOS = 12;
export const MAX_FAQ = 20;
export const MAX_AJUSTES = 8;
export const TITULO_AJUSTES = "AJUSTES DE LA MEJORA MENSUAL";

/** Señales de pasos 3-5 de la escalera (reponer, compensar, devolver): los decide Enrique. */
const POLITICA_RECLAMOS: RegExp[] = [
  /\bcompens/u,
  /\brepon(er|emos|go|e)\b|\breposicion\b/u,
  /\breenvi/u,
  /\bsin cargo\b|\bgratis\b|\bbonific/u,
  /\bte (devolvemos|pasamos) (la plata|el monto|el dinero)/u,
  /\bcambio por otro\b|\bcambiarlo por\b/u,
  /\bdescuento\b/u,
];

function norm(s: string): string {
  return String(s ?? "").normalize("NFD").replace(/\p{M}/gu, "").toLowerCase();
}

/** Todos los textos de un valor (profundo). */
export function textos(v: unknown): string[] {
  if (typeof v === "string") return [v];
  if (Array.isArray(v)) return v.flatMap(textos);
  if (v && typeof v === "object") return Object.values(v).flatMap(textos);
  return [];
}

// ------------------------------------------------------------------ prompt de una versión

/** Agrega una línea a la sección de ajustes del prompt (la crea si no existe; guarda las últimas 8). */
export function agregarAjuste(prompt: string, linea: string): string {
  const l = linea.replace(/\s+/g, " ").trim();
  const marca = `\n${TITULO_AJUSTES}\n`;
  const i = prompt.indexOf(marca);
  if (i < 0) return `${prompt.trimEnd()}\n${marca}- ${l}\n`;
  const antes = prompt.slice(0, i);
  const resto = prompt.slice(i + marca.length);
  const lineas = resto.split("\n").filter((x) => x.startsWith("- ")).map((x) => x.slice(2));
  const fin = resto.split("\n").filter((x) => x.trim() && !x.startsWith("- ")).join("\n");
  const nuevas = [...lineas.filter((x) => x !== l), l].slice(-MAX_AJUSTES);
  return `${antes.trimEnd()}\n${marca}${nuevas.map((x) => `- ${x}`).join("\n")}\n${fin ? fin + "\n" : ""}`;
}

export function ajustesDe(prompt: string): string[] {
  const marca = `\n${TITULO_AJUSTES}\n`;
  const i = prompt.indexOf(marca);
  if (i < 0) return [];
  return prompt.slice(i + marca.length).split("\n").filter((x) => x.startsWith("- ")).map((x) => x.slice(2));
}

/**
 * Plantilla completa que usa el vendedor con esta versión: prompt + ejemplos + FAQ + orden de objeciones.
 * Se inyecta como `config_wa.vendedor_prompt` (mismas llaves que _shared/vendedor/prompt.ts). Es la misma
 * función que usa el vendedor en producción con la versión activa (_shared/vendedor/version_activa.ts).
 */
export function armarPromptVersion(v: VersionVendedor): string {
  return armarPlantillaVersion(v);
}

// ------------------------------------------------------------------ revisión de contenido

export type RevisionContenido = { prohibidas: string[]; precios: number[]; salud: string[] };

export function revisarTextos(lista: string[], prohibidas: string[] = PROHIBIDAS_POR_DEFECTO): RevisionContenido {
  const r: RevisionContenido = { prohibidas: [], precios: [], salud: [] };
  for (const t of lista) {
    r.prohibidas.push(...palabrasProhibidas(t, prohibidas));
    r.precios.push(...extraerPrecios(t));
    r.salud.push(...promesasSalud(t));
  }
  return r;
}

/**
 * Contenido que la versión agrega respecto de la base (ejemplos, FAQ, objeciones, ajustes del prompt).
 * El prompt base no se revisa: su sección PROHIBIDO nombra las palabras a propósito.
 */
export function contenidoNuevo(v: VersionVendedor, base?: VersionVendedor | null): string[] {
  const viejos = new Set(base ? [...textos(base.ejemplos), ...textos(base.faq), ...base.objeciones, ...ajustesDe(base.prompt)] : []);
  return [...textos(v.ejemplos), ...textos(v.faq), ...v.objeciones, ...ajustesDe(v.prompt)].filter((t) => !viejos.has(t));
}

// ------------------------------------------------------------------ clasificación

export function clasificar(c: Conclusion, prohibidas: string[]): { tipo: TipoCambio; riesgo: Riesgo } | { descartar: string; detalle: string } {
  const s = c.sugerencia!;
  const todo = textos(s.contenido);
  if (s.tipo === "palabra_prohibida") return { tipo: "palabra_prohibida", riesgo: "requiere_decision" };
  const rev = revisarTextos(todo, prohibidas);
  if (rev.prohibidas.length) return { descartar: "palabra_prohibida", detalle: rev.prohibidas.join(", ") };
  if (rev.salud.length) return { descartar: "promesa_salud", detalle: rev.salud.join(", ") };
  if (rev.precios.length || s.tipo === "precio") return { tipo: "precio", riesgo: "requiere_decision" };
  const n = norm(todo.join("\n"));
  if (s.tipo === "politica_reclamos" || POLITICA_RECLAMOS.some((re) => re.test(n))) {
    return { tipo: "politica_reclamos", riesgo: "requiere_decision" };
  }
  return { tipo: s.tipo, riesgo: riesgoDeTipo(s.tipo) };
}

function str(v: unknown, max: number): string {
  return typeof v === "string" ? v.replace(/[ \t]+/g, " ").trim().slice(0, max) : "";
}

// ------------------------------------------------------------------ proponer

export type OpcionesProponer = { prohibidas?: string[]; minCasos?: number };

export function proponer(h: HallazgosSintesis, activa: VersionVendedor | null, o: OpcionesProponer = {}): Propuesta {
  // Sin versión activa no hay prompt sobre el cual proponer (la semilla la carga la integración).
  if (!activa || !activa.prompt.trim()) return { version: null, cambios: [], descartados: [{ conclusion_id: "*", motivo: "sin_version_activa", detalle: "" }] };
  const prohibidas = o.prohibidas ?? PROHIBIDAS_POR_DEFECTO;
  const min = o.minCasos ?? MIN_CASOS_DEFAULT;
  const v: VersionVendedor = {
    numero: activa.numero + 1,
    estado: "propuesta",
    prompt: activa.prompt,
    ejemplos: activa.ejemplos.map((e) => ({ ...e })),
    faq: activa.faq.map((f) => ({ ...f })),
    objeciones: [...activa.objeciones],
    origen: "mejora_mensual",
    ciclo_id: null,
    notas: null,
  };
  const cambios: CambioPropuesto[] = [];
  const descartados: Descartado[] = [];
  const descartar = (c: Conclusion, motivo: string, detalle: string) => descartados.push({ conclusion_id: c.id, motivo, detalle });

  if (h.sin_datos_suficientes) return { version: null, cambios, descartados };

  for (const c of h.analisis) {
    if (!c.sugerencia) continue;
    if (c.dato_debil || c.n < min) {
      descartar(c, "dato_debil", `${c.dimension}:${c.clave} n=${c.n}`);
      continue;
    }
    const cl = clasificar(c, prohibidas);
    if ("descartar" in cl) {
      descartar(c, cl.descartar, cl.detalle);
      continue;
    }
    const s = c.sugerencia;
    const motivo = `${c.texto} (n=${c.n}, entrega ${c.tasa_entrega === null ? "s/d" : Math.round(c.tasa_entrega * 100) + " %"}). ${s.detalle}`.trim();
    if (cl.riesgo === "requiere_decision") {
      cambios.push({ tipo: cl.tipo, riesgo: cl.riesgo, antes: null, despues: s.contenido, motivo, aplicado: false, incluido_en_version: false, conclusion_id: c.id });
      continue;
    }
    // Riesgo bajo: se aplica al borrador.
    const k = s.contenido;
    if (cl.tipo === "ejemplo") {
      const e = { cliente: str(k.cliente, 300), vendedor: str(k.vendedor, 400) };
      if (!e.cliente || !e.vendedor || contarLineas(e.vendedor) > 3 || contarPreguntas(e.vendedor) > 1) {
        descartar(c, "formato", "ejemplo incompleto o fuera de estilo (más de 3 líneas o más de 1 pregunta)");
        continue;
      }
      if (v.ejemplos.some((x) => x.cliente === e.cliente && x.vendedor === e.vendedor)) {
        descartar(c, "repetido", e.cliente);
        continue;
      }
      const antes = v.ejemplos.length >= MAX_EJEMPLOS ? v.ejemplos[0] : null;
      v.ejemplos = [...v.ejemplos, e].slice(-MAX_EJEMPLOS);
      cambios.push({ tipo: "ejemplo", riesgo: "bajo", antes, despues: e, motivo, aplicado: false, incluido_en_version: true, conclusion_id: c.id });
    } else if (cl.tipo === "faq") {
      const f = { pregunta: str(k.pregunta, 200), respuesta: str(k.respuesta, 400) };
      if (!f.pregunta || !f.respuesta || contarLineas(f.respuesta) > 3 || contarPreguntas(f.respuesta) > 1) {
        descartar(c, "formato", "FAQ incompleta o fuera de estilo");
        continue;
      }
      const i = v.faq.findIndex((x) => norm(x.pregunta) === norm(f.pregunta));
      const antes = i >= 0 ? v.faq[i] : null;
      if (i >= 0) v.faq[i] = f;
      else v.faq = [...v.faq, f].slice(-MAX_FAQ);
      cambios.push({ tipo: "faq", riesgo: "bajo", antes, despues: f, motivo, aplicado: false, incluido_en_version: true, conclusion_id: c.id });
    } else if (cl.tipo === "orden_objeciones") {
      const pedido = Array.isArray(k.orden) ? k.orden.map((x) => str(x, 80)).filter(Boolean) : [];
      if (pedido.length < 2) {
        descartar(c, "formato", "orden de objeciones con menos de 2 claves");
        continue;
      }
      const antes = [...v.objeciones];
      const nuevo = [...new Set([...pedido, ...v.objeciones])];
      if (nuevo.join("|") === antes.join("|")) {
        descartar(c, "sin_cambio", "el orden ya es ese");
        continue;
      }
      v.objeciones = nuevo;
      cambios.push({ tipo: "orden_objeciones", riesgo: "bajo", antes, despues: nuevo, motivo, aplicado: false, incluido_en_version: true, conclusion_id: c.id });
    } else if (cl.tipo === "prompt_tono") {
      const linea = str(k.linea, 200);
      if (!linea || linea.includes("\n") || /[{}]/.test(linea)) {
        descartar(c, "formato", "línea de tono vacía, de varias líneas o con llaves");
        continue;
      }
      const antes = ajustesDe(v.prompt);
      v.prompt = agregarAjuste(v.prompt, linea);
      cambios.push({ tipo: "prompt_tono", riesgo: "bajo", antes, despues: ajustesDe(v.prompt), motivo, aplicado: false, incluido_en_version: true, conclusion_id: c.id });
    }
  }

  // Red final: el contenido nuevo de la versión no puede traer prohibidas, montos ni promesas de salud.
  const rev = revisarTextos(contenidoNuevo(v, activa), prohibidas);
  const conVersion = cambios.some((x) => x.incluido_en_version);
  if (rev.prohibidas.length || rev.precios.length || rev.salud.length) {
    for (const x of cambios) x.incluido_en_version = false;
    descartados.push({ conclusion_id: "*", motivo: "version_insegura", detalle: JSON.stringify(rev) });
    return { version: null, cambios: cambios.filter((x) => x.riesgo === "requiere_decision"), descartados };
  }
  if (!conVersion) return { version: null, cambios, descartados };
  v.notas = `Mejora mensual: ${cambios.filter((x) => x.incluido_en_version).length} cambio(s) de riesgo bajo; ` +
    `${cambios.filter((x) => x.riesgo === "requiere_decision").length} para decidir (no incluidos).`;
  return { version: v, cambios, descartados };
}

// Chequeo de compatibilidad con tipos.ts (M1): una VersionVendedor sirve donde se pide VersionBorrador.
const _compat: (v: VersionVendedor) => VersionBorrador = (v) => ({ ...v, notas: v.notas ?? null });
void _compat;

/** Lleva una fila de vendedor_versiones (jsonb sin tipo) a VersionVendedor, descartando lo que no tiene forma. */
export function normalizarVersion(f: Record<string, unknown>): VersionVendedor {
  const arr = (v: unknown) => (Array.isArray(v) ? v : []);
  const s = (v: unknown) => (typeof v === "string" ? v : "");
  return {
    id: typeof f.id === "string" ? f.id : undefined,
    numero: typeof f.numero === "number" ? f.numero : 0,
    estado: (["activa", "propuesta", "descartada", "archivada"].includes(String(f.estado)) ? f.estado : "activa") as VersionVendedor["estado"],
    prompt: s(f.prompt),
    ejemplos: arr(f.ejemplos).filter((e) => e && typeof e === "object").map((e) => ({ cliente: s((e as Record<string, unknown>).cliente), vendedor: s((e as Record<string, unknown>).vendedor) })).filter((e) => e.cliente && e.vendedor),
    faq: arr(f.faq).filter((e) => e && typeof e === "object").map((e) => ({ pregunta: s((e as Record<string, unknown>).pregunta), respuesta: s((e as Record<string, unknown>).respuesta) })).filter((e) => e.pregunta && e.respuesta),
    objeciones: arr(f.objeciones).map((x) => (typeof x === "string" ? x : s((x as Record<string, unknown>)?.clave))).filter(Boolean),
    origen: (["semilla", "mejora_mensual", "manual"].includes(String(f.origen)) ? f.origen : "manual") as VersionVendedor["origen"],
    ciclo_id: typeof f.ciclo_id === "string" ? f.ciclo_id : null,
    notas: typeof f.notas === "string" ? f.notas : null,
  };
}
