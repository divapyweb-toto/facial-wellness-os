// _shared/vendedor/filtro_salida.ts · Dueño: G1 (ola 2)
// Regla dura del servidor sobre TODO texto que el vendedor con IA le va a mandar al cliente.
// No depende del modelo: si falla, el orquestador regenera una vez y, si vuelve a fallar, deriva a Enrique.
//
// Revisa: palabras prohibidas (config_wa.palabras_prohibidas), precios que no salieron del catálogo
// de ESTA conversación, promesas de salud, más de 3 líneas, más de 1 pregunta, más de 1 emoji.
// Y que no suene a bot (config_wa.vendedor_estilo): muletillas de bot ("¡Claro!", "No dudes en"...), formato
// markdown (**negrita**, viñetas), saludo vacío como primera línea, "¡" al inicio de varias frases, urgencia o
// stock inventados, negar ser un asistente virtual, anunciarse como IA sin que pregunten, o no decirlo cuando
// el cliente pregunta directamente si es un bot, e insistir con "¿qué te frena?".
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
  /** Muletillas de bot (config_wa.vendedor_estilo.muletillas). */
  muletillas?: string[];
  /** Frases de urgencia, stock o reseñas inventadas (config_wa.vendedor_estilo.urgencia). */
  urgencia?: string[];
  /** Frases que niegan ser un asistente virtual (config_wa.vendedor_estilo.niega_ia). */
  niegaIA?: string[];
  /** El cliente preguntó directamente si es un bot: la respuesta TIENE que decir "asistente virtual". */
  preguntaBot?: boolean;
  /** Ya se preguntó "¿qué te frena?" en esta conversación: no se repite. */
  yaPreguntoFreno?: boolean;
  /**
   * 19-10 (paquete 1, punto 2): acciones que una herramienta hizo de verdad en este turno (accionesHechas en
   * w1_vendedor.ts: nombres de herramientas con ok, "crear_pedido_cod:confirmar", "pedido_ya_creado"…). Sin este
   * campo (undefined) no se revisa: así lo usan los textos fijos y los tests viejos.
   */
  accionesHechas?: string[];
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

/** Muletillas de bot (se comparan sin tildes ni mayúsculas; los signos ¡ ¿ cuentan). */
export const MULETILLAS_DEFAULT = [
  "¡claro", "claro!", "por supuesto", "como asistente", "estoy aqui para ayudar", "no dudes en",
  "algo mas en lo que pueda ayudar", "algo mas en que pueda ayudar", "algo mas en lo que te pueda ayudar",
  "en que puedo ayudarte", "en que te puedo ayudar", "en que le puedo ayudar", "en que puedo ayudarle",
  "puedo ayudarte con algo mas", "te ayudo con algo mas", "entiendo tu preocupacion", "entiendo su preocupacion",
  "excelente pregunta", "gran pregunta", "espero haberte ayudado", "espero que esto te ayude", "fue un placer ayudarte",
];

/** Urgencia, stock o reseñas inventadas (Ley 1334, art. 35: publicidad que induce a error). */
export const URGENCIA_DEFAULT = [
  "ultimas unidades", "quedan pocas", "quedan pocos", "pocas unidades", "solo por hoy", "hasta agotar", "se agota",
  "se estan agotando", "tiempo limitado", "antes de que se termine", "el mas vendido", "los mas vendidos",
  "todos lo estan comprando", "miles de clientes", "cientos de clientes", "nuestros clientes dicen", "resenas",
];

/** Negar ser un asistente virtual es mentir (política de WhatsApp): nunca. */
export const NIEGA_IA_DEFAULT = [
  "soy una persona", "soy humano", "soy humana", "no soy un bot", "no soy bot", "no soy un robot", "no soy una ia",
  "no soy una maquina", "no soy inteligencia artificial", "soy de carne y hueso", "soy una persona real",
];

/** Anunciarse como IA sin que el cliente pregunte baja las ventas: solo se dice si preguntan. */
const SE_ANUNCIA_IA = ["asistente virtual", "soy un bot", "soy una ia", "inteligencia artificial", "soy un robot"];

function normalizar(s: string): string {
  return s.normalize("NFD").replace(/\p{M}/gu, "").toLowerCase();
}

function contieneFrase(t: string, lista: string[]): string | null {
  for (const f of lista) {
    const nf = normalizar(String(f ?? "")).trim();
    if (nf && t.includes(nf)) return f;
  }
  return null;
}

/** Formato markdown que WhatsApp no muestra como una persona escribe: **negrita**, __x__, viñetas, títulos, [x](url). */
export function tieneMarkdown(texto: string): string | null {
  if (/\*\*[^*\n]+\*\*/.test(texto)) return "negrita_doble";
  if (/__[^_\n]+__/.test(texto)) return "subrayado";
  if (/(^|\n)\s*[-*•·]\s+\S/.test(texto)) return "vinetas";
  if (/(^|\n)\s*\d{1,2}[.)]\s+\S/.test(texto)) return "lista_numerada";
  if (/(^|\n)\s*#{1,6}\s/.test(texto)) return "titulo";
  if (/\[[^\]]+\]\([^)]+\)/.test(texto)) return "enlace_markdown";
  return null;
}

const RE_SALUDO_VACIO =
  /^(?:hola+|holis|buenas|buen dia|buenos dias|buenas tardes|buenas noches|que tal|hey)(?:[ ,]+[a-zñ]+){0,2}(?: (?:como (?:estas|esta|andas|te va)|que tal))?$/u;

/**
 * Toda la respuesta es solo un saludo ("¡Hola!", "Buenas, ¿cómo estás?"): no avanza la charla.
 * Un saludo corto seguido de otra línea ("Buenas!\n¿Qué producto viste?") sí vale: así escribe Enrique
 * (prueba en vivo 07-10: bloquear el saludo en la primera línea forzaba aperturas raras y derivaba un "Hola").
 */
export function primeraLineaSaludoVacio(texto: string): boolean {
  const lineas = (texto ?? "").trim().split(/\n/).map((l) =>
    normalizar(l).replace(/[\p{Extended_Pictographic}\u{FE0F}\u{200D}]/gu, " ").replace(/[¡!¿?.,;:…]+/g, " ").replace(/\s+/g, " ").trim()
  ).filter(Boolean);
  return lineas.length > 0 && lineas.every((l) => RE_SALUDO_VACIO.test(l));
}

/** Frases que arrancan con "¡" (al inicio del texto o después de . ! ? o salto de línea). */
export function frasesConExclamacionInicial(texto: string): number {
  return ((texto ?? "").match(/(?:^|[.!?…\n]\s*)¡/g) ?? []).length;
}

// ---------- acciones inventadas ----------

/**
 * 19-10 (informe 02 §3a, #1072: "¿Te lo cambio a 2?" sin herramienta para cambiarlo): frases que dicen que se hizo
 * (o que se va a hacer) un cambio en un pedido. Solo pasan si en el mismo turno corrió con ok una herramienta que lo
 * hace. Se comparan sin tildes; una negación delante ("no lo cambié") no cuenta.
 */
export const ACCIONES_INVENTADAS: Array<{ accion: string; re: RegExp; permiten: string[] }> = [
  {
    accion: "cambio",
    re: /\b(?:(?:ya )?(?:te |se )?(?:lo|la|los|las) (?:cambio|cambie|cambiamos|modifico|modifique|modificamos|actualice|actualizamos)|ya (?:te )?(?:cambie|modifique|actualice))\b|\b(?:quedo|quedaron|ya esta|ya estan) (?:cambiad|modificad|actualizad)[oa]s?\b/,
    permiten: ["modificar_pedido", "actualizar_direccion", "programar_entrega", "guardar_factura"],
  },
  {
    accion: "agregado",
    re: /\b(?:(?:ya )?(?:te )?(?:lo|la|los|las) (?:agregue|agregamos|sume|sumamos)|ya (?:te )?(?:agregue|sume)|te (?:lo|la|los|las) (?:agrego|sumo))\b|\b(?:quedo|quedaron|ya esta|ya estan) (?:agregad|sumad)[oa]s?\b/,
    permiten: ["modificar_pedido", "guardar_factura", "actualizar_direccion"],
  },
  {
    accion: "cancelacion",
    re: /\b(?:(?:ya )?(?:te )?(?:lo|la) (?:cancele|cancelamos|cancelo)|ya (?:te )?cancele)\b|\b(?:quedo|ya esta|esta) cancelad[oa]\b/,
    permiten: ["modificar_pedido", "cancelar_pedido", "estado_pedido", "buscar_pedido"],
  },
  {
    // crear_pedido_cod con confirmar=true confirma de verdad; estado_pedido / buscar_pedido pueden devolver que ya está
    // confirmado; un pedido del bot ya creado o la marca del sistema "[pedido … CONFIRMADO" también lo respaldan.
    accion: "confirmacion",
    re: /\b(?:quedo confirmad[oa]|(?:ya )?esta confirmad[oa]|ya (?:te )?(?:lo|la) confirme|ya confirme|pedido confirmado|quedo (?:cargad|registrad)[oa])\b/,
    permiten: [
      "crear_pedido_cod:confirmar", "modificar_pedido", "estado_pedido", "buscar_pedido", "guardar_factura", "actualizar_direccion",
      "pedido_ya_creado", "pedido_confirmado_sistema",
    ],
  },
  {
    accion: "programacion",
    re: /\b(?:quedo (?:programad|agendad)[oa]|ya (?:te )?(?:lo|la) (?:programe|agende)|ya (?:programe|agende))\b/,
    permiten: ["programar_entrega", "crear_pedido_cod:confirmar", "modificar_pedido"],
  },
];

/** Primera acción inventada del texto ("cambio:lo cambie"), o null. */
export function accionInventada(texto: string, hechas: string[]): string | null {
  const t = normalizar(texto ?? "").replace(/[¡!¿?.,;:…]+/g, " ").replace(/\s+/g, " ");
  const set = new Set(hechas);
  for (const a of ACCIONES_INVENTADAS) {
    if (a.permiten.some((h) => set.has(h))) continue;
    for (const m of t.matchAll(new RegExp(a.re.source, "g"))) {
      // "no lo cambié", "no te lo cancelo": una negación delante no es una acción.
      if (/\bno (?:te |se |le )?(?:lo |la |los |las )?$/.test(t.slice(0, m.index))) continue;
      return `${a.accion}:${m[0].trim()}`;
    }
  }
  return null;
}

/** Instrucción exacta para la regeneración cuando el motivo fue una acción inventada. */
export const INSTRUCCION_ACCION_INVENTADA =
  "No confirmes cambios que no hiciste con una herramienta: decí en la primera línea que eso no lo podés hacer desde acá y ofrecé la alternativa real.";

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

const DIA_FUTURO = "(?:el|la|este|esta|proximo|proxima|a fin|fin de|manana|lunes|martes|miercoles|jueves|viernes|sabado|domingo|\\d{1,2}/\\d{1,2}|\\d{1,2} de)";
const RE_PROMESA = [
  new RegExp(`\\b(?:te|le) (?:escribo|vuelvo a escribir|hablo|contacto|mando un mensaje)\\b[^.?!\\n]{0,25}\\b${DIA_FUTURO}\\b`),
  new RegExp(`\\b${DIA_FUTURO}\\b[^.?!\\n]{0,25}\\b(?:te|le) (?:escribo|vuelvo a escribir|hablo|contacto)\\b`),
];
/** 19-10: promesa de escribirle otro día (texto ya normalizado: minúsculas y sin tildes). null si no hay. */
export function promesaRecontacto(nt: string): string | null {
  for (const re of RE_PROMESA) {
    const m = re.exec(nt);
    if (m) return m[0].trim().slice(0, 60);
  }
  return null;
}

/** 19-10: saca las frases con promesa de recontacto (si el modelo insiste, no se deriva a Enrique por esto). */
export function quitarPromesaRecontacto(texto: string): string {
  const norm = (x: string) => x.normalize("NFD").replace(/\p{M}/gu, "").toLowerCase();
  const frases = texto.split(/(?<=[.!?\n])\s+/).filter((f) => !promesaRecontacto(norm(f)));
  const limpio = frases.join(" ").trim();
  return limpio || "Cuando estés listo escribime por acá y lo armamos.";
}

/**
 * 21-10: saca las frases con montos que no salen del catálogo (precio_no_catalogo:N). "" si no queda nada. Se usa solo
 * cuando la IA, al regenerar, devolvió vacío: el resto de su primera respuesta (pedido de datos, beneficio) sale igual.
 */
export function quitarFrasesConMontos(texto: string, montos: number[]): string {
  const malos = new Set(montos);
  return texto.split(/(?<=[.!?\n\p{Extended_Pictographic}])\s+/u).filter((f) => !extraerMontos(f).some((n) => malos.has(n))).join(" ").trim();
}

export const INSTRUCCION_PROMESA_RECONTACTO =
  "No prometas escribirle otro día (pasadas 24 h WhatsApp no te deja). Decile \"cuando estés listo escribime por acá y lo armamos\" " +
  "o, si dio un día, ofrecé dejarlo programado para ese día con programar_entrega. El día ya quedó anotado.";

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

  // Que no suene a bot.
  const nt = normalizar(t);
  const muletilla = contieneFrase(nt, op.muletillas ?? MULETILLAS_DEFAULT);
  if (muletilla) motivos.push(`muletilla_bot:${muletilla}`);
  const md = tieneMarkdown(t);
  if (md) motivos.push(`markdown:${md}`);
  if (primeraLineaSaludoVacio(t)) motivos.push("saludo_vacio");
  if (frasesConExclamacionInicial(t) >= 2) motivos.push("exclamaciones_de_bot");
  const urg = contieneFrase(nt, op.urgencia ?? URGENCIA_DEFAULT);
  if (urg) motivos.push(`urgencia_inventada:${urg}`);
  const niega = contieneFrase(nt, op.niegaIA ?? NIEGA_IA_DEFAULT);
  if (niega) motivos.push(`niega_ser_asistente:${niega}`);
  if (op.preguntaBot) {
    if (!nt.includes("asistente virtual")) motivos.push("honestidad:falta_asistente_virtual");
  } else {
    const anuncia = contieneFrase(nt, SE_ANUNCIA_IA);
    if (anuncia) motivos.push(`se_anuncia_como_ia:${anuncia}`);
  }
  if (op.yaPreguntoFreno && /que te frena|que le frena/.test(nt)) motivos.push("insiste_que_te_frena");
  // 19-10 (paquete 1, punto 6): "el viernes 30/10 te escribo" casi siempre cae fuera de las 24 h y WhatsApp no deja
  // escribir libre (caso real del 19-10, 3 de 3 promesas vencidas sin mandar). El día de recontacto lo anota
  // registrar_perfil y ese día seguimiento-chat avisa a Enrique.
  const promesa = promesaRecontacto(nt);
  if (promesa) motivos.push(`promesa_recontacto:${promesa}`);
  if (op.accionesHechas) {
    const inv = accionInventada(t, op.accionesHechas);
    if (inv) motivos.push(`accion_inventada:${inv}`);
  }

  return { ok: motivos.length === 0, motivos };
}
