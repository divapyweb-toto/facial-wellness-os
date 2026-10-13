// tests/seguimiento-auditoria.test.mjs
// Arreglos de la auditoría de Seguimiento / Reclamos / Rendición del 12-10-2026.
// Datos inventados (repo público): nombres, teléfonos y referencias de mentira.
// Correr: node --import ./tests/registrar.mjs tests/seguimiento-auditoria.test.mjs
import { test } from 'node:test'
import assert from 'node:assert/strict'
import {
  codigoCourier, construirBandeja, mensajeCliente, mensajeReclamo, mensajeReclamoIndividual,
  marcaTienda, resumenBandeja,
} from '../src/lib/seguimiento.js'
import {
  guiaCourier, codigoLuceroDeRef, construirIndice, estadoPedido, estadoEnvioPorRef,
} from '../src/lib/buscadorPedidos.js'
import { sanearEntrega } from '../src/lib/estadosPaP.js'

const HOY = new Date(2026, 9, 12) // 12-10-2026
const TEL = '0991000000'          // inventado

// ── 1. Código para Lucero ──
test('1: Voltra va tal cual a Lucero (VT-1004), FW sigue con FW-', () => {
  assert.equal(codigoLuceroDeRef('VT-1004'), 'VT-1004')
  assert.equal(codigoLuceroDeRef('vt1004'), 'VT-1004')
  assert.equal(codigoLuceroDeRef('2025'), 'FW-2025')
  assert.equal(codigoLuceroDeRef(''), null)
  assert.equal(codigoCourier({ transportadora: 'lucero', n_referencia: 'VT-1004' }), 'VT-1004')
  assert.equal(codigoCourier({ transportadora: 'lucero', n_referencia: '2025', guia_transportadora: '999' }), 'FW-2025 (ID 999)')
  assert.equal(guiaCourier({ transportadora: 'lucero', ref: 'VT-1004' }).numero, 'VT-1004')
  assert.equal(guiaCourier({ transportadora: 'lucero', ref: '2025' }).numero, 'FW-2025')
})

// ── 2. Marca según la tienda ──
test('2: los mensajes dicen Voltra o Facial Wellness según la tienda', () => {
  assert.equal(marcaTienda('voltra'), 'Voltra')
  assert.equal(marcaTienda('fw'), 'Facial Wellness')
  assert.equal(marcaTienda(null), 'Facial Wellness')
  const vt = { tienda: 'voltra', cliente_nombre: 'Ana Prueba', producto_nombre: 'Producto X', estado: 'sin_contacto', n_referencia: 'VT-1', transportadora: 'lucero' }
  const fw = { tienda: 'fw', cliente_nombre: 'Beto Prueba', estado: 'sin_contacto', n_referencia: '10', transportadora: 'lucero' }
  for (const pl of ['consulta', 'demorado', 'reintento', 'intento_fallido']) {
    assert.match(mensajeCliente(vt, pl), /Voltra/)
    assert.doesNotMatch(mensajeCliente(vt, pl), /Facial/)
    assert.match(mensajeCliente(fw, pl === 'intento_fallido' ? 'consulta' : pl), /Facial Wellness/)
  }
  assert.match(mensajeReclamoIndividual(vt), /envio de Voltra:/)
  assert.match(mensajeReclamoIndividual(fw), /envio de Facial Wellness:/)
  assert.match(mensajeReclamo([vt]), /envios de Voltra:/)
  assert.match(mensajeReclamo([vt, fw]), /envios de Voltra y Facial Wellness:/)
})

// ── 3. Intento de entrega fallido (Shopify) ──
test('3: estadoEnvioPorRef cruza #1004 con VT-1004', () => {
  const m = estadoEnvioPorRef([
    { nombre: '#1004', estado_envio: 'INTENTO_FALLIDO' },
    { nombre: '#1005', estado_envio: null },
  ])
  assert.equal(m.get('VT-1004'), 'INTENTO_FALLIDO')
  assert.equal(m.has('VT-1005'), false)
})

test('3: en la bandeja el intento fallido va primero, se puede escribir ya y sin "¿ya lo recibiste?"', () => {
  const ventas = [
    { id: 'a', estado: 'pendiente', fecha: '2026-10-01', fecha_ingreso: '2026-10-01', cliente_telefono: TEL, tienda: 'fw', n_referencia: '50' },
    { id: 'b', estado: 'pendiente', fecha: '2026-10-11', fecha_ingreso: '2026-10-11', cliente_telefono: TEL, tienda: 'voltra', n_referencia: 'VT-1004', estado_envio: 'INTENTO_FALLIDO' },
  ]
  const b = construirBandeja(ventas, { hoy: HOY })
  assert.equal(b[0].id, 'b')
  assert.equal(b[0].envioFallido, 'Intento de entrega fallido')
  assert.equal(b[0].puedeContactar, true)   // 1 día: igual se contacta
  assert.equal(b[0].plantillaSugerida, 'intento_fallido')
  assert.doesNotMatch(mensajeCliente(b[0], b[0].plantillaSugerida), /recibiste/i)
  assert.equal(resumenBandeja(b).intentosFallidos, 1)
})

test('3: el buscador muestra el intento fallido en vez de "En tránsito"', () => {
  const idx = construirIndice(
    [{ id: 'v1', n_referencia: 'VT-1004', estado: 'pendiente', transportadora: 'lucero', total: 100 }],
    [{ nro_guia_pap: 'L-VT-1004', n_referencia: 'VT-1004', categoria: 'en_proceso', transportadora: 'lucero', fecha_ingreso: '2026-10-07' }],
    estadoEnvioPorRef([{ nombre: '#1004', estado_envio: 'INTENTO_FALLIDO' }]),
  )
  const p = idx.find(x => x.ref === 'VT-1004')
  assert.equal(estadoPedido(p).label, 'Intento de entrega fallido')
  // Sin el mapa (o con resultado final del courier) queda como antes.
  const idx2 = construirIndice(
    [{ id: 'v1', n_referencia: 'VT-1004', estado: 'pendiente', transportadora: 'lucero' }],
    [{ nro_guia_pap: 'L-VT-1004', n_referencia: 'VT-1004', categoria: 'en_proceso', transportadora: 'lucero' }],
  )
  assert.equal(estadoPedido(idx2[0]).label, 'En tránsito')
  assert.equal(estadoPedido({ ...p, entrega: { ...p.entrega, categoria: 'entregado' } }).label, 'Entregado')
})

// ── 4. Neto negativo de Lucero ──
test('4: sanearEntrega conserva el neto negativo legítimo de Lucero', () => {
  assert.equal(sanearEntrega({ transportadora: 'lucero', categoria: 'entregado', importe: 0, neto_depositado: -30000 }).depositoReal, -30000)
  assert.equal(sanearEntrega({ transportadora: 'lucero', categoria: 'entregado', importe: 150000, neto_depositado: 120000 }).depositoReal, 120000)
  // Basura sigue saliendo como 0; sin neto cae al bruto.
  assert.equal(sanearEntrega({ transportadora: 'lucero', importe: 1000, neto_depositado: -2147483648 }).depositoReal, 0)
  assert.equal(sanearEntrega({ importe: 99000, neto_depositado: null }).depositoReal, 99000)
  // El total cuadra: 150.000 de un entregado − 30.000 de un prepago.
  const total = [
    { transportadora: 'lucero', categoria: 'entregado', importe: 150000, neto_depositado: 150000 },
    { transportadora: 'lucero', categoria: 'entregado', importe: 0, neto_depositado: -30000 },
  ].map(sanearEntrega).reduce((s, m) => s + m.depositoReal, 0)
  assert.equal(total, 120000)
})

// ── 7. Días desde el despacho ──
test('7: los días se cuentan desde el ingreso al courier, después despachado_at', () => {
  const [a] = construirBandeja([{ id: 'a', estado: 'pendiente', fecha: '2026-10-01', fecha_ingreso: '2026-10-08', despachado_at: '2026-10-05', cliente_telefono: TEL }], { hoy: HOY })
  assert.equal(a.dias, 4)
  assert.equal(a.sinRastro, false)
  const [b] = construirBandeja([{ id: 'b', estado: 'pendiente', fecha: '2026-10-01', despachado_at: '2026-10-05T10:00:00Z', cliente_telefono: TEL }], { hoy: HOY })
  assert.equal(b.dias, 7)
  assert.equal(b.sinRastro, false)
})

test('7: sin rastro del courier se avisa en vez de "Recién despachado"', () => {
  const [c] = construirBandeja([{ id: 'c', estado: 'pendiente', fecha: '2026-10-11', cliente_telefono: TEL }], { hoy: HOY })
  assert.equal(c.sinRastro, true)
  assert.equal(c.dias, 1)
  assert.match(c.motivoBloqueo, /Sin rastro del courier/)
  assert.doesNotMatch(c.motivoBloqueo, /Recién despachado/)
  const r = resumenBandeja([c])
  assert.equal(r.sinRastro, 1)
  assert.equal(r.masViejo, 0)   // no mezcla días desde el pedido con días desde el despacho
})
