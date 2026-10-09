// tests/pantallas-arreglos.test.mjs
// Arreglos de pantallas del 09-10-2026. Datos inventados (repo público).
// Correr: node --import ./tests/registrar.mjs tests/pantallas-arreglos.test.mjs
import { test } from 'node:test'
import assert from 'node:assert/strict'
import { mensajesDeConv, fusionarMensajes } from '../src/pages/bandeja/cacheChat.js'
import { coerce, validarReglas, DEFAULTS } from '../src/lib/config.js'
import { urlProducto, segmentarRecompra, diasDesde, diaPY } from '../src/lib/recompra.js'
import { nombreArchivoRecompra } from '../src/lib/recompraExcel.js'

// ── 1. Bandeja: la caché no mezcla chats ──
const msgA = [
  { id: 'a1', conversacion_id: 'conv-A', creado_en: '2026-10-01T10:00:00Z', texto: 'hola A' },
  { id: 'a2', conversacion_id: 'conv-A', creado_en: '2026-10-01T10:05:00Z', texto: 'precio?' },
]
const msgB = [
  { id: 'b1', conversacion_id: 'conv-B', creado_en: '2026-10-02T09:00:00Z', texto: 'hola B' },
]

test('1: al cambiar de chat, la lista vieja no entra a la caché del nuevo', () => {
  // Render intermedio: activa = B, mensajes todavía de A.
  assert.deepEqual(mensajesDeConv('conv-B', msgA), [])
  assert.equal(mensajesDeConv('conv-A', [...msgA, ...msgB]).length, 2)
  assert.deepEqual(mensajesDeConv(null, msgA), [])
})

test('1: el merge descarta lo que estaba en pantalla de otra conversación', () => {
  const realtimeB = { id: 'b2', conversacion_id: 'conv-B', creado_en: '2026-10-02T09:10:00Z', texto: 'sigo acá' }
  const r = fusionarMensajes(msgB, [...msgA, realtimeB], 'conv-B')
  assert.deepEqual(r.map(m => m.id), ['b1', 'b2'])
  assert.ok(r.every(m => m.conversacion_id === 'conv-B'))
})

// ── 3. Config: vacío ≠ 0, y rangos antes de guardar ──
test('3: un número vacío vuelve al default, no a 0', () => {
  assert.equal(coerce('riesgo_bloqueo_fallos', ''), DEFAULTS.riesgo_bloqueo_fallos)
  assert.equal(coerce('riesgo_bloqueo_tasa', '   '), DEFAULTS.riesgo_bloqueo_tasa)
  assert.equal(coerce('riesgo_bloqueo_fallos', '3'), 3)
  assert.equal(coerce('pago_alias', ''), '') // los textos sí pueden quedar vacíos
})

test('3: validarReglas frena vacíos y valores fuera de rango', () => {
  assert.deepEqual(validarReglas({ riesgo_bloqueo_fallos: '2', riesgo_tasa: '0.34', flete_pap: '0' }), [])
  assert.equal(validarReglas({ riesgo_bloqueo_fallos: '' }).length, 1)
  assert.equal(validarReglas({ riesgo_bloqueo_fallos: '0' }).length, 1)
  assert.equal(validarReglas({ riesgo_bloqueo_tasa: '1.5' }).length, 1)
  assert.equal(validarReglas({ recompra_dias_cooldown: '0' }).length, 1)
  assert.equal(validarReglas({ flete_pap: '-1' }).length, 1)
  assert.deepEqual(validarReglas({ pago_alias: '' }), []) // texto: no se valida
})

// ── 9. Recompra: links y Excel por tienda ──
test('9: links de Voltra van a voltraparaguay.com; sin producto → portada', () => {
  assert.match(urlProducto('nasal', 'voltra'), /^https:\/\/voltraparaguay\.com\/products\//)
  assert.equal(urlProducto('bebird', 'voltra'), 'https://voltraparaguay.com/')
  assert.match(urlProducto('nasal', 'fw'), /^https:\/\/facialwellnesspy\.com\//)
  assert.match(urlProducto('parche', 'todas'), /voltraparaguay\.com/) // "Todas" → tienda activa
})

test('9: segmentar usa la tienda del pedido del cliente', () => {
  const hoy = new Date('2026-10-09T15:00:00Z')
  const lineas = [
    { telefono: '0900111222', nombre: 'Cliente Prueba', familia: 'lengua', cantidad: 1, fechaEntrega: '2026-09-01', tienda: 'voltra' },
    { telefono: '0900333444', nombre: 'Otra Prueba', familia: 'lengua', cantidad: 1, fechaEntrega: '2026-09-01', tienda: 'fw' },
  ]
  const { g3 } = segmentarRecompra(lineas, new Set(), hoy, { tienda: 'todas' })
  const porTel = Object.fromEntries(g3.map(r => [r.telefono, r]))
  assert.match(porTel['0900111222'].urlOfrecido, /voltraparaguay\.com/)
  assert.equal(porTel['0900111222'].tienda, 'voltra')
  assert.match(porTel['0900333444'].urlOfrecido, /facialwellnesspy\.com/)
  assert.equal(porTel['0900333444'].tienda, 'fw')
})

test('9: nombre del Excel según la tienda', () => {
  const d = new Date(2026, 9, 9)
  assert.equal(nombreArchivoRecompra('voltra', d), 'Recompra_Voltra_2026-10-09.xlsx')
  assert.equal(nombreArchivoRecompra('fw', d), 'Recompra_FacialWellness_2026-10-09.xlsx')
  assert.equal(nombreArchivoRecompra('todas', d), 'Recompra_Todas_2026-10-09.xlsx')
})

// ── 15. Días desde la entrega en día de Paraguay ──
test('15: de noche en Paraguay no se suma un día de más', () => {
  // 22:30 del 09-10 en Asunción (UTC-3) = 01:30 UTC del 10-10.
  const nochePY = new Date('2026-10-10T01:30:00Z')
  assert.equal(diaPY(nochePY), '2026-10-09')
  assert.equal(diasDesde(nochePY, '2026-10-01'), 8) // antes daba 9
  assert.equal(diasDesde(new Date('2026-10-09T12:00:00Z'), '2026-10-01'), 8)
  // Timestamp de entrega a la noche también cuenta como su día de Paraguay.
  assert.equal(diasDesde(nochePY, '2026-10-02T01:00:00Z'), 8)
  assert.equal(diasDesde(nochePY, null), null)
})
