// 27-10: el reporte de PaP no puede volver "en proceso" un pedido ya cerrado (caso VT-1028 / VT-1064). Datos inventados.
import assert from 'node:assert/strict'
import { conservarFinales } from '../src/lib/estadosPaP.js'

const previo = new Map([
  ['111', { nro_guia_pap: '111', categoria: 'entregado', estado_pap: 'Entregado', cobrado: 129000, fecha_entrega: '2026-10-26', dias_entrega: 5 }],
  ['222', { nro_guia_pap: '222', categoria: 'devuelto', estado_pap: 'Devolución', cobrado: 0, fecha_entrega: null, dias_entrega: null }],
])
const regs = [
  { nro_guia_pap: '111', categoria: 'en_proceso', estado_pap: 'En Oficina', cobrado: 0, fecha_entrega: null },      // foto vieja → se conserva entregado
  { nro_guia_pap: '222', categoria: 'entregado', estado_pap: 'Entregado', cobrado: 99000, fecha_entrega: '2026-10-27' }, // final → final: pasa
  { nro_guia_pap: '333', categoria: 'en_proceso', estado_pap: 'Asignado a ruta', cobrado: 0 },                          // sin previo: pasa
]
assert.equal(conservarFinales(regs, previo), 1)
assert.deepEqual([regs[0].categoria, regs[0].estado_pap, regs[0].cobrado, regs[0].fecha_entrega, regs[0].dias_entrega], ['entregado', 'Entregado', 129000, '2026-10-26', 5])
assert.equal(regs[1].categoria, 'entregado'); assert.equal(regs[1].cobrado, 99000)
assert.equal(regs[2].categoria, 'en_proceso')
console.log('✓ conservar finales: 3 casos OK')
