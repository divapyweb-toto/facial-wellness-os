// Dossier de decisión (Markdown) del módulo de productos.
// Correr: node --import ./tests/registrar.mjs tests/productos-dossier.test.mjs
// Datos inventados (DEMO).
import { test } from 'node:test'
import assert from 'node:assert/strict'
import { armarDossier, PREGUNTAS } from '../src/lib/productos/dossier.js'
import { costoPuesto, escenarios, caja } from '../src/lib/productos/motor.js'
import { decisionSugerida, puntaje } from '../src/lib/productos/rubrica.js'

const base = {
  precio: 158000, ivaPct: 10, unidadesPorPedido: 2, flete: 30000, costoBot: 1000, recuperaFallida: true,
  tasas: { confirmacion: 0.9, entrega: 0.85 }, adsPorConfirmado: 30000,
  lote: { lineas: [{ concepto: 'Mercadería DEMO', monto_minor: 10000, moneda: 'USD', tc_a_pyg: '7300', factura_a_nombre_voltra: true }], unidadesCompradas: 100, unidadesVendibles: 95 },
}

function datosCompletos() {
  const esc = escenarios(base, { adverso: { tasas: { entrega: 0.75 }, fuentes: ['DEMO adverso'] }, favorable: { adsPorConfirmado: 20000, fuentes: ['DEMO favorable'] } })
  const caso = {
    presupuesto: { disponible: 1000000, requerido: 800000 },
    contribucion: { valor: esc.base.resumen.porConfirmado.despuesAds, validada: false, denominador: 'confirmado' },
    muestra: { estado: 'PENDIENTE' }, abastecimiento: { proveedoresDisponibles: 1 },
    evidencia: { ofertasComparables: 3, vendedoresIndependientes: 2, cotizacionesFirmes: 1 },
    semaforoCaja: 'VERDE', proveedorFactura: true,
  }
  return {
    candidato: { nombre: 'Producto DEMO', hipotesis: 'resuelve X para Y', estado: 'INVESTIGAR', demo: true },
    ficha: { version: 2, resumen: 'acero, 10 cm, pack de 2' },
    segmentos: [{ nombre: 'Segmento DEMO', tipo: 'hypothesis', descripcion: 'usa el producto a diario', fuente: 'DEMO' }],
    problema: { texto: 'problema DEMO', fuente: 'evidencia DEMO #1' },
    porQueAqui: null,
    oferta: { descripcion: '2 unidades', canal: 'whatsapp', fuente: 'DEMO' },
    precioPrueba: { valor: 158000, fuente: 'caso v1' },
    preciosLocales: [
      { vendedor: 'Tienda A DEMO', vendedorClave: 'a', comparacion: 'equivalente', zona: 'CDE', precio: 150000, observadoEn: '2026-11-18', fuente: 'https://ejemplo.invalid/a' },
      { vendedor: 'Tienda A DEMO (IG)', vendedorClave: 'a', comparacion: 'equivalente', zona: 'CDE', precio: 150000, observadoEn: '2026-11-18', fuente: 'https://ejemplo.invalid/a-ig' },
    ],
    cotizaciones: [
      { proveedor: 'Proveedor DEMO', tipo: 'firme', precioUnitTexto: 'USD 1,00', moq: 100, fichaVersion: 2, validaHasta: '2026-12-01', fuente: 'cotización DEMO' },
      { proveedor: 'Vitrina DEMO', tipo: 'escaparate', precioUnitTexto: 'USD 0,80', moq: 500, fichaVersion: 2, validaHasta: null, fuente: 'anuncio DEMO' },
    ],
    costoPuesto: costoPuesto(base.lote.lineas, base.lote),
    escenarios: esc,
    caja: caja({ primerLote: 730000, calendario: { cobros: [{ dia: 30, monto: 900000 }] } }),
    decision: decisionSugerida(caso),
    puntaje: puntaje({ demanda: { valor: 60 } }),
    generadoEn: '2026-11-18T12:00:00Z',
  }
}

test('el dossier responde las 11 preguntas, en orden', () => {
  const md = armarDossier(datosCompletos())
  let pos = -1
  PREGUNTAS.forEach((p, i) => {
    const at = md.indexOf(`## ${i + 1}. ${p}`)
    assert.ok(at > pos, `falta o está fuera de orden: ${p}`)
    pos = at
  })
  assert.equal(PREGUNTAS.length, 11)
})

test('cada cifra lleva fuente/versión; DEMO marcado; puntaje no es probabilidad', () => {
  const md = armarDossier(datosCompletos())
  assert.match(md, /\*\*DEMO\*\*/)
  assert.match(md, /Precio de prueba \(con IVA\): ₲158\.000 _\(fuente: caso v1\)_/)
  assert.match(md, /Costo puesto por unidad vendible: ₲7\.684 _\(fuente: motor 1\.0\.0\)_/) // 730.000 / 95
  assert.match(md, /\| adverso \|/)
  assert.match(md, /DEMO adverso/)
  assert.match(md, /NO una probabilidad de éxito/)
  assert.match(md, /Puntaje de prioridad: 15 \/ 100/)
  assert.match(md, /escaparate \(no es cotización firme\)/)
  assert.match(md, /Cotizaciones firmes: 1 de 2\. Concentración/)
  assert.match(md, /2 oferta\(s\) de 1 vendedor\(es\) independiente\(s\)/, 'deduplica al mismo vendedor en dos canales')
  assert.match(md, /iniciado ÷ \(1 − % cancelado\)|"confirmado" = iniciado/, 'rotula los denominadores')
  // Ninguna cifra en guaraníes sin fuente al lado (excepto las de tablas, que tienen columna Fuentes)
  const sueltas = md.split('\n').filter(l => /₲\d/.test(l) && !l.startsWith('|') && !/_\(fuente: /.test(l))
  assert.deepEqual(sueltas, [])
})

test('lo desconocido es visible, no se rellena', () => {
  const md = armarDossier({ candidato: { nombre: 'Vacío DEMO' } })
  assert.match(md, /## 4\. Por qué comprarían aquí\n\*\*desconocido\*\*/)
  assert.match(md, /Precio de prueba \(con IVA\): \*\*desconocido\*\*/)
  assert.match(md, /Costo puesto por unidad vendible: \*\*desconocido\*\*/)
  assert.match(md, /Necesidad de caja: \*\*desconocido\*\*/)
  assert.match(md, /sin decisión calculada/)
  assert.match(md, /ficha sin versión/)
  assert.ok((md.match(/\*\*desconocido\*\*/g) || []).length >= 10)
  const conDatos = armarDossier(datosCompletos())
  assert.match(conDatos, /## 4\. Por qué comprarían aquí\n\*\*desconocido\*\*/, 'porQueAqui null → desconocido')
  assert.throws(() => armarDossier({}), /nombre/)
})

test('costo con partida desconocida se muestra como rango', () => {
  const lineas = [...base.lote.lineas, { concepto: 'Despacho', monto_minor: null, moneda: 'PYG', rango: { min_minor: 0, max_minor: 95000 } }]
  const md = armarDossier({ candidato: { nombre: 'Rango DEMO' }, costoPuesto: costoPuesto(lineas, base.lote) })
  assert.match(md, /rango ₲7\.684 a ₲8\.684/)
  assert.match(md, /desconocido: Despacho/)
})

test('bloqueos y siguiente acción quedan en el dossier; determinista', () => {
  const d = datosCompletos()
  d.decision = decisionSugerida({ ...{ presupuesto: { disponible: 1, requerido: 2 }, evidencia: { ofertasComparables: 5, vendedoresIndependientes: 3, cotizacionesFirmes: 1 }, semaforoCaja: 'ROJO' } })
  const md = armarDossier(d)
  assert.match(md, /\*\*Bloqueo duro\*\* `presupuesto_excedido`/)
  assert.match(md, /\*\*Bloqueo duro\*\* `caja_semaforo`/)
  assert.match(md, /Siguiente acción más barata que puede refutar la tesis:/)
  assert.match(md, /La tesis se cae si/)
  assert.equal(armarDossier(datosCompletos()), armarDossier(datosCompletos()))
})
