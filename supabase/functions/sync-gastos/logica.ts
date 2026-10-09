// supabase/functions/sync-gastos/logica.ts · Dueño: A1 (09-10-2026)
// Gasto REAL facturado por proveedor de API → public.gastos_proveedor_diario (migración 20261009000010).
// Lógica pura: todo el I/O entra por Deps (http = fetch, repo de Supabase, Telegram), así se prueba sin red.
//
// Formatos verificados el 09-10-2026:
//   Claude    GET https://api.anthropic.com/v1/organizations/cost_report (Admin API; doc platform.claude.com
//             manage-claude/usage-cost-api + api/beta/organization/cost_report/retrieve). amount = string decimal
//             en CENTAVOS de USD ("123.45" = $1,2345). Buckets diarios en UTC, paginado con has_more/next_page.
//             Probado contra la API real: con la ANTHROPIC_API_KEY normal responde 401 "The Admin API requires an
//             Admin API key..." → hace falta ANTHROPIC_ADMIN_KEY (sk-ant-admin01-...).
//   WhatsApp  GET graph.facebook.com/v25.0/<WABA>?fields=currency,pricing_analytics.start().end()
//             .granularity(DAILY).metric_types(["COST","VOLUME"]).dimensions(["PRICING_CATEGORY","PRICING_TYPE"])
//             Probado contra la API real (GET): data[0].data_points[] = {start,end,pricing_type,pricing_category,
//             volume,cost}; cost es número en la moneda de la cuenta (currency = "USD"); cortes diarios a las
//             00:00 de Paraguay (03:00 UTC).
//   ElevenLabs GET https://api.elevenlabs.io/v1/usage/character-stats?breakdown_type=product_type
//             Probado contra la API real: {time:[ms 00:00 UTC], usage:{STT:[...],TTS:[...],...}} en CRÉDITOS.
//             No da dólares y la tarifa del plan no se puede leer (la clave no tiene user_read) → monto_usd null.
//             La doc (changelog 20-04-2026) lo marca deprecado en favor de POST /v1/workspace/analytics/query/
//             usage-by-product-over-time; hoy sigue respondiendo. [VERIFICAR] si deja de andar.

export type Proveedor = 'claude' | 'whatsapp' | 'elevenlabs'
export const PROVEEDORES: Proveedor[] = ['claude', 'whatsapp', 'elevenlabs']

export interface FilaGasto {
  fecha: string // YYYY-MM-DD
  proveedor: Proveedor
  concepto: string
  monto_usd: number | null
  detalle: Record<string, unknown>
  fuente: 'api'
}

export interface EstadoProveedor {
  proveedor: Proveedor
  ultimo_ok_en: string | null
  ultimo_error: string | null
  ultimo_fallo_dia: string | null
  dias_fallando: number
  aviso_enviado: boolean
}

export type Http = (url: string, init?: RequestInit) => Promise<Response>

export interface Deps {
  ahora: () => Date
  env: (nombre: string) => string | undefined
  http: Http
  guardar: (filas: FilaGasto[]) => Promise<void>
  leerEstados: () => Promise<EstadoProveedor[]>
  guardarEstado: (e: EstadoProveedor) => Promise<void>
  avisar: (texto: string) => Promise<unknown>
}

export const DIAS_RESYNC = 7
export const GRAPH_VERSION = 'v25.0'
const ZONA_PY = 'America/Asuncion'
const DIA_MS = 86_400_000

/** Falta de configuración (secreto ausente): no cuenta como falla para el aviso de Telegram. */
export class SinConfigurar extends Error {}

// ─── Fechas ───────────────────────────────────────────────────────────────

/** YYYY-MM-DD en UTC. */
export function diaUTC(d: Date): string {
  return d.toISOString().slice(0, 10)
}

/** YYYY-MM-DD en hora de Paraguay. */
export function diaPY(d: Date): string {
  return new Intl.DateTimeFormat('en-CA', { timeZone: ZONA_PY, year: 'numeric', month: '2-digit', day: '2-digit' })
    .format(d)
}

/** 00:00 UTC del día de `d`. */
export function inicioDiaUTC(d: Date): Date {
  return new Date(Date.UTC(d.getUTCFullYear(), d.getUTCMonth(), d.getUTCDate()))
}

function redondear6(n: number): number {
  return Math.round(n * 1e6) / 1e6
}

/** Error legible sin filtrar secretos: solo status + mensaje de la API (recortado). */
async function errorHttp(nombre: string, r: Response): Promise<Error> {
  let msg = ''
  try {
    const j = await r.json()
    msg = j?.error?.message ?? j?.detail?.message ?? (typeof j?.detail === 'string' ? j.detail : '') ?? ''
  } catch { /* cuerpo no JSON */ }
  return new Error(`${nombre}: HTTP ${r.status}${msg ? ` · ${String(msg).slice(0, 200)}` : ''}`)
}

// ─── Claude (Anthropic Usage & Cost Admin API) ────────────────────────────

interface ResultadoCostoAnthropic {
  amount: string
  currency?: string
  description?: string | null
  model?: string | null
  cost_type?: string | null
  token_type?: string | null
  service_tier?: string | null
}
interface PaginaCostoAnthropic {
  data: { starting_at: string; ending_at: string; results: ResultadoCostoAnthropic[] }[]
  has_more: boolean
  next_page: string | null
}

/** Centavos (string decimal) → dólares. "123.45" → 1.2345. */
export function centavosADolares(amount: string | number): number {
  const n = typeof amount === 'number' ? amount : Number.parseFloat(amount)
  if (!Number.isFinite(n)) throw new Error(`monto inválido: ${amount}`)
  return n / 100
}

/** Junta las páginas en filas: una por (día UTC del bucket, modelo o descripción). */
export function filasClaude(paginas: PaginaCostoAnthropic[]): FilaGasto[] {
  const acc = new Map<string, FilaGasto & { detalle: { por_tipo: Record<string, number>; moneda: string } }>()
  for (const p of paginas) {
    for (const b of p.data ?? []) {
      const fecha = b.starting_at.slice(0, 10) // bucket UTC: la fecha del inicio
      for (const r of b.results ?? []) {
        if (r.currency && r.currency !== 'USD') throw new Error(`claude: moneda inesperada ${r.currency}`)
        const concepto = r.model ?? r.description ?? ''
        const usd = centavosADolares(r.amount)
        const k = `${fecha}|${concepto}`
        let f = acc.get(k)
        if (!f) {
          f = { fecha, proveedor: 'claude', concepto, monto_usd: 0, detalle: { por_tipo: {}, moneda: 'USD' }, fuente: 'api' }
          acc.set(k, f)
        }
        f.monto_usd = (f.monto_usd ?? 0) + usd
        const tipo = [r.cost_type, r.token_type, r.service_tier].filter(Boolean).join(':') || (r.description ?? 'total')
        f.detalle.por_tipo[tipo] = redondear6((f.detalle.por_tipo[tipo] ?? 0) + usd)
      }
    }
  }
  return [...acc.values()].map((f) => ({ ...f, monto_usd: redondear6(f.monto_usd ?? 0) }))
}

/** Pide los últimos DIAS_RESYNC días COMPLETOS (UTC) y sigue next_page hasta has_more=false. */
export async function traerClaude(deps: Deps): Promise<FilaGasto[]> {
  const clave = deps.env('ANTHROPIC_ADMIN_KEY')
  if (!clave) throw new SinConfigurar('claude: falta el secreto ANTHROPIC_ADMIN_KEY (Admin API key sk-ant-admin01-...)')
  const fin = inicioDiaUTC(deps.ahora()) // hoy UTC está incompleto: entra mañana (resync de 7 días)
  const inicio = new Date(fin.getTime() - DIAS_RESYNC * DIA_MS)
  const paginas: PaginaCostoAnthropic[] = []
  let page: string | null = null
  for (let i = 0; i < 20; i++) {
    const q = new URLSearchParams({
      starting_at: inicio.toISOString(),
      ending_at: fin.toISOString(),
      bucket_width: '1d',
      limit: '31',
    })
    q.append('group_by[]', 'description')
    if (page) q.set('page', page)
    const r = await deps.http(`https://api.anthropic.com/v1/organizations/cost_report?${q}`, {
      headers: { 'x-api-key': clave, 'anthropic-version': '2023-06-01', 'user-agent': 'VoltraOS/1.0 sync-gastos' },
    })
    if (!r.ok) throw await errorHttp('claude', r)
    const j = await r.json() as PaginaCostoAnthropic
    paginas.push(j)
    if (!j.has_more || !j.next_page) return filasClaude(paginas)
    page = j.next_page
  }
  throw new Error('claude: demasiadas páginas (más de 20)')
}

// ─── WhatsApp (Graph API pricing_analytics de la WABA) ────────────────────

interface PuntoPrecioWA {
  start: number
  end: number
  pricing_type?: string
  pricing_category?: string
  volume?: number
  cost?: number
}
interface RespuestaWA {
  currency?: string
  pricing_analytics?: { data?: { data_points?: PuntoPrecioWA[] }[]; paging?: { next?: string } }
}

/** Una fila por (día de Paraguay, categoría). Si la moneda no es USD: monto_usd null y el monto en detalle. */
export function filasWhatsApp(puntos: PuntoPrecioWA[], moneda: string | undefined): FilaGasto[] {
  const acc = new Map<string, { fecha: string; concepto: string; costo: number; volumen: number; por_tipo: Record<string, { volumen: number; costo: number }> }>()
  for (const p of puntos) {
    const fecha = diaPY(new Date(p.start * 1000))
    const concepto = (p.pricing_category ?? '').toLowerCase()
    const k = `${fecha}|${concepto}`
    let a = acc.get(k)
    if (!a) {
      a = { fecha, concepto, costo: 0, volumen: 0, por_tipo: {} }
      acc.set(k, a)
    }
    const costo = Number(p.cost ?? 0)
    const vol = Number(p.volume ?? 0)
    a.costo += costo
    a.volumen += vol
    const t = (p.pricing_type ?? 'SIN_TIPO').toLowerCase()
    const pt = a.por_tipo[t] ?? { volumen: 0, costo: 0 }
    pt.volumen += vol
    pt.costo = redondear6(pt.costo + costo)
    a.por_tipo[t] = pt
  }
  const esUSD = (moneda ?? '').toUpperCase() === 'USD'
  return [...acc.values()].map((a) => ({
    fecha: a.fecha,
    proveedor: 'whatsapp' as const,
    concepto: a.concepto,
    monto_usd: esUSD ? redondear6(a.costo) : null,
    detalle: {
      moneda: moneda ?? null,
      volumen: a.volumen,
      por_tipo: a.por_tipo,
      ...(esUSD ? {} : { monto_moneda_cuenta: redondear6(a.costo) }),
    },
    fuente: 'api' as const,
  }))
}

export async function traerWhatsApp(deps: Deps): Promise<FilaGasto[]> {
  const token = deps.env('WA_TOKEN')
  const waba = deps.env('WA_WABA_ID')
  if (!token || !waba) throw new SinConfigurar('whatsapp: falta el secreto WA_TOKEN o WA_WABA_ID')
  const ahora = deps.ahora()
  // Desde las 00:00 de Paraguay de hace 7 días (PY = UTC-3 fijo desde 2024).
  const hoyPY = diaPY(ahora)
  const inicio = Math.floor((Date.parse(`${hoyPY}T00:00:00-03:00`) - DIAS_RESYNC * DIA_MS) / 1000)
  const fin = Math.floor(ahora.getTime() / 1000)
  const campo = `currency,pricing_analytics.start(${inicio}).end(${fin}).granularity(DAILY)` +
    `.metric_types(["COST","VOLUME"]).dimensions(["PRICING_CATEGORY","PRICING_TYPE"])`
  const headers = { authorization: `Bearer ${token}` }
  const r = await deps.http(
    `https://graph.facebook.com/${GRAPH_VERSION}/${encodeURIComponent(waba)}?fields=${encodeURIComponent(campo)}`,
    { headers },
  )
  if (!r.ok) throw await errorHttp('whatsapp', r)
  const j = await r.json() as RespuestaWA
  const puntos: PuntoPrecioWA[] = (j.pricing_analytics?.data ?? []).flatMap((d) => d.data_points ?? [])
  let siguiente = j.pricing_analytics?.paging?.next
  for (let i = 0; siguiente && i < 20; i++) {
    const rp = await deps.http(siguiente, { headers })
    if (!rp.ok) throw await errorHttp('whatsapp', rp)
    const jp = await rp.json() as { data?: { data_points?: PuntoPrecioWA[] }[]; paging?: { next?: string } }
    puntos.push(...(jp.data ?? []).flatMap((d) => d.data_points ?? []))
    siguiente = jp.paging?.next
  }
  return filasWhatsApp(puntos, j.currency)
}

// ─── ElevenLabs (créditos por día y producto) ─────────────────────────────

interface RespuestaEleven {
  time: number[]
  usage: Record<string, number[]>
}

/** Una fila por (día UTC, producto) con créditos > 0. monto_usd null: la API no da dólares. */
export function filasElevenLabs(j: RespuestaEleven): FilaGasto[] {
  const filas: FilaGasto[] = []
  for (const [producto, serie] of Object.entries(j.usage ?? {})) {
    ;(j.time ?? []).forEach((t, i) => {
      const creditos = Number(serie?.[i] ?? 0)
      if (!creditos) return
      filas.push({
        fecha: diaUTC(new Date(t)),
        proveedor: 'elevenlabs',
        concepto: producto.toLowerCase(),
        monto_usd: null,
        detalle: { creditos, unidad: 'creditos', nota: 'la API no informa dólares; ver plan en elevenlabs.io' },
        fuente: 'api',
      })
    })
  }
  return filas
}

export async function traerElevenLabs(deps: Deps): Promise<FilaGasto[]> {
  const clave = deps.env('ELEVENLABS_API_KEY')
  if (!clave) throw new SinConfigurar('elevenlabs: falta el secreto ELEVENLABS_API_KEY')
  const ahora = deps.ahora()
  const inicio = inicioDiaUTC(ahora).getTime() - DIAS_RESYNC * DIA_MS
  const q = new URLSearchParams({
    start_unix: String(inicio),
    end_unix: String(ahora.getTime()),
    aggregation_interval: 'day',
    breakdown_type: 'product_type',
    include_workspace_metrics: 'true',
  })
  const r = await deps.http(`https://api.elevenlabs.io/v1/usage/character-stats?${q}`, { headers: { 'xi-api-key': clave } })
  if (!r.ok) throw await errorHttp('elevenlabs', r)
  return filasElevenLabs(await r.json() as RespuestaEleven)
}

// ─── Orquestación ─────────────────────────────────────────────────────────

export const TRAER: Record<Proveedor, (d: Deps) => Promise<FilaGasto[]>> = {
  claude: traerClaude,
  whatsapp: traerWhatsApp,
  elevenlabs: traerElevenLabs,
}

export interface ResultadoProveedor {
  proveedor: Proveedor
  estado: 'ok' | 'sin_configurar' | 'error'
  filas: number
  total_usd?: number
  error?: string
  aviso?: boolean
}

function estadoVacio(p: Proveedor): EstadoProveedor {
  return { proveedor: p, ultimo_ok_en: null, ultimo_error: null, ultimo_fallo_dia: null, dias_fallando: 0, aviso_enviado: false }
}

/** Día anterior (YYYY-MM-DD). */
function diaAnterior(dia: string): string {
  return diaUTC(new Date(Date.parse(`${dia}T00:00:00Z`) - DIA_MS))
}

/**
 * Corre los 3 proveedores AISLADOS: si uno falla, los otros siguen.
 * Aviso por Telegram solo cuando un proveedor falla 2 días (de Paraguay) seguidos, una vez por racha.
 */
export async function ejecutarSync(deps: Deps, traer = TRAER): Promise<{ ok: boolean; resultados: ResultadoProveedor[] }> {
  const ahora = deps.ahora()
  const hoy = diaPY(ahora)
  let estados: EstadoProveedor[] = []
  try {
    estados = await deps.leerEstados()
  } catch (e) {
    console.error('sync-gastos leerEstados', (e as Error).message)
  }
  const resultados: ResultadoProveedor[] = []
  for (const p of PROVEEDORES) {
    const est = { ...(estados.find((e) => e.proveedor === p) ?? estadoVacio(p)) }
    try {
      const filas = await traer[p](deps)
      if (filas.length) await deps.guardar(filas)
      const total = filas.reduce((s, f) => s + (f.monto_usd ?? 0), 0)
      resultados.push({ proveedor: p, estado: 'ok', filas: filas.length, total_usd: redondear6(total) })
      Object.assign(est, { ultimo_ok_en: ahora.toISOString(), ultimo_error: null, dias_fallando: 0, aviso_enviado: false })
    } catch (e) {
      const msg = (e as Error)?.message ?? String(e)
      if (e instanceof SinConfigurar) {
        resultados.push({ proveedor: p, estado: 'sin_configurar', filas: 0, error: msg })
        est.ultimo_error = msg
      } else {
        if (est.ultimo_fallo_dia !== hoy) {
          est.dias_fallando = est.ultimo_fallo_dia === diaAnterior(hoy) ? est.dias_fallando + 1 : 1
          est.ultimo_fallo_dia = hoy
        }
        est.ultimo_error = msg
        let aviso = false
        if (est.dias_fallando >= 2 && !est.aviso_enviado) {
          try {
            await deps.avisar(
              `Gastos automáticos: ${p} falla hace ${est.dias_fallando} días seguidos. Último error: ${msg}`,
            )
            est.aviso_enviado = true
            aviso = true
          } catch (ea) {
            console.error('sync-gastos avisar', (ea as Error).message)
          }
        }
        resultados.push({ proveedor: p, estado: 'error', filas: 0, error: msg, aviso })
      }
    }
    try {
      await deps.guardarEstado(est)
    } catch (e) {
      console.error('sync-gastos guardarEstado', (e as Error).message)
    }
  }
  return { ok: resultados.every((r) => r.estado !== 'error'), resultados }
}
