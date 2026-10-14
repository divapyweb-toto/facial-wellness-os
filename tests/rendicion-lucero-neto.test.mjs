// 14-10: Rendición de Lucero — neto depositado, días de cobro y "te debe" neto (datos inventados).
import { test } from 'node:test'
import assert from 'node:assert/strict'
import { exportLuceroAEntregas, diasEntre } from '../src/lib/exportLucero.js'
import { sanearEntrega } from '../src/lib/estadosPaP.js'

const base = { referencia: 'VT-9001', estado: 'Entregado', categoria: 'entregado', total: 158000, tarifa: 30000, multa: 0,
  fechaCreado: '2026-10-11', fechaUltimoEstado: '2026-10-13', rendido: true, fechaRendicion: '2026-10-14', envioId: '1' }

test('rendido: guarda neto (total − tarifa − multa) y días entrega→depósito', () => {
  const [f] = exportLuceroAEntregas([base])
  assert.equal(f.neto_depositado, 128000)
  assert.equal(f.dias_rendicion, 1)
  assert.equal(f.costo_envio, 30000)
})
test('prepago (total vacío): neto negativo, como lo descuenta Lucero', () => {
  const [f] = exportLuceroAEntregas([{ ...base, total: 0 }])
  assert.equal(f.neto_depositado, -30000)
})
test('sin rendir o sin tarifa: no se escribe neto (no se pisa lo que haya)', () => {
  assert.equal('neto_depositado' in exportLuceroAEntregas([{ ...base, rendido: false }])[0], false)
  assert.equal('neto_depositado' in exportLuceroAEntregas([{ ...base, tarifa: null }])[0], false)
})
test('diasEntre por fecha calendario', () => {
  assert.equal(diasEntre('2026-10-10', '2026-10-12'), 2)
  assert.equal(diasEntre('2026-10-13T21:00:00Z', '2026-10-14'), 1)
  assert.equal(diasEntre(null, '2026-10-14'), null)
  assert.equal(diasEntre('2026-10-15', '2026-10-14'), null)
})
test('sanearEntrega: Lucero sin neto guardado → bruto − tarifa; PaP sigue en bruto; neto guardado manda', () => {
  assert.equal(sanearEntrega({ transportadora: 'lucero', categoria: 'entregado', importe: 158000, costo_envio: 30000 }).depositoReal, 128000)
  assert.equal(sanearEntrega({ transportadora: 'lucero', categoria: 'entregado', importe: 158000, costo_envio: null }).depositoReal, 158000)
  assert.equal(sanearEntrega({ transportadora: 'pap', estado_pap: 'Entregado', importe: 112000, costo_envio: 29000 }).depositoReal, 112000)
  assert.equal(sanearEntrega({ transportadora: 'lucero', categoria: 'entregado', importe: 158000, costo_envio: 30000, neto_depositado: 120000 }).depositoReal, 120000)
})
