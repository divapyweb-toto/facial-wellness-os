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
writeFileSync(copia, fuente + '\nexport { mapearGrupoAPedidos, ventaAPedido, colapsarPorReferencia, salidaDePedido, noSaleVoltra, clasificarVentasPendientes, resumenQuien, estadoCourierFinal }\nexport { fijarTarifasCourier } from "../../lib/tarifasCourier"\n')
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
  assert.match(fuente, /prepago(:| =) p\.pagadoShopify \? !prepagos\.has\(p\.n_referencia\) : prepagos\.has\(p\.n_referencia\)/)
  assert.match(fuente, /const paraDespacho = useMemo\(\(\) => ordenarPorPrioridad\(todosConOverride\.filter\(p => p\.despachar\)\)/)
  assert.match(fuente, /if \(!busqueda\.trim\(\)\) return ordenarPorPrioridad\(visibles\)/) // 29-10: sin cancelados
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

  // ─── 29-10: Despacho muestra solo lo que sale (regla única de supabase/functions/_shared/sale_hoy.js) ───
  // Tarifas DE MENTIRA (repo público): Lucero cobra en Mbocajaty y Asunción; un pueblo reconocido donde nadie cobra.
  const t = (courier, ciudad, ciudad_nombre, extra = {}) => ({ courier, ciudad, ciudad_nombre, precio: 30000, alias: [], zona: null, tiempo: null, dias_min: 1, dias_max: 3, aplica_cobranza: true, tiene_agencia: null, ...extra })
  D.fijarTarifasCourier({ tarifas: [t('lucero', 'mbocajaty', 'Mbocajaty'), t('lucero', 'asuncion', 'Asunción'), t('pap', 'asuncion', 'Asunción'), t('pap', 'pueblo reconocido', 'Pueblo Reconocido', { aplica_cobranza: false })], tasas: [], zonasPaP: { 'INTERIOR 2': 35000 } })
  const ped = (n, tags, extra = {}) => D.mapearGrupoAPedidos([fila(n, tags, extra)])[0]
  const sale = (p) => D.salidaDePedido(p)
  // Sale: confirmado + courier + dirección utilizable
  const okP = ped('#9101', 'CONFIRMADO')
  assert.equal(sale(okP).sale, true)
  // Sin confirmar → bot; FALTAN_DATOS → bot; comprobante → Enrique; dirección inútil (sin pin, calle ni zona) → faltan datos
  assert.deepEqual([sale(ped('#9102', 'releasit_cod_form')).clave, sale(ped('#9102', 'releasit_cod_form')).quien], ['sin_confirmar', 'bot'])
  assert.deepEqual([sale(ped('#9103', 'CONFIRMADO, FALTAN_DATOS')).clave, sale(ped('#9103', 'CONFIRMADO, FALTAN_DATOS')).quien], ['faltan_datos', 'bot'])
  assert.deepEqual([sale(ped('#9104', 'CONFIRMADO, PAGO_ANTICIPADO_COMPROBANTE')).clave, sale(ped('#9104', 'CONFIRMADO, PAGO_ANTICIPADO_COMPROBANTE')).quien], ['comprobante', 'Enrique'])
  assert.equal(sale(ped('#9105', 'CONFIRMADO', { 'Shipping Address1': 'Seivo' })).clave, 'faltan_datos')
  // Con pin alcanza; con zona + ciudad también
  assert.equal(sale(ped('#9106', 'CONFIRMADO', { 'Shipping Address1': 'Pin de ubicación', 'Shipping Address2': 'Mapa: https://maps.google.com/?q=-25.2800000,-57.6300000' })).sale, true)
  assert.equal(sale(ped('#9107', 'CONFIRMADO', { 'Shipping Address1': 'Área 4' })).sale, true)
  // Historial de no recepción → Enrique
  assert.deepEqual(['clave', 'quien'].map(k => D.salidaDePedido(okP, { cubierto: true, bloqueadoRiesgo: true })[k]), ['no_recibe', 'Enrique'])
  ok('Despacho: sale solo confirmado + courier + dirección utilizable; el resto con motivo y quién lo resuelve (bot / sistema / Enrique)')

  // Cancelados o anulados: en ningún lado
  for (const [tags, extra] of [['CANCELADO_CLIENTE, OFERTA_PAGO_ANTICIPADO', {}], ['CONFIRMADO', { 'Financial Status': 'voided' }], ['CONFIRMADO', { 'Cancelled at': '2026-10-21 19:13:04' }], ['CONFIRMADO, REEMPLAZADO_POR_#9200', {}]]) {
    const p = ped('#9108', tags, extra)
    assert.equal(p.estado_releasit, 'cancelado', tags)
    assert.equal(sale(p).oculto, true, tags)
  }
  assert.deepEqual(D.noSaleVoltra([ped('#9108', 'CANCELADO_CLIENTE'), ped('#9102', 'releasit_cod_form')], { hoy: '2026-10-12' }).map(x => x.ref), ['VT-9102'])
  // En Desde Ventas: venta cuyo pedido de Shopify se canceló/anuló no se muestra; con FALTAN_DATOS va a "No sale hoy".
  const ventas = [{ n_referencia: 'VT-9110', ciudad: 'Asunción', total: 129000, transportadora: 'lucero' }, { n_referencia: 'VT-9111', ciudad: 'Asunción', total: 129000 }, { n_referencia: 'VT-9112', ciudad: 'Luque', total: 129000 }, { n_referencia: 'WA-0001', ciudad: 'Luque', total: 99000 }]
  const cv = D.clasificarVentasPendientes(ventas, [{ nombre: '#9110', tags: ['CONFIRMADO'], cancelado: null, fin: 'voided' }, { nombre: '#9111', tags: ['CONFIRMADO', 'FALTAN_DATOS'] }, { nombre: '#9112', tags: ['CONFIRMADO'] }])
  assert.deepEqual(cv.sale.map(v => v.n_referencia), ['VT-9112', 'WA-0001'])
  assert.deepEqual(cv.noSale.map(x => [x.ref, x.clave]), [['VT-9111', 'faltan_datos']])
  // El aviso "cancelado con paquete en courier" no sigue cuando el courier ya lo devolvió (#1091).
  assert.deepEqual(['Devuelto', 'DEVUELTO', 'Aceptado', 'En ruta', 'Cancelado'].map(D.estadoCourierFinal), [true, true, false, false, true])
  ok('cancelados o anulados (CANCELADO_CLIENTE, voided, cancelled_at, reemplazado) no aparecen en ningún lado')

  // Ciudades mal escritas
  const mb = ped('#9159', 'CONFIRMADO', { 'Shipping City': 'Mbocayaty', Total: '188000' })
  assert.equal(mb.transportadora, 'lucero')
  assert.equal(sale(mb).sale, true)
  for (const c of ['AsunciÓn', 'asuncion', ' ASUNCION ']) assert.equal(sale(ped('#9113', 'CONFIRMADO', { 'Shipping City': c })).sale, true, c)
  const casa = ped('#9150', 'CONFIRMADO', { 'Shipping City': 'Casa', 'Shipping Address1': 'Calle Inventada 1234' })
  assert.deepEqual(['sale', 'clave', 'motivo'].map(k => sale(casa)[k]), [false, 'ciudad', 'Faltan datos'])
  const reconocida = ped('#9114', 'CONFIRMADO', { 'Shipping City': 'Pueblo Reconocido' })
  assert.deepEqual(['clave', 'motivo', 'quien'].map(k => sale(reconocida)[k]), ['sin_cobertura', 'Sin cobertura', 'sistema'])
  // pagado: PaP llega aunque no cobre ahí → sale por PaP; donde nadie llega → courier libre ("otra")
  assert.deepEqual([sale(ped('#9115', 'CONFIRMADO, PAGADO', { 'Shipping City': 'Pueblo Reconocido' })).sale, sale(ped('#9115', 'CONFIRMADO, PAGADO', { 'Shipping City': 'Pueblo Reconocido' })).courier], [true, 'pap'])
  assert.deepEqual(['sale', 'courier'].map(k => sale(ped('#9116', 'CONFIRMADO, PAGADO', { 'Shipping City': 'Casa', 'Shipping Address1': 'Calle Inventada 1234' }))[k]), [true, 'otra'])
  const ns = D.noSaleVoltra([casa, reconocida, mb, okP], { hoy: '2026-10-12' })
  assert.deepEqual(ns.map(x => [x.ref, x.clave, x.quien]), [['VT-9150', 'ciudad', 'sistema'], ['VT-9114', 'sin_cobertura', 'sistema']])
  assert.equal(D.resumenQuien([{ quien: 'bot' }, { quien: 'Enrique' }, { quien: 'Enrique' }]), 'resuelve: 1 el bot · 2 vos')
  ok('"Mbocayaty" → Lucero; "AsunciÓn"/"asuncion" salen; "Casa" = faltan datos (ciudad), nunca sin cobertura; reconocida sin cobranza = sin cobertura')

  // La pantalla: "Para despachar hoy" arriba y "No sale hoy (N)" cerrado (details sin open); cancelados afuera.
  assert.match(fuente, /const paraDespachoTabla = tablaFiltrada\.filter\(p => p\.despachar\)/)
  assert.match(fuente, /const visibles = todosConOverride\.filter\(p => !p\.oculto\)/)
  assert.match(fuente, /Para despachar hoy \(\{paraDespachoTabla\.length\}\)/)
  assert.equal((fuente.match(/<details className="card ultra-o\d"[^>]*>/g) || []).length, 2)
  assert.equal(/<details[^>]* open/.test(fuente), false)
  ok('pantalla: una sola lista "Para despachar hoy"; "No sale hoy (N)" cerrada en CSV y en Desde Ventas')
} finally {
  rmSync(copia, { force: true }); rmSync(salida, { force: true })
}
console.log(`\n${n} pruebas de Despacho (prioridad) OK`)
