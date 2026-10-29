// Arreglos de la auditoría de Despacho (12-10-2026). Corre contra el código real:
// compila con esbuild una copia de DespachoPagina.jsx (exportando funciones
// internas) y ModalSalida.jsx. Datos de prueba inventados.
import { writeFileSync, readFileSync, rmSync } from 'node:fs'
import { buildSync } from 'esbuild'
import { pathToFileURL } from 'node:url'
import assert from 'node:assert/strict'
import { esPagoAnticipado, esRetiroConfirmado, esRetiroEnPersona, filasCsvDesdePedidoShopify, METODO_ENVIO_RETIRO, envioEntregado } from '../src/lib/pedidosVoltra.js'
import { tieneCobranzaPaP, zonaPaP, emparejarCiudad, expandirAbreviaturas, CIUDADES_PAP_LISTA } from '../src/lib/cobranzaPaP.js'
import { sugerirTransportadora } from '../src/lib/transportadoras.js'

const dir = new URL('../src/pages/despacho/', import.meta.url)
const fuente = readFileSync(new URL('DespachoPagina.jsx', dir), 'utf8')
const fuenteModal = readFileSync(new URL('ModalSalida.jsx', dir), 'utf8')
const copia = new URL('_probe_auditoria.jsx', dir)
const salida = new URL('../_probe_auditoria.out.mjs', import.meta.url)
const salidaModal = new URL('../_probe_auditoria_modal.out.mjs', import.meta.url)
const opts = {
  bundle: true, platform: 'node', format: 'esm', packages: 'external',
  loader: { '.jsx': 'jsx', '.js': 'jsx' }, logLevel: 'silent', jsx: 'automatic',
  define: { 'import.meta.env': '{"VITE_SUPABASE_URL":"http://localhost","VITE_SUPABASE_ANON_KEY":"x"}' },
}
writeFileSync(copia, fuente + '\nexport { filaVentaDePedido, separarPedidosVoltra, pendientesDesdeVentas, refsSalidasShopify, mapearGrupoAPedidos, agruparFilasPorReferencia }\n')
let n = 0
const ok = (m) => { n++; console.log('✓ ' + m) }

// Fila estilo CSV de Shopify (datos inventados).
const fila = (nombre, tags, extra = {}) => ({
  Name: nombre, 'Created at': '2026-10-12 10:00:00', Tags: tags, Total: '240000', Subtotal: '240000',
  'Shipping Name': 'Cliente Prueba', 'Shipping City': 'Asunción', 'Shipping Address1': 'Calle Inventada 123',
  Phone: '0981000000', Vendor: 'VOLTRA PARAGUAY', 'Lineitem name': 'Tiras nasales', 'Lineitem quantity': '2', 'Lineitem price': '120000',
  ...extra,
})

try {
  buildSync({ ...opts, entryPoints: [copia.pathname], outfile: salida.pathname })
  buildSync({ ...opts, entryPoints: [new URL('ModalSalida.jsx', dir).pathname], outfile: salidaModal.pathname })
  const D = await import(pathToFileURL(salida.pathname).href)
  const M = await import(pathToFileURL(salidaModal.pathname).href)

  // ── 1) Desde Ventas: no repite lo que ya salió ──
  const entregas = [
    { n_referencia: 'VT-9001', estado_pap: 'Aceptado' },          // Lucero ya lo tiene
    { n_referencia: 'VT-9002', estado_pap: 'Asignado a ruta' },   // PaP ya lo tiene
    { n_referencia: 'VT-9003', estado_pap: '' },                  // placeholder de Lucero: todavía no salió
    { n_referencia: '#00950', estado_pap: 'Entregado' },          // FW con # y ceros
  ]
  const enCourier = M.refsEnCourier(entregas)
  assert.deepEqual([...enCourier].sort(), ['950', 'VT-9001', 'VT-9002'])
  const ventas = [
    { id: 1, n_referencia: 'VT-9001', tienda: 'voltra' },
    { id: 2, n_referencia: 'VT-9002', tienda: 'voltra' },
    { id: 3, n_referencia: 'VT-9003', tienda: 'voltra' },
    { id: 4, n_referencia: 'VT-9004', tienda: 'voltra' },
    { id: 5, n_referencia: 'VT-9005', tienda: 'voltra', metodo_envio_nombre: METODO_ENVIO_RETIRO },
    { id: 6, n_referencia: '950', tienda: 'fw' },
    { id: 7, n_referencia: '951', tienda: 'fw' },
    { id: 8, n_referencia: '952' },                                // sin tienda = fw
  ]
  const salidasShopify = D.refsSalidasShopify([
    { nombre: '#9004', estado_envio: 'DESPACHADO' },
    { nombre: '#9003', estado_envio: 'EN_PREPARACION' },
  ])
  assert.deepEqual([...salidasShopify], ['VT-9004'])
  const ids = (l) => l.map(v => v.id)
  assert.deepEqual(ids(D.pendientesDesdeVentas(ventas, { tienda: 'voltra', enCourier, salidasShopify })), [3])
  assert.deepEqual(ids(D.pendientesDesdeVentas(ventas, { tienda: 'fw', enCourier, salidasShopify })), [7, 8])
  assert.deepEqual(ids(D.pendientesDesdeVentas(ventas, { tienda: 'todas', enCourier, salidasShopify })), [3, 7, 8])
  // despachado_at (escaneado) también afuera
  assert.deepEqual(ids(D.pendientesDesdeVentas([{ id: 9, n_referencia: '960', despachado_at: '2026-10-10T10:00:00Z' }], {})), [])
  assert.match(fuente, /\.is\('despachado_at', null\)/)
  assert.match(fuente, /tienda: getTienda\(\)/)
  ok('Desde Ventas: filtra tienda, despachado_at, fila real en entregas, DESPACHADO en Shopify y retiro en persona')

  // ── 2) Confirmar salida: sin falsos "olvidados" y cobro 0 si ya pagó ──
  const pend = (extra) => ({ estado: 'pendiente', despachado_at: null, ...extra })
  assert.equal(M.pendienteDeSalir(pend({ n_referencia: 'VT-9001' }), enCourier), false)
  assert.equal(M.pendienteDeSalir(pend({ n_referencia: 'VT-9003' }), enCourier), true)   // placeholder no cuenta
  assert.equal(M.pendienteDeSalir(pend({ n_referencia: 'VT-9010', metodo_envio_nombre: METODO_ENVIO_RETIRO }), enCourier), false)
  assert.equal(M.pendienteDeSalir({ ...pend({ n_referencia: 'VT-9011' }), estado: 'entregado' }, enCourier), false)
  assert.equal(M.totalACobrar([{ total: 129000 }, { total: 199000, pago_anticipado: true }, { total: '50000' }]), 179000)
  assert.equal(M.aCobrar({ total: 199000, pago_anticipado: true }), 0)
  assert.match(fuenteModal, /transportadora, tienda, pago_anticipado, metodo_envio_nombre/)
  assert.match(fuenteModal, /\.filter\(v => pendienteDeSalir\(v, enCourier\)\)/)
  assert.match(fuenteModal, /const totalCobrar = totalACobrar\(tanda\)/)
  ok('Confirmar salida: saca lo que ya está en entregas y el total a cobrar ignora los pagos anticipados')

  // ── 3) RETIRO_EN_CASA confirmado → venta sin courier ──
  assert.equal(esRetiroConfirmado('CONFIRMADO, RETIRO_EN_CASA'), true)
  assert.equal(esRetiroConfirmado('RETIRO_EN_CASA'), false)
  assert.equal(esRetiroConfirmado('CONFIRMADO, RETIRO_EN_CASA', '2026-10-10'), false)
  assert.equal(esRetiroConfirmado('CONFIRMADO, RETIRO_EN_CASA, CANCELADO'), false)
  const ret = D.mapearGrupoAPedidos([fila('#9017', 'CONFIRMADO, ORIGEN_WHATSAPP, RETIRO_EN_CASA', { 'Financial Status': 'paid', 'Fulfillment Status': 'fulfilled', Total: '120000', Subtotal: '120000', 'Lineitem quantity': '1' })])
  assert.equal(ret[0].retiroConfirmado, true)
  assert.equal(ret[0].cfg.despachar, false)          // en Despacho sigue sin poder salir por courier
  assert.equal(envioEntregado({ estado_envio: 'ENTREGADO' }), true)
  assert.equal(envioEntregado({ estado_envio: 'EN_PREPARACION' }), false)
  const sep = D.separarPedidosVoltra(ret, new Map([['VT-9017', { estado_envio: 'ENTREGADO' }]]))
  assert.equal(sep.retiros.length, 1); assert.equal(sep.listos.length, 0); assert.equal(sep.sinCobertura.length, 0)
  const vRet = D.filaVentaDePedido(sep.retiros[0], [])
  assert.equal(vRet.transportadora, 'otra')
  assert.equal(vRet.costo_envio, 0)
  assert.equal(vRet.estado, 'entregado')
  assert.equal(vRet.estado_releasit, 'confirmado')
  assert.equal(vRet.metodo_envio_nombre, METODO_ENVIO_RETIRO)
  assert.equal(vRet.pago_anticipado, false)          // 'paid' + fulfilled = cobrado al entregar, no prepago
  assert.equal(vRet.total, 120000)
  assert.equal(esRetiroEnPersona(vRet), true)
  const vRetPend = D.filaVentaDePedido(D.separarPedidosVoltra(ret, new Map()).retiros[0], [])
  assert.equal(vRetPend.estado, 'pendiente')
  assert.deepEqual(D.pendientesDesdeVentas([{ ...vRetPend, id: 1 }], {}), [])   // no va a planilla ni guías
  ok('RETIRO_EN_CASA confirmado: venta sin courier (otra, flete 0), entregada si Shopify dice ENTREGADO')

  // ── 4) Sin cobertura: no se inserta como PaP por defecto ──
  const sinCob = D.mapearGrupoAPedidos([fila('#9020', 'CONFIRMADO', { 'Shipping City': 'Pueblo Inventado Zzqx' })])
  assert.equal(sinCob[0].transportadora, null)
  assert.equal(sinCob[0].cfg.despachar, true)
  const sep2 = D.separarPedidosVoltra([...sinCob, ...D.mapearGrupoAPedidos([fila('#9021', 'CONFIRMADO')])])
  assert.deepEqual(sep2.sinCobertura.map(p => p.n_referencia), ['VT-9020'])
  assert.deepEqual(sep2.listos.map(p => p.n_referencia), ['VT-9021'])
  // 29-10: ya no es un aviso rojo "decidir a mano": va a "No sale hoy" con el motivo y quién lo resuelve.
  assert.match(fuente, /setVoltraNoSale\(noSale\)/)
  assert.match(fuente, /No sale hoy \(\{noSaleVentas\.length\}\)/)
  ok('Sin cobertura: queda afuera de Ventas, en "No sale hoy" con el motivo')

  // Abreviaturas generales en ciudades
  assert.equal(expandirAbreviaturas('cnel bogado'), 'coronel bogado')
  assert.equal(expandirAbreviaturas('gral diaz'), 'general diaz')
  assert.equal(expandirAbreviaturas('sta rita'), 'santa rita')
  assert.equal(tieneCobranzaPaP('Cnel. Bogado'), true)
  assert.equal(zonaPaP('Cnel. Bogado'), zonaPaP('Coronel Bogado'))
  assert.equal(emparejarCiudad('Cnel. Bogado', CIUDADES_PAP_LISTA), emparejarCiudad('Coronel Bogado', CIUDADES_PAP_LISTA))
  assert.deepEqual(sugerirTransportadora('Cnel. Bogado', 'Tiras nasales'), sugerirTransportadora('Coronel Bogado', 'Tiras nasales'))
  assert.equal(emparejarCiudad('Cnel Oviedo', CIUDADES_PAP_LISTA), 'coronel oviedo')
  assert.equal(emparejarCiudad('Sta. Rita', CIUDADES_PAP_LISTA), 'santa rita')
  assert.equal(emparejarCiudad('Pte. Franco', CIUDADES_PAP_LISTA), 'presidente franco')
  // "pte" también puede ser "puente": la expansión no inventa un "presidente kyjha" (queda como antes)
  assert.equal(emparejarCiudad('Pte. Kyjha', CIUDADES_PAP_LISTA), null)
  // 28-10: PaP ya no llega a Puente Kyjhá (avisó el 27-10): salió de la lista.
  assert.equal(emparejarCiudad('Puente Kyjha', CIUDADES_PAP_LISTA), null)
  assert.equal(emparejarCiudad('Mcal. Estigarribia', CIUDADES_PAP_LISTA), 'mariscal estigarribia')
  assert.equal(emparejarCiudad('Asunción', CIUDADES_PAP_LISTA), 'asuncion')
  ok('Ciudades: "Cnel. Bogado" empareja igual que "Coronel Bogado" (cnel/gral/pte/sta en general)')

  // ── 5) precio_unit = total / cantidad ──
  assert.equal(D.filaVentaDePedido({ total: 240000, cantidad: 2, transportadora: 'pap', ciudad: 'Asunción' }, []).precio_unit, 120000)
  assert.equal(D.filaVentaDePedido({ total: 100000, cantidad: 3, transportadora: 'pap', ciudad: 'Asunción' }, []).precio_unit, 33333)
  assert.equal(D.filaVentaDePedido({ total: 129000, transportadora: 'pap', ciudad: 'Asunción' }, []).precio_unit, 129000)
  assert.equal(D.filaVentaDePedido({ total: 240000, cantidad: 2, transportadora: 'pap', ciudad: 'Asunción' }, []).total, 240000)
  ok('filaVentaDePedido: precio_unit es unitario y total sigue siendo el total')

  // ── 6) Pago anticipado: misma regla en CSV y en "Traer pedidos de Voltra" ──
  assert.equal(esPagoAnticipado({ financial: 'paid', fulfillment: 'fulfilled', tags: 'CONFIRMADO, ENTREGADO' }), false)  // COD entregado
  assert.equal(esPagoAnticipado({ financial: 'paid', fulfillment: '', tags: 'CONFIRMADO' }), true)                       // pagó antes de preparar
  assert.equal(esPagoAnticipado({ financial: 'paid', fulfillment: 'unfulfilled', tags: '' }), true)
  assert.equal(esPagoAnticipado({ financial: 'pending', fulfillment: 'fulfilled', tags: 'PAGO_VERIFICADO' }), true)
  assert.equal(esPagoAnticipado({ financial: 'paid', fulfillment: 'fulfilled', tags: 'PAGO_ANTICIPADO_COMPROBANTE' }), true)
  assert.equal(esPagoAnticipado({ financial: 'pending', fulfillment: '', tags: 'PAGO_ANTICIPADO_COMPROBANTE' }), false)
  assert.equal(esPagoAnticipado({ financial: 'pending', fulfillment: '', tags: 'OFERTA_PAGO_ANTICIPADO' }), false)
  const csvCod = D.mapearGrupoAPedidos([fila('#9007', 'CONFIRMADO, ENTREGADO', { 'Financial Status': 'paid', 'Fulfillment Status': 'fulfilled' })])[0]
  assert.equal(csvCod.pagadoShopify, false)
  const csvPre = D.mapearGrupoAPedidos([fila('#9008', 'CONFIRMADO', { 'Financial Status': 'paid', 'Fulfillment Status': 'unfulfilled' })])[0]
  assert.equal(csvPre.pagadoShopify, true)
  // Botón: la fila de shopify_pedidos trae financial/fulfillment y da lo mismo que el CSV
  const raw = (fs, ff, tags) => ({ raw: { name: '#9030', created_at: '2026-10-12T10:00:00-03:00', tags, financial_status: fs, fulfillment_status: ff,
    total_price: '129000', subtotal_price: '129000', shipping_address: { name: 'Cliente Prueba', city: 'Asunción', address1: 'Calle Inventada 1', phone: '0981000000' },
    line_items: [{ name: 'Tiras nasales', quantity: 1, price: '129000', vendor: 'VOLTRA PARAGUAY' }] } })
  const viaBoton = (fs, ff, tags) => D.agruparFilasPorReferencia(filasCsvDesdePedidoShopify(raw(fs, ff, tags))).flatMap(D.mapearGrupoAPedidos)[0].pagadoShopify
  assert.equal(viaBoton('paid', 'fulfilled', 'CONFIRMADO, ENTREGADO'), false)
  assert.equal(viaBoton('paid', null, 'CONFIRMADO'), true)
  assert.equal(viaBoton('pending', 'fulfilled', 'CONFIRMADO, PAGO_VERIFICADO'), true)
  assert.equal(viaBoton('pending', null, 'CONFIRMADO'), false)
  // El UPDATE de prepago de ventas ya cargadas: por tienda y revisando el error
  assert.match(fuente, /\.eq\('tienda', t\)\.in\('n_referencia', \[\.\.\.refsT\]\)\.is\('deleted_at', null\)/)
  assert.match(fuente, /if \(errPre\) \{/)
  ok('Pago anticipado: solo PAGO_VERIFICADO, comprobante + paid, o paid sin preparar; UPDATE por tienda y con error revisado')
} finally {
  for (const f of [copia, salida, salidaModal]) { try { rmSync(f) } catch { /* nada */ } }
}
console.log(`\n${n} bloques OK`)
