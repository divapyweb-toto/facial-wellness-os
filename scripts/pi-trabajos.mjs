// scripts/pi-trabajos.mjs
// ═══════════════════════════════════════════════════════════
// LÓGICA PURA DEL MÓDULO DE INTELIGENCIA DE PRODUCTOS (cola de trabajos,
// mensajes y evidencias). Sin red, sin base, sin dependencias: la usa
// scripts/pi-cli.mjs y la prueba tests/productos-cli.test.mjs.
//
// Reglas de seguridad que viven acá (no en el CLI) para que sean probables:
//   · Toda carga, checkpoint, resultado y evidencia se valida contra una LISTA
//     BLANCA de campos. Un campo que no está en la lista se rechaza: así nunca
//     entra un "comando", "script" o "url_a_ejecutar" desde un trabajo remoto.
//   · Los textos son DATOS. Si parecen instrucciones ("ignorá lo anterior",
//     "ejecutá…") se guardan tal cual y se devuelve una advertencia; nada de
//     esta lógica interpreta ni ejecuta texto.
//   · Un mensaje SEND_UNKNOWN nunca se reenvía: primero se concilia.
// ═══════════════════════════════════════════════════════════

// ─── Catálogos ──────────────────────────────────────────────
export const TIPOS_TRABAJO = ['investigar_py', 'buscar_proveedores', 'cotizar', 'analizar']
export const ESTADOS_TRABAJO = ['QUEUED', 'LEASED', 'RUNNING', 'SUCCEEDED', 'BLOCKED', 'WAITING_REPLY', 'FAILED', 'CANCELLED']
export const ESTADOS_MENSAJE = ['DRAFT', 'AUTHORIZED', 'SENDING', 'SENT_CONFIRMED', 'SEND_UNKNOWN', 'FAILED']
export const TIPOS_EVIDENCIA = ['observed', 'supplier_claim', 'estimated', 'hypothesis', 'unknown']
export const TIPOS_MENSAJE = ['consulta', 'solicitud_cotizacion', 'seguimiento', 'contrapropuesta', 'aclaracion']
export const MONEDAS = { PYG: 0, USD: 2, CNY: 2 } // escala de unidades menores
export const ZONAS = ['CDE', 'GRAN_ASUNCION', 'INTERIOR', 'NACIONAL', 'DESCONOCIDA']
export const COMPARACIONES = ['identico', 'equivalente', 'sustituto']
export const PLATAFORMAS = ['alibaba', '1688', 'local', 'otro']
export const INCOTERMS = ['EXW', 'FOB', 'FCA', 'CFR', 'CIF', 'DAP', 'DDP']

// Caducidad inicial (especificación §4): precio/stock local y logística/cambio, 7 días.
export const CADUCIDAD_DIAS = 7
const CAMPOS_CADUCAN = /^(precio|stock|flete|tarifa|tipo_cambio|cambio)/
const CAMPOS_PLATA = /(precio|costo|flete|tarifa|price|cost)/

const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i
export const esUuid = (v) => typeof v === 'string' && UUID.test(v)
const EJECUTOR = /^[a-z0-9][a-z0-9._-]{1,63}$/
export const esEjecutor = (v) => typeof v === 'string' && EJECUTOR.test(v)

// ─── Validadores básicos ────────────────────────────────────
// Cada regla devuelve el valor normalizado o lanza un mensaje en español simple.
class ErrorCampo extends Error {}
const falla = (campo, msg) => { throw new ErrorCampo(`${campo}: ${msg}`) }

// Control chars (salvo salto de línea y tab) se sacan: no aportan y pueden
// esconder texto. El resto queda tal cual: es dato.
const limpiarTexto = (s) => s.replace(/[\u0000-\u0008\u000B\u000C\u000E-\u001F\u007F]/g, '')

const R = {
  texto: ({ max = 500, min = 1 } = {}) => (v, c) => {
    if (typeof v !== 'string') falla(c, 'tiene que ser texto')
    const t = limpiarTexto(v).trim()
    if (t.length < min) falla(c, 'está vacío')
    if (t.length > max) falla(c, `supera ${max} caracteres`)
    return t
  },
  entero: ({ min = 0, max = Number.MAX_SAFE_INTEGER } = {}) => (v, c) => {
    if (!Number.isSafeInteger(v)) falla(c, 'tiene que ser un número entero (sin decimales ni comillas)')
    if (v < min || v > max) falla(c, `fuera de rango (${min} a ${max})`)
    return v
  },
  booleano: () => (v, c) => { if (typeof v !== 'boolean') falla(c, 'tiene que ser true o false'); return v },
  uuid: () => (v, c) => { if (!esUuid(v)) falla(c, 'no es un id válido (uuid)'); return v.toLowerCase() },
  enumerado: (lista) => (v, c) => { if (!lista.includes(v)) falla(c, `tiene que ser uno de: ${lista.join(', ')}`); return v },
  lista: (regla, { min = 0, max = 50 } = {}) => (v, c) => {
    if (!Array.isArray(v)) falla(c, 'tiene que ser una lista')
    if (v.length < min) falla(c, `necesita al menos ${min} elemento(s)`)
    if (v.length > max) falla(c, `máximo ${max} elementos`)
    return v.map((x, i) => regla(x, `${c}[${i}]`))
  },
  url: () => (v, c) => {
    if (typeof v !== 'string' || v.length > 2000) falla(c, 'URL inválida')
    let u
    try { u = new URL(v) } catch { falla(c, 'URL inválida') }
    if (u.protocol !== 'https:' && u.protocol !== 'http:') falla(c, 'solo se aceptan URL http o https')
    if (u.username || u.password) falla(c, 'la URL no puede llevar usuario ni contraseña')
    return u.toString()
  },
  fechaReal: () => (v, c) => {
    if (typeof v !== 'string' || !/^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}(:\d{2}(\.\d+)?)?(Z|[+-]\d{2}:?\d{2})$/.test(v)) {
      falla(c, 'tiene que ser fecha ISO con hora y zona (ej. 2026-11-18T14:30:00-03:00)')
    }
    const t = Date.parse(v)
    if (Number.isNaN(t)) falla(c, 'fecha inválida')
    return new Date(t).toISOString()
  },
}

const opcional = (regla) => { const f = (v, c) => (v === null || v === undefined ? null : regla(v, c)); f.opcional = true; return f }

// Valida un objeto contra un esquema { campo: regla }. Campos extra = rechazo.
// Las reglas sin `.opcional` son obligatorias.
function validarObjeto(obj, esquema, nombre) {
  if (obj === null || typeof obj !== 'object' || Array.isArray(obj)) falla(nombre, 'tiene que ser un objeto JSON')
  const extra = Object.keys(obj).filter((k) => !Object.hasOwn(esquema, k))
  if (extra.length) falla(nombre, `campos no permitidos: ${extra.join(', ')} (lista blanca)`)
  const out = {}
  for (const [k, regla] of Object.entries(esquema)) {
    const v = obj[k]
    if ((v === undefined || v === null) && !regla.opcional) falla(`${nombre}.${k}`, 'es obligatorio')
    const r = regla(v, `${nombre}.${k}`)
    if (r !== null && r !== undefined) out[k] = r
  }
  return out
}

const envolver = (fn) => (...a) => {
  try { return { ok: true, valor: fn(...a), errores: [] } } catch (e) {
    if (e instanceof ErrorCampo) return { ok: false, valor: null, errores: [e.message] }
    throw e
  }
}

// ─── Cargas por tipo de trabajo ─────────────────────────────
// Solo datos para investigar: consultas, sitios, límites. Ningún campo acepta
// código ni comandos. `cotizar` solo PREPARA borradores (Fase 3 = sin envío).
const consulta = R.texto({ max: 200 })
const nota = opcional(R.texto({ max: 2000 }))
export const ESQUEMAS_CARGA = {
  investigar_py: {
    consultas: R.lista(consulta, { min: 1, max: 20 }),
    zonas: opcional(R.lista(R.enumerado(ZONAS), { max: ZONAS.length })),
    sitios: opcional(R.lista(R.url(), { max: 20 })),
    max_resultados: opcional(R.entero({ min: 1, max: 200 })),
    notas: nota,
  },
  buscar_proveedores: {
    ficha_version: R.entero({ min: 1, max: 1000 }),
    plataformas: R.lista(R.enumerado(PLATAFORMAS), { min: 1, max: PLATAFORMAS.length }),
    palabras_clave: R.lista(consulta, { min: 1, max: 20 }),
    max_proveedores: opcional(R.entero({ min: 1, max: 20 })),
    notas: nota,
  },
  cotizar: {
    ficha_version: R.entero({ min: 1, max: 1000 }),
    proveedor_ids: R.lista(R.uuid(), { min: 1, max: 5 }),
    cantidades: R.lista(R.entero({ min: 1, max: 1_000_000 }), { min: 1, max: 6 }),
    incoterm: opcional(R.enumerado(INCOTERMS)),
    notas: nota,
  },
  analizar: {
    preguntas: R.lista(R.texto({ max: 500 }), { min: 1, max: 20 }),
    evidencia_ids: opcional(R.lista(R.uuid(), { max: 200 })),
    escenario_ids: opcional(R.lista(R.uuid(), { max: 20 })),
    notas: nota,
  },
}

/** Valida la carga de un trabajo. `candidatoId` es la columna del trabajo:
 *  obligatoria salvo en investigar_py (puede arrancar de una demanda sin candidato). */
export const validarCarga = envolver((tipo, carga, candidatoId = null) => {
  if (!TIPOS_TRABAJO.includes(tipo)) falla('tipo', `tiene que ser uno de: ${TIPOS_TRABAJO.join(', ')}`)
  if (candidatoId !== null && candidatoId !== undefined && !esUuid(candidatoId)) falla('candidato', 'no es un id válido (uuid)')
  if (tipo !== 'investigar_py' && !candidatoId) falla('candidato', `es obligatorio para ${tipo}`)
  return validarObjeto(carga, ESQUEMAS_CARGA[tipo], 'carga')
})

// ─── Checkpoint y resultado ─────────────────────────────────
export const ESQUEMA_CHECKPOINT = {
  consultas_hechas: opcional(R.lista(consulta, { max: 100 })),
  urls_visitadas: opcional(R.lista(R.url(), { max: 300 })),
  evidencia_ids: opcional(R.lista(R.uuid(), { max: 300 })),
  pasos_completados: opcional(R.lista(R.texto({ max: 300 }), { max: 100 })),
  siguiente_paso: opcional(R.texto({ max: 500 })),
  notas: nota,
}
export const validarCheckpoint = envolver((cp) => validarObjeto(cp, ESQUEMA_CHECKPOINT, 'checkpoint'))

export const ESQUEMA_RESULTADO = {
  resumen: R.texto({ max: 4000 }),
  evidencia_ids: opcional(R.lista(R.uuid(), { max: 500 })),
  oferta_ids: opcional(R.lista(R.uuid(), { max: 500 })),
  hallazgos: opcional(R.lista(R.texto({ max: 1000 }), { max: 50 })),
  desconocidos: opcional(R.lista(R.texto({ max: 500 }), { max: 50 })),
  fuentes_bloqueadas: opcional(R.lista(R.texto({ max: 300 }), { max: 50 })),
}
export const validarResultado = envolver((r) => validarObjeto(r, ESQUEMA_RESULTADO, 'resultado'))

export const validarMotivo = envolver((m) => R.texto({ max: 1000, min: 5 })(m, 'motivo'))

// ─── Estados de trabajo ─────────────────────────────────────
// QUEUED → LEASED → RUNNING → SUCCEEDED, y las salidas laterales.
// "→ QUEUED" desde LEASED/RUNNING es la recuperación de un lease vencido.
export const TRANSICIONES_TRABAJO = {
  QUEUED: ['LEASED', 'CANCELLED'],
  LEASED: ['RUNNING', 'QUEUED', 'BLOCKED', 'FAILED', 'CANCELLED'],
  RUNNING: ['SUCCEEDED', 'BLOCKED', 'WAITING_REPLY', 'FAILED', 'CANCELLED', 'QUEUED'],
  WAITING_REPLY: ['QUEUED', 'CANCELLED'],
  BLOCKED: ['QUEUED', 'CANCELLED'],
  FAILED: ['QUEUED', 'CANCELLED'],
  SUCCEEDED: [],
  CANCELLED: [],
}
export function transicionValida(desde, hacia) {
  return Object.hasOwn(TRANSICIONES_TRABAJO, desde) && TRANSICIONES_TRABAJO[desde].includes(hacia)
}
export function verificarTransicion(desde, hacia) {
  if (!ESTADOS_TRABAJO.includes(desde)) return { ok: false, error: `estado actual desconocido: ${desde}` }
  if (!ESTADOS_TRABAJO.includes(hacia)) return { ok: false, error: `estado destino desconocido: ${hacia}` }
  if (!transicionValida(desde, hacia)) return { ok: false, error: `transición no permitida: ${desde} → ${hacia}` }
  return { ok: true }
}

/** ¿Este ejecutor puede operar este trabajo ahora? (checkpoint, completar, bloquear)
 *  Devuelve vencido=true si el lease pasó: el CLI solo sigue si la actualización
 *  atómica (mismo ejecutor + mismo intento) confirma que nadie lo reclamó. */
export function verificarPropiedad(trabajo, ejecutor, ahora = new Date()) {
  if (!trabajo) return { ok: false, error: 'trabajo no encontrado' }
  if (!['LEASED', 'RUNNING'].includes(trabajo.estado)) return { ok: false, error: `el trabajo está en ${trabajo.estado}; primero hay que reclamarlo` }
  if (trabajo.ejecutor !== ejecutor) return { ok: false, error: `el trabajo lo tiene otro ejecutor (${trabajo.ejecutor ?? 'nadie'})` }
  const vence = trabajo.lease_hasta ? Date.parse(trabajo.lease_hasta) : NaN
  const vencido = Number.isNaN(vence) || vence <= ahora.getTime()
  return { ok: true, vencido }
}

/** Lease vencido: el trabajo vuelve a la cola (lo puede reclamar otro). */
export function leaseVencido(trabajo, ahora = new Date()) {
  if (!['LEASED', 'RUNNING'].includes(trabajo?.estado)) return false
  const vence = trabajo.lease_hasta ? Date.parse(trabajo.lease_hasta) : NaN
  return Number.isNaN(vence) || vence <= ahora.getTime()
}

/** Pasos de estado para completar: desde LEASED pasa por RUNNING (nunca salta). */
export function rutaCompletar(estado) {
  if (estado === 'RUNNING') return ['SUCCEEDED']
  if (estado === 'LEASED') return ['RUNNING', 'SUCCEEDED']
  return null
}

// ─── Mensajes a proveedores (Fase 3: solo estados) ──────────
export const TRANSICIONES_MENSAJE = {
  DRAFT: ['AUTHORIZED'],
  AUTHORIZED: ['SENDING', 'DRAFT'],
  SENDING: ['SENT_CONFIRMED', 'SEND_UNKNOWN', 'FAILED'],
  // SEND_UNKNOWN solo sale por conciliación (mirando la conversación real).
  // NUNCA vuelve a SENDING: eso sería un reenvío a ciegas.
  SEND_UNKNOWN: ['SENT_CONFIRMED', 'FAILED'],
  SENT_CONFIRMED: [],
  FAILED: [],
}
export function transicionMensajeValida(desde, hacia) {
  return Object.hasOwn(TRANSICIONES_MENSAJE, desde) && TRANSICIONES_MENSAJE[desde].includes(hacia)
}

/** Clave de idempotencia: permiso|proveedor|conversación|versión|tipo (el parámetro sigue llamándose campana). */
export const claveIdempotencia = envolver(({ campana, proveedor, conversacion, version, tipo } = {}) => {
  const parte = (v, c) => {
    const t = R.texto({ max: 200 })(String(v ?? ''), c)
    if (t.includes('|')) falla(c, 'no puede contener "|"')
    return t
  }
  return [
    parte(campana, 'permiso'), parte(proveedor, 'proveedor'), parte(conversacion, 'conversación'),
    String(R.entero({ min: 1, max: 100000 })(version, 'versión')), R.enumerado(TIPOS_MENSAJE)(tipo, 'tipo'),
  ].join('|')
})

/** ¿Se puede pasar este mensaje a SENDING? Exige AUTHORIZED, política que permita
 *  enviar, vigente, dentro del límite de mensajes y que la clave no se haya usado. */
export function puedeEnviar(mensaje, politica, { ahora = new Date(), enviadosEnCampana = 0, clavesUsadas = [] } = {}) {
  if (mensaje?.estado === 'SEND_UNKNOWN') return { ok: false, error: 'SEND_UNKNOWN: conciliar la conversación antes de cualquier reintento' }
  if (mensaje?.estado !== 'AUTHORIZED') return { ok: false, error: `el mensaje está en ${mensaje?.estado}; solo AUTHORIZED puede enviarse` }
  if (!politica) return { ok: false, error: 'sin permiso para negociar: solo borradores' }
  if (politica.permite_envio !== true) return { ok: false, error: 'la política solo permite redactar, no enviar' }
  if (!politicaVigente(politica, ahora)) return { ok: false, error: 'la política está vencida' }
  if (!politica.autorizada_por || !politica.autorizada_en) return { ok: false, error: 'la política no tiene autorización registrada' }
  if (esPermisoGeneral(politica) && !mensaje.candidato_id) return { ok: false, error: 'bajo el permiso general el mensaje tiene que llevar candidato_id (el producto)' }
  const max = politica.alcance?.mensajes_max
  if (max !== undefined && (!Number.isSafeInteger(max) || enviadosEnCampana >= max)) return { ok: false, error: 'se alcanzó el límite de mensajes del permiso para negociar' }
  if (!mensaje.idempotencia) return { ok: false, error: 'el mensaje no tiene clave de idempotencia' }
  if (clavesUsadas.includes(mensaje.idempotencia)) return { ok: false, error: 'esa clave de idempotencia ya se usó: no se reenvía' }
  return { ok: true }
}

// ─── Permiso para negociar por producto (decisión de Enrique 18-11 (2)) ───
// Enrique autoriza UN permiso por producto con una línea en el chat. Dentro de
// ese alcance se consulta, cotiza, repregunta y contraoferta sin pedir más.
export const ALCANCE_POLITICA_DEFECTO = Object.freeze({
  proveedores_max: 5, rondas_max: 2, seguimiento_dias_habiles: 2, escalones: [], vigencia_dias: 14,
})

/** Arma la fila de pi_politicas a partir de lo que escribió Enrique (textual). */
export const crearPoliticaAutorizada = envolver(({ candidatoId, texto, producto, alcance = {}, ahora = new Date() } = {}) => {
  if (!esUuid(candidatoId)) falla('candidato', 'no es un id válido (uuid)')
  const t = R.texto({ max: 2000, min: 3 })(texto ?? '', 'texto de Enrique')
  const a = validarObjeto({ ...ALCANCE_POLITICA_DEFECTO, ...alcance, producto }, {
    producto: R.texto({ max: 200 }),
    proveedores_max: R.entero({ min: 1, max: 20 }),
    rondas_max: R.entero({ min: 0, max: 5 }),
    seguimiento_dias_habiles: R.entero({ min: 1, max: 10 }),
    escalones: R.lista(R.entero({ min: 1, max: 1_000_000 }), { max: 6 }),
    vigencia_dias: R.entero({ min: 1, max: 60 }),
    mensajes_max: opcional(R.entero({ min: 1, max: 500 })),
    presupuesto_max_minor: opcional(R.entero({ min: 0 })), // nunca se revela al proveedor
  }, 'alcance')
  if (!a.escalones) a.escalones = []
  return {
    candidato_id: candidatoId.toLowerCase(), alcance: a, permite_envio: true,
    vigente_hasta: new Date(ahora.getTime() + a.vigencia_dias * 86_400_000).toISOString(),
    autorizada_por: 'Enrique', autorizada_en: ahora.toISOString(), autorizada_texto: t,
  }
})

// Propuesta de permiso por producto (revisión 18-11, hallazgo 4): el CLI usa la clave de servicio y la base NO
// le deja autorizar. Lo crea con permite_envio = false; lo autoriza Enrique en Voltra OS con su sesión.
export const crearPoliticaPropuesta = envolver((datos = {}) => {
  const r = crearPoliticaAutorizada({ ...datos, texto: datos.texto || 'propuesta' })
  if (!r.ok) falla(r.errores[0]?.split(':')[0] || 'politica', r.errores.join('; '))
  const { candidato_id, alcance } = r.valor
  return { candidato_id, alcance, permite_envio: false, vigente_hasta: null, autorizada_por: null, autorizada_en: null, autorizada_texto: null }
})

// ─── Permiso GENERAL para negociar (pedido de Enrique 18-11: "siempre estes autorizado a negociar") ───
// UNA fila de pi_politicas con candidato_id null (la crea la migración como propuesta; la autoriza Enrique
// una vez en Voltra OS). No vence (vigente_hasta null) y los topes son POR PRODUCTO. Aceptar orden, pagar,
// muestras, exclusividad y términos quedan siempre afuera (pareceCompromiso).
export const ALCANCE_PERMISO_GENERAL = Object.freeze({
  tipo: 'general',
  negocia: Object.freeze(['precio', 'cantidades', 'color_variante', 'calidad', 'empaque', 'plazos', 'condiciones']),
  proveedores_max_por_producto: 10, rondas_max_por_producto: 3, seguimiento_dias_habiles: 2,
})
export const esPermisoGeneral = (p) => !!p && p.candidato_id == null && p.alcance?.tipo === 'general'
// Igual que el disparador de la base: vigente_hasta > ahora, o null solo en el permiso general.
function politicaVigente(p, ahora) {
  if (p.vigente_hasta == null) return esPermisoGeneral(p)
  return Date.parse(p.vigente_hasta) > ahora.getTime()
}

// Estados que solo puede poner Enrique con su sesión (la base rechaza la clave de servicio).
export const ESTADOS_ORDEN_SOLO_ENRIQUE = ['CONFIRMADA_POR_ENRIQUE', 'PAGADA_POR_ENRIQUE']

// Textos que comprometen a Voltra: necesitan confirmación APARTE de Enrique.
const PATRONES_COMPROMISO = [
  /\b(we|i)\s+(accept|confirm|agree to)\b.{0,40}\b(order|purchase|terms|contract|deal)/i,
  /\b(place|placing)\s+(the|an|our)?\s*order\b/i,
  /\b(we will|we'll|i will)\s+(pay|buy|purchase|order)\b/i,
  /\b(payment|deposit|transfer)\s+(sent|made|done|today)\b/i,
  /\b(buy|order|pay for)\s+(a\s+|the\s+)?samples?\b/i,
  /\bexclusiv/i,
  /(确认订单|下单|付款|已付|定金|独家|买样|样品费)/,
  /(acepto|aceptamos|confirmo|confirmamos).{0,30}(orden|pedido|compra|t[ée]rminos)|exclusividad/i,
]
export function pareceCompromiso(texto) {
  return typeof texto === 'string' && PATRONES_COMPROMISO.some((p) => p.test(texto))
}

/** ¿Puede este mensaje pasar de DRAFT a AUTHORIZED? Solo con política vigente
 *  que permita enviar y si el mensaje está dentro del alcance. Si no, queda DRAFT.
 *  Sirve para el permiso por producto y para el general (este exige mensaje.candidato_id).
 *  ctx: { ahora, proveedoresEnCampana: [ids ya contactados PARA ESE PRODUCTO], ronda: n.º de ronda de negociación de este mensaje con ese proveedor } */
export function puedeAutorizarMensaje(mensaje, politica, { ahora = new Date(), proveedoresEnCampana = [], ronda = 0 } = {}) {
  const no = (error) => ({ ok: false, estado: 'DRAFT', error })
  if (mensaje?.estado !== 'DRAFT') return no(`solo un DRAFT se autoriza (está en ${mensaje?.estado})`)
  if (!politica) return no('sin permiso para negociar: queda en borrador')
  if (politica.permite_envio !== true) return no('la política solo permite redactar')
  if (!politica.autorizada_en || !politica.autorizada_texto) return no('la política no tiene la autorización textual de Enrique')
  if (!politicaVigente(politica, ahora)) return no('la política está vencida')
  if (Date.parse(politica.autorizada_en) > ahora.getTime()) return no('la política todavía no rige')
  if (mensaje.politica_id && politica.id && mensaje.politica_id !== politica.id) return no('el mensaje es de otro permiso para negociar')
  const a = politica.alcance ?? {}
  const general = esPermisoGeneral(politica)
  if (general && !mensaje.candidato_id) return no('bajo el permiso general el mensaje tiene que llevar candidato_id (el producto)')
  const maxProv = general ? (a.proveedores_max_por_producto ?? ALCANCE_PERMISO_GENERAL.proveedores_max_por_producto) : (a.proveedores_max ?? ALCANCE_POLITICA_DEFECTO.proveedores_max)
  const maxRondas = general ? (a.rondas_max_por_producto ?? ALCANCE_PERMISO_GENERAL.rondas_max_por_producto) : (a.rondas_max ?? ALCANCE_POLITICA_DEFECTO.rondas_max)
  if (!mensaje.proveedor_id) return no('el mensaje no tiene proveedor')
  const ya = proveedoresEnCampana.includes(mensaje.proveedor_id)
  if (!ya && new Set(proveedoresEnCampana).size >= maxProv) return no(`se alcanzó el máximo de ${maxProv} proveedores ${general ? 'por producto' : 'del permiso'}`)
  if (!Number.isSafeInteger(ronda) || ronda < 0) return no('ronda inválida')
  if (ronda > maxRondas) return no(`se pasó el máximo de ${maxRondas} rondas de negociación`)
  if (!mensaje.idempotencia) return no('el mensaje no tiene clave de idempotencia')
  const textos = [mensaje.original, mensaje.traduccion].filter(Boolean)
  if (!mensaje.original || !mensaje.traduccion) return no('falta el original o la traducción')
  if (textos.some(pareceCompromiso)) return no('el texto compromete a Voltra (orden, pago, muestras, exclusividad o términos): necesita confirmación aparte de Enrique')
  const tope = a.presupuesto_max_minor
  if (Number.isSafeInteger(tope) && tope > 0 && textos.some((t) => t.replace(/[.,\s]/g, '').includes(String(tope)))) return no('el texto revela el presupuesto máximo')
  return { ok: true, estado: 'AUTHORIZED' }
}

/** Qué hacer al reanudar un trabajo o vencer un lease con un mensaje en curso. */
export function accionAlReanudar(mensaje) {
  switch (mensaje?.estado) {
    case 'SEND_UNKNOWN':
    case 'SENDING': // se cortó a mitad: no se sabe si salió → se trata como incierto
      return { reenviar: false, accion: 'conciliar', estado: 'SEND_UNKNOWN' }
    case 'SENT_CONFIRMED': return { reenviar: false, accion: 'nada', estado: 'SENT_CONFIRMED' }
    default: return { reenviar: false, accion: 'esperar_autorizacion', estado: mensaje?.estado ?? null }
  }
}

/** Concilia un SEND_UNKNOWN mirando la conversación real. Sin evidencia, no cambia nada. */
export const conciliarSendUnknown = envolver((mensaje, { salio, observado_en, captura_ref = null, fuente_url = null } = {}) => {
  if (mensaje?.estado !== 'SEND_UNKNOWN') falla('estado', 'solo se concilia un mensaje SEND_UNKNOWN')
  if (typeof salio !== 'boolean') falla('salio', 'hay que indicar true/false después de revisar la conversación')
  R.fechaReal()(observado_en, 'observado_en')
  if (!captura_ref && !fuente_url) falla('evidencia', 'falta captura_ref o fuente_url de la conversación revisada')
  return salio
    ? { estado: 'SENT_CONFIRMED', reenviar: false }
    // No salió: se marca FAILED. Reenviar exige una NUEVA versión (otra clave), autorizada de nuevo.
    : { estado: 'FAILED', reenviar: false, siguiente: 'crear nueva versión y autorizarla para reenviar' }
})

// ─── Fotos de candidatos (comando foto-subir) ───────────────
// La foto se BAJA y se guarda en el bucket privado pi-fotos: nunca se registra solo la URL externa
// (los proveedores bloquean el enlace directo y la foto no aparece en Voltra OS).
export const FUENTES_FOTO = ['proveedor', 'muestra', 'propia', 'ia_referencia']
export const FOTO_MAX_BYTES = 8 * 1024 * 1024
export const FOTO_TIMEOUT_MS = 20_000

/** Tipo real por los primeros bytes (no se cree en el content-type). Solo JPEG, PNG o WEBP; si no, null. */
export function tipoImagenPorBytes(b) {
  if (!b || b.length < 12) return null
  const ascii = (desde, hasta) => String.fromCharCode(...b.subarray(desde, hasta))
  if (b[0] === 0xff && b[1] === 0xd8 && b[2] === 0xff) return { ext: 'jpg', mime: 'image/jpeg' }
  if ([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a].every((x, i) => b[i] === x)) return { ext: 'png', mime: 'image/png' }
  if (ascii(0, 4) === 'RIFF' && ascii(8, 12) === 'WEBP') return { ext: 'webp', mime: 'image/webp' }
  return null
}

// Direcciones locales o privadas escritas tal cual (no resuelve DNS). Se rechazan salvo en pruebas locales.
const HOST_PRIVADO = /^(localhost|.+\.localhost|127\.\d+\.\d+\.\d+|10\.\d+\.\d+\.\d+|192\.168\.\d+\.\d+|169\.254\.\d+\.\d+|172\.(1[6-9]|2\d|3[01])\.\d+\.\d+|0\.\d+\.\d+\.\d+|\[.*\])$/i
export const validarUrlImagen = envolver((url, { permitirLocal = false } = {}) => {
  const u = R.url()(url, '--url')
  if (!permitirLocal && HOST_PRIVADO.test(new URL(u).hostname)) falla('--url', 'no se bajan imágenes de direcciones locales o privadas')
  return u
})

/** Opciones de foto-subir, validadas antes de tocar la red. */
export const validarPedidoFoto = envolver(({ candidato, url, fuente, principal, descripcion } = {}, { permitirLocal = false } = {}) => {
  if (!esUuid(candidato)) falla('--candidato', 'falta o no es un id válido (uuid)')
  const u = validarUrlImagen(url, { permitirLocal })
  if (!u.ok) throw new ErrorCampo(u.errores[0])
  if (principal !== undefined && principal !== true) falla('--principal', 'va sin valor')
  return {
    candidato: candidato.toLowerCase(), url: u.valor,
    fuente: fuente === undefined ? 'proveedor' : R.enumerado(FUENTES_FOTO)(fuente, '--fuente'),
    principal: principal === true,
    descripcion: descripcion === undefined ? null : R.texto({ max: 500 })(descripcion, '--descripcion'),
  }
})

// ─── Evidencias ─────────────────────────────────────────────
// Esquema = columnas de pi_evidencias del contrato. `razon_sin_url` es
// obligatoria cuando no hay URL y se guarda dentro de `cobertura`.
const PATRONES_INSTRUCCION = [
  /ignor(a|á|e|ar)\b.{0,40}(instruc|anterior|previous|above)/i,
  /\b(system|sistema)\s*prompt/i,
  /\b(ejecut(a|á)|run|execute)\b.{0,30}(comando|command|script|código|code)/i,
  /rm\s+-rf|curl\s+[^\s]+\s*\|\s*(sh|bash)|<script\b|javascript:/i,
  /(revel(a|á)|mostr(a|á)|reveal|print).{0,30}(clave|token|secret|password|contraseña)/i,
  /(cambi(a|á)|change).{0,30}(pol[ií]tica|policy|permiso)/i,
]
export function pareceInstruccion(texto) {
  return typeof texto === 'string' && PATRONES_INSTRUCCION.some((p) => p.test(texto))
}

export const ESQUEMA_EVIDENCIA = {
  tipo: R.enumerado(TIPOS_EVIDENCIA),
  campo: (v, c) => {
    if (typeof v !== 'string' || !/^[a-z][a-z0-9_]{0,63}$/.test(v)) falla(c, 'minúsculas, números y _ (ej. precio_minorista)')
    return v
  },
  valor: opcional(R.texto({ max: 2000 })),
  moneda: opcional(R.enumerado(Object.keys(MONEDAS))),
  fuente_url: opcional(R.url()),
  razon_sin_url: opcional(R.texto({ max: 500, min: 5 })),
  fuente_entidad: opcional(R.texto({ max: 200 })),
  observado_en: R.fechaReal(),
  valido_hasta: opcional(R.fechaReal()),
  variante: opcional(R.texto({ max: 200 })),
  captura_ref: opcional(R.texto({ max: 300 })),
  cobertura: opcional(R.texto({ max: 2000 })),
}

/** Valida una evidencia y la devuelve lista para insertar en pi_evidencias.
 *  `ahora` permite probar fechas futuras; `cargadoPor` va a la columna cargado_por. */
export const validarEvidencia = envolver((ev, { ahora = new Date(), cargadoPor = null } = {}) => {
  const e = validarObjeto(ev, ESQUEMA_EVIDENCIA, 'evidencia')
  const advertencias = []
  const obs = Date.parse(e.observado_en)
  if (obs > ahora.getTime() + 5 * 60_000) falla('evidencia.observado_en', 'está en el futuro: tiene que ser la fecha real de la observación')
  if (obs < Date.parse('2020-01-01T00:00:00Z')) falla('evidencia.observado_en', 'fecha anterior a 2020: revisar')
  if (e.valido_hasta && Date.parse(e.valido_hasta) <= obs) falla('evidencia.valido_hasta', 'tiene que ser posterior a observado_en')

  if (!e.fuente_url && !e.razon_sin_url) falla('evidencia.fuente_url', 'falta la URL; si no hay, poné fuente_url null y razon_sin_url')
  if (e.fuente_url && e.razon_sin_url) falla('evidencia.razon_sin_url', 'solo va cuando fuente_url es null')

  if (e.tipo === 'unknown') {
    if (e.valor) falla('evidencia.valor', 'un dato "unknown" va con valor null')
    if (!e.cobertura && !e.razon_sin_url) falla('evidencia.cobertura', 'explicá por qué es desconocido')
  } else if (!e.valor) {
    falla('evidencia.valor', 'es obligatorio (si no se sabe, usá tipo "unknown" con valor null)')
  }

  if (e.valor && CAMPOS_PLATA.test(e.campo)) {
    if (!e.moneda) falla('evidencia.moneda', 'es obligatoria para un monto')
    if (!/^\d+$/.test(e.valor)) falla('evidencia.valor', `monto en unidades menores enteras de ${e.moneda} (PYG sin decimales; USD/CNY en centavos)`)
  }

  // A8 (ampliación 18-11): días que un anuncio del competidor lleva prendido.
  if (e.campo === 'dias_activo_anuncio' && e.tipo !== 'unknown') {
    if (!/^\d{1,4}$/.test(e.valor) || Number(e.valor) > 3650) falla('evidencia.valor', 'días activos: entero de 0 a 3650')
    if (e.moneda) falla('evidencia.moneda', 'días activos no lleva moneda')
    if (!e.fuente_url) falla('evidencia.fuente_url', 'días activos necesita el enlace de la Biblioteca de anuncios')
    advertencias.push('dias_activo_anuncio es un indicio: un anuncio prendido muchos días NO prueba ventas')
  }

  if (e.tipo === 'supplier_claim') advertencias.push('supplier_claim prueba que el proveedor lo afirma, no que esté verificado')

  // Caducidad por defecto: precio/stock/logística/cambio, 7 días.
  if (!e.valido_hasta && e.tipo !== 'unknown' && CAMPOS_CADUCAN.test(e.campo)) {
    e.valido_hasta = new Date(obs + CADUCIDAD_DIAS * 86_400_000).toISOString()
  }
  if (e.valido_hasta && Date.parse(e.valido_hasta) <= ahora.getTime()) advertencias.push(`dato caducado (válido hasta ${e.valido_hasta}): revalidar antes de usarlo`)

  for (const k of ['valor', 'cobertura', 'fuente_entidad', 'variante', 'razon_sin_url']) {
    if (pareceInstruccion(e[k])) advertencias.push(`el texto de "${k}" parece una instrucción: se guarda como dato y no se ejecuta`)
  }

  const cobertura = [e.razon_sin_url ? `Sin URL: ${e.razon_sin_url}` : null, e.cobertura ?? null].filter(Boolean).join(' · ') || null
  const fila = {
    tipo: e.tipo, campo: e.campo, valor: e.valor ?? null, moneda: e.moneda ?? null,
    fuente_url: e.fuente_url ?? null, fuente_entidad: e.fuente_entidad ?? null,
    observado_en: e.observado_en, valido_hasta: e.valido_hasta ?? null, variante: e.variante ?? null,
    captura_ref: e.captura_ref ?? null, cobertura, cargado_por: cargadoPor,
  }
  return { fila, advertencias }
})

// ─── Ofertas de competencia ─────────────────────────────────
export const ESQUEMA_OFERTA = {
  vendedor: R.texto({ max: 200 }),
  vendedor_clave: opcional(R.texto({ max: 200 })),
  comparacion: R.enumerado(COMPARACIONES),
  zona: R.enumerado(ZONAS),
  precio_minor: R.entero({ min: 0 }),
  moneda: opcional(R.enumerado(Object.keys(MONEDAS))),
  tipo_precio: opcional(R.texto({ max: 100 })),
  incluye_envio: opcional(R.booleano()),
  url: opcional(R.url()),
  observado_en: R.fechaReal(),
  // Índice (0-based) de la evidencia del mismo archivo que respalda esta oferta.
  evidencia_indice: R.entero({ min: 0, max: 10_000 }),
}

/** Clave para deduplicar vendedores: minúsculas, sin acentos ni signos. */
export function claveVendedor(nombre) {
  return String(nombre).normalize('NFD').replace(/[̀-ͯ]/g, '').toLowerCase()
    .replace(/[^a-z0-9]+/g, ' ').trim().replace(/\s+/g, '-')
}

export const validarOferta = envolver((of, { ahora = new Date(), totalEvidencias = Infinity } = {}) => {
  const o = validarObjeto(of, ESQUEMA_OFERTA, 'oferta')
  if (Date.parse(o.observado_en) > ahora.getTime() + 5 * 60_000) falla('oferta.observado_en', 'está en el futuro')
  if (o.evidencia_indice >= totalEvidencias) falla('oferta.evidencia_indice', `no existe la evidencia ${o.evidencia_indice} en el archivo`)
  const advertencias = []
  if (pareceInstruccion(o.vendedor) || pareceInstruccion(o.tipo_precio)) advertencias.push('un texto de la oferta parece una instrucción: se guarda como dato')
  const fila = {
    vendedor: o.vendedor, vendedor_clave: o.vendedor_clave ? claveVendedor(o.vendedor_clave) : claveVendedor(o.vendedor),
    comparacion: o.comparacion, zona: o.zona, precio_minor: o.precio_minor, moneda: o.moneda ?? 'PYG',
    tipo_precio: o.tipo_precio ?? null, incluye_envio: o.incluye_envio ?? null, url: o.url ?? null,
    observado_en: o.observado_en,
  }
  return { fila, evidencia_indice: o.evidencia_indice, advertencias }
})

/** Huella de una oferta para detectar duplicados (mismo vendedor, mismo precio y condiciones). */
export const huellaOferta = (f) => [f.vendedor_clave, f.comparacion, f.precio_minor, f.moneda, f.tipo_precio ?? '', f.url ?? ''].join('|')

/** Separa ofertas únicas de duplicadas (dentro del lote y contra las ya guardadas). */
export function deduplicarOfertas(filas, existentes = []) {
  const vistas = new Set(existentes.map(huellaOferta))
  const unicas = [], duplicadas = []
  for (const f of filas) {
    const h = huellaOferta(f)
    if (vistas.has(h)) duplicadas.push(f); else { vistas.add(h); unicas.push(f) }
  }
  return { unicas, duplicadas }
}

/** Valida un archivo completo de cargar-evidencia: { evidencias: [...], ofertas: [...] }.
 *  Todo o nada: si una sola pieza falla, no se inserta ninguna. */
export function validarArchivoEvidencia(archivo, opciones = {}) {
  const errores = [], advertencias = []
  if (archivo === null || typeof archivo !== 'object' || Array.isArray(archivo)) return { ok: false, errores: ['el archivo tiene que ser un objeto { "evidencias": [...], "ofertas": [...] }'] }
  const extra = Object.keys(archivo).filter((k) => !['evidencias', 'ofertas'].includes(k))
  if (extra.length) errores.push(`campos no permitidos en el archivo: ${extra.join(', ')}`)
  const evs = archivo.evidencias ?? [], ofs = archivo.ofertas ?? []
  if (!Array.isArray(evs) || !Array.isArray(ofs)) return { ok: false, errores: ['evidencias y ofertas tienen que ser listas'] }
  if (evs.length === 0) errores.push('no hay evidencias')
  if (evs.length > 500 || ofs.length > 500) errores.push('máximo 500 evidencias y 500 ofertas por archivo')
  const evidencias = evs.map((e, i) => {
    const r = validarEvidencia(e, opciones)
    if (!r.ok) errores.push(...r.errores.map((m) => `[evidencia ${i}] ${m}`))
    else advertencias.push(...r.valor.advertencias.map((m) => `[evidencia ${i}] ${m}`))
    return r.valor?.fila
  })
  const ofertas = ofs.map((o, i) => {
    const r = validarOferta(o, { ...opciones, totalEvidencias: evs.length })
    if (!r.ok) errores.push(...r.errores.map((m) => `[oferta ${i}] ${m}`))
    else advertencias.push(...r.valor.advertencias.map((m) => `[oferta ${i}] ${m}`))
    return r.valor
  })
  if (errores.length) return { ok: false, errores, advertencias }
  return { ok: true, errores: [], advertencias, evidencias, ofertas }
}

// ─── Órdenes de compra (decisión de Enrique 18-11) ──────────
// El módulo ARMA la orden y registra su estado. Nunca paga: el pago lo hace
// Enrique. Ningún campo acepta datos de tarjeta o cuenta (lista blanca + chequeo).
export const ESTADOS_ORDEN = ['BORRADOR', 'CONFIRMADA_POR_ENRIQUE', 'PEDIDA', 'PAGADA_POR_ENRIQUE', 'EN_TRANSITO', 'RECIBIDA', 'CANCELADA']
export const TRANSICIONES_ORDEN = {
  BORRADOR: ['CONFIRMADA_POR_ENRIQUE', 'CANCELADA'],
  CONFIRMADA_POR_ENRIQUE: ['PEDIDA', 'CANCELADA'],
  PEDIDA: ['PAGADA_POR_ENRIQUE', 'CANCELADA'], // Claude llega hasta acá: el paso de pago es de Enrique
  PAGADA_POR_ENRIQUE: ['EN_TRANSITO', 'CANCELADA'],
  EN_TRANSITO: ['RECIBIDA'],
  RECIBIDA: [],
  CANCELADA: [],
}
export function transicionOrdenValida(desde, hacia) {
  return Object.hasOwn(TRANSICIONES_ORDEN, desde) && TRANSICIONES_ORDEN[desde].includes(hacia)
}

// 13 a 19 dígitos seguidos (con espacios o guiones) = posible tarjeta o cuenta.
export function pareceDatoDePago(texto) {
  return typeof texto === 'string' && /(?:\d[ -]?){13,19}/.test(texto)
}

export const ESQUEMA_ORDEN = {
  proveedor_id: opcional(R.uuid()),
  cotizacion_id: opcional(R.uuid()),
  plataforma: R.enumerado(PLATAFORMAS),
  variante: opcional(R.texto({ max: 200 })),
  cantidad: R.entero({ min: 1, max: 1_000_000 }),
  precio_unit_minor: R.entero({ min: 0 }),
  envio_minor: R.entero({ min: 0 }),
  total_minor: opcional(R.entero({ min: 0 })),
  moneda: R.enumerado(Object.keys(MONEDAS)),
  deposito_destino: R.texto({ max: 300 }),
  forwarder: opcional(R.texto({ max: 200 })),
  notas: opcional(R.texto({ max: 2000 })),
}

/** Valida una orden propuesta y devuelve la fila (estado BORRADOR). */
export const validarOrdenPropuesta = envolver((orden, candidatoId) => {
  if (!esUuid(candidatoId)) falla('candidato', 'no es un id válido (uuid)')
  const o = validarObjeto(orden, ESQUEMA_ORDEN, 'orden')
  const total = o.cantidad * o.precio_unit_minor + o.envio_minor
  if (!Number.isSafeInteger(total)) falla('orden.total_minor', 'monto fuera de rango')
  if (o.total_minor !== undefined && o.total_minor !== total) falla('orden.total_minor', `no cierra: cantidad × precio + envío = ${total}`)
  // 1688 no envía al exterior: hace falta depósito de un agente/forwarder en China.
  if (o.plataforma === '1688' && !o.forwarder) falla('orden.forwarder', '1688 no envía al exterior: falta el agente/forwarder con depósito en China')
  for (const k of ['variante', 'deposito_destino', 'forwarder', 'notas']) {
    if (pareceDatoDePago(o[k])) falla(`orden.${k}`, 'parece un número de tarjeta o cuenta: esos datos no se guardan acá (el pago lo hace Enrique)')
  }
  return { ...o, total_minor: total, candidato_id: candidatoId.toLowerCase(), estado: 'BORRADOR' }
})

/** Valida un cambio de estado y devuelve las columnas a actualizar.
 *  datos: { confirmacion, tracking, nota, ahora } */
export const validarCambioOrden = envolver((orden, hacia, { confirmacion = null, tracking = null, nota = null, ahora = new Date() } = {}) => {
  if (!ESTADOS_ORDEN.includes(orden?.estado)) falla('estado', `estado actual desconocido: ${orden?.estado}`)
  if (!ESTADOS_ORDEN.includes(hacia)) falla('estado', `tiene que ser uno de: ${ESTADOS_ORDEN.join(', ')}`)
  if (!transicionOrdenValida(orden.estado, hacia)) falla('estado', `transición no permitida: ${orden.estado} → ${hacia}`)
  const cambios = { estado: hacia }
  if (hacia === 'CONFIRMADA_POR_ENRIQUE') {
    const t = R.texto({ max: 1000, min: 3 })(confirmacion ?? '', 'confirmación')
    cambios.confirmada_texto = t
    cambios.confirmada_en = ahora.toISOString()
  }
  if (hacia === 'PEDIDA' && !orden.confirmada_en) falla('estado', 'falta la confirmación de Enrique (producto y total)')
  if (hacia === 'EN_TRANSITO') cambios.tracking = R.texto({ max: 200 })(tracking ?? '', 'tracking')
  if (hacia === 'CANCELADA' && !nota) falla('nota', 'explicá por qué se cancela (--nota)')
  if (nota) {
    const n = R.texto({ max: 1000 })(nota, 'nota')
    if (pareceDatoDePago(n)) falla('nota', 'parece un número de tarjeta o cuenta: no se guarda')
    cambios.notas = [orden.notas, `${ahora.toISOString().slice(0, 10)} ${hacia}: ${n}`].filter(Boolean).join('\n')
  }
  if (confirmacion && pareceDatoDePago(confirmacion)) falla('confirmación', 'parece un número de tarjeta o cuenta: no se guarda')
  return cambios
})
