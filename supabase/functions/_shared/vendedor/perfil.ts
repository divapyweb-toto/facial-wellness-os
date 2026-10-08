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
  /** Producto que eligió o por el que pregunta ("tiras nasales"). Máx. 60 caracteres. Sobrevive aunque el historial corte. */
  producto?: string;
  /** Cantidad que eligió (1 a 10). */
  cantidad?: number;
  /** Ya se le ofreció el ×2 (o el carrusel ×1/×2/×3): no se repite. */
  ofrecido_x2?: boolean;
  /** Ya se le preguntó "¿qué te frena?": no se insiste. */
  pregunto_freno?: boolean;
  /**
   * El cliente dijo claramente que no (07-10): no se le manda ningún recontacto automático (seguimiento-chat).
   * Lo marcan el orquestador (detección determinista, `esRechazo`) o el modelo con registrar_perfil.
   */
  rechazo?: boolean;
  /**
   * Recontactos automáticos hechos en el ciclo actual (seguimiento-chat; máx. config_wa.vendedor_seguimiento.max
   * cada 7 días). Marca del sistema: el modelo NO la puede tocar (ver `normalizarPerfil(v, "modelo")`).
   */
  seguimientos?: number;
  /** Cuándo se hizo el último recontacto automático (ISO). Marca del sistema. */
  ultimo_seguimiento_en?: string;
};

const esObj = (v: unknown): v is Record<string, unknown> => !!v && typeof v === "object" && !Array.isArray(v);

function normalizar(s: string): string {
  return String(s ?? "").normalize("NFD").replace(/\p{M}/gu, "").toLowerCase();
}

/**
 * Lo que viene de la base (jsonb) o de la herramienta registrar_perfil → perfil válido (descarta lo raro).
 * `origen: "modelo"` (registrar_perfil) descarta las marcas del sistema (seguimientos, ultimo_seguimiento_en):
 * el modelo solo puede sumar `rechazo: true`.
 */
export function normalizarPerfil(v: unknown, origen: "base" | "modelo" = "base"): PerfilCliente {
  if (!esObj(v)) return {};
  const p: PerfilCliente = {};
  if (typeof v.necesidad === "string" && (NECESIDADES as readonly string[]).includes(v.necesidad)) p.necesidad = v.necesidad as Necesidad;
  if (typeof v.perfil === "string" && (PERFILES as readonly string[]).includes(v.perfil)) p.perfil = v.perfil as TipoPerfil;
  if (typeof v.nota === "string" && v.nota.trim()) p.nota = v.nota.trim().replace(/\s+/g, " ").slice(0, 120);
  if (typeof v.producto === "string" && v.producto.trim()) p.producto = v.producto.trim().replace(/\s+/g, " ").slice(0, 60);
  const cant = Number(v.cantidad);
  if (Number.isInteger(cant) && cant >= 1 && cant <= 10) p.cantidad = cant;
  if (v.ofrecido_x2 === true) p.ofrecido_x2 = true;
  if (v.pregunto_freno === true) p.pregunto_freno = true;
  if (v.rechazo === true) p.rechazo = true;
  if (origen === "base") {
    const n = Number(v.seguimientos);
    if (Number.isInteger(n) && n > 0 && n <= 20) p.seguimientos = n;
    if (typeof v.ultimo_seguimiento_en === "string" && Number.isFinite(Date.parse(v.ultimo_seguimiento_en))) {
      p.ultimo_seguimiento_en = v.ultimo_seguimiento_en;
    }
  }
  return p;
}

/** Lo nuevo pisa lo viejo campo por campo; las marcas de cierre nunca se borran. "indefinido" no pisa un perfil ya detectado. */
export function fusionarPerfil(previo: PerfilCliente, nuevo: PerfilCliente): PerfilCliente {
  const r: PerfilCliente = { ...previo };
  if (nuevo.necesidad) r.necesidad = nuevo.necesidad;
  if (nuevo.perfil && !(nuevo.perfil === "indefinido" && previo.perfil)) r.perfil = nuevo.perfil;
  if (nuevo.nota) r.nota = nuevo.nota;
  if (nuevo.producto) r.producto = nuevo.producto;
  if (nuevo.cantidad) r.cantidad = nuevo.cantidad;
  if (nuevo.ofrecido_x2 || previo.ofrecido_x2) r.ofrecido_x2 = true;
  if (nuevo.pregunto_freno || previo.pregunto_freno) r.pregunto_freno = true;
  if (nuevo.rechazo || previo.rechazo) r.rechazo = true;
  if (nuevo.seguimientos !== undefined) r.seguimientos = nuevo.seguimientos;
  if (nuevo.ultimo_seguimiento_en !== undefined) r.ultimo_seguimiento_en = nuevo.ultimo_seguimiento_en;
  return r;
}

export function mismoPerfil(a: PerfilCliente, b: PerfilCliente): boolean {
  const k = (p: PerfilCliente) =>
    JSON.stringify([
      p.necesidad ?? null, p.perfil ?? null, p.nota ?? null, p.producto ?? null, p.cantidad ?? null, !!p.ofrecido_x2, !!p.pregunto_freno,
      !!p.rechazo, p.seguimientos ?? 0, p.ultimo_seguimiento_en ?? null,
    ]);
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

// ---------- rechazo (07-10) ----------

/** "No" claro en cualquier largo de mensaje. */
const RE_RECHAZO: RegExp[] = [
  /^(?:no+|nop|nel|nah)[\s,.!]*(?:gracias|grs|grx|grax|muchas gracias)\b/u,
  /\bno(?: me| nos)? (?:interesa|intereso)\b/u,
  /\bno (?:estoy|toy|estamos) interesad[oa]s?\b/u,
  /\bya no (?:quiero|me interesa|necesito|voy a (?:comprar|querer))\b/u,
  /\b(?:no me (?:escribas|escriban|molest)|deja(?:n)? de (?:escribir|mandar)\w*|no (?:me )?manden mas)\b/u,
  /\b(?:ya (?:lo )?compre en otro lado|ya consegui en otro lado)\b/u,
];
/** "No" que solo cuenta si el mensaje es corto ("no quiero", "no lo necesito"): en un mensaje largo puede ser otra cosa ("no quiero que ronque"). */
const RE_RECHAZO_CORTO = /^(?:no|nop|nel)?[\s,.!]*no (?:lo |la |los |las )?(?:quiero|necesito)(?: nada| comprar| gracias)?[\s.!]*$/u;

/**
 * true si el cliente dijo claramente que no quiere comprar. Determinista y conservador: "por ahora no" o
 * "después te aviso" NO son rechazo (ahí el recontacto sirve).
 */
export function esRechazo(texto: string): boolean {
  const t = normalizar(texto).replace(/[¿?¡]/g, " ").replace(/\s+/g, " ").trim();
  if (!t) return false;
  if (RE_RECHAZO.some((re) => re.test(t))) return true;
  return t.length <= 40 && RE_RECHAZO_CORTO.test(t);
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
    l.push("PERFIL: todavía sin detectar. Si nombró un producto, dale el precio; si no sabés qué le sirve, hacé UNA pregunta corta de diagnóstico y llamá registrar_perfil cuando lo sepas.");
  }
  if (p.producto) {
    l.push(`PRODUCTO ELEGIDO: ${p.producto}${p.cantidad ? ` x${p.cantidad}` : ""}. No le vuelvas a preguntar qué producto quiere.`);
  } else {
    l.push("PRODUCTO: todavía sin elegir. Cuando lo nombre, anotalo con registrar_perfil (producto y cantidad).");
  }
  if (p.ofrecido_x2) l.push("YA OFRECISTE EL ×2: no lo vuelvas a ofrecer salvo que el cliente lo pida.");
  if (p.pregunto_freno) l.push("YA PREGUNTASTE QUÉ LO FRENA: no insistas; respondé solo lo que pregunte.");
  if (p.rechazo) l.push("EL CLIENTE YA DIJO QUE NO: no insistas con la venta; respondé solo lo que pregunte.");
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
