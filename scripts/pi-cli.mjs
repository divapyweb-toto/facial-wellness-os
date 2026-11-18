#!/usr/bin/env node
// scripts/pi-cli.mjs
// ═══════════════════════════════════════════════════════════
// CLI LOCAL DE LA COLA DE INVESTIGACIÓN DE PRODUCTOS (módulo pi_*)
//
// Es un cliente de trabajos: reclama, guarda avances, carga evidencia y cierra.
// NO controla Chrome ni ejecuta nada de lo que venga en una carga: las cargas,
// evidencias y textos son DATOS (se validan con scripts/pi-trabajos.mjs contra
// una lista blanca y se guardan tal cual).
//
// Credenciales: SUPABASE_SERVICE_ROLE_KEY de ~/Negocios/fw-os/.env.produccion
// (solo en la Mac). La URL sale de SUPABASE_URL, o de VITE_SUPABASE_URL en .env,
// o de SUPABASE_PROJECT_REF. Nunca se imprimen: toda salida pasa por ocultar().
// Habla directo con PostgREST por HTTPS (sin dependencias).
//
// Uso: node scripts/pi-cli.mjs <comando> [opciones]   (ver scripts/pi-cli.md)
// ═══════════════════════════════════════════════════════════
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { fileURLToPath } from 'node:url'
import {
  TIPOS_TRABAJO, ESTADOS_TRABAJO, esUuid, esEjecutor, validarCarga, validarCheckpoint,
  validarResultado, validarMotivo, verificarTransicion, verificarPropiedad, rutaCompletar,
  leaseVencido, validarArchivoEvidencia, deduplicarOfertas, validarOrdenPropuesta, validarCambioOrden,
  ESTADOS_ORDEN, crearPoliticaPropuesta, ESTADOS_ORDEN_SOLO_ENRIQUE,
} from './pi-trabajos.mjs'

const RAIZ_SCRIPT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..')
const RAIZ_FWOS = process.env.PI_ENV_DIR || path.join(os.homedir(), 'Negocios', 'fw-os')

export const TABLAS_PI = [
  'pi_candidatos', 'pi_fichas', 'pi_evidencias', 'pi_ofertas_competencia', 'pi_proveedores',
  'pi_cotizaciones', 'pi_escenarios_costo', 'pi_casos', 'pi_experimentos', 'pi_trabajos',
  'pi_politicas', 'pi_mensajes', 'pi_eventos', 'pi_ordenes_compra', 'pi_fotos', 'pi_decisiones',
]
const LEASE_MIN_DEFECTO = 30

// ─── Salida sin secretos ────────────────────────────────────
const secretos = []
const ocultar = (t) => secretos.reduce((s, k) => (k && k.length >= 8 ? s.split(k).join('<oculto>') : s), String(t))
const out = (...a) => process.stdout.write(ocultar(a.join(' ')) + '\n')
const err = (...a) => process.stderr.write(ocultar(a.join(' ')) + '\n')
class ErrorCli extends Error { constructor(m, codigo = 1) { super(m); this.codigo = codigo } }

// ─── Credenciales ───────────────────────────────────────────
function leerArchivoEnv(ruta) {
  const env = {}
  if (!fs.existsSync(ruta)) return env
  for (const linea of fs.readFileSync(ruta, 'utf8').split('\n')) {
    const m = linea.match(/^\s*([A-Z0-9_]+)\s*=\s*(.*)$/)
    if (m) env[m[1]] = m[2].trim().replace(/^["']|["']$/g, '')
  }
  return env
}

export function leerCredenciales() {
  const prod = { ...leerArchivoEnv(path.join(RAIZ_SCRIPT, '.env.produccion')), ...leerArchivoEnv(path.join(RAIZ_FWOS, '.env.produccion')) }
  const vite = { ...leerArchivoEnv(path.join(RAIZ_SCRIPT, '.env')), ...leerArchivoEnv(path.join(RAIZ_FWOS, '.env')) }
  const clave = process.env.SUPABASE_SERVICE_ROLE_KEY || prod.SUPABASE_SERVICE_ROLE_KEY || ''
  let url = process.env.SUPABASE_URL || prod.SUPABASE_URL || vite.VITE_SUPABASE_URL || ''
  if (!url && prod.SUPABASE_PROJECT_REF) url = `https://${prod.SUPABASE_PROJECT_REF}.supabase.co`
  if (clave) secretos.push(clave)
  return { url: url.replace(/\/+$/, ''), clave }
}

function validarUrlBase(url) {
  let u
  try { u = new URL(url) } catch { return 'la URL de Supabase no es válida' }
  const local = ['localhost', '127.0.0.1', '[::1]'].includes(u.hostname)
  if (u.protocol !== 'https:' && !(local && u.protocol === 'http:')) return 'la URL de Supabase tiene que ser https'
  if (!local && !u.hostname.endsWith('.supabase.co')) return 'la URL no es de supabase.co'
  return null
}

// ─── Cliente PostgREST mínimo ───────────────────────────────
function cliente({ url, clave }) {
  const base = `${url}/rest/v1`
  const headers = { apikey: clave, Authorization: `Bearer ${clave}`, 'Content-Type': 'application/json' }
  async function pedir(metodo, ruta, { cuerpo, prefer } = {}) {
    let r
    try {
      r = await fetch(base + ruta, { method: metodo, headers: { ...headers, ...(prefer ? { Prefer: prefer } : {}) }, body: cuerpo === undefined ? undefined : JSON.stringify(cuerpo) })
    } catch (e) {
      throw new ErrorCli(`sin conexión con Supabase (${e.cause?.code || e.message})`, 3)
    }
    const texto = await r.text()
    let datos = null
    try { datos = texto ? JSON.parse(texto) : null } catch { datos = texto }
    return { status: r.status, ok: r.ok, datos }
  }
  const exigir = (res, que) => {
    if (res.ok) return res.datos
    const d = res.datos && typeof res.datos === 'object' ? res.datos : {}
    if (d.code === 'PGRST205' || d.code === '42P01') throw new ErrorCli(`${que}: tablas pi_* no encontradas (falta aplicar la migración del módulo)`, 2)
    if (d.code === 'PGRST202') throw new ErrorCli(`${que}: función pi_reclamar_trabajo no encontrada (falta aplicar la migración)`, 2)
    throw new ErrorCli(`${que}: error ${res.status} ${d.message || ''}`.trim())
  }
  return { pedir, exigir }
}

// ─── Utilidades de argumentos ───────────────────────────────
function parsearArgs(argv) {
  const pos = [], op = {}
  for (let i = 0; i < argv.length; i++) {
    const a = argv[i]
    if (a.startsWith('--')) {
      const k = a.slice(2)
      const sig = argv[i + 1]
      if (sig === undefined || sig.startsWith('--')) op[k] = true
      else { op[k] = sig; i++ }
    } else pos.push(a)
  }
  return { pos, op }
}
function exigirUuid(v, nombre) { if (!esUuid(v)) throw new ErrorCli(`${nombre}: falta o no es un id válido (uuid)`); return v.toLowerCase() }
function leerJson(ruta) {
  if (!ruta || ruta === true) throw new ErrorCli('falta --archivo <ruta.json>')
  if (!fs.existsSync(ruta)) throw new ErrorCli(`no existe el archivo ${ruta}`)
  if (fs.statSync(ruta).size > 2_000_000) throw new ErrorCli('archivo demasiado grande (máx. 2 MB)')
  try { return JSON.parse(fs.readFileSync(ruta, 'utf8')) } catch (e) { throw new ErrorCli(`el archivo no es JSON válido: ${e.message}`) }
}
function ejecutorDe(op) {
  const e = op.ejecutor === true ? '' : (op.ejecutor || process.env.PI_EJECUTOR || 'mac-enrique')
  if (!esEjecutor(e)) throw new ErrorCli('--ejecutor inválido (minúsculas, números, . _ -)')
  return e
}
function leaseMin(op) {
  const n = op['lease-min'] === undefined ? LEASE_MIN_DEFECTO : Number(op['lease-min'])
  if (!Number.isInteger(n) || n < 5 || n > 240) throw new ErrorCli('--lease-min entre 5 y 240')
  return n
}
const enMin = (min) => new Date(Date.now() + min * 60_000).toISOString()

async function registrarEvento(api, entidad, entidadId, accion, detalle, actor) {
  // Auditoría de mejor esfuerzo: si falla, se avisa pero no frena la operación.
  const r = await api.pedir('POST', '/pi_eventos', { cuerpo: { entidad, entidad_id: entidadId, accion, detalle, actor }, prefer: 'return=minimal' })
  if (!r.ok) err(`aviso: no se pudo registrar el evento ${accion} (${r.status})`)
}

async function leerTrabajo(api, id) {
  const filas = api.exigir(await api.pedir('GET', `/pi_trabajos?id=eq.${id}&select=*`), 'leer trabajo')
  if (!filas?.length) throw new ErrorCli(`no existe el trabajo ${id}`)
  return filas[0]
}

// Actualización atómica: solo cambia si el trabajo sigue en el estado, con el
// ejecutor y el intento que leímos. Si otro lo reclamó entretanto, 0 filas.
async function actualizarTrabajo(api, t, cambios) {
  const filtro = `id=eq.${t.id}&estado=eq.${t.estado}&intento=eq.${t.intento}` + (t.ejecutor ? `&ejecutor=eq.${encodeURIComponent(t.ejecutor)}` : '&ejecutor=is.null')
  const filas = api.exigir(await api.pedir('PATCH', `/pi_trabajos?${filtro}`, { cuerpo: { ...cambios, actualizado_en: new Date().toISOString() }, prefer: 'return=representation' }), 'actualizar trabajo')
  if (!filas?.length) throw new ErrorCli('el trabajo cambió mientras tanto (otro ejecutor lo reclamó o cambió de estado): no se tocó nada')
  return filas[0]
}

async function tomarPropio(api, id, ejecutor) {
  const t = await leerTrabajo(api, id)
  const p = verificarPropiedad(t, ejecutor)
  if (!p.ok) throw new ErrorCli(p.error)
  if (p.vencido) err('aviso: el lease estaba vencido; se sigue solo si nadie más lo reclamó (actualización atómica)')
  return t
}

const resumenTrabajo = (t) => `${t.id}  ${String(t.tipo).padEnd(18)} ${String(t.estado).padEnd(13)} intento ${t.intento ?? 0}  ${t.ejecutor ?? '-'}  lease ${t.lease_hasta ?? '-'}${leaseVencido(t) ? '  (LEASE VENCIDO)' : ''}`

// ─── Comandos ───────────────────────────────────────────────
const COMANDOS = {
  async listar(api, { op }) {
    const partes = ['select=id,tipo,candidato_id,estado,intento,ejecutor,lease_hasta,creado_en,bloqueo', 'order=creado_en.desc']
    if (op.estado) { if (!ESTADOS_TRABAJO.includes(op.estado)) throw new ErrorCli(`--estado: uno de ${ESTADOS_TRABAJO.join(', ')}`); partes.push(`estado=eq.${op.estado}`) }
    if (op.tipo) { if (!TIPOS_TRABAJO.includes(op.tipo)) throw new ErrorCli(`--tipo: uno de ${TIPOS_TRABAJO.join(', ')}`); partes.push(`tipo=eq.${op.tipo}`) }
    const lim = op.limite === undefined ? 20 : Number(op.limite)
    if (!Number.isInteger(lim) || lim < 1 || lim > 200) throw new ErrorCli('--limite entre 1 y 200')
    partes.push(`limit=${lim}`)
    const filas = api.exigir(await api.pedir('GET', `/pi_trabajos?${partes.join('&')}`), 'listar')
    if (op.json) return out(JSON.stringify(filas, null, 2))
    if (!filas.length) return out('No hay trabajos con ese filtro.')
    out('id                                    tipo               estado        intento  ejecutor  lease')
    for (const t of filas) out(resumenTrabajo(t) + (t.bloqueo ? `\n    bloqueo: ${t.bloqueo}` : ''))
  },

  async 'crear-trabajo'(api, { op }) {
    const tipo = op.tipo
    const candidato = op.candidato ? exigirUuid(op.candidato, '--candidato') : null
    const v = validarCarga(tipo, leerJson(op.archivo), candidato)
    if (!v.ok) throw new ErrorCli('carga rechazada:\n  ' + v.errores.join('\n  '))
    if (candidato) {
      const c = api.exigir(await api.pedir('GET', `/pi_candidatos?id=eq.${candidato}&select=id`), 'buscar candidato')
      if (!c.length) throw new ErrorCli(`no existe el candidato ${candidato}`)
    }
    const [t] = api.exigir(await api.pedir('POST', '/pi_trabajos', { cuerpo: { tipo, candidato_id: candidato, carga: v.valor, estado: 'QUEUED' }, prefer: 'return=representation' }), 'crear trabajo')
    await registrarEvento(api, 'pi_trabajos', t.id, 'crear', { tipo }, 'cli')
    out(`Trabajo creado: ${t.id} (${tipo}, QUEUED)`)
  },

  async reclamar(api, { op }) {
    const ejecutor = ejecutorDe(op)
    if (!op.tipos || op.tipos === true) throw new ErrorCli(`falta --tipos (ej. investigar_py o investigar_py,analizar)`)
    const tipos = String(op.tipos).split(',').map((s) => s.trim()).filter(Boolean)
    const malos = tipos.filter((t) => !TIPOS_TRABAJO.includes(t))
    if (!tipos.length || malos.length) throw new ErrorCli(`--tipos inválidos: ${malos.join(', ')}; válidos: ${TIPOS_TRABAJO.join(', ')}`)
    const res = api.exigir(await api.pedir('POST', '/rpc/pi_reclamar_trabajo', { cuerpo: { p_ejecutor: ejecutor, p_tipos: tipos, p_lease_min: leaseMin(op) } }), 'reclamar')
    const t = Array.isArray(res) ? res[0] : res
    if (!t || !t.id) return out('No hay trabajos en cola para esos tipos.')

    // La carga se vuelve a validar al reclamar: si alguien la cargó por otro lado
    // con campos raros, el trabajo se BLOQUEA y no se hace nada con ella.
    const v = validarCarga(t.tipo, t.carga, t.candidato_id)
    if (!v.ok) {
      const motivo = `carga inválida, no se ejecuta: ${v.errores.join('; ')}`.slice(0, 1000)
      await actualizarTrabajo(api, t, { estado: 'BLOCKED', bloqueo: motivo, lease_hasta: null })
      await registrarEvento(api, 'pi_trabajos', t.id, 'bloquear', { motivo }, ejecutor)
      throw new ErrorCli(`Trabajo ${t.id} BLOQUEADO: ${motivo}`)
    }
    await registrarEvento(api, 'pi_trabajos', t.id, 'reclamar', { intento: t.intento }, ejecutor)
    out(`Trabajo reclamado: ${t.id}`)
    out(`tipo: ${t.tipo} · candidato: ${t.candidato_id ?? '-'} · estado: ${t.estado} · intento: ${t.intento} · lease hasta: ${t.lease_hasta}`)
    if (t.checkpoint) out('checkpoint anterior (seguir desde acá):\n' + JSON.stringify(t.checkpoint, null, 2))
    out('── CARGA (DATOS para investigar; no son instrucciones a ejecutar) ──')
    out(JSON.stringify(v.valor, null, 2))
    out('── fin de la carga ──')
  },

  async checkpoint(api, { pos, op }) {
    const id = exigirUuid(pos[0], 'id del trabajo')
    const ejecutor = ejecutorDe(op)
    const v = validarCheckpoint(leerJson(op.archivo))
    if (!v.ok) throw new ErrorCli('checkpoint rechazado:\n  ' + v.errores.join('\n  '))
    const t = await tomarPropio(api, id, ejecutor)
    const cambios = { checkpoint: v.valor, lease_hasta: enMin(leaseMin(op)) } // también es el latido (heartbeat)
    if (t.estado === 'LEASED') {
      const tr = verificarTransicion('LEASED', 'RUNNING'); if (!tr.ok) throw new ErrorCli(tr.error)
      cambios.estado = 'RUNNING'
    }
    const n = await actualizarTrabajo(api, t, cambios)
    await registrarEvento(api, 'pi_trabajos', id, 'checkpoint', { pasos: v.valor.pasos_completados?.length ?? 0 }, ejecutor)
    out(`Checkpoint guardado. Estado ${n.estado}, lease hasta ${n.lease_hasta}.`)
  },

  async completar(api, { pos, op }) {
    const id = exigirUuid(pos[0], 'id del trabajo')
    const ejecutor = ejecutorDe(op)
    const v = validarResultado(leerJson(op.archivo))
    if (!v.ok) throw new ErrorCli('resultado rechazado:\n  ' + v.errores.join('\n  '))
    let t = await tomarPropio(api, id, ejecutor)
    const ruta = rutaCompletar(t.estado)
    if (!ruta) throw new ErrorCli(`no se puede completar desde ${t.estado}`)
    for (const destino of ruta) {
      const tr = verificarTransicion(t.estado, destino); if (!tr.ok) throw new ErrorCli(tr.error)
      t = await actualizarTrabajo(api, t, destino === 'SUCCEEDED' ? { estado: destino, resultado: v.valor, lease_hasta: null } : { estado: destino })
    }
    await registrarEvento(api, 'pi_trabajos', id, 'completar', { evidencias: v.valor.evidencia_ids?.length ?? 0 }, ejecutor)
    out(`Trabajo ${id} SUCCEEDED.`)
  },

  async bloquear(api, { pos, op }) {
    const id = exigirUuid(pos[0], 'id del trabajo')
    const ejecutor = ejecutorDe(op)
    const m = validarMotivo(op.motivo === true ? '' : op.motivo)
    if (!m.ok) throw new ErrorCli(m.errores.join('; ') + ' (usá --motivo "…")')
    const t = await tomarPropio(api, id, ejecutor)
    const tr = verificarTransicion(t.estado, 'BLOCKED'); if (!tr.ok) throw new ErrorCli(tr.error)
    await actualizarTrabajo(api, t, { estado: 'BLOCKED', bloqueo: m.valor, lease_hasta: null })
    await registrarEvento(api, 'pi_trabajos', id, 'bloquear', { motivo: m.valor }, ejecutor)
    out(`Trabajo ${id} BLOCKED: ${m.valor}`)
  },

  // Recuperación: un trabajo LEASED/RUNNING con lease vencido vuelve a la cola
  // (conserva su checkpoint para que el próximo siga desde ahí).
  async liberar(api, { pos }) {
    const id = exigirUuid(pos[0], 'id del trabajo')
    const t = await leerTrabajo(api, id)
    if (!leaseVencido(t)) throw new ErrorCli(`solo se libera un trabajo LEASED/RUNNING con lease vencido (está ${t.estado}, lease ${t.lease_hasta ?? '-'})`)
    const tr = verificarTransicion(t.estado, 'QUEUED'); if (!tr.ok) throw new ErrorCli(tr.error)
    await actualizarTrabajo(api, t, { estado: 'QUEUED', ejecutor: null, lease_hasta: null })
    await registrarEvento(api, 'pi_trabajos', id, 'liberar', { desde: t.estado }, 'cli')
    out(`Trabajo ${id} vuelve a la cola (QUEUED), con su checkpoint.`)
  },

  async 'cargar-evidencia'(api, { op }) {
    const candidato = exigirUuid(op.candidato, '--candidato')
    const cargadoPor = op['cargado-por'] && op['cargado-por'] !== true ? String(op['cargado-por']).slice(0, 100) : ejecutorDe(op)
    const v = validarArchivoEvidencia(leerJson(op.archivo), { cargadoPor })
    for (const a of v.advertencias ?? []) err('aviso: ' + a)
    if (!v.ok) throw new ErrorCli('evidencia rechazada (no se cargó nada):\n  ' + v.errores.join('\n  '))
    const c = api.exigir(await api.pedir('GET', `/pi_candidatos?id=eq.${candidato}&select=id`), 'buscar candidato')
    if (!c.length) throw new ErrorCli(`no existe el candidato ${candidato}`)

    const filasEv = v.evidencias.map((f) => ({ ...f, candidato_id: candidato }))
    const insertadas = api.exigir(await api.pedir('POST', '/pi_evidencias', { cuerpo: filasEv, prefer: 'return=representation' }), 'insertar evidencias')
    if (!Array.isArray(insertadas) || insertadas.length !== filasEv.length) throw new ErrorCli('la base no devolvió todas las evidencias insertadas')
    out(`Evidencias cargadas: ${insertadas.length}`)

    let ofertasIds = []
    if (v.ofertas.length) {
      const existentes = api.exigir(await api.pedir('GET', `/pi_ofertas_competencia?candidato_id=eq.${candidato}&select=vendedor_clave,comparacion,precio_minor,moneda,tipo_precio,url`), 'leer ofertas existentes')
      const filas = v.ofertas.map((o) => ({ ...o.fila, candidato_id: candidato, evidencia_id: insertadas[o.evidencia_indice].id }))
      const { unicas, duplicadas } = deduplicarOfertas(filas, existentes)
      for (const d of duplicadas) err(`aviso: oferta duplicada salteada (${d.vendedor_clave}, ${d.precio_minor} ${d.moneda})`)
      if (unicas.length) {
        const r = await api.pedir('POST', '/pi_ofertas_competencia', { cuerpo: unicas, prefer: 'return=representation' })
        if (!r.ok) {
          // Compensación: sin ofertas, se borran las evidencias recién cargadas (todo o nada).
          const ids = insertadas.map((e) => e.id).join(',')
          const b = await api.pedir('DELETE', `/pi_evidencias?id=in.(${ids})`, { prefer: 'return=minimal' })
          throw new ErrorCli(`falló la carga de ofertas (${r.status} ${r.datos?.message ?? ''}); ${b.ok ? 'se revirtieron las evidencias' : 'OJO: no se pudieron revertir las evidencias ' + ids}`)
        }
        ofertasIds = r.datos.map((x) => x.id)
      }
      out(`Ofertas cargadas: ${ofertasIds.length} · duplicadas salteadas: ${duplicadas.length}`)
    }
    await registrarEvento(api, 'pi_candidatos', candidato, 'cargar_evidencia', { evidencias: insertadas.length, ofertas: ofertasIds.length }, cargadoPor)
    out('evidencia_ids: ' + JSON.stringify(insertadas.map((e) => e.id)))
    if (ofertasIds.length) out('oferta_ids: ' + JSON.stringify(ofertasIds))
  },

  // Órdenes de compra: el CLI arma la propuesta y registra estados. NUNCA paga:
  // el pago lo hace Enrique; acá no entra ningún dato de tarjeta ni de cuenta.
  async 'orden-proponer'(api, { op }) {
    const candidato = exigirUuid(op.candidato, '--candidato')
    const v = validarOrdenPropuesta(leerJson(op.archivo), candidato)
    if (!v.ok) throw new ErrorCli('orden rechazada:\n  ' + v.errores.join('\n  '))
    const c = api.exigir(await api.pedir('GET', `/pi_candidatos?id=eq.${candidato}&select=id`), 'buscar candidato')
    if (!c.length) throw new ErrorCli(`no existe el candidato ${candidato}`)
    const [o] = api.exigir(await api.pedir('POST', '/pi_ordenes_compra', { cuerpo: v.valor, prefer: 'return=representation' }), 'crear orden')
    // La auditoría de órdenes la hace el disparador pi_ordenes_compra_auditar de la base.
    out(`Orden propuesta: ${o.id} (BORRADOR)`)
    out(`${o.plataforma} · ${o.variante ?? 'sin variante'} · ${o.cantidad} u × ${o.precio_unit_minor} + envío ${o.envio_minor} = TOTAL ${o.total_minor} ${o.moneda} (unidades menores) · llega a: ${o.deposito_destino}${o.forwarder ? ' vía ' + o.forwarder : ''}`)
    out('Siguiente: Enrique confirma producto y total en Voltra OS (Productos nuevos → Proveedores → Órdenes → Estado), con su sesión. La base no deja hacerlo desde el CLI.')
  },

  async 'orden-estado'(api, { pos, op }) {
    const id = exigirUuid(pos[0], 'id de la orden')
    const hacia = op.estado
    if (!ESTADOS_ORDEN.includes(hacia)) throw new ErrorCli(`--estado: uno de ${ESTADOS_ORDEN.join(', ')}`)
    if (ESTADOS_ORDEN_SOLO_ENRIQUE.includes(hacia)) throw new ErrorCli(`${hacia} lo marca solo Enrique en Voltra OS (Productos nuevos → Proveedores → Órdenes), con su sesión: la base rechaza la clave de servicio`)
    const txt = (k) => (op[k] && op[k] !== true ? String(op[k]) : null)
    const filas = api.exigir(await api.pedir('GET', `/pi_ordenes_compra?id=eq.${id}&select=*`), 'leer orden')
    if (!filas.length) throw new ErrorCli(`no existe la orden ${id}`)
    const orden = filas[0]
    const v = validarCambioOrden(orden, hacia, { confirmacion: txt('confirmacion'), tracking: txt('tracking'), nota: txt('nota') })
    if (!v.ok) throw new ErrorCli(v.errores.join('; '))
    const act = api.exigir(await api.pedir('PATCH', `/pi_ordenes_compra?id=eq.${id}&estado=eq.${orden.estado}`, { cuerpo: { ...v.valor, actualizado_en: new Date().toISOString() }, prefer: 'return=representation' }), 'actualizar orden')
    if (!act.length) throw new ErrorCli('la orden cambió mientras tanto: no se tocó nada')
    out(`Orden ${id}: ${orden.estado} → ${hacia}`)
    if (hacia === 'PEDIDA') out('Llegó al paso de pago: el pago lo hace Enrique, y después la marca PAGADA en Voltra OS con su sesión.')
  },

  // Campaña de negociación: el CLI la PROPONE (permite_envio = false) con el alcance por defecto del
  // contrato. La autoriza Enrique en Voltra OS con su sesión (la base rechaza la clave de servicio).
  async 'politica-proponer'(api, { op }) {
    const candidato = exigirUuid(op.candidato, '--candidato')
    const c = api.exigir(await api.pedir('GET', `/pi_candidatos?id=eq.${candidato}&select=id,nombre`), 'buscar candidato')
    if (!c.length) throw new ErrorCli(`no existe el candidato ${candidato}`)
    const v = crearPoliticaPropuesta({ candidatoId: candidato, producto: c[0].nombre })
    if (!v.ok) throw new ErrorCli(v.errores.join('; '))
    const [p] = api.exigir(await api.pedir('POST', '/pi_politicas', { cuerpo: v.valor, prefer: 'return=representation' }), 'crear política')
    await registrarEvento(api, 'pi_politicas', p.id, 'proponer', { alcance: v.valor.alcance }, ejecutorDe(op))
    const a = v.valor.alcance
    out(`Campaña propuesta: ${p.id} · ${a.producto} (todavía NO permite enviar)`)
    out(`Alcance: hasta ${a.proveedores_max} proveedores, ${a.rondas_max} rondas, seguimiento a los ${a.seguimiento_dias_habiles} días hábiles, ${a.vigencia_dias} días desde que Enrique la autorice`)
    out('Siguiente: Enrique la autoriza en Voltra OS → Productos nuevos → Proveedores → "Autorizar", con su sesión.')
    out('Fuera de alcance siempre: aceptar orden, pagar, muestras, exclusividad, términos (confirmación aparte de Enrique).')
  },

  async diagnostico(api, { cred }) {
    out(`URL de Supabase: ${cred.url ? 'presente (' + new URL(cred.url).hostname.replace(/^(.{4}).*?(\.supabase\.co)$/, '$1…$2') + ')' : 'FALTA'}`)
    out(`Clave de servicio: ${cred.clave ? 'presente (no se muestra)' : 'FALTA'}`)
    // Conexión: una consulta inofensiva a una tabla que ya existe en Voltra.
    const ping = await api.pedir('GET', '/productos?select=id&limit=1')
    if (ping.status === 401 || ping.status === 403) throw new ErrorCli('conexión rechazada: la clave no es válida para este proyecto', 3)
    out(`Conexión con la base: ${ping.ok ? 'OK' : `respondió ${ping.status}`}`)

    const faltan = [], estan = []
    for (const tabla of TABLAS_PI) {
      const r = await api.pedir('GET', `/${tabla}?select=id&limit=0`)
      if (r.ok) estan.push(tabla)
      else if (r.datos?.code === 'PGRST205' || r.datos?.code === '42P01' || r.status === 404) faltan.push(tabla)
      else faltan.push(`${tabla} (error ${r.status})`)
    }
    // La función de reclamo: se busca en el esquema OpenAPI (no se llama: reclamaría un trabajo).
    let rpc = 'no verificada'
    const raiz = await api.pedir('GET', '/')
    if (raiz.ok && raiz.datos?.paths) rpc = raiz.datos.paths['/rpc/pi_reclamar_trabajo'] ? 'encontrada' : 'NO encontrada'
    out(`Tablas pi_* encontradas: ${estan.length} de ${TABLAS_PI.length}`)
    out(`Función pi_reclamar_trabajo: ${rpc}`)
    if (faltan.length === TABLAS_PI.length) throw new ErrorCli('tablas pi_* no encontradas: falta aplicar la migración del módulo (la aplica el integrador con el OK de Enrique)', 2)
    if (faltan.length) throw new ErrorCli('faltan tablas: ' + faltan.join(', '), 2)
    if (rpc === 'NO encontrada') throw new ErrorCli('falta la función pi_reclamar_trabajo', 2)
    out('Diagnóstico OK: el módulo está listo para usarse.')
  },
}

const AYUDA = `Uso: node scripts/pi-cli.mjs <comando> [opciones]
  diagnostico                                   conexión y tablas pi_* (no muestra claves)
  listar [--estado X] [--tipo Y] [--limite N] [--json]
  crear-trabajo --tipo <${TIPOS_TRABAJO.join('|')}> [--candidato <uuid>] --archivo carga.json
  reclamar --ejecutor mac-enrique --tipos investigar_py[,analizar] [--lease-min 30]
  checkpoint <id> --archivo checkpoint.json [--ejecutor mac-enrique]
  completar <id> --archivo resultado.json [--ejecutor mac-enrique]
  bloquear <id> --motivo "texto" [--ejecutor mac-enrique]
  liberar <id>                                  devuelve a la cola un trabajo con lease vencido
  cargar-evidencia --candidato <uuid> --archivo evidencia.json [--cargado-por nombre]
  politica-proponer --candidato <uuid>   propone la campaña de negociación (la autoriza Enrique en Voltra OS)
  orden-proponer --candidato <uuid> --archivo orden.json      arma la orden en BORRADOR (no paga)
  orden-estado <id> --estado <${ESTADOS_ORDEN.join('|')}> [--confirmacion "…"] [--tracking T] [--nota "…"]
Detalle: scripts/pi-cli.md`

export async function main(argv = process.argv.slice(2)) {
  const { pos, op } = parsearArgs(argv)
  const comando = pos.shift()
  if (!comando || comando === 'ayuda' || op.help) { out(AYUDA); return 0 }
  if (!Object.hasOwn(COMANDOS, comando)) { err(`comando desconocido: ${comando}\n\n${AYUDA}`); return 1 }
  try {
    const cred = leerCredenciales()
    if (!cred.url || !cred.clave) throw new ErrorCli(`faltan credenciales: ${!cred.url ? 'URL de Supabase ' : ''}${!cred.clave ? 'SUPABASE_SERVICE_ROLE_KEY ' : ''}(en ${path.join(RAIZ_FWOS, '.env.produccion')})`, 3)
    const malUrl = validarUrlBase(cred.url)
    if (malUrl) throw new ErrorCli(malUrl, 3)
    await COMANDOS[comando](cliente(cred), { pos, op, cred })
    return 0
  } catch (e) {
    if (e instanceof ErrorCli) { err('ERROR: ' + e.message); return e.codigo }
    err('ERROR inesperado: ' + (e?.message ?? e)); return 1
  }
}

if (process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  main().then((c) => { process.exitCode = c })
}
