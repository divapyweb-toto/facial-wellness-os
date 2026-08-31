// src/lib/config.js
// ═══════════════════════════════════════════════════════════
// CONFIGURACIÓN CENTRAL del sistema.
//
// Parámetros que antes estaban fijos en el código y ahora se editan desde
// Config: flete de PaP, umbrales de riesgo, ventanas de recompra, datos de pago.
//
// Cómo funciona (para que nunca rompa):
//   • DEFAULTS tiene los valores actuales. Si la config no cargó todavía, o
//     Supabase falla, se usan los defaults → el sistema anda igual.
//   • cargarConfig() trae los valores de la tabla `config` y los cachea.
//   • Los getters (getFlete, etc.) son SÍNCRONOS y leen del caché con fallback.
// ═══════════════════════════════════════════════════════════
import { supabase } from './supabase'

// Valores por defecto = los que estaban en el código.
const DEFAULTS = {
  flete_pap: 29000,
  // Desde el 25/08/2026 el envío va INCLUIDO en el precio y no se cobra
  // aparte: el default tiene que ser 0, igual que la fila de `config`. Si
  // quedaba en 33000 y la carga de config fallaba, cada pedido nuevo salía
  // 33.000 Gs más caro sin que nada avisara.
  envio_cliente: 0,
  riesgo_bloqueo_fallos: 2,
  riesgo_bloqueo_tasa: 0.5,
  riesgo_tasa: 0.34,
  recompra_dias_reposicion: 28,
  recompra_dias_crosssell: 15,
  recompra_dias_cooldown: 25,
  pago_alias: '6103233',
  pago_alias_titular: 'CI José Ramírez',
  pago_tigo: '0981 948 800',
  // Tarifario de Lucero como JSON: { 'ciudad': [precio, velocidad] }.
  // Vacío = usar el de fábrica de transportadoras.js. Lo edita ConfigPage.
  tarifas_lucero: '',
}

// Caché en memoria. Arranca con los defaults.
let cache = { ...DEFAULTS }
let cargado = false

// Resultado de la última carga. cargarConfig() traga los errores a propósito
// (el sistema tiene que andar aunque Supabase falle), pero eso vuelve el fallo
// INVISIBLE: podés creer que rige tu tarifa editada y estar corriendo con la
// de fábrica. Config usa esto para decir de dónde vienen los valores.
let estadoCarga = { hecho: false, desdeDB: 0, error: null }
export const getEstadoConfig = () => ({ ...estadoCarga })

// Convierte el texto guardado al tipo del default (número o string).
function coerce(clave, valor) {
  if (valor == null) return DEFAULTS[clave]
  const def = DEFAULTS[clave]
  if (typeof def === 'number') {
    const n = Number(valor)
    return Number.isFinite(n) ? n : def
  }
  return String(valor)
}

// Carga la config desde Supabase al caché. Llamar una vez al iniciar la app.
// Si falla, deja los defaults (no rompe nada).
export async function cargarConfig() {
  try {
    const { data, error } = await supabase.from('config').select('clave, valor')
    if (error) throw error
    const nuevo = { ...DEFAULTS }
    let desdeDB = 0
    for (const row of (data || [])) {
      if (row.clave in DEFAULTS) { nuevo[row.clave] = coerce(row.clave, row.valor); desdeDB++ }
    }
    cache = nuevo
    cargado = true
    estadoCarga = { hecho: true, desdeDB, error: null }
  } catch (e) {
    // Sin config guardada: se usan los defaults. El sistema anda igual…
    // pero queda registrado, para que Config pueda avisarlo.
    cargado = true
    estadoCarga = { hecho: true, desdeDB: 0, error: e?.message || String(e) }
  }
  return cache
}

// Getter genérico (síncrono). Devuelve el valor del caché o el default.
export function getConfig(clave) {
  return cache[clave] ?? DEFAULTS[clave]
}

// Guarda un valor y actualiza el caché al instante.
export async function guardarConfig(clave, valor) {
  const { error } = await supabase.from('config')
    .upsert({ clave, valor: String(valor), actualizado: new Date().toISOString() }, { onConflict: 'clave' })
  if (error) throw error
  cache[clave] = coerce(clave, valor)
  return cache[clave]
}

// Guarda varios valores de una vez.
export async function guardarConfigLote(pares) {
  const filas = Object.entries(pares).map(([clave, valor]) => ({
    clave, valor: String(valor), actualizado: new Date().toISOString(),
  }))
  const { error } = await supabase.from('config').upsert(filas, { onConflict: 'clave' })
  if (error) throw error
  for (const [clave, valor] of Object.entries(pares)) cache[clave] = coerce(clave, valor)
  return cache
}

// ── Getters específicos (los que usan los módulos) ──
export const getFlete = () => getConfig('flete_pap')
export const getTarifasLuceroJSON = () => getConfig('tarifas_lucero')
export const getEnvioCliente = () => getConfig('envio_cliente')
export const getUmbralesRiesgo = () => ({
  bloqueoFallos: getConfig('riesgo_bloqueo_fallos'),
  bloqueoTasa: getConfig('riesgo_bloqueo_tasa'),
  riesgoTasa: getConfig('riesgo_tasa'),
})
export const getVentanasRecompra = () => ({
  diasReposicion: getConfig('recompra_dias_reposicion'),
  diasCrosssell: getConfig('recompra_dias_crosssell'),
  diasCooldown: getConfig('recompra_dias_cooldown'),
})
export const getDatosPago = () => ({
  alias: getConfig('pago_alias'),
  titular: getConfig('pago_alias_titular'),
  tigo: getConfig('pago_tigo'),
})

export { DEFAULTS }
export const configCargada = () => cargado
