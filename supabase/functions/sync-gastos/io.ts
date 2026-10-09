// supabase/functions/sync-gastos/io.ts · Dueño: A1 (09-10-2026)
// I/O real: Supabase (service role) y Telegram. Las APIs de proveedores van por deps.http = fetch.
import { db } from '../_shared/db.ts'
import { avisar } from '../_shared/telegram.ts'
import { escaparHtml } from '../_shared/telegram_formato.ts'
import type { Deps, EstadoProveedor, FilaGasto } from './logica.ts'

const TIMEOUT_MS = 20_000

/** fetch con timeout: un proveedor colgado no frena a los demás. */
function fetchConTimeout(url: string, init?: RequestInit): Promise<Response> {
  return fetch(url, { ...init, signal: AbortSignal.timeout(TIMEOUT_MS) })
}

export function depsReales(): Deps {
  return {
    ahora: () => new Date(),
    env: (n) => Deno.env.get(n) ?? undefined,
    http: fetchConTimeout,
    async guardar(filas: FilaGasto[]) {
      const sincronizado_en = new Date().toISOString()
      const { error } = await db().from('gastos_proveedor_diario')
        .upsert(filas.map((f) => ({ ...f, sincronizado_en })), { onConflict: 'fecha,proveedor,concepto' })
      if (error) throw new Error(`guardar: ${error.message}`)
    },
    async leerEstados() {
      const { data, error } = await db().from('gastos_sync_estado')
        .select('proveedor, ultimo_ok_en, ultimo_error, ultimo_fallo_dia, dias_fallando, aviso_enviado')
      if (error) throw new Error(`leerEstados: ${error.message}`)
      return (data ?? []) as EstadoProveedor[]
    },
    async guardarEstado(e: EstadoProveedor) {
      const { error } = await db().from('gastos_sync_estado')
        .upsert({ ...e, actualizado_en: new Date().toISOString() }, { onConflict: 'proveedor' })
      if (error) throw new Error(`guardarEstado: ${error.message}`)
    },
    avisar: (texto) => avisar(escaparHtml(texto)),
  }
}
