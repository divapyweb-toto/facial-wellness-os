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
  // Días desde que PaP ingresó el paquete a su sistema (fecha_ingreso, dato
  // diario, no horario — no se guarda la hora exacta) antes de considerarlo
  // "atascado" y ofrecer reclamarlo. Dos umbrales porque una ciudad cercana
  // que no se mueve en 1 día es sospechosa; una del interior puede tardar más
  // por logística normal (ver zona en ciudades.js).
  // Guaraníes por dólar de RESPALDO. Los gastos en USD (WhatsApp API, Claude
  // API) se convierten con el cambio de su día (ver tipoCambio.js); esto solo
  // rige si esa cotización no se puede obtener. 0 = sin respaldo: ese gasto
  // queda en dólares, sin sumar, en vez de inventar una cotización.
  usd_pyg: 0,
  // Gastos fijos mensuales de Voltra, una línea por gasto:  "Shopify: 180000"
  // o "Supabase: 25 usd". Reportes los prorratea según el período.
  gastos_fijos_voltra: '',
  seguimiento_pap_dias_cerca: 1,
  seguimiento_pap_dias_lejos: 2,
  // Qué estados de PaP vale la pena reclamar. "Custodio" y "No Gestionado"
  // llegan a categoria='en_proceso' cuando el motivo no matchea una palabra
  // de devolución (ver categorizarPaP), pero para Enrique son bajas, no
  // pedidos circulando — insistirle a PaP por esos no sirve de nada. Lista
  // en texto, separada por coma, para poder sumar un estado nuevo sin tocar
  // código si PaP inventa uno.
  seguimiento_pap_estados_reclamables: 'Asignado a ruta, En Oficina',
  // Primera línea del mensaje agrupado a PaP. Lo demás (la lista de guías,
  // agrupada por el estado que dice PaP) se arma solo — no hace falta
  // tocarlo para eso.
  plantilla_seguimiento_pap: 'Hola! Necesito que me ayuden con el seguimiento de estos envíos:',
  // Mensaje al cliente con el link de seguimiento de Lucero. {{nombre}} y
  // {{link}} se reemplazan solos.
  plantilla_tracking_lucero:
    'Hola {{nombre}}! Tu pedido de Facial Wellness ya está en camino con Lucero. ' +
    'Podés seguirlo acá: {{link}}',
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
export function coerce(clave, valor) {
  if (valor == null) return DEFAULTS[clave]
  const def = DEFAULTS[clave]
  if (typeof def === 'number') {
    // Vacío → default. Number('') da 0: un umbral vacío bloqueaba a todos.
    if (String(valor).trim() === '') return def
    const n = Number(valor)
    return Number.isFinite(n) ? n : def
  }
  return String(valor)
}

// Rangos válidos de los campos numéricos de Config. Se chequean antes de
// guardar: un valor fuera de rango (ej. 0 fallos) cambia el negocio en silencio.
const RANGOS = {
  riesgo_bloqueo_fallos: { min: 1, nombre: 'Bloquear desde (fallos)' },
  riesgo_bloqueo_tasa: { min: 0, max: 1, nombre: 'Tasa de bloqueo' },
  riesgo_tasa: { min: 0, max: 1, nombre: 'Tasa de riesgo' },
  recompra_dias_reposicion: { min: 1, nombre: 'Reponer consumible cada' },
  recompra_dias_crosssell: { min: 1, nombre: 'Ofrecer producto nuevo desde' },
  recompra_dias_cooldown: { min: 1, nombre: 'No repetir contacto por' },
  seguimiento_pap_dias_cerca: { min: 1, nombre: 'Días para reclamar (cerca)' },
  seguimiento_pap_dias_lejos: { min: 1, nombre: 'Días para reclamar (interior)' },
  flete_pap: { min: 0, nombre: 'Flete PaP' },
  envio_cliente: { min: 0, nombre: 'Envío al cliente' },
  usd_pyg: { min: 0, nombre: 'Tipo de cambio de respaldo' },
}

// Devuelve la lista de errores (vacía = se puede guardar). Solo mira las
// claves presentes en `valores`.
export function validarReglas(valores) {
  const errores = []
  for (const [clave, valor] of Object.entries(valores || {})) {
    if (typeof DEFAULTS[clave] !== 'number') continue
    const r = RANGOS[clave] || { min: 0, nombre: clave }
    const txt = String(valor ?? '').trim()
    const n = Number(txt)
    if (txt === '' || !Number.isFinite(n)) { errores.push(`${r.nombre}: no puede quedar vacío`); continue }
    if (r.min != null && n < r.min) errores.push(`${r.nombre}: mínimo ${r.min}`)
    if (r.max != null && n > r.max) errores.push(`${r.nombre}: máximo ${r.max}`)
  }
  return errores
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
export const getUmbralesSeguimientoPaP = () => ({
  diasCerca: getConfig('seguimiento_pap_dias_cerca'),
  diasLejos: getConfig('seguimiento_pap_dias_lejos'),
  estadosReclamables: String(getConfig('seguimiento_pap_estados_reclamables') || '')
    .split(',').map(s => s.trim()).filter(Boolean),
})
export const getGastosAutomaticosConfig = () => ({
  usdPyg: getConfig('usd_pyg'),
  gastosFijosTexto: getConfig('gastos_fijos_voltra'),
})
export const getPlantillaSeguimientoPaP = () => getConfig('plantilla_seguimiento_pap')
export const getPlantillaTrackingLucero = () => getConfig('plantilla_tracking_lucero')

export { DEFAULTS }
export const configCargada = () => cargado
