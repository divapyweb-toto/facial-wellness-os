// src/lib/riesgoCiudad.js
// ═══════════════════════════════════════════════════════════
// RIESGO POR CIUDAD (bloqueo de despacho) + TASA DE ENTREGA POR TRANSPORTADORA
//
// Hay ciudades que no entregan. Mandás el paquete, el cliente no recibe, vuelve,
// y pagaste el flete igual (PaP y Lucero cobran las devoluciones). Cada envío a
// una ciudad de 0% es plata quemada.
//
// Este módulo detecta esas ciudades y las bloquea en Despacho — con override
// manual, igual que el bloqueo por riesgo de cliente.
//
// ── LA TRAMPA QUE HAY QUE EVITAR ──
// Una ciudad con 1 envío devuelto tiene "0% de entrega". Bloquearla sería
// absurdo: no sabés nada de esa ciudad todavía, tenés UN dato. Por eso se exige
// una MUESTRA MÍNIMA de envíos resueltos antes de bloquear. Sin ese piso, el
// sistema se auto-cierra ciudades sanas por mala suerte inicial.
//
// ── POR TRANSPORTADORA ──
// La tasa se calcula además por transportadora, porque una ciudad puede entregar
// mal con una y bien con la otra. En ese caso NO se bloquea la ciudad: se sugiere
// cambiar de transportadora, que es la decisión correcta.
// ═══════════════════════════════════════════════════════════
import { normalizarCiudadPaP } from './cobranzaPaP'

// Muestra mínima de envíos RESUELTOS (entregados + devueltos) para poder juzgar
// una ciudad. Con menos que esto, la ciudad va siempre en 'ok' (sin datos).
export const MIN_MUESTRA_CIUDAD = 5

// Tasa de entrega por debajo de la cual se bloquea (con muestra suficiente).
export const BLOQUEO_TASA_CIUDAD = 0.20
// Tasa por debajo de la cual se avisa, sin bloquear.
export const RIESGO_TASA_CIUDAD = 0.50

const clave = (c) => normalizarCiudadPaP(c)

// Construye el historial por ciudad a partir de las entregas ya resueltas.
//
//   entregas: [{ n_referencia, ciudad, categoria }]  categoria: entregado|devuelto|...
//   transpPorRef: { [n_referencia normalizada]: 'pap' | 'lucero' }
//
// La transportadora sale de la VENTA (que es donde se decidió al despachar),
// no de la entrega — así funciona aunque el importador todavía no la guarde.
export function construirHistorialCiudades(entregas, transpPorRef = {}) {
  const mapa = new Map()
  const norm = (r) => String(r || '').replace(/[^0-9]/g, '')

  ;(entregas || []).forEach(e => {
    const cat = e.categoria
    if (cat !== 'entregado' && cat !== 'devuelto') return   // en proceso no cuenta
    const k = clave(e.ciudad)
    if (!k) return
    if (!mapa.has(k)) {
      mapa.set(k, {
        ciudad: e.ciudad, resueltos: 0, entregados: 0, devueltos: 0,
        porTransportadora: {},
      })
    }
    const h = mapa.get(k)
    h.resueltos++
    if (cat === 'entregado') h.entregados++; else h.devueltos++

    const t = transpPorRef[norm(e.n_referencia)] || 'pap'
    if (!h.porTransportadora[t]) h.porTransportadora[t] = { resueltos: 0, entregados: 0, devueltos: 0 }
    const ht = h.porTransportadora[t]
    ht.resueltos++
    if (cat === 'entregado') ht.entregados++; else ht.devueltos++
  })

  // Tasas calculadas al final
  mapa.forEach(h => {
    h.tasa = h.resueltos ? h.entregados / h.resueltos : null
    Object.values(h.porTransportadora).forEach(ht => {
      ht.tasa = ht.resueltos ? ht.entregados / ht.resueltos : null
    })
  })
  return mapa
}

// Evalúa una ciudad. Si se pasa `transportadora`, evalúa ESA transportadora en
// esa ciudad (y si la otra anda bien, devuelve la sugerencia en vez de bloquear).
//
// Devuelve { nivel, tasa, resueltos, entregados, devueltos, alternativa, motivo }
//   nivel: 'sin_datos' | 'ok' | 'riesgo' | 'bloqueado'
export function evaluarCiudad(historial, ciudad, transportadora = null) {
  const vacio = { nivel: 'sin_datos', tasa: null, resueltos: 0, entregados: 0, devueltos: 0, alternativa: null, motivo: '' }
  if (!historial) return vacio
  const h = historial.get(clave(ciudad))
  if (!h) return vacio

  // Base de evaluación: la transportadora pedida, o la ciudad completa.
  const base = transportadora && h.porTransportadora[transportadora]
    ? h.porTransportadora[transportadora]
    : h

  const { resueltos, entregados, devueltos, tasa } = base

  // Muestra insuficiente → no se juzga. Beneficio de la duda.
  if (resueltos < MIN_MUESTRA_CIUDAD) {
    return {
      nivel: 'sin_datos', tasa, resueltos, entregados, devueltos, alternativa: null,
      motivo: resueltos > 0 ? `Solo ${resueltos} envío${resueltos > 1 ? 's' : ''} resuelto${resueltos > 1 ? 's' : ''} — muestra insuficiente` : '',
    }
  }

  // ¿La otra transportadora anda mejor acá? Si sí, no se bloquea: se sugiere.
  let alternativa = null
  if (transportadora) {
    for (const [t, ht] of Object.entries(h.porTransportadora)) {
      if (t === transportadora) continue
      if (ht.resueltos >= MIN_MUESTRA_CIUDAD && ht.tasa != null && ht.tasa > (tasa ?? 0) + 0.15) {
        if (!alternativa || ht.tasa > alternativa.tasa) alternativa = { transportadora: t, tasa: ht.tasa, resueltos: ht.resueltos }
      }
    }
  }

  let nivel = 'ok'
  if (tasa <= BLOQUEO_TASA_CIUDAD) nivel = 'bloqueado'
  else if (tasa < RIESGO_TASA_CIUDAD) nivel = 'riesgo'

  // Si hay una alternativa claramente mejor, se degrada el bloqueo a riesgo:
  // el problema no es la ciudad, es la transportadora.
  if (nivel === 'bloqueado' && alternativa) nivel = 'riesgo'

  const pct = (x) => `${Math.round((x ?? 0) * 100)}%`
  let motivo = ''
  if (nivel === 'bloqueado') {
    motivo = `${pct(tasa)} de entrega en ${resueltos} envíos (${devueltos} devueltos). Cada envío acá pierde plata.`
  } else if (nivel === 'riesgo') {
    motivo = alternativa
      ? `${pct(tasa)} de entrega con esta transportadora. La otra va ${pct(alternativa.tasa)} — conviene cambiar.`
      : `${pct(tasa)} de entrega en ${resueltos} envíos. Por debajo de lo sano.`
  }
  return { nivel, tasa, resueltos, entregados, devueltos, alternativa, motivo }
}

// ─── Tasa de entrega por transportadora (global, para KPIs) ──
// Devuelve { pap: {resueltos, entregados, devueltos, tasa}, lucero: {...}, total: {...} }
export function tasaPorTransportadora(entregas, transpPorRef = {}) {
  const norm = (r) => String(r || '').replace(/[^0-9]/g, '')
  const acc = {}
  const sumar = (k, cat) => {
    if (!acc[k]) acc[k] = { resueltos: 0, entregados: 0, devueltos: 0 }
    acc[k].resueltos++
    if (cat === 'entregado') acc[k].entregados++; else acc[k].devueltos++
  }
  ;(entregas || []).forEach(e => {
    const cat = e.categoria
    if (cat !== 'entregado' && cat !== 'devuelto') return
    const t = transpPorRef[norm(e.n_referencia)] || 'pap'
    sumar(t, cat)
    sumar('total', cat)
  })
  Object.values(acc).forEach(a => { a.tasa = a.resueltos ? a.entregados / a.resueltos : null })
  return acc
}
