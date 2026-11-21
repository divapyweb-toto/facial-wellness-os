// 21-11: devoluciones por doble cobro (Rendición). Prueba la lógica pura de src/pages/rendicion/logicaDevoluciones.js
// (separar pendientes/devueltas, total, fila del upsert, deshacer, error de vista faltante) y que la tarjeta esté
// en RendicionPage. Datos inventados (pedidos DEMO, sin clientes reales).
import assert from 'node:assert/strict'
import { readFileSync } from 'node:fs'
import {
  separarDevoluciones, totalDevolver, filaMarcarDevuelta, cambioDeshacer, esFaltaVista, nombreCourier,
} from '../src/pages/rendicion/logicaDevoluciones.js'

let n = 0, fallas = 0
const caso = (nombre, fn) => {
  n++
  try { fn(); console.log('  ok  ', nombre) } catch (e) { fallas++; console.error('  FALLA', nombre, '\n', e.message) }
}

const filas = [
  { ref: 'VT-9003', pedido: '#9003', courier: 'lucero', fecha_entrega: '2026-11-10', rendido: true, cobrado: 150000, saldo: null, monto_devolver: 150000, devuelta: false, devuelto_en: null, nota: null },
  { ref: 'VT-9001', pedido: '#9001', courier: 'pap', fecha_entrega: '2026-11-02', rendido: false, cobrado: 100000, saldo: 40000, monto_devolver: 60000, devuelta: false, devuelto_en: null, nota: null },
  { ref: 'VT-9002', pedido: '#9002', courier: 'lucero', fecha_entrega: '2026-11-05', rendido: true, cobrado: 120000, saldo: null, monto_devolver: 120000, devuelta: true, devuelto_en: '2026-11-15T13:00:00Z', nota: 'DEMO' },
  { ref: 'VT-9004', pedido: '#9004', courier: 'lucero', fecha_entrega: '2026-11-12', rendido: true, cobrado: 90000, saldo: null, monto_devolver: 90000, devuelta: true, devuelto_en: '2026-11-18T13:00:00Z', nota: null },
  // Defensa: monto 0 nunca es pendiente (la vista ya lo excluye).
  { ref: 'VT-9005', pedido: '#9005', courier: 'pap', fecha_entrega: '2026-11-01', rendido: false, cobrado: 30000, saldo: 30000, monto_devolver: 0, devuelta: false, devuelto_en: null, nota: null },
]

caso('separa pendientes y devueltas; pendientes de la entrega más vieja a la más nueva', () => {
  const { pendientes, devueltas } = separarDevoluciones(filas)
  assert.deepEqual(pendientes.map(f => f.ref), ['VT-9001', 'VT-9003'])
  assert.deepEqual(devueltas.map(f => f.ref), ['VT-9004', 'VT-9002']) // última devuelta arriba
})

caso('total pendiente = suma de monto_devolver (pago parcial ya descontado)', () => {
  const { pendientes, devueltas } = separarDevoluciones(filas)
  assert.equal(totalDevolver(pendientes), 210000)
  assert.equal(totalDevolver(devueltas), 210000)
  assert.equal(totalDevolver([]), 0)
  assert.equal(totalDevolver(null), 0)
})

caso('sin filas o null no rompe', () => {
  assert.deepEqual(separarDevoluciones(null), { pendientes: [], devueltas: [] })
  assert.deepEqual(separarDevoluciones([]), { pendientes: [], devueltas: [] })
})

caso('marcar devuelta: monto = monto_devolver, devuelto_en = ahora, nota vacía = null', () => {
  const ahora = new Date('2026-11-21T15:00:00Z')
  const f = filaMarcarDevuelta(filas[1], '   ', ahora, 'demo@ejemplo.test')
  assert.deepEqual(f, {
    ref: 'VT-9001', monto: 60000, devuelto_en: '2026-11-21T15:00:00.000Z', nota: null,
    actualizado_en: '2026-11-21T15:00:00.000Z', actualizado_por: 'demo@ejemplo.test',
  })
  assert.equal(filaMarcarDevuelta(filas[0], ' transferencia DEMO ', ahora).nota, 'transferencia DEMO')
  assert.equal(filaMarcarDevuelta({ ref: 'VT-9', monto_devolver: -5 }, '', ahora).monto, 0) // check monto >= 0
})

caso('deshacer: devuelto_en vuelve a null', () => {
  const c = cambioDeshacer(new Date('2026-11-21T15:00:00Z'))
  assert.equal(c.devuelto_en, null)
  assert.equal(c.actualizado_en, '2026-11-21T15:00:00.000Z')
})

caso('vista faltante (migración sin aplicar) se reconoce; otros errores no', () => {
  assert.equal(esFaltaVista({ code: 'PGRST205', message: "Could not find the table 'public.devoluciones_doble_cobro' in the schema cache" }), true)
  assert.equal(esFaltaVista({ code: '42P01', message: 'relation "public.devoluciones_doble_cobro" does not exist' }), true)
  assert.equal(esFaltaVista({ message: 'relation "public.devoluciones_cliente" does not exist' }), true)
  assert.equal(esFaltaVista({ code: '42501', message: 'permission denied for view devoluciones_doble_cobro' }), false)
  assert.equal(esFaltaVista(null), false)
})

caso('nombre del courier', () => {
  assert.equal(nombreCourier('pap'), 'PaP')
  assert.equal(nombreCourier('lucero'), 'Lucero')
  assert.equal(nombreCourier(null), '—')
})

caso('la tarjeta está en Rendición, arriba de los KPIs, y la migración usa security_invoker', () => {
  const pagina = readFileSync(new URL('../src/pages/rendicion/RendicionPage.jsx', import.meta.url), 'utf8')
  const iTarjeta = pagina.indexOf('<DevolucionesDobleCobro')
  assert.ok(iTarjeta > 0, 'falta <DevolucionesDobleCobro> en RendicionPage')
  assert.ok(iTarjeta < pagina.indexOf('KPIs principales'), 'la tarjeta tiene que ir arriba')
  const sql = readFileSync(new URL('../supabase/migrations/20261121000001_devoluciones_doble_cobro.sql', import.meta.url), 'utf8')
  assert.match(sql, /devoluciones_doble_cobro with \(security_invoker = true\)/)
  assert.match(sql, /VOLVER ATRÁS/)
  assert.doesNotMatch(sql, /begin;|rollback;/i)
})

console.log(`\n${n - fallas}/${n} pruebas OK`)
if (fallas) process.exit(1)
