// supabase/functions/pap-sync/index.ts
// ═══════════════════════════════════════════════════════════
// Descarga automática de Punto a Punto (cron 3 veces por día, migración 20261009000003).
// Entra a la cuenta de Enrique en rastreo.puntoapunto.com.py con los secretos
// PAP_USUARIO / PAP_CLAVE (los carga Enrique; nunca se loguean), baja el Reporte de
// Gestión y el Reporte de Paquetes de los últimos 30 días y los pasa por el MISMO
// importador que la pantalla Entregas (importar-courier/procesar.ts → pedido_estados →
// post-entrega). Solo pedidos de Voltra (VT-).
// Solo la service role o el cron con su llave pueden llamarla (conServiceRole).
// Opcional: PAP_TENANT_ID (si el login pide tenant), PAP_DIAS (1-60, por defecto 30).
// ═══════════════════════════════════════════════════════════
import { conServiceRole } from '../_shared/auth_servicio.ts'
import { db, guardarEventoCrudo } from '../_shared/db.ts'
import { avisar } from '../_shared/telegram.ts'
import { escaparHtml } from '../_shared/telegram_formato.ts'
import { normalizarTelefonoPY } from '../_shared/telefono.ts'
import { procesarFilas } from '../importar-courier/procesar.ts'
import { crearClientePaP } from './cliente_pap.ts'
import { estadoSupabase, leerConfigCourier, repoCourier } from './repo.ts'
import { ejecutarSync } from './sync.ts'
import { leerXlsx } from './xlsx.ts'

async function sha256(texto: string): Promise<string> {
  const buf = await crypto.subtle.digest('SHA-256', new TextEncoder().encode(texto))
  return [...new Uint8Array(buf)].map((b) => b.toString(16).padStart(2, '0')).join('')
}

Deno.serve(conServiceRole(async () => {
  try {
    const r = await ejecutarSync({
      ahora: () => new Date(),
      credenciales: () => ({ usuario: Deno.env.get('PAP_USUARIO'), clave: Deno.env.get('PAP_CLAVE') }),
      pap: crearClientePaP(fetch, undefined, undefined, Deno.env.get('PAP_TENANT_ID') || undefined),
      leerXlsx,
      estado: estadoSupabase,
      async procesar(filas) {
        const cuerpo = JSON.stringify({ courier: 'pap', filas })
        const id = `pap-sync:${await sha256(cuerpo)}`
        await guardarEventoCrudo('courier', id, { courier: 'pap', filas, origen: 'pap-sync' })
          .catch((e) => console.error('eventos_crudos', e))
        const cfg = await leerConfigCourier()
        const resumen = await procesarFilas('pap', filas, repoCourier(), {
          ...cfg,
          ahora: new Date(),
          normalizarTelefono: normalizarTelefonoPY,
        })
        await db().from('eventos_crudos')
          .update({ procesado_en: new Date().toISOString(), error: resumen.errores.length ? resumen.errores.slice(0, 20).join(' | ') : null })
          .eq('fuente', 'courier').eq('id_externo', id)
        return resumen
      },
      avisar: (texto) => avisar(escaparHtml(texto)),
      pausa: (ms) => new Promise((ok) => setTimeout(ok, ms + Math.floor(Math.random() * 2000))),
      dias: Number(Deno.env.get('PAP_DIAS')) || undefined,
    })
    // Solo conteos: nada de teléfonos ni referencias en el log.
    console.log('pap-sync', JSON.stringify({ ok: r.ok, motivo: r.motivo, filas_voltra: r.filas_voltra, procesadas: r.resumen?.procesadas }))
    return Response.json(r, { status: r.ok || r.motivo === 'frenado_por_login' || r.motivo === 'desactivado' ? 200 : 502 })
  } catch (e) {
    console.error('pap-sync', (e as Error)?.message ?? e)
    return Response.json({ ok: false, error: (e as Error)?.message ?? String(e) }, { status: 500 })
  }
}))
