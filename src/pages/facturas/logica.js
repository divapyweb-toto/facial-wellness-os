// src/pages/facturas/logica.js
// ═══════════════════════════════════════════════════════════
// LÓGICA PURA DEL PANEL DE FACTURAS (SIFEN)
//
// Sin React ni Supabase: todo lo que se calcula acá se prueba en
// tests/facturas-panel.test.mjs. La página solo lee la base y dibuja.
//
// Esquema leído: docs/sifen-contrato.md (tabla `facturas`).
// ═══════════════════════════════════════════════════════════

import { refVoltra } from '../../lib/referencias'

export const ZONA = 'America/Asuncion'

// ── Tipos de documento (contrato: tipo_documento smallint) ──
export const TIPOS = {
  1: { sigla: 'FE', nombre: 'Factura electrónica' },
  4: { sigla: 'AF', nombre: 'Autofactura electrónica' },
  5: { sigla: 'NC', nombre: 'Nota de crédito' },
  6: { sigla: 'ND', nombre: 'Nota de débito' },
  7: { sigla: 'NR', nombre: 'Nota de remisión' },
}
export const siglaTipo = (t) => TIPOS[Number(t)]?.sigla || '—'
export const nombreTipo = (t) => TIPOS[Number(t)]?.nombre || 'Desconocido'

// ── Estados (contrato: pendiente | enviada | aprobada | rechazada |
//    cancelada | revisar | error | inutilizada) ──
// `grupo` es lo que usan las pestañas y las tarjetas.
export const ESTADOS = {
  pendiente:   { label: 'Pendiente',   badge: 'badge-yellow', grupo: 'pendientes' },
  enviada:     { label: 'Enviada',     badge: 'badge-blue',   grupo: 'pendientes' },
  error:       { label: 'Error',       badge: 'badge-red',    grupo: 'pendientes' },
  revisar:     { label: 'Revisar',     badge: 'badge-purple', grupo: 'pendientes' },
  aprobada:    { label: 'Aprobada',    badge: 'badge-green',  grupo: 'aprobadas' },
  rechazada:   { label: 'Rechazada',   badge: 'badge-red',    grupo: 'rechazadas' },
  cancelada:   { label: 'Cancelada',   badge: 'badge-gray',   grupo: 'canceladas' },
  inutilizada: { label: 'Inutilizada', badge: 'badge-gray',   grupo: 'canceladas' },
}
export const infoEstado = (e) => ESTADOS[e] || { label: e ? String(e) : 'Sin estado', badge: 'badge-gray', grupo: 'otros' }

export const PESTANAS = [
  { id: 'todas',      label: 'Todas' },
  { id: 'aprobadas',  label: 'Aprobadas' },
  { id: 'pendientes', label: 'Pendientes' },
  { id: 'rechazadas', label: 'Rechazadas' },
  { id: 'canceladas', label: 'Canceladas' },
  { id: 'nc',         label: 'Notas de crédito' },
]

export function filtrarPorPestana(facturas, pestana) {
  const lista = facturas || []
  if (pestana === 'todas' || !pestana) return lista
  if (pestana === 'nc') return lista.filter(f => Number(f.tipo_documento) === 5)
  return lista.filter(f => infoEstado(f.estado).grupo === pestana)
}

export function contarPorPestana(facturas) {
  const out = {}
  for (const p of PESTANAS) out[p.id] = filtrarPorPestana(facturas, p.id).length
  return out
}

// ── Fechas en hora de Asunción ──
const fmtDia = new Intl.DateTimeFormat('en-CA', { timeZone: ZONA, year: 'numeric', month: '2-digit', day: '2-digit' })

// ISO (UTC) → 'YYYY-MM-DD' del día en Paraguay
export function diaAsuncion(iso) {
  if (!iso) return ''
  const d = iso instanceof Date ? iso : new Date(iso)
  if (isNaN(d)) return ''
  return fmtDia.format(d)
}
export const mesAsuncion = (fecha = new Date()) => diaAsuncion(fecha).slice(0, 7)

// Fecha de la factura: la de emisión; si todavía no tiene, la de creación.
export const fechaFactura = (f) => f?.fecha_emision || f?.creado_en || null

// 'YYYY-MM' → límites del mes en UTC para filtrar en la base.
// Paraguay usa UTC-3 fijo desde oct-2024 (Ley 7.115/2024, sin horario de
// invierno). [VERIFICAR] si vuelve el cambio de hora, usar el offset de cada fecha.
export function rangoMes(ym) {
  const [y, m] = ym.split('-').map(Number)
  const desde = new Date(Date.UTC(y, m - 1, 1, 3, 0, 0))
  const hasta = new Date(Date.UTC(m === 12 ? y + 1 : y, m === 12 ? 0 : m, 1, 3, 0, 0))
  return { desde: desde.toISOString(), hasta: hasta.toISOString() }
}

// '2026-10-08T15:04:00Z' → '08/10/2026 12:04' (hora de Asunción)
const fmtFechaHora = new Intl.DateTimeFormat('es-PY', {
  timeZone: ZONA, day: '2-digit', month: '2-digit', year: 'numeric', hour: '2-digit', minute: '2-digit', hour12: false,
})
export function fechaHoraCorta(iso) {
  if (!iso) return '—'
  const d = new Date(iso)
  return isNaN(d) ? '—' : fmtFechaHora.format(d).replace(',', '')
}
// 'YYYY-MM-DD' → 'DD/MM/YYYY'
export const ddmmyyyy = (dia) => (dia ? dia.split('-').reverse().join('/') : '')

// ── Etiquetas de una fila ──
export function numeroCompleto(f) {
  if (f?.numero_completo) return f.numero_completo
  if (f?.numero == null) return '—'
  const est = String(f.establecimiento || '001').padStart(3, '0')
  const pun = String(f.punto || '001').padStart(3, '0')
  return `${est}-${pun}-${String(f.numero).padStart(7, '0')}`
}

// Pedido: nombre de Shopify ('#1003') → 'VT-1003'. Sin nombre, el id crudo.
export function etiquetaPedido(nombreShopify, shopifyOrderId) {
  if (nombreShopify) return refVoltra(nombreShopify) || String(nombreShopify)
  return shopifyOrderId ? `#${shopifyOrderId}` : '—'
}

export function esConsumidorFinal(f) {
  return f?.receptor_tipo === 'innominado' || !String(f?.razon_social || '').trim()
}
export const etiquetaCliente = (f) => (esConsumidorFinal(f) ? 'Consumidor final' : String(f.razon_social).trim())
export const etiquetaRuc = (f) => (f?.ruc ? String(f.ruc) : '—')

const n = (v) => {
  const x = Number(v)
  return Number.isFinite(x) ? x : 0
}
export const ivaTotal = (f) => n(f?.iva10) + n(f?.iva5)

// Modo prueba: alguna factura del período en ambiente test o simulada.
export const esModoPrueba = (facturas) => (facturas || []).some(f => f.ambiente !== 'prod' || f.simulado === true)

// ── Totales del mes ──
// Solo APROBADAS suman plata. Signo por tipo para el neto de ventas:
//   FE y ND suman, NC resta. AF (autofactura = compra a un no contribuyente)
//   y NR (remisión, sin valor) NO son ventas: se cuentan aparte.
// [VERIFICAR] con la contadora: tratamiento de AF en el crédito fiscal.
export const SIGNO_VENTA = { 1: 1, 6: 1, 5: -1 }
const CAMPOS_MONTO = ['base10', 'iva10', 'base5', 'iva5', 'exento', 'total']

export function resumenMes(facturas, hoy = new Date()) {
  const lista = facturas || []
  const diaHoy = diaAsuncion(hoy)
  const tot = { base10: 0, iva10: 0, base5: 0, iva5: 0, exento: 0, total: 0, totalIva: 0, cantidad: 0 }
  const porTipo = {}
  const porEstado = {}
  let delDia = 0, pendientes = 0, rechazadas = 0, canceladas = 0, aprobadas = 0

  for (const f of lista) {
    const g = infoEstado(f.estado).grupo
    porEstado[f.estado || 'sin_estado'] = (porEstado[f.estado || 'sin_estado'] || 0) + 1
    if (diaAsuncion(fechaFactura(f)) === diaHoy) delDia++
    if (g === 'pendientes') pendientes++
    if (f.estado === 'rechazada') rechazadas++
    if (f.estado === 'cancelada') canceladas++
    if (f.estado !== 'aprobada') continue
    aprobadas++

    const t = Number(f.tipo_documento)
    const pt = porTipo[t] || (porTipo[t] = { cantidad: 0, base10: 0, iva10: 0, base5: 0, iva5: 0, exento: 0, total: 0 })
    pt.cantidad++
    for (const c of CAMPOS_MONTO) pt[c] += n(f[c])

    const s = SIGNO_VENTA[t]
    if (!s) continue
    tot.cantidad++
    for (const c of CAMPOS_MONTO) tot[c] += s * n(f[c])
  }
  tot.totalIva = tot.iva10 + tot.iva5
  return { delDia, pendientes, rechazadas, canceladas, aprobadas, totales: tot, porTipo, porEstado, cantidad: lista.length }
}

// ── Exportación para la contadora ──
// Una fila por comprobante (todos los estados: la contadora necesita ver
// también los cancelados/rechazados para cuadrar la numeración).
// [VERIFICAR] formato exacto del "Registro mensual de comprobantes" de la
// DNIT (RG 90/2021 y modificatorias; columnas, orden y archivo de carga en
// Marangatu). Este archivo es una planilla de trabajo, no el formato oficial.
export const COLUMNAS_EXPORT = [
  'Fecha', 'Tipo', 'Número', 'Timbrado', 'CDC', 'RUC/Documento receptor', 'Razón social',
  'Base 10%', 'IVA 10%', 'Base 5%', 'IVA 5%', 'Exento', 'Total', 'Estado',
]

export function filasExportacion(facturas) {
  return [...(facturas || [])]
    .sort((a, b) => String(fechaFactura(a) || '').localeCompare(String(fechaFactura(b) || '')) || n(a.numero) - n(b.numero))
    .map(f => ({
      'Fecha': ddmmyyyy(diaAsuncion(fechaFactura(f))),
      'Tipo': siglaTipo(f.tipo_documento),
      'Número': numeroCompleto(f),
      'Timbrado': f.timbrado || '',
      'CDC': f.cdc || '',
      'RUC/Documento receptor': f.ruc || '',
      'Razón social': etiquetaCliente(f),
      'Base 10%': n(f.base10),
      'IVA 10%': n(f.iva10),
      'Base 5%': n(f.base5),
      'IVA 5%': n(f.iva5),
      'Exento': n(f.exento),
      'Total': n(f.total),
      'Estado': infoEstado(f.estado).label,
    }))
}

// Hoja "Resumen": por tipo (solo aprobadas), neto de ventas y conteo por estado.
export function filasResumen(facturas, ym) {
  const r = resumenMes(facturas)
  const filas = []
  const fila = (concepto, cantidad, m = {}) => ({
    'Concepto': concepto, 'Cantidad': cantidad,
    'Base 10%': n(m.base10), 'IVA 10%': n(m.iva10), 'Base 5%': n(m.base5), 'IVA 5%': n(m.iva5),
    'Exento': n(m.exento), 'Total': n(m.total), 'Total IVA': n(m.iva10) + n(m.iva5),
  })
  filas.push({ 'Concepto': `Mes ${ym}`, 'Cantidad': '' })
  for (const t of Object.keys(TIPOS).map(Number)) {
    const pt = r.porTipo[t]
    if (pt) filas.push(fila(`${TIPOS[t].sigla} aprobadas · ${TIPOS[t].nombre}`, pt.cantidad, pt))
  }
  filas.push(fila('NETO VENTAS (FE + ND − NC, aprobadas)', r.totales.cantidad, r.totales))
  filas.push({ 'Concepto': '', 'Cantidad': '' })
  filas.push({ 'Concepto': 'Comprobantes por estado', 'Cantidad': '' })
  for (const [estado, c] of Object.entries(r.porEstado)) filas.push({ 'Concepto': infoEstado(estado).label, 'Cantidad': c })
  filas.push({ 'Concepto': 'Total comprobantes del mes', 'Cantidad': r.cantidad })
  return filas
}

// CSV con ';' (Excel en español lo abre en columnas) y BOM para los acentos.
export function aCsv(filas, columnas) {
  const cols = columnas || (filas[0] ? Object.keys(filas[0]) : [])
  const esc = (v) => {
    const s = v == null ? '' : String(v)
    return /[;"\n\r]/.test(s) ? `"${s.replace(/"/g, '""')}"` : s
  }
  return '﻿' + [cols.join(';'), ...filas.map(f => cols.map(c => esc(f[c])).join(';'))].join('\r\n')
}

export const nombreArchivo = (ym, ext, sufijo = 'comprobantes') => `voltra-${sufijo}-${ym}.${ext}`

// ── Errores ──
// Tabla inexistente (migración sin correr): Postgres 42P01 o PostgREST PGRST205.
export function esTablaInexistente(error) {
  if (!error) return false
  const code = String(error.code || '')
  const msg = String(error.message || '').toLowerCase()
  return code === '42P01' || code === 'PGRST205' || code === 'PGRST202'
    || msg.includes('does not exist') || msg.includes('schema cache')
}

// Edge Function no desplegada: 404 del gateway. Si el 404 llega sin
// cabeceras CORS el navegador lo ve como fallo de red (FunctionsFetchError).
export function motivoErrorReenvio(error) {
  if (!error) return null
  const status = error.context?.status ?? error.status
  if (status === 404) return 'La función de reenvío todavía no está desplegada.'
  if (error.name === 'FunctionsFetchError') return 'No se pudo contactar la función de reenvío (puede que todavía no esté desplegada).'
  return `No se pudo reenviar: ${error.message || 'error desconocido'}`
}
