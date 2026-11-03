// "Imprimir para la contadora": filtros, orden, selección, resumen y unión de PDFs.
// Datos INVENTADOS (sin clientes ni proveedores reales).
import { test } from 'node:test'
import assert from 'node:assert/strict'
import { PDFDocument } from 'pdf-lib'
import {
  mesAnteriorAsuncion, rangoMesFecha, armarListas, paraImprimir, alternarTodas, alternarUna,
  podarSeleccion, resumen, idsPorTabla, nombrePdf, esColumnaInexistente, esEmitidaImprimible,
} from '../src/pages/facturas/imprimir.js'
import { esTablaInexistente } from '../src/pages/facturas/logica.js'
import { unirPdf } from '../src/lib/unirPdf.js'

const F = (o) => ({
  tipo_documento: 1, estado: 'aprobada', ambiente: 'prod', receptor_tipo: 'innominado',
  razon_social: null, ruc: null, total: 100000, kude_path: `kude/${o.id}.pdf`, impreso_en: null, ...o,
})
const R = (o) => ({
  proveedor: 'Proveedor Inventado SA', remitente: 'facturas@ejemplo.test', numero: '001-001-0000001',
  fecha_doc: '2026-10-10', recibida_en: '2026-10-10T15:00:00Z', total: 50000,
  pdf_path: `recibidas/${o.id}/factura.pdf`, xml_path: `recibidas/${o.id}/factura.xml`,
  es_de_voltra: true, descartada: false, impreso_en: null, ...o,
})

const facturas = [
  F({ id: 'e3', numero_completo: '001-001-0000003', fecha_emision: '2026-10-20T13:00:00Z' }),
  F({ id: 'e1', numero_completo: '001-001-0000001', fecha_emision: '2026-10-02T13:00:00Z', receptor_tipo: 'ruc', razon_social: 'Empresa Inventada SA', ruc: '80000001-1' }),
  F({ id: 'e2', numero_completo: '001-001-0000002', fecha_emision: '2026-10-05T13:00:00Z', impreso_en: '2026-11-01T12:00:00Z' }),
  F({ id: 'nc1', tipo_documento: 5, numero_completo: '001-001-0000001', fecha_emision: '2026-10-09T13:00:00Z' }),
  F({ id: 'x-test', numero_completo: '001-001-0000009', fecha_emision: '2026-10-09T13:00:00Z', ambiente: 'test' }),
  F({ id: 'x-rech', numero_completo: '001-001-0000010', fecha_emision: '2026-10-09T13:00:00Z', estado: 'rechazada' }),
  F({ id: 'x-sinkude', numero_completo: '001-001-0000011', fecha_emision: '2026-10-09T13:00:00Z', kude_path: null }),
  // 01-11 02:00 UTC = 31-10 23:00 en Asunción → es de octubre
  F({ id: 'e4', numero_completo: '001-001-0000004', fecha_emision: '2026-11-01T02:00:00Z' }),
  F({ id: 'x-nov', numero_completo: '001-001-0000012', fecha_emision: '2026-11-01T04:00:00Z' }),
]
const recibidas = [
  R({ id: 'r2', fecha_doc: '2026-10-15', numero: '002-001-0000050' }),
  R({ id: 'r1', fecha_doc: '2026-10-03', numero: '001-002-0000007', proveedor: null, remitente: 'otro@ejemplo.test' }),
  R({ id: 'r-sinpdf', fecha_doc: '2026-10-08', pdf_path: null }),
  // sin XML: se ubica por el día que llegó el correo (en hora de Asunción)
  R({ id: 'r-sinxml', fecha_doc: null, numero: null, xml_path: null, recibida_en: '2026-10-12T12:00:00Z', total: null }),
  R({ id: 'r-desc', fecha_doc: '2026-10-04', descartada: true }),
  R({ id: 'r-impresa', fecha_doc: '2026-10-20', impreso_en: '2026-11-02T10:00:00Z' }),
  R({ id: 'r-sep', fecha_doc: '2026-09-30' }),
]

test('mes por defecto: el anterior, en hora de Asunción', () => {
  assert.equal(mesAnteriorAsuncion(new Date('2026-11-03T15:00:00Z')), '2026-10')
  // 01-11 01:00 UTC = 31-10 22:00 en Paraguay → todavía octubre → anterior = septiembre
  assert.equal(mesAnteriorAsuncion(new Date('2026-11-01T01:00:00Z')), '2026-09')
  assert.equal(mesAnteriorAsuncion(new Date('2027-01-10T15:00:00Z')), '2026-12', 'enero → diciembre del año anterior')
  assert.deepEqual(rangoMesFecha('2026-12'), { desde: '2026-12-01', hasta: '2027-01-01' })
})

test('emitidas: solo aprobadas de producción con KuDE, del mes, ordenadas por número', () => {
  assert.equal(esEmitidaImprimible(facturas[4]), false, 'ambiente test no va')
  const { emitidas } = armarListas(facturas, recibidas, { mes: '2026-10' })
  assert.deepEqual(emitidas.map(f => f.id), ['e1', 'nc1', 'e2', 'e3', 'e4'])
  const e1 = emitidas[0]
  assert.equal(e1.clave, 'e:e1')
  assert.equal(e1.dia, '2026-10-02')
  assert.equal(e1.contraparte, 'Empresa Inventada SA')
  assert.equal(emitidas[2].contraparte, 'Consumidor final')
  assert.equal(e1.pdf_path, 'kude/e1.pdf')
})

test('recibidas: no descartadas, del mes, por fecha; sin PDF se listan marcadas', () => {
  const { recibidas: rec } = armarListas(facturas, recibidas, { mes: '2026-10' })
  assert.deepEqual(rec.map(f => f.id), ['r1', 'r-sinpdf', 'r-sinxml', 'r2', 'r-impresa'])
  assert.equal(rec.find(f => f.id === 'r-sinpdf').sin_pdf, true)
  assert.equal(rec.find(f => f.id === 'r1').contraparte, 'otro@ejemplo.test', 'sin proveedor usa el remitente')
  const sinXml = rec.find(f => f.id === 'r-sinxml')
  assert.equal(sinXml.dia, '2026-10-12')
  assert.equal(sinXml.numero, '—')
  assert.equal(sinXml.total, null)
})

test('"solo no impresas" saca las que ya tienen impreso_en', () => {
  const l = armarListas(facturas, recibidas, { mes: '2026-10', soloNoImpresas: true })
  assert.ok(!l.emitidas.some(f => f.id === 'e2'))
  assert.ok(!l.recibidas.some(f => f.id === 'r-impresa'))
  assert.equal(l.emitidas.length, 4)
})

test('sin tabla de recibidas (lista vacía) las emitidas siguen funcionando', () => {
  const l = armarListas(facturas, [], { mes: '2026-10' })
  assert.equal(l.recibidas.length, 0)
  assert.equal(paraImprimir(l, 'todas').length, 5)
  assert.equal(resumen([...l.emitidas, ...l.recibidas]).texto, '5 emitidas + 0 recibidas')
})

test('imprimir todo: emitidas primero, después recibidas, sin las "sin PDF"', () => {
  const l = armarListas(facturas, recibidas, { mes: '2026-10' })
  const p = paraImprimir(l, 'todas')
  assert.deepEqual(p.map(f => f.id), ['e1', 'nc1', 'e2', 'e3', 'e4', 'r1', 'r-sinxml', 'r2', 'r-impresa'])
})

test('selección: tildadas, casilla "todas" y poda al cambiar el filtro', () => {
  const l = armarListas(facturas, recibidas, { mes: '2026-10' })
  let sel = new Set()
  sel = alternarUna(sel, 'r:r2')
  sel = alternarUna(sel, 'e:e3')
  sel = alternarUna(sel, 'r:r-sinpdf') // aunque se tilde, no entra
  assert.deepEqual(paraImprimir(l, 'seleccionadas', sel).map(f => f.id), ['e3', 'r2'], 'respeta el orden de impresión, no el de tildado')
  sel = alternarUna(sel, 'e:e3')
  assert.ok(!sel.has('e:e3'), 'destildar')

  const todasRec = alternarTodas(new Set(), l.recibidas, true)
  assert.ok(!todasRec.has('r:r-sinpdf'), '"todas" no tilda las sin PDF')
  assert.equal(todasRec.size, 4)
  assert.equal(alternarTodas(todasRec, l.recibidas, false).size, 0)

  const soloPend = armarListas(facturas, recibidas, { mes: '2026-10', soloNoImpresas: true })
  const podada = podarSeleccion(new Set(['e:e2', 'e:e1', 'r:r-impresa']), soloPend)
  assert.deepEqual([...podada], ['e:e1'])
  assert.equal(paraImprimir(l, 'seleccionadas', []).length, 0)
})

test('resumen e ids por tabla', () => {
  const l = armarListas(facturas, recibidas, { mes: '2026-10' })
  const todo = [...l.emitidas, ...l.recibidas]
  const r = resumen(todo)
  assert.equal(r.texto, '5 emitidas + 4 recibidas, 1 sin PDF')
  assert.equal(r.total, 9)
  assert.equal(resumen([l.emitidas[0]]).texto, '1 emitida + 0 recibidas')
  const ids = idsPorTabla(paraImprimir(l, 'todas'))
  assert.deepEqual(ids.facturas, ['e1', 'nc1', 'e2', 'e3', 'e4'])
  assert.deepEqual(ids.facturas_recibidas, ['r1', 'r-sinxml', 'r2', 'r-impresa'])
  assert.equal(nombrePdf('2026-10'), 'voltra-facturas-contadora-2026-10.pdf')
})

test('errores: columna impreso_en faltante vs tabla faltante', () => {
  const col = { code: '42703', message: 'column facturas.impreso_en does not exist' }
  assert.equal(esColumnaInexistente(col), true)
  assert.equal(esColumnaInexistente({ code: 'PGRST204', message: "Could not find the 'impreso_en' column of 'facturas' in the schema cache" }), true)
  assert.equal(esColumnaInexistente({ code: 'PGRST205', message: "Could not find the table 'public.facturas_recibidas' in the schema cache" }), false)
  assert.equal(esTablaInexistente({ code: 'PGRST205', message: "Could not find the table 'public.facturas_recibidas' in the schema cache" }), true)
  assert.equal(esColumnaInexistente({ code: '42501', message: 'permission denied' }), false)
  assert.equal(esColumnaInexistente(null), false)
})

async function pdfDePaginas(n) {
  const doc = await PDFDocument.create()
  for (let i = 0; i < n; i++) doc.addPage([200, 200])
  const bytes = await doc.save()
  return bytes.buffer.slice(bytes.byteOffset, bytes.byteOffset + bytes.byteLength) // ArrayBuffer, como fetch
}

test('unirPdf: 2 PDF → páginas = suma, en orden', async () => {
  const a = await pdfDePaginas(1)
  const b = await pdfDePaginas(2)
  const unido = await unirPdf([a, b])
  assert.ok(unido instanceof Uint8Array)
  const doc = await PDFDocument.load(unido)
  assert.equal(doc.getPageCount(), 3)
})

test('unirPdf: un PDF roto corta, o se saltea si hay alFallar', async () => {
  const a = await pdfDePaginas(2)
  const roto = new TextEncoder().encode('esto no es un pdf').buffer
  await assert.rejects(() => unirPdf([a, roto]), /n\.º 2/)
  const fallos = []
  const unido = await unirPdf([roto, a], { alFallar: (i) => fallos.push(i) })
  assert.deepEqual(fallos, [0])
  assert.equal((await PDFDocument.load(unido)).getPageCount(), 2)
})
