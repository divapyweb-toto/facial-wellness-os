// Tests de sync-gastos con respuestas INVENTADAS (sin red, sin secretos reales).
import { assert, assertEquals, assertRejects } from '@std/assert'
import {
  centavosADolares,
  type Deps,
  diaPY,
  ejecutarSync,
  type EstadoProveedor,
  type FilaGasto,
  filasClaude,
  filasElevenLabs,
  filasWhatsApp,
  type Proveedor,
  SinConfigurar,
  traerClaude,
  traerElevenLabs,
  traerWhatsApp,
} from './logica.ts'

const AHORA = new Date('2026-10-09T09:30:00Z') // 06:30 en Asunción

function json(body: unknown, status = 200): Response {
  return new Response(JSON.stringify(body), { status, headers: { 'content-type': 'application/json' } })
}

function depsFalsas(over: Partial<Deps> = {}, env: Record<string, string> = {}) {
  const guardadas: FilaGasto[] = []
  const estados: EstadoProveedor[] = []
  const avisos: string[] = []
  const urls: string[] = []
  const deps: Deps = {
    ahora: () => AHORA,
    env: (n) => env[n],
    http: (url) => {
      urls.push(url)
      return Promise.resolve(json({}))
    },
    guardar: (f) => {
      guardadas.push(...f)
      return Promise.resolve()
    },
    leerEstados: () => Promise.resolve([...estados]),
    guardarEstado: (e) => {
      const i = estados.findIndex((x) => x.proveedor === e.proveedor)
      if (i >= 0) estados[i] = e
      else estados.push(e)
      return Promise.resolve()
    },
    avisar: (t) => {
      avisos.push(t)
      return Promise.resolve()
    },
    ...over,
  }
  return { deps, guardadas, estados, avisos, urls }
}

// ─── Claude ──────────────────────────────────────────────────

Deno.test('centavos → dólares', () => {
  assertEquals(centavosADolares('123.45'), 1.2345)
  assertEquals(centavosADolares('0'), 0)
  assertEquals(centavosADolares('250'), 2.5)
})

Deno.test('claude: agrupa por día UTC del bucket y modelo, suma tipos de token', () => {
  const filas = filasClaude([{
    data: [{
      starting_at: '2026-10-07T00:00:00Z',
      ending_at: '2026-10-08T00:00:00Z',
      results: [
        { amount: '100', currency: 'USD', model: 'claude-sonnet-5', cost_type: 'tokens', token_type: 'uncached_input_tokens', service_tier: 'standard', description: 'x' },
        { amount: '250.5', currency: 'USD', model: 'claude-sonnet-5', cost_type: 'tokens', token_type: 'output_tokens', service_tier: 'standard', description: 'y' },
        { amount: '10', currency: 'USD', model: null, cost_type: 'web_search', description: 'Web Search Usage' },
      ],
    }, { starting_at: '2026-10-08T00:00:00Z', ending_at: '2026-10-09T00:00:00Z', results: [] }],
    has_more: false,
    next_page: null,
  }])
  assertEquals(filas.length, 2)
  const sonnet = filas.find((f) => f.concepto === 'claude-sonnet-5')!
  assertEquals(sonnet.fecha, '2026-10-07')
  assertEquals(sonnet.monto_usd, 3.505)
  assertEquals((sonnet.detalle.por_tipo as Record<string, number>)['tokens:output_tokens:standard'], 2.505)
  assertEquals(filas.find((f) => f.concepto === 'Web Search Usage')!.monto_usd, 0.1)
})

Deno.test('claude: sigue la paginación (has_more/next_page) y manda los headers', async () => {
  const pedidos: { url: string; headers: Record<string, string> }[] = []
  const paginas = [
    { data: [{ starting_at: '2026-10-02T00:00:00Z', ending_at: '2026-10-03T00:00:00Z', results: [{ amount: '50', currency: 'USD', model: 'm1' }] }], has_more: true, next_page: 'page_ABC' },
    { data: [{ starting_at: '2026-10-03T00:00:00Z', ending_at: '2026-10-04T00:00:00Z', results: [{ amount: '70', currency: 'USD', model: 'm1' }] }], has_more: false, next_page: null },
  ]
  const { deps } = depsFalsas({
    http: (url, init) => {
      pedidos.push({ url, headers: init?.headers as Record<string, string> })
      return Promise.resolve(json(paginas[pedidos.length - 1]))
    },
  }, { ANTHROPIC_ADMIN_KEY: 'sk-ant-admin01-FALSA' })
  const filas = await traerClaude(deps)
  assertEquals(pedidos.length, 2)
  const u1 = new URL(pedidos[0].url)
  assertEquals(u1.searchParams.get('starting_at'), '2026-10-02T00:00:00.000Z')
  assertEquals(u1.searchParams.get('ending_at'), '2026-10-09T00:00:00.000Z') // solo días UTC completos
  assertEquals(u1.searchParams.getAll('group_by[]'), ['description'])
  assertEquals(u1.searchParams.get('page'), null)
  assertEquals(new URL(pedidos[1].url).searchParams.get('page'), 'page_ABC')
  assertEquals(pedidos[0].headers['x-api-key'], 'sk-ant-admin01-FALSA')
  assertEquals(pedidos[0].headers['anthropic-version'], '2023-06-01')
  assertEquals(filas.map((f) => [f.fecha, f.monto_usd]), [['2026-10-02', 0.5], ['2026-10-03', 0.7]])
})

Deno.test('claude: sin ANTHROPIC_ADMIN_KEY → SinConfigurar; 401 → error con mensaje y sin la clave', async () => {
  await assertRejects(() => traerClaude(depsFalsas().deps), SinConfigurar)
  const { deps } = depsFalsas({
    http: () => Promise.resolve(json({ type: 'error', error: { type: 'authentication_error', message: 'The Admin API requires an Admin API key' } }, 401)),
  }, { ANTHROPIC_ADMIN_KEY: 'sk-ant-api03-SECRETA' })
  const e = await assertRejects(() => traerClaude(deps))
  assert((e as Error).message.includes('HTTP 401'))
  assert(!(e as Error).message.includes('SECRETA'))
})

// ─── WhatsApp ────────────────────────────────────────────────

// Cortes a las 00:00 de Paraguay = 03:00 UTC (forma real vista el 09-10-2026, valores inventados).
const D7 = Date.parse('2026-10-07T03:00:00Z') / 1000
const D8 = D7 + 86400

Deno.test('whatsapp: día de Paraguay, suma por categoría y guarda tipos y volumen', () => {
  const filas = filasWhatsApp([
    { start: D7, end: D8, pricing_type: 'REGULAR', pricing_category: 'MARKETING', volume: 10, cost: 0.74 },
    { start: D7, end: D8, pricing_type: 'REGULAR', pricing_category: 'UTILITY', volume: 2, cost: 0.0226 },
    { start: D7, end: D8, pricing_type: 'FREE_ENTRY_POINT', pricing_category: 'SERVICE', volume: 30, cost: 0 },
    { start: D7, end: D8, pricing_type: 'FREE_CUSTOMER_SERVICE', pricing_category: 'SERVICE', volume: 5, cost: 0 },
    { start: D8, end: D8 + 86400, pricing_type: 'REGULAR', pricing_category: 'MARKETING', volume: 1, cost: 0.074 },
  ], 'USD')
  assertEquals(filas.length, 4)
  const mk7 = filas.find((f) => f.fecha === '2026-10-07' && f.concepto === 'marketing')!
  assertEquals(mk7.monto_usd, 0.74)
  const sv = filas.find((f) => f.concepto === 'service')!
  assertEquals(sv.monto_usd, 0)
  assertEquals(sv.detalle.volumen, 35)
  assertEquals(Object.keys(sv.detalle.por_tipo as object).sort(), ['free_customer_service', 'free_entry_point'])
  assert(filas.some((f) => f.fecha === '2026-10-08' && f.concepto === 'marketing'))
})

Deno.test('whatsapp: moneda distinta de USD → monto_usd null y monto en detalle', () => {
  const [f] = filasWhatsApp([{ start: D7, end: D8, pricing_category: 'MARKETING', pricing_type: 'REGULAR', volume: 1, cost: 500 }], 'PYG')
  assertEquals(f.monto_usd, null)
  assertEquals(f.detalle.moneda, 'PYG')
  assertEquals(f.detalle.monto_moneda_cuenta, 500)
})

Deno.test('whatsapp: arma el pedido GET y sigue paging.next', async () => {
  const urls: string[] = []
  const { deps } = depsFalsas({
    http: (url) => {
      urls.push(url)
      if (urls.length === 1) {
        return Promise.resolve(json({
          currency: 'USD',
          pricing_analytics: {
            data: [{ data_points: [{ start: D7, end: D8, pricing_type: 'REGULAR', pricing_category: 'MARKETING', volume: 1, cost: 0.074 }] }],
            paging: { next: 'https://graph.facebook.com/next-falso' },
          },
        }))
      }
      return Promise.resolve(json({ data: [{ data_points: [{ start: D8, end: D8 + 86400, pricing_type: 'REGULAR', pricing_category: 'UTILITY', volume: 1, cost: 0.0113 }] }] }))
    },
  }, { WA_TOKEN: 'tok', WA_WABA_ID: '123' })
  const filas = await traerWhatsApp(deps)
  assertEquals(urls.length, 2)
  const campo = decodeURIComponent(urls[0].split('fields=')[1])
  const inicio = Date.parse('2026-10-02T03:00:00Z') / 1000 // 00:00 PY de hace 7 días
  assert(campo.includes(`pricing_analytics.start(${inicio}).end(${AHORA.getTime() / 1000})`), campo)
  assert(campo.includes('granularity(DAILY)') && campo.includes('PRICING_CATEGORY'))
  assertEquals(filas.length, 2)
})

// ─── ElevenLabs ──────────────────────────────────────────────

Deno.test('elevenlabs: créditos por día UTC y producto, sin inventar dólares', async () => {
  const t0 = Date.parse('2026-10-07T00:00:00Z')
  const resp = { time: [t0, t0 + 86400000], usage: { STT: [73, 0], TTS: [486, 1199] } }
  const filas = filasElevenLabs(resp)
  assertEquals(filas.length, 3) // el 0 no se guarda
  assert(filas.every((f) => f.monto_usd === null))
  assertEquals(filas.find((f) => f.concepto === 'stt')!.detalle.creditos, 73)
  assertEquals(filas.find((f) => f.concepto === 'tts' && f.fecha === '2026-10-08')!.detalle.creditos, 1199)

  let url = ''
  const { deps } = depsFalsas({ http: (u) => (url = u, Promise.resolve(json(resp))) }, { ELEVENLABS_API_KEY: 'k' })
  await traerElevenLabs(deps)
  const q = new URL(url).searchParams
  assertEquals(q.get('breakdown_type'), 'product_type')
  assertEquals(q.get('start_unix'), String(Date.parse('2026-10-02T00:00:00Z')))
})

// ─── Orquestación ────────────────────────────────────────────

const filaX = (p: Proveedor, monto: number | null = 1): FilaGasto => ({ fecha: '2026-10-08', proveedor: p, concepto: 'x', monto_usd: monto, detalle: {}, fuente: 'api' })

Deno.test('un proveedor caído no frena al resto', async () => {
  const f = depsFalsas()
  const r = await ejecutarSync(f.deps, {
    claude: () => Promise.reject(new Error('claude: HTTP 500')),
    whatsapp: () => Promise.resolve([filaX('whatsapp', 7.25)]),
    elevenlabs: () => Promise.resolve([filaX('elevenlabs', null)]),
  })
  assertEquals(r.ok, false)
  assertEquals(r.resultados.map((x) => x.estado), ['error', 'ok', 'ok'])
  assertEquals(f.guardadas.map((g) => g.proveedor), ['whatsapp', 'elevenlabs'])
  assertEquals(f.avisos.length, 0) // primer día de falla: sin aviso
  assertEquals(f.estados.find((e) => e.proveedor === 'claude')!.dias_fallando, 1)
})

Deno.test('aviso por Telegram solo al 2º día seguido de falla, una vez por racha; se resetea al andar', async () => {
  const f = depsFalsas()
  const cae = { claude: () => Promise.reject(new Error('boom')), whatsapp: () => Promise.resolve([]), elevenlabs: () => Promise.resolve([]) }
  let ahora = new Date('2026-10-08T09:30:00Z')
  f.deps.ahora = () => ahora
  await ejecutarSync(f.deps, cae)
  await ejecutarSync(f.deps, cae) // mismo día (re-ejecución manual): no suma
  assertEquals(f.avisos.length, 0)
  ahora = new Date('2026-10-09T09:30:00Z')
  await ejecutarSync(f.deps, cae)
  assertEquals(f.avisos.length, 1)
  assert(f.avisos[0].includes('claude'))
  ahora = new Date('2026-10-10T09:30:00Z')
  await ejecutarSync(f.deps, cae) // 3er día: ya avisado
  assertEquals(f.avisos.length, 1)
  ahora = new Date('2026-10-11T09:30:00Z')
  await ejecutarSync(f.deps, { ...cae, claude: () => Promise.resolve([]) })
  const e = f.estados.find((x) => x.proveedor === 'claude')!
  assertEquals([e.dias_fallando, e.aviso_enviado, e.ultimo_error], [0, false, null])
})

Deno.test('falla salteada (no días seguidos) no avisa', async () => {
  const f = depsFalsas()
  const cae = { claude: () => Promise.reject(new Error('boom')), whatsapp: () => Promise.resolve([]), elevenlabs: () => Promise.resolve([]) }
  let ahora = new Date('2026-10-06T09:30:00Z')
  f.deps.ahora = () => ahora
  await ejecutarSync(f.deps, cae)
  ahora = new Date('2026-10-08T09:30:00Z')
  await ejecutarSync(f.deps, cae)
  assertEquals(f.avisos.length, 0)
})

Deno.test('secreto faltante: sin_configurar, no cuenta como falla ni avisa', async () => {
  const f = depsFalsas({}, { WA_TOKEN: 't', WA_WABA_ID: 'w', ELEVENLABS_API_KEY: 'k' })
  f.deps.http = (url) =>
    Promise.resolve(json(url.includes('elevenlabs') ? { time: [], usage: {} } : { currency: 'USD', pricing_analytics: { data: [] } }))
  for (const d of ['2026-10-08T09:30:00Z', '2026-10-09T09:30:00Z']) {
    f.deps.ahora = () => new Date(d)
    const r = await ejecutarSync(f.deps)
    assertEquals(r.ok, true)
    assertEquals(r.resultados[0].estado, 'sin_configurar')
  }
  assertEquals(f.avisos.length, 0)
})

Deno.test('fallo al guardar en la base cuenta como falla de ese proveedor y no frena al resto', async () => {
  const f = depsFalsas({
    guardar: (filas) => filas[0].proveedor === 'whatsapp' ? Promise.reject(new Error('guardar: db caída')) : Promise.resolve(),
  })
  const r = await ejecutarSync(f.deps, {
    claude: () => Promise.resolve([filaX('claude')]),
    whatsapp: () => Promise.resolve([filaX('whatsapp')]),
    elevenlabs: () => Promise.resolve([filaX('elevenlabs', null)]),
  })
  assertEquals(r.resultados.map((x) => x.estado), ['ok', 'error', 'ok'])
})

Deno.test('diaPY: 02:59 UTC todavía es el día anterior en Paraguay', () => {
  assertEquals(diaPY(new Date('2026-10-08T02:59:00Z')), '2026-10-07')
  assertEquals(diaPY(new Date('2026-10-08T03:00:00Z')), '2026-10-08')
})
