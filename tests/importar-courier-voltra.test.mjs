// Solo los pedidos VT- de Voltra viajan a importar-courier (datos inventados).
import assert from 'node:assert/strict'
import { armarPayloadCourier } from '../src/lib/importarCourierWA.js'

const lucero = armarPayloadCourier('lucero', [
  { codigo: 'VT-1003', estado: 'Entregado', telefono: '0981000001', rendido: true },
  { codigo: 'FW-2071', estado: 'Entregado', telefono: '0981000002' },
  { codigo: '', estado: 'Entregado', telefono: '0981000003' },
  { codigo: 'VT-1003', estado: 'Entregado', telefono: '0981000001', rendido: true },
])
assert.deepEqual(lucero.filas.map(f => f.referencia), ['VT-1003'])
assert.equal(lucero.filas[0].extra.rendido, true)

const pap = armarPayloadCourier('pap', [
  { n_referencia: 'VT-1004', estado_pap: 'Entregado', rendido: false },
  { n_referencia: '2071', estado_pap: 'Entregado' },
])
assert.deepEqual(pap.filas.map(f => f.referencia), ['VT-1004'])
console.log('✓ a Voltra OS solo van los pedidos VT- (FW y filas sin referencia quedan afuera)')
