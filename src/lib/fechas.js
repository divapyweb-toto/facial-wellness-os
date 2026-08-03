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

// Rango del MES ANTERIOR, recortado al mismo día-del-mes que hoy — para
// comparar "lo que va del mes" contra un período igual de largo, no contra el
// mes anterior completo. Sin esto, el día 3 de un mes se compara contra los
// 31 días del mes pasado y cualquier alerta de "cayeron las ventas" es un
// artefacto del calendario, no una señal real del negocio.
//
// Se recalcula solo (usa `hoy`), así que "compara 3-ago con 3-jul" pasa a ser
// automático mes a mes, sin fecha dura ni configuración manual.
//
// Si el mes anterior tiene menos días que hoy (ej. hoy 31-mar comparado con
// febrero), se recorta al último día real de ese mes.
export function rangoMesAnteriorEquivalente(hoy = new Date()) {
  const anioAnt = hoy.getMonth() === 0 ? hoy.getFullYear() - 1 : hoy.getFullYear()
  const mesAnt = hoy.getMonth() === 0 ? 11 : hoy.getMonth() - 1
  const ultimoDiaMesAnt = new Date(anioAnt, mesAnt + 1, 0).getDate()
  const diaEquivalente = Math.min(hoy.getDate(), ultimoDiaMesAnt)
  const inicio = new Date(anioAnt, mesAnt, 1).toISOString().slice(0, 10)
  const fin = new Date(anioAnt, mesAnt, diaEquivalente).toISOString().slice(0, 10)
  return { inicio, fin, dias: diaEquivalente }
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
