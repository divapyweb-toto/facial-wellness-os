// src/pages/productos/formato.js
// Helpers puros del módulo Productos nuevos: plata en unidades menores,
// fechas en hora de Paraguay y normalizaciones. Sin React ni base.

// Escala por moneda (contrato): PYG 0 decimales, USD y CNY 2.
export const ESCALA = { PYG: 0, USD: 2, CNY: 2 }
export const MONEDAS = ['PYG', 'USD', 'CNY']
export const escala = (moneda) => ESCALA[moneda] ?? 2

// "1.234,5" / "1234.5" / "1,234.50" → unidades menores enteras (BigInt-safe para montos normales).
// Devuelve null si está vacío o no es número. Nunca usa float para guardar:
// separa parte entera y decimal como texto.
export function aMinor(texto, moneda = 'PYG') {
  if (texto === null || texto === undefined) return null
  let s = String(texto).trim().replace(/\s|₲|Gs\.?|USD|CNY|\$/gi, '')
  if (!s) return null
  const neg = s.startsWith('-')
  if (neg) s = s.slice(1)
  const esc = escala(moneda)
  // Último separador = decimal solo si la moneda tiene decimales y hay 1-2 dígitos después.
  let entero = s, dec = ''
  const m = s.match(/^(.*)[.,](\d{1,2})$/)
  if (esc > 0 && m) { entero = m[1]; dec = m[2] }
  entero = entero.replace(/[.,]/g, '')
  if (!/^\d*$/.test(entero) || !/^\d*$/.test(dec)) return null
  if (!entero && !dec) return null
  const decPad = (dec + '00').slice(0, esc)
  const n = parseInt((entero || '0') + decPad, 10)
  if (!Number.isFinite(n)) return null
  return neg ? -n : n
}

// unidades menores → texto editable ("150000" o "12.50")
export function deMinorTexto(minor, moneda = 'PYG') {
  if (minor === null || minor === undefined || minor === '') return ''
  const esc = escala(moneda)
  const n = Number(minor)
  if (esc === 0) return String(Math.round(n))
  const neg = n < 0
  const abs = Math.abs(Math.round(n))
  const ent = Math.floor(abs / 10 ** esc)
  const dec = String(abs % 10 ** esc).padStart(esc, '0')
  return `${neg ? '-' : ''}${ent}.${dec}`
}

// Formato para mostrar: "₲ 150.000", "USD 12,50", "CNY 8,00"
export function fmtDinero(minor, moneda = 'PYG') {
  if (minor === null || minor === undefined || minor === '' || Number.isNaN(Number(minor))) return 'desconocido'
  const esc = escala(moneda)
  const valor = Number(minor) / 10 ** esc
  const txt = new Intl.NumberFormat('es-PY', { minimumFractionDigits: esc, maximumFractionDigits: esc }).format(valor)
  return moneda === 'PYG' ? `₲ ${txt}` : `${moneda} ${txt}`
}

export const fmtGs = (n) => fmtDinero(n === null || n === undefined ? null : Math.round(Number(n)), 'PYG')

export function fmtPct(v, dec = 1) {
  if (v === null || v === undefined || v === '' || Number.isNaN(Number(v))) return 'desconocido'
  return `${(Number(v) * 100).toFixed(dec).replace('.', ',')} %`
}

// Convierte unidades menores de una moneda a guaraníes con un tipo de cambio
// "1 <moneda> = X PYG". Devuelve null si falta el cambio (no se inventa).
export function aPYG(minor, moneda, tcAPyg) {
  if (minor === null || minor === undefined) return null
  if (moneda === 'PYG') return Math.round(Number(minor))
  const tc = Number(tcAPyg)
  if (!tc || !Number.isFinite(tc)) return null
  return Math.round((Number(minor) / 10 ** escala(moneda)) * tc)
}

// ── Fechas: se guardan en UTC, se muestran en America/Asuncion ──
const TZ = 'America/Asuncion'
export function fmtFecha(ts) {
  if (!ts) return '—'
  const d = new Date(ts)
  if (Number.isNaN(d.getTime())) return '—'
  return d.toLocaleDateString('es-PY', { timeZone: TZ, day: '2-digit', month: 'short', year: 'numeric' })
}
export function fmtFechaHora(ts) {
  if (!ts) return '—'
  const d = new Date(ts)
  if (Number.isNaN(d.getTime())) return '—'
  return d.toLocaleString('es-PY', { timeZone: TZ, day: '2-digit', month: 'short', hour: '2-digit', minute: '2-digit' })
}
// "2026-11-18" (fecha local PY) → ISO UTC. finDelDia = 23:59:59 hora PY.
// Paraguay quedó en UTC-3 todo el año (ley 7300/2024).
export function fechaLocalAISO(fecha, finDelDia = false) {
  if (!fecha) return null
  const d = new Date(`${fecha}T${finDelDia ? '23:59:59' : '00:00:00'}-03:00`)
  return Number.isNaN(d.getTime()) ? null : d.toISOString()
}
export function hoyLocal() {
  return new Date().toLocaleDateString('en-CA', { timeZone: TZ })
}
export function sumarDiasLocal(fecha, dias) {
  const d = new Date(`${fecha}T12:00:00-03:00`)
  d.setUTCDate(d.getUTCDate() + dias)
  return d.toLocaleDateString('en-CA', { timeZone: TZ })
}
export const vencida = (validoHasta, ahora = new Date()) => !!validoHasta && new Date(validoHasta) < ahora

// Clave para deduplicar vendedores: minúsculas, sin acentos, sin "www", sin símbolos.
export function claveVendedor(texto) {
  return String(texto || '')
    .normalize('NFD').replace(/[̀-ͯ]/g, '')
    .toLowerCase()
    .replace(/https?:\/\//g, '').replace(/^www\./, '')
    .replace(/\b(s\.?a\.?|e\.?a\.?s\.?|s\.?r\.?l\.?|py|paraguay)\b/g, '')
    .replace(/[^a-z0-9]/g, '')
}

// Estados de candidato (contrato) con su color de badge.
export const ESTADOS_CANDIDATO = [
  { v: 'INVESTIGAR', label: 'Investigar', badge: 'badge-blue' },
  { v: 'SOLICITAR_COTIZACION', label: 'Pedir cotización', badge: 'badge-purple' },
  { v: 'PROBAR_MUESTRA', label: 'Probar muestra', badge: 'badge-yellow' },
  { v: 'PROBAR_OFERTA', label: 'Probar oferta', badge: 'badge-yellow' },
  { v: 'REORDENAR', label: 'Reordenar', badge: 'badge-green' },
  { v: 'ESCALAR', label: 'Escalar', badge: 'badge-green' },
  { v: 'DESCARTAR', label: 'Descartar', badge: 'badge-gray' },
]
export const estadoInfo = (v) => ESTADOS_CANDIDATO.find(e => e.v === v) || { v, label: v || '—', badge: 'badge-gray' }

export const TIPOS_EVIDENCIA = [
  { v: 'observed', label: 'Observado', badge: 'badge-green', ayuda: 'Lo vimos nosotros (web, tienda, anuncio) con fecha.' },
  { v: 'supplier_claim', label: 'Dice el proveedor', badge: 'badge-purple', ayuda: 'Afirmación del vendedor/proveedor: no está verificada.' },
  { v: 'estimated', label: 'Estimado', badge: 'badge-blue', ayuda: 'Cálculo propio a partir de otros datos.' },
  { v: 'hypothesis', label: 'Hipótesis', badge: 'badge-yellow', ayuda: 'Suposición a confirmar.' },
  { v: 'unknown', label: 'Desconocido', badge: 'badge-red', ayuda: 'Falta el dato: se deja visible.' },
]
export const tipoEvidenciaInfo = (v) => TIPOS_EVIDENCIA.find(t => t.v === v) || { v, label: v || '—', badge: 'badge-gray' }

// Campos sugeridos de evidencia (texto libre igual). dias_activo_anuncio = ampliación A8.
export const CAMPOS_EVIDENCIA = [
  'precio_minorista', 'precio_mayorista', 'stock_local', 'dias_activo_anuncio', 'cantidad_anuncios_activos',
  'costo_unitario', 'moq', 'peso_g', 'medidas_cm', 'flete_internacional', 'tributos', 'tipo_cambio',
  'demanda_preguntas_clientes', 'garantia', 'certificado', 'otro',
]
// Vigencia sugerida por campo (especificación §4: precio/stock local 7 días, logística/cambio 7 días).
export function vigenciaSugeridaDias(campo) {
  if (/precio|stock|flete|tipo_cambio|dias_activo|anuncios/.test(campo || '')) return 7
  return null
}

// Solo http(s): un link con otro esquema (javascript:, data:) no se muestra como link (revisión 18-11, hallazgo 8).
export const urlSegura = (u) => (typeof u === 'string' && /^https?:\/\//i.test(u) ? u : null)
