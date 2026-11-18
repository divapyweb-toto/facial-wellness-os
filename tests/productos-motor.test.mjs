// Motor financiero del módulo de productos (dinero.js + motor.js).
// Correr: node --import ./tests/registrar.mjs tests/productos-motor.test.mjs
// Datos inventados (DEMO) salvo el bloque "caso real Voltra", marcado
// "referencia 18-11, verificar".
import { test } from 'node:test'
import assert from 'node:assert/strict'
import { aMenor, deMenor, convertirAPYG, redondear, formatoPYG, formatoMoneda, escalarTC } from '../src/lib/productos/dinero.js'
import {
  costoPuesto, contribucionPorPedido, ramasDesdeTasas, escenarios, sensibilidad, caja, flujoPiloto,
  unidadesDesdeCajas, cajasParaUnidades, pesoCobrable, asignarPorBase, lineasDeRuta, PLANTILLAS_RUTA,
  contribucionCohorte, adsPorConfirmadoDesdeIniciado, adsPorIniciadoDesdeConfirmado, evaluar,
} from '../src/lib/productos/motor.js'

const cerca = (a, b, tol, msg) => assert.ok(Math.abs(a - b) <= tol, `${msg}: ${a} vs ${b} (tolerancia ${tol})`)

// ───────────────────────── monedas ─────────────────────────
test('monedas: unidades menores por moneda y conversión exacta con tipo de cambio explícito', () => {
  assert.equal(aMenor('123.45', 'USD'), 12345)
  assert.equal(aMenor('12.3', 'CNY'), 1230)
  assert.equal(aMenor(158000, 'PYG'), 158000)
  assert.equal(deMenor(12345, 'USD'), 123.45)
  assert.throws(() => aMenor('1.234', 'USD'), /más de 2 decimales/)
  assert.throws(() => aMenor('100', 'EUR'), /Moneda desconocida/)
  // 1 USD = 7350.5 PYG → USD 123,45 = 907.419,225 → ₲907.419
  assert.equal(convertirAPYG(12345, 'USD', '7350.5').pyg, 907419)
  // Mitad exacta: USD 0,01 a 50 PYG = ₲0,5 → ₲1 (lejos del cero)
  assert.equal(convertirAPYG(1, 'USD', '50').pyg, 1)
  assert.equal(convertirAPYG(-1, 'USD', '50').pyg, -1)
  // 1 CNY = 1020.123456 PYG → CNY 10,00 = 10.201,23 → ₲10.201
  assert.equal(convertirAPYG(1000, 'CNY', '1020.123456').pyg, 10201)
  assert.throws(() => convertirAPYG(1000, 'USD', null), /Falta el tipo de cambio/)
  assert.throws(() => convertirAPYG(1000, 'PYG', '7000'), /no lleva tipo de cambio/)
  assert.throws(() => convertirAPYG(10.5, 'USD', '7000'), /entero/)
  assert.throws(() => convertirAPYG(100, 'USD', '7000.1234567'), /más de 6 decimales/)
  assert.equal(escalarTC('7350.5', '1.1'), '8085.550000')
})

test('redondeo documentado (mitad lejos del cero) y formato ₲ con punto de miles', () => {
  assert.equal(redondear(1.5), 2)
  assert.equal(redondear(-1.5), -2)
  assert.equal(redondear(2.4999999999), 2)
  assert.equal(redondear(0.1 + 0.2 - 0.3), 0)
  assert.equal(redondear(1.0000000000000002 * 2.5), 3, 'ruido de float no cambia la mitad')
  assert.equal(formatoPYG(158000), '₲158.000')
  assert.equal(formatoPYG(-4707), '−₲4.707')
  assert.equal(formatoPYG(1234567), '₲1.234.567')
  assert.equal(formatoPYG(null), 'desconocido')
  assert.equal(formatoMoneda(12345, 'USD'), 'USD 123,45')
})

// ───────────────────────── costo puesto ─────────────────────────
const TC = '7300' // DEMO: 1 USD = 7300 PYG
const loteDemo = () => ([
  { concepto: 'Mercadería', monto_minor: 10000, moneda: 'USD', tc_a_pyg: TC, recuperable: false, desembolso: true, factura_a_nombre_voltra: true },     // USD 100
  { concepto: 'Flete interno China', monto_minor: 7000, moneda: 'CNY', tc_a_pyg: '1000', recuperable: false, desembolso: true },                       // CNY 70
  { concepto: 'Retiro en CDE', monto_minor: 50000, moneda: 'PYG', recuperable: false, desembolso: true },
])

test('costo puesto: varias monedas, total y por unidad vendible', () => {
  const r = costoPuesto(loteDemo(), { unidadesCompradas: 100, unidadesVendibles: 100 })
  assert.equal(r.totalPYG, 730000 + 70000 + 50000)
  assert.equal(r.porUnidadVendible, 8500)
  assert.equal(r.desembolsoPYG, 850000)
  assert.deepEqual(r.entradas.lineas, loteDemo(), 'guarda sus entradas')
  assert.equal(r.detalle[0].pyg, 730000)
})

test('IVA recuperable vs no recuperable (A4: solo con factura a nombre de Voltra)', () => {
  const iva = (extra) => ({ concepto: 'IVA importación', monto_minor: 85000, moneda: 'PYG', recuperable: true, desembolso: true, ...extra })
  const con = costoPuesto([...loteDemo(), iva({ factura_a_nombre_voltra: true })], { unidadesCompradas: 100, unidadesVendibles: 100 })
  assert.equal(con.totalPYG, 850000, 'IVA recuperable con factura: NO es costo')
  assert.equal(con.desembolsoPYG, 935000, '...pero sí desembolso')
  assert.equal(con.ivaRecuperablePYG, 85000)

  const sin = costoPuesto([...loteDemo(), iva({ factura_a_nombre_voltra: false })], { unidadesCompradas: 100, unidadesVendibles: 100 })
  assert.equal(sin.totalPYG, 935000, 'sin factura a nombre de Voltra el IVA es costo')
  assert.equal(sin.ivaRecuperablePYG, 0)
  assert.ok(sin.avisos.some(a => /stock sin factura no deducible/.test(a)))

  const sinDato = costoPuesto([...loteDemo(), iva({})], { unidadesCompradas: 100, unidadesVendibles: 100 })
  assert.equal(sinDato.totalPYG, 935000, 'sin confirmar factura: se trata como costo (no se supone que se recupera)')
  assert.ok(sinDato.avisos.some(a => /falta confirmar factura/.test(a)))

  const noRec = costoPuesto([...loteDemo(), { concepto: 'IVA no recuperable', monto_minor: 85000, moneda: 'PYG', recuperable: false }], { unidadesCompradas: 100, unidadesVendibles: 100 })
  assert.equal(noRec.totalPYG, 935000)
})

test('flete incluido: no se cobra dos veces', () => {
  const sinLinea = costoPuesto(loteDemo().slice(0, 1), { unidadesCompradas: 10, unidadesVendibles: 10 })
  const incluido = costoPuesto([
    ...loteDemo().slice(0, 1),
    { concepto: 'Flete internacional', monto_minor: 2000, moneda: 'USD', tc_a_pyg: TC, incluido_en: 'Mercadería' },
  ], { unidadesCompradas: 10, unidadesVendibles: 10 })
  assert.equal(incluido.totalPYG, sinLinea.totalPYG)
  assert.equal(incluido.detalle[1].pyg, 0)
  assert.match(incluido.detalle[1].tratamiento, /no se suma/)
  assert.throws(() => costoPuesto([{ concepto: 'Flete', monto_minor: 1, moneda: 'PYG', incluido_en: 'No existe' }], { unidadesCompradas: 1, unidadesVendibles: 1 }), /no existe/)
})

test('unidades vendibles: la merma sube el costo por unidad vendible', () => {
  const ok = costoPuesto(loteDemo(), { unidadesCompradas: 100, unidadesVendibles: 100 })
  const merma = costoPuesto(loteDemo(), { unidadesCompradas: 100, unidadesVendibles: 85 })
  assert.equal(merma.totalPYG, ok.totalPYG, 'el total del lote no cambia')
  assert.equal(merma.porUnidadVendible, redondear(850000 / 85)) // 10.000
  assert.equal(merma.porUnidadComprada, 8500)
  assert.equal(merma.merma.unidades, 15)
  assert.throws(() => costoPuesto(loteDemo(), { unidadesCompradas: 10, unidadesVendibles: 11 }), /no pueden ser más/)
  assert.throws(() => costoPuesto(loteDemo(), { unidadesCompradas: 10 }), /unidadesVendibles/)
})

test('unidades y cajas, peso cobrable y reparto de un lote mixto', () => {
  assert.equal(unidadesDesdeCajas(10, 100), 1000)
  assert.deepEqual(cajasParaUnidades(250, 100), { cajas: 3, unidadesEnviadas: 300, sobrante: 50 })
  // Caja DEMO 50×37×17 cm, 7 kg: con divisor 6000 el volumétrico es 5,24 kg → manda el real.
  const p = pesoCobrable({ pesoBrutoG: 7000, medidasCm: [50, 37, 17], divisor: 6000 })
  assert.equal(p.base, 'real')
  assert.equal(p.pesoCobrableKg, 7)
  const liviano = pesoCobrable({ pesoBrutoG: 2000, medidasCm: [50, 37, 17], divisor: 5000, cajas: 2 })
  assert.equal(liviano.base, 'volumetrico')
  cerca(liviano.pesoCobrableKg, 12.58, 1e-9, 'volumétrico de 2 cajas')
  assert.throws(() => pesoCobrable({ pesoBrutoG: 7000, medidasCm: [50, 37, 17] }), /divisor/)
  const rep = asignarPorBase(100001, [{ id: 'a', peso: 1 }, { id: 'b', peso: 1 }, { id: 'c', peso: 1 }], 'peso')
  assert.equal(rep.reduce((s, x) => s + x.pyg, 0), 100001, 'el reparto suma exacto el total')
  assert.throws(() => asignarPorBase(1, [{ peso: 1 }], 'color'), /Base de asignación/)
})

test('costo desconocido: con rango da rango; sin rango es error claro', () => {
  const lineas = [...loteDemo(), { concepto: 'Despacho', monto_minor: null, moneda: 'PYG', rango: { min_minor: 100000, max_minor: 300000 } }]
  const r = costoPuesto(lineas, { unidadesCompradas: 100, unidadesVendibles: 100 })
  assert.equal(r.totalPYG, null)
  assert.deepEqual(r.rango.porUnidadVendible, { min: 9500, max: 11500 })
  assert.throws(() => costoPuesto([...loteDemo(), { concepto: 'Despacho', monto_minor: null, moneda: 'PYG' }], { unidadesCompradas: 1, unidadesVendibles: 1 }), /costo crítico desconocido/)
})

// ───────────────────────── plantillas de ruta (A6) ─────────────────────────
test('plantillas de ruta: avión Easybox por kg, barco desconocido, local CDE sin flete internacional', () => {
  const av = lineasDeRuta('avion_easybox', { pesoCobrableKg: 5, tcAPyg: TC })
  assert.equal(av[0].monto_minor, 19000, '5 kg × USD 38 = USD 190 (tarifa de referencia)')
  assert.match(av[0].fuente, /verificar/)
  assert.equal(av[0].fecha, '2026-11-18')
  assert.match(PLANTILLAS_RUTA.avion_easybox.estado, /verificar/)
  const barco = lineasDeRuta('barco_easybox', { tcAPyg: TC })
  assert.equal(barco[0].monto_minor, null)
  assert.throws(() => costoPuesto([...loteDemo(), ...barco], { unidadesCompradas: 100, unidadesVendibles: 100 }), /costo crítico desconocido/)
  const barcoRango = lineasDeRuta('barco_easybox', { tcAPyg: TC, rango: { min_minor: 5000, max_minor: 20000 } })
  assert.ok(costoPuesto([...loteDemo(), ...barcoRango], { unidadesCompradas: 100, unidadesVendibles: 100 }).rango)
  const local = lineasDeRuta('local_cde')
  assert.equal(local[0].monto_minor, 0)
  const editada = lineasDeRuta('avion_easybox', { pesoCobrableKg: 10, tcAPyg: TC, sobreescribir: { tarifa: { monto: '40', moneda: 'USD' }, fuente: 'cotización nueva DEMO', fecha: '2026-12-01' } })
  assert.equal(editada[0].monto_minor, 40000)
  assert.equal(editada[0].estado, 'editada')
  assert.throws(() => lineasDeRuta('tren'), /desconocida/)
})

// ───────────────────────── contribución ─────────────────────────
const baseDemo = () => ({
  precio: 110000, ivaPct: 10, costoUnit: 10000, unidadesPorPedido: 2, flete: 30000, costoBot: 1000,
  ramas: { cancelado: 0.1, fallida: 0.1, entregado: 0.75, devuelto: 0.05 },
  recuperaFallida: true, perdidaDevuelto: 5000, adsPorPedidoIniciado: 20000,
})

test('ramas: tienen que sumar 1; faltantes y datos críticos dan error claro', () => {
  assert.throws(() => contribucionPorPedido({ ...baseDemo(), ramas: { cancelado: 0.1, fallida: 0.1, entregado: 0.7, devuelto: 0.05 } }), /tienen que sumar 1 y suman 0\.95/)
  assert.throws(() => contribucionPorPedido({ ...baseDemo(), ramas: { cancelado: 0.1, fallida: 0.1, entregado: 0.8, perdido: 0 } }), /Rama desconocida/)
  assert.throws(() => contribucionPorPedido({ ...baseDemo(), precio: undefined }), /Falta el dato crítico "precio"/)
  assert.throws(() => contribucionPorPedido({ ...baseDemo(), recuperaFallida: undefined }), /recuperaFallida/)
  assert.throws(() => contribucionPorPedido({ ...baseDemo(), flete: 30000.5 }), /enteros/)
  assert.throws(() => contribucionPorPedido({ ...baseDemo(), adsPorConfirmado: 1 }), /dos veces/)
  const r = ramasDesdeTasas({ confirmacion: 0.9, entrega: 0.8, devolucion: 0.1 })
  cerca(r.cancelado + r.fallida + r.entregado + r.devuelto, 1, 1e-12, 'ramas desde tasas suman 1')
})

test('ramas: no duplican COGS ni ads, y cada rama paga lo que corresponde', () => {
  const r = contribucionPorPedido(baseDemo())
  const R = Object.fromEntries(r.detalleRamas.map(x => [x.rama, x]))
  assert.deepEqual(R.cancelado.costos, { producto: 0, flete: 0, bot: 1000, perdida: 0 }, 'cancelado: sin flete ni producto')
  assert.deepEqual(R.fallida.costos, { producto: 0, flete: 30000, bot: 1000, perdida: 0 }, 'fallida recuperada: flete sí, producto vuelve')
  assert.deepEqual(R.entregado.costos, { producto: 20000, flete: 30000, bot: 1000, perdida: 0 })
  assert.deepEqual(R.devuelto.costos, { producto: 0, flete: 30000, bot: 1000, perdida: 5000 })
  assert.equal(R.entregado.ingresoNeto, 100000, 'ingreso sin IVA: 110.000 × 100/110')
  assert.equal(R.devuelto.ingresoNeto, 0, 'devuelto: se reembolsa, no queda ingreso')
  // A mano: 0,75×(100.000−51.000) + 0,1×(−31.000) + 0,05×(−36.000) + 0,1×(−1.000) = 36.750 − 3.100 − 1.800 − 100 = 31.750
  assert.equal(r.porIniciado.contribucionAntesAds, 31750)
  assert.equal(r.porIniciado.contribucionDespuesAds, 11750, 'ads restados UNA vez, por pedido iniciado')
  assert.equal(r.porIniciado.costoAdsMaximo, 31750)
  assert.equal(r.ivaDebitoEsperadoPorIniciado, 7500, 'IVA solo de los entregados')
  // COGS total esperado = solo la rama entregado
  const cogs = r.detalleRamas.reduce((s, x) => s + x.probabilidad * x.costos.producto, 0)
  assert.equal(cogs, 0.75 * 20000)
})

test('flete y ads NO se multiplican por la tasa de entrega (fórmula COD)', () => {
  const t = (entrega) => contribucionPorPedido({ ...baseDemo(), ramas: undefined, tasas: { confirmacion: 1, entrega }, perdidaDevuelto: 0 })
  const a = t(0.9), b = t(0.8)
  // Bajar la entrega 10 puntos solo quita 0,1 × (ingreso neto − producto) = 0,1 × 80.000; el flete (30.000) y los ads siguen enteros.
  assert.equal(a.porIniciado.contribucionAntesAds - b.porIniciado.contribucionAntesAds, 8000)
  assert.equal(a.porIniciado.contribucionAntesAds, redondear(0.9 * (100000 - 20000) - 30000 - 1000))
})

test('entrega fallida con y sin recuperación de mercadería', () => {
  const rec = contribucionPorPedido(baseDemo())
  const sin = contribucionPorPedido({ ...baseDemo(), recuperaFallida: false })
  assert.equal(rec.porIniciado.contribucionAntesAds - sin.porIniciado.contribucionAntesAds, 0.1 * 20000, 'diferencia = p(fallida) × mercadería perdida')
})

test('devolución con pérdida', () => {
  const sinPerdida = contribucionPorPedido({ ...baseDemo(), perdidaDevuelto: 0 })
  const conPerdida = contribucionPorPedido({ ...baseDemo(), perdidaDevuelto: 40000 })
  assert.equal(sinPerdida.porIniciado.contribucionAntesAds - conPerdida.porIniciado.contribucionAntesAds, 0.05 * 40000)
  const sinDato = contribucionPorPedido({ ...baseDemo(), perdidaDevuelto: undefined })
  assert.ok(sinDato.avisos.some(a => /perdidaDevuelto/.test(a)))
})

test('contribución cero y negativa', () => {
  const cero = contribucionPorPedido({ precio: 100000, ivaPct: 0, costoUnit: 50000, unidadesPorPedido: 1, flete: 50000, costoBot: 0, ramas: { cancelado: 0, fallida: 0, entregado: 1, devuelto: 0 }, recuperaFallida: true, adsPorPedidoIniciado: 0 })
  assert.equal(cero.porIniciado.contribucionAntesAds, 0)
  assert.equal(cero.porIniciado.contribucionDespuesAds, 0)
  assert.equal(cero.porIniciado.costoAdsMaximo, 0)
  const neg = contribucionPorPedido({ ...baseDemo(), adsPorPedidoIniciado: 50000 })
  assert.equal(neg.porIniciado.contribucionDespuesAds, 31750 - 50000)
  assert.ok(neg.porIniciado.contribucionDespuesAds < 0)
  const objetivo = contribucionPorPedido({ ...baseDemo(), contribucionObjetivo: 10000 })
  assert.equal(objetivo.porIniciado.costoAdsMaximo, 21750, 'máximo de ads para dejar ₲10.000 por iniciado')
})

test('A9: dos denominadores con conversión explícita, sin mezclar', () => {
  const r = contribucionPorPedido(baseDemo())
  assert.equal(r.porConfirmado.ads, redondear(20000 / 0.9))
  assert.equal(adsPorConfirmadoDesdeIniciado(20000, 0.1), 20000 / 0.9)
  assert.equal(adsPorIniciadoDesdeConfirmado(20000 / 0.9, 0.1), 20000)
  cerca(r.porConfirmado.contribucionDespuesAds * 0.9, r.porIniciado.contribucionDespuesAdsExacta, 1, 'vista confirmado × (1 − cancelado) = vista iniciado')
  assert.equal(r.porIniciado.denominador, 'pedido iniciado')
  // Sin tasa de confirmado de Voltra el denominador se rotula como lo que es: despachado (hallazgo 3).
  assert.match(r.porConfirmado.denominador, /^pedido despachado/)
  assert.match(contribucionPorPedido({ ...baseDemo(), canceladoTrasConfirmar: 0.05 }).porConfirmado.denominador, /^pedido confirmado \(Voltra/)
  // Pasar el costo por confirmado da el mismo resultado que pasar el equivalente por iniciado.
  const desdeConf = contribucionPorPedido({ ...baseDemo(), adsPorPedidoIniciado: undefined, adsPorConfirmado: 20000 / 0.9 })
  assert.equal(desdeConf.porIniciado.contribucionDespuesAds, r.porIniciado.contribucionDespuesAds)
  assert.throws(() => adsPorConfirmadoDesdeIniciado(1, 1), /100% cancelado/)
})

test('conciliación con el total de una cohorte (mismo set de pedidos)', () => {
  const pedidos = []
  const add = (n, p) => { for (let i = 0; i < n; i++) pedidos.push({ ...p }) }
  add(10, { rama: 'cancelado', costoBot: 1000 })
  add(10, { rama: 'fallida', flete: 30000, costoBot: 1000, costoProducto: 0 })
  add(75, { rama: 'entregado', precio: 110000, flete: 30000, costoBot: 1000, costoProducto: 20000 })
  add(5, { rama: 'devuelto', flete: 30000, costoBot: 1000, perdida: 5000 })
  const gastoAds = 2000000
  const coh = contribucionCohorte(pedidos, { ivaPct: 10, gastoAds })
  const motor = contribucionPorPedido({ ...baseDemo(), ramas: coh.ramas, adsPorPedidoIniciado: gastoAds / coh.pedidosIniciados })
  cerca(motor.porIniciado.contribucionAntesAdsExacta * coh.pedidosIniciados, coh.contribucionAntesAdsTotalExacta, 1e-6, 'antes de ads: motor × N = cohorte')
  cerca(motor.porIniciado.contribucionDespuesAdsExacta * coh.pedidosIniciados, coh.contribucionDespuesAdsTotal, 1, 'después de ads: motor × N = cohorte')
  assert.equal(coh.contribucionDespuesAdsTotal, 3175000 - 2000000)
})

// ───────────────────────── escenarios y sensibilidad ─────────────────────────
const baseConLote = () => ({
  ...baseDemo(), costoUnit: undefined,
  ramas: undefined, tasas: { confirmacion: 0.9, entrega: 0.85, devolucion: 0 },
  lote: { lineas: loteDemo(), unidadesCompradas: 100, unidadesVendibles: 100 },
  fuentes: ['DEMO'],
})

test('escenarios reproducibles: mismas entradas → misma salida; cambian con costo, cambio, entrega y ads', () => {
  const cambios = {
    adverso: { tc: { USD: '8000' }, tasas: { entrega: 0.75 }, adsPorPedidoIniciado: 30000, fuentes: ['DEMO adverso'] },
    favorable: { tasas: { entrega: 0.92 }, adsPorConfirmado: 15000, fuentes: ['DEMO favorable'] },
  }
  const a = escenarios(baseConLote(), cambios)
  const b = escenarios(baseConLote(), cambios)
  assert.deepEqual(a, b, 'determinista')
  assert.equal(a.base.resumen.costoUnit, 8500)
  assert.equal(a.adverso.resumen.costoUnit, redondear((800000 + 70000 + 50000) / 100), 'tipo de cambio más alto sube el costo puesto')
  assert.ok(a.adverso.resumen.porIniciado.despuesAds < a.base.resumen.porIniciado.despuesAds)
  assert.ok(a.favorable.resumen.porIniciado.despuesAds > a.base.resumen.porIniciado.despuesAds)
  assert.deepEqual(a.adverso.fuentes, ['DEMO adverso'])
  assert.ok(!JSON.stringify(a).toLowerCase().includes('realista'))
  assert.equal(a.adverso.entradas.adsPorConfirmado, undefined, 'cambiar el denominador de ads no deja los dos')
})

test('sensibilidad: impacto ordenado; ramas sueltas rechazadas; tasas recortadas a [0,1]', () => {
  const s = sensibilidad(baseConLote(), ['precio', 'tasas.entrega', 'tc:USD', 'lote.unidadesVendibles', 'adsPorPedidoIniciado'], [-0.2, 0.2])
  assert.equal(s.filas.length, 10)
  assert.equal(s.impacto[0].variable, 'precio')
  const entregaAlta = s.filas.find(f => f.variable === 'tasas.entrega' && f.paso === 0.2)
  assert.equal(entregaAlta.valor, 1)
  assert.equal(entregaAlta.recortado, true)
  assert.throws(() => sensibilidad({ ...baseDemo() }, ['ramas.entregado'], [0.1]), /no se varían de a una/)
  assert.throws(() => sensibilidad(baseConLote(), ['color'], [0.1]), /desconocida/)
  const otra = sensibilidad(baseConLote(), ['precio', 'tasas.entrega', 'tc:USD', 'lote.unidadesVendibles', 'adsPorPedidoIniciado'], [-0.2, 0.2])
  assert.deepEqual(s, otra)
})

test('evaluar con costo desconocido exige elegir mínimo o máximo del rango', () => {
  const b = baseConLote()
  b.lote.lineas.push({ concepto: 'Despacho', monto_minor: null, moneda: 'PYG', rango: { min_minor: 0, max_minor: 200000 } })
  assert.throws(() => evaluar(b), /usarRango/)
  assert.equal(evaluar({ ...b, usarRango: 'max' }).contribucion.entradas.costoUnit, 10500)
})

// ───────────────────────── caja ─────────────────────────
test('caja: necesidad, pico negativo y días de recuperación (sin anualizar)', () => {
  const r = caja({
    muestras: 300000,
    primerLote: [{ dia: 5, monto: 2000000 }],
    publicidad: [{ dia: 10, monto: 500000 }, { dia: 20, monto: 500000 }],
    calendario: { cobros: [{ dia: 25, monto: 1500000 }, { dia: 40, monto: 2500000 }] },
  })
  assert.equal(r.necesidadCaja, 3300000)
  assert.equal(r.picoNegativo, -3300000)
  assert.equal(r.diaPico, 20)
  assert.equal(r.diaRecuperacion, 40)
  assert.equal(r.diasRecuperacion, 40)
  assert.equal(r.totales.neto, 700000)
  const noRecupera = caja({ primerLote: 1000000, calendario: { cobros: [{ dia: 30, monto: 400000 }] } })
  assert.equal(noRecupera.recupera, false)
  assert.equal(noRecupera.diaRecuperacion, null)
  assert.throws(() => caja({ inventario: 1 }), /desconocida/)
  assert.throws(() => caja({ primerLote: 10.5 }), /enteros/)
})

test('flujo de piloto: cobros solo de entregados, flete de despachados, ads de iniciados', () => {
  const f = flujoPiloto({ dias: 10, pedidosIniciadosPorDia: 2, tasas: { confirmacion: 0.9, entrega: 0.8 }, precio: 158000, flete: 30000, adsPorPedidoIniciado: 25000, diasHastaCobro: 4 })
  assert.equal(f.cobros[0].dia, 4)
  assert.equal(f.cobros[0].monto, redondear(2 * 0.72 * 158000))
  assert.equal(f.logistica[0].monto, redondear(2 * 0.9 * 30000))
  assert.equal(f.publicidad[0].monto, 50000)
  const r = caja({ primerLote: 500000, publicidad: f.publicidad, logistica: f.logistica, calendario: { cobros: f.cobros } })
  assert.ok(r.necesidadCaja > 500000)
  assert.ok(r.recupera)
})

// ───────────────────────── caso de pedido DEMO (números inventados; el repo es público) ─────────────────────────
// Fórmula COD por confirmado: entrega × (precio ÷ 1,1 − producto) − flete − ads/confirmado (fallida recuperable).
const WA_DEMO = { // DEMO
  ivaPct: 10, flete: 30000, costoBot: 0, recuperaFallida: true,
  tasas: { confirmacion: 0.9, entrega: 0.85 }, adsPorConfirmado: 25000,
}

test('caso DEMO: 2 unidades a ₲150.000 reproduce la fórmula COD por confirmado', () => {
  const r = contribucionPorPedido({ ...WA_DEMO, precio: 150000, costoUnit: 10000, unidadesPorPedido: 2 })
  // 0,85 × (150.000/1,1 − 20.000) − 30.000 − 25.000 = ₲43.909
  assert.equal(r.porConfirmado.contribucionDespuesAds, 43909)
  assert.equal(r.porConfirmado.costoAdsMaximo, 68909, 'equilibrio de ads por confirmado')
  assert.equal(r.porIniciado.ads, 22500, 'ads por iniciado = por confirmado × tasa de despacho')
  assert.equal(r.porConfirmado.base, 'despacho')
  assert.ok(r.avisos.some(a => /canceladoTrasConfirmar/.test(a)), 'avisa que falta la tasa de confirmado de Voltra')
  const caro = contribucionPorPedido({ ...WA_DEMO, precio: 150000, costoUnit: 25000, unidadesPorPedido: 2 })
  assert.equal(caro.porConfirmado.contribucionDespuesAds, 18409)
})

// Revisión adversarial 18-11, hallazgo 3: el "confirmado" de Voltra incluye a los que confirman y después
// cancelan. Convertir el costo por confirmado con la tasa de despacho subestima los ads e infla la ganancia.
test('confirmado de Voltra: con canceladoTrasConfirmar los ads por iniciado suben y la ganancia baja', () => {
  const sin = contribucionPorPedido({ ...WA_DEMO, precio: 150000, costoUnit: 10000, unidadesPorPedido: 2 })
  const con = contribucionPorPedido({ ...WA_DEMO, precio: 150000, costoUnit: 10000, unidadesPorPedido: 2, canceladoTrasConfirmar: 0.05 })
  // confirmación Voltra = 0,9 ÷ 0,95 = 0,947368
  assert.equal(con.porConfirmado.base, 'voltra')
  assert.equal(con.porIniciado.ads, 23684, '25.000 × 0,947368')
  assert.equal(con.porIniciado.contribucionAntesAds, sin.porIniciado.contribucionAntesAds, 'las ramas (despacho) no cambian')
  assert.equal(con.porConfirmado.contribucionDespuesAds, 40464)
  assert.ok(con.porConfirmado.contribucionDespuesAds < sin.porConfirmado.contribucionDespuesAds)
  assert.equal(con.avisos.length, 0)
  // ads por iniciado ÷ confirmación Voltra = ads por confirmado (sin mezclar denominadores)
  cerca(con.porIniciado.ads / (0.9 / 0.95), 25000, 1, 'conversión ida y vuelta')
  // con 0 = misma conversión que la tasa de despacho
  const cero = contribucionPorPedido({ ...WA_DEMO, precio: 150000, costoUnit: 10000, unidadesPorPedido: 2, canceladoTrasConfirmar: 0 })
  assert.equal(cero.porConfirmado.contribucionDespuesAds, sin.porConfirmado.contribucionDespuesAds)
  assert.throws(() => contribucionPorPedido({ ...WA_DEMO, precio: 150000, costoUnit: 10000, unidadesPorPedido: 2, canceladoTrasConfirmar: 1 }), /menor que 1/)
  assert.throws(() => contribucionPorPedido({ ...WA_DEMO, precio: 150000, costoUnit: 10000, unidadesPorPedido: 2, canceladoTrasConfirmar: 0.2 }), /más de 100%/)
})
