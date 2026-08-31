// src/lib/exportLucero.js
// ═══════════════════════════════════════════════════════════
// EXPORTACIÓN DE SEGUIMIENTO DE LUCERO DEL ESTE
//
// Archivo distinto (y mucho mejor) que el de Rendición: trae TODOS los envíos
// del rango con su estado actual, no solo los ya liquidados. Es el equivalente
// al reporte de "Gestión" de PaP — la fuente de verdad del tracking.
//
// 23 columnas: Codigo, EnvioID, Estado, FechaCreado, FechaUltimoEstado, Ciudad,
// Zona, Barrio, Destinatario, Telefono, Direccion, Item, Cantidad, Total,
// Tarifa, Multa, FormaPago, Motivo, Transportador, FechaAsignacionRuta,
// Rendido, FechaRendicion, Notas.
//
// ── TRES REGLAS QUE SALEN DE LOS DATOS REALES, NO DE SUPONER ──
//
// 1. "Fallido" NO ES DEFINITIVO. Lucero reintenta: se vio el ciclo completo
//    en_camino → fallido → aceptado → en_camino → ENTREGADO (código 2022).
//    Tratarlo como devolución sería contar una pérdida que todavía puede
//    revertirse, y además restaría flete que quizás nunca se cobre.
//    Solo 'Devuelto' y 'Cancelado' cierran en contra.
//
// 2. La TARIFA viene vacía en los NO ENTREGADOS, pero eso NO significa que no
//    se cobre: Lucero factura el flete recién cuando la mercadería vuelve al
//    depósito, y cobra UNA sola tarifa (la ida; el viaje de vuelta no se
//    cobra). O sea que el costo existe, todavía no está facturado.
//    Por eso, cuando la tarifa viene vacía, NO se pisa el `costo_envio` que ya
//    tiene la fila: se conserva la tarifa estimada que se congeló al despachar.
//    Ponerlo en 0 subestimaría el costo e inflaría la ganancia.
//
// 3. El campo "Motivo" trae el log de auditoría completo ("Usuario admin X
//    realizó cambio de estado..."), inservible para mostrar. El motivo real
//    útil está en "Notas" ("No contesta", "No responde") o al final del
//    Motivo después de "Nota:". Se extrae de ahí.
// ═══════════════════════════════════════════════════════════
import { esImporteCorrupto } from './estadosPaP'


const norm = (s) => String(s ?? '')
  .normalize('NFD').replace(/[\u0300-\u036f]/g, '')
  .toLowerCase().replace(/\s+/g, ' ').trim()

// ¿Este archivo es la exportación de seguimiento de Lucero?
// Se detecta por columnas que ningún otro archivo del sistema tiene juntas.
export function esExportLucero(filas) {
  if (!filas || !filas.length) return false
  const heads = (filas[0] || []).map(norm)
  return heads.includes('codigo') && heads.includes('envioid') &&
         heads.includes('rendido') && heads.includes('fechaultimoestado')
}

// 'FW-2025' → '2025' · '2018' → '2018'
export function refDesdeCodigo(codigo) {
  if (codigo == null) return ''
  const r = String(codigo).replace(/[#\s.\-/]/g, '').trim()
  const m = r.match(/^[A-Za-z]{1,4}0*(\d+)$/)
  if (m) return String(parseInt(m[1], 10))
  return /^\d+$/.test(r) ? String(parseInt(r, 10)) : r
}

// '28/07/2026 00:00' → '2026-07-28' · '31/07/2026 (Lote 419)' → '2026-07-31'
export function fechaLucero(v) {
  if (!v) return null
  if (v instanceof Date && !isNaN(v)) return v.toISOString().slice(0, 10)
  const m = String(v).match(/(\d{1,2})\/(\d{1,2})\/(\d{4})/)
  if (m) return `${m[3]}-${m[2].padStart(2, '0')}-${m[1].padStart(2, '0')}`
  const iso = String(v).match(/^(\d{4})-(\d{2})-(\d{2})/)
  return iso ? iso[0] : null
}

// '31/07/2026 (Lote 419)' → '419'
export function loteDesdeRendicion(v) {
  const m = String(v ?? '').match(/lote\s*#?\s*(\d+)/i)
  return m ? m[1] : null
}

// ─── Sanidad de montos ──────────────────────────────────────
// Lucero manda valores basura igual que PaP: se vio una Multa con
// 2.147.483.647 — el máximo de un entero de 32 bits, o sea un dato sin
// inicializar de su sistema, no una multa. Sumado a la tarifa daba
// 2.147.523.647 y Postgres rechazaba EL LOTE ENTERO con "out of range for
// type integer": no entraba ni un solo envío del archivo.
//
// Se reusa el tope de `estadosPaP` (2.000.000) para que la regla sea UNA sola
// en todo el sistema. `montoSano` distingue dos cosas a propósito:
//   · basura → null, para que quien la reciba decida (la tarifa corrupta se
//     omite y conserva la estimada; la multa corrupta cuenta como 0).
//   · vacío  → null también, que ya era el significado de "no vino el dato".
const montoSano = (v) => {
  const n = num(v)
  if (n == null) return null
  return esImporteCorrupto(n) ? null : n
}

const num = (v) => {
  if (v == null || v === '') return null
  if (typeof v === 'number') return Math.round(v)
  const n = parseInt(String(v).replace(/[^\d-]/g, ''), 10)
  return Number.isFinite(n) ? n : null
}

// ── Estado de Lucero → categoría interna ──
// 'en_proceso' incluye FALLIDO a propósito: es recuperable (ver regla 1).
// OJO: hay OTRA categoriaLucero() en rendicionLucero.js y NO son la misma, a
// propósito. Esta lee el export EN VIVO, donde 'fallido' es un intento fallido
// que Lucero va a reintentar (ver el ciclo de estados arriba), así que devuelve
// 'en_proceso'. La de la rendición lee el archivo de CIERRE, donde 'fallido' ya
// es definitivo y devuelve 'devuelto'. No unificarlas: la protección de
// precedencia vive en procesarExportLucero (un estado no terminal nunca pisa
// uno terminal).
export function categoriaLucero(estado) {
  const e = norm(estado)
  if (e.includes('entregado')) return 'entregado'
  if (e.includes('devuelto') || e.includes('cancelado')) return 'devuelto'
  if (e.includes('borrador')) return 'no_despachado'
  return 'en_proceso'   // cargado, preparando, aceptado, empaquetado, en_camino, FALLIDO
}

// Motivo legible: 'Notas' primero; si no, lo que viene después de "Nota:" en
// el log de auditoría. Nunca el log entero.
export function motivoLegible(motivo, notas) {
  const limpio = (s) => {
    const t = String(s ?? '').trim()
    if (!t || t === 'N/A' || t === 'N/A | N/A') return ''
    return t.replace(/^N\/A\s*\|\s*/, '').trim()
  }
  const n = limpio(notas)
  if (n) return n
  const m = String(motivo ?? '').match(/Nota:\s*(.+)$/i)
  if (m) return m[1].trim()
  const mo = limpio(motivo)
  // Si el motivo es el log de auditoría completo, no sirve para mostrar.
  return /realiz[óo] cambio de estado/i.test(mo) ? '' : mo
}

// ¿El envío está esperando un reintento? (fallido pero recuperable)
export const esReintentable = (estado) => norm(estado).includes('fallido')

// ── Parseo completo ──
// filas = XLSX.utils.sheet_to_json(ws, { header: 1, defval: '' })
export function parsearExportLucero(filas) {
  if (!filas || !filas.length) throw new Error('Archivo vacío')
  const heads = (filas[0] || []).map(norm)
  const col = (nombre) => heads.indexOf(norm(nombre))
  const idx = {
    codigo: col('Codigo'), envioId: col('EnvioID'), estado: col('Estado'),
    fCreado: col('FechaCreado'), fUltimo: col('FechaUltimoEstado'),
    ciudad: col('Ciudad'), zona: col('Zona'), destinatario: col('Destinatario'),
    telefono: col('Telefono'), direccion: col('Direccion'), item: col('Item'),
    cantidad: col('Cantidad'), total: col('Total'), tarifa: col('Tarifa'),
    multa: col('Multa'), motivo: col('Motivo'), transportador: col('Transportador'),
    fRuta: col('FechaAsignacionRuta'), rendido: col('Rendido'),
    fRendicion: col('FechaRendicion'), notas: col('Notas'),
  }
  if (idx.codigo < 0) throw new Error('No se encontró la columna "Codigo"')

  const get = (fila, i) => (i >= 0 ? fila[i] : null)
  const items = []
  for (let i = 1; i < filas.length; i++) {
    const f = filas[i] || []
    const codigo = get(f, idx.codigo)
    if (codigo == null || String(codigo).trim() === '') continue
    const estado = String(get(f, idx.estado) ?? '').trim()
    const rendidoRaw = norm(get(f, idx.rendido))
    items.push({
      codigo: String(codigo).trim(),
      referencia: refDesdeCodigo(codigo),
      envioId: String(get(f, idx.envioId) ?? '').trim(),
      estado,
      categoria: categoriaLucero(estado),
      reintentable: esReintentable(estado),
      fechaCreado: fechaLucero(get(f, idx.fCreado)),
      fechaUltimoEstado: fechaLucero(get(f, idx.fUltimo)),
      fechaRuta: fechaLucero(get(f, idx.fRuta)),
      ciudad: String(get(f, idx.ciudad) ?? '').trim(),
      zona: String(get(f, idx.zona) ?? '').trim(),
      destinatario: String(get(f, idx.destinatario) ?? '').trim(),
      telefono: String(get(f, idx.telefono) ?? '').trim(),
      direccion: String(get(f, idx.direccion) ?? '').trim(),
      producto: String(get(f, idx.item) ?? '').trim(),
      cantidad: num(get(f, idx.cantidad)) || 1,
      total: montoSano(get(f, idx.total)) || 0,
      // null (no 0) cuando no vino: distingue "no me cobraron" de "me cobraron 0".
      // Una tarifa corrupta también cae en null: así el upsert omite la clave
      // y conserva la tarifa estimada que se congeló al despachar.
      tarifa: montoSano(get(f, idx.tarifa)),
      multa: montoSano(get(f, idx.multa)) || 0,
      // Se marca la fila para poder avisarlo en pantalla en vez de que el
      // monto desaparezca en silencio.
      montoCorrupto: [get(f, idx.total), get(f, idx.tarifa), get(f, idx.multa)]
        .some(v => num(v) != null && esImporteCorrupto(num(v))),
      transportador: String(get(f, idx.transportador) ?? '').trim(),
      rendido: rendidoRaw === 'si' || rendidoRaw === 'sí' || rendidoRaw === 'true',
      fechaRendicion: fechaLucero(get(f, idx.fRendicion)),
      lote: loteDesdeRendicion(get(f, idx.fRendicion)),
      motivo: motivoLegible(get(f, idx.motivo), get(f, idx.notas)),
    })
  }
  return items
}

// ── A filas de la tabla `entregas` ──
// Mismo esquema que el importador de PaP, para que todo el resto del sistema
// (reportes, ganancia, tasa de entrega) lo lea sin cambios.
export function exportLuceroAEntregas(items) {
  return (items || []).map(it => ({
    // MISMA clave que usa el placeholder de Despacho y la rendición: así las
    // tres escrituras caen en la misma fila en vez de duplicarse.
    nro_guia_pap: `L-${it.referencia}`,
    n_referencia: it.referencia,
    estado_pap: it.estado,
    categoria: it.categoria,
    motivo: it.motivo || '',
    importe: it.total,
    cobrado: it.categoria === 'entregado' ? it.total : 0,
    // Solo se pisa el flete cuando Lucero YA lo facturó. Si viene vacío, se
    // omite la clave a propósito: el upsert deja intacta la tarifa estimada
    // que se congeló al despachar (el cobro llega después, cuando la
    // mercadería vuelve — ver nota 2 arriba).
    ...(it.tarifa != null ? { costo_envio: it.tarifa + (it.multa || 0) } : {}),
    fecha_ingreso: it.fechaCreado,
    fecha_entrega: it.categoria === 'entregado' ? it.fechaUltimoEstado : null,
    // El export es fuente de TRACKING, no contable. Si Lucero todavía no lo
    // marcó rendido, NO se pisa: ese paquete puede haberse conciliado desde la
    // planilla de rendición, que es la fuente contable. Escribir `false` acá
    // borraba el registro de que ya te habían pagado. Mismo criterio que
    // costo_envio unas líneas arriba: la clave se omite a propósito.
    ...(it.rendido ? { rendido: true, fecha_rendido: it.fechaRendicion } : {}),
    mensajero: it.transportador || '',
    // Igual que en PaP: lo que dice Lucero, para poder cruzar y auditar.
    telefono_courier: it.telefono || '',
    nombre_courier: it.destinatario || '',
    direccion_courier: it.direccion || '',
    ciudad: it.ciudad,
    producto: it.producto,
    transportadora: 'lucero',
    mes: (it.fechaCreado || '').slice(0, 7),
  }))
}

// ── Resumen para mostrar antes de guardar ──
export function resumenExportLucero(items) {
  const r = {
    total: items.length, entregados: 0, devueltos: 0, enProceso: 0,
    reintentables: 0, rendidos: 0, sinRendir: 0,
    montoEntregado: 0, montoEnJuego: 0, fleteFacturado: 0, multas: 0,
    montosCorruptos: 0, codigosCorruptos: [],
    porMotivo: {},
  }
  items.forEach(it => {
    if (it.categoria === 'entregado') { r.entregados++; r.montoEntregado += it.total }
    else if (it.categoria === 'devuelto') r.devueltos++
    else { r.enProceso++; r.montoEnJuego += it.total }
    if (it.reintentable) r.reintentables++
    if (it.rendido) r.rendidos++; else if (it.categoria === 'entregado') r.sinRendir++
    if (it.tarifa != null) r.fleteFacturado += it.tarifa
    r.multas += (it.multa || 0)
    if (it.montoCorrupto) { r.montosCorruptos++; if (r.codigosCorruptos.length < 6) r.codigosCorruptos.push(it.codigo) }
    if (it.motivo) r.porMotivo[it.motivo] = (r.porMotivo[it.motivo] || 0) + 1
  })
  const resueltos = r.entregados + r.devueltos
  r.tasaEntrega = resueltos ? (r.entregados / resueltos) * 100 : null
  // Tarifa promedio de lo entregado (lo que Lucero factura por una entrega ok).
  r.tarifaPromedio = r.entregados ? r.fleteFacturado / r.entregados : null
  // Costo REAL por entrega exitosa: incluye el flete de lo que se devolvió,
  // que también se paga (una tarifa, la ida) aunque no genere ingreso. Como
  // Lucero factura recién cuando la mercadería vuelve, ese flete todavía no
  // aparece en el archivo — se estima con la tarifa promedio para no
  // subestimar el costo. Es el número que compara transportadoras de verdad.
  r.fletePendienteEstimado = r.tarifaPromedio != null ? Math.round(r.tarifaPromedio * r.devueltos) : 0
  r.costoPorEntrega = r.entregados
    ? (r.fleteFacturado + r.fletePendienteEstimado) / r.entregados
    : null
  return r
}
