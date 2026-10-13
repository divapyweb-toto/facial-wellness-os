// 12-10: Despacho con pago con prioridad. Correr: node --import ./tests/registrar.mjs src/pages/despacho/prioridad.test.mjs
// Compila con esbuild una copia de DespachoPagina.jsx exportando funciones internas (igual que
// tests/despacho-arreglos.test.mjs). Datos inventados (repo público).
import { writeFileSync, readFileSync, rmSync } from 'node:fs'
import { buildSync } from 'esbuild'
import { pathToFileURL } from 'node:url'
import assert from 'node:assert/strict'
import { esPrioridad, ordenarGuias, ordenarPorPrioridad, pagadoPorTags, tienePrioridad } from './prioridad.js'

let n = 0
const ok = (m) => { n++; console.log('✓ ' + m) }

// ─── helpers puros ───
assert.equal(pagadoPorTags('CONFIRMADO, PAGADO', ''), true)
assert.equal(pagadoPorTags('PAGO_VERIFICADO', ''), true)
assert.equal(pagadoPorTags(['PAGADO_QR'], ''), true)
assert.equal(pagadoPorTags('CONFIRMADO', 'paid'), true)
assert.equal(pagadoPorTags('CONFIRMADO, PRIORIDAD, NO_PAGADO_X', 'pending'), false)
assert.equal(tienePrioridad('CONFIRMADO, PRIORIDAD'), true)
assert.equal(tienePrioridad('CONFIRMADO, PRIORIDADES'), false)
ok('PAGADO / PAGO_VERIFICADO / PAGADO_QR / paid = pagado; PRIORIDAD exacto')

const lista = [{ n: 'a' }, { n: 'b', prioridad: true }, { n: 'c' }, { n: 'd', prepago: true }, { n: 'e', prioridad: true }]
assert.deepEqual(ordenarPorPrioridad(lista).map(p => p.n), ['b', 'd', 'e', 'a', 'c'])
assert.deepEqual(lista.map(p => p.n), ['a', 'b', 'c', 'd', 'e']) // no toca la original
assert.equal(esPrioridad({ prepago: true }), true)
assert.equal(esPrioridad({}), false)
const guias = [
  { n: 1, transportadora: 'lucero' }, { n: 2, transportadora: 'pap' }, { n: 3, transportadora: 'lucero', prioridad: true },
  { n: 4, transportadora: 'pap', prioridad: true }, { n: 5, transportadora: 'otra' },
]
assert.deepEqual(ordenarGuias(guias).map(p => p.n), [4, 2, 3, 1, 5])
ok('orden estable: PRIORIDAD primero; guías por transportadora y prioridad dentro de cada una')

// ─── DespachoPagina real ───
const dir = new URL('./', import.meta.url)
const fuente = readFileSync(new URL('DespachoPagina.jsx', dir), 'utf8')
const copia = new URL('_probe_prioridad.jsx', dir)
const salida = new URL('_probe_prioridad.out.mjs', dir)
writeFileSync(copia, fuente + '\nexport { mapearGrupoAPedidos, ventaAPedido, colapsarPorReferencia }\n')
try {
  buildSync({
    bundle: true, platform: 'node', format: 'esm', packages: 'external',
    loader: { '.jsx': 'jsx', '.js': 'jsx' }, logLevel: 'silent', jsx: 'automatic',
    define: { 'import.meta.env': '{"VITE_SUPABASE_URL":"http://localhost","VITE_SUPABASE_ANON_KEY":"x"}' },
    entryPoints: [copia.pathname], outfile: salida.pathname,
  })
  const D = await import(pathToFileURL(salida.pathname).href)
  const fila = (nombre, tags, extra = {}) => ({
    Name: nombre, 'Created at': '2026-10-12 10:00:00', Tags: tags, Total: '129000', Subtotal: '129000',
    'Shipping Name': 'Ana Prueba', 'Shipping City': 'Asunción', 'Shipping Address1': 'Calle Falsa 123',
    Phone: '0981000000', Vendor: 'VOLTRA PARAGUAY', 'Lineitem name': 'Tiras nasales', 'Lineitem quantity': '1', 'Lineitem price': '129000',
    ...extra,
  })
  const normal = D.mapearGrupoAPedidos([fila('#1001', 'CONFIRMADO')])[0]
  const prio = D.mapearGrupoAPedidos([fila('#1002', 'CONFIRMADO, OFERTA_PAGO_ANTICIPADO, PAGO_VERIFICADO, PRIORIDAD, PAGADO')])[0]
  const soloPagado = D.mapearGrupoAPedidos([fila('#1003', 'CONFIRMADO, PAGADO')])[0]
  assert.equal(normal.pagadoShopify, false)
  assert.equal(normal.prioridad, false)
  assert.equal(prio.pagadoShopify, true)
  assert.equal(prio.prioridad, true)
  assert.equal(soloPagado.pagadoShopify, true) // el tag PAGADO solo ya alcanza para cobro 0
  ok('CSV / Shopify: PRIORIDAD → prioridad; PAGADO → pagado (prepago por defecto, importe 0)')

  // El componente marca prepago desde pagadoShopify y ordena paraDespacho / tablaFiltrada con ordenarPorPrioridad.
  assert.match(fuente, /prepago: p\.pagadoShopify \? !prepagos\.has\(p\.n_referencia\) : prepagos\.has\(p\.n_referencia\)/)
  assert.match(fuente, /const paraDespacho = useMemo\(\(\) => ordenarPorPrioridad\(todosConOverride\.filter\(p => p\.despachar\)\)/)
  assert.match(fuente, /if \(!busqueda\.trim\(\)\) return ordenarPorPrioridad\(todosConOverride\)/)
  assert.match(fuente, /ordenarPorPrioridad\(ventasPend\.filter\(v => selVentas\.has\(v\.id\)\)\.map\(ventaAPedido\)\)/)
  assert.equal((fuente.match(/const ordenadas = ordenarGuias\(colapsados\)/g) || []).length, 2)
  ok('lista, cabecera y guías (CSV y Desde Ventas) salen con PRIORIDAD primero')

  // Importe a cobrar 0 en las cabeceras para los pagados.
  assert.match(fuente, /p\.prepago \? 0 : \(p\.total \|\| 0\),\s+\/\/ IMPORTE a cobrar/)
  assert.match(fuente, /p\.prepago \? 0 : p\.total,/)
  assert.match(fuente, /esPrioridad\(p\) \? 'urgente' : null/)
  const v = D.ventaAPedido({ n_referencia: 'VT-1002', ciudad: 'Asunción', total: 129000, pago_anticipado: true })
  assert.equal(v.prepago, true)
  assert.equal(v.prioridad, true)
  assert.equal(D.ventaAPedido({ n_referencia: 'VT-1001', ciudad: 'Asunción', total: 129000 }).prioridad, false)
  // Colapsar un pedido multiproducto no pierde la prioridad ni el orden.
  const col = D.colapsarPorReferencia(ordenarPorPrioridad([{ ...normal }, { ...prio }, { ...prio, producto_nombre: 'Parches' }]))
  assert.deepEqual(col.map(p => p.n_referencia), [prio.n_referencia, normal.n_referencia])
  assert.equal(col[0].prioridad, true)
  ok('Desde Ventas: pago_anticipado → prepago + prioridad; importe 0 y "urgente" en la cabecera')
} finally {
  rmSync(copia, { force: true }); rmSync(salida, { force: true })
}
console.log(`\n${n} pruebas de Despacho (prioridad) OK`)
