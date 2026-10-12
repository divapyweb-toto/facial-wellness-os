// Preferencia temporal por Lucero (lluvia 12-10-2026): solo los días listados.
import { test } from 'node:test'
import assert from 'node:assert/strict'
import { preferirLucero, hoyParaguay, DIAS_PREFERIR_LUCERO } from '../src/lib/transportadoras.js'

test('solo el 12-10-2026, en hora de Paraguay', () => {
  assert.deepEqual(DIAS_PREFERIR_LUCERO, ['2026-10-12'])
  assert.equal(preferirLucero('2026-10-12'), true)
  assert.equal(preferirLucero('2026-10-13'), false)
  assert.equal(preferirLucero('2026-10-11'), false)
  // 13-10 a las 02:00 UTC todavía es 12-10 en Paraguay (UTC−3).
  assert.equal(hoyParaguay(new Date('2026-10-13T02:00:00Z')), '2026-10-12')
  assert.equal(hoyParaguay(new Date('2026-10-13T03:30:00Z')), '2026-10-13')
})
