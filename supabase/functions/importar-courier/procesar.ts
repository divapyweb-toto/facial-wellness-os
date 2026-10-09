// supabase/functions/importar-courier/procesar.ts
// ═══════════════════════════════════════════════════════════
// Lógica pura del importador de couriers (sin red ni base: todo el I/O entra
// por `Repo`, así se prueba con dobles en memoria).
//
// Por cada fila del archivo del courier:
//   1. traduce el estado (estados_courier.ts) — lo no traducible se ignora
//      y se cuenta, no se manda a revisión (son filas en curso del courier).
//   2. busca el pedido: por número (Codigo de Lucero sin el prefijo de la
//      tienda, NroGuiaRef de PaP) y, si no aparece, por teléfono.
//      Sin pedido → courier_revision.
//   3. inserta en pedido_estados; el unique (pedido, estado) garantiza que un
//      mismo cambio de estado se procese UNA sola vez aunque se reimporte.
//   4. programa el aviso al cliente, carga el evento en Shopify y las tags.
// ═══════════════════════════════════════════════════════════
import type { EstadoEnvio } from '../_shared/tipos.ts'
import { type Courier, traducirEstado } from '../_shared/estados_courier.ts'
import { partesAsuncion } from '../_shared/horario.ts'

export interface FilaCourier {
  referencia?: string | null
  estado_crudo?: string | null
  telefono?: string | null
  fecha?: string | null
  extra?: Record<string, unknown> | null
}

export interface PedidoImport {
  shopify_order_id: number
  nombre: string | null
  cliente_id: string | null
  telefono: string | null
  total: number | null
  estado_confirmacion: string
  estado_envio: string | null
  tags: string[] | null
  es_borrador?: boolean
  raw?: unknown
  /** wa_clientes.nombre (join). */
  cliente_nombre?: string | null
  creado_en?: string | null
}

export interface EnvioNuevo {
  cliente_id: string
  shopify_order_id: number
  plantilla: string
  variables: string[]
  categoria: 'utilidad'
  enviar_desde: string
  clave_unica: string
}

export interface Repo {
  buscarPedidoPorNumero(numero: string): Promise<PedidoImport | null>
  buscarPedidosPorTelefono(telefonoE164: string): Promise<PedidoImport[]>
  /** true si se insertó; false si ese (pedido, estado) ya existía. */
  insertarEstado(orderId: number, estado: EstadoEnvio, fuente: string): Promise<boolean>
  marcarNotificado(orderId: number, estado: EstadoEnvio): Promise<void>
  actualizarEstadoEnvio(orderId: number, estado: EstadoEnvio, courier: Courier): Promise<void>
  /** true si se programó; false si la clave_unica ya existía. */
  programarEnvio(envio: EnvioNuevo): Promise<boolean>
  enviarARevision(courier: Courier, referencia: string, fila: unknown, motivo: string): Promise<void>
  crearEventoEnvio(orderId: number, estado: EstadoEnvio): Promise<{ ok: boolean; error?: string }>
  agregarTags(orderId: number, tags: string[]): Promise<{ ok: boolean; error?: string }>
}

export interface ConfigImport {
  /** config_wa.prefijos_courier → prefijos del Codigo que pertenecen a ESTA tienda. */
  prefijos: Record<Courier, string[]>
  /** config_wa.plazos_courier */
  plazos: Record<Courier, string>
  ahora: Date
  normalizarTelefono: (x: string) => string | null
}

export interface Resumen {
  procesadas: number
  avisos_programados: number
  sin_pedido: number
  repetidas: number
  // Extras (no rompen el contrato; ayudan a la pantalla):
  estado_no_reconocido: number
  estados_no_reconocidos: string[]
  otra_tienda: number
  cancelados_cliente: number
  errores: string[]
}

// ─── Qué se manda en cada estado ───────────────────────────
// Nombres de plantillas del documento de mensajes (sección G + "Aviso de
// despacho automático"). Las variables van en orden ({{1}}, {{2}}, ...).
export const PLANTILLA_POR_ESTADO: Partial<Record<EstadoEnvio, string>> = {
  DESPACHADO: 'voltra_pedido_despachado',
  INTENTO_FALLIDO: 'voltra_no_entregado',
  NO_ENTREGADO_RESCATABLE: 'voltra_no_entregado',
  ENTREGADO: 'voltra_seguimiento_entrega',
}

export const TAG_POR_ESTADO: Partial<Record<EstadoEnvio, string>> = {
  DESPACHADO: 'DESPACHADO',
  ENTREGADO: 'ENTREGADO',
  NO_ENTREGADO: 'NO_ENTREGADO',
}

const CON_EVENTO_SHOPIFY: EstadoEnvio[] = [
  'DESPACHADO', 'INTENTO_FALLIDO', 'NO_ENTREGADO_RESCATABLE', 'ENTREGADO', 'NO_ENTREGADO',
]

// Un estado final no se pisa con uno intermedio que llega tarde (archivo
// viejo reimportado): se registra, pero no se avisa ni cambia estado_envio.
const TERMINALES = new Set<string>(['ENTREGADO', 'NO_ENTREGADO', 'CANCELADO', 'RENDIDO'])

export const NOMBRE_COURIER: Record<Courier, string> = {
  lucero: 'Lucero del Este',
  pap: 'Punto a Punto',
}

// ─── Saneo defensivo (la fila ya viene limpia de los parsers del navegador) ──
const TOPE_IMPORTE = 2_000_000 // mismo tope que src/lib/estadosPaP.js

export function fechaISO(v: unknown): string | null {
  if (v == null || v === '') return null
  const s = String(v).trim()
  const dmy = s.match(/(\d{1,2})\/(\d{1,2})\/(\d{4})/) // '31/07/2026 (Lote 419)'
  if (dmy) return `${dmy[3]}-${dmy[2].padStart(2, '0')}-${dmy[1].padStart(2, '0')}`
  const iso = s.match(/^(\d{4})-(\d{2})-(\d{2})/)
  return iso ? iso[0] : null
}

export function montoSano(v: unknown): number | null {
  if (v == null || v === '') return null
  const n = typeof v === 'number' ? Math.round(v) : parseInt(String(v).replace(/[^\d-]/g, ''), 10)
  if (!Number.isFinite(n) || Math.abs(n) > TOPE_IMPORTE) return null // 2147483647 = basura
  return n
}

export function limpiarNota(v: unknown): string {
  const t = String(v ?? '').trim()
  if (!t || t === 'N/A' || t === 'N/A | N/A') return ''
  return t.replace(/^N\/A\s*\|\s*/, '').trim()
}

export function sanearFila(f: FilaCourier): FilaCourier {
  const extra = { ...(f.extra ?? {}) }
  for (const k of ['multa', 'tarifa', 'total', 'importe']) if (k in extra) extra[k] = montoSano(extra[k])
  for (const k of ['fecha_rendicion', 'fecha_rendido', 'fecha_ruta']) if (k in extra) extra[k] = fechaISO(extra[k])
  if ('motivo' in extra) extra.motivo = limpiarNota(extra.motivo)
  if (extra.lote == null && typeof f.extra?.fecha_rendicion === 'string') {
    const m = String(f.extra.fecha_rendicion).match(/lote\s*#?\s*(\d+)/i)
    if (m) extra.lote = m[1]
  }
  return {
    referencia: String(f.referencia ?? '').trim(),
    estado_crudo: String(f.estado_crudo ?? '').trim(),
    telefono: String(f.telefono ?? '').trim(),
    fecha: fechaISO(f.fecha),
    extra,
  }
}

// ─── Referencia → número de pedido ─────────────────────────
// 'FW-2071' con prefijos ['FW-'] → '2071'. Un prefijo de OTRA tienda
// (p. ej. 'FW-' cuando la tienda es Voltra) → 'otra_tienda'.
export function numeroDesdeReferencia(
  ref: string,
  prefijos: string[],
): { numero: string | null; otraTienda: boolean } {
  const r = String(ref ?? '').trim()
  if (!r) return { numero: null, otraTienda: false }
  const limpio = (s: string) => {
    const d = s.replace(/^[#\s]+/, '').replace(/[\s.]/g, '')
    return /^\d+$/.test(d) ? String(parseInt(d, 10)) : null
  }
  // Solo dígitos (o '#1001'): no hay prefijo que validar.
  const directo = limpio(r)
  if (directo) return { numero: directo, otraTienda: false }
  const norm = (s: string) => s.toUpperCase().replace(/[\s\-_/]/g, '')
  const rn = norm(r)
  // 'VT-' es SIEMPRE de esta tienda (referencias de Voltra, src/lib/referencias.js),
  // aunque config_wa.prefijos_courier no lo liste (hoy pap = []: el VT-1004 de PaP
  // quedaba como 'otra_tienda' y no se procesaba).
  for (const p of [...prefijos, 'VT-']) {
    const pn = norm(p)
    if (pn && rn.startsWith(pn)) {
      const n = limpio(rn.slice(pn.length))
      if (n) return { numero: n, otraTienda: false }
    }
  }
  // Tiene letras de prefijo pero no son de esta tienda.
  // ('FW-2071', 'FW-WA-2001', 'LCE-12345' cuando ninguno está configurado.)
  if (/^[A-Za-z]+(?:[\s\-_/]?[A-Za-z]+)*[\s\-_/]?\d+$/.test(r)) return { numero: null, otraTienda: true }
  return { numero: null, otraTienda: false }
}

// ─── Datos para las variables de la plantilla ──────────────
type Obj = Record<string, unknown>
const obj = (x: unknown): Obj => (x && typeof x === 'object' ? x as Obj : {})

export function primerNombre(p: PedidoImport): string {
  const raw = obj(p.raw)
  const candidatos = [
    p.cliente_nombre,
    obj(raw.customer).first_name, obj(raw.customer).firstName,
    obj(raw.shipping_address).first_name, obj(raw.shippingAddress).firstName,
    obj(raw.billing_address).first_name,
  ]
  for (const c of candidatos) {
    const t = String(c ?? '').trim()
    if (t) return t.split(/\s+/)[0]
  }
  return ''
}

export function productoTexto(p: PedidoImport): string {
  const raw = obj(p.raw)
  let items: Obj[] = []
  if (Array.isArray(raw.line_items)) items = raw.line_items as Obj[]
  else if (Array.isArray(obj(raw.lineItems).nodes)) items = obj(raw.lineItems).nodes as Obj[]
  else if (Array.isArray(obj(raw.lineItems).edges)) {
    items = (obj(raw.lineItems).edges as Obj[]).map((e) => obj(e.node))
  }
  const partes = items
    .map((it) => {
      const t = String(it.title ?? it.name ?? '').trim()
      const q = Number(it.quantity ?? 1)
      // Mismo formato que el ejemplo de las plantillas de F: '1 Tiras nasales'.
      return t ? `${Number.isFinite(q) && q > 0 ? q : 1} ${t}` : ''
    })
    .filter(Boolean)
  return partes.join(', ') || (p.nombre ?? '')
}

export function formatoGs(n: number | null | undefined): string {
  const v = Math.round(Number(n ?? 0))
  return String(Math.abs(v)).replace(/\B(?=(\d{3})+(?!\d))/g, '.')
}

/** Mañana a las 10:00 hora de Asunción, como ISO UTC. */
export function manianaALas10(ahora: Date): string {
  const p = partesAsuncion(ahora)
  const comoUTC = Date.UTC(p.anio, p.mes - 1, p.dia + 1, 10, 0, 0)
  // offset = local − UTC en `ahora` (Paraguay: −3 h fijo desde oct-2024).
  const off = Date.UTC(p.anio, p.mes - 1, p.dia, p.hora, p.minuto, p.segundo) -
    Math.floor(ahora.getTime() / 1000) * 1000
  let objetivo = new Date(comoUTC - off)
  const p2 = partesAsuncion(objetivo)
  if (p2.hora !== 10) objetivo = new Date(objetivo.getTime() + (10 - p2.hora) * 3_600_000)
  return objetivo.toISOString()
}

export function armarEnvio(
  estado: EstadoEnvio,
  pedido: PedidoImport,
  courier: Courier,
  cfg: ConfigImport,
): EnvioNuevo | null {
  const plantilla = PLANTILLA_POR_ESTADO[estado]
  if (!plantilla || !pedido.cliente_id) return null
  const nombre = primerNombre(pedido)
  const producto = productoTexto(pedido)
  let variables: string[]
  let enviarDesde = cfg.ahora.toISOString()
  switch (estado) {
    case 'DESPACHADO':
      variables = [nombre, producto, NOMBRE_COURIER[courier], cfg.plazos[courier] ?? '', formatoGs(pedido.total)]
      break
    case 'ENTREGADO':
      variables = [nombre, producto]
      enviarDesde = manianaALas10(cfg.ahora)
      break
    default: // INTENTO_FALLIDO, NO_ENTREGADO_RESCATABLE
      variables = [nombre, producto]
  }
  return {
    cliente_id: pedido.cliente_id,
    shopify_order_id: pedido.shopify_order_id,
    plantilla,
    variables,
    categoria: 'utilidad',
    enviar_desde: enviarDesde,
    clave_unica: `courier:${pedido.shopify_order_id}:${estado}`,
  }
}

const esCanceladoCliente = (p: PedidoImport) =>
  p.estado_confirmacion === 'cancelado_cliente' || (p.tags ?? []).includes('CANCELADO_CLIENTE')

const FINALES_ENVIO = new Set(['ENTREGADO', 'NO_ENTREGADO', 'CANCELADO', 'RENDIDO'])

async function buscarPedido(
  fila: FilaCourier,
  numero: string | null,
  telefono: string | null,
  repo: Repo,
): Promise<{ pedido: PedidoImport | null; motivo: string }> {
  if (numero) {
    const p = await repo.buscarPedidoPorNumero(numero)
    if (p) {
      // Red de seguridad: el número coincide pero el teléfono es de otra
      // persona (p. ej. el mismo número de pedido en otra tienda).
      if (telefono && p.telefono && p.telefono !== telefono) {
        return { pedido: null, motivo: 'telefono_no_coincide' }
      }
      return { pedido: p, motivo: '' }
    }
  }
  if (telefono) {
    const lista = (await repo.buscarPedidosPorTelefono(telefono)).filter((p) => !p.es_borrador)
    if (lista.length === 1) return { pedido: lista[0], motivo: '' }
    if (lista.length > 1) {
      const abiertos = lista.filter((p) => !FINALES_ENVIO.has(p.estado_envio ?? ''))
      if (abiertos.length === 1) return { pedido: abiertos[0], motivo: '' }
      return { pedido: null, motivo: 'varios_pedidos_mismo_telefono' }
    }
  }
  void fila
  return { pedido: null, motivo: numero || telefono ? 'sin_pedido' : 'sin_referencia_ni_telefono' }
}

export async function procesarFilas(
  courier: Courier,
  filasIn: FilaCourier[],
  repo: Repo,
  cfg: ConfigImport,
): Promise<Resumen> {
  const r: Resumen = {
    procesadas: 0, avisos_programados: 0, sin_pedido: 0, repetidas: 0,
    estado_no_reconocido: 0, estados_no_reconocidos: [], otra_tienda: 0,
    cancelados_cliente: 0, errores: [],
  }
  const noReconocidos = new Set<string>()
  const fuente = `courier_${courier}`

  for (const filaCruda of filasIn) {
    const fila = sanearFila(filaCruda)
    const ref = fila.referencia ?? ''
    try {
      const rendido = fila.extra?.rendido === true
      const estado = traducirEstado(courier, fila.estado_crudo, { rendido })
      const estados: EstadoEnvio[] = []
      if (estado) estados.push(estado)
      if (rendido && estado !== 'RENDIDO') estados.push('RENDIDO')
      if (!estado) {
        r.estado_no_reconocido++
        if (fila.estado_crudo) noReconocidos.add(fila.estado_crudo)
        // Rendido sin estado conocido igual vale para conciliar caja.
        if (!estados.length) continue
      }

      const { numero, otraTienda } = numeroDesdeReferencia(ref, cfg.prefijos[courier] ?? [])
      if (otraTienda) { r.otra_tienda++; continue }
      const tel = fila.telefono ? cfg.normalizarTelefono(fila.telefono) : null

      const { pedido, motivo } = await buscarPedido(fila, numero, tel, repo)
      if (!pedido) {
        r.sin_pedido++
        await repo.enviarARevision(courier, ref, fila, motivo)
        continue
      }
      r.procesadas++

      const cancelado = esCanceladoCliente(pedido)
      let estadoActual = pedido.estado_envio ?? null

      for (const est of estados) {
        const nuevo = await repo.insertarEstado(pedido.shopify_order_id, est, fuente)
        if (!nuevo) { r.repetidas++; continue }

        const tardio = estadoActual != null && TERMINALES.has(estadoActual) && !TERMINALES.has(est)
        if (!tardio && est !== 'RENDIDO') {
          await repo.actualizarEstadoEnvio(pedido.shopify_order_id, est, courier)
          estadoActual = est
        }

        if (cancelado) {
          // No se manda nada al cliente y queda para que Enrique lo vea.
          r.cancelados_cliente++
          await repo.enviarARevision(courier, ref, { ...fila, estado: est, shopify_order_id: pedido.shopify_order_id },
            'cancelado_cliente_con_movimiento')
          continue
        }
        if (tardio) continue

        if (CON_EVENTO_SHOPIFY.includes(est)) {
          const ev = await repo.crearEventoEnvio(pedido.shopify_order_id, est)
          if (!ev.ok) r.errores.push(`${pedido.nombre ?? pedido.shopify_order_id} evento Shopify: ${ev.error ?? 'error'}`)
        }
        const tag = TAG_POR_ESTADO[est]
        if (tag) {
          const t = await repo.agregarTags(pedido.shopify_order_id, [tag])
          if (!t.ok) r.errores.push(`${pedido.nombre ?? pedido.shopify_order_id} tag ${tag}: ${t.error ?? 'error'}`)
        }

        if (PLANTILLA_POR_ESTADO[est]) {
          const envio = armarEnvio(est, pedido, courier, cfg)
          if (!envio) {
            await repo.enviarARevision(courier, ref, { ...fila, estado: est, shopify_order_id: pedido.shopify_order_id },
              'pedido_sin_cliente')
            continue
          }
          if (await repo.programarEnvio(envio)) {
            r.avisos_programados++
            await repo.marcarNotificado(pedido.shopify_order_id, est)
          }
        }
      }
    } catch (e) {
      r.errores.push(`${ref || '(sin referencia)'}: ${(e as Error)?.message ?? String(e)}`)
    }
  }
  r.estados_no_reconocidos = [...noReconocidos]
  return r
}
