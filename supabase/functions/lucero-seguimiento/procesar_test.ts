// Datos 100 % inventados (repo público): HTML armado a mano con la MISMA estructura que envio.php de Lucero
// (verificada el 09-10-2026), referencias VT-9xxx y EnvioID ficticios.
import { assert, assertEquals } from 'jsr:@std/assert@1'
import { type FilaCourier, type PedidoImport, procesarFilas, type Repo, type Resumen } from '../importar-courier/procesar.ts'
import {
  cambiosEntrega, correrSeguimiento, type Deps, estadoCrudo, type GuiaAbierta, normalizarConfig, parsearPagina, refVoltra,
} from './procesar.ts'

const PASOS = ['Creado', 'Aceptado', 'En camino', 'Entregado', 'Devuelto', 'Fallido', 'Cancelado']
const BADGE: Record<string, string> = {
  Creado: 'cargado', Aceptado: 'aceptado', 'En camino': 'en_camino', Entregado: 'entregado',
  Devuelto: 'devuelto', Fallido: 'fallido', Cancelado: 'cancelado',
}

function paginaInventada(o: { id: string; ref: string; estado: string; fechas: Record<string, string> }): string {
  const actualLabel = Object.entries(BADGE).find(([, b]) => b === o.estado)?.[0]
  const filas = PASOS.map((l) => {
    const f = o.fechas[l]
    const cls = `${f ? 'done' : ''} ${l === actualLabel ? 'current' : ''}`
    return `<div class="tl-row ${cls}">
                <div class="dot"></div>
                <div class="tl-main">
                  <div class="tl-top">
                    <div class="tl-label">${l}</div>
                    <div class="tl-date">${f ?? '—'}</div>
                  </div>
                  <div class="tl-sub">
                    <span class="badge">${BADGE[l]}</span>
                    ${l === actualLabel ? '<span class="mut">· actual</span>' : ''}
                  </div>
                </div>
              </div>`
  }).join('\n')
  return `<!doctype html><html><head><title>x</title></head><body><div class="container"><div class="card">
      <div class="h1">Estado del envío — #${o.id}</div>
      <div class="kv">
          <div class="k">ID</div><div class="v">#${o.id}</div>
          <div class="k">Referencia</div><div class="v">${o.ref}</div>
          <div class="k">Empresa</div><div class="v">Empresa Inventada</div>
          <div class="k">Estado</div><div class="v"><span class="badge">${o.estado}</span></div>
          <div class="k">Creado</div><div class="v">2026-10-01 00:00</div>
        </div>
        <div class="stepper"><div class="step done current"><div class="s-label">Entregado</div><div class="s-date">1999-01-01 00:00</div></div></div>
        <!-- ===== Historial (lista) ===== -->
        <div class="timeline">
        ${filas}
        </div>
        <!-- ===== Ruta REAL según log ===== -->
      </div></div></body></html>`
}

const ENTREGADO = paginaInventada({
  id: '90001', ref: 'VT-9001', estado: 'entregado',
  fechas: { Creado: '2026-10-01 00:00', Aceptado: '2026-10-02 09:10', 'En camino': '2026-10-02 18:00', Entregado: '2026-10-03 13:05' },
})
const EN_CAMINO = paginaInventada({
  id: '90002', ref: 'VT-9002', estado: 'en_camino',
  fechas: { Creado: '2026-10-01 00:00', Aceptado: '2026-10-02 09:10', 'En camino': '2026-10-02 18:00' },
})
const NO_ENCONTRADO = '<html><body><h1>Estado del envío</h1><p>No se encontró el envío solicitado.</p><a>Buscar otro</a></body></html>'
const FORMATO_NUEVO = '<html><body><section class="tracking"><h2>Estado: Entregado</h2></section></body></html>'

Deno.test('parsearPagina: entregado con fecha y hora del estado actual (no del stepper)', () => {
  const p = parsearPagina(ENTREGADO)
  assert(p.tipo === 'ok')
  assertEquals(p.referencia, 'VT-9001')
  assertEquals(p.estado, 'entregado')
  assertEquals(p.estado_crudo, 'Entregado')
  assertEquals(p.fecha, '2026-10-03 13:05')
  assertEquals(p.historial.length, 7)
  assertEquals(p.historial.find((h) => h.estado === 'devuelto')?.fecha, null)
})

Deno.test('parsearPagina: en_camino → "En camino"', () => {
  const p = parsearPagina(EN_CAMINO)
  assert(p.tipo === 'ok')
  assertEquals(p.estado_crudo, 'En camino')
  assertEquals(p.fecha, '2026-10-02 18:00')
})

Deno.test('parsearPagina: no encontrado y formato cambiado no inventan estado', () => {
  assertEquals(parsearPagina(NO_ENCONTRADO).tipo, 'no_encontrado')
  const p = parsearPagina(FORMATO_NUEVO)
  assertEquals(p.tipo, 'sin_parsear')
  const raro = parsearPagina(ENTREGADO.replace('<span class="badge">entregado</span></div>\n          <div class="k">Creado', '<span class="badge">en_deposito</span></div>\n          <div class="k">Creado'))
  assert(raro.tipo === 'sin_parsear' && raro.motivo.startsWith('estado_desconocido'))
})

Deno.test('helpers: refVoltra, estadoCrudo, normalizarConfig', () => {
  assertEquals(refVoltra('vt 09001'), 'VT-9001')
  assertEquals(refVoltra('#VT9001'), 'VT-9001')
  assertEquals(refVoltra('FW-9001'), null)
  assertEquals(estadoCrudo('en_camino'), 'En camino')
  assertEquals(normalizarConfig({ tope: 500, pausa_ms: 100 }), { tope: 40, pausa_ms: 3000 })
  assertEquals(normalizarConfig(null), { tope: 30, pausa_ms: 3000 })
})

const guia = (over: Partial<GuiaAbierta> = {}): GuiaAbierta => ({
  nro_guia_pap: 'L-VT-9001', n_referencia: 'VT-9001', envio_id: '90001',
  categoria: 'en_proceso', estado_pap: 'Aceptado', vinculo_metodo: null, importe: 129000, ...over,
})

Deno.test('cambiosEntrega: precedencia (manual no se pisa, terminal no se degrada, sin cambios = null)', () => {
  const p = parsearPagina(ENTREGADO)
  assert(p.tipo === 'ok')
  assertEquals(cambiosEntrega(guia(), p), { estado_pap: 'Entregado', categoria: 'entregado', fecha_entrega: '2026-10-03', cobrado: 129000 })
  assertEquals(cambiosEntrega(guia({ vinculo_metodo: 'manual' }), p), null)
  assertEquals(cambiosEntrega(guia({ categoria: 'devuelto' }), p), null)
  const q = parsearPagina(EN_CAMINO)
  assert(q.tipo === 'ok')
  assertEquals(cambiosEntrega(guia({ estado_pap: 'En camino', categoria: 'en_proceso' }), q), null)
  assertEquals(cambiosEntrega(guia({ categoria: 'entregado' }), q), null)
})

// ─── Corrida completa con el pipeline REAL (procesarFilas) y un repo en memoria ───
function pedido(over: Partial<PedidoImport> = {}): PedidoImport {
  return {
    shopify_order_id: 5001, nombre: '#9001', cliente_id: 'cli-x', telefono: '+595981000000', total: 129000,
    estado_confirmacion: 'confirmado', estado_envio: null, tags: [], es_borrador: false,
    raw: { customer: { first_name: 'Ana Prueba' }, line_items: [{ title: 'Producto inventado', quantity: 1 }] }, ...over,
  }
}

function repoMemoria(pedidos: PedidoImport[]) {
  const estados: string[] = []
  const repo: Repo = {
    buscarPedidoPorNumero: (n) => Promise.resolve(pedidos.find((p) => p.nombre === `#${n}`) ?? null),
    buscarPedidosPorTelefono: () => Promise.resolve([]),
    insertarEstado: (id, e) => {
      const k = `${id}:${e}`
      if (estados.includes(k)) return Promise.resolve(false)
      estados.push(k)
      return Promise.resolve(true)
    },
    marcarNotificado: () => Promise.resolve(),
    actualizarEstadoEnvio: (id, e) => {
      const p = pedidos.find((x) => x.shopify_order_id === id)
      if (p) p.estado_envio = e
      return Promise.resolve()
    },
    programarEnvio: () => Promise.resolve(true),
    enviarARevision: () => Promise.resolve(),
    crearEventoEnvio: () => Promise.resolve({ ok: true }),
    agregarTags: () => Promise.resolve({ ok: true }),
  }
  return { repo, estados }
}

function depsPrueba(guias: GuiaAbierta[], paginas: Record<string, string | Error | number>, pedidos: PedidoImport[]) {
  const mem = repoMemoria(pedidos)
  const log = {
    consultas: [] as string[], esperas: [] as number[], lotes: [] as FilaCourier[][], avisos: [] as string[],
    actualizadas: [] as { guia: string; cambios: unknown }[], marcadas: [] as { guia: string; error: string | null }[],
  }
  const deps: Deps = {
    guiasAbiertas: (tope) => Promise.resolve(guias.slice(0, tope)),
    consultar: (id) => {
      log.consultas.push(id)
      const p = paginas[id]
      if (p instanceof Error) return Promise.reject(p)
      if (typeof p === 'number') return Promise.resolve({ status: p, html: '' })
      return Promise.resolve({ status: 200, html: p ?? NO_ENCONTRADO })
    },
    esperar: (ms) => (log.esperas.push(ms), Promise.resolve()),
    guardarLote: (f) => (log.lotes.push(f), Promise.resolve()),
    procesarFilas: (filas): Promise<Resumen> =>
      procesarFilas('lucero', filas, mem.repo, {
        prefijos: { lucero: ['FW-'], pap: [] }, plazos: { lucero: '24 a 48 h', pap: '' },
        ahora: new Date('2026-10-09T15:00:00Z'), normalizarTelefono: (x) => x,
      }),
    actualizarEntrega: (g, c) => (log.actualizadas.push({ guia: g, cambios: c }), Promise.resolve(true)),
    marcarConsultada: (g, e) => (log.marcadas.push({ guia: g, error: e }), Promise.resolve()),
    avisar: (t) => (log.avisos.push(t), Promise.resolve()),
  }
  return { deps, log, estados: mem.estados }
}

Deno.test('correrSeguimiento: entregado y en camino llegan a pedido_estados y a entregas, con pausa ≥ 3 s', async () => {
  const pedidos = [pedido(), pedido({ shopify_order_id: 5002, nombre: '#9002' })]
  const { deps, log, estados } = depsPrueba(
    [guia(), guia({ nro_guia_pap: 'L-VT-9002', n_referencia: 'VT-9002', envio_id: '90002', estado_pap: 'Aceptado' })],
    { '90001': ENTREGADO, '90002': EN_CAMINO },
    pedidos,
  )
  const r = await correrSeguimiento(deps, { tope: 40, pausa_ms: 3000 })
  assertEquals(r.ok, 2)
  assertEquals(log.esperas, [3000])
  assertEquals(estados.sort(), ['5001:ENTREGADO', '5002:DESPACHADO'])
  assertEquals(pedidos[0].estado_envio, 'ENTREGADO')
  assertEquals(r.pipeline?.procesadas, 2)
  assertEquals(log.lotes[0][0], {
    referencia: 'VT-9001', estado_crudo: 'Entregado', telefono: '', fecha: '2026-10-03 13:05',
    extra: { envio_id: '90001', rendido: false, fuente_web: 'envio.php' },
  })
  assertEquals(r.entregas_actualizadas, 2)
  assertEquals(log.marcadas.map((m) => m.error), [null, null])
  assertEquals(log.avisos.length, 0)
})

Deno.test('correrSeguimiento: manual alimenta el pipeline pero no toca entregas; referencia distinta no procesa', async () => {
  const pedidos = [pedido()]
  const { deps, log, estados } = depsPrueba(
    [guia({ vinculo_metodo: 'manual' }), guia({ nro_guia_pap: 'L-VT-9003', n_referencia: 'VT-9003', envio_id: '90001' })],
    { '90001': ENTREGADO },
    pedidos,
  )
  const r = await correrSeguimiento(deps)
  assertEquals(r.entregas_protegidas, 1)
  assertEquals(r.referencia_distinta, 1)
  assertEquals(log.actualizadas.length, 0)
  assertEquals(estados, ['5001:ENTREGADO'])
  assertEquals(log.marcadas[1].error, 'referencia_distinta')
})

Deno.test('correrSeguimiento: más de la mitad falla → un solo aviso; tope respetado', async () => {
  const gs = ['1', '2', '3', '4', '5'].map((n) => guia({ nro_guia_pap: `L-VT-900${n}`, n_referencia: `VT-900${n}`, envio_id: `9000${n}` }))
  const { deps, log } = depsPrueba(gs, {
    '90001': ENTREGADO, '90002': FORMATO_NUEVO, '90003': new Error('timeout'), '90004': 302,
  }, [pedido()])
  const r = await correrSeguimiento(deps, { tope: 4 })
  assertEquals(log.consultas, ['90001', '90002', '90003', '90004'])
  assertEquals(r.sin_parsear, 1)
  assertEquals(r.error_red, 2)
  assertEquals(log.avisos.length, 1)
  assert(log.avisos[0].includes('3 de 4'))
  assert(r.aviso_enviado)
})

Deno.test('correrSeguimiento: sin guías no consulta ni avisa', async () => {
  const { deps, log } = depsPrueba([], {}, [])
  const r = await correrSeguimiento(deps)
  assertEquals(r.consultadas, 0)
  assertEquals(log.lotes.length + log.avisos.length, 0)
})

Deno.test('correrSeguimiento: guarda de a tandas; si se corta, lo ya consultado queda guardado y lo cortado sin marcar', async () => {
  const ns = ['1', '2', '3', '4', '5', '6', '7']
  const gs = ns.map((n) => guia({ nro_guia_pap: `L-VT-900${n}`, n_referencia: `VT-900${n}`, envio_id: `9000${n}` }))
  const paginas = Object.fromEntries(ns.map((n) => [`9000${n}`, EN_CAMINO.replaceAll('VT-9002', `VT-900${n}`)]))
  const pedidos = ns.map((n) => pedido({ shopify_order_id: 5000 + Number(n), nombre: `#900${n}` }))

  // Corrida completa: 2 tandas (5 + 2), resumen del pipeline sumado.
  const a = depsPrueba(gs, paginas, pedidos)
  const r = await correrSeguimiento(a.deps)
  assertEquals(a.log.lotes.map((l) => l.length), [5, 2])
  assertEquals(r.pipeline?.procesadas, 7)
  assertEquals(r.entregas_actualizadas, 7)
  assertEquals(a.log.marcadas.length, 7)

  // Corrida cortada antes de la guía 7 (simula el límite de tiempo de la Edge Function).
  const b = depsPrueba(gs, paginas, pedidos.map((p) => ({ ...p, estado_envio: null })))
  let esperas = 0
  b.deps.esperar = () => (++esperas === 6 ? Promise.reject(new Error('corte')) : Promise.resolve())
  let cortada = false
  await correrSeguimiento(b.deps).catch(() => (cortada = true))
  assert(cortada)
  assertEquals(b.log.lotes.map((l) => l.length), [5])
  assertEquals(b.estados.length, 5)
  assertEquals(b.log.marcadas.map((m) => m.guia), gs.slice(0, 5).map((g) => g.nro_guia_pap))
})
