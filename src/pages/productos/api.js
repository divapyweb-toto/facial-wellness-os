// src/pages/productos/api.js
// Lecturas y escrituras del módulo Productos nuevos (tablas pi_* del contrato).
// Usa el cliente `supabase` con la sesión de Enrique (RLS: solo authenticated).
// Modo DEMO: misma interfaz, pero contra datos ficticios en memoria (demo.js);
// nada se escribe en la base. Sirve para ver la pantalla antes de aplicar la
// migración o para probar sin ensuciar datos reales.
import { supabase } from '../../lib/supabase'
import { DEMO } from './demo'

let modoDemo = false
export const esModoDemo = () => modoDemo
export function setModoDemo(v) { modoDemo = !!v }

const mem = {}
const memTabla = (t) => {
  if (!mem[t]) mem[t] = JSON.parse(JSON.stringify(DEMO[t] || []))
  return mem[t]
}
const nuevoId = () => (globalThis.crypto?.randomUUID?.() || `demo-${Date.now()}-${Math.random().toString(16).slice(2)}`)

// Error legible: qué pasó + qué hacer. Marca si falta la tabla (migración sin aplicar).
function errorLegible(error, tabla) {
  const msg = error?.message || String(error)
  const faltaTabla = error?.code === '42P01' || error?.code === 'PGRST205' || /does not exist|Could not find the (table|relation)/i.test(msg)
  const e = new Error(faltaTabla
    ? `La tabla o vista "${tabla}" todavía no existe en la base (migración del módulo sin aplicar). Podés ver la pantalla con datos DEMO.`
    : `No se pudo leer/guardar en ${tabla}: ${msg}`)
  e.faltaTabla = faltaTabla
  e.original = error
  return e
}

// ── Capa genérica ──────────────────────────────────────────
export async function listar(tabla, { eq = {}, orden = 'creado_en', asc = false, columnas = '*', limite } = {}) {
  if (modoDemo) {
    let filas = memTabla(tabla).filter(f => Object.entries(eq).every(([k, v]) => f[k] === v))
    if (orden) filas = [...filas].sort((a, b) => (a[orden] > b[orden] ? 1 : a[orden] < b[orden] ? -1 : 0) * (asc ? 1 : -1))
    return limite ? filas.slice(0, limite) : filas
  }
  let q = supabase.from(tabla).select(columnas)
  for (const [k, v] of Object.entries(eq)) q = q.eq(k, v)
  if (orden) q = q.order(orden, { ascending: asc })
  q = q.limit(limite || 1000)
  const { data, error } = await q
  if (error) throw errorLegible(error, tabla)
  return data || []
}

export async function insertar(tabla, fila) {
  if (modoDemo) {
    const ahora = new Date().toISOString()
    const f = { id: nuevoId(), creado_en: ahora, actualizado_en: ahora, ...fila }
    memTabla(tabla).push(f)
    return f
  }
  const { data, error } = await supabase.from(tabla).insert(fila).select().single()
  if (error) throw errorLegible(error, tabla)
  await registrarEvento(tabla, data?.id, 'crear', null)
  return data
}

export async function actualizar(tabla, id, cambios) {
  const conFecha = { ...cambios, actualizado_en: new Date().toISOString() }
  if (modoDemo) {
    const f = memTabla(tabla).find(x => x.id === id)
    if (f) Object.assign(f, conFecha)
    return f
  }
  const { data, error } = await supabase.from(tabla).update(conFecha).eq('id', id).select().single()
  if (error) throw errorLegible(error, tabla)
  await registrarEvento(tabla, id, 'actualizar', { campos: Object.keys(cambios) })
  return data
}

export async function borrar(tabla, id) {
  if (modoDemo) {
    const arr = memTabla(tabla)
    const i = arr.findIndex(x => x.id === id)
    if (i >= 0) arr.splice(i, 1)
    return
  }
  const { error } = await supabase.from(tabla).delete().eq('id', id)
  if (error) throw errorLegible(error, tabla)
  await registrarEvento(tabla, id, 'borrar', null)
}

// Auditoría (pi_eventos). Nunca rompe la acción principal.
let actorCache = null
async function actor() {
  if (actorCache) return actorCache
  try {
    const { data } = await supabase.auth.getSession()
    actorCache = data?.session?.user?.email || 'web'
  } catch { actorCache = 'web' }
  return actorCache
}
async function registrarEvento(entidad, entidad_id, accion, detalle) {
  if (modoDemo || entidad === 'pi_eventos') return
  try {
    await supabase.from('pi_eventos').insert({ entidad, entidad_id: entidad_id || null, accion, detalle, actor: await actor() })
  } catch { /* la auditoría no frena */ }
}

// ── Candidatos ─────────────────────────────────────────────
export const listarCandidatos = () => listar('pi_candidatos', { orden: 'actualizado_en' })
export const crearCandidato = (c) => insertar('pi_candidatos', c)
export const actualizarCandidato = (id, cambios) => actualizar('pi_candidatos', id, cambios)

// Resumen para la lista de Oportunidades: todo junto, en paralelo.
export async function cargarResumenOportunidades() {
  const [candidatos, evidencias, escenarios, cotizaciones, ofertas, fotos] = await Promise.all([
    listarCandidatos(),
    listar('pi_evidencias', { columnas: 'id,candidato_id,tipo,campo,valido_hasta', orden: null }),
    listar('pi_escenarios_costo', { columnas: 'id,candidato_id,nombre,version,resultado,calculado_en', orden: 'calculado_en' }),
    listar('pi_cotizaciones', { columnas: 'id,candidato_id,tipo', orden: null }),
    listar('pi_ofertas_competencia', { columnas: 'id,candidato_id,vendedor_clave', orden: null }),
    // Fotos (alerta roja "sin foto"): si la tabla falta, null y no se alerta.
    listar('pi_fotos', { columnas: 'id,candidato_id,es_principal', orden: null }).catch(e => { if (e.faltaTabla) return null; throw e }),
  ])
  return { candidatos, evidencias, escenarios, cotizaciones, ofertas, fotos }
}

// Tablero de acierto (ampliación A2). Vista pi_tasa_acierto; si no existe, null.
export async function leerTasaAcierto() {
  try { return await listar('pi_tasa_acierto', { orden: null }) } catch (e) { if (e.faltaTabla) return null; throw e }
}

// ── Detalle de un candidato ─────────────────────────────────
export async function cargarDetalle(candidatoId) {
  const eq = { candidato_id: candidatoId }
  const [cands, fichas, evidencias, ofertas, cotizaciones, proveedores, escenarios, casos, experimentos, trabajos] = await Promise.all([
    listar('pi_candidatos', { eq: { id: candidatoId }, orden: null }),
    listar('pi_fichas', { eq, orden: 'version', asc: true }), // ascendente: la última es la vigente
    listar('pi_evidencias', { eq, orden: 'creado_en' }),
    listar('pi_ofertas_competencia', { eq, orden: 'creado_en' }),
    listar('pi_cotizaciones', { eq, orden: 'creado_en' }),
    listar('pi_proveedores', { orden: 'creado_en' }),
    listar('pi_escenarios_costo', { eq, orden: 'calculado_en' }),
    listar('pi_casos', { eq, orden: 'creado_en' }),
    listar('pi_experimentos', { eq, orden: 'creado_en' }),
    listar('pi_trabajos', { eq, orden: 'creado_en' }),
  ])
  // Tablas de las ampliaciones (órdenes, permisos para negociar, conversaciones): si faltan, la pantalla sigue.
  const opcional = (p) => p.catch(e => { if (e.faltaTabla) return null; throw e })
  const [ordenes, politicas] = await Promise.all([
    opcional(listar('pi_ordenes_compra', { eq, orden: 'creado_en' })),
    opcional(listar('pi_politicas', { eq, orden: 'creado_en' })),
  ])
  const idsPol = new Set((politicas || []).map(p => p.id))
  // Mensajes del producto: los de sus permisos por producto + los del permiso general que llevan su candidato_id.
  const mensajes = politicas ? ((await opcional(listar('pi_mensajes', { orden: 'creado_en' }))) || []).filter(m => idsPol.has(m.politica_id) || m.candidato_id === candidatoId) : []
  return { candidato: cands[0] || null, fichas, evidencias, ofertas, cotizaciones, proveedores, escenarios, casos, experimentos, trabajos, ordenes, politicas, mensajes }
}

// Órdenes de compra (decisión de Enrique 18-11). El pago lo hace Enrique: acá
// solo se arma la orden propuesta y se siguen sus estados.
export const crearOrden = (o) => insertar('pi_ordenes_compra', { estado: 'BORRADOR', ...o })
export const actualizarOrden = (id, cambios) => actualizar('pi_ordenes_compra', id, cambios)

// Autorizar un permiso para negociar (revisión 18-11, hallazgo 4): la base solo deja si quien está
// logueado es el usuario autorizado de pi_config (Enrique). Quién y cuándo los pone la base.
// Permiso general (candidato_id NULL): no se manda vigente_hasta, queda NULL = no vence.
export async function autorizarPolitica(politica, texto) {
  if (politica?.candidato_id == null) return actualizar('pi_politicas', politica.id, { permite_envio: true, autorizada_texto: texto.trim() })
  const dias = Number(politica?.alcance?.vigencia_dias) || 14
  const vigente_hasta = new Date(Date.now() + dias * 86_400_000).toISOString()
  return actualizar('pi_politicas', politica.id, { permite_envio: true, autorizada_texto: texto.trim(), vigente_hasta })
}
export const apagarPolitica = (id) => actualizar('pi_politicas', id, { permite_envio: false })

// Permiso general para negociar: la única fila de pi_politicas con candidato_id NULL.
// Devuelve la fila, o null si todavía no existe (migración sin aplicar o tabla faltante).
export async function leerPermisoGeneral() {
  if (modoDemo) return memTabla('pi_politicas').find(p => p.candidato_id == null) || null
  const { data, error } = await supabase.from('pi_politicas').select('*').is('candidato_id', null).limit(1)
  if (error) { const e = errorLegible(error, 'pi_politicas'); if (e.faltaTabla) return null; throw e }
  return (data || [])[0] || null
}

// Ficha versionada: nunca se pisa; cada cambio es versión nueva.
export async function guardarFicha(candidatoId, spec, versionActual) {
  return insertar('pi_fichas', { candidato_id: candidatoId, version: (versionActual || 0) + 1, spec })
}

export const crearEvidencia = (ev) => insertar('pi_evidencias', ev)
export const borrarEvidencia = (id) => borrar('pi_evidencias', id)
export const crearOferta = (o) => insertar('pi_ofertas_competencia', o)
export const borrarOferta = (id) => borrar('pi_ofertas_competencia', id)
export const crearProveedor = (p) => insertar('pi_proveedores', p)
export const crearCotizacion = (c) => insertar('pi_cotizaciones', c)
export const borrarCotizacion = (id) => borrar('pi_cotizaciones', id)

// Escenario de costo: versión = última del mismo nombre + 1.
export async function guardarEscenario(candidatoId, nombre, entradas, resultado, escenariosExistentes = []) {
  const v = Math.max(0, ...escenariosExistentes.filter(e => e.nombre === nombre).map(e => e.version || 0)) + 1
  return insertar('pi_escenarios_costo', { candidato_id: candidatoId, nombre, version: v, entradas, resultado, calculado_en: new Date().toISOString() })
}

export async function guardarCaso(candidatoId, caso, casosExistentes = []) {
  const v = Math.max(0, ...casosExistentes.map(c => c.version || 0)) + 1
  return insertar('pi_casos', { candidato_id: candidatoId, ...caso, version: v })
}

export const crearExperimento = (e) => insertar('pi_experimentos', e)
export const actualizarExperimento = (id, cambios) => actualizar('pi_experimentos', id, cambios)

// Resultados reales de pruebas (ampliación A1): vista pi_resultado_experimentos.
export async function leerResultadoExperimentos(candidatoId) {
  try {
    const filas = await listar('pi_resultado_experimentos', { orden: null })
    return candidatoId ? filas.filter(f => !f.candidato_id || f.candidato_id === candidatoId) : filas
  } catch (e) { if (e.faltaTabla) return null; throw e }
}

// Datos reales de Voltra (solo lectura): vista pi_base_operativa.
export const leerBaseOperativa = () => listar('pi_base_operativa', { orden: null })

// ── Actividad ───────────────────────────────────────────────
export const listarTrabajos = () => listar('pi_trabajos', { orden: 'actualizado_en' })
export const crearTrabajo = (t) => insertar('pi_trabajos', { estado: 'QUEUED', intento: 0, ...t })
export const actualizarTrabajo = (id, cambios) => actualizar('pi_trabajos', id, cambios)
export const listarMensajes = () => listar('pi_mensajes', { orden: 'creado_en' })
export const listarPoliticas = () => listar('pi_politicas', { orden: 'creado_en' })

// ── Salida (ampliación A7): prueba de choque del nombre con familia_producto(text).
// Solo lectura. Si la función no es ejecutable por la sesión, avisa.
export async function probarFamiliaProducto(nombre) {
  if (modoDemo) return { ok: false, aviso: 'En modo DEMO no se consulta la base. Verificar con FUNCIONES.' }
  const intentos = [{ t: nombre }] // firma real: public.familia_producto(t text)
  let ultimo = null
  for (const args of intentos) {
    const { data, error } = await supabase.rpc('familia_producto', args)
    if (!error) return { ok: true, familia: data }
    ultimo = error
    // Si el error no es de firma de parámetros, no tiene sentido seguir probando.
    if (!/function|parameter|argument|schema cache/i.test(error.message || '')) break
  }
  return { ok: false, aviso: `No se pudo llamar a familia_producto (${ultimo?.message || 'sin permiso'}). Verificar con FUNCIONES.` }
}
