// 16-11 (paquete d): el export de Lucero no pisa la plata de una fila ya rendida por la rendición,
// la rendición no vacía el motivo y cada carga queda con su fuente. Datos inventados.
import assert from 'node:assert/strict'
import { exportLuceroAEntregas } from '../src/lib/exportLucero.js'
import { soloColumnasEntregas } from '../src/lib/estadosPaP.js'
import {
  rendicionLuceroAEntregas, protegerRendidas, filaProtegida, lotesUniformes, conFuente, idEventoRendicion, FUENTES,
} from '../src/lib/rendicionLucero.js'

// Item del export de Lucero (forma de parsearExportLucero) para un pedido inventado.
const itemExport = {
  referencia: 'VT-99901', estado: 'Entregado', categoria: 'entregado', motivo: 'Entregado sin novedad',
  total: 188000, tarifa: 40000, multa: 0, fechaCreado: '2026-11-03', fechaUltimoEstado: '2026-11-06',
  envioId: '555001', rendido: true, fechaRendicion: '2026-11-10', transportador: 'Moto 1',
  telefono: '0900000000', destinatario: 'Cliente Inventado', direccion: 'Calle Falsa 123', ciudad: 'Ciudad X', producto: 'Producto X',
}
// Lo que dejó la rendición en la base (mismo patrón que el caso real: 0 a cobrar, neto = −tarifa).
const previoRendicion = {
  nro_guia_pap: 'L-VT-99901', categoria: 'entregado', importe: 0, cobrado: 0, neto_depositado: -40000, costo_envio: 40000,
  fecha_entrega: '2026-11-13', dias_entrega: null, rendido: true, fecha_rendido: '2026-11-13', dias_rendicion: 10,
  fuente_plata: 'rendicion_lucero', corregido_manual: false,
}

// 1) Antes del arreglo el export manda los montos de la guía (esto es lo que pisaba).
{
  const [r] = exportLuceroAEntregas([itemExport]).map(soloColumnasEntregas)
  assert.equal(r.importe, 188000); assert.equal(r.neto_depositado, 148000); assert.equal(r.fecha_entrega, '2026-11-06')
  console.log('✓ el export solo trae 188.000 / neto 148.000 (lo que pisaba la rendición)')
}

// 2) Con la protección: fila rendida por la rendición → se mandan los valores guardados y se lista la diferencia.
{
  const regs = exportLuceroAEntregas([itemExport]).map(soloColumnasEntregas)
  const dif = protegerRendidas(regs, new Map([['L-VT-99901', previoRendicion]]))
  const r = regs[0]
  assert.deepEqual([r.importe, r.cobrado, r.neto_depositado, r.costo_envio, r.fecha_entrega, r.rendido, r.fecha_rendido],
    [0, 0, -40000, 40000, '2026-11-13', true, '2026-11-13'])
  assert.equal(r.dias_rendicion, 10)             // el export traía 4; queda el de la rendición
  assert.equal(r.estado_pap, 'Entregado')         // el resto pasa
  assert.equal(r.motivo, 'Entregado sin novedad')
  assert.equal(dif.length, 1)
  assert.equal(dif[0].n_referencia, 'VT-99901'); assert.equal(dif[0].por, 'rendicion')
  const campos = dif[0].cambios.map(c => c.campo)
  assert.deepEqual(campos, ['importe', 'cobrado', 'neto_depositado', 'fecha_entrega', 'fecha_rendido', 'dias_rendicion'])
  const imp = dif[0].cambios.find(c => c.campo === 'importe')
  assert.deepEqual([imp.archivo, imp.guardado], [188000, 0])
  console.log('✓ export sobre fila rendida: conserva 0 / −40.000 y avisa 6 campos distintos')
}

// 3) Mismos valores → protegida pero sin diferencia que mostrar. Numérico como texto ("-40000") cuenta igual.
{
  const regs = [{ nro_guia_pap: 'L-VT-99901', n_referencia: 'VT-99901', importe: 0, cobrado: 0, neto_depositado: '-40000', rendido: true, fecha_rendido: '2026-11-13' }]
  assert.equal(protegerRendidas(regs, new Map([['L-VT-99901', previoRendicion]])).length, 0)
  console.log('✓ sin diferencias reales no se avisa nada')
}

// 4) Fila NO protegida (la plata vino del export, o no estaba rendida) → el export actualiza como hoy.
{
  const regs = exportLuceroAEntregas([itemExport]).map(soloColumnasEntregas)
  const dif = protegerRendidas(regs, new Map([['L-VT-99901', { ...previoRendicion, fuente_plata: 'export_lucero' }]]))
  assert.equal(dif.length, 0); assert.equal(regs[0].importe, 188000)
  assert.equal(filaProtegida({ ...previoRendicion, rendido: false }), false)
  assert.equal(filaProtegida({ ...previoRendicion, fuente_plata: null }), false)  // filas de antes de la migración
  assert.equal(filaProtegida(undefined), false)
  console.log('✓ fila sin rendición: el export actualiza igual que hoy')
}

// 5) Corrección manual → protegida aunque la plata no venga de la rendición.
{
  const regs = exportLuceroAEntregas([itemExport]).map(soloColumnasEntregas)
  const prev = { ...previoRendicion, fuente_plata: 'manual', corregido_manual: true, importe: 50000, cobrado: 50000 }
  const dif = protegerRendidas(regs, new Map([['L-VT-99901', prev]]))
  assert.equal(regs[0].importe, 50000); assert.equal(dif[0].por, 'manual')
  console.log('✓ corrección manual: el export no la pisa')
}

// 6) Rendición: no vacía el motivo (no manda la clave) y sale con su fuente.
{
  const parsed = { fecha: '2026-11-13', items: [{ referencia: 'VT-99901', estadoFinal: 'entregado', envioId: '555001', ciudad: 'Ciudad X', producto: 'Producto X', tarifa: 40000, totalCobrar: 0, pagoCliente: -40000 }] }
  const [r] = conFuente(rendicionLuceroAEntregas(parsed).map(soloColumnasEntregas), FUENTES.RENDICION_LUCERO)
  assert.equal('motivo' in r, false)
  assert.equal(r.fuente_ultima, 'rendicion_lucero')
  assert.deepEqual([r.importe, r.neto_depositado, r.rendido], [0, -40000, true])
  console.log('✓ rendición: sin motivo vacío y con fuente_ultima = rendicion_lucero')
}

// 7) Lotes con las mismas claves: en un upsert de varias filas, la clave que falta en una fila se escribe NULL
//    (PostgREST arma las columnas con la unión de todas). Por eso se agrupan por juego de claves.
{
  const regs = [
    { nro_guia_pap: 'L-1', importe: 1, rendido: true, costo_envio: 10 },
    { nro_guia_pap: 'L-2', importe: 2 },
    { nro_guia_pap: 'L-3', importe: 3, costo_envio: 30, rendido: true },
    { nro_guia_pap: 'L-4', importe: 4 },
    { nro_guia_pap: 'L-5', importe: 5 },
  ]
  const lotes = lotesUniformes(regs, 2)
  for (const l of lotes) {
    const firma = Object.keys(l[0]).sort().join()
    assert.ok(l.every(r => Object.keys(r).sort().join() === firma))
    assert.ok(l.length <= 2)
  }
  assert.equal(lotes.flat().length, 5)
  assert.deepEqual(lotes.map(l => l.map(r => r.nro_guia_pap)), [['L-1', 'L-3'], ['L-2', 'L-4'], ['L-5']])
  console.log('✓ lotes uniformes: ninguna fila manda NULL por una clave ausente')
}

// 8) Rastro de la rendición en eventos_crudos: id determinístico y que NO caiga en el filtro 'lucero:%' de post-entrega.
{
  const a = await idEventoRendicion({ lotes: [{ lote: '1', items: [1] }] })
  const b = await idEventoRendicion({ lotes: [{ lote: '1', items: [1] }] })
  const c = await idEventoRendicion({ lotes: [{ lote: '2', items: [1] }] })
  assert.equal(a, b); assert.notEqual(a, c)
  assert.match(a, /^rendicion_lucero:[0-9a-f]{64}$/)
  assert.equal(a.startsWith('lucero:'), false)
  console.log('✓ evento de rendición: id estable, fuera del filtro de post-entrega')
}

console.log('✓ entregas-proteccion: todo OK')
