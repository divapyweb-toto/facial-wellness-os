// src/lib/periodos.js
// ═══════════════════════════════════════════════════════════
// PERÍODOS DE REPORTE: diario, semanal, mensual, anual.
//
// Cada período devuelve su rango [inicio, fin] y el rango del período ANTERIOR
// comparable (ayer, semana pasada, mes pasado, año pasado). Todo en fechas
// YYYY-MM-DD, que es como se guardan en la BD.
// ═══════════════════════════════════════════════════════════

const pad = (n) => String(n).padStart(2, '0')
const iso = (d) => `${d.getFullYear()}-${pad(d.getMonth() + 1)}-${pad(d.getDate())}`

const meses = ['Enero', 'Febrero', 'Marzo', 'Abril', 'Mayo', 'Junio', 'Julio', 'Agosto', 'Septiembre', 'Octubre', 'Noviembre', 'Diciembre']

// Lunes de la semana que contiene a `d` (la semana arranca el lunes)
function lunesDe(d) {
  const x = new Date(d)
  const dia = (x.getDay() + 6) % 7 // 0 = lunes
  x.setDate(x.getDate() - dia)
  x.setHours(0, 0, 0, 0)
  return x
}

// Devuelve { tipo, inicio, fin, inicioPrev, finPrev, etiqueta, etiquetaPrev, granularidad }
// referencia: fecha ancla (YYYY-MM-DD). Por defecto hoy.
export function calcularPeriodo(tipo, referencia) {
  const ref = referencia ? new Date(referencia + 'T00:00:00') : new Date()
  ref.setHours(0, 0, 0, 0)

  if (tipo === 'diario') {
    const ayer = new Date(ref); ayer.setDate(ayer.getDate() - 1)
    return {
      tipo, granularidad: 'hora',
      inicio: iso(ref), fin: iso(ref),
      inicioPrev: iso(ayer), finPrev: iso(ayer),
      etiqueta: `${ref.getDate()} de ${meses[ref.getMonth()]} ${ref.getFullYear()}`,
      etiquetaPrev: `${ayer.getDate()} de ${meses[ayer.getMonth()]}`,
    }
  }

  if (tipo === 'semanal') {
    const lun = lunesDe(ref)
    const dom = new Date(lun); dom.setDate(dom.getDate() + 6)
    const lunPrev = new Date(lun); lunPrev.setDate(lunPrev.getDate() - 7)
    const domPrev = new Date(lunPrev); domPrev.setDate(domPrev.getDate() + 6)
    return {
      tipo, granularidad: 'dia',
      inicio: iso(lun), fin: iso(dom),
      inicioPrev: iso(lunPrev), finPrev: iso(domPrev),
      etiqueta: `Semana del ${lun.getDate()}/${pad(lun.getMonth() + 1)} al ${dom.getDate()}/${pad(dom.getMonth() + 1)}`,
      etiquetaPrev: `Semana anterior`,
    }
  }

  if (tipo === 'anual') {
    const y = ref.getFullYear()
    return {
      tipo, granularidad: 'mes',
      inicio: `${y}-01-01`, fin: `${y}-12-31`,
      inicioPrev: `${y - 1}-01-01`, finPrev: `${y - 1}-12-31`,
      etiqueta: `Año ${y}`,
      etiquetaPrev: `Año ${y - 1}`,
    }
  }

  // mensual (default)
  const y = ref.getFullYear(), m = ref.getMonth()
  const inicio = new Date(y, m, 1)
  const fin = new Date(y, m + 1, 0)
  const iniPrev = new Date(y, m - 1, 1)
  const finPrev = new Date(y, m, 0)
  return {
    tipo, granularidad: 'dia',
    inicio: iso(inicio), fin: iso(fin),
    inicioPrev: iso(iniPrev), finPrev: iso(finPrev),
    etiqueta: `${meses[m]} ${y}`,
    etiquetaPrev: `${meses[iniPrev.getMonth()]} ${iniPrev.getFullYear()}`,
  }
}

// Agrupa ventas en "cubos" según la granularidad del período, para la serie
// temporal (día por día, mes por mes, etc.). Devuelve [{ clave, label, ...acumuladores }]
export function agruparSerie(ventas, periodo) {
  const g = periodo.granularidad
  const cubos = new Map()

  const claveDe = (fecha) => {
    const f = String(fecha || '').slice(0, 10)
    if (!f) return null
    if (g === 'mes') return f.slice(0, 7)        // YYYY-MM
    return f                                       // YYYY-MM-DD (día)
  }
  const labelDe = (clave) => {
    if (g === 'mes') {
      const [, mm] = clave.split('-')
      return meses[parseInt(mm, 10) - 1]?.slice(0, 3) || clave
    }
    const [, mm, dd] = clave.split('-')
    return `${dd}/${mm}`
  }

  for (const v of (ventas || [])) {
    const clave = claveDe(v.fecha)
    if (!clave) continue
    if (!cubos.has(clave)) cubos.set(clave, { clave, label: labelDe(clave), pedidos: 0, entregados: 0, devueltos: 0, ventasBrutas: 0, ingresoEntregado: 0 })
    const c = cubos.get(clave)
    c.pedidos++
    c.ventasBrutas += v.total || 0
    if (v.estado === 'entregado') { c.entregados++; c.ingresoEntregado += v.total || 0 }
    if (v.estado === 'devuelto') c.devueltos++
  }

  return [...cubos.values()].sort((a, b) => a.clave.localeCompare(b.clave))
}

export { meses as NOMBRES_MESES }
