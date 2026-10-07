// _shared/vendedor/perfil.ts · Dueño: G1 (vendedor)
// Perfil del cliente que el vendedor detecta en la conversación (qué le pasa + cómo encararlo) y marcas de
// cierre (ya ofreció el ×2, ya preguntó "¿qué te frena?"). Se guarda en wa_conversaciones.perfil_vendedor
// (migración 20261006000011) para que los turnos siguientes lo usen sin volver a preguntar.
// Puro: sin I/O. El orquestador lo lee con la conversación y lo guarda al cerrar el turno.

export const NECESIDADES = ["ronca", "pareja_se_queja", "boca_seca", "aliento", "mandibula", "deporte", "regalo", "otro"] as const;
export const PERFILES = ["apurado", "desconfiado", "curioso", "precio", "regalo", "indefinido"] as const;

export type Necesidad = typeof NECESIDADES[number];
export type TipoPerfil = typeof PERFILES[number];

export type PerfilCliente = {
  necesidad?: Necesidad;
  perfil?: TipoPerfil;
  /** Dato corto que sirve para el próximo turno ("es para el marido", "vive en CDE"). Máx. 120 caracteres. */
  nota?: string;
  /** Ya se le ofreció el ×2 (o el carrusel ×1/×2/×3): no se repite. */
  ofrecido_x2?: boolean;
  /** Ya se le preguntó "¿qué te frena?": no se insiste. */
  pregunto_freno?: boolean;
};

const esObj = (v: unknown): v is Record<string, unknown> => !!v && typeof v === "object" && !Array.isArray(v);

function normalizar(s: string): string {
  return String(s ?? "").normalize("NFD").replace(/\p{M}/gu, "").toLowerCase();
}

/** Lo que viene de la base (jsonb) o de la herramienta registrar_perfil → perfil válido (descarta lo raro). */
export function normalizarPerfil(v: unknown): PerfilCliente {
  if (!esObj(v)) return {};
  const p: PerfilCliente = {};
  if (typeof v.necesidad === "string" && (NECESIDADES as readonly string[]).includes(v.necesidad)) p.necesidad = v.necesidad as Necesidad;
  if (typeof v.perfil === "string" && (PERFILES as readonly string[]).includes(v.perfil)) p.perfil = v.perfil as TipoPerfil;
  if (typeof v.nota === "string" && v.nota.trim()) p.nota = v.nota.trim().replace(/\s+/g, " ").slice(0, 120);
  if (v.ofrecido_x2 === true) p.ofrecido_x2 = true;
  if (v.pregunto_freno === true) p.pregunto_freno = true;
  return p;
}

/** Lo nuevo pisa lo viejo campo por campo; las marcas de cierre nunca se borran. "indefinido" no pisa un perfil ya detectado. */
export function fusionarPerfil(previo: PerfilCliente, nuevo: PerfilCliente): PerfilCliente {
  const r: PerfilCliente = { ...previo };
  if (nuevo.necesidad) r.necesidad = nuevo.necesidad;
  if (nuevo.perfil && !(nuevo.perfil === "indefinido" && previo.perfil)) r.perfil = nuevo.perfil;
  if (nuevo.nota) r.nota = nuevo.nota;
  if (nuevo.ofrecido_x2 || previo.ofrecido_x2) r.ofrecido_x2 = true;
  if (nuevo.pregunto_freno || previo.pregunto_freno) r.pregunto_freno = true;
  return r;
}

export function mismoPerfil(a: PerfilCliente, b: PerfilCliente): boolean {
  const k = (p: PerfilCliente) => JSON.stringify([p.necesidad ?? null, p.perfil ?? null, p.nota ?? null, !!p.ofrecido_x2, !!p.pregunto_freno]);
  return k(a) === k(b);
}

const RE_X2 = /(?:×|\bx)\s?2\b|\b(?:el|la|los|las) de (?:2|dos)\b|\b(?:2|dos) (?:bolsas|unidades|packs?|cajas)\b|\bde a (?:2|dos)\b/u;
const RE_FRENO = /que te frena|que le frena/u;

/** Marcas que deja un texto que el vendedor le mandó al cliente (deterministas, no dependen del modelo). */
export function marcasDeRespuesta(texto: string, herramientasUsadas: string[] = []): PerfilCliente {
  const t = normalizar(texto);
  const m: PerfilCliente = {};
  if (RE_X2.test(t) || herramientasUsadas.includes("enviar_opciones")) m.ofrecido_x2 = true;
  if (RE_FRENO.test(t)) m.pregunto_freno = true;
  return m;
}

export function preguntaQueTeFrena(texto: string): boolean {
  return RE_FRENO.test(normalizar(texto));
}

const ETIQUETA_NECESIDAD: Record<Necesidad, string> = {
  ronca: "ronca",
  pareja_se_queja: "la pareja se queja de los ronquidos",
  boca_seca: "se despierta con la boca seca",
  aliento: "le preocupa el aliento",
  mandibula: "quiere marcar o entrenar la mandíbula",
  deporte: "lo quiere para entrenar o hacer deporte",
  regalo: "es para regalar",
  otro: "otra necesidad",
};

const COMO_ENCARAR: Record<TipoPerfil, string> = {
  apurado: "apurado: cerrá ya pidiendo los datos, sin vueltas",
  desconfiado: "desconfiado: prueba concreta (video real, pagás al recibir, RUC de Voltra E.A.S.)",
  curioso: "curioso: un beneficio concreto y una pregunta",
  precio: "mira el precio: total en una línea y el valor del ×2",
  regalo: "regalo: para quién es y cerrá con los datos de entrega",
  indefinido: "todavía sin perfil claro",
};

/** Bloque para el contexto dinámico del system (no va en la parte cacheada). */
export function textoPerfil(p: PerfilCliente): string {
  const l: string[] = [];
  if (p.necesidad || (p.perfil && p.perfil !== "indefinido")) {
    const partes = [p.necesidad ? `necesidad: ${ETIQUETA_NECESIDAD[p.necesidad]}` : null, p.perfil ? `perfil: ${COMO_ENCARAR[p.perfil]}` : null]
      .filter(Boolean);
    l.push(`PERFIL YA DETECTADO (no lo vuelvas a preguntar): ${partes.join("; ")}.${p.nota ? ` Nota: ${p.nota}.` : ""}`);
  } else {
    l.push("PERFIL: todavía sin detectar. Si no lo dijo y no está apurado por comprar, hacé UNA pregunta corta de diagnóstico antes de recomendar y llamá registrar_perfil cuando lo sepas.");
  }
  if (p.ofrecido_x2) l.push("YA OFRECISTE EL ×2: no lo vuelvas a ofrecer salvo que el cliente lo pida.");
  if (p.pregunto_freno) l.push("YA PREGUNTASTE QUÉ LO FRENA: no insistas; respondé solo lo que pregunte.");
  return l.join("\n");
}

// ---------- honestidad ----------

const RE_PREGUNTA_BOT: RegExp[] = [
  /\b(?:sos|eres|seras|serias) (?:un |una )?(?:bot|robot|ia|inteligencia artificial|maquina|programa|contestador|chatbot|persona|humano|humana|real|automatico)\b/u,
  /\b(?:es|esto es) (?:un |una )?(?:bot|robot|ia|inteligencia artificial|maquina|chatbot|contestador)\b/u,
  /\b(?:estoy hablando|hablo|chateo|estoy chateando) con (?:un |una )?(?:bot|robot|ia|maquina|persona|humano|chatbot|contestador)\b/u,
  /\bme (?:atiende|responde|contesta|escribe) (?:un |una )?(?:bot|robot|ia|persona|humano|maquina)\b/u,
  /\b(?:respuesta|mensaje|contestador) automatic[oa]\b/u,
  /\bbot\s*\?/u,
];

/** true si el cliente pregunta directamente si habla con un bot o con una persona (no si pide una persona). */
export function preguntaSiEsBot(texto: string): boolean {
  const t = normalizar(texto).replace(/[¿?¡!.,]/g, (c) => (c === "?" ? " ?" : " ")).replace(/\s+/g, " ");
  return RE_PREGUNTA_BOT.some((re) => re.test(t));
}
