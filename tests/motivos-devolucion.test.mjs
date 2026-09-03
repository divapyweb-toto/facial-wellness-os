// tests/motivos-devolucion.test.mjs
// ═══════════════════════════════════════════════════════════
// Corrección C3 (diagnóstico 03-09-2026): mapeo de motivo crudo de PaP a la
// lista cerrada. Los 5 casos con más volumen son los reales medidos en
// producción el 03-09 (100 fin de custodia, 51 en proceso, 35 rechazado no
// desea, 26 inubicable, 13 fuera de cobertura sobre 241 entregas devueltas).
//
// Correr:  node --import ./tests/registrar.mjs tests/motivos-devolucion.test.mjs
// ═══════════════════════════════════════════════════════════
import { motivoDesdeTextoPaP, labelMotivoDevolucion, MOTIVOS_DEVOLUCION } from '../src/lib/motivosDevolucion.js'

let fallas = 0
const ok = (c, m) => { console.log(`${c ? '✓' : '✗'} ${m}`); if (!c) fallas++ }

console.log('── motivoDesdeTextoPaP: los 5 textos reales más frecuentes ──')
ok(motivoDesdeTextoPaP('Devuelto por fin de custodia') === 'fin_custodia', 'fin de custodia (100 casos reales)')
ok(motivoDesdeTextoPaP('Devolucion en proceso') === 'en_proceso', 'en proceso (51 casos reales)')
ok(motivoDesdeTextoPaP('Rechazado no desea') === 'rechazo_puerta', 'rechazado no desea (35 casos reales)')
ok(motivoDesdeTextoPaP('Inubicable') === 'direccion_mala', 'inubicable (26 casos reales)')
ok(motivoDesdeTextoPaP('Fuera de cobertura') === 'fuera_cobertura', 'fuera de cobertura (13 casos reales)')

console.log('── casos borde ──')
ok(motivoDesdeTextoPaP('') === null, 'texto vacío da null, no "otro" — para no inventar un motivo que no vino')
ok(motivoDesdeTextoPaP(null) === null, 'null da null')
ok(motivoDesdeTextoPaP('Cancelado por el cliente') === 'otro', 'texto no mapeado cae en "otro", nunca se pierde')
ok(motivoDesdeTextoPaP('RECHAZADO NO DESEA') === 'rechazo_puerta', 'no distingue mayúsculas/minúsculas')

console.log('── labelMotivoDevolucion ──')
ok(labelMotivoDevolucion('fin_custodia') === 'Fin de custodia (no retiró)', 'traduce a texto legible')
ok(labelMotivoDevolucion('valor_inexistente') === 'valor_inexistente', 'value desconocido se muestra tal cual, no rompe')
ok(labelMotivoDevolucion(null) === '—', 'null se muestra como guion')
ok(MOTIVOS_DEVOLUCION.length === 6, 'la lista cerrada tiene las 6 opciones esperadas')

console.log()
console.log(fallas === 0 ? `✓ Todo OK (${MOTIVOS_DEVOLUCION.length} motivos)` : `✗ ${fallas} fallas`)
process.exit(fallas === 0 ? 0 : 1)
