// mejora-mensual/sintetizar.ts · Dueño: M2 (ciclo mensual de mejora del vendedor)
//
// 1) `agregar(convs)`: convierte las conversaciones YA clasificadas y anonimizadas (salida de M1) en
//    AGREGADOS: conteos y tasas de ENTREGA por objeción, por respuesta y por objeción→respuesta,
//    reclamos por paso de la escalera, casos que debieron derivarse, errores del bot, y como mucho
//    unos pocos ejemplos cortos anonimizados por grupo. Lógica pura.
// 2) `sintetizar(agregados)`: Sonnet 5.5 lee SOLO esos agregados (nunca conversaciones crudas) y
//    devuelve conclusiones con, como mucho, una sugerencia de cambio cada una. El código recalcula
//    n y tasa de cada conclusión desde los agregados (no confía en el modelo) y si n < 10 la marca
//    "dato débil" y le saca la sugerencia.
//
// La tasa SIEMPRE es contra ENTREGADO (pedido entregado y cobrado), no contra venta: una respuesta
// que "cierra" pedidos que después se rechazan en la puerta es peor, no mejor.
//
// Salida JSON: _shared/claude.ts no expone output_config.format, así que el formato se pide en el
// system y se valida acá (con un reintento). Verificado el 06-10-2026 (skill claude-api, tabla del
// 25-09-2026): claude-sonnet-5-5 USD 2 entrada / 10 salida / 0,20 lectura de caché por millón; la API
// tiene salida estructurada con output_config.format {type:"json_schema"} (si G1 la suma a
// llamarClaude, conviene usarla acá). Sonnet 5.5 no acepta prefill del asistente.
// Precios: nunca en el código; el costo real lo calcula llamarClaude con config_wa.precios_claude.

import { ErrorClaude, esModoSimulado, llamarClaude, type PedidoClaude, type RespuestaClaude, textoDe } from "../_shared/claude.ts";
import {
  type ClasificacionConResultado,
  type Etiquetas,
  type Hallazgos,
  type Resultado,
  type TasaPorClave,
  TIPOS_CAMBIO,
  type TipoCambio,
} from "./tipos.ts";

// ------------------------------------------------------------------ tipos

/** Etiquetas del contrato (tipos.ts de M1). Alias para no romper a quien ya lo importe. */
export type EtiquetasContrato = Etiquetas;
export type ResultadoConversacion = Resultado;

/** Lo que sintetizar necesita de cada conversación: ClasificacionConResultado de M1 (+ ejemplo opcional). */
export type ConvClasificada = Pick<ClasificacionConResultado, "conversacion_id" | "etiquetas" | "resultado"> & {
  /** De la vista conversacion_resultado: el chat terminó derivado a Enrique. */
  derivado?: boolean;
  /** Ejemplo corto YA anonimizado por M1 (anonimizar.ts). Se recorta y se revisa otra vez acá. */
  ejemplo?: { cliente?: string; vendedor?: string } | null;
};

export type Ejemplo = { cliente: string; vendedor: string };

export type Grupo = {
  n: number;
  entregados: number;
  /** entregados / (n − en_curso). null si todas siguen en curso. */
  tasa_entrega: number | null;
  en_curso: number;
  dato_debil: boolean;
  ejemplos: Ejemplo[];
};

export type Agregados = {
  /** 'YYYY-MM-01' del mes analizado ('' si no se pasó). */
  mes: string;
  n_conversaciones: number;
  min_casos: number;
  por_resultado: Record<ResultadoConversacion, number>;
  tasa_entrega_global: number | null;
  por_objecion: Record<string, Grupo>;
  por_respuesta: Record<string, Grupo>;
  /** clave "objecion → respuesta" */
  por_objecion_respuesta: Record<string, Grupo>;
  reclamos: {
    total: number;
    /** clave "1".."5" o "sin_resolver" */
    por_paso: Record<string, Grupo>;
    por_tipo: Record<string, Grupo>;
    derivados: number;
  };
  /** debio_derivar = true y el chat NO se derivó; clave = etapa */
  debio_derivar: Record<string, Grupo>;
  errores_bot: Record<string, Grupo>;
  emocion: Record<string, number>;
};

export const DIMENSIONES = [
  "por_objecion",
  "por_respuesta",
  "por_objecion_respuesta",
  "reclamos_por_paso",
  "reclamos_por_tipo",
  "debio_derivar",
  "errores_bot",
] as const;
export type Dimension = typeof DIMENSIONES[number];

export { TIPOS_CAMBIO, type TipoCambio };

export type Sugerencia = {
  tipo: TipoCambio;
  detalle: string;
  /** ejemplo: {cliente, vendedor} · faq: {pregunta, respuesta} · orden_objeciones: {orden: string[]} · prompt_tono: {linea} · resto: libre */
  contenido: Record<string, unknown>;
};

export type Conclusion = {
  id: string;
  dimension: Dimension;
  clave: string;
  texto: string;
  /** Recalculados desde los agregados, nunca tomados del modelo. */
  n: number;
  tasa_entrega: number | null;
  dato_debil: boolean;
  sugerencia: Sugerencia | null;
};

/**
 * Hallazgos del ciclo: los campos de `Hallazgos` (tipos.ts de M1; `conclusiones` = textos cortos) más el
 * análisis con sugerencias que usa proponer.ts.
 */
export type HallazgosSintesis = Hallazgos & {
  resumen: string;
  /** Conclusiones con grupo, n y tasa recalculados, y como mucho una sugerencia (null si dato débil). */
  analisis: Conclusion[];
  /** Conclusiones que el modelo devolvió y el código descartó (clave inexistente, formato). */
  descartadas: { motivo: string; detalle: string }[];
  modelo: string;
  simulado: boolean;
  /** true si no había ningún grupo con n ≥ min_casos: no se llamó a Claude. */
  sin_datos_suficientes: boolean;
};

// ------------------------------------------------------------------ agregados (puro)

export const MIN_CASOS_DEFAULT = 10;
const MAX_EJEMPLOS = 2;
const MAX_CHARS_EJEMPLO = 160;

/**
 * Defensa extra (M1 ya anonimiza): descarta un ejemplo si parece traer un dato personal sin código:
 * 7+ dígitos seguidos (teléfono, CI, pedido), un email o un "+595".
 */
export function pareceDatoPersonal(texto: string): boolean {
  const t = String(texto ?? "");
  if (/\d[\d\s.-]{6,}\d/.test(t.replace(/\[[A-Z]+_\d+\]/g, ""))) return true;
  if (/[^\s@]+@[^\s@]+\.[^\s@]+/.test(t)) return true;
  if (/\+\s?595/.test(t)) return true;
  return false;
}

function recortar(s: string): string {
  const t = String(s ?? "").replace(/\s+/g, " ").trim();
  return t.length > MAX_CHARS_EJEMPLO ? t.slice(0, MAX_CHARS_EJEMPLO - 1) + "…" : t;
}

function ejemploSeguro(e: ConvClasificada["ejemplo"]): Ejemplo | null {
  if (!e) return null;
  const cliente = recortar(e.cliente ?? "");
  const vendedor = recortar(e.vendedor ?? "");
  if (!cliente && !vendedor) return null;
  if (pareceDatoPersonal(cliente) || pareceDatoPersonal(vendedor)) return null;
  return { cliente, vendedor };
}

function normalizarClave(s: string | null | undefined): string | null {
  const t = String(s ?? "").trim().toLowerCase().replace(/\s+/g, " ");
  return t ? t.slice(0, 80) : null;
}

type Acum = { n: number; entregados: number; en_curso: number; ejemplos: Ejemplo[] };

function sumar(mapa: Map<string, Acum>, clave: string, c: ConvClasificada) {
  const a = mapa.get(clave) ?? { n: 0, entregados: 0, en_curso: 0, ejemplos: [] };
  a.n++;
  if (c.resultado === "entregado") a.entregados++;
  if (c.resultado === "en_curso") a.en_curso++;
  if (a.ejemplos.length < MAX_EJEMPLOS) {
    const e = ejemploSeguro(c.ejemplo);
    if (e) a.ejemplos.push(e);
  }
  mapa.set(clave, a);
}

function cerrar(mapa: Map<string, Acum>, min: number): Record<string, Grupo> {
  const out: Record<string, Grupo> = {};
  const claves = [...mapa.keys()].sort((x, y) => mapa.get(y)!.n - mapa.get(x)!.n || x.localeCompare(y));
  for (const k of claves) {
    const a = mapa.get(k)!;
    const conocidos = a.n - a.en_curso;
    out[k] = {
      n: a.n,
      entregados: a.entregados,
      en_curso: a.en_curso,
      tasa_entrega: conocidos > 0 ? Math.round((a.entregados / conocidos) * 1000) / 1000 : null,
      dato_debil: conocidos < min,
      ejemplos: a.ejemplos,
    };
  }
  return out;
}

export function agregar(convs: ConvClasificada[], opciones: { minCasos?: number; mes?: string } = {}): Agregados {
  const min = opciones.minCasos ?? MIN_CASOS_DEFAULT;
  const porResultado: Record<ResultadoConversacion, number> = {
    entregado: 0, devuelto: 0, rechazado: 0, cancelado: 0, en_curso: 0, sin_compra: 0,
  };
  const obj = new Map<string, Acum>();
  const resp = new Map<string, Acum>();
  const objResp = new Map<string, Acum>();
  const paso = new Map<string, Acum>();
  const tipoRec = new Map<string, Acum>();
  const debio = new Map<string, Acum>();
  const errores = new Map<string, Acum>();
  const emocion: Record<string, number> = {};
  let reclamos = 0;
  let derivadosRec = 0;

  for (const c of convs) {
    const e = c.etiquetas;
    if (!e) continue;
    porResultado[c.resultado] = (porResultado[c.resultado] ?? 0) + 1;
    emocion[e.emocion] = (emocion[e.emocion] ?? 0) + 1;
    const o = normalizarClave(e.objecion_principal);
    const r = normalizarClave(e.respuesta_que_movio);
    if (o) sumar(obj, o, c);
    if (r) sumar(resp, r, c);
    if (o && r) sumar(objResp, `${o} → ${r}`, c);
    if (e.reclamo?.hubo) {
      reclamos++;
      if (e.reclamo.derivado) derivadosRec++;
      sumar(paso, e.reclamo.paso_resuelto ? String(e.reclamo.paso_resuelto) : "sin_resolver", c);
      sumar(tipoRec, normalizarClave(e.reclamo.tipo) ?? "sin_tipo", c);
    }
    const derivo = c.derivado === true || e.reclamo?.derivado === true;
    if (e.debio_derivar && !derivo) sumar(debio, e.etapa, c);
    for (const err of new Set((e.errores_bot ?? []).map(normalizarClave).filter((x): x is string => !!x))) {
      sumar(errores, err, c);
    }
  }
  const n = Object.values(porResultado).reduce((s, x) => s + x, 0);
  const conocidos = n - porResultado.en_curso;
  return {
    mes: opciones.mes ?? "",
    n_conversaciones: n,
    min_casos: min,
    por_resultado: porResultado,
    tasa_entrega_global: conocidos > 0 ? Math.round((porResultado.entregado / conocidos) * 1000) / 1000 : null,
    por_objecion: cerrar(obj, min),
    por_respuesta: cerrar(resp, min),
    por_objecion_respuesta: cerrar(objResp, min),
    reclamos: { total: reclamos, por_paso: cerrar(paso, min), por_tipo: cerrar(tipoRec, min), derivados: derivadosRec },
    debio_derivar: cerrar(debio, min),
    errores_bot: cerrar(errores, min),
    emocion,
  };
}

/** El grupo de una dimensión/clave, o null si no existe. */
export function grupoDe(a: Agregados, dimension: Dimension, clave: string): Grupo | null {
  const tabla: Record<Dimension, Record<string, Grupo>> = {
    por_objecion: a.por_objecion,
    por_respuesta: a.por_respuesta,
    por_objecion_respuesta: a.por_objecion_respuesta,
    reclamos_por_paso: a.reclamos.por_paso,
    reclamos_por_tipo: a.reclamos.por_tipo,
    debio_derivar: a.debio_derivar,
    errores_bot: a.errores_bot,
  };
  return tabla[dimension]?.[clave] ?? tabla[dimension]?.[normalizarClave(clave) ?? ""] ?? null;
}

export function hayDatosSuficientes(a: Agregados): boolean {
  for (const d of DIMENSIONES) {
    const tabla = d === "reclamos_por_paso" ? a.reclamos.por_paso : d === "reclamos_por_tipo" ? a.reclamos.por_tipo : a[d];
    if (Object.values(tabla).some((g) => !g.dato_debil)) return true;
  }
  return false;
}

// ------------------------------------------------------------------ pedido a Claude (puro)

export const MODELO_SINTESIS = "claude-sonnet-5-5";

export const SISTEMA_SINTESIS = `Analizás el mes de un vendedor por WhatsApp de una tienda paraguaya con pago contra entrega.
Recibís SOLO agregados (conteos, tasas y unos pocos ejemplos anonimizados). No hay conversaciones completas.

Reglas:
- La única métrica de éxito es la TASA DE ENTREGA (pedido entregado y cobrado), nunca la venta.
- Cada conclusión tiene que apuntar a UN grupo que exista en los agregados: "dimension" es una de ${DIMENSIONES.join(", ")} y "clave" es la clave exacta del grupo.
- Si el grupo tiene dato_debil = true (menos de 10 casos con resultado conocido), podés mencionarlo pero con "sugerencia": null.
- Como mucho 8 conclusiones, las de más impacto en entregas o en reclamos.
- Escalera de reclamos: 1 escuchar (foto o video, cómo lo usa), 2 resolver el uso (consejo y video). Esos dos los hace la IA. 3 reponer, 4 compensar y 5 la devolución los decide Enrique: cualquier cambio sobre ellos es tipo "politica_reclamos".
- Tipos de sugerencia: "ejemplo" (contenido {cliente, vendedor}: un intercambio corto modelo), "faq" ({pregunta, respuesta}), "orden_objeciones" ({orden: [claves de objeción en el orden en que conviene responderlas]}), "prompt_tono" ({linea: una instrucción breve de estilo}), "derivacion" ({cuando}), "politica_reclamos" ({paso, cambio}), "afirmacion" ({texto}), "precio" ({detalle}), "palabra_prohibida" ({palabra}).
- Nunca escribas precios ni montos en los textos sugeridos: los precios los da la herramienta del catálogo.
- Nunca uses estas palabras: garantía, devolución, reembolso, "sin riesgo", cura, curar, tratamiento, oxígeno. Nada de promesas de salud.
- Español de Paraguay, voseo, 1 a 3 líneas por mensaje de vendedor, una sola pregunta.

Respondé SOLO un objeto JSON, sin texto antes ni después, con esta forma:
{"resumen": "2 a 4 frases", "conclusiones": [{"dimension": "...", "clave": "...", "texto": "qué muestran los números", "sugerencia": null | {"tipo": "...", "detalle": "por qué", "contenido": {...}}}]}`;

const TEXTO = { type: "string" };
/**
 * Esquema de la salida estructurada (output_config.format). `contenido` junta los campos de todos los tipos
 * de sugerencia como opcionales (cerrado con additionalProperties:false). La validación de validarSalida
 * sigue igual: el grupo tiene que existir, n/tasa salen de los agregados, dato débil ⇒ sin sugerencia.
 */
export const ESQUEMA_SINTESIS: Record<string, unknown> = {
  type: "object",
  properties: {
    resumen: TEXTO,
    conclusiones: {
      type: "array",
      items: {
        type: "object",
        properties: {
          dimension: { type: "string", enum: [...DIMENSIONES] },
          clave: TEXTO,
          texto: TEXTO,
          sugerencia: {
            anyOf: [
              { type: "null" },
              {
                type: "object",
                properties: {
                  tipo: { type: "string", enum: [...TIPOS_CAMBIO] },
                  detalle: TEXTO,
                  contenido: {
                    type: "object",
                    properties: {
                      cliente: TEXTO, vendedor: TEXTO, pregunta: TEXTO, respuesta: TEXTO,
                      orden: { type: "array", items: TEXTO },
                      linea: TEXTO, cuando: TEXTO, paso: TEXTO, cambio: TEXTO, texto: TEXTO, detalle: TEXTO, palabra: TEXTO,
                    },
                    additionalProperties: false,
                  },
                },
                required: ["tipo", "detalle", "contenido"],
                additionalProperties: false,
              },
            ],
          },
        },
        required: ["dimension", "clave", "texto", "sugerencia"],
        additionalProperties: false,
      },
    },
  },
  required: ["resumen", "conclusiones"],
  additionalProperties: false,
};

export function armarPedidoSintesis(a: Agregados, modelo = MODELO_SINTESIS): PedidoClaude {
  return {
    modelo,
    system: SISTEMA_SINTESIS,
    mensajes: [{ role: "user", content: `Agregados del mes (JSON):\n${JSON.stringify(a)}` }],
    maxTokens: 8000,
    esfuerzo: "medium",
    cache: false, // una sola llamada al mes: escribir caché cuesta más que no usarla
    esquemaJson: ESQUEMA_SINTESIS,
  };
}

// ------------------------------------------------------------------ validación (pura)

function esObj(v: unknown): v is Record<string, unknown> {
  return !!v && typeof v === "object" && !Array.isArray(v);
}

/** Extrae el primer objeto JSON del texto (tolera ```json ... ```). */
export function extraerJson(texto: string): unknown {
  const t = String(texto ?? "").trim().replace(/^```(?:json)?\s*/i, "").replace(/```\s*$/, "");
  try {
    return JSON.parse(t);
  } catch {
    const i = t.indexOf("{");
    const j = t.lastIndexOf("}");
    if (i >= 0 && j > i) {
      try {
        return JSON.parse(t.slice(i, j + 1));
      } catch { /* sigue */ }
    }
    return null;
  }
}

function validarSugerencia(s: unknown): Sugerencia | null | "invalida" {
  if (s === null || s === undefined) return null;
  if (!esObj(s)) return "invalida";
  const tipo = s.tipo as TipoCambio;
  if (!TIPOS_CAMBIO.includes(tipo)) return "invalida";
  const contenido = esObj(s.contenido) ? s.contenido : {};
  return { tipo, detalle: String(s.detalle ?? "").slice(0, 400), contenido };
}

/**
 * Valida la respuesta del modelo contra los agregados. Devuelve null si el formato no sirve
 * (para reintentar). n, tasa y dato_debil salen de los agregados; con dato débil no hay sugerencia.
 */
export function validarSalida(
  crudo: unknown,
  a: Agregados,
): { resumen: string; analisis: Conclusion[]; descartadas: HallazgosSintesis["descartadas"] } | null {
  if (!esObj(crudo) || !Array.isArray(crudo.conclusiones)) return null;
  const conclusiones: Conclusion[] = [];
  const descartadas: HallazgosSintesis["descartadas"] = [];
  for (const c of crudo.conclusiones.slice(0, 8)) {
    if (!esObj(c)) {
      descartadas.push({ motivo: "formato", detalle: JSON.stringify(c).slice(0, 120) });
      continue;
    }
    const dimension = c.dimension as Dimension;
    const clave = String(c.clave ?? "");
    if (!DIMENSIONES.includes(dimension)) {
      descartadas.push({ motivo: "dimension_inexistente", detalle: `${String(c.dimension)}:${clave}` });
      continue;
    }
    const g = grupoDe(a, dimension, clave);
    if (!g) {
      descartadas.push({ motivo: "grupo_inexistente", detalle: `${dimension}:${clave}` });
      continue;
    }
    const sug = validarSugerencia(c.sugerencia);
    if (sug === "invalida") descartadas.push({ motivo: "sugerencia_invalida", detalle: `${dimension}:${clave}` });
    conclusiones.push({
      id: `c${conclusiones.length + 1}`,
      dimension,
      clave,
      texto: String(c.texto ?? "").slice(0, 500),
      n: g.n,
      tasa_entrega: g.tasa_entrega,
      dato_debil: g.dato_debil,
      // Dato débil ⇒ nunca se propone un cambio por esa conclusión.
      sugerencia: g.dato_debil || sug === "invalida" ? null : sug,
    });
  }
  return { resumen: String(crudo.resumen ?? "").slice(0, 1000), analisis: conclusiones, descartadas };
}

// ------------------------------------------------------------------ síntesis determinista (modo simulado)

/**
 * Sin Claude: reglas fijas sobre los agregados, para correr el ciclo sin red.
 * - Orden de objeciones por frecuencia (solo las que no son dato débil), si hay 2 o más.
 * - Casos que debieron derivarse y no se derivaron (≥ min) → sugerencia de derivación.
 * - Por cada objeción fuerte, la respuesta fuerte con mejor tasa de entrega (sin sugerencia: texto).
 */
export function sintesisDeterminista(a: Agregados): { resumen: string; analisis: Conclusion[] } {
  const conclusiones: Conclusion[] = [];
  const add = (dimension: Dimension, clave: string, texto: string, sugerencia: Sugerencia | null) => {
    const g = grupoDe(a, dimension, clave)!;
    conclusiones.push({
      id: `c${conclusiones.length + 1}`,
      dimension,
      clave,
      texto,
      n: g.n,
      tasa_entrega: g.tasa_entrega,
      dato_debil: g.dato_debil,
      sugerencia: g.dato_debil ? null : sugerencia,
    });
  };
  const fuertes = Object.entries(a.por_objecion).filter(([, g]) => !g.dato_debil);
  if (fuertes.length >= 2) {
    const orden = fuertes.map(([k]) => k);
    add("por_objecion", orden[0], `Objeción más frecuente: ${orden[0]} (${fuertes[0][1].n} casos).`, {
      tipo: "orden_objeciones",
      detalle: "Ordenar las objeciones por frecuencia del mes.",
      contenido: { orden },
    });
  }
  for (const [obj] of fuertes) {
    const mejor = Object.entries(a.por_objecion_respuesta)
      .filter(([k, g]) => k.startsWith(`${obj} → `) && !g.dato_debil && g.tasa_entrega !== null)
      .sort((x, y) => (y[1].tasa_entrega ?? 0) - (x[1].tasa_entrega ?? 0))[0];
    if (mejor) {
      add("por_objecion_respuesta", mejor[0], `Mejor respuesta a "${obj}": entrega ${Math.round((mejor[1].tasa_entrega ?? 0) * 100)} %.`, null);
    }
  }
  for (const [etapa, g] of Object.entries(a.debio_derivar)) {
    if (g.dato_debil) continue;
    add("debio_derivar", etapa, `${g.n} chats en etapa ${etapa} debieron pasar a Enrique y no pasaron.`, {
      tipo: "derivacion",
      detalle: `Revisar la regla de derivación en la etapa ${etapa}.`,
      contenido: { cuando: etapa },
    });
  }
  const tasa = a.tasa_entrega_global === null ? "sin datos" : `${Math.round(a.tasa_entrega_global * 100)} %`;
  return {
    resumen: `Síntesis determinista (modo simulado). ${a.n_conversaciones} conversaciones, entrega ${tasa}.`,
    analisis: conclusiones.slice(0, 8),
  };
}

// ------------------------------------------------------------------ campos de Hallazgos (M1)

function tasas(t: Record<string, Grupo>): TasaPorClave[] {
  return Object.entries(t).map(([clave, g]) => ({ clave, n: g.n, entregados: g.entregados, tasa_entrega: g.tasa_entrega ?? 0 }));
}

/** Los campos de `Hallazgos` (tipos.ts) que salen directo de los agregados. */
export function camposHallazgos(a: Agregados, conclusiones: string[], costo_usd: number): Hallazgos {
  const porPaso: Hallazgos["reclamos"]["por_paso"] = {};
  for (const [k, g] of Object.entries(a.reclamos.por_paso)) {
    const p = Number(k);
    if (p >= 1 && p <= 5) porPaso[p as 1 | 2 | 3 | 4 | 5] = g.n;
  }
  return {
    mes: a.mes,
    n_conversaciones: a.n_conversaciones,
    n_clasificadas: a.n_conversaciones,
    tasa_entrega_global: a.tasa_entrega_global ?? 0,
    objeciones: tasas(a.por_objecion),
    respuestas_que_mueven: tasas(a.por_respuesta),
    errores_bot: Object.entries(a.errores_bot).map(([error, g]) => ({ error, n: g.n })),
    reclamos: {
      n: a.reclamos.total,
      por_tipo: Object.entries(a.reclamos.por_tipo).map(([tipo, g]) => ({ tipo, n: g.n })),
      por_paso: porPaso,
      resueltos_sin_devolucion: [1, 2, 3, 4].reduce((s, p) => s + (porPaso[p as 1 | 2 | 3 | 4] ?? 0), 0),
      debio_derivar_y_no: Object.values(a.debio_derivar).reduce((s, g) => s + g.n, 0),
    },
    conclusiones,
    costo_usd,
  };
}

/** Texto corto de una conclusión para `Hallazgos.conclusiones`. */
function linea(c: Conclusion): string {
  const tasa = c.tasa_entrega === null ? "s/d" : `${Math.round(c.tasa_entrega * 100)} %`;
  return `${c.dato_debil ? "[dato débil] " : ""}${c.texto} (n=${c.n}, entrega ${tasa})`;
}

// ------------------------------------------------------------------ orquestación

export type DepsSintesis = {
  llamar?: (p: PedidoClaude) => Promise<RespuestaClaude>;
  simulado?: boolean;
  modelo?: string;
};

export async function sintetizar(a: Agregados, deps: DepsSintesis = {}): Promise<HallazgosSintesis> {
  const modelo = deps.modelo ?? MODELO_SINTESIS;
  const armar = (
    r: { resumen: string; analisis: Conclusion[]; descartadas?: HallazgosSintesis["descartadas"] },
    extra: { costo_usd: number; simulado: boolean; modelo: string; sin_datos_suficientes: boolean },
  ): HallazgosSintesis => ({
    ...camposHallazgos(a, r.analisis.map(linea), extra.costo_usd),
    resumen: r.resumen,
    analisis: r.analisis,
    descartadas: r.descartadas ?? [],
    modelo: extra.modelo,
    simulado: extra.simulado,
    sin_datos_suficientes: extra.sin_datos_suficientes,
  });
  if (!hayDatosSuficientes(a)) {
    return armar(
      { resumen: `Ningún grupo llega a ${a.min_casos} casos con resultado conocido: no hay conclusiones firmes ni cambios.`, analisis: [] },
      { costo_usd: 0, simulado: deps.simulado ?? esModoSimulado(), modelo, sin_datos_suficientes: true },
    );
  }
  const simulado = deps.simulado ?? (deps.llamar ? false : esModoSimulado());
  if (simulado) {
    return armar(sintesisDeterminista(a), { costo_usd: 0, simulado: true, modelo, sin_datos_suficientes: false });
  }
  const llamar = deps.llamar ?? llamarClaude;
  let pedido = armarPedidoSintesis(a, modelo);
  let costo = 0;
  for (let intento = 0; intento < 2; intento++) {
    // El reintento repite el mismo pedido (sin editar historia: Sonnet 5.5 no acepta prefill).
    let r: RespuestaClaude;
    try {
      r = await llamar(pedido);
    } catch (e) {
      // Si la API rechaza el esquema (400), se sigue sin salida estructurada: validarSalida igual filtra.
      if (e instanceof ErrorClaude && e.status === 400 && pedido.esquemaJson) {
        console.warn(`sintetizar: la API rechazó el esquema (${e.message}); sigo sin salida estructurada`);
        const { esquemaJson: _sinEsquema, ...resto } = pedido;
        pedido = resto;
        r = await llamar(pedido);
      } else throw e;
    }
    costo += r.costo_usd ?? 0;
    if (r.stop_reason === "refusal") continue;
    const v = validarSalida(extraerJson(textoDe(r.contenido)), a);
    if (v) return armar(v, { costo_usd: costo, simulado: r.simulado, modelo: r.modelo || modelo, sin_datos_suficientes: false });
  }
  throw new Error(`sintetizar: el modelo no devolvió un JSON válido en 2 intentos (costo USD ${costo.toFixed(4)})`);
}
