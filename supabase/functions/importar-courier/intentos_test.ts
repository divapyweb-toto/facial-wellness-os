// 13-10: un aviso por intento fallido (no uno por pedido). Datos 100 % inventados (repo público).
import { assert, assertEquals } from 'jsr:@std/assert@1'
import { normalizarTelefonoPY } from '../_shared/telefono.ts'
import {
  type ConfigImport, type EnvioNuevo, esIntentoNuevo, fechaIntentoAvisado, type IntentoAvisado, type PedidoImport,
  procesarFilas, type Repo,
} from './procesar.ts'

function pedido(over: Partial<PedidoImport> = {}): PedidoImport {
  return {
    shopify_order_id: 9001, nombre: '#1001', cliente_id: 'cli-1', telefono: '+595981000000', total: 129000,
    estado_confirmacion: 'confirmado', estado_envio: null, tags: [], es_borrador: false,
    raw: { customer: { first_name: 'Ana Prueba' }, line_items: [{ title: 'Tiras nasales', quantity: 1 }] },
    cliente_nombre: null, ...over,
  }
}

/** Repo en memoria con envios_programados (clave + creado_en) para intentosAvisados. `reloj` = "ahora" del alta. */
function repoMemoria(pedidos: PedidoImport[], reloj: { ahora: Date }, conHistorial = true) {
  const estados = new Set<string>()
  const notificados = new Set<string>()
  const envios: (EnvioNuevo & { creado_en: string })[] = []
  const eventos: string[] = []
  const revision: string[] = []
  const repo: Repo = {
    buscarPedidoPorNumero: (n) => Promise.resolve(pedidos.find((p) => p.nombre === `#${n}`) ?? null),
    buscarPedidosPorTelefono: (t) => Promise.resolve(pedidos.filter((p) => p.telefono === t)),
    insertarEstado: (id, e) => {
      const k = `${id}:${e}`
      if (estados.has(k)) return Promise.resolve(false)
      estados.add(k)
      return Promise.resolve(true)
    },
    avisoPendiente: (id, e) => Promise.resolve(estados.has(`${id}:${e}`) && !notificados.has(`${id}:${e}`)),
    marcarNotificado: (id, e) => (notificados.add(`${id}:${e}`), Promise.resolve()),
    actualizarEstadoEnvio: (id, e) => {
      const p = pedidos.find((x) => x.shopify_order_id === id)
      if (p) p.estado_envio = e
      return Promise.resolve()
    },
    programarEnvio: (env) => {
      if (envios.some((x) => x.clave_unica === env.clave_unica)) return Promise.resolve(false)
      envios.push({ ...env, creado_en: reloj.ahora.toISOString() })
      return Promise.resolve(true)
    },
    enviarARevision: (_c, _r, _f, motivo) => (revision.push(motivo), Promise.resolve()),
    crearEventoEnvio: (id, e) => (eventos.push(`${id}:${e}`), Promise.resolve({ ok: true })),
    agregarTags: () => Promise.resolve({ ok: true }),
  }
  if (conHistorial) {
    repo.intentosAvisados = (id) =>
      Promise.resolve(envios.filter((e) => e.clave_unica.startsWith(`courier:${id}:INTENTO_FALLIDO`))
        .map((e) => ({ clave_unica: e.clave_unica, creado_en: e.creado_en })))
  }
  return { repo, envios, eventos, revision, notificados }
}

const cfg = (ahora: Date): ConfigImport => ({
  prefijos: { lucero: ['VT-'], pap: [] },
  plazos: { lucero: '1 a 3 días hábiles', pap: '2 a 5 días hábiles' },
  ahora,
  normalizarTelefono: normalizarTelefonoPY,
})

const reintentos = (envios: EnvioNuevo[]) => envios.filter((e) => e.plantilla === 'voltra_reintento_entrega_v2')

Deno.test('13-10: segundo intento fallido (otro día) → su propio aviso; reimportar cualquiera de los dos no duplica', async () => {
  const reloj = { ahora: new Date('2026-10-12T18:00:00Z') } // 15:00 Asunción del 12
  const { repo, envios, eventos } = repoMemoria([pedido()], reloj)
  const fallo1 = { referencia: 'VT-1001', estado_crudo: 'Fallido', fecha: '2026-10-12 14:30' }
  const r1 = await procesarFilas('lucero', [fallo1], repo, cfg(reloj.ahora))
  assertEquals(r1.avisos_programados, 1)
  assertEquals(envios[0].clave_unica, 'courier:9001:INTENTO_FALLIDO:2026-10-12')

  // El courier vuelve a salir (en camino, repetido) y falla de nuevo al día siguiente.
  reloj.ahora = new Date('2026-10-13T18:00:00Z')
  await procesarFilas('lucero', [{ referencia: 'VT-1001', estado_crudo: 'En camino', fecha: '2026-10-13 08:00' }], repo, cfg(reloj.ahora))
  const fallo2 = { referencia: 'VT-1001', estado_crudo: 'Fallido', fecha: '2026-10-13 13:00' }
  const r2 = await procesarFilas('lucero', [fallo2], repo, cfg(reloj.ahora))
  assertEquals(r2.avisos_programados, 1)
  assertEquals(reintentos(envios).map((e) => e.clave_unica), [
    'courier:9001:INTENTO_FALLIDO:2026-10-12',
    'courier:9001:INTENTO_FALLIDO:2026-10-13',
  ])
  // Cada intento deja su evento en Shopify.
  assertEquals(eventos.filter((e) => e === '9001:INTENTO_FALLIDO').length, 2)

  // Reimportar el archivo viejo y el nuevo: nada nuevo.
  reloj.ahora = new Date('2026-10-14T12:00:00Z')
  const r3 = await procesarFilas('lucero', [fallo1, fallo2], repo, cfg(reloj.ahora))
  assertEquals([r3.avisos_programados, r3.repetidas], [0, 2])
  assertEquals(reintentos(envios).length, 2)
})

Deno.test('13-10: tercer intento → tercer aviso (todas las claves con el prefijo courier:<id>:INTENTO_FALLIDO)', async () => {
  const reloj = { ahora: new Date('2026-10-10T15:00:00Z') }
  const { repo, envios } = repoMemoria([pedido()], reloj)
  for (const dia of ['2026-10-10', '2026-10-12', '2026-10-14']) {
    reloj.ahora = new Date(`${dia}T20:00:00Z`)
    await procesarFilas('pap', [{ referencia: '1001', estado_crudo: 'Devolucion en proceso', fecha: dia }], repo, cfg(reloj.ahora))
  }
  assertEquals(reintentos(envios).length, 3)
  assert(reintentos(envios).every((e) => e.clave_unica.startsWith('courier:9001:INTENTO_FALLIDO')))
})

Deno.test('13-10: mismo intento con otra fecha de reserva (ingreso) y después la fecha real → no duplica', async () => {
  // Primer import: el archivo no traía la fecha del intento y se usó la de ingreso (3 días antes).
  const reloj = { ahora: new Date('2026-10-12T18:00:00Z') }
  const { repo, envios } = repoMemoria([pedido()], reloj)
  await procesarFilas('pap', [{ referencia: '1001', estado_crudo: 'Devolucion en proceso', fecha: '2026-10-09' }], repo, cfg(reloj.ahora))
  // Más tarde el mismo evento llega con la fecha real (12-10): no es un intento nuevo.
  reloj.ahora = new Date('2026-10-12T22:00:00Z')
  const r = await procesarFilas('pap', [{ referencia: '1001', estado_crudo: 'Devolucion en proceso', fecha: '2026-10-12' }], repo, cfg(reloj.ahora))
  assertEquals([r.avisos_programados, r.repetidas], [0, 1])
  assertEquals(reintentos(envios).length, 1)
})

Deno.test('13-10: fallido y rescatable del mismo día → un solo aviso; sin fecha no se distingue y no se repite', async () => {
  const reloj = { ahora: new Date('2026-10-12T18:00:00Z') }
  const { repo, envios, notificados } = repoMemoria([pedido()], reloj)
  await procesarFilas('lucero', [{ referencia: 'VT-1001', estado_crudo: 'Fallido', fecha: '2026-10-12' }], repo, cfg(reloj.ahora))
  await procesarFilas('pap', [{ referencia: '1001', estado_crudo: 'Devolucion en proceso', fecha: '2026-10-12' }], repo, cfg(reloj.ahora))
  reloj.ahora = new Date('2026-10-15T18:00:00Z')
  const r = await procesarFilas('lucero', [{ referencia: 'VT-1001', estado_crudo: 'Fallido' }], repo, cfg(reloj.ahora))
  assertEquals(r.repetidas, 1)
  assertEquals(reintentos(envios).length, 1)
  assert(notificados.has('9001:NO_ENTREGADO_RESCATABLE'))
})

Deno.test('13-10: segundo intento a un pedido entregado, cancelado o de retiro → nada', async () => {
  for (const over of [{ tags: ['RETIRO_EN_CASA'] }, { estado_confirmacion: 'cancelado_sin_respuesta' }, { tags: ['CANCELADO_CLIENTE'] }]) {
    const reloj = { ahora: new Date('2026-10-12T18:00:00Z') }
    const { repo, envios, revision } = repoMemoria([pedido(over)], reloj)
    await procesarFilas('lucero', [{ referencia: 'VT-1001', estado_crudo: 'Fallido', fecha: '2026-10-12' }], repo, cfg(reloj.ahora))
    assertEquals(envios.length, 0, JSON.stringify(over))
    // Retiro / cancelado sin respuesta ya no van a revisión como 'pedido_sin_cliente'.
    assert(!revision.includes('pedido_sin_cliente'))
  }
  // Entregado: el fallido que llega tarde no avisa.
  const reloj = { ahora: new Date('2026-10-12T18:00:00Z') }
  const { repo, envios } = repoMemoria([pedido()], reloj)
  await procesarFilas('lucero', [{ referencia: 'VT-1001', estado_crudo: 'Fallido', fecha: '2026-10-11' }], repo, cfg(reloj.ahora))
  await procesarFilas('lucero', [{ referencia: 'VT-1001', estado_crudo: 'Entregado', fecha: '2026-10-12' }], repo, cfg(reloj.ahora))
  reloj.ahora = new Date('2026-10-14T18:00:00Z')
  await procesarFilas('lucero', [{ referencia: 'VT-1001', estado_crudo: 'Fallido', fecha: '2026-10-14' }], repo, cfg(reloj.ahora))
  assertEquals(reintentos(envios).length, 1)
})

Deno.test('13-10: Repo sin intentosAvisados → comportamiento anterior (clave sin fecha, un aviso por pedido)', async () => {
  const reloj = { ahora: new Date('2026-10-12T18:00:00Z') }
  const { repo, envios } = repoMemoria([pedido()], reloj, false)
  await procesarFilas('lucero', [{ referencia: 'VT-1001', estado_crudo: 'Fallido', fecha: '2026-10-12' }], repo, cfg(reloj.ahora))
  await procesarFilas('lucero', [{ referencia: 'VT-1001', estado_crudo: 'Fallido', fecha: '2026-10-14' }], repo, cfg(reloj.ahora))
  assertEquals(envios.map((e) => e.clave_unica), ['courier:9001:INTENTO_FALLIDO'])
})

Deno.test('13-10: fechaIntentoAvisado y esIntentoNuevo', () => {
  const a = (clave_unica: string, creado_en: string): IntentoAvisado => ({ clave_unica, creado_en })
  // Clave vieja (sin fecha): vale el día del registro en Asunción (00:30 UTC del 13 = 21:30 del 12).
  assertEquals(fechaIntentoAvisado(a('courier:1:INTENTO_FALLIDO', '2026-10-13T00:30:00Z')), '2026-10-12')
  // Fecha del evento el mismo día o el anterior al registro: manda el evento.
  assertEquals(fechaIntentoAvisado(a('courier:1:INTENTO_FALLIDO:2026-10-11', '2026-10-12T12:00:00Z')), '2026-10-11')
  // Fecha del evento muy anterior (reserva) o futura: manda el registro.
  assertEquals(fechaIntentoAvisado(a('courier:1:INTENTO_FALLIDO:2026-10-01', '2026-10-12T12:00:00Z')), '2026-10-12')
  assertEquals(fechaIntentoAvisado(a('courier:1:INTENTO_FALLIDO:2026-10-20', '2026-10-12T12:00:00Z')), '2026-10-12')
  const previos = [a('courier:1:INTENTO_FALLIDO:2026-10-11', '2026-10-12T12:00:00Z')]
  assertEquals(esIntentoNuevo('2026-10-12', previos), true) // el reintento del día siguiente, registrado al otro día
  assertEquals(esIntentoNuevo('2026-10-11', previos), false)
  assertEquals(esIntentoNuevo(null, previos), false)
  assertEquals(esIntentoNuevo(null, []), true)
})
