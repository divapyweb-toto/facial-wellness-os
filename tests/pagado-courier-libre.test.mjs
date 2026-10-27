// 27-10 (Enrique: "ya esta pagada no necesita cobranza"): en Despacho, un pedido pagado en una ciudad donde ningún
// courier cobra contra entrega sale por "otra" (courier libre, cobro 0) en vez de quedar "sin cobertura".
// Corre contra el código real (compila una copia de DespachoPagina.jsx exportando mapearGrupoAPedidos). Datos inventados.
// FUENTE=<archivo> corre la prueba contra otra versión (antes/después).
import { writeFileSync, readFileSync, rmSync } from 'node:fs'
import { buildSync } from 'esbuild'
import { pathToFileURL } from 'node:url'
import assert from 'node:assert/strict'

const dir = new URL('../src/pages/despacho/', import.meta.url)
const fuente = readFileSync(process.env.FUENTE || new URL('DespachoPagina.jsx', dir), 'utf8')
const copia = new URL('_probe_pagado.jsx', dir)
const salida = new URL('../_probe_pagado.out.mjs', import.meta.url)
writeFileSync(copia, fuente + '\nexport { mapearGrupoAPedidos }\n')
let n = 0, fallas = 0
const ok = (m, f) => { try { f(); n++; console.log('✓ ' + m) } catch (e) { fallas++; console.log('✗ ' + m + '\n   ' + e.message.split('\n')[0]) } }
const fila = (tags, financial, ciudad) => [{
  Name: '#9100', Id: '9100', 'Created at': '2026-10-27 10:00:00', Tags: tags, 'Financial Status': financial, 'Fulfillment Status': '',
  'Note Attributes': '', Total: '188000', Subtotal: '188000', 'Shipping Name': 'Cliente Inventado', 'Shipping City': ciudad,
  'Shipping Address1': 'Calle Inventada 123', Phone: '0981000000', Vendor: 'VOLTRA PARAGUAY',
  'Lineitem name': 'Raspador de Lengua: aliento más limpio', 'Lineitem quantity': '3', 'Lineitem price': '62666',
}]
try {
  buildSync({
    bundle: true, platform: 'node', format: 'esm', packages: 'external', loader: { '.jsx': 'jsx', '.js': 'jsx' }, logLevel: 'silent', jsx: 'automatic',
    define: { 'import.meta.env': '{"VITE_SUPABASE_URL":"http://localhost","VITE_SUPABASE_ANON_KEY":"x"}' },
    entryPoints: [copia.pathname], outfile: salida.pathname,
  })
  const D = await import(pathToFileURL(salida.pathname).href)
  ok('pagado sin cobertura (Colonia Manitoba) → transportadora "otra", se despacha, cobro 0', () => {
    const [p] = D.mapearGrupoAPedidos(fila('CONFIRMADO, SIN_COBERTURA, PAGADO, PAGO_VERIFICADO', 'paid', 'Colonia Manitoba'))
    assert.equal(p.transportadora, 'otra')
    assert.equal(p.despachar, true)
    assert.equal(p.pagadoShopify, true)
    assert.match(p.motivoTransportadora, /courier libre/)
  })
  ok('sin pagar en esa ciudad → sigue sin courier y no se despacha', () => {
    const [p] = D.mapearGrupoAPedidos(fila('CONFIRMADO, SIN_COBERTURA', 'pending', 'Colonia Manitoba'))
    assert.equal(p.transportadora, null)
    assert.equal(p.despachar, false)
  })
  ok('pagado en una ciudad con courier → el courier de siempre', () => {
    const [p] = D.mapearGrupoAPedidos(fila('CONFIRMADO, PAGADO, PAGO_VERIFICADO', 'paid', 'Ciudad del Este'))
    assert.equal(p.transportadora, 'lucero')
  })
} finally {
  rmSync(copia, { force: true }); rmSync(salida, { force: true })
}
console.log(`\n${n} bloques de pagado-courier-libre OK${fallas ? ` · ${fallas} FALLAN` : ''}`)
if (fallas) process.exit(1)
