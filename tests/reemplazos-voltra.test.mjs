// 21-10: pedido que reemplaza a otro cuyo paquete ya está en el courier. Correr: node --import ./tests/registrar.mjs tests/reemplazos-voltra.test.mjs
import assert from 'node:assert/strict'

// ─── 21-10: reemplazo de un pedido cuyo paquete ya está en el courier ───
{
  const { mapaReemplazos, reemplazosVinculados } = await import('../src/lib/pedidosVoltra.js')
  const filas = [
    { nombre: '#2001', raw: { name: '#2001', tags: ['CONFIRMADO', 'REEMPLAZA_A_#2000'] } },
    { nombre: '#2003', raw: { name: '#2003', tags: 'CONFIRMADO, REEMPLAZA_A_#2002' } },   // tags en texto (REST)
    { nombre: '#2005', raw: { name: '#2005', tags: ['CONFIRMADO'] } },                    // pedido normal
  ]
  const m = mapaReemplazos(filas)
  assert.deepEqual([...m], [['VT-2001', 'VT-2000'], ['VT-2003', 'VT-2002']])
  // #2000 ya está en el courier → el nuevo se vincula (no se carga aparte); #2002 no salió → el nuevo se carga normal
  const v = reemplazosVinculados(m, new Set(['VT-2000', 'VT-2002']), new Set(['VT-2000']))
  assert.deepEqual([...v], ['VT-2001'])
  // si la venta vieja no existe en Ventas, tampoco se vincula
  assert.deepEqual([...reemplazosVinculados(m, new Set(), new Set(['VT-2000']))], [])
  console.log('✓ reemplazo en courier: se vincula, no aparece doble')
}
