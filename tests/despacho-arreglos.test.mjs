// Arreglos de Despacho (09-10-2026). Corre contra el código real: compila con
// esbuild una copia de DespachoPagina.jsx (exportando funciones internas) y
// ModalSalida.jsx. Datos de prueba inventados.
import { writeFileSync, readFileSync, rmSync } from 'node:fs'
import { buildSync } from 'esbuild'
import { pathToFileURL } from 'node:url'
import assert from 'node:assert/strict'

const dir = new URL('../src/pages/despacho/', import.meta.url)
const fuente = readFileSync(new URL('DespachoPagina.jsx', dir), 'utf8')
const fuenteModal = readFileSync(new URL('ModalSalida.jsx', dir), 'utf8')
const copia = new URL('_probe_arreglos.jsx', dir)
const salida = new URL('../_probe_arreglos.out.mjs', import.meta.url)
const salidaModal = new URL('../_probe_modal.out.mjs', import.meta.url)
const opts = {
  bundle: true, platform: 'node', format: 'esm', packages: 'external',
  loader: { '.jsx': 'jsx', '.js': 'jsx' }, logLevel: 'silent', jsx: 'automatic',
  define: { 'import.meta.env': '{"VITE_SUPABASE_URL":"http://localhost","VITE_SUPABASE_ANON_KEY":"x"}' },
}
writeFileSync(copia, fuente + '\nexport { ventaAPedido, parsearPedidoManual, faltaFleteOtra, deduplicarHistorico, siguienteNumeroWA, colapsarPorReferencia, esErrorColumnaFaltante }\n')
let n = 0
const ok = (m) => { n++; console.log('✓ ' + m) }
try {
  buildSync({ ...opts, entryPoints: [copia.pathname], outfile: salida.pathname })
  buildSync({ ...opts, entryPoints: [new URL('ModalSalida.jsx', dir).pathname], outfile: salidaModal.pathname })
  const D = await import(pathToFileURL(salida.pathname).href)
  const M = await import(pathToFileURL(salidaModal.pathname).href)

  // 1) Desde Ventas: una venta pagada sale como prepago, con su courier y flete
  const venta = { n_referencia: 'VT-9001', cliente_nombre: 'Cliente Prueba', ciudad: 'Asunción', producto_nombre: 'Tiras nasales',
    cantidad: 1, total: 129000, pago_anticipado: true, transportadora: 'lucero', costo_envio: 23456, tienda: 'voltra' }
  const p = D.ventaAPedido(venta)
  assert.equal(p.prepago, true)
  assert.equal(p.transportadora, 'lucero')
  assert.equal(p.costo_envio, 23456)
  assert.equal(p.tienda, 'voltra')
  assert.equal(D.ventaAPedido({ ...venta, pago_anticipado: false }).prepago, false)
  assert.equal(D.ventaAPedido({ n_referencia: 'X1', ciudad: 'Asunción' }).prepago, false)
  ok('ventaAPedido respeta pago anticipado, transportadora, flete y tienda')
  assert.match(fuente, /COLS_VENTAS_PEND_EXTRA = 'pago_anticipado, transportadora, costo_envio, tienda'/)
  assert.equal(D.esErrorColumnaFaltante({ message: 'column ventas.tienda does not exist', code: '42703' }), true)
  assert.equal(D.esErrorColumnaFaltante({ message: 'permission denied' }), false)
  ok('select de Desde Ventas trae las columnas extra con reintento si falta alguna')

  // 2) Pendientes sin borradas
  assert.match(fuente, /\.eq\('estado', 'pendiente'\)\s*\n\s*\.is\('deleted_at', null\)/)
  ok('fetchVentasPendientes filtra deleted_at')

  // 3) Duplicados: mira error y aborta
  assert.match(fuente, /\.in\('n_referencia', refs\)\.is\('deleted_at', null\)\s*\n\s*if \(error\) throw error/)
  assert.match(fuente, /No se pudo verificar duplicados, no se cargó nada/)
  ok('chequeo de duplicados aborta si falla y no cuenta borradas')

  // 4) Candado de traerPedidosVoltra
  assert.match(fuente, /if \(trayendoVoltraRef\.current\) return/)
  assert.match(fuente, /if \(errYa\) throw errYa/)
  ok('traerPedidosVoltra no corre dos veces y aborta si falla la consulta "ya"')

  // 5) Pedido manual de WhatsApp → Voltra
  const bloque = 'Nombre completo: Cliente Prueba\nCiudad: Asunción\nDirección: Calle Falsa 123\nNúmero de contacto: 0981000000\nProducto y cantidad: Tiras nasales 1'
  const man = D.parsearPedidoManual(bloque, [{ id: 1, nombre: 'Tiras nasales', precio_1u: 79000, grupo_envio: 'B' }], 'WA-0001')
  assert.equal(man.tienda, 'voltra')
  ok('pedido pegado de WhatsApp queda como Voltra')

  // 7) Histórico Releasit sin referencias repetidas
  const hist = D.deduplicarHistorico([
    { n_referencia: '#1', total: 100 }, { n_referencia: '#1', total: 50 }, { n_referencia: '#2', total: 10 },
  ])
  assert.deepEqual(hist.map(h => [h.n_referencia, h.total]), [['#1', 150], ['#2', 10]])
  ok('histórico Releasit deduplica por referencia y suma el total')

  // 8) Catálogo: las 3 consultas cortan si fallan
  assert.equal((fuente.match(/if \(errCat\) throw/g) || []).length, 2)
  assert.match(fuente, /No se pudo leer el catálogo, no se cargó nada/)
  ok('las 3 consultas de catálogo cortan la carga si fallan')

  // 9) 'otra' sin flete no se despacha
  assert.equal(D.faltaFleteOtra('otra', ''), true)
  assert.equal(D.faltaFleteOtra('otra', '0'), true)
  assert.equal(D.faltaFleteOtra('otra', undefined), true)
  assert.equal(D.faltaFleteOtra('otra', '35000'), false)
  assert.equal(D.faltaFleteOtra('pap', ''), false)
  assert.match(fuente, /!bloqueadoPorCiudad && !sinFleteOtra/)
  ok("transportadora 'otra' sin flete queda bloqueada con faltante")

  // 10) Serie WA-
  assert.equal(D.siguienteNumeroWA('WA-0041'), 42)
  assert.equal(D.siguienteNumeroWA(undefined), 1)
  assert.match(fuente, /\.order\('n_referencia', \{ ascending: false \}\)\.limit\(1\)/)
  ok('serie WA- pide solo el máximo')

  // 11) Placeholders de Lucero solo para lo insertado y con error chequeado
  assert.match(fuente, /const deLuceroNuevas = insertadas\.filter/)
  assert.equal((fuente.match(/if \(errPh\) throw errPh/g) || []).length, 2)
  ok('placeholders de Lucero solo para lotes guardados y con { error } chequeado')

  // 12) Paginación por columna única
  assert.doesNotMatch(fuente, /columnaOrden: 'n_referencia'/)
  ok('historial por ciudad pagina por id')

  // EMPRESA_LUCERO no se tocó (decisión de negocio)
  assert.match(fuente, /const EMPRESA_LUCERO = 'Facial Wellness'/)

  // 6) ModalSalida
  const ventas = [
    { id: 1, n_referencia: '1500', transportadora: 'pap', tienda: 'voltra' },
    { id: 2, n_referencia: '1500', transportadora: 'pap', tienda: 'voltra' },
    { id: 3, n_referencia: '1501', transportadora: 'lucero', tienda: 'voltra' },
    { id: 4, n_referencia: '1502', transportadora: null, tienda: null },
  ]
  const idx = M.indexarPorRef(ventas)
  const filas1500 = Object.values(idx).find(l => l.some(v => v.id === 1))
  assert.deepEqual(filas1500.map(v => v.id), [1, 2])
  ok('índice de escaneo guarda TODAS las líneas de un pedido multiproducto')
  assert.equal(M.contarPaquetes(ventas), 3)
  ok('paquetes se cuentan por referencia única (4 filas = 3 cajas)')
  assert.deepEqual(M.filtrarSalida(ventas, { transportadora: 'pap' }).map(v => v.id), [1, 2, 4])
  assert.deepEqual(M.filtrarSalida(ventas, { transportadora: 'lucero' }).map(v => v.id), [3])
  assert.deepEqual(M.filtrarSalida(ventas, { tienda: 'voltra' }).map(v => v.id), [1, 2, 3])
  assert.deepEqual(M.filtrarSalida(ventas, { tienda: 'fw' }).map(v => v.id), [4])
  assert.equal(M.filtrarSalida(ventas, {}).length, 4)
  ok('filtro por transportadora y tienda')
  assert.equal(M.diasDesde('2026-10-09', '2026-10-09'), 0)
  assert.equal(M.diasDesde('2026-10-06', '2026-10-09'), 3)
  assert.equal(M.diasDesde('2026-09-30T23:00:00', '2026-10-01'), 1)
  assert.equal(M.diasDesde(null), null)
  ok('diasDesde cuenta días calendario de Paraguay')
  assert.match(fuenteModal, /select\(cols\)/)
  assert.match(fuenteModal, /transportadora, tienda/)

  console.log(`\n${n} verificaciones de despacho OK`)
} finally {
  rmSync(copia, { force: true }); rmSync(salida, { force: true }); rmSync(salidaModal, { force: true })
}
