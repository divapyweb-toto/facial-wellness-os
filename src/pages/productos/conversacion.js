// src/pages/productos/conversacion.js
// Lógica pura de la charla con proveedores (contrato FUNCIONES 21-11, "proveedores 24/7"):
// gasto del mes en hora de Paraguay, plantillas de WhatsApp del mes, orden de la conversación,
// validación de los datos de contacto y la fila de "Pedir primer contacto". Sin React ni base.
//
// Datos (migración 20261124000001): pi_proveedores.whatsapp/email/wechat/canal_preferido/no_contactar/idioma
// y pi_mensajes.canal/direccion/id_externo/hilo/asunto/costo_usd/autor + estado 'RECEIVED'.
// Si la migración no está aplicada, esas claves no vienen en las filas: todo acá tolera que falten.

const TZ = 'America/Asuncion'
export const CANALES = [['email', 'Correo'], ['whatsapp', 'WhatsApp'], ['1688', '1688']]
export const IDIOMAS = [['zh', 'Chino'], ['en', 'Inglés'], ['es', 'Español']]
export const TOPES_POR_DEFECTO = { tope_ia_usd_mes: 10, tope_plantillas_mes: 30 }

export const ESTADOS_MSG = {
  DRAFT: ['Borrador', 'badge-gray'], AUTHORIZED: ['Autorizado: espera salir', 'badge-blue'], SENDING: ['Enviando', 'badge-yellow'],
  SENT_CONFIRMED: ['Enviado (confirmado)', 'badge-green'], SEND_UNKNOWN: ['Envío incierto: conciliar', 'badge-red'],
  FAILED: ['Falló', 'badge-red'], RECEIVED: ['Recibido', 'badge-purple'],
}
export const estadoMsg = (estado) => ESTADOS_MSG[estado] || [estado || '—', 'badge-gray']
export const etiquetaCanal = (c) => CANALES.find(x => x[0] === c)?.[1] || (c ? String(c) : 'canal sin dato')
export const etiquetaIdioma = (i) => IDIOMAS.find(x => x[0] === i)?.[1] || (i ? String(i) : '—')

// ── Mes de Paraguay (UTC-3 todo el año desde la ley 7300/2024) ──
export function mesPY(fecha) {
  const d = fecha instanceof Date ? fecha : new Date(fecha)
  if (Number.isNaN(d.getTime())) return null
  return d.toLocaleDateString('en-CA', { timeZone: TZ }).slice(0, 7) // "2026-11"
}
// Primer instante del mes de Paraguay en ISO UTC ("2026-11-01T03:00:00.000Z").
export function inicioMesPYISO(ahora = new Date()) {
  const m = mesPY(ahora)
  return new Date(`${m}-01T00:00:00-03:00`).toISOString()
}

// Dirección del mensaje: la columna nueva; sin ella, un RECEIVED es entrante y todo lo demás saliente
// (antes de esta migración el módulo solo guardaba salientes).
export const direccionDe = (m) => (m?.direccion === 'in' || m?.direccion === 'out' ? m.direccion : m?.estado === 'RECEIVED' ? 'in' : 'out')
const ENVIADOS = new Set(['SENDING', 'SENT_CONFIRMED', 'SEND_UNKNOWN'])

// Gasto del mes: suma de costo_usd de los mensajes creados en el mes de Paraguay.
// Se suma en millonésimas enteras (numeric(12,6) en la base) para no arrastrar error de coma flotante.
export function costoMesUsd(mensajes, ahora = new Date()) {
  const mes = mesPY(ahora)
  let micro = 0
  for (const m of mensajes || []) {
    if (m?.costo_usd == null || m.costo_usd === '' || mesPY(m.creado_en) !== mes) continue
    const n = Number(m.costo_usd)
    if (Number.isFinite(n) && n > 0) micro += Math.round(n * 1e6)
  }
  return micro / 1e6
}

// Plantillas de WhatsApp del mes (estimado): salientes de WhatsApp que salieron este mes sin un
// mensaje del mismo proveedor en las 24 h anteriores (ventana cerrada = Meta obliga a usar plantilla).
export function plantillasMes(mensajes, ahora = new Date()) {
  const mes = mesPY(ahora)
  const lista = mensajes || []
  const entrantes = lista.filter(m => m?.canal === 'whatsapp' && direccionDe(m) === 'in')
  let n = 0
  for (const m of lista) {
    if (m?.canal !== 'whatsapp' || direccionDe(m) !== 'out' || !ENVIADOS.has(m.estado) || mesPY(m.creado_en) !== mes) continue
    const t = new Date(m.creado_en).getTime()
    const abierta = entrantes.some(e => {
      if (!((e.proveedor_id && e.proveedor_id === m.proveedor_id) || (e.hilo && e.hilo === m.hilo))) return false
      const te = new Date(e.creado_en).getTime()
      return te <= t && t - te < 24 * 3600 * 1000
    })
    if (!abierta) n++
  }
  return n
}

// config.proveedores es texto JSON. Ilegible o ausente = topes por defecto (10 / 30) y apagado.
export function configProveedoresDesde(valor) {
  let o = valor
  if (typeof valor === 'string') { try { o = JSON.parse(valor) } catch { o = null } }
  if (!o || typeof o !== 'object' || Array.isArray(o)) return { leida: false, activo: false, ...TOPES_POR_DEFECTO }
  const num = (v, def) => (Number.isFinite(Number(v)) && Number(v) >= 0 && v !== null && v !== '' ? Number(v) : def)
  return {
    leida: true,
    activo: o.activo === true,
    tope_ia_usd_mes: num(o.tope_ia_usd_mes, TOPES_POR_DEFECTO.tope_ia_usd_mes),
    tope_plantillas_mes: num(o.tope_plantillas_mes, TOPES_POR_DEFECTO.tope_plantillas_mes),
  }
}

export function resumenMes(mensajes, configValor, ahora = new Date()) {
  const cfg = configProveedoresDesde(configValor)
  const gastoUsd = costoMesUsd(mensajes, ahora)
  const plantillas = plantillasMes(mensajes, ahora)
  return {
    gastoUsd, plantillas, mes: mesPY(ahora), activo: cfg.activo, configLeida: cfg.leida,
    topeUsd: cfg.tope_ia_usd_mes, topePlantillas: cfg.tope_plantillas_mes,
    llegoTopeIa: gastoUsd >= cfg.tope_ia_usd_mes, llegoTopePlantillas: plantillas >= cfg.tope_plantillas_mes,
  }
}
export const fmtUsd = (n) => `USD ${new Intl.NumberFormat('es-PY', { minimumFractionDigits: 2, maximumFractionDigits: 2 }).format(Number(n) || 0)}`

// ── Conversación ──
// Del más viejo al más nuevo. Empate de hora: el entrante antes que la respuesta; después, por id (orden estable).
export function ordenarConversacion(mensajes) {
  return [...(mensajes || [])].sort((a, b) => {
    const ta = new Date(a.creado_en).getTime() || 0, tb = new Date(b.creado_en).getTime() || 0
    if (ta !== tb) return ta - tb
    const da = direccionDe(a) === 'in' ? 0 : 1, db = direccionDe(b) === 'in' ? 0 : 1
    if (da !== db) return da - db
    return String(a.id).localeCompare(String(b.id))
  })
}
export const conversacionDe = (mensajes, proveedorId) => ordenarConversacion((mensajes || []).filter(m => m.proveedor_id === proveedorId))

// ── Datos de contacto ──
export const tieneColumnasContacto = (p) => !!p && Object.prototype.hasOwnProperty.call(p, 'no_contactar')
export const normalizarEmail = (t) => String(t ?? '').trim().toLowerCase()
export const emailValido = (e) => /^[^@\s]+@[^@\s]+\.[^@\s]+$/.test(e) // mismo patrón que la base
// WhatsApp: E.164 sin '+', solo dígitos, 8 a 15 (mismo check que la base).
export const normalizarWhatsapp = (t) => String(t ?? '').replace(/\D/g, '')

// Devuelve { ok, errores: {campo: texto}, cambios } con los valores listos para guardar.
export function validarContacto(f) {
  const errores = {}
  const email = normalizarEmail(f.email)
  if (email && !emailValido(email)) errores.email = 'Correo inválido: tiene que ser algo@dominio.com.'
  const crudo = String(f.whatsapp ?? '').trim()
  const whatsapp = normalizarWhatsapp(crudo)
  if (crudo && !whatsapp) errores.whatsapp = 'WhatsApp sin números.'
  else if (whatsapp && whatsapp.startsWith('0')) errores.whatsapp = 'Escribilo con el código de país (ej.: 86 para China), sin el 0 del principio.'
  else if (whatsapp && (whatsapp.length < 8 || whatsapp.length > 15)) errores.whatsapp = 'WhatsApp: entre 8 y 15 números, con el código de país.'
  const wechat = String(f.wechat ?? '').trim()
  if (wechat.length > 64) errores.wechat = 'WeChat: máximo 64 caracteres.'
  const canal = f.canal_preferido || null
  if (canal && !CANALES.some(x => x[0] === canal)) errores.canal_preferido = 'Canal preferido inválido.'
  else if (canal === 'email' && !email) errores.canal_preferido = 'Para preferir correo, cargá el correo.'
  else if (canal === 'whatsapp' && !whatsapp) errores.canal_preferido = 'Para preferir WhatsApp, cargá el número.'
  const idioma = f.idioma || null
  if (idioma && !IDIOMAS.some(x => x[0] === idioma)) errores.idioma = 'Idioma inválido.'
  const ok = Object.keys(errores).length === 0
  return { ok, errores, cambios: ok ? { email: email || null, whatsapp: whatsapp || null, wechat: wechat || null, canal_preferido: canal, idioma, no_contactar: !!f.no_contactar } : null }
}

// ── Pedir primer contacto (correo) ──
// Fila que lee proveedores-gmail: canal email, out, AUTHORIZED, hilo null, autor admin, original null
// (lo redacta el agente desde `traduccion` = el pedido en español). Sale solo en horario de China.
export const esPrimerContactoPendiente = (m) => m?.canal === 'email' && direccionDe(m) === 'out' && m.estado === 'AUTHORIZED' && !m.hilo && m.autor === 'admin'

export function puedePedirPrimerContacto({ proveedor, candidato, permisoGeneral, mensajes, ahora = new Date() }) {
  if (!tieneColumnasContacto(proveedor)) return { ok: false, motivo: 'Falta aplicar la migración de canales (datos de contacto) en la base.' }
  if (proveedor.no_contactar) return { ok: false, motivo: 'Está marcado "No contactar".' }
  if (!proveedor.email) return { ok: false, motivo: 'Sin correo cargado: cargalo en los datos de contacto.' }
  if (!candidato?.id) return { ok: false, motivo: 'Falta el producto: el primer contacto se pide desde la ficha de un producto.' }
  const vigente = !!permisoGeneral?.permite_envio && permisoGeneral.candidato_id == null && (!permisoGeneral.vigente_hasta || new Date(permisoGeneral.vigente_hasta) > ahora)
  if (!vigente) return { ok: false, motivo: 'El permiso general para negociar no está autorizado.' }
  if ((mensajes || []).some(m => m.proveedor_id === proveedor.id && esPrimerContactoPendiente(m))) return { ok: false, motivo: 'Ya hay un primer contacto esperando salir.' }
  return { ok: true, motivo: null }
}

export function filaPrimerContacto({ proveedor, candidato, permisoGeneral, mensajes, asunto, pedido, ahora = new Date() }) {
  const p = puedePedirPrimerContacto({ proveedor, candidato, permisoGeneral, mensajes, ahora })
  if (!p.ok) throw new Error(p.motivo)
  const a = String(asunto ?? '').trim().replace(/\s+/g, ' ')
  const t = String(pedido ?? '').trim()
  if (a.length < 3 || a.length > 150) throw new Error('El asunto tiene que tener entre 3 y 150 caracteres.')
  if (t.length < 10 || t.length > 2000) throw new Error('Escribí qué pedirle (entre 10 y 2000 caracteres).')
  const n = (mensajes || []).filter(m => m.proveedor_id === proveedor.id && m.canal === 'email' && direccionDe(m) === 'out' && String(m.idempotencia || '').includes(':primer:')).length + 1
  return {
    politica_id: permisoGeneral.id, candidato_id: candidato.id, proveedor_id: proveedor.id,
    canal: 'email', direccion: 'out', estado: 'AUTHORIZED', hilo: null, autor: 'admin',
    asunto: a, original: null, traduccion: t, idioma: proveedor.idioma || null,
    idempotencia: `email:out:${proveedor.id}:primer:${n}`,
  }
}
