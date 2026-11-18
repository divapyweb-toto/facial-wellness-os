// Permiso general para negociar + fotos siempre visibles (contrato FUNCIONES 18-11).
// Correr: node --import ./tests/registrar.mjs tests/productos-fotos.test.mjs
// Datos inventados (DEMO).
import { test } from 'node:test'
import assert from 'node:assert/strict'
import { esPermisoGeneral, politicaVigente, textoNegocia, topesPermisoGeneral, NUNCA_CUBRE } from '../src/pages/productos/derivados.js'
import { fotoPrincipal, alertaFoto, urlFotoExternaValida, armarTarjetas } from '../src/pages/importaciones/logica.js'
import { DEMO } from '../src/pages/productos/demo.js'

const ALCANCE = { tipo: 'general', negocia: ['precio', 'cantidades', 'color_variante', 'calidad', 'empaque', 'plazos', 'condiciones'], proveedores_max_por_producto: 10, rondas_max_por_producto: 3, seguimiento_dias_habiles: 2 }
const general = (extra = {}) => ({ id: 'g', candidato_id: null, alcance: ALCANCE, permite_envio: false, vigente_hasta: null, ...extra })
const ahora = new Date('2026-11-18T12:00:00Z')

test('esPermisoGeneral: candidato_id null y alcance tipo general', () => {
  assert.equal(esPermisoGeneral(general()), true)
  assert.equal(esPermisoGeneral(general({ candidato_id: 'demo-cand' })), false)
  assert.equal(esPermisoGeneral({ candidato_id: null, alcance: { proveedores_max: 5 } }), false)
  assert.equal(esPermisoGeneral(null), false)
})

test('politicaVigente: general sin fecha no vence; por producto sin fecha no vale', () => {
  assert.equal(politicaVigente(general(), ahora), false, 'sin autorizar')
  assert.equal(politicaVigente(general({ permite_envio: true }), ahora), true, 'autorizado, sin fecha = no vence')
  assert.equal(politicaVigente(general({ permite_envio: true, vigente_hasta: '2026-11-10T00:00:00Z' }), ahora), false, 'si viene con fecha, se respeta')
  assert.equal(politicaVigente({ candidato_id: 'c', permite_envio: true, vigente_hasta: null }, ahora), false, 'por producto exige fecha')
  assert.equal(politicaVigente({ candidato_id: 'c', permite_envio: true, vigente_hasta: '2026-11-30T00:00:00Z' }, ahora), true)
  assert.equal(politicaVigente(undefined, ahora), false)
})

test('textoNegocia y topes en palabras simples', () => {
  assert.equal(textoNegocia(ALCANCE), 'precio, cantidades, color o variante, calidad, empaque, plazos y condiciones')
  assert.equal(textoNegocia({ negocia: ['precio'] }), 'precio')
  assert.equal(textoNegocia({}), 'nada cargado')
  assert.deepEqual(topesPermisoGeneral(ALCANCE), { proveedores: 10, rondas: 3, seguimientoDias: 2 })
  assert.deepEqual(topesPermisoGeneral({}), { proveedores: 10, rondas: 3, seguimientoDias: 2 }, 'por defecto 10 y 3')
  for (const x of ['pagar', 'comprar muestras', 'prometer exclusividad', 'aceptar términos']) assert.ok(NUNCA_CUBRE.includes(x))
  assert.ok(NUNCA_CUBRE.some(x => /orden/.test(x)))
})

test('foto principal: solo cuenta es_principal; sin principal = alerta', () => {
  assert.deepEqual(alertaFoto([]), { tipo: 'sin_foto', texto: 'Sin foto' })
  assert.deepEqual(alertaFoto(null), { tipo: 'sin_foto', texto: 'Sin foto' })
  const sinPrincipal = [{ id: 1, es_principal: false }, { id: 2, es_principal: false }]
  assert.equal(fotoPrincipal(sinPrincipal), null)
  assert.equal(alertaFoto(sinPrincipal).tipo, 'sin_principal')
  assert.equal(alertaFoto([{ id: 1, es_principal: false }, { id: 2, es_principal: true }]), null)
})

test('urlFotoExternaValida: solo http/https, nunca data: ni otros esquemas', () => {
  assert.equal(urlFotoExternaValida('https://ejemplo.invalid/foto.jpg'), true)
  assert.equal(urlFotoExternaValida('http://ejemplo.invalid/foto.jpg'), true)
  assert.equal(urlFotoExternaValida('  https://ejemplo.invalid/x.png  '), true)
  assert.equal(urlFotoExternaValida('data:image/png;base64,AAAA'), false)
  assert.equal(urlFotoExternaValida('javascript:alert(1)'), false)
  assert.equal(urlFotoExternaValida('ftp://ejemplo.invalid/x.jpg'), false)
  assert.equal(urlFotoExternaValida('https://'), false)
  assert.equal(urlFotoExternaValida(''), false)
  assert.equal(urlFotoExternaValida(null), false)
})

test('tarjetas: alerta de foto por candidato; sin tabla de fotos no alerta', () => {
  const t = { candidatos: [{ id: 'a' }, { id: 'b' }, { id: 'c' }], fotos: [{ id: 1, candidato_id: 'a', es_principal: true }, { id: 2, candidato_id: 'b', es_principal: false }] }
  const [a, b, c] = armarTarjetas(t, ahora)
  assert.equal(a.alertaFoto, null)
  assert.equal(b.alertaFoto.tipo, 'sin_principal')
  assert.equal(c.alertaFoto.tipo, 'sin_foto')
  assert.equal(armarTarjetas({ candidatos: [{ id: 'a' }], fotos: null }, ahora)[0].alertaFoto, null)
})

test('DEMO: hay un permiso general (único, sin autorizar) y un mensaje bajo él con candidato_id', () => {
  const generales = DEMO.pi_politicas.filter(p => p.candidato_id == null)
  assert.equal(generales.length, 1)
  assert.equal(esPermisoGeneral(generales[0]), true)
  assert.equal(generales[0].permite_envio, false)
  assert.equal(generales[0].vigente_hasta, null)
  const msgs = DEMO.pi_mensajes.filter(m => m.politica_id === generales[0].id)
  assert.ok(msgs.length >= 1 && msgs.every(m => m.candidato_id))
  // Ningún dato real: los links externos DEMO apuntan a .invalid o son SVG generados.
  for (const f of DEMO.pi_fotos) assert.ok(/^data:image\/svg\+xml|^https:\/\/ejemplo\.invalid\//.test(f.url_externa || ''))
})
