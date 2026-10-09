// Costo por anuncio: cruce por nombre, por ID, WhatsApp y totales (datos inventados).
import assert from 'node:assert/strict'
import { armarCostoPorAnuncio } from '../src/lib/costoPorAnuncio.js'

const r = armarCostoPorAnuncio({
  gastoAnuncios: [
    { fecha: '2026-10-08', ad_id: '111111111', ad_nombre: 'VID PRUEBA A 08-10-26', campana_nombre: 'CAMP WEB', gasto: 30000 },
    { fecha: '2026-10-09', ad_id: '111111111', ad_nombre: 'VID PRUEBA A 08-10-26', campana_nombre: 'CAMP WEB', gasto: 30000 },
    { fecha: '2026-10-08', ad_id: '222222222', ad_nombre: 'IMG WHATSAPP PRUEBA B', campana_nombre: 'CAMP WA', gasto: 20000 },
    { fecha: '2026-10-08', ad_id: '333333333', ad_nombre: 'IMG SIN PEDIDOS', campana_nombre: 'CAMP WEB', gasto: 5000 },
  ],
  pedidos: [
    { utm_content: 'vid prueba a 08-10-26 ', entregado: true },        // por nombre (mayúsculas/espacios)
    { utm_content: '111111111', entregado: false },                    // por ID
    { anuncio_wa: '222222222', origen: 'whatsapp', entregado: true },  // WhatsApp por ID
    { utm_content: '', anuncio_wa: null },                             // sin anuncio
  ],
})
const a = r.filas.find(f => f.anuncio === 'VID PRUEBA A 08-10-26')
assert.equal(a.gasto, 60000); assert.equal(a.pedidos, 2); assert.equal(a.entregados, 1)
assert.equal(a.costoPedido, 30000); assert.equal(a.costoEntregado, 60000); assert.equal(a.tasaEntrega, 50); assert.equal(a.canal, 'Web')
const b = r.filas.find(f => f.anuncio === 'IMG WHATSAPP PRUEBA B')
assert.equal(b.canal, 'WhatsApp'); assert.equal(b.costoEntregado, 20000)
const c = r.filas.find(f => f.anuncio === 'IMG SIN PEDIDOS')
assert.equal(c.pedidos, 0); assert.equal(c.costoPedido, null)
assert.equal(r.sinAnuncio, 1); assert.equal(r.conPedidos, 2)
assert.equal(r.total.gasto, 85000); assert.equal(r.total.pedidos, 3); assert.equal(r.total.entregados, 2)
assert.equal(r.filas[0].anuncio, 'VID PRUEBA A 08-10-26') // ordenado por gasto
assert.deepEqual(armarCostoPorAnuncio().filas, [])
console.log('✓ costo por anuncio: nombre, ID, WhatsApp, sin anuncio y totales')
