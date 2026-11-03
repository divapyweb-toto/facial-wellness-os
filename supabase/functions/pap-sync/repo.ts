// supabase/functions/pap-sync/repo.ts
// I/O con la base para pap-sync.
//
// 13-10: repoCourier() y leerConfigCourier() ya no son copias: viven en importar-courier/repo.ts (un solo
// lugar para los tres caminos: pantalla Entregas, pap-sync y lucero-seguimiento) y acá se reexportan.
import { db } from '../_shared/db.ts'
import { cambiosEntrega, ESTADO_INICIAL, type EstadoSync } from './logica.ts'
import type { FilaCourier } from '../importar-courier/procesar.ts'
import type { TipoEvento } from './sync.ts'

export { leerConfigCourier, repoCourier } from '../importar-courier/repo.ts'

// 03-11: entregas sigue a PaP. Un pedido ya entregado no se pisa con un estado viejo de otra hoja, salvo el rendido.
export async function actualizarEntregas(filas: FilaCourier[]): Promise<void> {
  for (const f of filas) {
    const c = cambiosEntrega(f)
    if (!c) continue
    const base = () => db().from('entregas').update(c).eq('n_referencia', f.referencia).eq('transportadora', 'pap')
    const { error } = c.categoria === 'entregado' ? await base() : await base().neq('categoria', 'entregado')
    if (error) throw new Error(`entregas: ${error.message}`)
  }
}

// ─── Estado del sincronizador (migración 20261009000003_pap_sync.sql) ──
const CAMPOS_ESTADO = Object.keys(ESTADO_INICIAL) as (keyof EstadoSync)[]

export const estadoSupabase = {
  async leer(): Promise<EstadoSync> {
    const { data, error } = await db().from('pap_sync_estado').select(CAMPOS_ESTADO.join(', ')).eq('id', 1).maybeSingle()
    if (error) throw new Error(`pap_sync_estado: ${error.message}`)
    return { ...ESTADO_INICIAL, ...((data ?? {}) as Partial<EstadoSync>) }
  },
  async guardar(e: EstadoSync): Promise<void> {
    const fila: Record<string, unknown> = { id: 1, actualizado_en: new Date().toISOString() }
    for (const k of CAMPOS_ESTADO) fila[k] = e[k]
    const { error } = await db().from('pap_sync_estado').upsert(fila, { onConflict: 'id' })
    if (error) throw new Error(`pap_sync_estado: ${error.message}`)
  },
  async registrarEvento(tipo: TipoEvento, detalle: Record<string, unknown>): Promise<void> {
    const { error } = await db().from('pap_sync_eventos').insert({ tipo, detalle })
    if (error) console.error('pap_sync_eventos', error.message)
  },
  async contarEventos(tipo: TipoEvento, desdeISO: string): Promise<number> {
    const { count, error } = await db().from('pap_sync_eventos').select('id', { count: 'exact', head: true })
      .eq('tipo', tipo).gte('creado_en', desdeISO)
    if (error) throw new Error(`pap_sync_eventos: ${error.message}`)
    return count ?? 0
  },
}
