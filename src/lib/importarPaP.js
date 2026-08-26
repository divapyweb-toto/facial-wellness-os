// src/lib/importarPaP.js
// ═══════════════════════════════════════════════════════════
// LÓGICA PURA DE IMPORTACIÓN DE PUNTO A PUNTO
//
// Vivía dentro de EntregasPage.jsx, mezclada con el componente de React. Se
// extrajo acá cuando el observador local necesitó el MISMO parseo fuera del
// navegador: duplicarla habría creado dos versiones que se separan con el
// primer arreglo — exactamente lo que ya pasó en este código con el
// categorizador copiado en 5 archivos.
//
// Sin React, sin Supabase: entra un Excel, sale un array listo para guardar.
// Por eso se puede probar con `node` contra los archivos de datos-couriers/.
//
// Combina los DOS reportes de PaP (Gestión y Paquete) por NroGuia:
//   · Paquete manda para el ESTADO (es el cierre final)
//   · Gestión aporta el detalle (mensajero, fechas, teléfono, ruta)
// ═══════════════════════════════════════════════════════════
import * as XLSX from 'xlsx'
import { normalizarRef, limpiarTel } from './referencias'
import { categorizarPaP as categorizar, importeSano, esImporteCorrupto } from './estadosPaP'
import { costoFleteActual } from './flete'

export function detectarTipo(headers) {
  if (headers.includes('FechaEnt') || headers.includes('Recurso')) return 'gestion'
  if (headers.includes('Recibido Por') || headers.includes('FechaGestion')) return 'paquete'
  return 'desconocido'
}

export function parseXLSX(arrayBuffer) {
  const wb = XLSX.read(arrayBuffer, { cellDates: true })
  const ws = wb.Sheets[wb.SheetNames[0]]
  const rows = XLSX.utils.sheet_to_json(ws, { defval: '' })
  const headers = Object.keys(rows[0] || {})
  return { rows, headers, tipo: detectarTipo(headers) }
}



// Categoriza mirando ESTADO y MOTIVO juntos. El motivo manda cuando el estado
// es intermedio: un "Custodio" con motivo "Inubicable" es una devolución, no un proceso.

function toISODate(v) {
  if (!v) return null
  if (v instanceof Date && !isNaN(v)) return v.toISOString().split('T')[0]
  if (typeof v === 'string') {
    const m = v.match(/(\d{2})\/(\d{2})\/(\d{4})/)
    if (m) return `${m[3]}-${m[2]}-${m[1]}`
    if (/^\d{4}-\d{2}-\d{2}/.test(v)) return v.split('T')[0].split(' ')[0]
  }
  return null
}

function diasEntre(a, b) {
  if (!a || !b) return null
  const da = new Date(a), db = new Date(b)
  if (isNaN(da) || isNaN(db)) return null
  const d = Math.round((db - da) / 86400000)
  return d >= 0 ? d : null
}

// Combina ambos reportes por NroGuia. Paquete tiene prioridad para el estado
// (es el cierre final); Gestión aporta el detalle (mensajero, fechas, ruta).
export function combinar(paqData, gesData) {
  const pmap = new Map()
  const gmap = new Map()
  if (paqData) paqData.rows.forEach(r => pmap.set(String(r['NroGuia']), r))
  if (gesData) gesData.rows.forEach(r => gmap.set(String(r['NroGuia']), r))

  const guias = new Set([...pmap.keys(), ...gmap.keys()])
  const out = []
  // Registros cuyo Importe vino corrupto desde PaP (se avisan en pantalla).
  const importesDescartados = []

  guias.forEach(guia => {
    if (!guia || guia === 'undefined') return
    const p = pmap.get(guia)
    const g = gmap.get(guia)

    // Estado: prioridad PAQUETE (estado final). Motivo: el que tenga valor de cualquiera.
    const estado = (p && p['Estado']) ? p['Estado'] : (g ? g['Estado'] : '')
    const motivo = ((p && p['Motivo']) || (g && g['Motivo']) || '')
    const cat = categorizar(estado, motivo)
    // TOPE DE SANIDAD. Los borradores de PaP traen el Importe corrupto (se han
    // visto valores de 900+ millones), y un solo registro basura envenena todas
    // las sumas del sistema. Tu pedido más caro posible es Bebird ×3 ≈ 1.100.000,
    // así que cualquier cosa por encima del tope es dato roto, no una venta.
    const importeCrudo = parseInt((p ? p['Importe'] : g['Importe']) || 0) || 0
    const importe = importeSano(importeCrudo)
    if (esImporteCorrupto(importeCrudo)) {
      importesDescartados.push({
        ref: normalizarRef((p && p['NroGuiaRef']) ? p['NroGuiaRef'] : (g ? g['NroGuiaRef'] : '')),
        valor: importeCrudo,
        estado,
      })
    }
    const ref = normalizarRef((p && p['NroGuiaRef']) ? p['NroGuiaRef'] : (g ? g['NroGuiaRef'] : ''))
    const ciudad = ((g ? g['Ciudad'] : (p ? p['Ciudad'] : '')) || '').trim()
    const mensajero = (g ? g['Recurso'] : '') || ''
    const telefono = limpiarTel(g ? g['Telefono'] : '')
    const nombreCliente = ((g ? g['Nombre'] : (p ? p['Nombre'] : '')) || '').trim()
    const producto = (g ? (g['Descripcion'] || g['Tipodeproducto']) : (p ? p['TipoPaquete'] : '')) || ''
    const fIng = toISODate(g ? g['FechaIng'] : (p ? p['Fecha Ingreso'] : null))
    const fEnt = toISODate(g ? g['FechaEnt'] : (p ? p['FechaEvento'] : null))

    // Tesorería: ¿la plata ya te llegó? (solo si el reporte se exportó con "Incluir Tesorería")
    const estadoDepTesor = (g ? g['EstadoDepTesor'] : '') || ''
    const rendido = estadoDepTesor === 'Rendido Tesorero'
    const fRendido = toISODate(g ? g['FechaDepositoTesoreroCliente'] : null)
    const diasRendicion = (rendido && cat === 'entregado') ? diasEntre(fEnt, fRendido) : null

    out.push({
      nro_guia_pap: guia,
      n_referencia: ref,
      estado_pap: estado,
      categoria: cat,
      motivo,
      importe,
      cobrado: cat === 'entregado' ? importe : 0,
      costo_envio: costoFleteActual(),
      fecha_ingreso: fIng,
      fecha_entrega: fEnt,
      dias_entrega: cat === 'entregado' ? diasEntre(fIng, fEnt) : null,
      rendido,
      fecha_rendido: fRendido,
      dias_rendicion: diasRendicion,
      mensajero,
      // Se guardan con el sufijo _courier para que quede claro que es lo que
      // dice PaP, no lo que cargaste vos. Antes se llamaban `telefono` y
      // `nombre_cliente` y se descartaban antes del insert.
      telefono_courier: telefono,
      nombre_courier: nombreCliente,
      direccion_courier: (g ? g['Direccion'] : '') || '',
      ciudad,
      producto,
      mes: (fIng || fEnt || '').slice(0, 7),  // mes por FECHA DE INGRESO (cuándo salió a despacho)
    })
  })

  // Se cuelgan del array para que quien lo use pueda avisar sin cambiar la firma.
  out.importesDescartados = importesDescartados
  return out
}
