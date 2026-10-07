// mejora-mensual/anonimizar.ts · Dueño: M1
// Reemplaza datos personales por códigos antes de que cualquier texto salga hacia Claude.
//   teléfonos (cualquier formato PY, fijos y extranjeros largos) → [TEL_n]
//   nombres conocidos del cliente (y "me llamo …", "a nombre de …") → [NOMBRE_n]
//   direcciones (conocidas y por palabras clave: calle, avda., barrio, c/, esq., km, ruta…) → [DIR_n]
//   CI / RUC / números largos sin moneda → [DOC_n]
//   números de pedido (#1001, "pedido 1234", VT-123, IDs de Shopify) → [PEDIDO_n]
//   emails → [EMAIL_n] · enlaces (wa.me, maps, cualquier URL) → [URL_n]
// El mismo dato recibe el mismo código en toda la conversación (se pasa `ctx.mapa` entre mensajes).
// Precios ("Gs 129.000", "129.000 gs", "199 mil", "129.000") se conservan: son la materia del análisis.
// Lógica pura, sin I/O.
import { normalizarTelefonoPY } from "../_shared/telefono.ts";

export type TipoDato = "TEL" | "NOMBRE" | "DIR" | "DOC" | "PEDIDO" | "EMAIL" | "URL";

/** Clave interna normalizada → código. Vive solo en memoria; nunca se manda ni se guarda. */
export type MapaAnon = {
  codigos: Record<string, string>;
  contadores: Partial<Record<TipoDato, number>>;
};

export type ContextoAnon = {
  /** Nombres conocidos del cliente (wa_clientes.nombre, wa_username, nombre del pedido…). */
  nombres?: (string | null | undefined)[];
  /** Teléfonos conocidos (cualquier formato). Los PY se detectan igual aunque no estén acá. */
  telefonos?: (string | null | undefined)[];
  /** Direcciones conocidas (dirección y referencia del pedido). */
  direcciones?: (string | null | undefined)[];
  /** Números de pedido conocidos ('#1001', '1001', id de Shopify). */
  pedidos?: (string | number | null | undefined)[];
  /** Documentos conocidos (CI / RUC). */
  documentos?: (string | null | undefined)[];
  /** Mapa de la conversación (para códigos consistentes entre mensajes). */
  mapa?: MapaAnon;
};

export function mapaVacio(): MapaAnon {
  return { codigos: {}, contadores: {} };
}

const RE_CODIGO = /\[(?:TEL|NOMBRE|DIR|DOC|PEDIDO|EMAIL|URL)_\d+\]/g;

// ---------- utilidades ----------

export function quitarAcentos(s: string): string {
  return s.normalize("NFD").replace(/\p{M}/gu, "");
}

function normalizarClave(s: string): string {
  return quitarAcentos(s).toLowerCase().replace(/[^\p{L}\p{N}]+/gu, " ").trim();
}

function escaparRegex(s: string): string {
  return s.replace(/[.*+?^${}()|[\]\\/]/g, "\\$&");
}

const CLASES: Record<string, string> = {
  a: "[aáàäâã]",
  e: "[eéèëê]",
  i: "[iíìïî]",
  o: "[oóòöôõ]",
  u: "[uúùüû]",
  n: "[nñ]",
  c: "[cç]",
};

/** Patrón que ignora acentos, mayúsculas y separadores entre palabras. */
function patronFlexible(s: string): string {
  const tokens = normalizarClave(s).split(" ").filter(Boolean);
  return tokens.map((t) => [...t].map((ch) => CLASES[ch] ?? escaparRegex(ch)).join("")).join("[^\\p{L}\\p{N}]+");
}

const B_IZQ = "(?<![\\p{L}\\p{N}])";
const B_DER = "(?![\\p{L}\\p{N}])";

function codigo(mapa: MapaAnon, tipo: TipoDato, clave: string): string {
  const k = `${tipo}:${clave}`;
  const ya = mapa.codigos[k];
  if (ya) return ya;
  const n = (mapa.contadores[tipo] ?? 0) + 1;
  mapa.contadores[tipo] = n;
  const c = `[${tipo}_${n}]`;
  mapa.codigos[k] = c;
  return c;
}

/** Aplica `fn` solo sobre los tramos que no son códigos ya puestos. */
function fueraDeCodigos(texto: string, fn: (tramo: string) => string): string {
  let out = "";
  let ultimo = 0;
  for (const m of texto.matchAll(RE_CODIGO)) {
    out += fn(texto.slice(ultimo, m.index)) + m[0];
    ultimo = m.index! + m[0].length;
  }
  return out + fn(texto.slice(ultimo));
}

function reemplazar(texto: string, re: RegExp, fn: (m: RegExpExecArray | RegExpMatchArray) => string): string {
  return fueraDeCodigos(texto, (tramo) => tramo.replace(re, (...args) => {
    // args: match, ...grupos, offset, string, [groups]
    const conGrupos = typeof args[args.length - 1] === "object" && args[args.length - 1] !== null;
    const grupos = args.slice(0, conGrupos ? -3 : -2) as string[];
    return fn(grupos as unknown as RegExpMatchArray);
  }));
}

// ---------- listas ----------

const PALABRAS_VACIAS = new Set([
  "del", "las", "los", "con", "por", "para", "que", "una", "uno", "the", "san", "santa", "sra", "sr",
  "señor", "señora", "senor", "senora", "doña", "dona", "don", "voltra", "cliente",
]);

/** Palabras que no son nombre aunque sigan a "me llamo" / "a nombre de" (cortan la captura). */
const CORTAN_NOMBRE = new Set([
  "y", "e", "de", "del", "la", "el", "los", "las", "que", "por", "para", "con", "en", "a", "al", "mi", "su",
  "tu", "es", "soy", "pero", "porque", "gracias", "hola", "buenas", "buen", "dia", "día", "tarde", "noche",
  "quiero", "queria", "quería", "necesito", "te", "le", "lo", "me", "se", "ya", "si", "sí", "no", "favor",
  "pf", "pls", "ok", "dale", "bueno", "entonces", "pedido", "pedi", "pedí", "compra", "compre", "compré",
]);

/** Tokens de direcciones que no identifican a nadie (no se tachan sueltos). */
const TOKENS_DIR_GENERICOS = new Set([
  "calle", "avenida", "avda", "barrio", "casa", "numero", "nro", "esquina", "casi", "entre", "frente", "lado",
  "ruta", "km", "kilometro", "centro", "ciudad", "este", "oeste", "norte", "sur", "asuncion", "encarnacion",
  "luque", "lambare", "capiata", "fernando", "mora", "limpio", "nemby", "villa", "elisa", "hernandarias",
  "franco", "minga", "guazu", "concepcion", "pedro", "caballero", "coronel", "oviedo", "villarrica",
  "caaguazu", "itaugua", "aregua", "paraguari", "pilar", "caacupe", "lorenzo", "mariano", "roque", "alonso",
  "presidente", "paraguay", "departamento", "alto", "parana", "central", "referencia", "porton", "portón",
  "color", "blanco", "negro", "verde", "azul", "rojo", "amarillo", "gris", "muralla", "muro", "piso", "dpto",
  "edificio", "local", "zona", "cerca", "detras", "atras", "escuela", "colegio", "iglesia", "supermercado",
]);

const ABREVIATURAS = new Set([
  "mcal", "avda", "av", "gral", "dr", "dra", "tte", "cnel", "sta", "sto", "pdte", "nro", "esq", "bo", "km",
  "c", "cap", "ing", "prof", "lic", "sgto", "cte", "nº", "n°", "no",
]);

// ---------- pasadas ----------

function pasadaUrlsYEmails(t: string, mapa: MapaAnon): string {
  t = reemplazar(t, /\b(?:https?:\/\/|www\.)\S+|\b(?:wa\.me|api\.whatsapp\.com|maps\.app\.goo\.gl|goo\.gl\/maps|maps\.google\.\w+)\/?\S*/gi,
    (m) => codigo(mapa, "URL", m[0].toLowerCase()));
  t = reemplazar(t, /[\p{L}\p{N}._%+-]+@[\p{L}\p{N}-]+(?:\.[\p{L}\p{N}-]+)+/gu,
    (m) => codigo(mapa, "EMAIL", m[0].toLowerCase()));
  // Coordenadas sueltas (-25.5097, -54.6111) = ubicación.
  t = reemplazar(t, /-?\d{1,2}\.\d{3,}\s*,\s*-?\d{1,3}\.\d{3,}/g, (m) => codigo(mapa, "DIR", m[0].replace(/\s/g, "")));
  return t;
}

function pasadaConocidos(t: string, ctx: ContextoAnon, mapa: MapaAnon): string {
  // Pedidos conocidos: '#1001', '1001', id largo.
  for (const p of ctx.pedidos ?? []) {
    if (p === null || p === undefined) continue;
    const d = String(p).replace(/\D/g, "");
    if (d.length < 3) continue;
    const re = new RegExp(`(?<![\\p{N}])#?\\s?${d}(?![\\p{N}])`, "gu");
    t = reemplazar(t, re, () => codigo(mapa, "PEDIDO", d));
  }
  // Documentos conocidos, con o sin puntos.
  for (const doc of ctx.documentos ?? []) {
    if (!doc) continue;
    const d = doc.replace(/\D/g, "");
    if (d.length < 5) continue;
    const re = new RegExp(`(?<![\\p{N}])${[...d].join("[.\\s]?")}(?:-\\d)?(?![\\p{N}])`, "gu");
    t = reemplazar(t, re, () => codigo(mapa, "DOC", d.slice(0, 8)));
  }
  // Direcciones conocidas: completa primero, después sus palabras distintivas.
  for (const dir of ctx.direcciones ?? []) {
    if (!dir || normalizarClave(dir).length < 4) continue;
    const clave = normalizarClave(dir);
    const cod = codigo(mapa, "DIR", clave);
    t = reemplazar(t, new RegExp(B_IZQ + patronFlexible(dir) + B_DER, "giu"), () => cod);
    for (const tok of clave.split(" ")) {
      if (tok.length < 5 || TOKENS_DIR_GENERICOS.has(tok) || /^\d+$/.test(tok)) continue;
      t = reemplazar(t, new RegExp(B_IZQ + patronFlexible(tok) + B_DER, "giu"), () => cod);
    }
    // Números de casa de la dirección (3+ dígitos).
    for (const num of dir.match(/\d{3,}/g) ?? []) {
      t = reemplazar(t, new RegExp(`(?<![\\p{N}])${num}(?![\\p{N}])`, "gu"), () => cod);
    }
  }
  // Nombres conocidos: un código por persona; nombre completo y cada palabra.
  for (const nombre of ctx.nombres ?? []) {
    if (!nombre) continue;
    const clave = normalizarClave(nombre.replace(/[_\d]+/g, " "));
    const tokens = clave.split(" ").filter((x) => x.length >= 3 && !PALABRAS_VACIAS.has(x));
    if (!tokens.length) continue;
    const cod = codigo(mapa, "NOMBRE", tokens.join(" "));
    // El usuario de WhatsApp tal cual (maria_gonzalez99), antes que sus partes.
    if (/[_\d]/.test(nombre) && nombre.length >= 4) {
      t = reemplazar(t, new RegExp(escaparRegex(nombre), "gi"), () => cod);
    }
    t = reemplazar(t, new RegExp(B_IZQ + patronFlexible(tokens.join(" ")) + B_DER, "giu"), () => cod);
    for (const tok of tokens) {
      t = reemplazar(t, new RegExp(B_IZQ + patronFlexible(tok) + "(?![\\p{L}])", "giu"), () => cod);
    }
  }
  return t;
}

/** "me llamo Ana Pérez", "mi nombre es …", "a nombre de …", "nombre: …" → [NOMBRE_n]. */
function pasadaNombresPorFrase(t: string, mapa: MapaAnon): string {
  const re = /(?<![\p{L}])(me llamo|mi nombre es|mi nombre:|a nombre de|nombre\s*:|nombre y apellido\s*:?|soy la señora|soy el señor)([^\S\n]*)([\p{L}'’]+(?:[^\S\n]+[\p{L}'’]+){0,3})/giu;
  return reemplazar(t, re, (m) => {
    const [, frase, esp, resto] = m as unknown as string[];
    let fin = 0;
    for (const w of resto.matchAll(/[\p{L}'’]+/gu)) {
      if (CORTAN_NOMBRE.has(quitarAcentos(w[0].toLowerCase()))) break;
      fin = w.index! + w[0].length;
    }
    if (!fin) return m[0];
    const nombre = resto.slice(0, fin);
    const sobra = resto.slice(fin);
    const tokens = normalizarClave(nombre).split(" ").filter((x) => x.length >= 2);
    return `${frase}${esp}${codigo(mapa, "NOMBRE", tokens.join(" "))}${sobra}`;
  });
}

/** Fin de una cláusula de dirección: salto de línea, ; ! ? o ". " + mayúscula que no venga de una abreviatura. */
function finDeClausula(t: string, desde: number, max = 140): number {
  const limite = Math.min(t.length, desde + max);
  for (let i = desde; i < limite; i++) {
    const ch = t[i];
    if (ch === "\n" || ch === ";" || ch === "!" || ch === "?") return i;
    if (ch === "." && /\s/.test(t[i + 1] ?? "") ) {
      const previo = (t.slice(desde, i).match(/([\p{L}°º]+)$/u)?.[1] ?? "").toLowerCase();
      if (ABREVIATURAS.has(quitarAcentos(previo))) continue;
      return i;
    }
    if (ch === "." && i + 1 >= t.length) return i;
  }
  return limite;
}

const RE_INICIO_DIR = new RegExp(
  "(?<![\\p{L}])(" + [
    "mi direcci[oó]n(?: es)?",
    "la direcci[oó]n(?: es)?",
    "direcci[oó]n\\s*:",
    "direcci[oó]n es",
    "calle",
    "avda\\.?",
    "avenida",
    "av\\.",
    "barrio",
    "b[°º]",
    "bo\\.",
    "c\\/",
    "esq\\.?",
    "esquina",
    "entre (?:las )?calles",
    "km\\.?\\s*\\d",
    "kil[oó]metro\\s*\\d",
    "ruta\\s*(?:n[°º]?\\s*)?\\d",
    "frente a",
    "frente al",
    "al lado de",
    "al lado del",
    "detr[aá]s de",
    "detr[aá]s del",
    "casa (?:nro|n[°º]|n[uú]mero)",
    "referencia\\s*:",
    "ref\\.?\\s*:",
    "port[oó]n (?:negro|blanco|verde|azul|rojo|gris|marr[oó]n)",
    "vivo (?:sobre|por|cerca)",
  ].join("|") + ")",
  "giu",
);

function pasadaDirecciones(t: string, mapa: MapaAnon): string {
  return fueraDeCodigos(t, (tramo) => {
    let out = "";
    let i = 0;
    RE_INICIO_DIR.lastIndex = 0;
    let m: RegExpExecArray | null;
    while ((m = RE_INICIO_DIR.exec(tramo))) {
      if (m.index < i) continue;
      const fin = finDeClausula(tramo, m.index + m[0].length);
      const original = tramo.slice(m.index, fin);
      out += tramo.slice(i, m.index) + codigo(mapa, "DIR", normalizarClave(original));
      i = fin;
      RE_INICIO_DIR.lastIndex = fin;
    }
    return out + tramo.slice(i);
  });
}

function pasadaPedidosYDocsPorFrase(t: string, mapa: MapaAnon): string {
  // Códigos de envío / pedido con prefijo (VT-1234, FW-1234).
  t = reemplazar(t, /(?<![\p{L}\p{N}])(?:VT|FW)\s?-?\s?\d{2,}(?![\p{N}])/giu,
    (m) => codigo(mapa, "PEDIDO", m[0].replace(/\D/g, "")));
  // '#1001'
  t = reemplazar(t, /#\s?\d{3,}(?![\p{N}])/gu, (m) => codigo(mapa, "PEDIDO", m[0].replace(/\D/g, "")));
  // "pedido 1234", "orden nro 1234", "pedido n° 1234", "número de pedido: 1234"
  t = reemplazar(
    t,
    /(?<![\p{L}])(pedido|orden|order|compra|n[uú]mero de pedido|nro\.? de pedido)(\s*(?:n[°º]|nro\.?|n[uú]mero|#|:)?\s*)(\d{3,})(?![\p{N}])/giu,
    (m) => {
      const [, pal, sep, num] = m as unknown as string[];
      return `${pal}${sep}${codigo(mapa, "PEDIDO", num)}`;
    },
  );
  // "CI 4.567.890", "cédula: 4567890", "RUC 80012345-6"
  t = reemplazar(
    t,
    /(?<![\p{L}])(c\.?\s?i\.?|c[eé]dula(?: de identidad)?|ruc|documento|doc\.?)(\s*(?:n[°º]|nro\.?|:|es)?\s*)(\d[\d.\s]{3,}\d(?:\s?-\s?\d)?)(?![\p{N}])/giu,
    (m) => {
      const [, pal, sep, num] = m as unknown as string[];
      return `${pal}${sep}${codigo(mapa, "DOC", num.replace(/\D/g, "").slice(0, 8))}`;
    },
  );
  // RUC suelto: 1234567-8 / 80.012.345-6
  t = reemplazar(t, /(?<![\p{N}.\-])\d{1,3}(?:\.?\d{3}){1,2}\s?-\s?\d(?![\p{N}\-])/gu,
    (m) => codigo(mapa, "DOC", m[0].replace(/\D/g, "").slice(0, -1)));
  return t;
}

function esTelefono(d: string): string | null {
  const py = normalizarTelefonoPY(d);
  if (py) return py;
  if (/^0\d{8,9}$/.test(d)) return d; // fijo con código de área (021 123 456, 061 500 600)
  if (/^595\d{8,10}$/.test(d)) return d;
  return null;
}

const RE_MONEDA_ANTES = /(?:gs\.?|₲|pyg|guaran[ií]es?|\$)\s*$/iu;
const RE_MONEDA_DESPUES = /^\s*(?:gs\b|₲|mil\b|guaran|pyg|k\b|lucas?\b)/iu;

function esPrecio(grupo: string, antes: string, despues: string): boolean {
  if (RE_MONEDA_ANTES.test(antes.slice(-8)) || RE_MONEDA_DESPUES.test(despues.slice(0, 10))) return true;
  const d = grupo.replace(/\D/g, "");
  // 129.000 / 1.250.000 / 129000: múltiplo de mil, hasta 7 dígitos.
  return d.length >= 4 && d.length <= 7 && /000$/.test(d);
}

/** Corridas de dígitos (con espacios, guiones, puntos, paréntesis): teléfonos, documentos e IDs. */
function pasadaNumeros(t: string, mapa: MapaAnon): string {
  return fueraDeCodigos(t, (tramo) => {
    const re = /\+?\(?\d[\d.()\-\/ \t]*\d|\d/g;
    let out = "";
    let ultimo = 0;
    for (const m of tramo.matchAll(re)) {
      const base = m.index!;
      const corrida = m[0];
      // grupos de dígitos (con puntos internos) dentro de la corrida
      const grupos: { ini: number; fin: number; txt: string }[] = [];
      for (const g of corrida.matchAll(/\+?\d[\d.]*/g)) {
        const txt = g[0].replace(/\.+$/, "");
        if (!txt) continue;
        const ini = base + g.index!;
        grupos.push({ ini, fin: ini + txt.length, txt });
      }
      const piezas: { ini: number; fin: number; rep: string }[] = [];
      let i = 0;
      while (i < grupos.length) {
        let tomado = false;
        for (let j = Math.min(grupos.length - 1, i + 5); j >= i; j--) {
          const digitos = grupos.slice(i, j + 1).map((g) => g.txt.replace(/\D/g, "")).join("");
          const tel = digitos.length >= 8 ? esTelefono(digitos) : null;
          if (tel) {
            let ini = grupos[i].ini;
            let fin = grupos[j].fin;
            if (tramo[ini - 1] === "(") ini--;
            const tramoTel = tramo.slice(ini, fin);
            if ((tramoTel.match(/\(/g)?.length ?? 0) > (tramoTel.match(/\)/g)?.length ?? 0) && tramo[fin] === ")") fin++;
            piezas.push({ ini, fin, rep: codigo(mapa, "TEL", tel) });
            i = j + 1;
            tomado = true;
            break;
          }
        }
        if (tomado) continue;
        const g = grupos[i];
        const d = g.txt.replace(/\D/g, "");
        const antes = tramo.slice(Math.max(0, g.ini - 12), g.ini);
        const despues = tramo.slice(g.fin, g.fin + 12);
        if (d.length >= 6 && !esPrecio(g.txt, antes, despues)) {
          const tipo: TipoDato = d.length >= 11 ? "PEDIDO" : (/^0\d{8,9}$/.test(d) ? "TEL" : "DOC");
          piezas.push({ ini: g.ini, fin: g.fin, rep: codigo(mapa, tipo, d) });
        }
        i++;
      }
      for (const p of piezas) {
        out += tramo.slice(ultimo, p.ini) + p.rep;
        ultimo = p.fin;
      }
    }
    return out + tramo.slice(ultimo);
  });
}

// ---------- API ----------

/**
 * Anonimiza un texto. Pasá el mismo `ctx.mapa` para todos los mensajes de una conversación:
 * el mismo dato queda con el mismo código. Nunca devuelve el dato crudo.
 */
export function anonimizar(texto: string, ctx: ContextoAnon = {}): { texto: string; mapa: MapaAnon } {
  const mapa = ctx.mapa ?? mapaVacio();
  if (!texto) return { texto: "", mapa };
  // Caracteres invisibles que se usan para "esconder" números (0981\u200B123…).
  let t = texto.replace(/[​-‍⁠﻿]/g, "");
  t = pasadaUrlsYEmails(t, mapa);
  t = pasadaConocidos(t, ctx, mapa);
  t = pasadaNombresPorFrase(t, mapa);
  t = pasadaPedidosYDocsPorFrase(t, mapa);
  t = pasadaDirecciones(t, mapa);
  t = pasadaNumeros(t, mapa);
  return { texto: t, mapa };
}

/**
 * Control final (defensa en profundidad): devuelve los motivos por los que el texto todavía
 * parece tener un dato crudo. Lista vacía = limpio.
 */
export function buscarDatosCrudos(texto: string, ctx: ContextoAnon = {}): string[] {
  const motivos: string[] = [];
  const sinCodigos = texto.replace(RE_CODIGO, " ");
  if (/[\p{L}\p{N}._%+-]+@[\p{L}\p{N}-]+\.[\p{L}]{2,}/u.test(sinCodigos)) motivos.push("email");
  if (/https?:\/\/|www\.|wa\.me/i.test(sinCodigos)) motivos.push("url");
  // Cualquier corrida de 6+ dígitos (ignorando separadores) que no sea un precio.
  for (const m of sinCodigos.matchAll(/\d[\d.\- \t()]*\d/g)) {
    const d = m[0].replace(/\D/g, "");
    if (d.length < 6) continue;
    const antes = sinCodigos.slice(Math.max(0, m.index! - 12), m.index!);
    const despues = sinCodigos.slice(m.index! + m[0].length, m.index! + m[0].length + 12);
    const grupos = m[0].split(/[ \t\-()]+/).filter(Boolean);
    const todosPrecio = grupos.every((g) => g.replace(/\D/g, "").length < 6 || esPrecio(g, antes, despues));
    if (esTelefono(d) || !todosPrecio) motivos.push(`numero:${d.length}`);
  }
  const norm = ` ${normalizarClave(sinCodigos)} `;
  for (const n of ctx.nombres ?? []) {
    for (const tok of normalizarClave((n ?? "").replace(/[_\d]+/g, " ")).split(" ")) {
      if (tok.length >= 3 && !PALABRAS_VACIAS.has(tok) && norm.includes(` ${tok} `)) motivos.push(`nombre:${tok.length}`);
    }
  }
  for (const dir of ctx.direcciones ?? []) {
    const c = normalizarClave(dir ?? "");
    if (c.length >= 4 && norm.includes(` ${c} `)) motivos.push("direccion");
  }
  for (const tel of ctx.telefonos ?? []) {
    const py = tel ? normalizarTelefonoPY(tel) : null;
    if (py && sinCodigos.replace(/\D/g, "").includes(py.slice(4))) motivos.push("telefono_conocido");
  }
  return [...new Set(motivos)];
}
