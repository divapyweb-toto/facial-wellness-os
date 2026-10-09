// Datos 100 % inventados (repo público): referencias VT-9xxx, teléfonos 0981000000.
import { assert, assertEquals } from 'jsr:@std/assert@1'
import {
  aFechaISO, cambioDeFormato, clasificarDescarga, clasificarLogin, columnasFaltantes, combinarAFilas,
  cuerpoGestion, cuerpoPaquetes, ESTADO_INICIAL, esXlsx, fechaAsuncion, rangoFechas, refVoltra, trasError,
  trasExito, trasLogin,
} from './logica.ts'
import { cookiesDe } from './cliente_pap.ts'

Deno.test('rangoFechas: 00:00 de Asunción de hace N días hasta ahora, tope 60', () => {
  const ahora = new Date('2026-10-09T02:00:00Z') // 08-10 23:00 en Asunción
  assertEquals(fechaAsuncion(ahora), '2026-10-08')
  assertEquals(rangoFechas(ahora, 30), { desde: '2026-09-08T03:00:00.000Z', hasta: '2026-10-09T02:00:00.000Z' })
  assertEquals(rangoFechas(ahora, 500).desde, '2026-08-09T03:00:00.000Z') // 60 días
  const g = cuerpoGestion(rangoFechas(ahora, 1))
  assertEquals(g.incluirTesoreria, true)
  assertEquals(g.filtros, [])
  assertEquals(Object.keys(cuerpoPaquetes(rangoFechas(ahora))), ['fechaEnt', 'fechaEntHasta'])
})

Deno.test('clasificarLogin: ABP envuelto, clave mala, bloqueo, caído', () => {
  const tok = 'eyJ' + 'x'.repeat(40)
  const ok = clasificarLogin(200, JSON.stringify({ result: { accessToken: tok, expireInSeconds: 86400 }, success: true, __abp: true }))
  assertEquals(ok.tipo, 'ok')
  assertEquals(ok.token, tok)
  assertEquals(clasificarLogin(200, JSON.stringify({ accessToken: tok })).tipo, 'ok') // sin envoltorio
  const mala = clasificarLogin(500, JSON.stringify({ success: false, __abp: true, error: { message: 'Login failed!', details: 'Invalid user name or password' } }))
  assertEquals(mala.tipo, 'credenciales')
  assertEquals(clasificarLogin(401, '').tipo, 'credenciales')
  assertEquals(clasificarLogin(500, JSON.stringify({ __abp: true, error: { message: 'Login failed!', details: 'The user account has been locked out.' } })).tipo, 'bloqueado')
  assertEquals(clasificarLogin(502, '<html>Bad gateway</html>').tipo, 'servidor')
  assertEquals(clasificarLogin(200, '{}').tipo, 'servidor')
  assertEquals(clasificarLogin(500, JSON.stringify({ __abp: true, error: { message: 'An internal error occurred' } })).tipo, 'servidor')
})

Deno.test('clasificarDescarga: xlsx, sesión, endpoint, formato', () => {
  const pk = new Uint8Array([0x50, 0x4b, 0x03, 0x04, 1, 2, 3])
  assert(esXlsx(pk))
  assertEquals(clasificarDescarga(200, pk).tipo, 'ok')
  assertEquals(clasificarDescarga(401, new Uint8Array()).tipo, 'sesion')
  assertEquals(clasificarDescarga(404, new Uint8Array()).tipo, 'endpoint')
  assertEquals(clasificarDescarga(200, new TextEncoder().encode('<!DOCTYPE html>')).tipo, 'formato')
  assertEquals(clasificarDescarga(503, new Uint8Array()).tipo, 'servidor')
})

Deno.test('refVoltra / fechas / columnas', () => {
  assertEquals(refVoltra('VT-01003'), 'VT-1003')
  assertEquals(refVoltra('#vt1003'), 'VT-1003')
  assertEquals(refVoltra('FW-2071'), null)
  assertEquals(refVoltra('2071'), null)
  assertEquals(aFechaISO('31/07/2026 10:00'), '2026-07-31')
  assertEquals(aFechaISO(new Date('2026-08-01T12:00:00Z')), '2026-08-01')
  assertEquals(columnasFaltantes('paquetes', ['NroGuia', 'NroGuiaRef', 'Estado']), ['Motivo', 'FechaEvento', 'Fecha Ingreso'])
  assert(!cambioDeFormato(null, 'a|b'))
  assert(cambioDeFormato('a|b', 'a|c'))
})

Deno.test('combinarAFilas: Paquete manda el estado, Gestión aporta tel/tesorería, solo VT-, sin repetidas', () => {
  const paquetes = [
    { NroGuia: '100', NroGuiaRef: 'VT-9001', Estado: 'Entregado', Motivo: '', Importe: 129000, FechaEvento: '02/10/2026', 'Fecha Ingreso': '01/10/2026' },
    { NroGuia: '101', NroGuiaRef: '2071', Estado: 'Entregado', Motivo: '', Importe: 99000 }, // Facial Wellness
  ]
  const gestion = [
    { NroGuia: '100', NroGuiaRef: 'VT-9001', Estado: 'En ruta', Telefono: '0981 000 000', FechaIng: new Date('2026-10-01T12:00:00Z'),
      FechaEnt: new Date('2026-10-02T12:00:00Z'), Recurso: 'Mensajero X', EstadoDepTesor: 'Rendido Tesorero',
      FechaDepositoTesoreroCliente: new Date('2026-10-05T12:00:00Z') },
    { NroGuia: '102', NroGuiaRef: 'vt-09002', Estado: 'Custodio', Motivo: 'Inubicable', Telefono: '+595981000001', Recurso: '' },
    { NroGuia: '103', NroGuiaRef: 'VT-9002', Estado: 'Custodio', Motivo: 'Inubicable', Telefono: '+595981000001', Recurso: '' }, // repetida
  ]
  const f = combinarAFilas(paquetes, gestion)
  assertEquals(f.length, 2)
  assertEquals(f[0], {
    referencia: 'VT-9001', estado_crudo: 'Entregado', telefono: '0981000000', fecha: '2026-10-02',
    extra: { nro_guia: '100', rendido: true, fecha_rendido: '2026-10-05', motivo: '', importe: 129000, ruta_asignada: true },
  })
  assertEquals(f[1].referencia, 'VT-9002')
  assertEquals(f[1].estado_crudo, 'Custodio')
  assertEquals(f[1].extra?.motivo, 'Inubicable')
  assertEquals(f[1].extra?.rendido, false)
})

Deno.test('trasLogin: frena al 2º fallo seguido y avisa una sola vez; ok resetea', () => {
  const mal = { tipo: 'credenciales' as const, detalle: 'x' }
  const a = trasLogin(ESTADO_INICIAL, mal)
  assertEquals(a.estado.fallos_login, 1)
  assertEquals(a.estado.frenado, false)
  assertEquals(a.aviso, null)
  const b = trasLogin(a.estado, mal)
  assertEquals(b.estado.frenado, true)
  assert(b.aviso && b.aviso.includes('Frené'))
  const c = trasLogin(b.estado, mal)
  assertEquals(c.aviso, null) // ya avisado
  const d = trasLogin(c.estado, { tipo: 'ok', token: 't', detalle: 'ok' })
  assertEquals(d.estado.fallos_login, 0)
  assertEquals(d.estado.frenado, false)
  // Un error de red no cuenta como login fallido.
  const e = trasLogin(ESTADO_INICIAL, { tipo: 'servidor', detalle: 'red' })
  assertEquals(e.estado.fallos_login, 0)
  assertEquals(e.estado.errores_seguidos, 1)
})

Deno.test('trasError: avisa una vez al 3er error seguido; trasExito resetea', () => {
  let e = ESTADO_INICIAL
  const avisos: (string | null)[] = []
  for (let i = 0; i < 5; i++) { const t = trasError(e, 'HTTP 503'); e = t.estado; avisos.push(t.aviso) }
  assertEquals(avisos.filter(Boolean).length, 1)
  assert(avisos[2])
  const ok = trasExito(e, new Date('2026-10-09T12:00:00Z'))
  assertEquals(ok.errores_seguidos, 0)
  assertEquals(ok.aviso_errores_enviado, false)
  assertEquals(ok.ultimo_ok_en, '2026-10-09T12:00:00.000Z')
})

Deno.test('cookiesDe: solo las del balanceador', () => {
  const h = new Headers()
  h.append('set-cookie', 'AWSELB=abc;PATH=/')
  h.append('set-cookie', 'AWSELBCORS=def;PATH=/;SECURE')
  h.append('set-cookie', 'otra=1; Path=/')
  assertEquals(cookiesDe(new Response('', { headers: h })), 'AWSELB=abc; AWSELBCORS=def')
})
