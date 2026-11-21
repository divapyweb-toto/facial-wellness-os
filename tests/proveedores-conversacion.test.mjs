// Charla con proveedores 24/7: lógica pura de la pantalla (src/pages/productos/conversacion.js).
// Correr: node --import ./tests/registrar.mjs tests/proveedores-conversacion.test.mjs
// Todos los datos son DEMO (correos .invalid, números con ceros); ningún proveedor real.
import { test } from 'node:test'
import assert from 'node:assert/strict'
import {
  mesPY, inicioMesPYISO, costoMesUsd, plantillasMes, configProveedoresDesde, resumenMes, ordenarConversacion, conversacionDe,
  direccionDe, validarContacto, normalizarEmail, normalizarWhatsapp, tieneColumnasContacto, puedePedirPrimerContacto,
  filaPrimerContacto, esPrimerContactoPendiente, estadoMsg, fmtUsd,
} from '../src/pages/productos/conversacion.js'
import { DEMO } from '../src/pages/productos/demo.js'

const AHORA = new Date('2026-11-21T15:00:00Z') // 12:00 en Paraguay
const prov = (extra = {}) => ({ id: 'demo-prov-x', plataforma: 'alibaba', razon_social_declarada: 'Proveedor DEMO X', whatsapp: null, email: 'ventas@demo-x.invalid', wechat: null, canal_preferido: 'email', no_contactar: false, idioma: 'en', ...extra })
const CAND = { id: 'demo-cand-x', nombre: 'DEMO · producto' }
const PERMISO = { id: 'demo-pol-general', candidato_id: null, permite_envio: true, vigente_hasta: null }

test('mes de Paraguay: el borde lo marca la hora PY (UTC-3), no UTC', () => {
  assert.equal(mesPY('2026-12-01T02:59:59Z'), '2026-11') // 23:59:59 del 30-11 en PY
  assert.equal(mesPY('2026-12-01T03:00:00Z'), '2026-12')
  assert.equal(mesPY('basura'), null)
  assert.equal(inicioMesPYISO(AHORA), '2026-11-01T03:00:00.000Z')
  assert.equal(inicioMesPYISO(new Date('2026-12-01T01:00:00Z')), '2026-11-01T03:00:00.000Z')
})

test('gasto del mes: suma costo_usd solo del mes PY, sin error de coma flotante', () => {
  const ms = [
    { creado_en: '2026-11-01T03:00:00Z', costo_usd: 0.1 },
    { creado_en: '2026-11-15T12:00:00Z', costo_usd: '0.2' },        // numeric llega como texto
    { creado_en: '2026-11-01T02:59:59Z', costo_usd: 5 },            // 31-10 en PY: no entra
    { creado_en: '2026-12-01T03:00:00Z', costo_usd: 5 },            // diciembre: no entra
    { creado_en: '2026-11-10T12:00:00Z', costo_usd: null },
    { creado_en: '2026-11-10T12:00:00Z' },                           // sin columna (migración sin aplicar)
    { creado_en: '2026-11-10T12:00:00Z', costo_usd: 'x' },
    { creado_en: '2026-11-10T12:00:00Z', costo_usd: 0.000001 },
  ]
  assert.equal(costoMesUsd(ms, AHORA), 0.300001)
  assert.equal(costoMesUsd([], AHORA), 0)
  assert.equal(costoMesUsd(null, AHORA), 0)
})

test('plantillas del mes: WhatsApp saliente enviado con la ventana de 24 h cerrada', () => {
  const ms = [
    { id: 'a', proveedor_id: 'p1', canal: 'whatsapp', direccion: 'out', estado: 'SENT_CONFIRMED', creado_en: '2026-11-05T12:00:00Z' }, // primer contacto: plantilla
    { id: 'b', proveedor_id: 'p1', canal: 'whatsapp', direccion: 'in', estado: 'RECEIVED', creado_en: '2026-11-06T12:00:00Z' },
    { id: 'c', proveedor_id: 'p1', canal: 'whatsapp', direccion: 'out', estado: 'SENT_CONFIRMED', creado_en: '2026-11-06T20:00:00Z' }, // dentro de 24 h: gratis
    { id: 'd', proveedor_id: 'p1', canal: 'whatsapp', direccion: 'out', estado: 'SENT_CONFIRMED', creado_en: '2026-11-08T12:00:00Z' }, // recordatorio 48 h: plantilla
    { id: 'e', proveedor_id: 'p2', canal: 'whatsapp', direccion: 'out', estado: 'DRAFT', creado_en: '2026-11-08T12:00:00Z' },          // no salió
    { id: 'f', proveedor_id: 'p2', canal: 'whatsapp', direccion: 'out', estado: 'FAILED', creado_en: '2026-11-08T12:00:00Z' },         // no salió
    { id: 'g', proveedor_id: 'p2', canal: 'email', direccion: 'out', estado: 'SENT_CONFIRMED', creado_en: '2026-11-08T12:00:00Z' },    // correo: no es plantilla
    { id: 'h', proveedor_id: 'p3', canal: 'whatsapp', direccion: 'in', estado: 'RECEIVED', creado_en: '2026-10-31T23:00:00Z' },        // del mes anterior abre la ventana
    { id: 'i', proveedor_id: 'p3', canal: 'whatsapp', direccion: 'out', estado: 'SEND_UNKNOWN', creado_en: '2026-11-01T10:00:00Z' },   // dentro de 24 h: gratis
    { id: 'j', proveedor_id: 'p4', canal: 'whatsapp', direccion: 'out', estado: 'SENT_CONFIRMED', creado_en: '2026-10-20T12:00:00Z' }, // otro mes
  ]
  assert.equal(plantillasMes(ms, AHORA), 2)
})

test('config.proveedores: texto JSON; ilegible = topes 10/30 y apagado', () => {
  assert.deepEqual(configProveedoresDesde('{"activo": true, "tope_ia_usd_mes": 7.5, "tope_plantillas_mes": 20}'), { leida: true, activo: true, tope_ia_usd_mes: 7.5, tope_plantillas_mes: 20 })
  assert.deepEqual(configProveedoresDesde(null), { leida: false, activo: false, tope_ia_usd_mes: 10, tope_plantillas_mes: 30 })
  assert.deepEqual(configProveedoresDesde('{roto'), { leida: false, activo: false, tope_ia_usd_mes: 10, tope_plantillas_mes: 30 })
  assert.equal(configProveedoresDesde('{"activo": "true"}').activo, false) // solo true de verdad prende
  assert.equal(configProveedoresDesde('{"tope_ia_usd_mes": -1}').tope_ia_usd_mes, 10)
  assert.equal(configProveedoresDesde({ tope_plantillas_mes: 0 }).tope_plantillas_mes, 0)
})

test('resumen del mes: "USD X de USD 10 de IA · N plantillas de 30" y aviso de tope', () => {
  const ms = [{ creado_en: '2026-11-10T12:00:00Z', costo_usd: 10 }]
  const r = resumenMes(ms, null, AHORA)
  assert.equal(r.gastoUsd, 10); assert.equal(r.topeUsd, 10); assert.equal(r.topePlantillas, 30)
  assert.equal(r.llegoTopeIa, true); assert.equal(r.plantillas, 0); assert.equal(r.activo, false); assert.equal(r.mes, '2026-11')
  assert.match(fmtUsd(3.5), /^USD 3,50$/)
})

test('conversación: de vieja a nueva; empate de hora = entrante primero; filtra por proveedor', () => {
  const ms = [
    { id: '3', proveedor_id: 'p1', direccion: 'out', creado_en: '2026-11-02T10:00:00Z' },
    { id: '2', proveedor_id: 'p1', direccion: 'in', estado: 'RECEIVED', creado_en: '2026-11-02T10:00:00Z' },
    { id: '1', proveedor_id: 'p1', direccion: 'out', creado_en: '2026-11-01T10:00:00Z' },
    { id: '9', proveedor_id: 'p2', direccion: 'in', creado_en: '2026-11-01T09:00:00Z' },
  ]
  assert.deepEqual(conversacionDe(ms, 'p1').map(m => m.id), ['1', '2', '3'])
  assert.deepEqual(ordenarConversacion(ms).map(m => m.id), ['9', '1', '2', '3'])
  assert.equal(ms[0].id, '3') // no muta la lista original
  // Sin la columna direccion (migración sin aplicar): RECEIVED es entrante, lo demás saliente.
  assert.equal(direccionDe({ estado: 'RECEIVED' }), 'in')
  assert.equal(direccionDe({ estado: 'DRAFT' }), 'out')
  assert.deepEqual(estadoMsg('RECEIVED'), ['Recibido', 'badge-purple'])
  assert.deepEqual(estadoMsg('RARO'), ['RARO', 'badge-gray'])
})

test('datos de contacto: correo en minúscula, WhatsApp solo dígitos con código de país, canal y idioma válidos', () => {
  assert.equal(normalizarEmail('  Ventas@Demo-X.INVALID '), 'ventas@demo-x.invalid')
  assert.equal(normalizarWhatsapp('+86 000-0000-0001'), '8600000000001')
  const ok = validarContacto({ email: ' Ventas@Demo-X.Invalid', whatsapp: '+86 000 0000 0001', wechat: '  demo_wx ', canal_preferido: 'whatsapp', idioma: 'zh', no_contactar: false })
  assert.equal(ok.ok, true)
  assert.deepEqual(ok.cambios, { email: 'ventas@demo-x.invalid', whatsapp: '8600000000001', wechat: 'demo_wx', canal_preferido: 'whatsapp', idioma: 'zh', no_contactar: false })
  const vacio = validarContacto({ email: '', whatsapp: '', wechat: '', canal_preferido: '', idioma: '', no_contactar: true })
  assert.deepEqual(vacio.cambios, { email: null, whatsapp: null, wechat: null, canal_preferido: null, idioma: null, no_contactar: true })
  assert.ok(validarContacto({ email: 'sin-arroba.invalid' }).errores.email)
  assert.ok(validarContacto({ email: 'a b@demo.invalid' }).errores.email)
  assert.match(validarContacto({ whatsapp: '0981 000 000' }).errores.whatsapp, /código de país/)
  assert.ok(validarContacto({ whatsapp: '1234567' }).errores.whatsapp)          // 7 dígitos
  assert.ok(validarContacto({ whatsapp: '1234567890123456' }).errores.whatsapp) // 16 dígitos
  assert.ok(validarContacto({ whatsapp: '---' }).errores.whatsapp)
  assert.ok(validarContacto({ canal_preferido: 'wechat' }).errores.canal_preferido)
  assert.match(validarContacto({ canal_preferido: 'email' }).errores.canal_preferido, /correo/)
  assert.match(validarContacto({ canal_preferido: 'whatsapp' }).errores.canal_preferido, /WhatsApp/)
  assert.equal(validarContacto({ canal_preferido: '1688' }).ok, true)
  assert.ok(validarContacto({ idioma: 'fr' }).errores.idioma)
  assert.ok(validarContacto({ wechat: 'x'.repeat(65) }).errores.wechat)
  assert.equal(validarContacto({ email: 'malo' }).cambios, null)
})

test('pedir primer contacto: solo con correo, sin "no contactar", con producto, permiso general y sin otro en cola', () => {
  const base = { proveedor: prov(), candidato: CAND, permisoGeneral: PERMISO, mensajes: [], ahora: AHORA }
  assert.deepEqual(puedePedirPrimerContacto(base), { ok: true, motivo: null })
  assert.match(puedePedirPrimerContacto({ ...base, proveedor: prov({ email: null }) }).motivo, /Sin correo/)
  assert.match(puedePedirPrimerContacto({ ...base, proveedor: prov({ no_contactar: true }) }).motivo, /No contactar/)
  assert.match(puedePedirPrimerContacto({ ...base, candidato: null }).motivo, /producto/)
  assert.match(puedePedirPrimerContacto({ ...base, permisoGeneral: { ...PERMISO, permite_envio: false } }).motivo, /permiso general/)
  assert.match(puedePedirPrimerContacto({ ...base, permisoGeneral: null }).motivo, /permiso general/)
  assert.match(puedePedirPrimerContacto({ ...base, permisoGeneral: { ...PERMISO, candidato_id: 'otro' } }).motivo, /permiso general/)
  assert.match(puedePedirPrimerContacto({ ...base, permisoGeneral: { ...PERMISO, vigente_hasta: '2026-11-01T00:00:00Z' } }).motivo, /permiso general/)
  const sinCols = { id: 'demo-prov-y', plataforma: 'alibaba' } // migración sin aplicar: no hay columnas de contacto
  assert.equal(tieneColumnasContacto(sinCols), false)
  assert.match(puedePedirPrimerContacto({ ...base, proveedor: sinCols }).motivo, /migración/)
  const pendiente = { proveedor_id: 'demo-prov-x', canal: 'email', direccion: 'out', estado: 'AUTHORIZED', hilo: null, autor: 'admin' }
  assert.equal(esPrimerContactoPendiente(pendiente), true)
  assert.match(puedePedirPrimerContacto({ ...base, mensajes: [pendiente] }).motivo, /esperando/)
  // Uno ya mandado (con hilo) no bloquea uno nuevo.
  assert.equal(puedePedirPrimerContacto({ ...base, mensajes: [{ ...pendiente, estado: 'SENT_CONFIRMED', hilo: 'h1' }] }).ok, true)
})

test('fila de primer contacto: exactamente la que lee proveedores-gmail (AUTHORIZED, original null, pedido en traduccion)', () => {
  const fila = filaPrimerContacto({ proveedor: prov(), candidato: CAND, permisoGeneral: PERMISO, mensajes: [], asunto: '  Quotation   request ', pedido: ' Precio por 100 y 300 unidades, peso y caja. ', ahora: AHORA })
  assert.deepEqual(fila, {
    politica_id: 'demo-pol-general', candidato_id: 'demo-cand-x', proveedor_id: 'demo-prov-x',
    canal: 'email', direccion: 'out', estado: 'AUTHORIZED', hilo: null, autor: 'admin',
    asunto: 'Quotation request', original: null, traduccion: 'Precio por 100 y 300 unidades, peso y caja.', idioma: 'en',
    idempotencia: 'email:out:demo-prov-x:primer:1',
  })
  // n sube con los primeros contactos anteriores (idempotencia única).
  const previo = { proveedor_id: 'demo-prov-x', canal: 'email', direccion: 'out', estado: 'SENT_CONFIRMED', hilo: 'h1', idempotencia: 'email:out:demo-prov-x:primer:1' }
  assert.equal(filaPrimerContacto({ proveedor: prov(), candidato: CAND, permisoGeneral: PERMISO, mensajes: [previo], asunto: 'Hola', pedido: 'Precio por 100 unidades' }).idempotencia, 'email:out:demo-prov-x:primer:2')
  assert.throws(() => filaPrimerContacto({ proveedor: prov(), candidato: CAND, permisoGeneral: PERMISO, mensajes: [], asunto: 'ab', pedido: 'Precio por 100 unidades' }), /asunto/)
  assert.throws(() => filaPrimerContacto({ proveedor: prov(), candidato: CAND, permisoGeneral: PERMISO, mensajes: [], asunto: 'Hola', pedido: 'corto' }), /qué pedirle/)
  assert.throws(() => filaPrimerContacto({ proveedor: prov({ no_contactar: true }), candidato: CAND, permisoGeneral: PERMISO, mensajes: [], asunto: 'Hola', pedido: 'Precio por 100 unidades' }), /No contactar/)
  assert.throws(() => filaPrimerContacto({ proveedor: prov({ email: null }), candidato: CAND, permisoGeneral: PERMISO, mensajes: [], asunto: 'Hola', pedido: 'Precio por 100 unidades' }), /Sin correo/)
})

test('DEMO: solo datos inventados y coherentes con los checks de la base', () => {
  for (const p of DEMO.pi_proveedores) {
    assert.ok(tieneColumnasContacto(p), `${p.id} trae columnas de contacto`)
    if (p.email) { assert.match(p.email, /\.invalid$/, 'correo DEMO con dominio .invalid'); assert.equal(p.email, p.email.toLowerCase()) }
    if (p.whatsapp) { assert.match(p.whatsapp, /^\d{8,15}$/); assert.match(p.whatsapp, /^860+\d$/, 'número DEMO de ceros') }
    assert.equal(validarContacto(p).ok, true, `${p.id} pasa la validación`)
  }
  for (const m of DEMO.pi_mensajes) {
    if (m.estado === 'RECEIVED') { assert.equal(m.direccion, 'in'); assert.equal(m.politica_id, null) }
    if (m.direccion === 'out') assert.ok(m.politica_id, 'saliente con permiso')
    assert.match(`${m.original || ''} ${m.traduccion || ''}`, /DEMO/)
  }
  assert.equal(configProveedoresDesde(DEMO.config_proveedores).leida, true)
})
