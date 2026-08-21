// src/lib/vinculacion.js
// ═══════════════════════════════════════════════════════════
// VINCULACIÓN AUTOMÁTICA DE GUÍAS CON VENTAS
//
// Al cargar una venta todavía no existe número de guía: PaP y Lucero la
// asignan cuando el paquete llega a su oficina. Vuelve en el Excel que ellos
// mandan, y ahí hay que pegarla con la venta que le corresponde.
//
// ── LO QUE HABÍA ANTES ──
// EntregasPage ya tenía una cascada parecida, pero con dos fallas graves:
//
//   1. NO GUARDABA el resultado. Lo usaba para marcar el estado de la venta y
//      lo tiraba. Cada carga de Excel recalculaba todo desde cero.
//   2. DESEMPATABA A CIEGAS. Si dos ventas compartían teléfono agarraba
//      `mismoTel[0]` — la primera de la lista, sin criterio. Con 51 clientes
//      tuyos que repitieron compra, eso es marcar la venta equivocada como
//      entregada. Se midió un caso real: un paquete de "Michael" tenía 7
//      ventas con ese nombre y 3 con el mismo importe. Una chance en tres.
//
// ── LA REGLA DE ORO ──
// Ante la duda NO se vincula. Un vínculo equivocado es peor que ninguno,
// porque mueve el estado de una venta ajena y nadie se entera. Todo lo dudoso
// va a la cola para que lo confirme una persona.
// ═══════════════════════════════════════════════════════════
import { limpiarTel } from './referencias'
import { refUtil, normTexto, diasDesde } from './buscadorPedidos'

// ─── Métodos, de más a menos confiable ──────────────────────
// El `rango` decide quién puede pisar a quién: un método vuelve a correr en
// cada carga, y sin jerarquía una coincidencia por nombre podría degradar un
// vínculo que ya estaba resuelto por referencia.
// `manual` y `sin_venta` tienen el rango más alto: los puso una persona y no
// los pisa ningún automático (además del trigger que lo blinda en la base).
export const METODOS = {
  referencia: { id: 'referencia', label: 'Por referencia',    rango: 3, color: 'var(--green)' },
  telefono:   { id: 'telefono',   label: 'Por teléfono',      rango: 2, color: 'var(--accent)' },
  nombre:     { id: 'nombre',     label: 'Por nombre',        rango: 1, color: 'var(--yellow)' },
  manual:     { id: 'manual',     label: 'Confirmado a mano', rango: 9, color: 'var(--purple)' },
  sin_venta:  { id: 'sin_venta',  label: 'Sin venta',         rango: 9, color: 'var(--text-muted)' },
}

const rango = (m) => METODOS[m]?.rango ?? 0
export const esProtegido = (m) => m === 'manual' || m === 'sin_venta'

// Una venta despachada mucho después de cargada no es el mismo pedido. Se
// permiten 3 días para atrás por desfasajes de zona horaria y cargas tardías.
export const VENTANA_DIAS = 45
const DIAS_TOLERANCIA_ATRAS = 3

function dentroDeVentana(venta, entrega) {
  const ref = entrega?.fecha_ingreso
  if (!ref || !venta?.fecha) return true   // sin fechas no se descarta por fecha
  const d = diasDesde(venta.fecha, new Date(String(ref).slice(0, 10) + 'T00:00:00'))
  if (d == null) return true
  return d >= -DIAS_TOLERANCIA_ATRAS && d <= VENTANA_DIAS
}

// ═══════════════════════════════════════════════════════════
// ÍNDICE DE VENTAS
// ═══════════════════════════════════════════════════════════
// Un pedido de 2 productos son 2 filas de venta con la misma referencia. El
// paquete es UNO, así que el vínculo apunta a una fila ancla: siempre la de
// menor id, para que dos corridas den el mismo resultado.
export function indexarVentas(ventas) {
  const porRef = new Map()
  const sueltas = []
  for (const v of (ventas || [])) {
    const r = refUtil(v.n_referencia)
    if (!r) { sueltas.push(v); continue }
    if (!porRef.has(r)) porRef.set(r, [])
    porRef.get(r).push(v)
  }
  const grupos = new Map()
  for (const [r, filas] of porRef) {
    const ordenadas = [...filas].sort((a, b) => String(a.id).localeCompare(String(b.id)))
    grupos.set(r, { ref: r, ancla: ordenadas[0], filas: ordenadas })
  }
  const porTel = new Map(), porNom = new Map()
  const agregar = (mapa, clave, v) => {
    if (!clave) return
    if (!mapa.has(clave)) mapa.set(clave, [])
    mapa.get(clave).push(v)
  }
  for (const v of (ventas || [])) {
    agregar(porTel, limpiarTel(v.cliente_telefono), v)
    agregar(porNom, normTexto(v.cliente_nombre), v)
  }
  return { grupos, sueltas, porTel, porNom, todas: ventas || [] }
}

const mismoMonto = (v, e) => Number(v?.total || 0) === Number(e?.importe || 0)
const mismaCiudad = (v, e) => {
  const a = normTexto(v?.ciudad), b = normTexto(e?.ciudad)
  return !a || !b ? false : a === b
}

// Cómo se describe un candidato en la cola, para poder decidir de un vistazo.
function aCandidato(v, motivo) {
  return {
    venta_id: v.id, n_referencia: v.n_referencia,
    cliente_nombre: v.cliente_nombre, cliente_telefono: v.cliente_telefono,
    ciudad: v.ciudad, total: v.total, fecha: v.fecha,
    producto_nombre: v.producto_nombre, estado: v.estado,
    motivo,
  }
}

// ═══════════════════════════════════════════════════════════
// LA CASCADA
// ═══════════════════════════════════════════════════════════
// Devuelve QUÉ habría que escribir, sin escribir nada. Así se puede mostrar el
// resumen antes de tocar la base, y se puede testear sin conexión.
//
//   entregas : filas ya guardadas o recién parseadas del Excel. Deben traer
//              nro_guia_pap, n_referencia, importe, ciudad, fecha_ingreso y,
//              si el reporte los tuvo, telefono_courier y nombre_courier.
//   ventas   : todas las ventas vivas.
export function calcularVinculos(entregas, ventas, opciones = {}) {
  const { ahora = new Date() } = opciones
  const ix = indexarVentas(ventas)
  const sello = ahora.toISOString()

  // Una venta no puede estar en dos paquetes. Se arranca con las que YA están
  // vinculadas en la base: sin esto, una segunda corrida le robaría la venta a
  // un paquete anterior y el vínculo iría rebotando entre guías.
  const ocupadas = new Set()
  for (const e of (entregas || [])) if (e.venta_id) ocupadas.add(e.venta_id)

  const vinculos = [], pendientes = []
  const resumen = { referencia: 0, telefono: 0, nombre: 0, pendientes: 0, protegidas: 0, sinCambio: 0, total: 0 }

  // Primero las que tienen referencia: son las de mayor confianza y reservan
  // su venta antes de que un match débil por nombre pueda quedársela.
  const orden = [...(entregas || [])].sort((a, b) => {
    const ra = refUtil(a.n_referencia) ? 0 : 1
    const rb = refUtil(b.n_referencia) ? 0 : 1
    return ra - rb
  })

  for (const e of orden) {
    resumen.total++

    if (esProtegido(e.vinculo_metodo)) { resumen.protegidas++; continue }

    let venta = null, metodo = null, candidatos = [], razon = null

    // ── 1. REFERENCIA ──
    const ref = refUtil(e.n_referencia)
    if (ref && ix.grupos.has(ref)) {
      const g = ix.grupos.get(ref)
      // Si el ancla ya está tomada por OTRA guía, es la misma referencia en dos
      // paquetes: no se fuerza, se manda a revisar.
      if (!ocupadas.has(g.ancla.id) || e.venta_id === g.ancla.id) {
        venta = g.ancla; metodo = 'referencia'
      } else {
        razon = `La referencia ${ref} ya está vinculada a otro paquete.`
        candidatos = [aCandidato(g.ancla, 'misma referencia')]
      }
    }

    // ── 2. TELÉFONO ──
    if (!venta && !razon) {
      const tel = limpiarTel(e.telefono_courier)
      if (tel && ix.porTel.has(tel)) {
        const libres = ix.porTel.get(tel).filter(v => !ocupadas.has(v.id) && dentroDeVentana(v, e))
        if (libres.length === 1) { venta = libres[0]; metodo = 'telefono' }
        else if (libres.length > 1) {
          const exactas = libres.filter(v => mismoMonto(v, e))
          if (exactas.length === 1) { venta = exactas[0]; metodo = 'telefono' }
          else {
            razon = `${libres.length} ventas con ese teléfono${exactas.length > 1 ? ` y ${exactas.length} con el mismo importe` : ', ninguna con el mismo importe'}.`
            candidatos = (exactas.length ? exactas : libres).map(v => aCandidato(v, 'mismo teléfono'))
          }
        }
      }
    }

    // ── 3. NOMBRE + MONTO + CIUDAD ──
    // El nombre solo no alcanza: 53 nombres se repiten entre tus clientes. Se
    // exige además que coincidan el importe y la ciudad.
    if (!venta && !razon) {
      const nom = normTexto(e.nombre_courier)
      if (nom && ix.porNom.has(nom)) {
        const libres = ix.porNom.get(nom).filter(v => !ocupadas.has(v.id) && dentroDeVentana(v, e))
        const fuertes = libres.filter(v => mismoMonto(v, e) && mismaCiudad(v, e))
        if (fuertes.length === 1) { venta = fuertes[0]; metodo = 'nombre' }
        else if (fuertes.length > 1) {
          razon = `${fuertes.length} ventas con el mismo nombre, importe y ciudad.`
          candidatos = fuertes.map(v => aCandidato(v, 'nombre + importe + ciudad'))
        } else if (libres.length) {
          const medios = libres.filter(v => mismoMonto(v, e))
          razon = medios.length
            ? `Coincide el nombre y el importe, pero no la ciudad.`
            : `Coincide el nombre pero no el importe.`
          candidatos = (medios.length ? medios : libres).map(v => aCandidato(v, medios.length ? 'nombre + importe' : 'solo el nombre'))
        }
      }
    }

    if (venta) {
      // Idempotencia: si ya está vinculada a la misma venta por un método igual
      // o mejor, no se escribe nada. Volver a subir el mismo Excel no genera
      // ni un solo UPDATE.
      if (e.venta_id === venta.id && rango(e.vinculo_metodo) >= rango(metodo)) {
        resumen.sinCambio++
        ocupadas.add(venta.id)
        continue
      }
      if (e.venta_id && rango(e.vinculo_metodo) > rango(metodo)) {
        resumen.sinCambio++
        ocupadas.add(e.venta_id)
        continue
      }
      ocupadas.add(venta.id)
      vinculos.push({
        nro_guia_pap: e.nro_guia_pap,
        venta_id: venta.id,
        vinculo_metodo: metodo,
        vinculo_at: sello,
      })
      resumen[metodo]++
    } else {
      // Ya estaba vinculada de antes y esta corrida no encontró nada mejor:
      // se deja como está, no se rompe un vínculo que ya existía.
      if (e.venta_id) { resumen.sinCambio++; ocupadas.add(e.venta_id); continue }
      resumen.pendientes++
      pendientes.push({
        nro_guia_pap: e.nro_guia_pap,
        entrega: e,
        candidatos,
        razon: razon || (refUtil(e.n_referencia)
          ? `La referencia ${refUtil(e.n_referencia)} no existe en ninguna venta.`
          : 'El reporte del courier no trajo referencia y no hay con qué cruzarlo.'),
      })
    }
  }

  return { vinculos, pendientes, resumen }
}

// ─── Texto del resumen para mostrar al terminar la carga ────
export function textoResumen(r) {
  const p = []
  if (r.referencia) p.push(`${r.referencia} por referencia`)
  if (r.telefono) p.push(`${r.telefono} por teléfono`)
  if (r.nombre) p.push(`${r.nombre} por nombre`)
  const auto = r.referencia + r.telefono + r.nombre
  const l = [auto ? `${auto} vinculadas (${p.join(' · ')})` : 'Ninguna vinculada nueva']
  if (r.sinCambio) l.push(`${r.sinCambio} ya estaban`)
  if (r.protegidas) l.push(`${r.protegidas} confirmadas a mano (no se tocaron)`)
  if (r.pendientes) l.push(`${r.pendientes} para revisar`)
  return l.join(' · ')
}
