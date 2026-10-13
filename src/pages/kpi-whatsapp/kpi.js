// src/pages/kpi-whatsapp/kpi.js — formato y definiciones del panel semanal (sin React).
// Los datos salen de la vista kpi_whatsapp_semanal (migración 20261006000006).
import { tasaEntregaRealista, textoEsperada, textoRango, colorTasa } from '../../lib/tasaEntrega'

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

/**
 * Pedidos que "cayeron sin respuesta" (estado_confirmacion 'cancelado_sin_respuesta') por semana.
 * La vista kpi_whatsapp_semanal no los separa: los cuenta en `pedidos` y como NO confirmados.
 * Se agregan a cada fila como `sin_respuesta` (null si no se pudieron leer → se ve '—').
 */
export function agregarSinRespuesta(filas, cancelados) {
  if (!Array.isArray(cancelados)) return filas.map((f) => ({ ...f, sin_respuesta: null }))
  const porSemana = new Map()
  for (const c of cancelados) {
    if (!c?.creado_en) continue
    const s = lunesActual(new Date(c.creado_en))
    porSemana.set(s, (porSemana.get(s) ?? 0) + 1)
  }
  return filas.map((f) => ({ ...f, sin_respuesta: porSemana.get(String(f.semana).slice(0, 10)) ?? 0 }))
}

// ── Entrega realista por semana (12-10) ──────────────────────
// La vista calcula pct_entregados = entregados ÷ (entregados + no entregados):
// con 5 entregados, 0 devueltos y 28 confirmados daba "100 %", y el costo por
// entregado dividía la plata de toda la semana por los 5 que ya llegaron.
// Sin tocar la vista (no hay migraciones), acá se deriva:
//   · en_camino     = confirmados que todavía no son ni entregados ni devueltos
//                     (aproximado: la vista no expone entregados_confirmados).
//   · pct_resuelto  = (entregados + no entregados) ÷ confirmados.
//   · semana_resuelta (≥ 80 % resuelto): recién ahí el costo por entregado es real.
//   · tasa_entrega  = tasaEntregaRealista (~esperada + rango + en camino).
export const MIN_RESUELTO_SEMANA = 80

export function derivarEntrega(f, hist = null) {
  const ent = Math.max(0, Number(f?.entregados) || 0)
  const dev = Math.max(0, Number(f?.no_entregados) || 0)
  const conf = Math.max(0, Number(f?.confirmados) || 0)
  const resueltos = ent + dev
  const base = Math.max(conf, resueltos)
  const enCamino = Math.max(0, conf - resueltos)
  const pctResuelto = base ? (resueltos / base) * 100 : null
  const t = tasaEntregaRealista({ entregados: ent, devueltos: dev, enCamino, hist })
  return {
    ...f,
    en_camino: enCamino,
    pct_resuelto: pctResuelto,
    semana_resuelta: pctResuelto != null && pctResuelto >= MIN_RESUELTO_SEMANA,
    pct_entrega_esperada: t.esperada,
    tasa_entrega: t,
  }
}

// Aplica derivarEntrega a todas las semanas. La tasa con la que se proyecta
// lo que está en camino sale de las semanas YA resueltas (≥ 80 %); si no
// suman 20 resueltos, tasaEntregaRealista cae a la referencia del rubro.
export function agregarEntrega(filas) {
  const hist = { entregados: 0, resueltos: 0 }
  for (const f of filas || []) {
    const d = derivarEntrega(f)
    if (!d.semana_resuelta) continue
    hist.entregados += Number(f.entregados) || 0
    hist.resueltos += (Number(f.entregados) || 0) + (Number(f.no_entregados) || 0)
  }
  return (filas || []).map((f) => derivarEntrega(f, hist))
}

// Costo por entregado: solo con la semana resuelta; si no, 'parcial'.
export function fmtPorEntregado(f, clave) {
  if (!f?.semana_resuelta) return esNulo(f?.[clave]) ? '—' : 'parcial'
  return fmtUsd(f[clave])
}
const subResuelto = (f) => (f?.semana_resuelta || f?.pct_resuelto == null
  ? '' : ` · ${nf0.format(Math.round(f.pct_resuelto))} % resuelto`)

// sentido: 'sube' = mejor si sube; 'baja' = mejor si baja; null = neutro.
export const KPIS = [
  { clave: 'pedidos', etiqueta: 'Pedidos', fmt: fmtNum, sentido: 'sube',
    sub: (f) => `${fmtNum(f.pedidos_whatsapp)} por WhatsApp` },
  { clave: 'pct_confirmados', etiqueta: 'Confirmados', fmt: fmtPct, sentido: 'sube',
    sub: (f) => `${fmtNum(f.confirmados)} de ${fmtNum(f.pedidos)}` },
  { clave: 'sin_respuesta', etiqueta: 'Cayeron sin respuesta', fmt: fmtNum, sentido: 'baja',
    sub: () => 'cancelados solos: no son confirmados ni ventas' },
  // 12-10: ~esperada + "N de M confirmados · N en camino · rango"; nunca el
  // 100 % de pocos resueltos. Solo se compara con la semana anterior si las
  // dos están resueltas (si no, se compararían proyecciones).
  { clave: 'pct_entrega_esperada', etiqueta: 'Entregados', sentido: 'sube',
    fmt: (v) => (esNulo(v) ? '—' : `~${nf0.format(Math.round(Number(v)))} %`),
    valor: (f) => (f.tasa_entrega ? textoEsperada(f.tasa_entrega) : '—'),
    color: (f) => (f.tasa_entrega ? colorTasa(f.tasa_entrega) : null),
    comparable: (f) => !!f?.semana_resuelta,
    sub: (f) => `${fmtNum(f.entregados)} de ${fmtNum(f.confirmados)} confirmados · ${fmtNum(f.no_entregados)} no`
      + (f.tasa_entrega ? ` · ${textoRango(f.tasa_entrega)}` : '') },
  { clave: 'minutos_mediana_confirmar', etiqueta: 'Tiempo a confirmar', fmt: fmtMin, sentido: 'baja',
    sub: () => 'mediana, desde el pedido' },
  { clave: 'costo_mensajes_por_entregado_usd', etiqueta: 'Mensajes / entregado', fmt: fmtUsd, sentido: 'baja',
    valor: (f) => fmtPorEntregado(f, 'costo_mensajes_por_entregado_usd'), comparable: (f) => !!f?.semana_resuelta,
    sub: (f) => `${fmtUsd(f.costo_mensajes_usd)} en la semana${subResuelto(f)}` },
  { clave: 'costo_ia_por_entregado_usd', etiqueta: 'IA / entregado', fmt: fmtUsd, sentido: 'baja',
    valor: (f) => fmtPorEntregado(f, 'costo_ia_por_entregado_usd'), comparable: (f) => !!f?.semana_resuelta,
    sub: (f) => `${fmtUsd(f.costo_ia_usd)} en la semana${subResuelto(f)}` },
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
  // 12-10: semanas sin resolver no se comparan (serían proyecciones o parciales).
  if (kpi.comparable && (!kpi.comparable(actual) || !kpi.comparable(anterior))) return null
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
