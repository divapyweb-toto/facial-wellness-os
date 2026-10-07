#!/usr/bin/env node
// Plantillas de WhatsApp de Voltra (ola 1).
//
//   node scripts/crear-plantillas-wa.mjs            → solo valida e imprime
//   node scripts/crear-plantillas-wa.mjs --enviar   → valida y manda a aprobación de Meta
//
// Con --enviar usa WA_TOKEN y WA_WABA_ID desde variables de entorno (nunca desde un archivo).
// Lee supabase/plantillas/*.json. Las claves que empiezan con "_" (notas) no se mandan a Meta.
// Las palabras prohibidas se leen de supabase/seed_config_wa.sql (config_wa), no del código.

import { readFileSync, readdirSync } from 'node:fs';
import { join, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';

const RAIZ = join(dirname(fileURLToPath(import.meta.url)), '..');
export const DIR_PLANTILLAS = join(RAIZ, 'supabase', 'plantillas');
const SEED = join(RAIZ, 'supabase', 'seed_config_wa.sql');
const GRAPH = 'https://graph.facebook.com/v25.0';

// Límites de Meta (documentación vigente, oct-2026) y reglas propias.
export const LIMITES = {
  cuerpo: 1024,          // Meta: BODY máx. 1024 caracteres
  pie: 60,               // Meta: FOOTER máx. 60
  nombre: 512,           // Meta: nombre máx. 512, minúsculas, números y _
  botonesMeta: 10,       // Meta: hasta 10 botones por plantilla
  botonesProyecto: 3,    // Regla propia: con más de 3, WhatsApp los esconde en una lista
  etiquetaMeta: 25,      // Meta: QUICK_REPLY máx. 25 caracteres
  etiquetaProyecto: 20,  // Regla propia: la misma etiqueta se usa en botones interactivos (máx. 20) dentro de la ventana
  palabrasPorVariable: 3 // Heurística propia: Meta rechaza "demasiadas variables para el largo" sin publicar el número
};

/** Único prefijo de nombre que puede usar categoría MARKETING. */
export const PREFIJO_MARKETING = 'voltra_mk_';

export function cargarPalabrasProhibidas(rutaSeed = SEED) {
  const sql = readFileSync(rutaSeed, 'utf8');
  const m = sql.match(/'palabras_prohibidas'\s*,\s*'(\[[^']*\])'/);
  if (!m) throw new Error(`No encontré palabras_prohibidas en ${rutaSeed}`);
  return JSON.parse(m[1]);
}

const normalizar = (s) => s.normalize('NFD').replace(/[̀-ͯ]/g, '').toLowerCase();

/** Devuelve la palabra prohibida encontrada (inicio de palabra, sin tildes ni mayúsculas) o null. */
export function buscarProhibida(texto, lista) {
  const t = normalizar(texto);
  for (const p of lista) {
    const patron = normalizar(p).replace(/[.*+?^${}()|[\]\\]/g, '\\$&').replace(/\s+/g, '\\s+');
    if (new RegExp(`(^|[^a-z0-9])${patron}`).test(t)) return p;
  }
  return null;
}

export function cargarPlantillas(dir = DIR_PLANTILLAS) {
  return readdirSync(dir)
    .filter((f) => f.endsWith('.json'))
    .sort()
    .map((archivo) => ({ archivo, plantilla: JSON.parse(readFileSync(join(dir, archivo), 'utf8')) }));
}

/** Valida una plantilla. Devuelve la lista de errores (vacía = OK). */
export function validarPlantilla(p, palabras, archivo = '') {
  const e = [];
  const nombre = p?.name ?? '';
  if (!/^[a-z0-9_]+$/.test(nombre) || nombre.length > LIMITES.nombre) e.push(`nombre inválido: "${nombre}"`);
  if (!nombre.startsWith('voltra_')) e.push('el nombre debe empezar con voltra_');
  if (archivo && archivo !== `${nombre}.json`) e.push(`el archivo debería llamarse ${nombre}.json`);
  if (p.language !== 'es') e.push(`idioma "${p.language}": usar "es" (no existe es_PY)`);
  // MARKETING solo para voltra_mk_* (ofertas con opt-in) y esas no pueden ir como UTILITY; el resto, UTILITY.
  const categoriaEsperada = nombre.startsWith(PREFIJO_MARKETING) ? 'MARKETING' : 'UTILITY';
  if (p.category !== categoriaEsperada) {
    e.push(`categoría "${p.category}": se esperaba ${categoriaEsperada} (MARKETING solo con prefijo ${PREFIJO_MARKETING}; el resto es de utilidad)`);
  }
  if (!Array.isArray(p.components)) return [...e, 'falta components'];

  const tipos = p.components.map((c) => c.type);
  if (new Set(tipos).size !== tipos.length) e.push('componentes repetidos');
  const cuerpo = p.components.find((c) => c.type === 'BODY');
  if (!cuerpo?.text) return [...e, 'falta el BODY'];
  const texto = cuerpo.text;

  if (texto.length > LIMITES.cuerpo) e.push(`cuerpo de ${texto.length} caracteres (máx. ${LIMITES.cuerpo})`);
  if (/[{}]/.test(texto.replace(/\{\{\d+\}\}/g, ''))) e.push('llaves sueltas o variables mal escritas');

  const nums = [...texto.matchAll(/\{\{(\d+)\}\}/g)].map((m) => Number(m[1]));
  const unicos = [...new Set(nums)];
  if (nums.length !== unicos.length) e.push('variable repetida');
  unicos.forEach((n, i) => { if (n !== i + 1) e.push(`variables fuera de orden: se esperaba {{${i + 1}}} y vino {{${n}}}`); });

  if (unicos.length) {
    if (/^\s*\{\{\d+\}\}/.test(texto)) e.push('el texto no puede empezar con una variable');
    if (/\{\{\d+\}\}[\s.,;:!?¡¿)]*$/.test(texto)) e.push('el texto no puede terminar con una variable');
    if (/\}\}\s*\{\{/.test(texto)) e.push('dos variables pegadas');
    const palabrasFijas = texto.replace(/\{\{\d+\}\}/g, ' ').split(/\s+/).filter((w) => /\p{L}/u.test(w)).length;
    if (palabrasFijas < unicos.length * LIMITES.palabrasPorVariable) e.push('demasiadas variables para el largo del texto');

    const ej = cuerpo.example?.body_text;
    if (!Array.isArray(ej) || !Array.isArray(ej[0])) e.push('faltan los ejemplos (example.body_text)');
    else {
      if (ej[0].length !== unicos.length) e.push(`${unicos.length} variables y ${ej[0].length} ejemplos`);
      ej[0].forEach((v, i) => {
        if (typeof v !== 'string' || !v.trim()) e.push(`ejemplo {{${i + 1}}} vacío`);
        else if (/[\n\t]| {5,}/.test(v)) e.push(`ejemplo {{${i + 1}}} con saltos de línea o espacios de más`);
      });
    }
  } else if (cuerpo.example) e.push('ejemplos sin variables');

  const pie = p.components.find((c) => c.type === 'FOOTER');
  if (pie && (pie.text ?? '').length > LIMITES.pie) e.push(`pie de más de ${LIMITES.pie} caracteres`);

  const textos = [texto, pie?.text ?? ''];
  const bloqueBotones = p.components.find((c) => c.type === 'BUTTONS');
  const botones = bloqueBotones?.buttons ?? [];
  if (botones.length > LIMITES.botonesMeta) e.push(`más de ${LIMITES.botonesMeta} botones (límite de Meta)`);
  if (botones.length > LIMITES.botonesProyecto) e.push(`más de ${LIMITES.botonesProyecto} botones`);
  const etiquetas = new Set();
  for (const b of botones) {
    if (b.type !== 'QUICK_REPLY') e.push(`botón "${b.text}": solo QUICK_REPLY`);
    const t = b.text ?? '';
    if (!t.trim()) e.push('botón sin texto');
    if (t.length > LIMITES.etiquetaMeta) e.push(`botón "${t}" de más de ${LIMITES.etiquetaMeta} caracteres (límite de Meta)`);
    else if (t.length > LIMITES.etiquetaProyecto) e.push(`botón "${t}" de más de ${LIMITES.etiquetaProyecto} caracteres`);
    if (etiquetas.has(t)) e.push(`botón repetido "${t}"`);
    etiquetas.add(t);
    textos.push(t);
  }
  const payloads = p._notas?.botones_payload ?? [];
  if (payloads.length !== botones.length) e.push('_notas.botones_payload no coincide con los botones');
  payloads.forEach((x) => { if (!/^[a-z_]+$/.test(x)) e.push(`payload "${x}" inválido`); });
  if ((p._notas?.variables ?? []).length !== unicos.length) e.push('_notas.variables no coincide con las variables');

  for (const t of [...textos, ...(cuerpo.example?.body_text?.[0] ?? [])]) {
    const mala = buscarProhibida(String(t), palabras);
    if (mala) e.push(`palabra prohibida "${mala}" en "${t}"`);
  }
  return e;
}

/** Cuerpo que se manda a Meta: sin las claves de notas ("_..."). */
export function cuerpoParaMeta(p) {
  return Object.fromEntries(Object.entries(p).filter(([k]) => !k.startsWith('_')));
}

export function validarTodas(dir = DIR_PLANTILLAS, rutaSeed = SEED) {
  const palabras = cargarPalabrasProhibidas(rutaSeed);
  return cargarPlantillas(dir).map(({ archivo, plantilla }) => ({
    archivo, plantilla, errores: validarPlantilla(plantilla, palabras, archivo)
  }));
}

async function enviar(plantilla, token, waba) {
  const r = await fetch(`${GRAPH}/${waba}/message_templates`, {
    method: 'POST',
    headers: { Authorization: `Bearer ${token}`, 'Content-Type': 'application/json' },
    body: JSON.stringify(cuerpoParaMeta(plantilla))
  });
  const j = await r.json().catch(() => ({}));
  return r.ok
    ? `OK id=${j.id} estado=${j.status} categoría=${j.category}`
    : `ERROR ${j?.error?.code ?? r.status}: ${j?.error?.error_user_msg ?? j?.error?.message ?? r.statusText}`;
}

async function main() {
  const conEnviar = process.argv.includes('--enviar');
  const resultados = validarTodas();
  let fallas = 0;
  for (const { archivo, plantilla, errores } of resultados) {
    const cuerpo = plantilla.components?.find((c) => c.type === 'BODY')?.text ?? '';
    const botones = (plantilla.components?.find((c) => c.type === 'BUTTONS')?.buttons ?? []).map((b) => b.text);
    console.log(`\n${errores.length ? 'X' : 'OK'}  ${archivo}  [${plantilla.category}, ${plantilla.language}]`);
    console.log('    ' + cuerpo.replace(/\n/g, '\n    '));
    if (botones.length) console.log(`    Botones: ${botones.join(' | ')}`);
    errores.forEach((x) => console.log(`    - ${x}`));
    if (errores.length) fallas++;
  }
  console.log(`\n${resultados.length - fallas}/${resultados.length} plantillas válidas.`);
  if (fallas) { process.exitCode = 1; return; }
  if (!conEnviar) { console.log('Solo validación. Para mandarlas a aprobación: --enviar'); return; }

  const token = process.env.WA_TOKEN;
  const waba = process.env.WA_WABA_ID;
  if (!token || !waba) {
    console.error('Faltan WA_TOKEN y/o WA_WABA_ID en las variables de entorno.');
    process.exitCode = 1;
    return;
  }
  for (const { plantilla } of resultados) {
    console.log(`${plantilla.name}: ${await enviar(plantilla, token, waba)}`);
  }
}

if (import.meta.main) await main();
