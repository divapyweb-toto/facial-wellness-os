import { test } from 'node:test'
import assert from 'node:assert/strict'
import { readFileSync, readdirSync } from 'node:fs'
import {
  interpretarMensaje, formatearTextoWA, textoPlano, textoVistaPrevia, armarLineaDeTiempo,
  reaccionesPorMensaje, barrasAudio, formatoDuracion, etiquetaDia,
} from '../src/pages/bandeja/mensajeWA.js'

const plantillas = Object.fromEntries(
  readdirSync('supabase/plantillas').filter(f => f.endsWith('.json'))
    .map(f => JSON.parse(readFileSync(`supabase/plantillas/${f}`, 'utf8'))).map(d => [d.name, d]),
)
const fila = (o) => ({ id: 'm' + Math.random(), direccion: 'in', creado_en: '2026-10-07T12:00:00Z', estado: 'entregado', ...o })

test('formato: negrita, cursiva, tachado, código y enlace', () => {
  const n = formatearTextoWA('Hola *mundo* _lindo_ ~no~ `x` https://a.com/b.')
  const tipos = n.map(x => x.t)
  assert.deepEqual(tipos.filter(t => t !== 'text'), ['b', 'i', 's', 'code', 'link'])
  assert.equal(n.find(x => x.t === 'link').href, 'https://a.com/b') // sin el punto final
  assert.equal(textoPlano('*a* y _b_'), 'a y b')
})

test('formato: no rompe con asteriscos sueltos ni snake_case', () => {
  assert.equal(textoPlano('2 * 3 * 4'), '2 * 3 * 4')
  assert.equal(textoPlano('mi_variable_larga'), 'mi_variable_larga')
  assert.equal(textoPlano(''), '')
  assert.equal(textoPlano(null), '')
})

test('imagen entrante con foto guardada', () => {
  const v = interpretarMensaje(fila({ tipo: 'image', contenido: { storage_path: 'media/1/a.jpg', image: { id: 'x' } } }))
  assert.equal(v.kind, 'image'); assert.equal(v.ruta, 'media/1/a.jpg')
})
test('imagen vieja sin guardar → sin ruta (la burbuja avisa)', () => {
  const v = interpretarMensaje(fila({ tipo: 'image', texto: '[imagen]', contenido: { image: { id: 'x' } } }))
  assert.equal(v.ruta, null); assert.equal(v.caption, '')
})
test('audio con transcripción', () => {
  const v = interpretarMensaje(fila({ tipo: 'audio', contenido: { storage_path: 'media/1/b.ogg', transcripcion: 'hola' } }))
  assert.equal(v.kind, 'audio'); assert.equal(v.transcripcion, 'hola')
  assert.equal(textoVistaPrevia(fila({ tipo: 'audio', contenido: {} })), '🎤 Mensaje de voz')
})
test('video y sticker y documento', () => {
  assert.equal(interpretarMensaje(fila({ tipo: 'video', contenido: { storage_path: 'p', video: { caption: 'mirá' } } })).caption, 'mirá')
  assert.equal(interpretarMensaje(fila({ tipo: 'sticker', contenido: { storage_path: 'p' } })).kind, 'sticker')
  assert.equal(interpretarMensaje(fila({ tipo: 'document', contenido: { document: { filename: 'a.pdf' } } })).nombre, 'a.pdf')
})
test('ubicación', () => {
  const v = interpretarMensaje(fila({ tipo: 'location', contenido: { location: { latitude: -25.5, longitude: -54.6, name: 'Casa' } } }))
  assert.equal(v.kind, 'location'); assert.equal(v.nombre, 'Casa')
})
test('interactivos salientes: botones, lista y enlace', () => {
  const b = interpretarMensaje(fila({ direccion: 'out', tipo: 'interactive', contenido: { interactive: { type: 'button', body: { text: '¿Confirmás?' }, action: { buttons: [{ reply: { id: 'si', title: 'Sí' } }, { reply: { id: 'no', title: 'No' } }] } } } }))
  assert.equal(b.kind, 'botones'); assert.deepEqual(b.botones.map(x => x.titulo), ['Sí', 'No'])
  const l = interpretarMensaje(fila({ direccion: 'out', tipo: 'interactive', contenido: { interactive: { type: 'list', body: { text: 'Elegí' }, action: { button: 'Ver', sections: [{ title: 'S', rows: [{ id: '1', title: 'Uno', description: 'd' }] }] } } } }))
  assert.equal(l.kind, 'lista'); assert.equal(l.secciones[0].filas[0].titulo, 'Uno')
  const c = interpretarMensaje(fila({ direccion: 'out', tipo: 'interactive', contenido: { interactive: { type: 'cta_url', body: { text: 'Mirá' }, action: { parameters: { display_text: 'Abrir', url: 'https://v.com' } } } } }))
  assert.equal(c.kind, 'cta'); assert.equal(c.url, 'https://v.com')
})
test('respuesta del cliente a botón o lista', () => {
  const r = interpretarMensaje(fila({ tipo: 'interactive', contenido: { interactive: { type: 'button_reply', button_reply: { id: 'si', title: 'Sí' } } } }))
  assert.equal(r.kind, 'respuesta'); assert.equal(r.texto, 'Sí')
  const l = interpretarMensaje(fila({ tipo: 'interactive', contenido: { interactive: { type: 'list_reply', list_reply: { id: '1', title: 'Uno', description: 'd' } } } }))
  assert.equal(l.lista, true)
  assert.equal(interpretarMensaje(fila({ tipo: 'button', contenido: { button: { text: 'Confirmar' } } })).texto, 'Confirmar')
})
test('plantillas reales: se rellenan {{n}} y se muestran los botones', () => {
  const v = interpretarMensaje(fila({ direccion: 'out', tipo: 'template', contenido: { template: { name: 'voltra_confirmacion_pedido', components: [{ type: 'body', parameters: ['Ana', '1 Tiras', '129.000', 'Calle 1', 'CDE'].map(text => ({ type: 'text', text })) }] } } }), { plantillas })
  assert.equal(v.kind, 'plantilla')
  assert.match(v.cuerpo, /Hola Ana, recibimos tu pedido de Voltra: 1 Tiras/)
  assert.doesNotMatch(v.cuerpo, /\{\{/)
  assert.deepEqual(v.botones.map(b => b.titulo), ['Confirmar', 'Corregir datos', 'Cancelar'])
})
test('plantilla desconocida no rompe', () => {
  const v = interpretarMensaje(fila({ direccion: 'out', tipo: 'template', texto: '[plantilla zzz] hola', contenido: { template: { name: 'zzz' } } }), { plantillas })
  assert.equal(v.kind, 'text')
})
test('tipo raro y contenido vacío no rompen', () => {
  assert.equal(interpretarMensaje(fila({ tipo: 'raro', contenido: null })).kind, 'text')
  assert.equal(interpretarMensaje(fila({ tipo: 'image', contenido: undefined })).kind, 'image')
})
test('cita a otro mensaje por wa_message_id', () => {
  const a = fila({ tipo: 'text', texto: 'original', wa_message_id: 'w1', contenido: { text: { body: 'original' } } })
  const b = fila({ tipo: 'text', contenido: { text: { body: 'resp' }, context: { id: 'w1' } } })
  const v = interpretarMensaje(b, { porWamid: new Map([['w1', a]]) })
  assert.equal(v.cita.texto, 'original')
})
test('línea de tiempo: separador de día, tramos y reacciones fuera de burbuja', () => {
  const ms = [
    fila({ id: 'a', tipo: 'text', texto: 'x', creado_en: '2026-10-06T12:00:00Z' }),
    fila({ id: 'b', tipo: 'text', texto: 'y', creado_en: '2026-10-07T12:00:00Z' }),
    fila({ id: 'c', tipo: 'text', texto: 'z', creado_en: '2026-10-07T12:01:00Z' }),
    fila({ id: 'd', tipo: 'reaction', contenido: { reaction: { emoji: '👍', message_id: 'w1' } }, creado_en: '2026-10-07T12:02:00Z' }),
    fila({ id: 'e', tipo: 'text', texto: 'w', direccion: 'out', creado_en: '2026-10-07T12:03:00Z' }),
  ]
  const t = armarLineaDeTiempo(ms, {}, new Date('2026-10-07T15:00:00Z'))
  assert.deepEqual(t.map(x => x.tipo), ['dia', 'msg', 'dia', 'msg', 'msg', 'msg'])
  assert.equal(t[0].label.length > 0, true)
  assert.equal(t[2].label, 'HOY')
  const msgs = t.filter(x => x.tipo === 'msg')
  assert.deepEqual(msgs.map(x => x.primero), [true, true, false, true])
  assert.deepEqual(msgs.map(x => x.ultimo), [true, false, true, true])
  assert.deepEqual(reaccionesPorMensaje(ms).w1, [{ dir: 'in', emoji: '👍' }])
})
test('etiquetas de día, barras y duración', () => {
  const ahora = new Date('2026-10-07T15:00:00Z')
  assert.equal(etiquetaDia('2026-10-06T15:00:00Z', ahora), 'AYER')
  assert.deepEqual(barrasAudio('x'), barrasAudio('x'))
  assert.equal(barrasAudio('x').length, 32)
  assert.ok(barrasAudio('x').every(h => h >= 0.25 && h <= 1))
  assert.equal(formatoDuracion(65), '1:05'); assert.equal(formatoDuracion(NaN), '0:00')
})
