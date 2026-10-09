// supabase/functions/lucero-seguimiento/io.ts · Dueño: W (09-10-2026)
// I/O real de la función: Supabase (entregas, pipeline de courier), la página pública de Lucero y Telegram.
//
// El Repo del pipeline común es una COPIA de repoSupabase() de importar-courier/index.ts: ese archivo no lo
// exporta y al importarlo arrancaría su propio Deno.serve. Si se cambia uno, cambiar el otro (o mover ambos a
// importar-courier/repo.ts, que es lo correcto cuando se pueda tocar ese archivo).
import { db, guardarEventoCrudo } from '../_shared/db.ts'
import { normalizarTelefonoPY } from '../_shared/telefono.ts'
import { agregarTags, crearEventoEnvio, orderGid } from '../_shared/shopify.ts'
import { avisar } from '../_shared/telegram.ts'
import { type ConfigImport, type FilaCourier, type PedidoImport, procesarFilas, type Repo } from '../importar-courier/procesar.ts'
import { CATEGORIAS_TERMINALES, type ConfigSeguimiento, type Deps, type GuiaAbierta } from './procesar.ts'

export const URL_ENVIO = 'https://www.luceroexpress.com.py/envio.php?id='
export const USER_AGENT = 'VoltraOS/1.0 (seguimiento de envios propios; contacto voltraparaguay@gmail.com)'
const TIMEOUT_MS = 15_000

const COLS_PEDIDO =
  'shopify_order_id, nombre, cliente_id, telefono, total, estado_confirmacion, estado_envio, tags, es_borrador, raw, creado_en, wa_clientes(nombre)'

// deno-lint-ignore no-explicit-any
function aPedido(row: any): PedidoImport {
  const { wa_clientes, ...resto } = row ?? {}
  return { ...resto, cliente_nombre: wa_clientes?.nombre ?? null }
}

async function sha256(t: string): Promise<string> {
  const buf = await crypto.subtle.digest('SHA-256', new TextEncoder().encode(t))
  return [...new Uint8Array(buf)].map((b) => b.toString(16).padStart(2, '0')).join('')
}

/** config_wa: lucero_seguimiento {activo, tope, pausa_ms} + prefijos/plazos del pipeline (como importar-courier). */
export async function leerConfig(): Promise<{
  activo: boolean
  seguimiento: Partial<ConfigSeguimiento>
  importar: Pick<ConfigImport, 'prefijos' | 'plazos'>
}> {
  const { data, error } = await db().from('config_wa').select('clave, valor')
    .in('clave', ['lucero_seguimiento', 'prefijos_courier', 'plazos_courier'])
  if (error) throw new Error(`config_wa: ${error.message}`)
  const m = Object.fromEntries((data ?? []).map((r) => [r.clave, r.valor]))
  const ls = m.lucero_seguimiento ?? {}
  const pre = m.prefijos_courier ?? {}
  const arr = (x: unknown) => Array.isArray(x) ? x.map(String) : typeof x === 'string' ? [x] : []
  return {
    activo: ls.activo !== false, // sin la clave: activo con valores por defecto
    seguimiento: { tope: ls.tope, pausa_ms: ls.pausa_ms },
    importar: {
      prefijos: { lucero: 'lucero' in pre ? arr(pre.lucero) : ['FW-'], pap: 'pap' in pre ? arr(pre.pap) : [] },
      plazos: { lucero: m.plazos_courier?.lucero ?? '', pap: m.plazos_courier?.pap ?? '' },
    },
  }
}

export function repoCourier(): Repo {
  const s = db()
  return {
    async buscarPedidoPorNumero(numero) {
      const { data, error } = await s.from('shopify_pedidos').select(COLS_PEDIDO)
        .in('nombre', [`#${numero}`, numero]).eq('es_borrador', false).limit(2)
      if (error) throw new Error(`buscar pedido: ${error.message}`)
      return data && data.length === 1 ? aPedido(data[0]) : null
    },
    async buscarPedidosPorTelefono(tel) {
      const { data, error } = await s.from('shopify_pedidos').select(COLS_PEDIDO)
        .eq('telefono', tel).order('creado_en', { ascending: false }).limit(10)
      if (error) throw new Error(`buscar por teléfono: ${error.message}`)
      return (data ?? []).map(aPedido)
    },
    async avisoPendiente(orderId, estado) {
      // Estado guardado pero cuyo aviso no salió (falla anterior): se reintenta en vez de contarlo como repetido.
      const { data, error } = await s.from('pedido_estados').select('notificado')
        .eq('shopify_order_id', orderId).eq('estado', estado).maybeSingle()
      if (error) throw new Error(`pedido_estados: ${error.message}`)
      return data?.notificado === false
    },
    async insertarEstado(orderId, estado, fuente) {
      const { data, error } = await s.from('pedido_estados')
        .upsert({ shopify_order_id: orderId, estado, fuente }, { onConflict: 'shopify_order_id,estado', ignoreDuplicates: true })
        .select('id')
      if (error) throw new Error(`pedido_estados: ${error.message}`)
      return Array.isArray(data) && data.length > 0
    },
    async marcarNotificado(orderId, estado) {
      const { error } = await s.from('pedido_estados').update({ notificado: true })
        .eq('shopify_order_id', orderId).eq('estado', estado)
      if (error) throw new Error(`marcar notificado: ${error.message}`)
    },
    async actualizarEstadoEnvio(orderId, estado, courier) {
      const { error } = await s.from('shopify_pedidos').update({ estado_envio: estado, courier })
        .eq('shopify_order_id', orderId)
      if (error) throw new Error(`estado_envio: ${error.message}`)
    },
    async programarEnvio(envio) {
      const { data, error } = await s.from('envios_programados')
        .upsert(envio, { onConflict: 'clave_unica', ignoreDuplicates: true }).select('id')
      if (error) throw new Error(`envios_programados: ${error.message}`)
      return Array.isArray(data) && data.length > 0
    },
    async enviarARevision(courier, referencia, fila, motivo) {
      const { error } = await s.from('courier_revision').insert({ courier, referencia, fila, motivo })
      if (error) throw new Error(`courier_revision: ${error.message}`)
    },
    async crearEventoEnvio(orderId, estado) {
      const r = await crearEventoEnvio(orderGid(orderId), estado)
      return { ok: r.ok, error: r.error }
    },
    async agregarTags(orderId, tags) {
      const r = await agregarTags(orderGid(orderId), tags)
      return { ok: r.ok, error: r.error }
    },
  }
}

const TERMINALES_SQL = `(${[...CATEGORIAS_TERMINALES].join(',')})`

export function depsReales(importar: Pick<ConfigImport, 'prefijos' | 'plazos'>): Deps {
  const s = db()
  return {
    async guiasAbiertas(tope) {
      // Lucero + Voltra + con EnvioID + sin estado terminal; las menos recientemente consultadas primero.
      const { data, error } = await s.from('entregas')
        .select('nro_guia_pap, n_referencia, guia_transportadora, categoria, estado_pap, vinculo_metodo, importe')
        .eq('transportadora', 'lucero')
        .ilike('n_referencia', 'VT-%')
        .not('guia_transportadora', 'is', null).neq('guia_transportadora', '')
        .or(`categoria.is.null,categoria.not.in.${TERMINALES_SQL}`)
        .order('lucero_consultado_en', { ascending: true, nullsFirst: true })
        .limit(tope)
      if (error) throw new Error(`entregas: ${error.message}`)
      return (data ?? [])
        .filter((e) => /^\d+$/.test(String(e.guia_transportadora).trim()))
        .map((e): GuiaAbierta => ({
          nro_guia_pap: e.nro_guia_pap, n_referencia: e.n_referencia, envio_id: String(e.guia_transportadora).trim(),
          categoria: e.categoria, estado_pap: e.estado_pap, vinculo_metodo: e.vinculo_metodo, importe: e.importe,
        }))
    },
    async consultar(envioId) {
      const r = await fetch(URL_ENVIO + encodeURIComponent(envioId), {
        headers: { 'User-Agent': USER_AGENT, Accept: 'text/html' },
        redirect: 'manual', // un 302 a login.php = la página dejó de ser pública → cuenta como falla
        signal: AbortSignal.timeout(TIMEOUT_MS),
      })
      const html = r.status === 200 ? await r.text() : (await r.body?.cancel(), '')
      return { status: r.status, html }
    },
    esperar: (ms) => new Promise((ok) => setTimeout(ok, ms)),
    async guardarLote(filas: FilaCourier[]) {
      // Mismo formato que importar-courier: post-entrega busca acá la fecha real del ENTREGADO.
      const cuerpo = JSON.stringify({ courier: 'lucero', filas })
      await guardarEventoCrudo('courier', `lucero:web:${await sha256(cuerpo)}`,
        { courier: 'lucero', filas, origen: 'lucero-seguimiento' })
        .catch((e) => console.error('eventos_crudos', e))
    },
    procesarFilas: (filas) =>
      procesarFilas('lucero', filas, repoCourier(), { ...importar, ahora: new Date(), normalizarTelefono: normalizarTelefonoPY }),
    async actualizarEntrega(nroGuia, cambios) {
      // Condiciones en la base (no solo en memoria): si entre la lectura y ahora alguien cargó un estado
      // terminal o vinculó a mano, el update no toca nada.
      const { data, error } = await s.from('entregas').update(cambios)
        .eq('nro_guia_pap', nroGuia)
        .or(`categoria.is.null,categoria.not.in.${TERMINALES_SQL}`)
        .or('vinculo_metodo.is.null,vinculo_metodo.neq.manual')
        .select('nro_guia_pap')
      if (error) throw new Error(`entregas update: ${error.message}`)
      return Array.isArray(data) && data.length > 0
    },
    async marcarConsultada(nroGuia, err) {
      const { error } = await s.from('entregas')
        .update({ lucero_consultado_en: new Date().toISOString(), lucero_web_error: err })
        .eq('nro_guia_pap', nroGuia)
      if (error) console.error('marcarConsultada', error.message)
    },
    async avisar(texto) {
      const r = await avisar(texto)
      if (!r.ok) console.error('telegram', r.error)
    },
  }
}
