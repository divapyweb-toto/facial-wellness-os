// src/lib/motorCourier.js · 21-10-2026
// ═══════════════════════════════════════════════════════════
// MOTOR DE COURIER en el front (Despacho).
//
// La decisión la toma la base (rpc `motor_courier`: ganancia esperada por courier, con datos medidos). Acá solo:
//   · se lee el INTERRUPTOR (config 'motor_courier'): mientras activo=false el motor SOLO SUGIERE;
//   · se pide la decisión de cada pedido (en paralelo, una vez por clave, con tope de 4 s);
//   · funciones PURAS: qué courier queda al final, cómo se registra un cambio manual, qué línea se muestra.
//
// Si el interruptor, la rpc o la red fallan, TODO sigue como hoy (sin motor): ninguna función de acá tira.
// Nada de p ni de ganancias se calcula en el front.
// ═══════════════════════════════════════════════════════════
import { supabase } from './supabase'

export const TIMEOUT_MOTOR_MS = 4000
const REINTENTO_FALLO_MS = 30000   // una decisión que falló no se vuelve a pedir durante 30 s (evita insistir en bucle)

const hoyPY = (d = new Date()) => d.toLocaleDateString('en-CA', { timeZone: 'America/Asuncion' })

// ─── Interruptor ───────────────────────────────────────────
// config.motor_courier = '{"activo": false, "desde": null}'
//   activo=false → solo sugiere (todo se comporta como hoy). activo=true → asigna solo al CARGAR una venta nueva.
//   desde = AAAA-MM-DD opcional: antes de esa fecha (hora de Paraguay) el motor sigue como apagado.
const MOTOR_APAGADO = Object.freeze({ activo: false, desde: null })
let cfgMotor = { ...MOTOR_APAGADO }
let cfgCargada = false
let cfgEnCurso = null
let estadoCfg = { hecho: false, error: null }

export const getEstadoMotorConfig = () => ({ ...estadoCfg })

// Texto de la base → { activo, desde }. Cualquier cosa rara = apagado (nunca prende el motor por error).
export function interpretarConfigMotor(valor) {
  try {
    const o = typeof valor === 'string' ? JSON.parse(valor) : valor
    if (o && typeof o === 'object' && !Array.isArray(o)) {
      const desde = typeof o.desde === 'string' && /^\d{4}-\d{2}-\d{2}/.test(o.desde.trim()) ? o.desde.trim().slice(0, 10) : null
      return { activo: o.activo === true, desde }
    }
  } catch { /* cae al apagado */ }
  return { ...MOTOR_APAGADO }
}

// ¿Rige el motor hoy? (activo y, si hay fecha "desde", ya llegó).
export function motorEstaActivo(cfg, hoy = hoyPY()) {
  return !!cfg && cfg.activo === true && (!cfg.desde || String(hoy) >= String(cfg.desde))
}

export const motorActivo = (hoy = hoyPY()) => motorEstaActivo(cfgMotor, hoy)
export const fijarConfigMotor = (valor) => { cfgMotor = interpretarConfigMotor(valor); cfgCargada = true; return { ...cfgMotor } }

// Lee el interruptor. Nunca tira: si falla, el motor queda apagado (como hoy) y se vuelve a intentar la próxima vez.
export async function cargarMotorConfig(cliente = supabase) {
  if (cfgEnCurso) return cfgEnCurso
  cfgEnCurso = (async () => {
    try {
      const { data, error } = await cliente.from('config').select('valor').eq('clave', 'motor_courier').maybeSingle()
      if (error) throw error
      if (data?.valor == null) {
        // Sin fila (o sin sesión: RLS devuelve vacío): apagado, y se reintenta más adelante.
        cfgMotor = { ...MOTOR_APAGADO }; cfgCargada = false
        estadoCfg = { hecho: true, error: 'sin fila motor_courier (¿sin sesión?)' }
      } else {
        cfgMotor = interpretarConfigMotor(data.valor); cfgCargada = true
        estadoCfg = { hecho: true, error: null }
      }
    } catch (e) {
      cfgMotor = { ...MOTOR_APAGADO }; cfgCargada = false
      estadoCfg = { hecho: true, error: e?.message || String(e) }
    } finally {
      cfgEnCurso = null
    }
    return { ...cfgMotor }
  })()
  return cfgEnCurso
}

// Carga solo si todavía no cargó bien (para llamarla al abrir Despacho, ya con sesión).
export const asegurarMotorConfig = () => (cfgCargada ? Promise.resolve({ ...cfgMotor }) : cargarMotorConfig())

// ─── Decisiones (rpc motor_courier) ────────────────────────
const normTexto = (t) => String(t ?? '').trim().toLowerCase()

// Clave de caché: ciudad + producto + cobro + cod (como pide la base; el costo del producto no entra).
export const claveDecision = ({ ciudad, producto, cobro, cod = true } = {}) =>
  [normTexto(ciudad), normTexto(producto), Math.round(Number(cobro) || 0), cod === false ? 0 : 1].join('|')

const COURIERS_MOTOR = ['pap', 'lucero']

// Respuesta de la rpc → decisión limpia, o null si no tiene la forma esperada (entonces se ignora).
export function normalizarDecision(d) {
  if (!d || typeof d !== 'object' || Array.isArray(d)) return null
  const ganador = COURIERS_MOTOR.includes(d.ganador) ? d.ganador : null
  const sinCob = d.sin_cobertura === true || d.regla === 'sin_cobertura'
  if (!ganador && !sinCob) return null
  return {
    ...d,
    ganador,
    regla: d.regla ?? null,
    sin_cobertura: sinCob,
    motivo: typeof d.motivo === 'string' ? d.motivo : '',
    pocos_datos: d.pocos_datos === true,
    fallback_producto: d.fallback_producto === true,
    opciones: Array.isArray(d.opciones) ? d.opciones.filter(o => o && typeof o === 'object') : [],
  }
}

const cache = new Map()   // clave → { promesa, resuelta: decisión|null, vence: ms|null }
export const limpiarCacheMotor = () => cache.clear()

// Lectura SÍNCRONA de lo ya pedido (para memos de React). null = todavía no hay decisión (o falló).
export function decisionGuardada(params) {
  return cache.get(claveDecision(params))?.resuelta ?? null
}

const conTope = (promesa, ms) => new Promise((resolve) => {
  let listo = false
  const t = setTimeout(() => { if (!listo) { listo = true; resolve(null) } }, ms)
  Promise.resolve(promesa).then(
    (v) => { if (!listo) { listo = true; clearTimeout(t); resolve(v) } },
    () => { if (!listo) { listo = true; clearTimeout(t); resolve(null) } },
  )
})

// Pide la decisión del motor para un pedido. Una sola llamada por clave (las siguientes reusan la misma promesa).
// Nunca tira: si la rpc falla, tarda más de 4 s o devuelve algo raro → null (todo sigue como hoy).
//   opts.rpc(args) → { data, error }  ·  opts.timeoutMs  ·  opts.ahora() (para tests)
export function decisionMotor({ ciudad, producto, cobro, costoProd = null, cod = true } = {}, opts = {}) {
  const clave = claveDecision({ ciudad, producto, cobro, cod })
  const ahora = (opts.ahora || Date.now)()
  const previo = cache.get(clave)
  if (previo && (previo.vence == null || ahora < previo.vence)) return previo.promesa
  if (!normTexto(ciudad) || !normTexto(producto)) return Promise.resolve(null)
  const rpc = opts.rpc || ((args) => supabase.rpc('motor_courier', args))
  const entrada = { promesa: null, resuelta: null, vence: null }
  entrada.promesa = conTope((async () => {
    const { data, error } = await rpc({
      p_ciudad: String(ciudad), p_producto: String(producto), p_cobro: Math.round(Number(cobro) || 0),
      p_costo_prod: costoProd == null ? null : Number(costoProd), p_cod: cod !== false,
    })
    if (error) return null
    return normalizarDecision(data)
  })(), opts.timeoutMs ?? TIMEOUT_MOTOR_MS).then((dec) => {
    entrada.resuelta = dec
    if (!dec) entrada.vence = (opts.ahora || Date.now)() + REINTENTO_FALLO_MS
    return dec
  })
  cache.set(clave, entrada)
  return entrada.promesa
}

// Pide varias decisiones en tandas (por defecto de 10 en paralelo) para no abrir cientos de llamadas a la vez.
// `activo()` se consulta entre tandas: si devuelve false (la pantalla cambió), se corta. `alTerminarTanda` avisa a la pantalla.
export async function pedirDecisiones(listaParams, { tanda = 10, alTerminarTanda, activo = () => true, opts } = {}) {
  const unicas = new Map()
  for (const x of listaParams || []) { const k = claveDecision(x); if (!unicas.has(k) && !decisionGuardada(x)) unicas.set(k, x) }
  const lista = [...unicas.values()]
  for (let i = 0; i < lista.length && activo(); i += tanda) {
    await Promise.all(lista.slice(i, i + tanda).map(x => decisionMotor(x, opts)))
    if (activo() && alTerminarTanda) alTerminarTanda()
  }
}

// ─── Parámetros de la consulta ─────────────────────────────
// Pedido del CSV / WhatsApp / "Traer de Voltra". `cod`: true = contra entrega (default).
// Todas las líneas de un mismo pedido comparten ciudad, producto de ruteo y cobro del pedido entero → misma decisión.
export const paramsMotorDePedido = (p, cod = true) => ({
  ciudad: p?.ciudad || '',
  producto: p?.productoRuteo || p?.producto_nombre || '',
  cobro: p?.totalOrden ?? p?.total ?? 0,
  cod: cod !== false,
})

// Venta ya cargada ("Desde Ventas"). `info` = { producto, cobro } del pedido entero (ver infoPorReferencia).
export const paramsMotorDeVenta = (v, info) => ({
  ciudad: v?.ciudad || '',
  producto: info?.producto || v?.producto_nombre || '',
  cobro: info?.cobro ?? v?.total ?? 0,
  cod: !v?.pago_anticipado,
})

// Filas de ventas (una por línea) → Map ref → { producto, cobro }. El producto es el de la regla de producto si hay
// (ej. JawFlex rige para toda la caja), si no el de la primera línea. `esForzado(nombre)` lo pone Despacho.
export function infoPorReferencia(ventas, esForzado = () => false) {
  const m = new Map()
  for (const v of ventas || []) {
    const ref = String(v?.n_referencia ?? '')
    const t = m.get(ref) || { producto: v?.producto_nombre || '', forzado: false, cobro: 0 }
    if (!t.forzado && esForzado(v?.producto_nombre)) { t.producto = v.producto_nombre; t.forzado = true }
    t.cobro += Number(v?.total) || 0
    m.set(ref, t)
  }
  return m
}

// ─── Qué courier queda ─────────────────────────────────────
// Prioridad: lo ya guardado en una venta (NUNCA se reasigna) > lo que Enrique eligió a mano > el motor (solo si está
// activo) > el de hoy. `disponibles` (opcional) = couriers que hoy cubren la ciudad según Despacho: si el ganador no
// está, no se aplica (mantiene el bloqueo de PaP sin cobranza). Motor activo + sin cobertura → null (flujo de
// pago anticipado de siempre).
export function elegirTransportadora({ motor, activo, manual, actual, guardada, disponibles } = {}) {
  if (guardada) return guardada
  if (manual) return manual
  if (!activo || !motor) return actual ?? null
  if (motor.sin_cobertura) return null
  if (!motor.ganador) return actual ?? null
  if (Array.isArray(disponibles) && !disponibles.includes(motor.ganador)) return actual ?? null
  return motor.ganador
}

// ¿El courier final difiere del que eligió el motor?
export const esCambioManual = (decision, final) =>
  !!decision?.ganador && !!final && final !== decision.ganador

const ganancia = (decision, courier) => {
  const o = (decision?.opciones || []).find(x => x?.courier === courier)
  const g = Number(o?.ganancia_esperada)
  return o && Number.isFinite(g) ? Math.round(g) : null
}

// Fila para `courier_cambios`, o null si no hubo cambio (o no hay decisión). Sin datos personales: solo referencia,
// ciudad y producto.
export function armarFilaCambio({ ref, ciudad, producto, decision, final }) {
  if (!esCambioManual(decision, final) || !ref) return null
  return {
    n_referencia: String(ref),
    ciudad: ciudad ?? null,
    producto: producto ?? null,
    courier_motor: decision.ganador,
    courier_final: final,
    regla_motor: decision.regla ?? null,
    ganancia_motor: ganancia(decision, decision.ganador),
    ganancia_final: ganancia(decision, final),
  }
}

// Una fila por pedido (varias líneas = una sola caja) a partir de los pedidos de Despacho ya insertados.
export function filasCambioDePedidos(pedidos, refsInsertadas) {
  const vistos = new Set()
  const out = []
  for (const p of pedidos || []) {
    const ref = String(p?.n_referencia ?? '')
    if (!ref || vistos.has(ref) || (refsInsertadas && !refsInsertadas.has(ref))) continue
    vistos.add(ref)
    const f = armarFilaCambio({
      ref, ciudad: p.ciudad, producto: p.productoRuteo || p.producto_nombre,
      decision: p.motorDecision, final: p.transportadora,
    })
    if (f) out.push(f)
  }
  return out
}

// Registro best-effort: si la tabla no está o falla, no pasa nada.
export async function registrarCambiosCourier(filas, cliente = supabase) {
  if (!filas?.length) return false
  try {
    const { error } = await cliente.from('courier_cambios').insert(filas)
    return !error
  } catch { return false }
}

// ─── Aplicar el motor a un pedido de Despacho ──────────────
// Devuelve una copia con la decisión anotada (motorDecision, courier_motor, courier_regla: se guardan en la venta) y,
// SOLO si el motor está activo y nadie eligió a mano, con el courier ganador asignado (flete, aviso de producto y
// `despachar` coherentes con el nuevo courier). Con el motor apagado solo anota: no cambia ninguna asignación.
// `detalleTarifa(courier, ciudad)` → { precio, estimado } | null (la pasa Despacho: tarifaDetalle).
export function aplicarMotorAPedido(p, decision, { activo = false, manual = null, disponibles, detalleTarifa } = {}) {
  if (!p || p.retiroEnPersona || p.retiroConfirmado || p.cfg?.despachar === false) return p
  if (!decision) return p
  const base = {
    ...p,
    motorDecision: decision,
    courier_motor: decision.ganador || null,
    courier_regla: decision.regla || null,
  }
  const nuevo = elegirTransportadora({ motor: decision, activo, manual, actual: p.transportadora ?? null, disponibles })
  if (!activo || manual || nuevo === (p.transportadora ?? null)) return base
  const d = nuevo && nuevo !== 'otra' && detalleTarifa ? detalleTarifa(nuevo, p.ciudad) : null
  return {
    ...base,
    transportadora: nuevo,
    motivoTransportadora: decision.motivo || p.motivoTransportadora,
    bloqueadoPorProducto: false,
    fallbackProducto: !!decision.fallback_producto,
    cobranzaOk: nuevo != null,
    costo_envio: p.lineaPrincipal === false ? 0 : (d?.precio ?? null),
    flete_estimado: p.lineaPrincipal === false ? false : !!d?.estimado,
    despachar: p.cfg?.despachar !== false && nuevo != null && (!p.origenManual || !(p.faltantes || []).length),
  }
}

// ─── Textos ────────────────────────────────────────────────
// La línea que se muestra por pedido: el motivo que armó la base (incluye desempate o regla dura si fue eso) y,
// si el dato es flojo, "pocos datos".
export function textoMotor(decision) {
  if (!decision) return ''
  let t = String(decision.motivo || '').trim()
  if (!t) {
    t = decision.sin_cobertura ? 'Sin cobertura: ningún courier cobra contra entrega acá'
      : decision.ganador ? `Motor: ${decision.ganador === 'pap' ? 'PaP' : 'Lucero'}` : ''
  }
  if (!t) return ''
  const op = (decision.opciones || []).find(o => o?.courier === decision.ganador)
  const flojo = decision.pocos_datos === true || op?.pocos_datos === true || op?.nivel_p === 'general'
  if (flojo && !/pocos datos/i.test(t)) t += ' · pocos datos'
  return t
}

// ─── Pedidos parados (vista pedidos_parados) ───────────────
const NOMBRE_COURIER = { pap: 'PaP', lucero: 'Lucero', otra: 'Otra' }
const plural = (n, uno, varios) => `${n} ${n === 1 ? uno : varios}`

// filas de la vista → { n, items: [texto], resto, texto }  (del más viejo al más nuevo, máximo `max`).
export function resumenPedidosParados(filas, max = 10) {
  const ordenadas = (filas || [])
    .filter(f => f && (f.ref || f.nombre))
    .slice()
    .sort((a, b) => (Number(b.horas) || 0) - (Number(a.horas) || 0))
  const items = ordenadas.slice(0, max).map((f) => {
    const dias = Math.max(0, Math.floor(Number(f.dias) || 0))
    const courier = f.courier ? ` → ${NOMBRE_COURIER[f.courier] || f.courier}` : ''
    return `${f.ref || f.nombre} ${f.ciudad || 'sin ciudad'} · ${plural(dias, 'día', 'días')} · ${f.etapa || 'sin_despachar'}${courier}`
  })
  const resto = Math.max(0, ordenadas.length - items.length)
  return { n: ordenadas.length, items, resto, texto: items.join(' · ') + (resto ? ` y ${resto} más` : '') }
}

// ─── Insert tolerante a columnas que todavía no existen ────
// Mismo patrón que ya usaba Despacho ("Could not find the 'x' column"), pero repetido: courier_motor y courier_regla
// pueden faltar las dos. Devuelve { error, filas } con las filas como quedaron enviadas.
export async function insertarTolerante(cliente, tabla, filas, maxReintentos = 6) {
  let actuales = filas
  let error = null
  for (let i = 0; i <= maxReintentos; i++) {
    ;({ error } = await cliente.from(tabla).insert(actuales))
    const m = error && /Could not find the '(\w+)' column/.exec(error.message || '')
    if (!m) break
    const col = m[1]
    actuales = actuales.map((r) => { const o = { ...r }; delete o[col]; return o })
  }
  return { error, filas: actuales }
}
