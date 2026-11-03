// src/pages/facturas/imprimir.js
// ═══════════════════════════════════════════════════════════
// LÓGICA PURA DE "IMPRIMIR PARA LA CONTADORA"
//
// Sin React ni Supabase: se prueba en tests/imprimir-facturas.test.mjs.
// ImprimirContadora.jsx lee la base, baja los PDF y llama a esto.
//
// Dos listas:
//   · Emitidas por Voltra: `facturas` aprobadas, ambiente prod, con KuDE.
//   · Recibidas a nombre de Voltra: `facturas_recibidas` no descartadas.
//     Las que llegaron solo con XML (sin PDF) se listan como "sin PDF" y no
//     entran al PDF para imprimir.
// Orden de impresión: emitidas por número, después recibidas por fecha.
// Contrato: docs/contrato-imprimir-facturas-03-11.md (sección 3).
// ═══════════════════════════════════════════════════════════

import { diaAsuncion, mesAsuncion, numeroCompleto, etiquetaCliente } from './logica'

// Columnas que se leen. `impreso_en` es nueva: si la migración no corrió,
// la página repite la consulta sin ella (ver esColumnaInexistente).
export const COLUMNAS_EMITIDAS = ['id', 'numero', 'numero_completo', 'establecimiento', 'punto', 'tipo_documento',
  'fecha_emision', 'receptor_tipo', 'razon_social', 'ruc', 'total', 'estado', 'ambiente', 'kude_path']
export const COLUMNAS_RECIBIDAS = ['id', 'recibida_en', 'proveedor', 'remitente', 'ruc_emisor', 'numero',
  'fecha_doc', 'total', 'pdf_path', 'xml_path', 'es_de_voltra', 'descartada']

// ── Mes por defecto: el anterior, en hora de Asunción ──
// El 01-11 a las 23:00 de Paraguay todavía es 01-11 → mes anterior = octubre.
export function mesAnteriorAsuncion(ahora = new Date()) {
  const [y, m] = mesAsuncion(ahora).split('-').map(Number)
  return m === 1 ? `${y - 1}-12` : `${y}-${String(m - 1).padStart(2, '0')}`
}

// 'YYYY-MM' → límites como fecha simple (para columnas `date`, p. ej. fecha_doc).
export function rangoMesFecha(ym) {
  const [y, m] = ym.split('-').map(Number)
  const sig = m === 12 ? `${y + 1}-01` : `${y}-${String(m + 1).padStart(2, '0')}`
  return { desde: `${ym}-01`, hasta: `${sig}-01` }
}

// Día del comprobante recibido: el del documento; si no hay XML, el día en que llegó el correo.
const diaRecibida = (r) => (r?.fecha_doc ? String(r.fecha_doc).slice(0, 10) : diaAsuncion(r?.recibida_en))

const num = (v) => {
  const x = Number(v)
  return Number.isFinite(x) ? x : 0
}

// ── Filas normalizadas (mismo formato para las dos listas) ──
// { clave, origen, id, dia, numero, contraparte, total, impreso_en, pdf_path, sin_pdf }
export function filaEmitida(f) {
  return {
    clave: `e:${f.id}`, origen: 'emitida', id: f.id,
    dia: diaAsuncion(f.fecha_emision), numero: numeroCompleto(f),
    tipo: Number(f.tipo_documento) || null,
    contraparte: etiquetaCliente(f), total: num(f.total),
    impreso_en: f.impreso_en || null, pdf_path: f.kude_path || null, sin_pdf: !f.kude_path,
  }
}

export function filaRecibida(r) {
  return {
    clave: `r:${r.id}`, origen: 'recibida', id: r.id,
    dia: diaRecibida(r), numero: r.numero || '—',
    tipo: null,
    contraparte: String(r.proveedor || r.remitente || '').trim() || 'Proveedor sin nombre',
    total: r.total == null ? null : num(r.total),
    impreso_en: r.impreso_en || null, pdf_path: r.pdf_path || null, sin_pdf: !r.pdf_path,
  }
}

// Emitidas que van a papel: aprobadas, de producción, con KuDE guardado.
export const esEmitidaImprimible = (f) => f?.estado === 'aprobada' && f?.ambiente === 'prod' && !!f?.kude_path

// Numeración: '001-001-0000012' ordena bien como texto; empate → por tipo (FE antes que NC).
const porNumero = (a, b) => a.numero.localeCompare(b.numero) || num(a.tipo) - num(b.tipo)
const porFecha = (a, b) => String(a.dia).localeCompare(String(b.dia)) || String(a.numero).localeCompare(String(b.numero))

/**
 * Arma las dos listas del mes.
 * @param {object[]} facturas   filas de `facturas`
 * @param {object[]} recibidas  filas de `facturas_recibidas`
 * @param {{ mes: string, soloNoImpresas?: boolean }} filtro
 */
export function armarListas(facturas, recibidas, { mes, soloNoImpresas = false } = {}) {
  const delMes = (fila) => !mes || String(fila.dia).slice(0, 7) === mes
  const pendiente = (fila) => !soloNoImpresas || !fila.impreso_en
  const emitidas = (facturas || []).filter(esEmitidaImprimible).map(filaEmitida)
    .filter(delMes).filter(pendiente).sort(porNumero)
  const rec = (recibidas || []).filter(r => r && r.descartada !== true).map(filaRecibida)
    .filter(delMes).filter(pendiente).sort(porFecha)
  return { emitidas, recibidas: rec }
}

/**
 * Filas que entran al PDF, en orden de impresión. Las "sin PDF" nunca entran.
 * @param {{ emitidas, recibidas }} listas  salida de armarListas
 * @param {'todas'|'seleccionadas'} modo
 * @param {Set<string>|string[]} seleccion  claves tildadas
 */
export function paraImprimir(listas, modo = 'todas', seleccion = []) {
  const tildadas = seleccion instanceof Set ? seleccion : new Set(seleccion || [])
  const todas = [...(listas?.emitidas || []), ...(listas?.recibidas || [])]
  return todas.filter(f => !f.sin_pdf && (modo === 'todas' || tildadas.has(f.clave)))
}

// Casilla de "todas" de una lista: se tildan solo las que tienen PDF.
export function alternarTodas(seleccion, filas, marcar) {
  const out = new Set(seleccion)
  for (const f of filas || []) {
    if (f.sin_pdf) continue
    if (marcar) out.add(f.clave)
    else out.delete(f.clave)
  }
  return out
}

export function alternarUna(seleccion, clave) {
  const out = new Set(seleccion)
  if (out.has(clave)) out.delete(clave)
  else out.add(clave)
  return out
}

// Al cambiar el filtro, la selección se queda solo con lo que sigue visible.
export function podarSeleccion(seleccion, listas) {
  const visibles = new Set(paraImprimir(listas, 'todas').map(f => f.clave))
  return new Set([...seleccion].filter(c => visibles.has(c)))
}

const plural = (n, uno, varios) => `${n} ${n === 1 ? uno : varios}`

/**
 * Resumen corto: "12 emitidas + 4 recibidas, 3 sin PDF".
 * Cuenta todo lo que se le pasa (filas listadas o filas a imprimir).
 */
export function resumen(filas) {
  const lista = filas || []
  const emitidas = lista.filter(f => f.origen === 'emitida' && !f.sin_pdf).length
  const recibidas = lista.filter(f => f.origen === 'recibida' && !f.sin_pdf).length
  const sinPdf = lista.filter(f => f.sin_pdf).length
  let texto = `${plural(emitidas, 'emitida', 'emitidas')} + ${plural(recibidas, 'recibida', 'recibidas')}`
  if (sinPdf) texto += `, ${sinPdf} sin PDF`
  return { emitidas, recibidas, sinPdf, total: emitidas + recibidas, texto }
}

// Ids por tabla, para "Marcar como impresas" (solo lo que entró al último PDF).
export function idsPorTabla(filas) {
  const facturas = [], facturas_recibidas = []
  for (const f of filas || []) {
    if (f.origen === 'emitida') facturas.push(f.id)
    else if (f.origen === 'recibida') facturas_recibidas.push(f.id)
  }
  return { facturas, facturas_recibidas }
}

export const nombrePdf = (ym) => `voltra-facturas-contadora-${ym}.pdf`

// ── Errores ──
// Columna inexistente (impreso_en sin migrar): Postgres 42703 o PostgREST PGRST204.
// Va ANTES que esTablaInexistente: ese también matchea "does not exist".
export function esColumnaInexistente(error) {
  if (!error) return false
  const code = String(error.code || '')
  const msg = String(error.message || '').toLowerCase()
  return code === '42703' || code === 'PGRST204' || /column .* does not exist/.test(msg)
    || (msg.includes('could not find') && msg.includes('column'))
}
