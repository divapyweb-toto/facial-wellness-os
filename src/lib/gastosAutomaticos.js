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
//   · Gastos fijos     → los que se anotan UNA vez en Config (Shopify, Supabase…)
//
// WhatsApp y Claude se registran en dólares: hace falta el tipo de cambio de
// Config. Si falta, NO se inventa uno: se muestran en dólares y no se suman.
// ═══════════════════════════════════════════════════════════
import { familiaProducto } from './recompra'

const num = (v) => Number(v) || 0

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

// Todo lo de un período. Entradas ya leídas de la base (esta función no toca red).
//   adsDiario:  [{ fecha, gasto, producto_id, tienda? }]
//   productos:  [{ id, nombre }]
//   mesesConCampanas: Set de 'YYYY-MM' que ya tienen publicidad cargada a mano
//   tienda:     'voltra' | 'fw' | 'todas'
//   fraccionMes: qué parte del mes cubre el período (para prorratear gastos fijos)
export function armarGastosAutomaticos({
  adsDiario = [], productos = [], mesesConCampanas = new Set(),
  waMensajes = [], turnosIA = [], ciclosMejora = [],
  tienda = 'voltra', usdPyg = 0, gastosFijosTexto = '', fraccionMes = 1,
} = {}) {
  const idAFamilia = new Map((productos || []).map(p => [p.id, familiaProducto(p.nombre)]))

  // Meta diario. Si el mes ya tiene publicidad cargada a mano en Campañas, esa
  // manda: sumar las dos contaría la misma plata dos veces.
  const metaPorFamilia = {}
  let metaTotal = 0, metaDescartado = 0
  for (const r of adsDiario) {
    const t = r.tienda || 'fw'
    if (tienda !== 'todas' && t !== tienda) continue
    if (mesesConCampanas.has(String(r.fecha).slice(0, 7))) { metaDescartado += num(r.gasto); continue }
    const g = num(r.gasto)
    metaTotal += g
    const fam = idAFamilia.get(r.producto_id)
    if (fam) metaPorFamilia[fam] = (metaPorFamilia[fam] || 0) + g
  }

  // WhatsApp y Claude son de Voltra: Facial Wellness no los usa.
  const aplicaVoltra = tienda === 'voltra' || tienda === 'todas'
  const waUsd = aplicaVoltra ? waMensajes.reduce((s, m) => s + num(m.costo_usd), 0) : 0
  const claudeUsd = aplicaVoltra
    ? turnosIA.filter(t => !t.simulado).reduce((s, t) => s + num(t.costo_usd), 0)
      + ciclosMejora.reduce((s, c) => s + num(c.costo_usd), 0)
    : 0

  const hayTC = num(usdPyg) > 0
  const aGs = (usd) => (hayTC ? Math.round(usd * usdPyg) : 0)

  // Gastos fijos mensuales (prorrateados al período).
  const fijos = aplicaVoltra ? parsearGastosFijos(gastosFijosTexto).map(f => {
    const faltaTC = f.usd && !hayTC
    const gs = faltaTC ? 0 : Math.round((f.usd ? f.monto * usdPyg : f.monto) * fraccionMes)
    return { concepto: f.concepto, gs, faltaTC }
  }) : []

  const whatsappGs = aGs(waUsd), claudeGs = aGs(claudeUsd)
  const fijosGs = fijos.reduce((s, f) => s + f.gs, 0)
  const usdSinConvertir = hayTC ? 0 : waUsd + claudeUsd
  return {
    metaTotal, metaPorFamilia, metaDescartado,
    waUsd, claudeUsd, whatsappGs, claudeGs,
    fijos, fijosGs,
    // Lo que se suma a los gastos del reporte (Meta se suma aparte, a la publicidad).
    totalGs: whatsappGs + claudeGs + fijosGs,
    usdPyg: num(usdPyg), faltaTipoCambio: !hayTC && (waUsd > 0 || claudeUsd > 0 || fijos.some(f => f.faltaTC)),
    usdSinConvertir,
  }
}

// Lee de la base lo que hace falta. Cada lectura es independiente: si una
// tabla falla (o la columna `tienda` todavía no existe) el reporte sigue.
export async function cargarGastosAutomaticos(cliente, { inicio, fin }) {
  const dia = (d, fin_) => `${d}T${fin_ ? '23:59:59' : '00:00:00'}-03:00`
  const seguro = async (fn) => { try { const { data, error } = await fn(); return error ? null : (data || []) } catch { return null } }

  let ads = await seguro(() => cliente.from('gasto_ads_diario').select('fecha, gasto, producto_id, tienda').gte('fecha', inicio).lte('fecha', fin).limit(5000))
  // Sin la columna `tienda` (migración todavía sin correr): todo es de Facial Wellness.
  if (ads === null) ads = await seguro(() => cliente.from('gasto_ads_diario').select('fecha, gasto, producto_id').gte('fecha', inicio).lte('fecha', fin).limit(5000)) || []

  const [wa, turnos, ciclos] = await Promise.all([
    seguro(() => cliente.from('wa_mensajes').select('costo_usd').not('costo_usd', 'is', null).gte('creado_en', dia(inicio)).lte('creado_en', dia(fin, true)).limit(20000)),
    seguro(() => cliente.from('vendedor_turnos').select('costo_usd, simulado').gte('creado_en', dia(inicio)).lte('creado_en', dia(fin, true)).limit(20000)),
    seguro(() => cliente.from('mejora_ciclos').select('costo_usd').gte('creado_en', dia(inicio)).lte('creado_en', dia(fin, true)).limit(1000)),
  ])
  return { adsDiario: ads, waMensajes: wa || [], turnosIA: turnos || [], ciclosMejora: ciclos || [] }
}
