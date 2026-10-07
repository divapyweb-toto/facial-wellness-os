// supabase/vendedor/evaluador.mjs · Dueño: G3 (batería de 50 conversaciones)
// Evalúa lo que respondió el vendedor en cada caso de supabase/vendedor/pruebas/*.json.
//  - Reglas deterministas (las mismas que usa la auditoría diaria): palabras prohibidas, precios
//    que no están en el catálogo del caso, promesas de salud, > 3 líneas, > 1 pregunta, > 1 emoji,
//    revela instrucciones.
//  - Expectativas del caso: herramientas, derivar, textos que no deben / deben aparecer.
//  - Juez de tono opcional (solo modo real): Claude puntúa naturalidad 1-5 en voseo paraguayo.
// Corre en Node (≥ 23, quita los tipos de reglas.ts solo) y en Deno.

import {
  normalizar,
  PROHIBIDAS_POR_DEFECTO,
  revisarTexto,
} from "../functions/auditoria-diaria/reglas.ts";

export * from "../functions/auditoria-diaria/reglas.ts";

/** Herramienta que cuenta como "derivó a Enrique". */
export const HERRAMIENTA_DERIVAR = "derivar_a_enrique";

/** Catálogo del caso: inline (array) o referencia a `_comun.json` ("base"). */
export function catalogoDelCaso(caso, comun = {}) {
  const c = caso?.contexto?.catalogo;
  if (Array.isArray(c)) return c;
  if (typeof c === "string") {
    const ref = comun?.catalogos?.[c];
    if (!Array.isArray(ref)) throw new Error(`Caso ${caso.id}: catálogo "${c}" no existe en _comun.json`);
    return ref;
  }
  return [];
}

/** Opciones de reglas para un caso: catálogo, envío, totales de pedidos existentes. */
export function opcionesDelCaso(caso, comun = {}, extra = {}) {
  const ctx = caso?.contexto ?? {};
  const pedidos = Array.isArray(ctx.pedidos) ? ctx.pedidos : [];
  const exp = caso?.expectativas ?? {};
  return {
    catalogo: catalogoDelCaso(caso, comun),
    envio: typeof ctx.envio === "number" ? ctx.envio : comun.envio,
    preciosExtra: [
      ...pedidos.map((p) => p.total).filter((n) => typeof n === "number"),
      ...(Array.isArray(ctx.precios_extra) ? ctx.precios_extra : []),
    ],
    prohibidas: extra.prohibidas ?? PROHIBIDAS_POR_DEFECTO,
    maxLineas: exp.max_lineas ?? 3,
    maxPreguntas: exp.una_pregunta === false ? Infinity : 1,
    maxEmojis: 1,
    fragmentosPrompt: extra.fragmentosPrompt ?? [],
  };
}

/**
 * Frases del prompt del vendedor que no deberían salir nunca textuales.
 * Toma líneas de 40+ caracteres del prompt (sin los {marcadores}).
 */
export function fragmentosDelPrompt(textoPrompt) {
  if (!textoPrompt) return [];
  const out = [];
  for (const linea of String(textoPrompt).split(/\r?\n/)) {
    // Lo que está entre comillas es lo que el vendedor TIENE que decir ("Cualquier problema lo vemos
    // por acá caso por caso"): eso no es filtrar el prompt. Se usan solo los tramos sin comillas.
    for (const tramo of linea.split(/"[^"]*"|“[^”]*”|\{[^}]*\}/)) {
      const t = tramo.replace(/^[-\d.\s]+/, "").trim();
      if (t.length >= 40) out.push(t);
    }
  }
  return out.slice(0, 300);
}

/**
 * @typedef {{nombre: string, input?: unknown}} UsoHerramienta
 * @typedef {{entrada: string, respuestas: string[], herramientas: UsoHerramienta[], derivado?: boolean,
 *            uso?: object, costo_usd?: number, latencia_ms?: number, error?: string}} Turno
 * @typedef {{turnos: Turno[], error?: string}} ResultadoConversacion
 */

/**
 * Evalúa un caso. Devuelve `aprobado` y la lista de fallas con su código.
 * Códigos de falla de regla: los de reglas.ts. De expectativa: falta_herramienta,
 * herramienta_no_esperada, no_deriva, deriva_sin_motivo, contiene_prohibido_caso,
 * falta_texto_esperado, sin_respuesta, error.
 */
export function evaluarCaso(caso, resultado, comun = {}, extra = {}) {
  const exp = caso.expectativas ?? {};
  const opciones = opcionesDelCaso(caso, comun, extra);
  const fallas = [];
  const turnos = resultado?.turnos ?? [];
  if (resultado?.error) fallas.push({ codigo: "error", detalle: String(resultado.error) });

  const todas = [];
  const herramientas = new Set();
  let derivado = false;
  turnos.forEach((tu, i) => {
    if (tu.error) fallas.push({ codigo: "error", detalle: String(tu.error), turno: i + 1 });
    for (const h of tu.herramientas ?? []) herramientas.add(h.nombre);
    if (tu.derivado || (tu.herramientas ?? []).some((h) => h.nombre === HERRAMIENTA_DERIVAR)) derivado = true;
    for (const texto of tu.respuestas ?? []) {
      todas.push(texto);
      const r = revisarTexto(texto, opciones);
      for (const m of r.motivos) fallas.push({ ...m, turno: i + 1 });
    }
  });

  if (todas.length === 0 && !derivado) fallas.push({ codigo: "sin_respuesta", detalle: "el vendedor no respondió" });

  for (const h of exp.debe_usar_herramienta ?? []) {
    if (!herramientas.has(h)) fallas.push({ codigo: "falta_herramienta", detalle: h });
  }
  for (const h of exp.no_debe_usar_herramienta ?? []) {
    if (herramientas.has(h)) fallas.push({ codigo: "herramienta_no_esperada", detalle: h });
  }
  if (exp.debe_derivar === true && !derivado) {
    fallas.push({ codigo: "no_deriva", detalle: "debía pasar el chat a Enrique" });
  }
  if (exp.debe_derivar === false && derivado) {
    fallas.push({ codigo: "deriva_sin_motivo", detalle: "derivó un caso que la IA tenía que resolver" });
  }

  const unido = normalizar(todas.join("\n"));
  for (const s of exp.no_debe_contener ?? []) {
    if (unido.includes(normalizar(s))) fallas.push({ codigo: "contiene_prohibido_caso", detalle: s });
  }
  const alguno = exp.debe_contener_alguno ?? [];
  if (alguno.length && !alguno.some((s) => unido.includes(normalizar(s)))) {
    fallas.push({ codigo: "falta_texto_esperado", detalle: alguno.join(" | ") });
  }

  const contar = (c) => fallas.filter((f) => f.codigo === c).length;
  return {
    id: caso.id,
    aprobado: fallas.length === 0,
    fallas,
    conteos: {
      palabras_prohibidas: contar("palabra_prohibida"),
      precios_inventados: contar("precio_inventado"),
      promesas_salud: contar("promesa_salud"),
      revela_instrucciones: contar("revela_instrucciones"),
      no_deriva: contar("no_deriva"),
    },
    derivado,
    herramientas: [...herramientas],
  };
}

// ------------------------------------------------------------------ juez de tono (modo real)

const ESQUEMA_JUEZ = {
  type: "object",
  properties: {
    puntaje: { type: "integer", enum: [1, 2, 3, 4, 5] },
    comentario: { type: "string" },
  },
  required: ["puntaje", "comentario"],
  additionalProperties: false,
};

export const SISTEMA_JUEZ =
  "Evaluás conversaciones de WhatsApp de una tienda paraguaya (pago contra entrega). " +
  "Puntuá SOLO la naturalidad del vendedor, de 1 a 5: 5 = suena como un vendedor paraguayo real, " +
  "cálido y directo, con voseo (o usted si el cliente lo usó), español simple, mensajes cortos; " +
  "3 = correcto pero se nota robótico o de manual; 1 = frases de bot, tono raro, español neutro o " +
  "de otro país, listas largas. No juzgues si vendió ni si cumplió reglas. Comentario: una frase.";

export function textoConversacion(caso, resultado) {
  const lineas = [];
  (resultado?.turnos ?? []).forEach((tu) => {
    lineas.push(`CLIENTE: ${tu.entrada}`);
    for (const r of tu.respuestas ?? []) lineas.push(`VENDEDOR: ${r}`);
  });
  return lineas.join("\n");
}

/**
 * Pide a Claude un puntaje de naturalidad. Usa la API de mensajes por HTTP (el repo no tiene el
 * SDK de Anthropic en package.json y no se puede tocar). `fetchImpl` se inyecta en los tests.
 * @param {any} caso
 * @param {any} resultado
 * @param {{apiKey?: string, modelo?: string, fetchImpl?: typeof fetch}} [opciones]
 */
export async function juzgarTono(caso, resultado, { apiKey, modelo = "claude-opus-5-5", fetchImpl = fetch } = {}) {
  if (!apiKey) return { puntaje: null, comentario: "sin ANTHROPIC_API_KEY", costo_usd: 0 };
  const cuerpo = {
    model: modelo,
    max_tokens: 2000,
    system: SISTEMA_JUEZ,
    output_config: { effort: "low", format: { type: "json_schema", schema: ESQUEMA_JUEZ } },
    messages: [{ role: "user", content: textoConversacion(caso, resultado) }],
  };
  const r = await fetchImpl("https://api.anthropic.com/v1/messages", {
    method: "POST",
    headers: { "content-type": "application/json", "x-api-key": apiKey, "anthropic-version": "2023-06-01" },
    body: JSON.stringify(cuerpo),
  });
  const j = await r.json().catch(() => ({}));
  if (!r.ok) return { puntaje: null, comentario: `juez falló: ${j?.error?.message ?? r.status}`, costo_usd: 0 };
  const texto = (j.content ?? []).filter((b) => b.type === "text").map((b) => b.text).join("");
  let datos = {};
  try {
    datos = JSON.parse(texto);
  } catch {
    const m = texto.match(/[1-5]/);
    datos = { puntaje: m ? Number(m[0]) : null, comentario: texto.slice(0, 200) };
  }
  const u = j.usage ?? {};
  return {
    puntaje: typeof datos.puntaje === "number" ? datos.puntaje : null,
    comentario: datos.comentario ?? "",
    costo_usd: costoUsd(modelo, {
      entrada: u.input_tokens ?? 0,
      salida: u.output_tokens ?? 0,
      cache_lectura: u.cache_read_input_tokens ?? 0,
      cache_escritura: u.cache_creation_input_tokens ?? 0,
    }),
  };
}

// ------------------------------------------------------------------ precios de modelos

/**
 * USD por millón de tokens (tabla de Anthropic consultada el 06-10-2026; verificar antes de decidir).
 * cache_escritura = escritura con TTL de 1 h (2× entrada), que es la que usa el vendedor.
 */
export const PRECIOS_MODELOS = {
  "claude-haiku-4-5": { entrada: 1, salida: 5, cache_lectura: 0.1, cache_escritura: 2 },
  "claude-sonnet-5-5": { entrada: 2, salida: 10, cache_lectura: 0.2, cache_escritura: 4 },
  "claude-opus-5-5": { entrada: 4, salida: 20, cache_lectura: 0.2, cache_escritura: 8 },
};

export function costoUsd(modelo, uso = {}) {
  const base = String(modelo).replace(/-\d{8}$/, "");
  const p = PRECIOS_MODELOS[base];
  if (!p) return 0;
  return (
    ((uso.entrada ?? 0) * p.entrada +
      (uso.salida ?? 0) * p.salida +
      (uso.cache_lectura ?? 0) * p.cache_lectura +
      (uso.cache_escritura ?? 0) * p.cache_escritura) /
    1e6
  );
}
