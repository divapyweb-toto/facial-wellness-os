// src/lib/fechas.js
// ═══════════════════════════════════════════════════════════
// Helpers de fecha compartidos. Antes `etiquetaMes` estaba duplicado en cada
// página que necesitaba un selector de mes — se centraliza acá para que un
// cambio de formato no requiera tocar cinco archivos.
// ═══════════════════════════════════════════════════════════

import { NOMBRES_MESES } from './periodos'

// 'YYYY-MM' → 'Julio 2026'
export function etiquetaMes(ym) {
  if (!ym) return ''
  const [y, m] = ym.split('-')
  return `${NOMBRES_MESES[parseInt(m, 10) - 1] || ''} ${y}`
}

// Los últimos `n` meses en formato 'YYYY-MM', empezando por el actual y yendo
// hacia atrás. Sirve para dar un selector de mes siempre disponible aunque
// todavía no haya datos cargados en ese mes (a diferencia de listar solo los
// meses que ya tienen registros).
export function mesesRecientes(n = 12, referencia = new Date()) {
  const out = []
  const d = new Date(referencia.getFullYear(), referencia.getMonth(), 1)
  for (let i = 0; i < n; i++) {
    out.push(`${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, '0')}`)
    d.setMonth(d.getMonth() - 1)
  }
  return out
}
