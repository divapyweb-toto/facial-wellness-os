// src/pages/kpi-whatsapp/kpi.js — formato y definiciones del panel semanal (sin React).
// Los datos salen de la vista kpi_whatsapp_semanal (migración 20261006000006).

const nf1 = new Intl.NumberFormat('es-PY', { maximumFractionDigits: 1, minimumFractionDigits: 0 })
const nf0 = new Intl.NumberFormat('es-PY', { maximumFractionDigits: 0 })

export const esNulo = (v) => v === null || v === undefined || v === '' || Number.isNaN(Number(v))

export function fmtPct(v) { return esNulo(v) ? '—' : `${nf1.format(Number(v))} %` }
export function fmtNum(v) { return esNulo(v) ? '—' : nf0.format(Number(v)) }
export function fmtUsd(v) {
  if (esNulo(v)) return '—'
  const n = Number(v)
  const dec = Math.abs(n) < 1 && n !== 0 ? 4 : 2
  return `US$ ${n.toLocaleString('es-PY', { minimumFractionDigits: 2, maximumFractionDigits: dec })}`
}
export function fmtMin(v) {
  if (esNulo(v)) return '—'
  const m = Number(v)
  if (m < 60) return `${nf0.format(Math.round(m))} min`
  const h = Math.floor(m / 60)
  return `${h} h ${Math.round(m - h * 60)} min`
}

/** '2026-10-05' (lunes) → '5 – 11 oct' */
export function rangoSemana(semana) {
  if (!semana) return ''
  const [a, m, d] = String(semana).slice(0, 10).split('-').map(Number)
  const ini = new Date(Date.UTC(a, m - 1, d))
  const fin = new Date(Date.UTC(a, m - 1, d + 6))
  const mes = (x) => x.toLocaleString('es-PY', { month: 'short', timeZone: 'UTC' }).replace('.', '')
  return ini.getUTCMonth() === fin.getUTCMonth()
    ? `${ini.getUTCDate()} – ${fin.getUTCDate()} ${mes(fin)}`
    : `${ini.getUTCDate()} ${mes(ini)} – ${fin.getUTCDate()} ${mes(fin)}`
}

/** Lunes de la semana actual en Asunción, 'YYYY-MM-DD'. */
export function lunesActual(ahora = new Date()) {
  const p = Object.fromEntries(new Intl.DateTimeFormat('en-CA', {
    timeZone: 'America/Asuncion', year: 'numeric', month: '2-digit', day: '2-digit', weekday: 'short',
  }).formatToParts(ahora).map((x) => [x.type, x.value]))
  const dias = { Mon: 0, Tue: 1, Wed: 2, Thu: 3, Fri: 4, Sat: 5, Sun: 6 }[p.weekday] ?? 0
  const f = new Date(Date.UTC(Number(p.year), Number(p.month) - 1, Number(p.day) - dias))
  return f.toISOString().slice(0, 10)
}

// sentido: 'sube' = mejor si sube; 'baja' = mejor si baja; null = neutro.
export const KPIS = [
  { clave: 'pedidos', etiqueta: 'Pedidos', fmt: fmtNum, sentido: 'sube',
    sub: (f) => `${fmtNum(f.pedidos_whatsapp)} por WhatsApp` },
  { clave: 'pct_confirmados', etiqueta: 'Confirmados', fmt: fmtPct, sentido: 'sube',
    sub: (f) => `${fmtNum(f.confirmados)} de ${fmtNum(f.pedidos)}` },
  { clave: 'pct_entregados', etiqueta: 'Entregados', fmt: fmtPct, sentido: 'sube',
    sub: (f) => `${fmtNum(f.entregados)} entregados · ${fmtNum(f.no_entregados)} no` },
  { clave: 'minutos_mediana_confirmar', etiqueta: 'Tiempo a confirmar', fmt: fmtMin, sentido: 'baja',
    sub: () => 'mediana, desde el pedido' },
  { clave: 'costo_mensajes_por_entregado_usd', etiqueta: 'Mensajes / entregado', fmt: fmtUsd, sentido: 'baja',
    sub: (f) => `${fmtUsd(f.costo_mensajes_usd)} en la semana` },
  { clave: 'costo_ia_por_entregado_usd', etiqueta: 'IA / entregado', fmt: fmtUsd, sentido: 'baja',
    sub: (f) => `${fmtUsd(f.costo_ia_usd)} en la semana` },
  { clave: 'pct_derivado', etiqueta: 'Derivado a Enrique', fmt: fmtPct, sentido: 'baja',
    sub: (f) => `${fmtNum(f.derivadas)} de ${fmtNum(f.conversaciones)} chats` },
  { clave: 'recompras', etiqueta: 'Recompras', fmt: fmtNum, sentido: 'sube',
    sub: () => 'clientes con una entrega previa' },
  { clave: 'reclamos', etiqueta: 'Reclamos', fmt: fmtNum, sentido: 'baja',
    sub: (f) => `${fmtNum(f.reclamos_por_100_entregados)} cada 100 entregados` },
]

/** Variación contra la semana anterior: {texto, tono: 'green'|'red'|null} o null. */
export function variacion(kpi, actual, anterior) {
  if (!anterior) return null
  const a = Number(actual?.[kpi.clave]); const b = Number(anterior?.[kpi.clave])
  if (esNulo(actual?.[kpi.clave]) || esNulo(anterior?.[kpi.clave])) return null
  const d = a - b
  if (Math.abs(d) < 1e-9) return { texto: '= sem. anterior', tono: null }
  const esPct = kpi.clave.startsWith('pct_')
  const txt = esPct ? `${d > 0 ? '+' : '−'}${nf1.format(Math.abs(d))} pts`
    : b !== 0 ? `${d > 0 ? '+' : '−'}${nf0.format(Math.abs(d / b) * 100)} %` : (d > 0 ? 'sube' : 'baja')
  const mejor = kpi.sentido === 'sube' ? d > 0 : kpi.sentido === 'baja' ? d < 0 : null
  return { texto: `${txt} vs sem. anterior`, tono: mejor === null ? null : mejor ? 'green' : 'red' }
}
