// Datos 100 % inventados (repo público). Repo en memoria: nada de red.
import { assert, assertEquals } from 'jsr:@std/assert@1'
import { normalizarTelefonoPY } from '../_shared/telefono.ts'
import type { OrigenAnuncio, ResultadoCapi } from '../_shared/meta_capi.ts'
import {
  type CambiosPedido, type ConfigPostEntrega, entregadoEnDesdeFecha, type FilaLote, fechaRealDesdeFilas,
  type PedidoPendiente, procesarPostEntrega, type Repo, TAG_CAPI,
} from './procesar.ts'

const AHORA = new Date('2026-10-06T15:00:00Z')

function pedido(over: Partial<PedidoPendiente> = {}): PedidoPendiente {
  return {
    shopify_order_id: 9001, nombre: '#1001', cliente_id: 'cli-1', telefono: '+595981000000', total: 129000,
    tags: [], creado_en: '2026-10-02T13:00:00Z', entregado_en: null, pagado_marcado: false, capi_enviado: false,
    capi_omitido: null, post_entrega_intentos: 0, entregado_registrado_en: '2026-10-06T12:00:00Z',
    entregado_fuente_estado: 'courier_lucero', rendido: true, ...over,
  }
}

const FILAS: FilaLote[] = [
  { referencia: 'VT-1001', estado_crudo: 'entregado', telefono: '0981000000', fecha: '05/10/2026' },
  { referencia: 'VT-1002', estado_crudo: 'en_camino', telefono: '0981000001', fecha: '05/10/2026' },
]

function cfg(over: Partial<ConfigPostEntrega> = {}): ConfigPostEntrega {
  return {
    ahora: AHORA, prefijos: { lucero: ['VT-', 'FW-'], pap: [] }, normalizarTelefono: normalizarTelefonoPY,
    limite: 50, maxIntentos: 48, avisoTras: 3, ventanaCtwaDias: 7, simuladoShopify: false, ...over,
  }
}

const capiOk = (simulado = false): ResultadoCapi => ({
  ok: true, simulado, principal: { ok: true }, mensajeria: { ok: true, omitido: 'sin_ctwa_clid' },
})

/** Repo en memoria que imita la vista post_entrega_pendientes. */
function repoMemoria(pedidos: PedidoPendiente[], o: {
  pagoFalla?: boolean; capi?: () => ResultadoCapi; origen?: OrigenAnuncio | null; filas?: FilaLote[]
} = {}) {
  const tabla = new Map(pedidos.map((p) => [p.shopify_order_id, { ...p }]))
  const log = { pagos: 0, capi: [] as { id: number; origen: OrigenAnuncio | null; entregado_en: string | null }[],
    tags: [] as string[], avisos: [] as string[], cambios: [] as CambiosPedido[] }
  const repo: Repo = {
    pendientes(limite, maxIntentos) {
      return Promise.resolve([...tabla.values()].filter((p) =>
        p.post_entrega_intentos < maxIntentos &&
        (!p.entregado_en || !p.pagado_marcado || (!p.capi_enviado && !p.capi_omitido))
      ).slice(0, limite).map((p) => ({ ...p })))
    },
    filasLote: () => Promise.resolve(o.filas ?? FILAS),
    origenAnuncio: () => Promise.resolve(o.origen ?? null),
    actualizar(id, c) {
      log.cambios.push(c)
      const p = tabla.get(id)!
      Object.assign(p, Object.fromEntries(Object.entries(c).filter(([k]) => k in p)))
      return Promise.resolve()
    },
    marcarPagado() {
      log.pagos++
      return Promise.resolve(o.pagoFalla ? { ok: false, error: 'Shopify caído' } : { ok: true })
    },
    enviarCapi(p, origen) {
      log.capi.push({ id: p.shopify_order_id, origen, entregado_en: p.entregado_en })
      return Promise.resolve(o.capi ? o.capi() : capiOk())
    },
    agregarTags(id, tags) {
      log.tags.push(...tags)
      const p = tabla.get(id)!
      p.tags = [...(p.tags ?? []), ...tags]
      return Promise.resolve({ ok: true })
    },
    avisar(t) { log.avisos.push(t); return Promise.resolve({ ok: true }) },
  }
  return { repo, tabla, log }
}

Deno.test('fecha real: fila del courier por número de pedido', () => {
  assertEquals(fechaRealDesdeFilas(FILAS, pedido(), 'lucero', ['VT-'], normalizarTelefonoPY), '2026-10-05')
})

Deno.test('fecha real: por teléfono si el número no coincide; nada si hay dos', () => {
  const p = pedido({ nombre: '#7777' })
  assertEquals(fechaRealDesdeFilas(FILAS, p, 'lucero', ['VT-'], normalizarTelefonoPY), '2026-10-05')
  const dobles = [...FILAS, { referencia: 'VT-1003', estado_crudo: 'entregado', telefono: '0981000000', fecha: '04/10/2026' }]
  assertEquals(fechaRealDesdeFilas(dobles, p, 'lucero', ['VT-'], normalizarTelefonoPY), null)
})

Deno.test('fecha real: estado no entregado no cuenta', () => {
  const p = pedido({ nombre: '#1002', telefono: '+595981000001' })
  assertEquals(fechaRealDesdeFilas(FILAS, p, 'lucero', ['VT-'], normalizarTelefonoPY), null)
})

Deno.test('entregado_en: mediodía de Asunción, nunca después de la importación', () => {
  assertEquals(entregadoEnDesdeFecha('2026-10-05', '2026-10-06T12:00:00Z'), '2026-10-05T15:00:00.000Z')
  assertEquals(entregadoEnDesdeFecha('2026-10-06', '2026-10-06T12:00:00Z'), '2026-10-06T12:00:00.000Z')
})

Deno.test('una corrida: fecha, pagado, CAPI y tag', async () => {
  const { repo, tabla, log } = repoMemoria([pedido()])
  const r = await procesarPostEntrega(repo, cfg())
  const p = tabla.get(9001)!
  assertEquals(p.entregado_en, '2026-10-05T15:00:00.000Z')
  assertEquals(p.pagado_marcado, true)
  assertEquals(p.capi_enviado, true)
  assertEquals(log.tags, [TAG_CAPI])
  assertEquals(log.capi[0].entregado_en, '2026-10-05T15:00:00.000Z')
  assertEquals(r.fechas_de_courier, 1)
  assertEquals(log.cambios[0].entregado_fuente, 'courier')
})

Deno.test('idempotencia: dos corridas no duplican pagos, eventos ni tags', async () => {
  const { repo, log } = repoMemoria([pedido(), pedido({ shopify_order_id: 9002, nombre: '#1002' })])
  const r1 = await procesarPostEntrega(repo, cfg())
  const r2 = await procesarPostEntrega(repo, cfg())
  assertEquals(log.pagos, 2)
  assertEquals(log.capi.length, 2)
  assertEquals(log.tags.length, 2)
  assertEquals(r1.revisados, 2)
  assertEquals(r2.revisados, 0)
})

Deno.test('sin fila del courier: usa la hora de importación', async () => {
  const { repo, tabla, log } = repoMemoria([pedido()], { filas: [] })
  await procesarPostEntrega(repo, cfg())
  assertEquals(tabla.get(9001)!.entregado_en, '2026-10-06T12:00:00Z')
  assertEquals(log.cambios[0].entregado_fuente, 'importacion')
})

Deno.test('ya tenía el tag META_ENTREGA_ENVIADA: no se reenvía', async () => {
  const { repo, tabla, log } = repoMemoria([pedido({ tags: [TAG_CAPI], pagado_marcado: true })])
  await procesarPostEntrega(repo, cfg())
  assertEquals(log.capi.length, 0)
  assertEquals(tabla.get(9001)!.capi_enviado, true)
})

Deno.test('entrega de más de 7 días: CAPI omitido, pago igual', async () => {
  const { repo, tabla, log } = repoMemoria([pedido({ entregado_en: '2026-09-20T15:00:00Z' })])
  const r = await procesarPostEntrega(repo, cfg())
  assertEquals(log.capi.length, 0)
  assertEquals(tabla.get(9001)!.capi_omitido, 'fuera_de_plazo_7_dias')
  assertEquals(tabla.get(9001)!.pagado_marcado, true)
  assertEquals(r.capi_omitidos, 1)
})

Deno.test('modo simulado de CAPI: no marca enviado ni pone tag (se mandará al cargar el token)', async () => {
  const { repo, tabla, log } = repoMemoria([pedido()], { capi: () => capiOk(true) })
  const r = await procesarPostEntrega(repo, cfg())
  assertEquals(tabla.get(9001)!.capi_enviado, false)
  assertEquals(log.tags.length, 0)
  assertEquals(r.capi_simulados, 1)
  assertEquals(r.errores, 0)
})

Deno.test('modo simulado de Shopify: no llama a marcarPagado', async () => {
  const { repo, log } = repoMemoria([pedido()])
  await procesarPostEntrega(repo, cfg({ simuladoShopify: true }))
  assertEquals(log.pagos, 0)
})

Deno.test('origen de anuncio: se pasa el ctwa_clid al envío', async () => {
  const { repo, log } = repoMemoria([pedido()], { origen: { ctwa_clid: 'CLID_PRUEBA' } })
  const r = await procesarPostEntrega(repo, cfg())
  assertEquals(log.capi[0].origen?.ctwa_clid, 'CLID_PRUEBA')
  assertEquals(r.con_anuncio, 1)
})

Deno.test('fallos: reintenta en cada corrida y avisa a Telegram UNA vez al 3er fallo', async () => {
  const { repo, tabla, log } = repoMemoria([pedido()], { pagoFalla: true })
  for (let i = 0; i < 5; i++) await procesarPostEntrega(repo, cfg())
  const p = tabla.get(9001)!
  assertEquals(log.pagos, 5)
  assertEquals(p.post_entrega_intentos, 5)
  assertEquals(p.pagado_marcado, false)
  assertEquals(p.capi_enviado, true) // el CAPI no depende del pago
  assertEquals(log.capi.length, 1)
  assertEquals(log.avisos.length, 1)
  assert(log.avisos[0].includes('#1001'))
})

Deno.test('fallos: deja de reintentar al llegar al máximo', async () => {
  const { repo, log } = repoMemoria([pedido({ post_entrega_intentos: 2 })], { pagoFalla: true })
  for (let i = 0; i < 4; i++) await procesarPostEntrega(repo, cfg({ maxIntentos: 4 }))
  assertEquals(log.pagos, 2)
})

Deno.test('CAPI con error: no marca enviado y cuenta el fallo', async () => {
  const { repo, tabla } = repoMemoria([pedido()], {
    capi: () => ({ ok: false, simulado: false, principal: { ok: false, error: 'Invalid' }, mensajeria: { ok: true } }),
  })
  const r = await procesarPostEntrega(repo, cfg())
  assertEquals(tabla.get(9001)!.capi_enviado, false)
  assertEquals(r.errores, 1)
  assert(r.detalle_errores[0].includes('Invalid'))
})

Deno.test('factura (ola 4): solo con la bandera activa; una falla no frena pagado ni CAPI', async () => {
  // Bandera apagada: no se llama.
  let llamadas: number[] = []
  let m = repoMemoria([pedido()])
  m.repo.facturar = (id) => (llamadas.push(id), Promise.resolve({ accion: 'emitida' }))
  await procesarPostEntrega(m.repo, cfg())
  assertEquals(llamadas, [])

  // Activa: se factura el pedido entregado.
  m = repoMemoria([pedido()])
  m.repo.facturar = (id) => (llamadas.push(id), Promise.resolve({ accion: 'emitida' }))
  let r = await procesarPostEntrega(m.repo, cfg({ facturaActiva: true }))
  assertEquals(llamadas, [pedido().shopify_order_id])
  assertEquals(r.errores, 0)

  // Activa y FacturaSend falla (o tira excepción): pagado y CAPI salen igual, sin contar como error del pedido.
  for (const falla of [() => Promise.resolve({ accion: 'error', error: 'FacturaSend 500' }), () => Promise.reject(new Error('red'))]) {
    llamadas = []
    m = repoMemoria([pedido()])
    m.repo.facturar = falla
    r = await procesarPostEntrega(m.repo, cfg({ facturaActiva: true }))
    assertEquals([r.pagados, r.capi_enviados, r.errores], [1, 1, 0])
    assert(r.detalle_errores.some((d) => d.includes('factura')))
  }
})

Deno.test('entregado pero NO rendido: no marca pagado (el courier todavía no pagó), el resto sigue', async () => {
  const { repo, tabla, log } = repoMemoria([pedido({ rendido: false })])
  const r = await procesarPostEntrega(repo, cfg())
  const p = tabla.get(9001)!
  assertEquals(log.pagos, 0)
  assertEquals(p.pagado_marcado, false)
  assertEquals(r.pagados, 0)
  assertEquals(p.capi_enviado, true) // la señal de venta a Meta sale al entregar, no al rendir
  assertEquals(r.errores, 0)
})

Deno.test('rendido después: en la corrida siguiente marca pagado una sola vez', async () => {
  const { repo, tabla, log } = repoMemoria([pedido({ rendido: false })])
  await procesarPostEntrega(repo, cfg())
  tabla.get(9001)!.rendido = true
  await procesarPostEntrega(repo, cfg())
  await procesarPostEntrega(repo, cfg())
  assertEquals(log.pagos, 1)
  assertEquals(tabla.get(9001)!.pagado_marcado, true)
})
