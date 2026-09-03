// src/lib/motivosDevolucion.js
// ═══════════════════════════════════════════════════════════
// MOTIVO DE CADA DEVOLUCIÓN — corrección C3 (diagnóstico 03-09-2026)
//
// Hasta ahora `ventas.notas` guardaba el CI/RUC del cliente, no por qué volvió
// el pedido. Sin ese dato era imposible separar el rechazo real en la puerta
// (problema de producto o precio) del fin de custodia (problema logístico:
// el cliente nunca retiró el paquete) — y son dos causas que se atacan
// distinto.
//
// La fuente real ya existe y no hay que inventarla: `entregas.motivo` trae el
// texto que manda PaP en su propio reporte (ver estadosPaP.js). Esta función
// lo traduce a la lista cerrada que el dueño va a ver y elegir — la lista es
// EDITABLE (ver MOTIVOS_DEVOLUCION más abajo), nunca bloqueante: si el texto
// de PaP no matchea nada conocido, cae en 'otro' y se puede corregir a mano.
// ═══════════════════════════════════════════════════════════

// Lista cerrada que ve el usuario. El value es lo que se guarda en
// ventas.motivo_devolucion; el label es lo que se muestra.
export const MOTIVOS_DEVOLUCION = [
  { value: 'rechazo_puerta', label: 'Rechazó en la puerta' },
  { value: 'fin_custodia', label: 'Fin de custodia (no retiró)' },
  { value: 'direccion_mala', label: 'Dirección errónea / inubicable' },
  { value: 'fuera_cobertura', label: 'Fuera de cobertura' },
  { value: 'en_proceso', label: 'Devolución en proceso (todavía no cerró)' },
  { value: 'otro', label: 'Otro' },
]

const LABEL_POR_VALUE = Object.fromEntries(MOTIVOS_DEVOLUCION.map(m => [m.value, m.label]))
export function labelMotivoDevolucion(value) {
  return LABEL_POR_VALUE[value] || value || '—'
}

// Traduce el texto crudo de `entregas.motivo` (PaP) a un value de la lista
// cerrada. Reusa el mismo vocabulario que categorizarPaP() en estadosPaP.js,
// pero un nivel más fino: ahí solo importa si es 'devuelto' o no; acá importa
// POR QUÉ.
export function motivoDesdeTextoPaP(motivoCrudo) {
  const m = (motivoCrudo || '').toLowerCase()
  if (!m) return null
  if (m.includes('fin de custodia')) return 'fin_custodia'
  if (m.includes('en proceso')) return 'en_proceso'
  if (m.includes('rechaz') || m.includes('no desea') || m.includes('rehus')) return 'rechazo_puerta'
  if (m.includes('inubicable') || m.includes('problema de direccion')) return 'direccion_mala'
  if (m.includes('fuera de cobertura')) return 'fuera_cobertura'
  if (m.includes('cancelad') || m.includes('no ingreso')) return 'otro'
  return 'otro'
}
