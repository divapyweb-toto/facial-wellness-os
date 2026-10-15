// supabase/functions/lucero-seguimiento/io.ts · Dueño: W (09-10-2026)
// I/O real de la función: Supabase (entregas, pipeline de courier), la página pública de Lucero y Telegram.
//
// 13-10: el Repo del pipeline común ya no es una copia: viene de importar-courier/repo.ts (el mismo que usan la
// pantalla Entregas y pap-sync), así un intento fallido visto en la web de Lucero sigue exactamente el mismo
// camino (pedido_estados → aviso de reintento al cliente → texto para el courier a Enrique).
import { db, guardarEventoCrudo } from '../_shared/db.ts'
import { normalizarTelefonoPY } from '../_shared/telefono.ts'
import { avisar } from '../_shared/telegram.ts'
import { type ConfigImport, type FilaCourier, procesarFilas } from '../importar-courier/procesar.ts'
import { configCourierDesde, repoCourier } from '../importar-courier/repo.ts'
import { CATEGORIAS_TERMINALES, type ConfigSeguimiento, type Deps, type GuiaAbierta } from './procesar.ts'

export { repoCourier }

export const URL_ENVIO = 'https://www.luceroexpress.com.py/envio.php?id='
export const USER_AGENT = 'VoltraOS/1.0 (seguimiento de envios propios; contacto voltraparaguay@gmail.com)'
const TIMEOUT_MS = 15_000

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
  return {
    activo: ls.activo !== false, // sin la clave: activo con valores por defecto
    seguimiento: { tope: ls.tope, pausa_ms: ls.pausa_ms },
    importar: configCourierDesde(m.prefijos_courier, m.plazos_courier),
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
