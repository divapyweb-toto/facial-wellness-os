// Inhalador de menta GTRC (09-11-2026): familia propia antes que Tiras en Despacho, guía/planillas y ruteo.
// Corre contra el código real de Despacho (copia de DespachoPagina.jsx exportando funciones internas). Datos inventados.
// FUENTE=<archivo> permite correrla contra otra versión (p. ej. la anterior al cambio) para comparar antes/después.
import { writeFileSync, readFileSync, rmSync } from 'node:fs'
import { buildSync } from 'esbuild'
import { pathToFileURL } from 'node:url'
import assert from 'node:assert/strict'

const dir = new URL('../src/pages/despacho/', import.meta.url)
const fuente = readFileSync(process.env.FUENTE || new URL('DespachoPagina.jsx', dir), 'utf8')
const copia = new URL('_probe_inhalador.jsx', dir)
const salida = new URL('../_probe_inhalador.out.mjs', import.meta.url)
const opts = {
  bundle: true, platform: 'node', format: 'esm', packages: 'external',
  loader: { '.jsx': 'jsx', '.js': 'jsx' }, logLevel: 'silent', jsx: 'automatic',
  define: { 'import.meta.env': '{"VITE_SUPABASE_URL":"http://localhost","VITE_SUPABASE_ANON_KEY":"x"}' },
}
writeFileSync(copia, fuente + '\nexport { getTipo, getDesc, matchProducto, filaVentaDePedido }\n')
let n = 0, fallas = 0
const ok = (m, f) => { try { f(); n++; console.log('✓ ' + m) } catch (e) { fallas++; console.log('✗ ' + m + '\n   ' + e.message.split('\n')[0]) } }
try {
  buildSync({ ...opts, entryPoints: [copia.pathname], outfile: salida.pathname })
  const D = await import(pathToFileURL(salida.pathname).href)
  const { familiaProducto } = await import('../src/lib/recompra.js')

  const catalogo = [
    { id: 'b', nombre: 'Botella Flexible', costo_unit: 20230, precio_1u: 129000 },
    { id: 't', nombre: 'Tiras nasales', costo_unit: 16000, precio_1u: 129000 },
    { id: 'i', nombre: 'Inhalador de menta', costo_unit: 3750, precio_1u: 99000 },
    { id: 'kd', nombre: 'Kit Deporte (Botella Flexible + Tiras nasales)', costo_unit: 36230, precio_1u: 158000, es_combo: true },
  ]
  const INH = 'Inhalador de Menta: frescura en 1 respiro' // título en Shopify (09-11)
  const TIRAS = 'Tiras Nasales: más aire por la nariz'
  const BOTELLA = 'Botella Deportiva Flexible: se enrolla y no pesa'

  ok('familia: inhalador (también "inhalador nasal") es "inhalador"; tiras, kit y botella igual que antes', () => {
    assert.equal(familiaProducto(INH), 'inhalador')
    assert.equal(familiaProducto('Inhalador nasal de menta'), 'inhalador')
    assert.equal(familiaProducto(TIRAS), 'nasal')
    assert.equal(familiaProducto('Kit Deporte: Botella Deportiva + Tiras Nasales'), 'kit')
    assert.equal(familiaProducto(BOTELLA), 'botella')
  })
  ok('Despacho: 3 inhaladores se cargan con el producto Inhalador (costo 3.750), no con Tiras', () => {
    assert.equal(D.matchProducto(INH, catalogo)?.id, 'i')
    assert.equal(D.matchProducto('Inhalador nasal de menta', catalogo)?.id, 'i')
    const fila = D.filaVentaDePedido({ producto_nombre: INH, cantidad: 3, total: 149000, transportadora: 'lucero', tienda: 'voltra' }, catalogo)
    assert.equal(fila.producto_id, 'i'); assert.equal(fila.costo_prod, 3 * 3750)
  })
  ok('Despacho: pedido mixto Botella + Inhalador → cada línea con su producto', () => {
    assert.equal(D.matchProducto(BOTELLA, catalogo)?.id, 'b')
    assert.equal(D.matchProducto(INH, catalogo)?.id, 'i')
    assert.equal([D.getTipo(BOTELLA), D.getTipo(INH)].join(' + '), 'Botella Flexible + Inhalador de menta')
  })
  ok('Despacho: un pedido de Tiras sigue siendo Tiras (sin cambios)', () => {
    assert.equal(D.matchProducto(TIRAS, catalogo)?.id, 't')
    assert.equal(D.getTipo(TIRAS), 'Tiras nasales')
    assert.equal(D.getDesc(TIRAS, 1), 'Tiras nasales (30 unidades)')
  })
  ok('guía del courier: "Inhalador de menta (3 unidades)"', () => {
    assert.equal(D.getTipo(INH), 'Inhalador de menta')
    assert.equal(D.getDesc(INH, 3), 'Inhalador de menta (3 unidades)')
    assert.equal(D.getDesc(INH, 1), 'Inhalador de menta (1 unidad)')
  })
} finally {
  rmSync(copia, { force: true }); rmSync(salida, { force: true })
}
console.log(`\n${n} bloques de inhalador OK${fallas ? ` · ${fallas} FALLAN` : ''}`)
if (fallas) process.exit(1)
