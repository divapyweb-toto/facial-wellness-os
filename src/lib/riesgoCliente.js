// src/lib/riesgoCliente.js
// ═══════════════════════════════════════════════════════════
// RIESGO DE CLIENTE (control de fraude / clientes que no reciben)
//
// Detecta clientes con historial de NO recibir su pedido (devoluciones por
// rechazo, inubicable, no desea, etc). La idea no es bloquear a lo bruto, sino
// razonar con volumen + tasa:
//   • 10 pedidos, 2 no recibió (20%)  → OK, es normal
//   • 3 pedidos, 2 no recibió (67%)   → bloquear, es un patrón
//   • 2 pedidos, 2 no recibió (100%)  → bloquear
//   • 2 pedidos, 1 no recibió (50%)   → riesgo → conviene pago anticipado
//
// El admin siempre puede forzar el despacho o exigir pago anticipado.
// ═══════════════════════════════════════════════════════════

// Umbrales (razonables, aprobados)
const BLOQUEO_FALLOS = 2      // mínimo de fallos para considerar bloqueo
const BLOQUEO_TASA = 0.5      // + tasa de fallo ≥ 50%
const RIESGO_TASA = 0.34      // riesgo: al menos 1 fallo y tasa ≥ 34%

import { getUmbralesRiesgo } from './config'

// Normaliza un teléfono paraguayo para cruzar clientes entre pedidos.
export function normalizarTel(t) {
  if (!t) return ''
  let s = String(t).replace(/\D/g, '')
  if (s.startsWith('595')) s = '0' + s.slice(3)
  if (s && !s.startsWith('0')) s = '0' + s
  return s
}

// Normaliza una referencia (para cruzar ventas ⋈ entregas).
function normRef(ref) {
  if (!ref) return ''
  let r = String(ref).replace(/[#\s.\-/]/g, '').trim()
  if (/^\d+$/.test(r)) r = String(parseInt(r, 10))
  return r
}

// Resuelve el estado real de una venta: primero lo que dice PaP (más confiable),
// y si PaP no tiene datos, se cae a ventas.estado.
function estadoReal(v, estadoPaP) {
  const cat = estadoPaP?.[normRef(v.n_referencia)]
  if (cat) return cat
  if (v.estado === 'entregado') return 'entregado'
  if (v.estado === 'devuelto') return 'devuelto'
  return 'en_proceso'
}

// Construye el historial de cada cliente a partir de sus ventas históricas.
// ventas: [{ cliente_telefono, n_referencia, estado, fecha, producto_nombre }]
// estadoPaP: { normRef → 'entregado'|'devuelto'|'en_proceso' } (opcional, más preciso)
// Devuelve Map: telNormalizado → { pedidos, fallos, entregados, ultimaFallaFecha, nombre }
// Nota: solo cuenta pedidos RESUELTOS (entregado o devuelto). Los en tránsito no
// suman ni a favor ni en contra.
export function construirHistorialClientes(ventas, estadoPaP = {}) {
  const hist = new Map()
  for (const v of (ventas || [])) {
    const tel = normalizarTel(v.cliente_telefono)
    if (!tel) continue
    const cat = estadoReal(v, estadoPaP)
    if (cat === 'en_proceso') continue // todavía no cerró: no cuenta
    if (!hist.has(tel)) hist.set(tel, { telefono: tel, nombre: v.cliente_nombre || '', pedidos: 0, fallos: 0, entregados: 0, ultimaFallaFecha: null })
    const h = hist.get(tel)
    h.pedidos++
    if (cat === 'devuelto') {
      h.fallos++
      if (!h.ultimaFallaFecha || (v.fecha && v.fecha > h.ultimaFallaFecha)) h.ultimaFallaFecha = v.fecha
    } else {
      h.entregados++
    }
    if (v.cliente_nombre && !h.nombre) h.nombre = v.cliente_nombre
  }
  return hist
}

// Evalúa el nivel de riesgo de un cliente según su historial.
// Devuelve { nivel: 'ok'|'riesgo'|'bloqueado', pedidos, fallos, entregados, tasa }
export function evaluarRiesgo(h) {
  const pedidos = h?.pedidos || 0
  const fallos = h?.fallos || 0
  const entregados = h?.entregados || 0
  if (pedidos === 0) return { nivel: 'ok', pedidos: 0, fallos: 0, entregados: 0, tasa: 0 }
  const tasa = fallos / pedidos
  const { bloqueoFallos, bloqueoTasa, riesgoTasa } = getUmbralesRiesgo()
  let nivel = 'ok'
  if (fallos >= bloqueoFallos && tasa >= bloqueoTasa) nivel = 'bloqueado'
  else if (fallos >= 1 && tasa >= riesgoTasa) nivel = 'riesgo'
  return { nivel, pedidos, fallos, entregados, tasa }
}

// Texto corto para mostrarle al admin por qué un cliente está marcado.
export function motivoRiesgo(ev) {
  if (!ev || ev.nivel === 'ok') return ''
  const pct = Math.round((ev.tasa || 0) * 100)
  if (ev.nivel === 'bloqueado') {
    return `${ev.pedidos} pedidos, ${ev.fallos} no recibió (${pct}%). Patrón de no recepción.`
  }
  return `${ev.pedidos} pedido${ev.pedidos === 1 ? '' : 's'}, ${ev.fallos} no recibió (${pct}%). Conviene pago anticipado.`
}

export { BLOQUEO_FALLOS, BLOQUEO_TASA, RIESGO_TASA }
