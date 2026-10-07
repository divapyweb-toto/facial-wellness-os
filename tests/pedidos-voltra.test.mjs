// Pedidos de Voltra: referencia propia (VT-), que no choque con FW, y que el
// pedido de Shopify (JSON del webhook) dé las mismas filas que el CSV.
import { normalizarRef, refVoltra, esRefVoltra } from '../src/lib/referencias.js'
import { refDesdeCodigo } from '../src/lib/exportLucero.js'
import { refDesdeCodigoLucero, guiaLucero } from '../src/lib/rendicionLucero.js'
import { filasCsvDesdePedidoShopify, esPedidoImportable } from '../src/lib/pedidosVoltra.js'
import { codigoPedido, interpretarEscaneo, normalizarEscaneo } from '../src/lib/barcode.js'

let fallas = 0
const ok = (c, m) => { console.log(`${c ? '✓' : '✗'} ${m}`); if (!c) fallas++ }

console.log('── referencias: Voltra no se mezcla con FW ──')
ok(refVoltra('#1003') === 'VT-1003', "'#1003' de Voltra → 'VT-1003'")
ok(normalizarRef('VT-1003') === 'VT-1003' && normalizarRef('#vt1003') === 'VT-1003' && normalizarRef('VT-01003') === 'VT-1003', 'todas las formas de VT-1003 dan la misma clave')
ok(normalizarRef('VT-1003') !== normalizarRef('1003'), 'VT-1003 NO cruza con el 1003 de FW')
ok(normalizarRef('FW-2025') === '2025' && normalizarRef('L-2025') === '2025' && normalizarRef('WA-0007') === '7' && normalizarRef('#1985') === '1985', 'FW-, L-, WA- y # siguen cruzando como antes')
ok(esRefVoltra('VT-1003') && !esRefVoltra('FW-1003') && !esRefVoltra('1003'), 'esRefVoltra distingue las tiendas')

console.log('\n── couriers: lo que devuelven cruza con lo guardado ──')
ok(refDesdeCodigo('VT-1003') === 'VT-1003' && refDesdeCodigoLucero('VT-1003') === 'VT-1003', 'Lucero devuelve VT-1003 y cruza con la venta VT-1003')
ok(refDesdeCodigo('FW-2071') === '2071' && refDesdeCodigoLucero('FW-2071') === '2071', 'FW-2071 sigue cruzando como 2071')
ok(guiaLucero('VT-1003') === 'L-VT-1003' && guiaLucero('2071') === 'L-2071', 'la clave interna de Lucero tampoco choca')

console.log('\n── código de barras ──')
const cod = codigoPedido('VT-1003', '2026-10-07')
ok(cod === '261007-VT-1003', `código de la guía: ${cod}`)
const e = interpretarEscaneo(cod)
ok(e.ref === normalizarEscaneo('VT-1003') && e.ref !== normalizarEscaneo('1003'), 'al escanear se reconoce como VT-1003, no como 1003')

console.log('\n── pedido de Shopify (#1004, el real) → filas del CSV ──')
const raw = {
  id: 18947973316691, name: '#1004', tags: 'CONFIRMADO, OFERTA_PAGO_ANTICIPADO, ORIGEN_WHATSAPP', test: false,
  phone: '+595981422561', created_at: '2026-10-07T17:04:16-03:00', cancelled_at: null,
  total_price: '158000', subtotal_price: '125000',
  note_attributes: [{ name: 'origen', value: 'whatsapp' }, { name: 'factura', value: '1540443-9 Miguel Soa' }],
  line_items: [{ name: 'Botella Flexible: tomá agua sin frenar', quantity: 2, price: '62500', vendor: 'VOLTRA PARAGUAY' }],
  shipping_address: { name: 'Miguel Soa', city: 'Asunción', address1: 'Independencia Nacional 811', address2: 'Edificio El Productor', phone: '+595981422561' },
}
const fila = { shopify_order_id: raw.id, nombre: '#1004', es_borrador: false, raw }
const rows = filasCsvDesdePedidoShopify(fila)
ok(esPedidoImportable(fila) && rows.length === 1, 'se importa y da una fila por producto')
ok(rows[0].Name === '#1004' && rows[0].Vendor === 'VOLTRA PARAGUAY' && rows[0]['Created at'].startsWith('2026-10-07'), 'Name, Vendor y fecha (en hora de Paraguay)')
ok(rows[0]['Lineitem quantity'] === '2' && rows[0].Total === '158000' && rows[0]['Shipping City'] === 'Asunción', 'cantidad, total y ciudad')
ok(rows[0]['Note Attributes'].includes('factura: 1540443-9 Miguel Soa'), 'la factura con RUC viaja en las notas')
ok(!esPedidoImportable({ ...fila, es_borrador: true }) && !esPedidoImportable({ ...fila, raw: { ...raw, test: true } }), 'borradores y pruebas no se importan')

console.log(fallas ? `\n✗ ${fallas} falla(s)` : '\n✓ Voltra no se mezcla con Facial Wellness')
process.exit(fallas ? 1 : 0)
