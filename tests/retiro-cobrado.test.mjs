// 28-10: botón "Retirado y cobrado" de Despacho (caso #1089). Arma la venta de un retiro con el código real de Despacho
// (compila una copia de DespachoPagina.jsx exportando funciones internas). Datos inventados.
import { writeFileSync, readFileSync, rmSync } from 'node:fs'
import { buildSync } from 'esbuild'
import { pathToFileURL } from 'node:url'
import assert from 'node:assert/strict'

const dir = new URL('../src/pages/despacho/', import.meta.url)
const copia = new URL('_probe_retiro.jsx', dir), salida = new URL('../_probe_retiro.out.mjs', import.meta.url)
writeFileSync(copia, readFileSync(new URL('DespachoPagina.jsx', dir), 'utf8') + '\nexport { mapearGrupoAPedidos, filaVentaDePedido, agruparFilasPorReferencia }\n')
let n = 0, fallas = 0
const ok = (m, f) => { try { f(); n++; console.log('✓ ' + m) } catch (e) { fallas++; console.log('✗ ' + m + '\n   ' + e.message.split('\n')[0]) } }
try {
  buildSync({ bundle: true, platform: 'node', format: 'esm', packages: 'external', loader: { '.jsx': 'jsx', '.js': 'jsx' }, logLevel: 'silent', jsx: 'automatic',
    define: { 'import.meta.env': '{"VITE_SUPABASE_URL":"http://localhost","VITE_SUPABASE_ANON_KEY":"x"}' }, entryPoints: [copia.pathname], outfile: salida.pathname })
  const D = await import(pathToFileURL(salida.pathname).href)
  const { filasCsvDesdePedidoShopify } = await import('../src/lib/pedidosVoltra.js')
  const catalogo = [{ id: 'g', nombre: 'tiras nasales + parches bucales Pack Gudair', costo_unit: 32000, precio_1u: 150000, es_combo: true }]
  const ped = { shopify_order_id: 9200, nombre: '#9200', es_borrador: false, raw: {
    name: '#9200', id: 9200, created_at: '2026-10-20T10:00:00-03:00', tags: 'CONFIRMADO, ORIGEN_WHATSAPP, RETIRO_EN_CASA', financial_status: 'pending',
    total_price: '120000', subtotal_price: '120000', shipping_address: { name: 'Cliente Inventado', city: 'Ciudad del Este', address1: 'Oficina' },
    line_items: [{ name: 'Pack GUDAIR: nariz abierta, boca cerrada', quantity: 1, price: '120000', vendor: 'VOLTRA PARAGUAY' }] } }
  const armar = (medio) => D.agruparFilasPorReferencia(filasCsvDesdePedidoShopify(ped)).flatMap(D.mapearGrupoAPedidos)
    .map(p => D.filaVentaDePedido({ ...p, fecha: '2026-10-20', prepago: medio === 'transferencia', retiroEnPersona: true, entregadoRetiro: true }, catalogo))
  ok('transferencia: entregada el 20-10, retiro en persona, flete 0, pago anticipado, producto vinculado (descuenta stock)', () => {
    const [f] = armar('transferencia')
    assert.equal(f.n_referencia, 'VT-9200'); assert.equal(f.fecha, '2026-10-20'); assert.equal(f.estado, 'entregado')
    assert.equal(f.transportadora, 'otra'); assert.equal(f.costo_envio, 0); assert.equal(f.metodo_envio_nombre, 'Retiro en persona')
    assert.equal(f.pago_anticipado, true); assert.equal(f.metodo_pago_nombre, 'Transferencia (anticipado)')
    assert.equal(f.producto_id, 'g'); assert.equal(f.costo_prod, 32000); assert.equal(f.total, 120000)
  })
  ok('efectivo: entregada, sin pago anticipado (el botón le pone "Efectivo (retiro en oficina)")', () => {
    const [f] = armar('efectivo')
    assert.equal(f.estado, 'entregado'); assert.equal(f.pago_anticipado, false)
  })
} finally { rmSync(copia, { force: true }); rmSync(salida, { force: true }) }
console.log(`\n${n} bloques de retiro-cobrado OK${fallas ? ` · ${fallas} FALLAN` : ''}`)
if (fallas) process.exit(1)
