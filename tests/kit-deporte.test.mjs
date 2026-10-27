// Kit Deporte (botella + tiras) y nota de armado de JawFlex ×3 (26-10-2026). Corre contra el código real de Despacho
// (compila una copia de DespachoPagina.jsx exportando funciones internas). Datos de prueba inventados.
// FUENTE=<archivo> permite correrla contra otra versión (p. ej. la anterior al cambio) para comparar antes/después.
import { writeFileSync, readFileSync, rmSync } from 'node:fs'
import { buildSync } from 'esbuild'
import { pathToFileURL } from 'node:url'
import assert from 'node:assert/strict'

const dir = new URL('../src/pages/despacho/', import.meta.url)
const fuente = readFileSync(process.env.FUENTE || new URL('DespachoPagina.jsx', dir), 'utf8')
const copia = new URL('_probe_kit.jsx', dir)
const salida = new URL('../_probe_kit.out.mjs', import.meta.url)
const opts = {
  bundle: true, platform: 'node', format: 'esm', packages: 'external',
  loader: { '.jsx': 'jsx', '.js': 'jsx' }, logLevel: 'silent', jsx: 'automatic',
  define: { 'import.meta.env': '{"VITE_SUPABASE_URL":"http://localhost","VITE_SUPABASE_ANON_KEY":"x"}' },
}
writeFileSync(copia, fuente + '\nexport { getTipo, getDesc, matchProducto, mapearGrupoAPedidos, colapsarPorReferencia, filaVentaDePedido }\n')
let n = 0, fallas = 0
const ok = (m, f) => { try { f(); n++; console.log('✓ ' + m) } catch (e) { fallas++; console.log('✗ ' + m + '\n   ' + e.message.split('\n')[0]) } }
try {
  buildSync({ ...opts, entryPoints: [copia.pathname], outfile: salida.pathname })
  const D = await import(pathToFileURL(salida.pathname).href)
  const { familiaProducto } = await import('../src/lib/recompra.js')
  const { notaArmado } = await import('../src/lib/armado.js')

  const catalogo = [
    { id: 'b', nombre: 'Botella Flexible', costo_unit: 20230, precio_1u: 129000 },
    { id: 't', nombre: 'Tiras nasales', costo_unit: 16000, precio_1u: 129000 },
    { id: 'p', nombre: 'Parches bucales', costo_unit: 16000, precio_1u: 129000 },
    { id: 'j', nombre: 'Ejercitador de mandibula JawFlex Pro', costo_unit: 15000, precio_1u: 129000 },
    { id: 'g', nombre: 'tiras nasales + parches bucales Pack Gudair', costo_unit: 32000, precio_1u: 150000, es_combo: true },
    { id: 'kd', nombre: 'Kit Deporte (Botella Flexible + Tiras nasales)', costo_unit: 36230, precio_1u: 158000, es_combo: true },
  ]
  const KIT = 'Kit Deporte: Botella Flexible + Tiras Nasales'

  ok('familia: el kit es "kit"; la botella "Deportiva" sigue siendo botella; tiras y pack igual que antes', () => {
    assert.equal(familiaProducto(KIT), 'kit')
    assert.equal(familiaProducto('Botella Deportiva Flexible: se enrolla y no pesa'), 'botella')
    assert.equal(familiaProducto('Tiras Nasales: más aire por la nariz'), 'nasal')
    assert.equal(familiaProducto('Pack GUDAIR: nariz abierta, boca cerrada'), 'gudair')
  })
  ok('Despacho: la venta del kit se carga con el producto combo (descuenta botella y tiras), costo 36.230', () => {
    assert.equal(D.matchProducto(KIT, catalogo)?.id, 'kd')
    const fila = D.filaVentaDePedido({ producto_nombre: KIT, cantidad: 1, total: 158000, transportadora: 'lucero', tienda: 'voltra' }, catalogo)
    assert.equal(fila.producto_id, 'kd'); assert.equal(fila.costo_prod, 36230)
  })
  ok('Despacho: botella sola, tiras solas y Pack siguen como antes', () => {
    assert.equal(D.matchProducto('Botella Deportiva Flexible: se enrolla y no pesa', catalogo)?.id, 'b')
    assert.equal(D.matchProducto('Tiras Nasales: más aire por la nariz', catalogo)?.id, 't')
    assert.equal(D.matchProducto('Pack GUDAIR: nariz abierta, boca cerrada', catalogo)?.id, 'g')
    assert.equal(D.matchProducto('Ejercitador de Mandíbula: entrená en minutos', catalogo)?.id, 'j')
  })
  ok('guía y planillas: el kit dice botella + tiras (no solo "Tiras nasales")', () => {
    assert.equal(D.getTipo(KIT), 'Kit Deporte')
    assert.match(D.getDesc(KIT, 1), /Botella Flexible \+ Tiras nasales/)
    assert.equal(D.getTipo('Botella Deportiva Flexible: se enrolla y no pesa'), 'Botella Flexible')
  })
  ok('JawFlex ×3: nota de armado; ×1, ×2 y otros productos ×3 no', () => {
    assert.equal(notaArmado('Ejercitador de Mandíbula: entrená en minutos', 3), 'ARMAR: 1 suave + 1 medio + 1 duro')
    assert.equal(notaArmado('Ejercitador de Mandíbula: entrená en minutos', 1), '')
    assert.equal(notaArmado('JawFlex Pro', 2), '')
    assert.equal(notaArmado('Tiras Nasales', 3), '')
  })
  ok('CSV de Shopify: pedido Raspador ×1 + JawFlex ×3 → el paquete lleva la nota; uno de JawFlex ×1, no', () => {
    const fila = (name, item, qty, extra = {}) => ({ Name: name, 'Lineitem name': item, 'Lineitem quantity': String(qty), 'Lineitem price': '79000',
      Total: '300000', Subtotal: '300000', Tags: 'confirmado', 'Shipping City': 'Asunción', 'Shipping Address1': 'Calle 1', Phone: '0981000000',
      'Billing Name': 'Cliente Prueba', Vendor: 'VOLTRA PARAGUAY', 'Created at': '2026-10-26 10:00:00 -0300', ...extra })
    const ps = D.mapearGrupoAPedidos([fila('#1200', 'Raspador de Lengua: aliento más limpio', 1), fila('#1200', 'Ejercitador de Mandíbula: entrená en minutos', 3, { Name: '#1200' })])
    assert.ok(ps.every(p => p.armado === 'ARMAR: 1 suave + 1 medio + 1 duro'))
    const [paquete] = D.colapsarPorReferencia(ps)
    assert.equal(paquete.armado, 'ARMAR: 1 suave + 1 medio + 1 duro')
    const uno = D.mapearGrupoAPedidos([fila('#1201', 'Ejercitador de Mandíbula: entrená en minutos', 1)])
    assert.equal(uno[0].armado, '')
  })
} finally {
  rmSync(copia, { force: true }); rmSync(salida, { force: true })
}
console.log(`\n${n} bloques de kit-deporte OK${fallas ? ` · ${fallas} FALLAN` : ''}`)
if (fallas) process.exit(1)
