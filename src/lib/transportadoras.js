// src/lib/transportadoras.js
// ═══════════════════════════════════════════════════════════
// TRANSPORTADORAS
//
// El negocio usa DOS transportadoras COD en paralelo:
//
//   · Punto a Punto (PAP) — 65 ciudades, tarifa PLANA (editable en Config),
//     rinde la plata en ~7 días o más.
//   · Lucero del Este   — 16 ciudades, tarifa POR CIUDAD, rinde al día siguiente.
//
// Las dos cobran el flete IGUAL entregue o no (las devoluciones se pagan).
// Por eso la decisión de cuál usar en cada ciudad no es solo el precio: una
// entrega adicional vale ~102.000 Gs. de margen, mucho más que la diferencia
// de flete. Cada tarifa de Lucero exige una tasa de entrega mínima para
// empatar a PaP — ver TASA_EQUILIBRIO más abajo.
//
// Decisión vigente (julio 2026): Lucero se lleva las 11 ciudades donde su
// tarifa es ≤ 30.000; PaP se queda con las de 35.000 y con las otras 49.
// ═══════════════════════════════════════════════════════════
import { getFlete } from './config'
import { tieneCobranzaPaP, emparejarCiudad, normalizarCiudadPaP } from './cobranzaPaP'

export const TRANSPORTADORAS = {
  pap: {
    id: 'pap',
    label: 'PAP',                     // lo que se imprime en la guía
    nombre: 'Punto a Punto',
    tarifaPlana: true,
    diasRendicion: 7,
  },
  lucero: {
    id: 'lucero',
    label: 'Lucero',                  // lo que se imprime en la guía
    nombre: 'Lucero del Este',
    tarifaPlana: false,
    diasRendicion: 1,
  },
}

export const IDS_TRANSPORTADORA = Object.keys(TRANSPORTADORAS)
export const esTransportadoraValida = (id) => IDS_TRANSPORTADORA.includes(id)

// Etiqueta para imprimir en la guía. Si el dato viniera vacío o corrupto,
// cae en PAP (que es el default histórico de todas las ventas viejas).
export function labelTransportadora(id) {
  return (TRANSPORTADORAS[id] || TRANSPORTADORAS.pap).label
}

// ─── Tarifario de Lucero del Este ───────────────────────────
// Claves normalizadas (minúscula, sin tildes) para poder cruzar con lo que
// escribe el cliente en el checkout. Fuente: tarifario vigente de Lucero.
// TODO: cuando exista la tabla `tarifas_envio` en Supabase, esto pasa a ser
// el respaldo y el precio real se lee de la base (para histórico correcto).
export const TARIFAS_LUCERO = {
  'ciudad del este': 20000,
  'asuncion': 25000,
  'lambare': 25000,
  'san lorenzo': 25000,
  'hernandarias': 25000,
  'presidente franco': 25000,
  'fernando de la mora': 30000,
  'luque': 30000,
  'mariano roque alonso': 30000,
  'villa elisa': 30000,
  'minga guazu': 30000,
  'aregua': 35000,
  'capiata': 35000,
  'itaugua': 35000,
  'limpio': 35000,
  'nemby': 35000,
}

const CIUDADES_LUCERO = Object.keys(TARIFAS_LUCERO)

// Nombre canónico en MAYÚSCULAS, como lo espera la planilla de Lucero.
// Si mandás la ciudad con otra grafía, su sistema la marca como no reconocida.
export const NOMBRE_OFICIAL_LUCERO = {
  'ciudad del este': 'CIUDAD DEL ESTE',
  'asuncion': 'ASUNCIÓN',
  'lambare': 'LAMBARÉ',
  'san lorenzo': 'SAN LORENZO',
  'hernandarias': 'HERNANDARIAS',
  'presidente franco': 'PRESIDENTE FRANCO',
  'fernando de la mora': 'FERNANDO DE LA MORA',
  'luque': 'LUQUE',
  'mariano roque alonso': 'MARIANO ROQUE ALONSO',
  'villa elisa': 'VILLA ELISA',
  'minga guazu': 'MINGA GUAZÚ',
  'aregua': 'AREGUÁ',
  'capiata': 'CAPIATÁ',
  'itaugua': 'ITAUGUÁ',
  'limpio': 'LIMPIO',
  'nemby': 'ÑEMBY',
}

// ─── Ruteo: qué transportadora conviene en cada ciudad ───────
// Tasa de entrega que Lucero necesita para EMPATAR a PaP, según su tarifa
// (con ticket ~127.000, COGS ~25.000 y PaP a 29.000 con 83% de entrega).
// Sirve para mostrar el criterio en la UI y para revisar la decisión cuando
// haya datos reales de Lucero.
export const TASA_EQUILIBRIO = {
  20000: 0.742,   // puede entregar 8.8pp PEOR que PaP y aún conviene
  25000: 0.791,   // puede entregar 3.9pp PEOR que PaP y aún conviene
  30000: 0.840,   // necesita 1.0pp MEJOR que PaP
  35000: 0.889,   // necesita 5.9pp MEJOR que PaP → por eso quedan en PaP
}

// Tarifa máxima de Lucero que aceptamos rutear automáticamente.
// Con 30.000 el equilibrio pide solo 1pp más de entrega (asumible por su
// velocidad). Con 35.000 pide 5.9pp, que no se puede asumir sin datos.
export const TARIFA_MAX_LUCERO = 30000

// Resuelve la ciudad del texto libre contra el tarifario de Lucero.
// Devuelve la clave normalizada o null.
export function ciudadLucero(ciudad) {
  return emparejarCiudad(ciudad, CIUDADES_LUCERO)
}

// ¿La transportadora hace COD en esta ciudad?
export function cubre(transportadora, ciudad) {
  if (transportadora === 'lucero') return ciudadLucero(ciudad) != null
  return tieneCobranzaPaP(ciudad)
}

// Tarifa de esa transportadora para esa ciudad.
// PaP: tarifa plana editable en Config. Lucero: por ciudad.
// Devuelve null si la transportadora no cubre la ciudad.
export function tarifaDe(transportadora, ciudad) {
  if (transportadora === 'lucero') {
    const c = ciudadLucero(ciudad)
    return c ? TARIFAS_LUCERO[c] : null
  }
  return tieneCobranzaPaP(ciudad) ? getFlete() : null
}

// Transportadoras que pueden llevar un pedido a esa ciudad.
export function transportadorasDisponibles(ciudad) {
  return IDS_TRANSPORTADORA.filter(id => cubre(id, ciudad))
}

// ─── Sugerencia automática ──────────────────────────────────
// Regla vigente: Lucero si cubre la ciudad Y su tarifa es ≤ 30.000
// (más barato o +1.000 compensado por cobrar 6 días antes).
// En las de 35.000 y en todo lo que Lucero no cubre, va PaP.
// Devuelve { transportadora, motivo } — el motivo se muestra en Despacho
// para que la decisión sea auditable y no una caja negra.
export function sugerirTransportadora(ciudad) {
  const cL = ciudadLucero(ciudad)
  const hayPaP = tieneCobranzaPaP(ciudad)

  if (cL) {
    const tarifa = TARIFAS_LUCERO[cL]
    if (tarifa <= TARIFA_MAX_LUCERO) {
      const flete = getFlete()
      const dif = tarifa - flete
      const motivo = dif < 0
        ? `Lucero ${Math.abs(dif).toLocaleString('es-PY')} más barato y rinde al día siguiente`
        : dif === 0
          ? 'Misma tarifa y rinde al día siguiente'
          : `+${dif.toLocaleString('es-PY')} pero rinde al día siguiente`
      return { transportadora: 'lucero', motivo, tarifa }
    }
    // Lucero cubre pero está a 35.000: necesitaría 5.9pp más de entrega.
    if (hayPaP) {
      return {
        transportadora: 'pap',
        motivo: `Lucero cuesta ${TARIFAS_LUCERO[cL].toLocaleString('es-PY')} acá — no compensa`,
        tarifa: getFlete(),
      }
    }
    // PaP no cubre y Lucero sí, aunque sea caro: mejor caro que sin despachar.
    return {
      transportadora: 'lucero',
      motivo: 'PaP no cubre esta ciudad',
      tarifa: TARIFAS_LUCERO[cL],
    }
  }

  if (hayPaP) return { transportadora: 'pap', motivo: 'Lucero no cubre esta ciudad', tarifa: getFlete() }
  return { transportadora: null, motivo: 'Ninguna transportadora cubre esta ciudad', tarifa: null }
}

// Nombre de ciudad tal cual lo espera la planilla de Lucero.
// Si no la reconoce, devuelve lo que vino en mayúsculas (Lucero lo va a marcar
// para que lo corrijas a mano, que es mejor que mandarlo vacío).
export function ciudadParaPlanillaLucero(ciudad) {
  const c = ciudadLucero(ciudad)
  if (c && NOMBRE_OFICIAL_LUCERO[c]) return NOMBRE_OFICIAL_LUCERO[c]
  return String(ciudad || '').toUpperCase().trim()
}

export { normalizarCiudadPaP }
