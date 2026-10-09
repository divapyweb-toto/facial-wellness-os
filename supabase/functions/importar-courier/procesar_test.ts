// Datos 100 % inventados (repo público): teléfonos 0981000000 y nombres ficticios.
import { assert, assertEquals } from 'jsr:@std/assert@1'
import type { EstadoEnvio } from '../_shared/tipos.ts'
import { normalizarTelefonoPY } from '../_shared/telefono.ts'
import {
  type ConfigImport, type EnvioNuevo, type PedidoImport, type Repo,
  fechaISO, manianaALas10, montoSano, numeroDesdeReferencia, procesarFilas, sanearFila,
} from './procesar.ts'

const AHORA = new Date('2026-10-06T15:00:00Z') // 12:00 en Asunción

function pedido(over: Partial<PedidoImport> = {}): PedidoImport {
  return {
    shopify_order_id: 9001,
    nombre: '#1001',
    cliente_id: 'cli-1',
    telefono: '+595981000000',
    total: 129000,
    estado_confirmacion: 'confirmado',
    estado_envio: null,
    tags: [],
    es_borrador: false,
    raw: { customer: { first_name: 'Ana Prueba' }, line_items: [{ title: 'Tiras nasales', quantity: 1 }] },
    cliente_nombre: null,
    ...over,
  }
}

function repoMemoria(pedidos: PedidoImport[]) {
  const estados = new Set<string>()
  const claves = new Set<string>()
  const log = {
    envios: [] as EnvioNuevo[],
    revision: [] as { referencia: string; motivo: string }[],
    eventos: [] as string[],
    tags: [] as string[],
    estadoEnvio: [] as string[],
    notificados: [] as string[],
  }
  const repo: Repo = {
    buscarPedidoPorNumero: (n) =>
      Promise.resolve(pedidos.find((p) => p.nombre === `#${n}`) ?? null),
    buscarPedidosPorTelefono: (t) => Promise.resolve(pedidos.filter((p) => p.telefono === t)),
    insertarEstado: (id, e) => {
      const k = `${id}:${e}`
      if (estados.has(k)) return Promise.resolve(false)
      estados.add(k)
      return Promise.resolve(true)
    },
    marcarNotificado: (id, e) => { log.notificados.push(`${id}:${e}`); return Promise.resolve() },
    avisoPendiente: (id, e) =>
      Promise.resolve(estados.has(`${id}:${e}`) && !log.notificados.includes(`${id}:${e}`)),
    actualizarEstadoEnvio: (id, e) => {
      log.estadoEnvio.push(`${id}:${e}`)
      const p = pedidos.find((x) => x.shopify_order_id === id)
      if (p) p.estado_envio = e
      return Promise.resolve()
    },
    programarEnvio: (env) => {
      if (claves.has(env.clave_unica)) return Promise.resolve(false)
      claves.add(env.clave_unica)
      log.envios.push(env)
      return Promise.resolve(true)
    },
    enviarARevision: (_c, referencia, _f, motivo) => { log.revision.push({ referencia, motivo }); return Promise.resolve() },
    crearEventoEnvio: (id, e) => { log.eventos.push(`${id}:${e}`); return Promise.resolve({ ok: true }) },
    agregarTags: (id, t) => { log.tags.push(`${id}:${t.join(',')}`); return Promise.resolve({ ok: true }) },
  }
  return { repo, log }
}

const cfg: ConfigImport = {
  prefijos: { lucero: ['VT-'], pap: [] },
  plazos: { lucero: '1 a 3 días hábiles', pap: '2 a 5 días hábiles' },
  ahora: AHORA,
  normalizarTelefono: normalizarTelefonoPY,
}

Deno.test('Lucero en_camino → un aviso de despacho con las 5 variables', async () => {
  const { repo, log } = repoMemoria([pedido()])
  const r = await procesarFilas('lucero', [
    { referencia: 'VT-1001', estado_crudo: 'En camino', telefono: '0981000000', fecha: '06/10/2026 09:00' },
  ], repo, cfg)
  assertEquals(r.procesadas, 1)
  assertEquals(r.avisos_programados, 1)
  assertEquals(log.envios[0].plantilla, 'voltra_pedido_despachado')
  assertEquals(log.envios[0].variables, ['Ana', '1 Tiras nasales', 'Lucero del Este', '1 a 3 días hábiles', '129.000'])
  assertEquals(log.envios[0].categoria, 'utilidad')
  assertEquals(log.eventos, ['9001:DESPACHADO'])
  assertEquals(log.tags, ['9001:DESPACHADO'])
  assertEquals(log.notificados, ['9001:DESPACHADO'])
})

Deno.test('reimportar el mismo archivo no repite el aviso', async () => {
  const { repo, log } = repoMemoria([pedido()])
  const filas = [{ referencia: 'VT-1001', estado_crudo: 'en_camino', telefono: '0981000000' }]
  await procesarFilas('lucero', filas, repo, cfg)
  const r2 = await procesarFilas('lucero', filas, repo, cfg)
  assertEquals(r2.repetidas, 1)
  assertEquals(r2.avisos_programados, 0)
  assertEquals(log.envios.length, 1)
})

Deno.test('ENTREGADO → seguimiento mañana 10:00 Asunción; rendido suma RENDIDO sin mensaje', async () => {
  const { repo, log } = repoMemoria([pedido()])
  const r = await procesarFilas('lucero', [
    { referencia: 'VT-1001', estado_crudo: 'Entregado', telefono: '0981000000', extra: { rendido: true } },
  ], repo, cfg)
  assertEquals(r.avisos_programados, 1)
  assertEquals(log.envios[0].plantilla, 'voltra_seguimiento_entrega')
  assertEquals(log.envios[0].enviar_desde, '2026-10-07T13:00:00.000Z')
  assertEquals(log.envios[0].variables, ['Ana', '1 Tiras nasales'])
  // RENDIDO no cambia estado_envio ni genera evento.
  assertEquals(log.estadoEnvio, ['9001:ENTREGADO'])
  assertEquals(log.eventos, ['9001:ENTREGADO'])
})

Deno.test('fallido, devuelto, cancelado, preparación', async () => {
  const p = pedido()
  const { repo, log } = repoMemoria([p])
  await procesarFilas('lucero', [{ referencia: 'VT-1001', estado_crudo: 'Aceptado' }], repo, cfg)
  assertEquals(log.envios.length, 0)
  await procesarFilas('lucero', [{ referencia: 'VT-1001', estado_crudo: 'Fallido' }], repo, cfg)
  assertEquals(log.envios.at(-1)?.plantilla, 'voltra_no_entregado')
  await procesarFilas('lucero', [{ referencia: 'VT-1001', estado_crudo: 'Devuelto' }], repo, cfg)
  assertEquals(log.envios.length, 1) // NO_ENTREGADO: nada al cliente
  assertEquals(log.tags.at(-1), '9001:NO_ENTREGADO')
})

Deno.test('PaP: Devolucion en proceso → "¿lo reprogramamos?"; Asignado a ruta → despacho', async () => {
  const a = pedido({ shopify_order_id: 1, nombre: '#1500' })
  const b = pedido({ shopify_order_id: 2, nombre: '#1501', telefono: '+595981000001' })
  const { repo, log } = repoMemoria([a, b])
  const r = await procesarFilas('pap', [
    { referencia: '1500', estado_crudo: 'Devolucion en proceso', telefono: '0981000000' },
    { referencia: '1501', estado_crudo: 'Asignado a ruta', telefono: '0981000001' },
    { referencia: '1502', estado_crudo: 'Custodio', telefono: '0981000002' },
  ], repo, cfg)
  assertEquals(r.avisos_programados, 2)
  assertEquals(log.envios.map((e) => e.plantilla), ['voltra_no_entregado', 'voltra_pedido_despachado'])
  assertEquals(log.envios[1].variables[2], 'Punto a Punto')
  assertEquals(r.estado_no_reconocido, 1)
  assertEquals(r.estados_no_reconocidos, ['Custodio'])
})

Deno.test('CANCELADO_CLIENTE: no se programa nada y queda para avisar', async () => {
  const { repo, log } = repoMemoria([pedido({ tags: ['CANCELADO_CLIENTE'] })])
  const r = await procesarFilas('lucero', [{ referencia: 'VT-1001', estado_crudo: 'en_camino' }], repo, cfg)
  assertEquals(r.avisos_programados, 0)
  assertEquals(r.cancelados_cliente, 1)
  assertEquals(log.envios.length, 0)
  assertEquals(log.eventos.length, 0)
  assertEquals(log.revision[0].motivo, 'cancelado_cliente_con_movimiento')
})

Deno.test('sin pedido → courier_revision; prefijo de otra tienda se ignora', async () => {
  const { repo, log } = repoMemoria([pedido()])
  const r = await procesarFilas('lucero', [
    { referencia: 'VT-7777', estado_crudo: 'en_camino', telefono: '0981000009' },
    { referencia: 'FW-1001', estado_crudo: 'en_camino', telefono: '0981000000' },
  ], repo, cfg)
  assertEquals(r.sin_pedido, 1)
  assertEquals(r.otra_tienda, 1)
  assertEquals(log.revision, [{ referencia: 'VT-7777', motivo: 'sin_pedido' }])
})

Deno.test('búsqueda por teléfono y teléfono que no coincide', async () => {
  const { repo, log } = repoMemoria([pedido()])
  const r = await procesarFilas('lucero', [
    { referencia: '', estado_crudo: 'en_camino', telefono: '0981 000 000' },
  ], repo, cfg)
  assertEquals(r.procesadas, 1)
  const { repo: repo2, log: log2 } = repoMemoria([pedido()])
  const r2 = await procesarFilas('lucero', [
    { referencia: 'VT-1001', estado_crudo: 'en_camino', telefono: '0981000005' },
  ], repo2, cfg)
  assertEquals(r2.sin_pedido, 1)
  assertEquals(log2.revision[0].motivo, 'telefono_no_coincide')
  assert(log.envios.length === 1)
})

Deno.test('estado tardío no pisa un estado final ni avisa', async () => {
  const { repo, log } = repoMemoria([pedido({ estado_envio: 'ENTREGADO' as EstadoEnvio })])
  const r = await procesarFilas('lucero', [{ referencia: 'VT-1001', estado_crudo: 'en_camino' }], repo, cfg)
  assertEquals(r.avisos_programados, 0)
  assertEquals(log.estadoEnvio.length, 0)
})

Deno.test('pedido sin cliente_id → revisión, sin aviso', async () => {
  const { repo, log } = repoMemoria([pedido({ cliente_id: null })])
  const r = await procesarFilas('lucero', [{ referencia: 'VT-1001', estado_crudo: 'en_camino' }], repo, cfg)
  assertEquals(r.avisos_programados, 0)
  assertEquals(log.revision[0].motivo, 'pedido_sin_cliente')
})

Deno.test('saneo: multa basura, fechas en dos formatos, lote, notas N/A', () => {
  assertEquals(montoSano(2147483647), null)
  assertEquals(montoSano('15.000'), 15000)
  assertEquals(fechaISO('31/07/2026 (Lote 419)'), '2026-07-31')
  assertEquals(fechaISO('2026-07-31T10:00:00'), '2026-07-31')
  assertEquals(fechaISO('basura'), null)
  const f = sanearFila({
    referencia: ' VT-1 ', estado_crudo: 'x', fecha: '1/8/2026 09:15',
    extra: { multa: 2147483647, fecha_rendicion: '05/08/2026 (Lote 421)', motivo: 'N/A | No contesta' },
  })
  assertEquals(f.referencia, 'VT-1')
  assertEquals(f.fecha, '2026-08-01')
  assertEquals(f.extra, { multa: null, fecha_rendicion: '2026-08-05', motivo: 'No contesta', lote: '421' })
})

Deno.test('numeroDesdeReferencia', () => {
  assertEquals(numeroDesdeReferencia('FW-2071', ['FW-']), { numero: '2071', otraTienda: false })
  assertEquals(numeroDesdeReferencia('fw 2071', ['FW-']), { numero: '2071', otraTienda: false })
  assertEquals(numeroDesdeReferencia('#1001', []), { numero: '1001', otraTienda: false })
  assertEquals(numeroDesdeReferencia('FW-2071', ['VT-']), { numero: null, otraTienda: true })
  assertEquals(numeroDesdeReferencia('', ['VT-']), { numero: null, otraTienda: false })
  assertEquals(numeroDesdeReferencia('FW-WA-2001', ['FW-']), { numero: null, otraTienda: true })
  assertEquals(numeroDesdeReferencia('FW-WA-2001', ['FW-', 'FW-WA-']), { numero: '2001', otraTienda: false })
  assertEquals(numeroDesdeReferencia('XX-12', ['FW-']).otraTienda, true)
})

Deno.test('manianaALas10 cruza el fin de mes', () => {
  assertEquals(manianaALas10(new Date('2026-10-31T23:30:00Z')), '2026-11-01T13:00:00.000Z') // 20:30 local del 31
  assertEquals(manianaALas10(new Date('2026-11-01T02:00:00Z')), '2026-11-01T13:00:00.000Z') // 23:00 local del 31
})

Deno.test('numeroDesdeReferencia: VT- siempre es de esta tienda, aunque la config no lo liste', () => {
  assertEquals(numeroDesdeReferencia('VT-1004', []), { numero: '1004', otraTienda: false })
  assertEquals(numeroDesdeReferencia('vt 1004', ['FW-']), { numero: '1004', otraTienda: false })
  assertEquals(numeroDesdeReferencia('FW-2071', []), { numero: null, otraTienda: true })
})

Deno.test('falla después de insertar el estado → la próxima importación manda el aviso una sola vez', async () => {
  const { repo, log } = repoMemoria([pedido()])
  const original = repo.actualizarEstadoEnvio
  let fallar = true
  repo.actualizarEstadoEnvio = (id, e, c) => fallar ? Promise.reject(new Error('caída simulada')) : original(id, e, c)
  const filas = [{ referencia: 'VT-1001', estado_crudo: 'en_camino', telefono: '0981000000' }]
  const r1 = await procesarFilas('lucero', filas, repo, cfg)
  assertEquals(r1.errores.length, 1)
  assertEquals(log.envios.length, 0)
  fallar = false
  const r2 = await procesarFilas('lucero', filas, repo, cfg)
  assertEquals([r2.repetidas, r2.avisos_programados, log.envios.length], [0, 1, 1])
  const r3 = await procesarFilas('lucero', filas, repo, cfg)
  assertEquals([r3.repetidas, r3.avisos_programados, log.envios.length], [1, 0, 1])
})

Deno.test('aviso programado pero marcarNotificado falló → reintento no duplica y queda notificado', async () => {
  const { repo, log } = repoMemoria([pedido()])
  const original = repo.marcarNotificado
  let fallar = true
  repo.marcarNotificado = (id, e) => fallar ? Promise.reject(new Error('caída simulada')) : original(id, e)
  const filas = [{ referencia: 'VT-1001', estado_crudo: 'en_camino', telefono: '0981000000' }]
  await procesarFilas('lucero', filas, repo, cfg)
  fallar = false
  const r2 = await procesarFilas('lucero', filas, repo, cfg)
  assertEquals([r2.avisos_programados, log.envios.length], [0, 1])
  assertEquals(log.notificados, ['9001:DESPACHADO'])
})

Deno.test('fallido y después rescatable → un solo "no entregado" por pedido', async () => {
  const { repo, log } = repoMemoria([pedido()])
  await procesarFilas('lucero', [{ referencia: 'VT-1001', estado_crudo: 'Fallido' }], repo, cfg)
  const r = await procesarFilas('pap', [{ referencia: '1001', estado_crudo: 'Devolucion en proceso' }], repo, cfg)
  assertEquals(r.avisos_programados, 0)
  assertEquals(log.envios.filter((e) => e.plantilla === 'voltra_no_entregado').length, 1)
  assert(log.notificados.includes('9001:NO_ENTREGADO_RESCATABLE'))
})
