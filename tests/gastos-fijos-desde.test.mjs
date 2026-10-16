// 16-10: gastos fijos con mes de inicio ("desde AAAA-MM").
import { test } from 'node:test'
import assert from 'node:assert/strict'
import { parsearGastosFijos, armarGastosAutomaticos } from '../src/lib/gastosAutomaticos.js'

const TEXTO = 'Shopify: 25 usd desde 2026-10\nReleasit: 10 usd desde 2026-10\nHiggsfield Plus: 290000 desde 2026-10\nSupabase: 100000'
test('lee el mes de inicio y deja igual las líneas viejas', () => {
  const f = parsearGastosFijos(TEXTO)
  assert.deepEqual(f.map(x => [x.concepto, x.monto, x.usd, x.desde]), [
    ['Shopify', 25, true, '2026-10'], ['Releasit', 10, true, '2026-10'], ['Higgsfield Plus', 290000, false, '2026-10'], ['Supabase', 100000, false, null]])
})
test('septiembre no descuenta los de octubre; octubre sí', () => {
  const tasas = new Map()
  const sep = armarGastosAutomaticos({ gastosFijosTexto: TEXTO, usdPyg: 6000, tasas, fechaTasaFijos: '2026-09-30' })
  assert.deepEqual(sep.fijos.map(f => f.concepto), ['Supabase'])
  const oct = armarGastosAutomaticos({ gastosFijosTexto: TEXTO, usdPyg: 6000, tasas, fechaTasaFijos: '2026-10-31' })
  assert.deepEqual(oct.fijos.map(f => [f.concepto, f.gs]), [['Shopify', 150000], ['Releasit', 60000], ['Higgsfield Plus', 290000], ['Supabase', 100000]])
})
