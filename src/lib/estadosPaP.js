// src/lib/estadosPaP.js
// ═══════════════════════════════════════════════════════════
// FUENTE ÚNICA de la interpretación de los datos de Punto a Punto.
//
// Antes esta lógica estaba COPIADA en 5 archivos (Entregas, Rendición, Despacho,
// Campañas e Inteligencia). Cada copia tenía pequeñas diferencias, así que
// arreglar un bug en una dejaba las otras cuatro mal — fue exactamente lo que
// pasó con los importes corruptos de los borradores: se arregló la importación
// y Rendición siguió mostrando 2.948 millones porque recalcula con su copia.
//
// Si cambia una regla, se cambia ACÁ y vale para todo el sistema.
// ═══════════════════════════════════════════════════════════

// Tope de sanidad para el Importe que manda PaP.
// El pedido más caro razonable es Bebird Pro ×3 (~1.100.000). PaP manda los
// borradores con el Importe corrupto (se vieron valores de 900+ millones) y un
// solo registro basura envenena todas las sumas del sistema.
export const IMPORTE_MAX_RAZONABLE = 2000000

// Devuelve el importe usable: 0 si el valor es evidentemente basura.
export function importeSano(valor) {
  const n = typeof valor === 'number' ? valor : (parseInt(valor, 10) || 0)
  if (!Number.isFinite(n) || n < 0) return 0
  return n > IMPORTE_MAX_RAZONABLE ? 0 : n
}

export const esImporteCorrupto = (valor) => {
  const n = typeof valor === 'number' ? valor : (parseInt(valor, 10) || 0)
  return Number.isFinite(n) && n > IMPORTE_MAX_RAZONABLE
}

// Motivos que implican devolución aunque el estado sea intermedio (Custodio, etc.)
const MOTIVOS_DEVOLUCION = [
  'rechaz', 'inubicable', 'fuera de cobertura', 'fin de custodia',
  'problema de direccion', 'no desea', 'cancelad', 'no ingreso', 'rehus',
]

// Categoriza un registro de PaP.
//   'entregado'     → cobrado, cerrado a favor
//   'devuelto'      → cerrado en contra (el flete se paga igual)
//   'no_despachado' → NUNCA salió: borrador de PaP o no ingresó al sistema.
//                     No está en tránsito, no hay flete comprometido y no debe
//                     entrar en ninguna proyección de cierre.
//   'en_proceso'    → todavía volando
export function categorizarPaP(estado, motivo) {
  const e = (estado || '').toLowerCase()
  const m = (motivo || '').toLowerCase()
  if (e.includes('borrador') || e.includes('no ingreso')) return 'no_despachado'
  if (e.includes('entregado')) return 'entregado'
  if (e.includes('devuelto')) return 'devuelto'
  if (MOTIVOS_DEVOLUCION.some(k => m.includes(k))) return 'devuelto'
  if (e.includes('devolucion') || m.includes('devolucion')) return 'devuelto'
  return 'en_proceso'
}

// Normaliza un registro de `entregas` leído de la base: recalcula la categoría
// y sanea el importe. Usar SIEMPRE esto al leer, porque las filas viejas fueron
// guardadas antes de estas reglas y traen la categoría y el importe mal.
export function sanearEntrega(e) {
  const categoria = categorizarPaP(e?.estado_pap, e?.motivo)
  const importe = importeSano(e?.importe)
  return {
    ...e,
    categoria,
    importe,
    // Solo lo entregado se considera cobrado.
    cobrado: categoria === 'entregado' ? importe : 0,
  }
}
