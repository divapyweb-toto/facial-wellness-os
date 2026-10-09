// Corrida completa con un PaP FALSO (respuestas inventadas; nunca toca el servidor real).
import { assert, assertEquals } from 'jsr:@std/assert@1'
import type { FilaCourier, Resumen } from '../importar-courier/procesar.ts'
import { crearClientePaP, type Fetch } from './cliente_pap.ts'
import { ESTADO_INICIAL, type EstadoSync, RUTAS_PAP } from './logica.ts'
import { type DepsSync, ejecutarSync, type TipoEvento } from './sync.ts'
import { escribirXlsx, leerXlsx } from './xlsx.ts'

const BASE = 'https://pap.invalid/trackerservices'
const TOKEN = 'eyJ' + 'a'.repeat(60)
const USUARIO = 'usuario-inventado'
const CLAVE = 'clave-inventada-123'

const GESTION = [
  ['NroGuia', 'NroGuiaRef', 'FechaIng', 'FechaEnt', 'Nombre', 'Recurso', 'Motivo', 'Estado', 'Telefono', 'Importe', 'EstadoDepTesor', 'FechaDepositoTesoreroCliente'],
  ['500', 'VT-9001', '01/10/2026', '02/10/2026', 'Cliente Ficticio', 'Mensajero X', '', 'En ruta', '0981000000', 129000, 'Rendido Tesorero', '05/10/2026'],
  ['501', '2071', '01/10/2026', '', 'Otro Ficticio', '', '', 'Pendiente', '0981000002', 99000, '', ''],
]
const PAQUETES = [
  ['NroGuia', 'NroGuiaRef', 'Nombre', 'Recibido Por', 'Estado', 'Motivo', 'Fecha Ingreso', 'Importe', 'FechaEvento', 'FechaGestion'],
  ['500', 'VT-9001', 'Cliente Ficticio', 'Titular', 'Entregado', '', '01/10/2026', 129000, '02/10/2026', '02/10/2026'],
]

interface Llamada { url: string; init?: RequestInit }

function papFalso(opts: { login?: () => Response; gestion?: () => Response; paquetes?: () => Response } = {}) {
  const llamadas: Llamada[] = []
  const xlsx = (aoa: unknown[][]) => new Response(escribirXlsx(aoa), { status: 200, headers: { 'Content-Type': 'application/xlsx' } })
  const f: Fetch = (url, init) => {
    llamadas.push({ url, init })
    if (url.endsWith(RUTAS_PAP.login)) {
      return Promise.resolve(opts.login?.() ?? new Response(
        JSON.stringify({ result: { accessToken: TOKEN, expireInSeconds: 86400 }, success: true, __abp: true }),
        { status: 200, headers: { 'set-cookie': 'AWSELB=zz;PATH=/' } },
      ))
    }
    if (url.endsWith(RUTAS_PAP.gestion)) return Promise.resolve(opts.gestion?.() ?? xlsx(GESTION))
    if (url.endsWith(RUTAS_PAP.paquetes)) return Promise.resolve(opts.paquetes?.() ?? xlsx(PAQUETES))
    return Promise.resolve(new Response('no', { status: 404 }))
  }
  return { f, llamadas }
}

function deps(f: Fetch, inicial: Partial<EstadoSync> = {}) {
  const mem = {
    estado: { ...ESTADO_INICIAL, ...inicial } as EstadoSync,
    eventos: [] as { tipo: TipoEvento; detalle: Record<string, unknown> }[],
    avisos: [] as string[],
    procesadas: [] as FilaCourier[][],
  }
  const resumen: Resumen = {
    procesadas: 1, avisos_programados: 1, sin_pedido: 0, repetidas: 0, estado_no_reconocido: 0,
    estados_no_reconocidos: [], otra_tienda: 0, cancelados_cliente: 0, errores: [],
  }
  const d: DepsSync = {
    ahora: () => new Date('2026-10-09T14:00:00Z'),
    credenciales: () => ({ usuario: USUARIO, clave: CLAVE }),
    pap: crearClientePaP(f, BASE, 5_000),
    leerXlsx,
    estado: {
      leer: () => Promise.resolve({ ...mem.estado }),
      guardar: (e) => { mem.estado = { ...e }; return Promise.resolve() },
      registrarEvento: (tipo, detalle) => { mem.eventos.push({ tipo, detalle }); return Promise.resolve() },
      contarEventos: (tipo) => Promise.resolve(mem.eventos.filter((e) => e.tipo === tipo).length),
    },
    procesar: (filas) => { mem.procesadas.push(filas); return Promise.resolve(resumen) },
    avisar: (t) => { mem.avisos.push(t); return Promise.resolve() },
    pausa: () => Promise.resolve(),
  }
  return { d, mem }
}

Deno.test('corrida feliz: login, 2 reportes, solo VT- al importador, firmas guardadas', async () => {
  const { f, llamadas } = papFalso()
  const { d, mem } = deps(f)
  const r = await ejecutarSync(d)
  assertEquals(r.ok, true)
  assertEquals(r.filas_gestion, 2)
  assertEquals(r.filas_paquetes, 1)
  assertEquals(r.filas_voltra, 1)
  assertEquals(mem.procesadas[0][0].referencia, 'VT-9001')
  assertEquals(mem.procesadas[0][0].estado_crudo, 'Entregado')
  assertEquals(mem.procesadas[0][0].extra?.rendido, true)
  assertEquals(llamadas.length, 3)
  // Login con el formato ABP; reportes con Bearer y la cookie del balanceador.
  assertEquals(JSON.parse(String(llamadas[0].init?.body)), { userNameOrEmailAddress: USUARIO, password: CLAVE, rememberClient: false })
  const h = llamadas[1].init?.headers as Record<string, string>
  assertEquals(h.Authorization, `Bearer ${TOKEN}`)
  assertEquals(h.Cookie, 'AWSELB=zz')
  assertEquals(JSON.parse(String(llamadas[1].init?.body)).incluirTesoreria, true)
  assert(mem.estado.firma_gestion?.startsWith('NroGuia|NroGuiaRef|FechaIng'))
  assert(mem.estado.ultimo_ok_en)
  assertEquals(mem.avisos, [])
  // La clave nunca aparece en eventos ni avisos.
  assert(!JSON.stringify(mem.eventos).includes(CLAVE))
})

Deno.test('login rechazado 2 veces → frena, avisa UNA vez y la 3ª corrida no toca PaP', async () => {
  const mala = () => new Response(JSON.stringify({ __abp: true, success: false, error: { message: 'Login failed!', details: 'Invalid user name or password' } }), { status: 500 })
  const { f, llamadas } = papFalso({ login: mala })
  const { d, mem } = deps(f)
  assertEquals((await ejecutarSync(d)).motivo, 'login_credenciales')
  assertEquals(mem.avisos.length, 0)
  assertEquals((await ejecutarSync(d)).motivo, 'login_credenciales')
  assertEquals(mem.estado.frenado, true)
  assertEquals(mem.avisos.length, 1)
  assert(!mem.avisos[0].includes(CLAVE) && !mem.avisos[0].includes(USUARIO))
  const antes = llamadas.length
  assertEquals((await ejecutarSync(d)).motivo, 'frenado_por_login')
  assertEquals(llamadas.length, antes) // no se volvió a intentar
  assertEquals(mem.avisos.length, 1)
})

Deno.test('sin secretos o desactivado: no llama a PaP', async () => {
  const { f, llamadas } = papFalso()
  const a = deps(f)
  a.d.credenciales = () => ({})
  assertEquals((await ejecutarSync(a.d)).motivo, 'faltan_secretos')
  const b = deps(f, { activo: false })
  assertEquals((await ejecutarSync(b.d)).motivo, 'desactivado')
  assertEquals(llamadas.length, 0)
})

Deno.test('cambio de columnas: registra el cambio, avisa y sigue si están las requeridas', async () => {
  const { f } = papFalso()
  const { d, mem } = deps(f, { firma_paquetes: 'NroGuia|NroGuiaRef|Estado|Formato|Viejo' })
  const r = await ejecutarSync(d)
  assertEquals(r.ok, true)
  assertEquals(mem.eventos.filter((e) => e.tipo === 'cambio_formato').length, 1)
  assertEquals(mem.avisos.length, 1)
  assert(mem.avisos[0].includes('Paquetes'))
})

Deno.test('faltan columnas requeridas: no procesa nada y avisa una sola vez por formato', async () => {
  const sinTel = GESTION.map((fila) => fila.filter((_, i) => i !== 8)) // sin 'Telefono'
  const xl = () => new Response(escribirXlsx(sinTel), { status: 200 })
  const { f } = papFalso({ gestion: xl })
  const { d, mem } = deps(f)
  const r1 = await ejecutarSync(d)
  assertEquals(r1.ok, false)
  assertEquals(mem.procesadas.length, 0)
  assertEquals(mem.avisos.filter((a) => a.includes('faltan columnas')).length, 1)
  await ejecutarSync(d)
  assertEquals(mem.avisos.filter((a) => a.includes('faltan columnas')).length, 1)
})

Deno.test('endpoint desaparecido (404) y respuesta HTML: cuentan como cambio de formato', async () => {
  const { f } = papFalso({ paquetes: () => new Response('no', { status: 404 }) })
  const { d, mem } = deps(f)
  const r = await ejecutarSync(d)
  assertEquals(r.ok, false)
  assertEquals(mem.eventos.filter((e) => e.tipo === 'cambio_formato').length, 1)
  assert(mem.avisos.some((a) => a.includes('cambió el reporte de Paquetes')))

  const h = papFalso({ gestion: () => new Response('<!DOCTYPE html><html></html>', { status: 200 }) })
  const x = deps(h.f)
  assertEquals((await ejecutarSync(x.d)).ok, false)
  assertEquals(x.mem.eventos.filter((e) => e.tipo === 'cambio_formato').length, 1)
})

Deno.test('la misma falla repetida se registra una vez; el 3er cambio en 90 días recuerda el criterio de abandono', async () => {
  const { f } = papFalso({ paquetes: () => new Response('no', { status: 404 }) })
  const { d, mem } = deps(f)
  for (let i = 0; i < 3; i++) await ejecutarSync(d)
  assertEquals(mem.eventos.filter((e) => e.tipo === 'cambio_formato').length, 1)
  assert(!mem.avisos.some((a) => a.includes('criterio de abandono')))

  const otro = deps(papFalso({ paquetes: () => new Response('no', { status: 404 }) }).f)
  otro.mem.eventos.push({ tipo: 'cambio_formato', detalle: {} }, { tipo: 'cambio_formato', detalle: {} })
  await ejecutarSync(otro.d)
  assert(otro.mem.avisos.some((a) => a.includes('criterio de abandono')))
})

Deno.test('vuelta a la normalidad tras una falla registrada no cuenta como otro cambio', async () => {
  const { f } = papFalso()
  const { d, mem } = deps(f, { firma_paquetes: '!endpoint:404' })
  assertEquals((await ejecutarSync(d)).ok, true)
  assertEquals(mem.eventos.filter((e) => e.tipo === 'cambio_formato').length, 0)
})

Deno.test('servidor caído: no cuenta como login fallido; avisa una vez al 3er error', async () => {
  const { f } = papFalso({ login: () => new Response('<html>502</html>', { status: 502 }) })
  const { d, mem } = deps(f)
  for (let i = 0; i < 4; i++) await ejecutarSync(d)
  assertEquals(mem.estado.fallos_login, 0)
  assertEquals(mem.estado.frenado, false)
  assertEquals(mem.avisos.length, 1)
})
