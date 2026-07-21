// src/lib/conciliacionRendicion.js
// ═══════════════════════════════════════════════════════════
// CONCILIACIÓN DE RENDICIÓN (el reporte que PaP manda cada martes)
//
// Cruza el archivo de rendición del martes con las entregas del sistema para:
//   1. Marcar como RENDIDO las guías que PaP pagó (por nro de guía o referencia).
//   2. Conciliar: cuánto te rindió PaP en efectivo vs lo que esperabas.
//   3. Detectar si PaP te rindió DE MENOS (plata faltante) — tu plata.
//
// El archivo separa:
//   • Efectivo → PaP cobró y te rinde esa plata.
//   • Transferencia → el cliente pagó directo (prepago), PaP no cobró nada.
// ═══════════════════════════════════════════════════════════

// Normaliza una referencia/guía para cruzar (igual que el resto del sistema).
export function normalizarRef(ref) {
  if (!ref) return ''
  let r = String(ref).replace(/[#\s.\-/]/g, '').trim()
  if (/^\d+$/.test(r)) r = String(parseInt(r, 10))
  return r
}

// ¿La forma de pago es efectivo (PaP rinde) o transferencia (cobró el cliente)?
function esEfectivo(forma) {
  return /efectivo/i.test(String(forma || ''))
}
function esTransferencia(forma) {
  return /transfer/i.test(String(forma || ''))
}

// Parsea las filas crudas del Excel (ya convertidas a objetos por SheetJS).
// OJO: los headers del archivo de PaP vienen CON espacios (" Importe ", " Cobrado "),
// así que normalizamos cada fila quitando espacios de las claves antes de leer.
export function parsearFilasRendicion(rows) {
  const out = []
  for (const rRaw of (rows || [])) {
    // Normalizar claves: quitar espacios alrededor (" Cobrado " → "Cobrado")
    const r = {}
    for (const k of Object.keys(rRaw)) r[String(k).trim()] = rRaw[k]

    const nroGuia = r.NroGuia ?? r.nroGuia ?? r['Nro Guia'] ?? ''
    if (!nroGuia) continue
    const cobradoRaw = r.Cobrado
    const cobrado = (typeof cobradoRaw === 'number') ? cobradoRaw
      : (cobradoRaw == null || String(cobradoRaw).trim() === '-' || String(cobradoRaw).trim() === '') ? null
      : Number(String(cobradoRaw).replace(/[^\d.-]/g, '')) || 0
    out.push({
      nroGuia: String(nroGuia).trim(),
      nroGuiaRef: r.NroGuiaRef != null ? String(r.NroGuiaRef).trim() : '',
      fecha: r.FechaIng || r.Fecha || null,
      nombre: r.Nombre || '',
      estado: r.Estado || '',
      importe: Number(r.Importe) || 0,
      cobrado,                         // null = no cobró efectivo (transferencia)
      formaPago: r.FormaPago || r['Forma Pago'] || '',
      efectivo: esEfectivo(r.FormaPago),
      transferencia: esTransferencia(r.FormaPago),
    })
  }
  return out
}

// Combina las filas de VARIOS archivos de rendición en una sola lista,
// deduplicando por nro de guía (si la misma guía aparece en dos archivos,
// se queda con una sola). Útil para cargar varios martes de una vez.
export function combinarArchivosRendicion(listasFilas) {
  const vistas = new Set()
  const combinado = []
  for (const filas of (listasFilas || [])) {
    for (const f of (filas || [])) {
      const k = String(f.nroGuia).trim()
      if (!k || vistas.has(k)) continue
      vistas.add(k)
      combinado.push(f)
    }
  }
  return combinado
}

// Concilia las filas del archivo contra las entregas del sistema.
//   filas: salida de parsearFilasRendicion
//   entregas: [{ nro_guia_pap, n_referencia, nro_guia_ref, importe, rendido }]
// Devuelve el resumen + qué marcar como rendido + discrepancias.
export function conciliarRendicion(filas, entregas) {
  // Índices para cruzar rápido: por nro de guía PaP y por referencia
  const porGuia = {}
  const porRef = {}
  for (const e of (entregas || [])) {
    if (e.nro_guia_pap) porGuia[normalizarRef(e.nro_guia_pap)] = e
    const ref = normalizarRef(e.n_referencia) || normalizarRef(e.nro_guia_ref)
    if (ref) porRef[ref] = e
  }

  const marcarRendido = []        // nro_guia_pap a marcar rendido
  const discrepancias = []        // { nroGuia, ref, esperado, cobrado, motivo }
  const noEncontradas = []        // guías del archivo que no están en el sistema
  let totalEfectivo = 0           // plata que PaP te rinde (efectivo)
  let totalTransferencia = 0      // plata cobrada por el cliente (prepago)
  let countEfectivo = 0, countTransf = 0

  for (const f of filas) {
    // Buscar la entrega: primero por nro de guía PaP, luego por referencia
    const e = porGuia[normalizarRef(f.nroGuia)] || (f.nroGuiaRef ? porRef[normalizarRef(f.nroGuiaRef)] : null)

    if (f.efectivo) {
      countEfectivo++
      totalEfectivo += (f.cobrado || 0)
    } else if (f.transferencia) {
      countTransf++
      totalTransferencia += f.importe
    }

    if (!e) {
      noEncontradas.push({ nroGuia: f.nroGuia, ref: f.nroGuiaRef, nombre: f.nombre, importe: f.importe, formaPago: f.formaPago })
      continue
    }

    // Marcar rendido (tanto efectivo como transferencia: la guía ya cerró su ciclo)
    if (e.nro_guia_pap) marcarRendido.push({ nro_guia_pap: e.nro_guia_pap, formaPago: f.formaPago, cobrado: f.cobrado })

    // Conciliación: para efectivo, comparar lo que PaP cobró vs lo que esperaba el sistema.
    // Solo marcamos faltante REAL: el sistema tiene que tener un importe válido y la
    // diferencia tiene que ser significativa (no redondeo). Si el sistema no tiene
    // importe cargado, no inventamos un faltante.
    if (f.efectivo && f.cobrado != null) {
      const esperado = Number(e.importe) || 0
      const cobrado = f.cobrado || 0
      const falta = esperado - cobrado
      if (esperado > 0 && falta > 1000) {
        discrepancias.push({
          nroGuia: f.nroGuia, ref: f.nroGuiaRef, nombre: f.nombre,
          esperado, cobrado, falta, motivo: 'PaP cobró menos de lo esperado',
        })
      }
    }
  }

  const totalFaltante = discrepancias.reduce((s, d) => s + (d.falta || 0), 0)

  return {
    marcarRendido,
    discrepancias,
    noEncontradas,
    totalEfectivo,          // debería entrar a tu banco hoy
    totalTransferencia,     // ya lo cobraste vos (prepago)
    totalFaltante,          // plata que PaP te rindió de menos
    countEfectivo,
    countTransf,
    totalGuias: filas.length,
  }
}
