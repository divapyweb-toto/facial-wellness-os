// src/lib/gastosAutomaticos.js
// ═══════════════════════════════════════════════════════════
// GASTOS QUE SE CARGAN SOLOS
//
// Reportes ya suma los gastos manuales (Finanzas) y la publicidad cargada a
// mano (Campañas). Acá se agregan los que el sistema ya registra por su cuenta:
//
//   · Meta Ads diario  → gasto_ads_diario (lo escribe la sincronización)
//   · WhatsApp API     → wa_mensajes.costo_usd (lo que cobra Meta por mensaje)
//   · Claude API       → vendedor_turnos.costo_usd + mejora_ciclos.costo_usd
//   · Lo REAL facturado → gastos_proveedor_diario (claude, whatsapp, elevenlabs).
//     Por proveedor y por día: si hay dato real, manda el real y el estimado de
//     ese día no se suma; si no, se usa el estimado. ElevenLabs solo tiene real.
//   · Gastos fijos     → los que se anotan UNA vez en Config (Shopify, Supabase…)
//
// WhatsApp y Claude se registran en dólares: hace falta el tipo de cambio de
// Config. Si falta, NO se inventa uno: se muestran en dólares y no se suman.
// ═══════════════════════════════════════════════════════════
import { familiaProducto } from './recompra'
import { tasaDelDia } from './tipoCambio'
import { fetchAll } from './fetchAll'

const num = (v) => Number(v) || 0

// Día de Paraguay (UTC-3) de un instante guardado en UTC.
export const diaLocal = (iso) => (iso ? new Date(new Date(iso).getTime() - 3 * 3600000).toISOString().slice(0, 10) : null)

// Convierte dólares a guaraníes con el cambio del día de CADA fila. Una fila sin
// fecha usa el respaldo; sin cambio posible, queda sin convertir (y se avisa).
//   diaDe / usdDe: cómo sacar el día paraguayo y los dólares de cada fila.
function convertirPorDia(filas, tasas, respaldo, diaDe = f => diaLocal(f.creado_en), usdDe = f => num(f.costo_usd)) {
  let usd = 0, gs = 0, sinConvertir = 0, usdConvertido = 0
  const usadas = []
  for (const f of filas) {
    const d = usdDe(f)
    if (!d) continue
    usd += d
    const t = tasaDelDia(tasas, diaDe(f), respaldo)
    if (t > 0) { gs += d * t; usdConvertido += d; usadas.push(t) } else sinConvertir += d
  }
  return { usd, gs: Math.round(gs), sinConvertir, usdConvertido, usadas }
}

const VACIO = { usd: 0, gs: 0, sinConvertir: 0, usdConvertido: 0, usadas: [] }

// Un proveedor, día por día: si ese día hay lo FACTURADO por el proveedor
// (gastos_proveedor_diario), manda eso y el estimado de ese día no se suma.
// Si no hay dato real, se usa el estimado del sistema.
//   estimadas: filas { costo_usd, creado_en } (lo que el sistema calcula solo)
//   reales:    filas { fecha, monto_usd } de ese proveedor
function costoProveedor(estimadas, reales, tasas, respaldo) {
  const diasReales = new Set(reales.map(r => String(r.fecha).slice(0, 10)))
  const estDelDia = estimadas.filter(f => !diasReales.has(diaLocal(f.creado_en)))
  const real = convertirPorDia(reales, tasas, respaldo, r => String(r.fecha).slice(0, 10), r => num(r.monto_usd))
  const est = convertirPorDia(estDelDia, tasas, respaldo)
  const diasEst = new Set(estDelDia.filter(f => num(f.costo_usd)).map(f => diaLocal(f.creado_en) || 'sin-fecha'))
  return {
    usd: real.usd + est.usd, gs: real.gs + est.gs,
    sinConvertir: real.sinConvertir + est.sinConvertir,
    usdConvertido: real.usdConvertido + est.usdConvertido,
    usadas: [...real.usadas, ...est.usadas],
    realUsd: real.usd, realGs: real.gs, estimadoUsd: est.usd, estimadoGs: est.gs,
    diasReales: diasReales.size, diasEstimados: diasEst.size,
    // 'real' | 'estimado' | 'mixto' | 'sin-datos' — para la marca en Reportes.
    origen: diasReales.size && diasEst.size ? 'mixto' : diasReales.size ? 'real' : diasEst.size ? 'estimado' : 'sin-datos',
  }
}

// Gastos fijos escritos en Config, una línea por gasto:
//   Shopify: 180000          (guaraníes por mes)
//   Supabase: 25 usd         (dólares por mes)
export function parsearGastosFijos(texto) {
  return String(texto ?? '').split('\n').map(l => l.trim()).filter(Boolean).map(l => {
    const m = l.match(/^(.+?)\s*:\s*([\d.,]+)\s*(usd|us\$|\$|gs|₲)?\s*$/i)
    if (!m) return null
    const monto = parseFloat(m[2].replace(/\./g, '').replace(',', '.')) || (parseFloat(m[2]) || 0)
    const usd = /usd|us\$|\$/i.test(m[3] || '')
    return monto > 0 ? { concepto: m[1].trim(), monto, usd } : null
  }).filter(Boolean)
}

const detalleOrigen = (p) => ({
  tipo: p.origen, realUsd: p.realUsd, realGs: p.realGs, estimadoUsd: p.estimadoUsd, estimadoGs: p.estimadoGs,
  diasReales: p.diasReales, diasEstimados: p.diasEstimados,
})

// Gastos manuales del período sin doble conteo de publicidad. Si hay ads
// (Campañas a mano o Meta sincronizado) Y además gastos de categoría
// "Publicidad", es la misma plata cargada dos veces: se resta SOLO el ads y el
// de Publicidad queda afuera (posibleDoble avisa para que se borre).
// Fuente única para Dashboard y Reportes.
export const esGastoPublicidad = (g) => /public|ads|meta|marketing/i.test(g?.categoria || '')
export function gastosSinDobleAds(gastos = [], totalAds = 0) {
  const bruto = (gastos || []).reduce((s, g) => s + (Number(g.monto) || 0), 0)
  const gastoPublicidad = (gastos || []).filter(esGastoPublicidad).reduce((s, g) => s + (Number(g.monto) || 0), 0)
  const posibleDoble = totalAds > 0 && gastoPublicidad > 0
  return { totalGastos: bruto - (posibleDoble ? gastoPublicidad : 0), gastoPublicidad, posibleDoble }
}

// Clave del set de meses con publicidad cargada a mano. Una fila sin tienda
// (anterior a la columna) es de Facial Wellness, igual que en gasto_ads_diario.
export const claveCampanaManual = (tienda, mes) => `${tienda || 'fw'}|${String(mes).slice(0, 7)}`

// Todo lo de un período. Entradas ya leídas de la base (esta función no toca red).
//   adsDiario:  [{ fecha, gasto, producto_id, tienda? }]
//   productos:  [{ id, nombre }]
//   gastosReales: [{ fecha, proveedor, concepto, monto_usd }] (gastos_proveedor_diario)
//   mesesConCampanas: Set de 'tienda|YYYY-MM' (ver claveCampanaManual) que ya
//     tienen publicidad cargada a mano. Una clave sin tienda ('YYYY-MM') vale
//     para todas las tiendas (compatibilidad con llamadas viejas).
//   tienda:     'voltra' | 'fw' | 'todas'
//   fraccionMes: qué parte del mes cubre el período (para prorratear gastos fijos)
export function armarGastosAutomaticos({
  adsDiario = [], productos = [], mesesConCampanas = new Set(),
  waMensajes = [], turnosIA = [], ciclosMejora = [], gastosReales = [],
  tienda = 'voltra', usdPyg = 0, tasas = new Map(), fechaTasaFijos = null, gastosFijosTexto = '', fraccionMes = 1,
} = {}) {
  const idAFamilia = new Map((productos || []).map(p => [p.id, familiaProducto(p.nombre)]))

  // Meta diario. Si el mes ya tiene publicidad cargada a mano en Campañas, esa
  // manda: sumar las dos contaría la misma plata dos veces.
  const metaPorFamilia = {}
  let metaTotal = 0, metaDescartado = 0
  for (const r of adsDiario) {
    const t = r.tienda || 'fw'
    if (tienda !== 'todas' && t !== tienda) continue
    // Por tienda+mes: en "Todas", una campaña manual de FW no puede descartar
    // el Meta sincronizado de Voltra del mismo mes (son cuentas distintas).
    const mes = String(r.fecha).slice(0, 7)
    if (mesesConCampanas.has(claveCampanaManual(t, mes)) || mesesConCampanas.has(mes)) { metaDescartado += num(r.gasto); continue }
    const g = num(r.gasto)
    metaTotal += g
    const fam = idAFamilia.get(r.producto_id)
    if (fam) metaPorFamilia[fam] = (metaPorFamilia[fam] || 0) + g
  }

  // WhatsApp y Claude son de Voltra: Facial Wellness no los usa.
  const aplicaVoltra = tienda === 'voltra' || tienda === 'todas'
  const realesDe = (prov) => (gastosReales || []).filter(r => r.proveedor === prov && r.fecha)
  const vacio = { ...VACIO, realUsd: 0, realGs: 0, estimadoUsd: 0, estimadoGs: 0, diasReales: 0, diasEstimados: 0, origen: 'sin-datos' }
  const wa = aplicaVoltra ? costoProveedor(waMensajes, realesDe('whatsapp'), tasas, usdPyg) : vacio
  const cl = aplicaVoltra
    ? costoProveedor([...turnosIA.filter(t => !t.simulado), ...ciclosMejora], realesDe('claude'), tasas, usdPyg)
    : vacio
  const el = aplicaVoltra ? costoProveedor([], realesDe('elevenlabs'), tasas, usdPyg) : vacio
  const waUsd = wa.usd, claudeUsd = cl.usd

  // Fijos en dólares: el cambio de la fecha de referencia (fin del período, o hoy).
  const tFijos = tasaDelDia(tasas, fechaTasaFijos, usdPyg)
  const fijos = aplicaVoltra ? parsearGastosFijos(gastosFijosTexto).map(f => {
    const faltaTC = f.usd && !(tFijos > 0)
    const gs = faltaTC ? 0 : Math.round((f.usd ? f.monto * tFijos : f.monto) * fraccionMes)
    return { concepto: f.concepto, gs, faltaTC }
  }) : []

  const whatsappGs = wa.gs, claudeGs = cl.gs, elevenlabsGs = el.gs, elevenlabsUsd = el.usd
  const fijosGs = fijos.reduce((s, f) => s + f.gs, 0)
  const usdSinConvertir = wa.sinConvertir + cl.sinConvertir + el.sinConvertir
  const usadas = [...wa.usadas, ...cl.usadas, ...el.usadas]
  const usdConv = wa.usdConvertido + cl.usdConvertido + el.usdConvertido
  const rangoTasa = usadas.length
    ? { min: Math.min(...usadas), max: Math.max(...usadas), prom: Math.round((whatsappGs + claudeGs + elevenlabsGs) / usdConv) }
    : null
  return {
    metaTotal, metaPorFamilia, metaDescartado,
    waUsd, claudeUsd, whatsappGs, claudeGs, elevenlabsUsd, elevenlabsGs,
    // Cuánto fue real (facturado por el proveedor) y cuánto estimado, por proveedor.
    origen: {
      whatsapp: detalleOrigen(wa), claude: detalleOrigen(cl), elevenlabs: detalleOrigen(el),
    },
    fijos, fijosGs,
    // Lo que se suma a los gastos del reporte (Meta se suma aparte, a la publicidad).
    totalGs: whatsappGs + claudeGs + elevenlabsGs + fijosGs,
    rangoTasa, faltaTipoCambio: usdSinConvertir > 0 || fijos.some(f => f.faltaTC),
    usdSinConvertir,
  }
}

// Lee de la base lo que hace falta. Cada lectura es independiente: si una
// tabla falla (o la columna `tienda` todavía no existe) el reporte sigue.
export async function cargarGastosAutomaticos(cliente, { inicio, fin }) {
  const dia = (d, fin_) => `${d}T${fin_ ? '23:59:59' : '00:00:00'}-03:00`
  // Paginado con fetchAll: `.limit(20000)` NO pasa el tope de 1.000 filas de
  // Supabase (corta en silencio). Cada tabla se ordena por una clave única.
  const seguro = async (fn) => { try { return await fn() } catch { return null } }
  const todo = (q, columnaOrden = 'id') => seguro(() => fetchAll(q, { columnaOrden }))

  // gasto_ads_diario es único por (fecha, adset_id): orden adset_id + fecha.
  let ads = await todo(() => cliente.from('gasto_ads_diario').select('fecha, gasto, producto_id, tienda').gte('fecha', inicio).lte('fecha', fin).order('adset_id'), 'fecha')
  // Sin la columna `tienda` (migración todavía sin correr): todo es de Facial Wellness.
  if (ads === null) ads = await todo(() => cliente.from('gasto_ads_diario').select('fecha, gasto, producto_id').gte('fecha', inicio).lte('fecha', fin).order('adset_id'), 'fecha') || []

  const [wa, turnos, ciclos, reales] = await Promise.all([
    todo(() => cliente.from('wa_mensajes').select('costo_usd, creado_en').not('costo_usd', 'is', null).gte('creado_en', dia(inicio)).lte('creado_en', dia(fin, true))),
    todo(() => cliente.from('vendedor_turnos').select('costo_usd, simulado, creado_en').gte('creado_en', dia(inicio)).lte('creado_en', dia(fin, true))),
    todo(() => cliente.from('mejora_ciclos').select('costo_usd, creado_en').gte('creado_en', dia(inicio)).lte('creado_en', dia(fin, true))),
    // Lo facturado por cada proveedor. Si la tabla todavía no existe, queda
    // vacío y el reporte sigue con el estimado, como antes.
    // Clave única (fecha, proveedor, concepto).
    todo(() => cliente.from('gastos_proveedor_diario').select('fecha, proveedor, concepto, monto_usd').gte('fecha', inicio).lte('fecha', fin).order('proveedor').order('concepto'), 'fecha'),
  ])
  return { adsDiario: ads, waMensajes: wa || [], turnosIA: turnos || [], ciclosMejora: ciclos || [], gastosReales: reales || [] }
}
