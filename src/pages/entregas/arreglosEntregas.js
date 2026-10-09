// src/pages/entregas/arreglosEntregas.js
// Funciones puras que usa EntregasPage. Viven aparte para poder probarlas
// sin React ni Supabase (tests/entregas-ventas-arreglos.test.mjs).
import { normalizarRef } from '../../lib/referencias'

// Lo que se manda a Voltra OS después de un reporte de PaP: SOLO las filas de
// ESTE reporte (no todo el histórico) y nunca filas de Lucero.
export function filasPaPParaVoltra(reportesNuevos) {
  return (reportesNuevos || []).filter(r => r && r.transportadora !== 'lucero')
}

// Ids de ventas a pasar a `estado`, cruzando la referencia normalizada en
// memoria ('FW-2071' cruza con '2071'; 'VT-1003' NO cruza con '1003').
// Solo las que todavía no tienen ese estado.
export function idsVentasParaEstado(ventas, refs, estado) {
  const buscadas = new Set((refs || []).map(normalizarRef).filter(Boolean))
  if (!buscadas.size) return []
  return (ventas || [])
    .filter(v => v && v.estado !== estado && buscadas.has(normalizarRef(v.n_referencia)))
    .map(v => v.id)
}

// Fecha de hoy en Paraguay ('YYYY-MM-DD'), sin importar la zona de la máquina.
export function hoyParaguay(ahora = new Date()) {
  return new Intl.DateTimeFormat('en-CA', { timeZone: 'America/Asuncion', year: 'numeric', month: '2-digit', day: '2-digit' }).format(ahora)
}

// Días entre una fecha 'YYYY-MM-DD' y hoy (día de Paraguay). Antes se hacía
// new Date('YYYY-MM-DD') (medianoche UTC) contra la hora local: sumaba un día.
export function diasDesdeParaguay(fecha, ahora = new Date()) {
  const f = String(fecha || '').slice(0, 10)
  if (!/^\d{4}-\d{2}-\d{2}$/.test(f)) return null
  const aUTC = (s) => { const [y, m, d] = s.split('-').map(Number); return Date.UTC(y, m - 1, d) }
  return Math.max(0, Math.round((aUTC(hoyParaguay(ahora)) - aUTC(f)) / 86400000))
}

// Lo que te deben los couriers, separado. Usa `depositoReal` (Lucero descuenta
// el flete antes de depositar) y cae al importe bruto si no existe.
export function deudaPorCourier(entregadosSinRendir) {
  const out = { pap: 0, lucero: 0, total: 0 }
  for (const m of (entregadosSinRendir || [])) {
    const monto = Number(m.depositoReal ?? m.importe) || 0
    const k = m.transportadora === 'lucero' ? 'lucero' : 'pap'
    out[k] += monto
    out.total += monto
  }
  return out
}

// ¿Esta fila de entregas es de la tienda elegida arriba? (Voltra / FW / Todas)
export function esDeTienda(fila, tienda) {
  if (!tienda || tienda === 'todas') return true
  return (fila?.tienda || 'fw') === tienda
}
