// Confirmación de pedidos (Config) + métricas de "cayó sin respuesta". Datos inventados.
import assert from 'node:assert/strict'
import {
  CONFIRMACION_DEFAULTS, leerConfirmacion, validarConfirmacion, armarConfirmacionGuardar, textoAyudaConfirmacion,
} from '../src/lib/confirmacion.js'
import { armarCostoPorAnuncio } from '../src/lib/costoPorAnuncio.js'
import { agregarSinRespuesta } from '../src/pages/kpi-whatsapp/kpi.js'

// ── Defaults y lectura ──
assert.deepEqual({ ...CONFIRMACION_DEFAULTS }, { recordatorio_min: 60, aviso_enrique_h: 3, ultimo_aviso_h: 24, cancelar_h: 48 })
assert.deepEqual(leerConfirmacion(null), { recordatorio_min: '60', aviso_enrique_h: '3', ultimo_aviso_h: '24', cancelar_h: '48' })
assert.deepEqual(leerConfirmacion({ recordatorio_min: 30, cancelar_h: 'x', confirmar_min: 0 }),
  { recordatorio_min: '30', aviso_enrique_h: '3', ultimo_aviso_h: '24', cancelar_h: '48' })

// ── Validación ──
const ok = { recordatorio_min: '60', aviso_enrique_h: '3', ultimo_aviso_h: '24', cancelar_h: '48' }
assert.deepEqual(validarConfirmacion(ok), [])
assert.deepEqual(validarConfirmacion({ ...ok, recordatorio_min: '5' }), [])
assert.equal(validarConfirmacion({ ...ok, recordatorio_min: '4' }).length, 1)
assert.equal(validarConfirmacion({ ...ok, aviso_enrique_h: '0' }).length, 1)
assert.equal(validarConfirmacion({ ...ok, ultimo_aviso_h: '2' }).length, 1)          // antes del aviso a Enrique
assert.deepEqual(validarConfirmacion({ ...ok, ultimo_aviso_h: '3' }), [])             // igual se permite
assert.equal(validarConfirmacion({ ...ok, cancelar_h: '23', ultimo_aviso_h: '10' }).length, 1) // < 24
assert.deepEqual(validarConfirmacion({ ...ok, cancelar_h: '24', ultimo_aviso_h: '10' }), [])
assert.equal(validarConfirmacion({ ...ok, ultimo_aviso_h: '30', cancelar_h: '30' }).length, 1)   // tiene que ser ≥ 31
assert.deepEqual(validarConfirmacion({ ...ok, ultimo_aviso_h: '30', cancelar_h: '31' }), [])
assert.ok(validarConfirmacion({ ...ok, cancelar_h: '' })[0].includes('número'))
assert.ok(validarConfirmacion({ ...ok, aviso_enrique_h: '1.5' })[0].includes('entero'))

// ── Merge: conserva confirmar_min y cualquier otra clave ──
const existente = { confirmar_min: 0, recordatorio_h: 1, retener_h: 24, cancelar_h: 72, otra: { a: 1 } }
const guardado = armarConfirmacionGuardar(existente, { ...ok, cancelar_h: '50' })
assert.deepEqual(guardado, {
  confirmar_min: 0, recordatorio_h: 1, retener_h: 24, otra: { a: 1 },
  recordatorio_min: 60, aviso_enrique_h: 3, ultimo_aviso_h: 24, cancelar_h: 50,
})
assert.equal(typeof guardado.cancelar_h, 'number')
assert.deepEqual(armarConfirmacionGuardar(null, ok), { recordatorio_min: 60, aviso_enrique_h: 3, ultimo_aviso_h: 24, cancelar_h: 48 })
assert.deepEqual(existente.cancelar_h, 72) // no muta lo leído

// ── Texto de ayuda ──
assert.equal(textoAyudaConfirmacion(ok),
  'Los pedidos sin confirmar se cancelan solos a las 48 h. A las 3 h te aviso por Telegram para que llames. Si el aviso o la cancelación caen de noche, salen a las 8:00.')

// ── Costo por anuncio: los cancelados no entran al costo por pedido ──
const r = armarCostoPorAnuncio({
  gastoAnuncios: [{ fecha: '2026-10-08', ad_id: '111111111', ad_nombre: 'VID A', campana_nombre: 'C', gasto: 60000 }],
  pedidos: [
    { utm_content: 'VID A', entregado: true, estado_confirmacion: 'confirmado' },
    { utm_content: 'VID A', entregado: false, estado_confirmacion: 'pendiente' },
    { utm_content: 'VID A', entregado: false, estado_confirmacion: 'cancelado_sin_respuesta' },
    { utm_content: '111111111', entregado: false, estado_confirmacion: 'cancelado_sin_respuesta' },
    { utm_content: 'VID A', entregado: false, estado_confirmacion: 'cancelado_cliente' },
    { utm_content: '', estado_confirmacion: 'cancelado_sin_respuesta' }, // cancelado sin anuncio: no suma a "sin anuncio"
  ],
})
const a = r.filas.find(f => f.anuncio === 'VID A')
assert.equal(a.pedidos, 2); assert.equal(a.sinRespuesta, 2); assert.equal(a.costoPedido, 30000); assert.equal(a.tasaEntrega, 50)
assert.equal(r.total.pedidos, 2); assert.equal(r.total.sinRespuesta, 2); assert.equal(r.total.costoPedido, 30000)
assert.equal(r.sinAnuncio, 0)
// Sin la columna (vista vieja) se comporta igual que antes.
assert.equal(armarCostoPorAnuncio({ pedidos: [{ utm_content: 'X' }] }).filas[0].pedidos, 1)

// ── KPI WhatsApp: "cayó sin respuesta" por semana (lunes, hora de Asunción) ──
const filas = [{ semana: '2026-10-05', pedidos: 10, confirmados: 6 }, { semana: '2026-09-28', pedidos: 8 }]
const k = agregarSinRespuesta(filas, [
  { creado_en: '2026-10-05T03:30:00Z' },  // lunes 00:30 en Asunción → semana del 05-10
  { creado_en: '2026-10-05T02:30:00Z' },  // domingo 23:30 en Asunción → semana del 28-09
  { creado_en: '2026-10-11T12:00:00Z' },
])
assert.equal(k[0].sin_respuesta, 2); assert.equal(k[1].sin_respuesta, 1)
assert.equal(k[0].confirmados, 6) // no toca los confirmados
assert.equal(agregarSinRespuesta(filas, null)[0].sin_respuesta, null)

console.log('✓ confirmación: defaults, validación, merge, ayuda · costo por anuncio sin cancelados · KPI sin respuesta')
