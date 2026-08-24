// scripts/consulta-lectura.mjs
// ═══════════════════════════════════════════════════════════
// CONSULTA DE SOLO LECTURA A SUPABASE
//
// Un solo lugar para leer datos desde la terminal sin abrir la app. Existe para
// los análisis (precios, entregas, rentabilidad) que necesitan cruzar miles de
// filas y no se pueden hacer a ojo en la pantalla.
//
// Es de solo lectura POR DISEÑO, no por convención: solo hace GET contra
// PostgREST y usa SUPABASE_READONLY_TOKEN. No hay ninguna ruta de código acá
// que pueda escribir, borrar o modificar una fila.
//
// La clave `apikey` SIEMPRE es la anon del proyecto — Supabase solo acepta la
// anon o la service_role en ese header. El token de lectura va en Authorization,
// que es donde PostgREST lee el rol. Mandarlo en los dos headers da el error
// "Invalid API key", que es exactamente el que aparecía antes.
//
// Uso:
//   node scripts/consulta-lectura.mjs --check
//   node scripts/consulta-lectura.mjs ventas "select=*&fecha=gte.2026-06-01&limit=5"
//   node scripts/consulta-lectura.mjs ventas "select=*&fecha=gte.2026-06-01" --csv > /tmp/ventas.csv
//
// El flag --todo pagina de a 1000 hasta traer todo (PostgREST corta ahí).
// ═══════════════════════════════════════════════════════════
import fs from 'node:fs'
import path from 'node:path'
import { fileURLToPath } from 'node:url'

const RAIZ = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..')

// ─── Credenciales ───────────────────────────────────────────
// Se leen de los .env del proyecto, que no van a Git. Nunca se imprimen.
function leerEnv() {
  const env = {}
  for (const archivo of ['.env', '.env.local']) {
    const ruta = path.join(RAIZ, archivo)
    if (!fs.existsSync(ruta)) continue
    for (const linea of fs.readFileSync(ruta, 'utf8').split('\n')) {
      const m = linea.match(/^\s*([A-Z0-9_]+)\s*=\s*(.*)$/)
      if (m) env[m[1]] = m[2].trim().replace(/^["']|["']$/g, '')
    }
  }
  const faltan = ['VITE_SUPABASE_URL', 'VITE_SUPABASE_ANON_KEY', 'SUPABASE_READONLY_TOKEN']
    .filter(k => !env[k])
  if (faltan.length) {
    console.error(`Faltan variables en .env / .env.local: ${faltan.join(', ')}`)
    process.exit(1)
  }
  return env
}

const env = leerEnv()

const headers = {
  apikey: env.VITE_SUPABASE_ANON_KEY,          // identifica el proyecto
  Authorization: `Bearer ${env.SUPABASE_READONLY_TOKEN}`, // identifica el rol
}

// ─── El único verbo que este archivo sabe hacer ─────────────
async function leer(tabla, query) {
  const url = `${env.VITE_SUPABASE_URL}/rest/v1/${tabla}?${query}`
  const r = await fetch(url, { method: 'GET', headers })
  const texto = await r.text()
  if (!r.ok) throw new Error(`HTTP ${r.status} en "${tabla}": ${texto.slice(0, 500)}`)
  return JSON.parse(texto)
}

// Trae TODAS las filas. PostgREST devuelve máximo 1000 por llamada, así que
// pagina con offset hasta que una página vuelve incompleta.
async function leerTodo(tabla, query) {
  const PAGINA = 1000
  const filas = []
  for (let offset = 0; ; offset += PAGINA) {
    const pagina = await leer(tabla, `${query}&limit=${PAGINA}&offset=${offset}`)
    filas.push(...pagina)
    if (pagina.length < PAGINA) return filas
  }
}

// ─── Chequeo de credenciales ────────────────────────────────
// Prueba una fila de cada tabla y reporta qué se puede leer. Sirve para saber
// si el token venció o si a una tabla le falta permiso, sin adivinar.
async function chequear() {
  const tablas = ['ventas', 'entregas', 'productos', 'rendiciones', 'gasto_ads_diario']
  console.log(`Proyecto: ${env.VITE_SUPABASE_URL}\n`)
  let algunaOk = false
  for (const t of tablas) {
    try {
      const filas = await leer(t, 'select=*&limit=1')
      const cols = filas.length ? Object.keys(filas[0]) : []
      console.log(`  OK   ${t.padEnd(18)} ${cols.length} columnas`)
      if (cols.length) console.log(`       ${cols.join(', ')}`)
      algunaOk = true
    } catch (e) {
      console.log(`  FALLA ${t.padEnd(17)} ${e.message.split('\n')[0]}`)
    }
  }
  if (!algunaOk) {
    console.log('\nNinguna tabla respondió. Si el error dice "JWT expired", regenerá')
    console.log('SUPABASE_READONLY_TOKEN. Si dice "Invalid API key", revisá VITE_SUPABASE_ANON_KEY.')
    process.exit(1)
  }
}

// ─── Entrada ────────────────────────────────────────────────
const args = process.argv.slice(2)

if (args.includes('--check')) {
  await chequear()
} else {
  const [tabla, query] = args.filter(a => !a.startsWith('--'))
  if (!tabla) {
    console.error('Uso: node scripts/consulta-lectura.mjs <tabla> "<query PostgREST>" [--todo] [--csv]')
    console.error('     node scripts/consulta-lectura.mjs --check')
    process.exit(1)
  }
  const filas = args.includes('--todo')
    ? await leerTodo(tabla, query || 'select=*')
    : await leer(tabla, query || 'select=*&limit=100')

  if (args.includes('--csv')) {
    if (!filas.length) process.exit(0)
    const cols = [...new Set(filas.flatMap(f => Object.keys(f)))]
    const celda = v => (v == null ? '' : /[",\n]/.test(String(v)) ? `"${String(v).replace(/"/g, '""')}"` : String(v))
    console.log(cols.join(','))
    for (const f of filas) console.log(cols.map(c => celda(f[c])).join(','))
  } else {
    console.log(JSON.stringify(filas, null, 2))
  }
}
