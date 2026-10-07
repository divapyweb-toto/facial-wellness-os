// mejora-mensual/tipos.ts · Dueño: M1 (ciclo mensual de mejora del vendedor)
// Tipos compartidos por datos, clasificar (M1), sintetizar, proponer, probar (M2) y la máquina de estados (M3).
// Fuente: supabase/CONTRATO-MEJORA-MENSUAL.md

// ---------- etiquetas por conversación (salida de Haiku, validada) ----------

export const ETAPAS = ["consulta", "interes", "objecion", "cierre", "postventa", "reclamo"] as const;
export type Etapa = typeof ETAPAS[number];

export const EMOCIONES = ["neutral", "enojo", "abandono", "satisfecho"] as const;
export type Emocion = typeof EMOCIONES[number];

export type PasoEscalera = 1 | 2 | 3 | 4 | 5;

export type Etiquetas = {
  etapa: Etapa;
  objecion_principal: string | null;
  respuesta_que_movio: string | null;
  errores_bot: string[];
  reclamo: {
    hubo: boolean;
    tipo: string | null;
    paso_resuelto: PasoEscalera | null;
    derivado: boolean;
  };
  emocion: Emocion;
  debio_derivar: boolean;
};

// ---------- resultado por conversación (vista conversacion_resultado) ----------

export const RESULTADOS = ["entregado", "devuelto", "rechazado", "cancelado", "en_curso", "sin_compra"] as const;
export type Resultado = typeof RESULTADOS[number];

export type ConversacionResultado = {
  conversacion_id: string;
  cliente_id: string | null;
  shopify_order_id: number | null;
  resultado: Resultado;
  costo_ia_usd: number;
  costo_mensajes_usd: number;
  tuvo_reclamo: boolean;
  paso_escalera: PasoEscalera | null;
  derivado: boolean;
};

/** Un mensaje ya anonimizado. `de`: C = cliente, V = Voltra (IA o Enrique). */
export type MensajeAnon = { de: "C" | "V"; texto: string };

/** Lo único que sale hacia Claude (texto ya anonimizado) más el resultado para correlacionar. */
export type ConversacionParaAnalizar = {
  conversacion_id: string;
  resultado: Resultado;
  derivado: boolean;
  tuvo_reclamo: boolean;
  paso_escalera: PasoEscalera | null;
  costo_ia_usd: number;
  costo_mensajes_usd: number;
  n_mensajes: number;
  mensajes: MensajeAnon[];
  /** Transcripción compacta (una línea por mensaje, "C: …" / "V: …"), ya recortada. */
  transcripcion: string;
  /** true si se recortaron mensajes o caracteres para respetar el tamaño máximo. */
  recortada: boolean;
};

export type RecoleccionMes = {
  /** 'YYYY-MM-01' */
  mes: string;
  /** Conversaciones del mes que cumplen el mínimo de mensajes (antes de muestrear). Va contra min_conversaciones. */
  total: number;
  conversaciones: ConversacionParaAnalizar[];
  /** Cuántas quedaron afuera por el tope de costo. */
  recortadas_por_tope: number;
  notas: string[];
};

/** Etiquetas + resultado: la materia prima de los agregados que M2 manda a Sonnet. */
export type ClasificacionConResultado = {
  conversacion_id: string;
  etiquetas: Etiquetas;
  resultado: Resultado;
  derivado: boolean;
  tuvo_reclamo: boolean;
  paso_escalera: PasoEscalera | null;
};

// ---------- hallazgos, cambios y propuesta (M2) ----------

export const TIPOS_CAMBIO = [
  "ejemplo",
  "orden_objeciones",
  "faq",
  "prompt_tono",
  "precio",
  "afirmacion",
  "palabra_prohibida",
  "politica_reclamos",
  "derivacion",
] as const;
export type TipoCambio = typeof TIPOS_CAMBIO[number];

export type Riesgo = "bajo" | "requiere_decision";

/** Los que nunca se aplican solos (los lista la propuesta, decide Enrique). */
export const TIPOS_REQUIEREN_DECISION: readonly TipoCambio[] = [
  "precio",
  "afirmacion",
  "palabra_prohibida",
  "politica_reclamos",
  "derivacion",
];

export type Cambio = {
  tipo: TipoCambio;
  riesgo: Riesgo;
  antes: unknown;
  despues: unknown;
  motivo: string;
};

export type TasaPorClave = {
  clave: string;
  n: number;
  entregados: number;
  /** entregados / n (0..1). Se correlaciona con ENTREGADO, no con venta. */
  tasa_entrega: number;
};

export type Hallazgos = {
  mes: string;
  n_conversaciones: number;
  n_clasificadas: number;
  tasa_entrega_global: number;
  objeciones: TasaPorClave[];
  respuestas_que_mueven: TasaPorClave[];
  errores_bot: { error: string; n: number }[];
  reclamos: {
    n: number;
    por_tipo: { tipo: string; n: number }[];
    por_paso: Partial<Record<PasoEscalera, number>>;
    resueltos_sin_devolucion: number;
    debio_derivar_y_no: number;
  };
  /** Conclusiones en texto corto (las escribe Sonnet sobre los agregados). */
  conclusiones: string[];
  costo_usd: number;
};

export type VersionBorrador = {
  prompt: string;
  ejemplos: unknown[];
  faq: unknown[];
  objeciones: unknown[];
  notas: string | null;
};

export type Propuesta = {
  version: VersionBorrador;
  /** Todos los cambios; los `requiere_decision` NO están aplicados en `version`. */
  cambios: Cambio[];
};

// ---------- filas de las tablas nuevas ----------

export type EstadoVersion = "activa" | "propuesta" | "descartada" | "archivada";
export type OrigenVersion = "semilla" | "mejora_mensual" | "manual";

export type VendedorVersion = {
  id: string;
  numero: number;
  estado: EstadoVersion;
  prompt: string;
  ejemplos: unknown[];
  faq: unknown[];
  objeciones: unknown[];
  origen: OrigenVersion;
  ciclo_id: string | null;
  creado_en: string;
  activada_en: string | null;
  notas: string | null;
};

export const ESTADOS_CICLO = [
  "recolectando",
  "clasificando",
  "sintetizando",
  "probando",
  "esperando_aprobacion",
  "aplicado",
  "descartado",
  "sin_datos_suficientes",
  "error",
] as const;
export type EstadoCiclo = typeof ESTADOS_CICLO[number];

export type MejoraCiclo = {
  id: string;
  mes: string;
  estado: EstadoCiclo;
  n_conversaciones: number | null;
  lote_id: string | null;
  costo_usd: number;
  resumen: Record<string, unknown> | null;
  hallazgos: Hallazgos | null;
  propuesta_version_id: string | null;
  prueba: Record<string, unknown> | null;
  telegram_message_id: number | null;
  error: string | null;
  creado_en: string;
  actualizado_en: string;
};

// ---------- configuración (config_wa.mejora_mensual) ----------

export type CfgMejora = {
  /** Tope duro en USD por ciclo (clasificación + síntesis). */
  tope_usd: number;
  min_conversaciones: number;
  /** Fracción del tope para la clasificación (el resto, síntesis). */
  reparto_clasificacion: number;
  modelo_clasificacion: string;
  modelo_sintesis: string;
  /** Tope de tokens de salida por clasificación. */
  max_tokens_clasificacion: number;
  /** Tamaño máximo de la transcripción por conversación (caracteres). */
  max_chars_conversacion: number;
  /** Máximo de mensajes por conversación (se guardan los primeros y los últimos). */
  max_mensajes_conversacion: number;
  min_mensajes_conversacion: number;
  /** Caracteres por token para estimar (conservador para español). */
  chars_por_token: number;
};

export const CFG_MEJORA_DEFAULT: CfgMejora = {
  tope_usd: 3,
  min_conversaciones: 100,
  reparto_clasificacion: 0.7,
  modelo_clasificacion: "claude-haiku-4-5-20251001",
  modelo_sintesis: "claude-sonnet-5-5",
  max_tokens_clasificacion: 300,
  max_chars_conversacion: 4000,
  max_mensajes_conversacion: 40,
  min_mensajes_conversacion: 2,
  chars_por_token: 3,
};

/** Lee config_wa.mejora_mensual con valores por defecto; `faltantes` para dejarlo en el log. */
export function leerCfgMejora(valor: unknown): { cfg: CfgMejora; faltantes: string[] } {
  const v = (valor && typeof valor === "object" ? valor : {}) as Record<string, unknown>;
  const cfg: CfgMejora = { ...CFG_MEJORA_DEFAULT };
  const faltantes: string[] = [];
  for (const k of Object.keys(CFG_MEJORA_DEFAULT) as (keyof CfgMejora)[]) {
    const x = v[k];
    const def = CFG_MEJORA_DEFAULT[k];
    if (typeof def === "number" && typeof x === "number" && Number.isFinite(x) && x > 0) {
      (cfg as Record<string, unknown>)[k] = x;
    } else if (typeof def === "string" && typeof x === "string" && x.trim()) {
      (cfg as Record<string, unknown>)[k] = x.trim();
    } else {
      faltantes.push(k);
    }
  }
  if (cfg.reparto_clasificacion >= 1) cfg.reparto_clasificacion = CFG_MEJORA_DEFAULT.reparto_clasificacion;
  return { cfg, faltantes };
}

/** Reparto del tope: clasificación ~70 %, síntesis ~30 %. */
export function presupuesto(cfg: CfgMejora): { clasificacion_usd: number; sintesis_usd: number } {
  const c = Math.round(cfg.tope_usd * cfg.reparto_clasificacion * 1e6) / 1e6;
  return { clasificacion_usd: c, sintesis_usd: Math.round((cfg.tope_usd - c) * 1e6) / 1e6 };
}
