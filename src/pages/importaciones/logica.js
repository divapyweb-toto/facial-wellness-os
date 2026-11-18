// src/pages/importaciones/logica.js
// Lógica pura de la mesa de decisión de Importaciones: tarjetas, semáforo,
// alertas, comparación de proveedores, cambio aéreo/marítimo, escalera de
// precios y cantidad recomendada. Toda la plata la calcula el motor.
import { evaluar, contribucionPorPedido, lineasDeRuta } from '../../lib/productos/motor'
import { convertirAPYG } from '../../lib/productos/dinero'

export const ETAPAS = [
  { v: 'SUGERIDO', label: 'Sugerido' }, { v: 'INVESTIGADO', label: 'Investigado' }, { v: 'COTIZADO', label: 'Cotizado' },
  { v: 'MUESTRA', label: 'Muestra' }, { v: 'EN_PRUEBA', label: 'En prueba' }, { v: 'DECIDIR', label: 'Decidir' },
  { v: 'IMPORTADO', label: 'Importado' }, { v: 'DESCARTADO', label: 'Descartado' },
]
export const etapaDe = (c) => c?.etapa || 'SUGERIDO'
export const TOPE_ADS_VOLTRA = 35000 // ₲ por confirmado (tope, no meta)
export const MAX_MESES_NO_PROBADO = 4
const DIA = 86400000

// Regla de fotos (igual que el disparador de la base): 3 reales (IA no cuenta) y ≥ 1 del proveedor.
export function reglaFotos(fotos) {
  const lista = fotos || []
  const reales = lista.filter(f => f.fuente !== 'ia_referencia').length
  const proveedor = lista.filter(f => f.fuente === 'proveedor').length
  const ok = reales >= 3 && proveedor >= 1
  const motivo = ok ? null : `Para pasar a Decidir hacen falta 3 fotos reales (hay ${reales}; las de IA de referencia no cuentan) y al menos 1 del proveedor (hay ${proveedor}).`
  return { ok, reales, proveedor, motivo }
}

// Foto principal (contrato 18-11): solo cuenta la marcada es_principal. Sin principal = alerta roja,
// aunque haya otras fotos.
export const fotoPrincipal = (fotos) => (fotos || []).find(f => f.es_principal) || null
export function alertaFoto(fotos) {
  const lista = fotos || []
  if (!lista.length) return { tipo: 'sin_foto', texto: 'Sin foto' }
  if (!fotoPrincipal(lista)) return { tipo: 'sin_principal', texto: 'Sin foto principal: elegí una' }
  return null
}
// Link externo de foto: solo http/https (nunca data: ni otros esquemas fuera de DEMO).
export function urlFotoExternaValida(url) {
  const t = String(url || '').trim()
  if (!/^https?:\/\//i.test(t)) return false
  try { const u = new URL(t); return (u.protocol === 'http:' || u.protocol === 'https:') && !!u.hostname } catch { return false }
}

const ultimoPor = (arr, campo = 'candidato_id') => {
  const m = new Map()
  for (const x of arr || []) if (!m.has(x[campo])) m.set(x[campo], x) // vienen ordenados del más nuevo al más viejo
  return m
}

// Tarjeta del tablero para un candidato.
export function armarTarjetas(t, ahora = new Date()) {
  const escPorCand = new Map()
  for (const e of t.escenarios || []) {
    const prev = escPorCand.get(e.candidato_id)
    if (!prev || (/base/i.test(e.nombre || '') && !/base/i.test(prev.nombre || ''))) escPorCand.set(e.candidato_id, e)
  }
  const casoPorCand = new Map()
  for (const c of t.casos || []) { const p = casoPorCand.get(c.candidato_id); if (!p || (c.version || 0) > (p.version || 0)) casoPorCand.set(c.candidato_id, c) }
  const ordenPorCand = ultimoPor(t.ordenes || [])

  return (t.candidatos || []).map(c => {
    const esc = escPorCand.get(c.id) || null
    const r = esc?.resultado?.resumen || {}
    const caso = casoPorCand.get(c.id) || null
    const fotos = (t.fotos || []).filter(f => f.candidato_id === c.id)
    const principal = fotos.find(f => f.es_principal) || fotos[0] || null
    const cots = (t.cotizaciones || []).filter(q => q.candidato_id === c.id)
    const vigentes = cots.filter(q => q.valida_hasta && new Date(q.valida_hasta) >= ahora)
    const vence = vigentes.map(q => new Date(q.valida_hasta)).sort((a, b) => a - b)[0] || null
    const alertas = alertasDe({ cots, esc, ahora })
    const sem = semaforo({ esc, caso, fotos, cots, ahora })
    return {
      c, etapa: etapaDe(c), principal, nFotos: fotos.length, alertaFoto: t.fotos ? alertaFoto(fotos) : null, esc,
      precio: esc?.entradas?.motor?.precio ?? null,
      ganancia: r.contribDespuesAdsConfirmado ?? null,
      plata: plataTotal(esc?.resultado),
      dias: r.diasRecuperacion ?? null,
      recupera: r.recupera ?? null,
      vence, semaforo: sem, alertas, orden: ordenPorCand.get(c.id) || null,
    }
  })
}

// Plata total necesaria = salidas del calendario de caja (muestra + lote + flete + tributos + anuncios...).
// Si no hay caja, el desembolso del lote. Si no, desconocido.
export function plataTotal(resultado) {
  const cj = resultado?.caja
  if (cj?.totales?.salidas != null) return cj.totales.salidas
  return resultado?.resumen?.desembolsoLote ?? null
}

// Verde = pasa todas las reglas; amarillo = falta algún dato; rojo = bloqueo duro.
export function semaforo({ esc, caso, fotos, cots, ahora = new Date() }) {
  const bloqueos = caso?.bloqueos?.bloqueos || []
  if (bloqueos.length) return { color: 'rojo', motivos: bloqueos.map(b => b.mensaje || b.codigo) }
  const faltan = []
  if (!esc) faltan.push('sin escenario de rentabilidad guardado')
  const r = esc?.resultado?.resumen || {}
  if (esc && r.contribDespuesAdsConfirmado == null) faltan.push('sin costo de anuncios en el escenario')
  if (esc && r.contribDespuesAdsConfirmado != null && r.contribDespuesAdsConfirmado <= 0) faltan.push('ganancia por pedido ≤ 0 (estimada)')
  if (esc && r.cajaNecesaria == null) faltan.push('sin calendario de caja')
  if (!caso) faltan.push('sin rúbrica / decisión evaluada')
  if (!reglaFotos(fotos).ok) faltan.push('faltan fotos (3 reales, 1 del proveedor)')
  if (!(cots || []).some(q => q.tipo === 'firme' && q.valida_hasta && new Date(q.valida_hasta) >= ahora)) faltan.push('sin cotización firme vigente')
  if (esc?.entradas?.semaforoCaja && esc.entradas.semaforoCaja !== 'VERDE') faltan.push(`semáforo de caja ${String(esc.entradas.semaforoCaja).toLowerCase()}`)
  return faltan.length ? { color: 'amarillo', motivos: faltan } : { color: 'verde', motivos: ['pasa todas las reglas cargadas'] }
}

// Alertas: cotización por vencer (≤ 3 días) o vencida, precio del proveedor cambiado,
// tipo de cambio del escenario con más de 7 días.
export function alertasDe({ cots, esc, ahora = new Date() }) {
  const out = []
  for (const q of cots || []) {
    if (!q.valida_hasta) continue
    const dias = (new Date(q.valida_hasta) - ahora) / DIA
    if (dias < 0) out.push({ tipo: 'vencida', texto: 'Cotización vencida' })
    else if (dias <= 3) out.push({ tipo: 'por_vencer', texto: `Cotización vence en ${Math.max(0, Math.ceil(dias))} día(s)` })
  }
  const porProv = new Map()
  for (const q of [...(cots || [])].sort((a, b) => new Date(a.creado_en) - new Date(b.creado_en))) {
    const p0 = (q.escalones || [])[0]?.precio_unit_minor
    if (p0 == null) continue
    const prev = porProv.get(q.proveedor_id)
    if (prev && prev.moneda === q.moneda && prev.p0 !== p0) out.push({ tipo: 'precio_cambiado', texto: 'El proveedor cambió el precio' })
    porProv.set(q.proveedor_id, { p0, moneda: q.moneda })
  }
  const lineas = esc?.entradas?.motor?.lote?.lineas || []
  if (lineas.some(l => l.moneda && l.moneda !== 'PYG') && esc?.calculado_en && (ahora - new Date(esc.calculado_en)) / DIA > 7) {
    out.push({ tipo: 'tc_viejo', texto: 'Tipo de cambio de hace más de 7 días' })
  }
  const vistos = new Set()
  return out.filter(a => (vistos.has(a.texto) ? false : vistos.add(a.texto)))
}

// Tipo de cambio que usó el escenario base por moneda (texto "1 X = N PYG").
export function tcDelEscenario(esc) {
  const out = {}
  for (const l of esc?.entradas?.motor?.lote?.lineas || []) if (l.moneda && l.moneda !== 'PYG' && l.tc_a_pyg && !out[l.moneda]) out[l.moneda] = l.tc_a_pyg
  return out
}

// Compara cotizaciones normalizadas a costo puesto por unidad vendible en ₲:
// precio del escalón (en ₲) ÷ (1 − merma) + logística/tributos por unidad vendible
// del escenario base (todo lo que no es mercadería). Marca qué es estimado.
export function compararProveedores(d, esc, { cantidad } = {}) {
  const tc = tcDelEscenario(esc)
  const cp = esc?.resultado?.escenarios?.base?.resultado?.costoPuesto || null
  const uv = cp?.entradas?.unidadesVendibles || null
  const uc = cp?.entradas?.unidadesCompradas || null
  const merma = uv && uc ? 1 - uv / uc : 0
  // Logística y tributos por unidad vendible del escenario base (todo lo que no es mercadería).
  // Un proveedor LOCAL no paga flete internacional: a ese se le saca esa partida.
  let otrosPorUnidad = null, otrosLocal = null
  if (cp && cp.totalPYG != null && uv) {
    const suma = (re) => (cp.detalle || []).filter(x => re.test(x.concepto || '')).reduce((s, x) => s + (x.pyg || 0), 0)
    const merc = suma(/mercader|producto/i)
    const fleteInt = suma(/^Flete internacional/i)
    otrosPorUnidad = Math.round((cp.totalPYG - merc) / uv)
    otrosLocal = Math.round((cp.totalPYG - merc - fleteInt) / uv)
  }
  const q = cantidad || uc || null
  const provPorId = Object.fromEntries((d.proveedores || []).map(p => [p.id, p]))
  return (d.cotizaciones || []).map(c => {
    const esc2 = (c.escalones || []).filter(e => e?.cantidad != null && e?.precio_unit_minor != null).sort((a, b) => a.cantidad - b.cantidad)
    const elegido = (q ? esc2.filter(e => e.cantidad <= q).pop() : null) || esc2[0] || null
    let pyg = null, falta = null
    if (elegido) { try { pyg = convertirAPYG(elegido.precio_unit_minor, c.moneda, c.moneda === 'PYG' ? null : tc[c.moneda] || null).pyg } catch { falta = `falta tipo de cambio ${c.moneda}` } }
    const prov = provPorId[c.proveedor_id] || null
    const otros = prov?.plataforma === 'local' ? otrosLocal : otrosPorUnidad
    const precioVendible = pyg == null ? null : Math.round(pyg / (1 - merma))
    const costoPuesto = precioVendible == null || otros == null ? null : precioVendible + otros
    return { c, prov, elegido, escalones: esc2, pyg, precioVendible, costoPuesto, falta, estimado: otros != null, sinFleteInternacional: prov?.plataforma === 'local' }
  }).sort((a, b) => (a.costoPuesto ?? a.precioVendible ?? Infinity) - (b.costoPuesto ?? b.precioVendible ?? Infinity))
}

// Recalcula el escenario base cambiando la ruta de flete internacional (aéreo / marítimo / local).
// pesoKg = kg cobrables del lote; tarifaMaritima opcional {monto, moneda} ("verificar").
export function costoConRuta(esc, idRuta, { pesoKg, tcUSD, tarifaMaritima } = {}) {
  const base = esc?.entradas?.motor
  if (!base?.lote) throw new Error('El escenario guardado no tiene lote: cargalo en Productos nuevos → Rentabilidad.')
  const otras = base.lote.lineas.filter(l => !/^Flete internacional/i.test(l.concepto || ''))
  const sobre = idRuta === 'barco_easybox' && tarifaMaritima?.monto ? { tarifa: tarifaMaritima, fuente: 'tarifa marítima tipeada (verificar)', fecha: null } : {}
  const lineasRuta = lineasDeRuta(idRuta, { pesoCobrableKg: Number(pesoKg) || 0, tcAPyg: tcUSD || tcDelEscenario(esc).USD || null, sobreescribir: sobre })
  const entradas = { ...base, lote: { ...base.lote, lineas: [...otras, ...lineasRuta] } }
  return evaluar(entradas)
}

// Escalera 1/2/3 unidades de Voltra: contribución de cada oferta con el costo del escenario base.
export function escalera(esc, precios) {
  const base = esc?.entradas?.motor
  const costoUnit = esc?.resultado?.resumen?.costoUnit
  if (!base || costoUnit == null) return []
  return precios.map((precio, i) => {
    if (precio == null) return { unidades: i + 1, precio: null }
    const { lote, usarRango, nombre, fuentes, ...e } = base
    try {
      const c = contribucionPorPedido({ ...e, precio, costoUnit, unidadesPorPedido: i + 1 })
      return { unidades: i + 1, precio, porConfirmado: c.porConfirmado.contribucionDespuesAds, porIniciado: c.porIniciado.contribucionDespuesAds, adsMax: c.porConfirmado.costoAdsMaximo }
    } catch (err) { return { unidades: i + 1, precio, error: err.message.replace(/^\[motor\]\s*/, '') } }
  })
}

// Cantidad recomendada: piloto (muestra + lote aéreo chico) contra lote marítimo,
// sin pasar nunca de 4 meses de venta de algo no probado. ritmo = unidades vendidas por día esperadas.
export function cantidadRecomendada({ ritmoUnidadesDia, moq, costoUnit, semaforoCaja, probado = false, diasPiloto = 21 }) {
  const ritmo = Number(ritmoUnidadesDia) || 0
  if (!ritmo || costoUnit == null) return null
  const tope = Math.floor(ritmo * 30 * MAX_MESES_NO_PROBADO)
  const piloto = Math.ceil(ritmo * diasPiloto)
  // Si el proveedor pide un mínimo mayor que el piloto, se sube hasta el MOQ (sin pasar el tope de 4 meses).
  const pilotoAjustado = moq ? Math.max(piloto, Math.min(moq, tope)) : piloto
  const maritimo = Math.min(tope, Math.max(moq || 0, Math.ceil(ritmo * 90)))
  const cajaFrena = semaforoCaja === 'AMARILLO' || semaforoCaja === 'ROJO'
  const recomendado = cajaFrena ? 'solo_muestra' : probado ? 'maritimo' : 'piloto'
  return {
    tope, piloto: pilotoAjustado, maritimo, recomendado,
    plataPiloto: pilotoAjustado * costoUnit, plataMaritimo: maritimo * costoUnit,
    moqSuperaTope: moq != null && moq > tope,
    nota: cajaFrena ? `Caja en ${semaforoCaja.toLowerCase()}: no se compra lote; como mucho, muestra cuando vuelva a verde.` : probado ? 'Producto probado: el lote marítimo baja el costo, siempre dentro de 4 meses de venta.' : 'Producto no probado: primero muestra + lote aéreo chico; el marítimo después del piloto.',
  }
}
