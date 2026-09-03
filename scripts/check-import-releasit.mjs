// scripts/check-import-releasit.mjs
// ═══════════════════════════════════════════════════════════
// AVISO: ¿HACE CUÁNTO NO SE IMPORTA RELEASIT?
//
// pedidos_releasit se llena como efecto secundario de una acción manual: al
// entrar a Despacho y cargar el Excel de Releasit, cargarVentas() hace un
// upsert ahí (ver fw-os/src/pages/despacho/DespachoPagina.jsx). No hay ningún
// proceso que lo traiga solo — si un día no se abre Despacho, ese día no
// queda registrado en ningún lado, y sin eso no hay denominador para calcular
// el CPA real (diagnóstico del 03-09-2026, corrección C1).
//
// Este script no arregla eso — SOLO AVISA. Corre en 2 segundos y no requiere
// nada nuevo: mismo patrón de lectura que consulta-lectura.mjs.
//
// Uso:
//   node scripts/check-import-releasit.mjs
//
// Sale con código 1 (falla) si pasaron 2 días o más sin importar, para poder
// engancharlo a una notificación más adelante sin tener que tocarlo de nuevo.
// ═══════════════════════════════════════════════════════════
import fs from 'node:fs'
import path from 'node:path'
import { fileURLToPath } from 'node:url'

const RAIZ = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..')

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
  return env
}

const env = leerEnv()
const URL_BASE = (env.VITE_SUPABASE_URL || '').replace(/\/$/, '')
const ANON = env.VITE_SUPABASE_ANON_KEY
const TOKEN = env.SUPABASE_READONLY_TOKEN || ANON

if (!URL_BASE || !ANON) {
  console.error('Faltan VITE_SUPABASE_URL / VITE_SUPABASE_ANON_KEY en .env')
  process.exit(2)
}

const hoy = new Date()
const hoyStr = hoy.toISOString().slice(0, 10)

const r = await fetch(
  `${URL_BASE}/rest/v1/pedidos_releasit?select=fecha&order=fecha.desc&limit=1`,
  { headers: { apikey: ANON, Authorization: `Bearer ${TOKEN}` } }
)
if (!r.ok) {
  console.error('Error consultando Supabase:', r.status, await r.text())
  process.exit(2)
}
const [ultimo] = await r.json()

if (!ultimo) {
  console.log('⚠️  pedidos_releasit está vacía. Nunca se importó nada.')
  process.exit(1)
}

const dias = Math.floor((hoy - new Date(ultimo.fecha + 'T00:00:00')) / 86400000)

console.log(`Hoy:                    ${hoyStr}`)
console.log(`Último pedido importado: ${ultimo.fecha}`)
console.log(`Días sin importar:       ${dias}`)
console.log()

if (dias >= 2) {
  console.log(`⚠️  Van ${dias} días sin importar Releasit. Entrá a Despacho y cargá el Excel.`)
  process.exit(1)
} else if (dias === 1) {
  console.log('🟡 Ayer no se importó todavía. Si ya pasó el horario de despacho de hoy, cargalo.')
  process.exit(0)
} else {
  console.log('✅ Al día.')
  process.exit(0)
}
