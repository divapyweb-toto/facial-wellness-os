// Rúbrica, bloqueos duros y decisión sugerida del módulo de productos.
// Correr: node --import ./tests/registrar.mjs tests/productos-rubrica.test.mjs
// Casos inventados (DEMO).
import { test } from 'node:test'
import assert from 'node:assert/strict'
import { bloqueosDuros, puntaje, decisionSugerida, PESOS_INICIALES, ESTADOS } from '../src/lib/productos/rubrica.js'

// Caso "todo en orden" para comprar la muestra; cada prueba rompe una cosa.
const casoOk = (extra = {}) => ({
  compromiso: 'PROBAR_MUESTRA',
  presupuesto: { disponible: 500000, requerido: 200000 },
  contribucion: { valor: 30000, validada: false, denominador: 'confirmado' },
  costosDesconocidos: [],
  importacion: { requerida: false, verificada: false },
  muestra: { estado: 'PENDIENTE' },
  abastecimiento: { proveedoresDisponibles: 2 },
  evidencia: { ofertasComparables: 5, vendedoresIndependientes: 3, cotizacionesFirmes: 1, pilotoMaduro: false },
  semaforoCaja: 'VERDE',
  proveedorFactura: true,
  ...extra,
})
const codigos = (r) => r.bloqueos.map(b => b.codigo)

test('caso en orden: sin bloqueos para comprar la muestra', () => {
  const r = bloqueosDuros(casoOk())
  assert.deepEqual(r.bloqueos, [])
  assert.equal(r.bloqueaCompra, false)
  assert.deepEqual(r.entradas, casoOk(), 'guarda sus entradas')
})

test('cada bloqueo duro de la especificación', () => {
  assert.deepEqual(codigos(bloqueosDuros(casoOk({ presupuesto: { disponible: 100000, requerido: 200000 } }))), ['presupuesto_excedido'])
  assert.deepEqual(codigos(bloqueosDuros(casoOk({ presupuesto: null }))), ['presupuesto_excedido'], 'sin presupuesto definido no se compra')
  assert.deepEqual(codigos(bloqueosDuros(casoOk({ costosDesconocidos: [{ concepto: 'Despacho', maximoPorPedido: null }] }))), ['costo_critico_desconocido'])
  assert.deepEqual(codigos(bloqueosDuros(casoOk({ costosDesconocidos: [{ concepto: 'Despacho', maximoPorPedido: 35000 }] }))), ['costo_critico_desconocido'], 'puede invertir el resultado')
  const acotado = bloqueosDuros(casoOk({ costosDesconocidos: [{ concepto: 'Despacho', maximoPorPedido: 5000 }] }))
  assert.deepEqual(codigos(acotado), [])
  assert.ok(acotado.avisos.some(a => a.codigo === 'costo_desconocido_acotado'))
  assert.deepEqual(codigos(bloqueosDuros(casoOk({ importacion: { requerida: true, verificada: false } }))), ['importacion_sin_verificar'])
  assert.deepEqual(codigos(bloqueosDuros(casoOk({ muestra: { estado: 'DEFECTUOSA' } }))), ['muestra_defectuosa'])
  assert.deepEqual(codigos(bloqueosDuros(casoOk({ contribucion: { valor: -5000, validada: true } }))), ['contribucion_negativa_validada'])
  const estimada = bloqueosDuros(casoOk({ contribucion: { valor: -5000, validada: false } }))
  assert.deepEqual(codigos(estimada), [], 'negativa sin validar: aviso, no bloqueo')
  assert.ok(estimada.avisos.some(a => a.codigo === 'contribucion_negativa_estimada'))
  assert.deepEqual(codigos(bloqueosDuros(casoOk({ abastecimiento: { proveedoresDisponibles: 0 } }))), ['sin_abastecimiento'])
  assert.deepEqual(codigos(bloqueosDuros(casoOk({ evidencia: { ofertasComparables: 1, vendedoresIndependientes: 1, cotizacionesFirmes: 0 } }))), ['evidencia_insuficiente'])
})

test('precio de escaparate no cuenta como cotización firme', () => {
  const r = bloqueosDuros(casoOk({ evidencia: { ofertasComparables: 5, vendedoresIndependientes: 3, cotizacionesFirmes: 0, cotizacionesEscaparate: 4 } }))
  assert.deepEqual(codigos(r), ['evidencia_insuficiente'])
  assert.match(r.bloqueos[0].mensaje, /cotizacionesFirmes: 0 de 1/)
})

test('ESCALAR exige muestra conforme y piloto maduro', () => {
  const r = bloqueosDuros(casoOk({ compromiso: 'ESCALAR', muestra: { estado: 'CONFORME' } }))
  assert.deepEqual(codigos(r), ['evidencia_insuficiente'])
  assert.match(r.bloqueos[0].mensaje, /piloto/)
})

test('A3: semáforo de caja AMARILLO o ROJO bloquea comprar; DESCONOCIDO solo avisa', () => {
  assert.deepEqual(codigos(bloqueosDuros(casoOk({ semaforoCaja: 'AMARILLO' }))), ['caja_semaforo'])
  assert.deepEqual(codigos(bloqueosDuros(casoOk({ semaforoCaja: 'ROJO' }))), ['caja_semaforo'])
  const desc = bloqueosDuros(casoOk({ semaforoCaja: 'DESCONOCIDO' }))
  assert.deepEqual(codigos(desc), [])
  assert.ok(desc.avisos.some(a => a.codigo === 'caja_semaforo_desconocido'))
  assert.ok(bloqueosDuros(casoOk({ semaforoCaja: undefined })).avisos.some(a => a.codigo === 'caja_semaforo_desconocido'))
  assert.throws(() => bloqueosDuros(casoOk({ semaforoCaja: 'NARANJA' })), /no válido/)
  // Con caja en rojo se puede seguir investigando / cotizando
  const d = decisionSugerida(casoOk({ semaforoCaja: 'ROJO' }))
  assert.equal(d.estado, 'INVESTIGAR')
  assert.match(d.siguienteAccion, /semáforo VERDE/)
})

test('A4: proveedor sin factura a nombre de Voltra avisa, no bloquea', () => {
  const r = bloqueosDuros(casoOk({ proveedorFactura: false }))
  assert.deepEqual(codigos(r), [])
  assert.ok(r.avisos.some(a => a.codigo === 'proveedor_sin_factura' && /no se deduce del IRE/.test(a.mensaje)))
  assert.ok(bloqueosDuros(casoOk({ proveedorFactura: null })).avisos.some(a => a.codigo === 'factura_sin_confirmar'))
})

test('puntaje: pesos 25/25/20/15/10/5, editables; NO es probabilidad; faltantes visibles', () => {
  assert.deepEqual({ ...PESOS_INICIALES }, { demanda: 25, contribucion: 25, caja: 20, abastecimiento: 15, diferenciacion: 10, operacion: 5 })
  const dims = {
    demanda: { valor: 80, evidencia: ['5 ofertas'], razon: 'DEMO' },
    contribucion: { valor: 60 }, caja: { valor: 50 }, abastecimiento: { valor: 40 },
    diferenciacion: { valor: 100 }, operacion: { valor: 100 },
  }
  const r = puntaje(dims)
  // (25×80 + 25×60 + 20×50 + 15×40 + 10×100 + 5×100) / 100 = 66
  assert.equal(r.puntaje, 66)
  assert.equal(r.cobertura, 1)
  assert.match(r.advertencia, /NO probabilidad/)
  assert.ok(!/probabilidad/.test(Object.keys(r).join(' ')), 'ningún campo se llama probabilidad')
  const editado = puntaje(dims, { ...PESOS_INICIALES, demanda: 50 })
  assert.equal(editado.puntaje, Math.round(((50 * 80 + 25 * 60 + 20 * 50 + 15 * 40 + 10 * 100 + 5 * 100) / 125) * 10) / 10)
  const incompleto = puntaje({ demanda: { valor: 80 } })
  assert.equal(incompleto.cobertura, 0.25)
  assert.ok(incompleto.detalle.find(d => d.dimension === 'caja').faltantes.some(f => /sin valoración/.test(f)))
  assert.throws(() => puntaje({ suerte: { valor: 100 } }), /desconocida/)
  assert.throws(() => puntaje({ demanda: { valor: 120 } }), /fuera de 0-100/)
  assert.throws(() => puntaje({}, { demanda: -1 }), /inválido/)
})

test('un puntaje alto nunca neutraliza un bloqueo duro', () => {
  const alto = puntaje({ demanda: { valor: 100 }, contribucion: { valor: 100 }, caja: { valor: 100 }, abastecimiento: { valor: 100 }, diferenciacion: { valor: 100 }, operacion: { valor: 100 } })
  assert.equal(alto.puntaje, 100)
  const d = decisionSugerida(casoOk({ importacion: { requerida: true, verificada: false } }), { puntaje: alto })
  assert.notEqual(d.estado, 'PROBAR_MUESTRA')
  assert.equal(d.estado, 'SOLICITAR_COTIZACION')
  assert.match(d.siguienteAccion, /despachante/)
  const neg = decisionSugerida(casoOk({ contribucion: { valor: -1, validada: true } }), { puntaje: alto })
  assert.equal(neg.estado, 'DESCARTAR')
})

test('decisión: escalera de evidencia, cada estado con su siguiente acción más barata y qué la refuta', () => {
  const sinOfertas = decisionSugerida(casoOk({ evidencia: { ofertasComparables: 0, vendedoresIndependientes: 0, cotizacionesFirmes: 0 } }))
  assert.equal(sinOfertas.estado, 'INVESTIGAR')
  assert.match(sinOfertas.siguienteAccion, /5 ofertas comparables/)
  const sinCot = decisionSugerida(casoOk({ evidencia: { ofertasComparables: 5, vendedoresIndependientes: 3, cotizacionesFirmes: 0 } }))
  assert.equal(sinCot.estado, 'SOLICITAR_COTIZACION')
  assert.match(sinCot.siguienteAccion, /mayorista local en CDE/)
  const muestra = decisionSugerida(casoOk())
  assert.equal(muestra.estado, 'PROBAR_MUESTRA')
  const oferta = decisionSugerida(casoOk({ muestra: { estado: 'CONFORME' } }))
  assert.equal(oferta.estado, 'PROBAR_OFERTA')
  for (const d of [sinOfertas, sinCot, muestra, oferta]) {
    assert.ok(ESTADOS.includes(d.estado))
    assert.ok(d.siguienteAccion && d.refutaSi && d.costoDeLaAccion, `${d.estado} trae acción, costo y refutación`)
  }
  const defectuosa = decisionSugerida(casoOk({ muestra: { estado: 'DEFECTUOSA' } }))
  assert.equal(defectuosa.estado, 'SOLICITAR_COTIZACION')
  assert.match(defectuosa.siguienteAccion, /otro proveedor/)
})

test('no se pasa a ESCALAR desde una estimación: hace falta piloto maduro + muestra conforme + contribución validada + puntaje', () => {
  const alto = { puntaje: 85 }
  const piloto = (extra) => casoOk({ muestra: { estado: 'CONFORME' }, evidencia: { ofertasComparables: 5, vendedoresIndependientes: 3, cotizacionesFirmes: 1, pilotoMaduro: true }, ...extra })
  assert.equal(decisionSugerida(piloto({ contribucion: { valor: 30000, validada: false } }), { puntaje: alto }).estado, 'REORDENAR', 'contribución estimada: no escala')
  assert.equal(decisionSugerida(piloto({ contribucion: { valor: 30000, validada: true } }), { puntaje: { puntaje: 50 } }).estado, 'REORDENAR', 'puntaje bajo el umbral')
  assert.equal(decisionSugerida(piloto({ contribucion: { valor: 30000, validada: true } }), { puntaje: alto }).estado, 'ESCALAR')
  assert.equal(decisionSugerida(piloto({ contribucion: { valor: 30000, validada: true }, semaforoCaja: 'AMARILLO' }), { puntaje: alto }).estado, 'INVESTIGAR', 'caja amarilla frena reordenar/escalar')
  const sinPiloto = decisionSugerida(casoOk({ muestra: { estado: 'CONFORME' }, contribucion: { valor: 90000, validada: false } }), { puntaje: { puntaje: 99 } })
  assert.equal(sinPiloto.estado, 'PROBAR_OFERTA')
})

test('determinista: mismas entradas, misma decisión', () => {
  assert.deepEqual(decisionSugerida(casoOk()), decisionSugerida(casoOk()))
  assert.deepEqual(puntaje({ demanda: { valor: 1 } }), puntaje({ demanda: { valor: 1 } }))
})
