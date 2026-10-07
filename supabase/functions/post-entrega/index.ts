// supabase/functions/post-entrega/index.ts · Dueño: H2 (ola 3)
// Cron cada 30 min (migración 20261006000006). Solo la service role (_shared/auth_servicio.ts).
// Pedidos con ENTREGADO en pedido_estados → fecha real de entrega, pagado en Shopify,
// Conversions API (dataset de campañas + dataset de mensajería si vino de un anuncio).
// La lógica vive en procesar.ts; acá solo el I/O.
import { db } from '../_shared/db.ts'
import { conServiceRole } from '../_shared/auth_servicio.ts'
import { normalizarTelefonoPY } from '../_shared/telefono.ts'
import { agregarTags, orderGid } from '../_shared/shopify.ts'
import { marcarPagado } from '../_shared/shopify_pagos.ts'
import { enviarEventoEntregado } from '../_shared/meta_capi.ts'
import { avisar } from '../_shared/telegram.ts'
import { facturarPedidoEntregado } from '../factura/io.ts'
import type { Courier } from '../_shared/estados_courier.ts'
import { type ConfigPostEntrega, type FilaLote, type PedidoPendiente, procesarPostEntrega, type Repo } from './procesar.ts'

// Valores por defecto si falta la clave en config_wa (se dejan en el log).
const DEFECTO = { limite: 50, max_intentos: 48, aviso_tras: 3, ventana_ctwa_dias: 7, action_source: 'system_generated' }

type CfgPE = typeof DEFECTO

async function leerConfig(): Promise<{ pe: CfgPE; prefijos: Record<Courier, string[]>; facturaActiva: boolean }> {
  const { data, error } = await db().from('config_wa').select('clave, valor').in('clave', ['post_entrega', 'prefijos_courier', 'ola4.factura'])
  if (error) throw new Error(`config_wa: ${error.message}`)
  const m = Object.fromEntries((data ?? []).map((r) => [r.clave, r.valor]))
  if (!m.post_entrega) console.log('[post-entrega] falta config_wa.post_entrega; uso valores por defecto', DEFECTO)
  const pe = { ...DEFECTO, ...(m.post_entrega ?? {}) } as CfgPE
  const pre = m.prefijos_courier ?? {}
  const arr = (x: unknown) => (Array.isArray(x) ? x.map(String) : typeof x === 'string' ? [x] : [])
  return {
    pe,
    facturaActiva: m['ola4.factura']?.activo === true,
    prefijos: { lucero: 'lucero' in pre ? arr(pre.lucero) : ['VT-', 'FW-'], pap: 'pap' in pre ? arr(pre.pap) : [] },
  }
}

function repoSupabase(pe: CfgPE): Repo {
  const s = db()
  return {
    async pendientes(limite, maxIntentos) {
      const { data, error } = await s.from('post_entrega_pendientes').select('*')
        .lt('post_entrega_intentos', maxIntentos)
        .order('entregado_registrado_en', { ascending: true }).limit(limite)
      if (error) throw new Error(`post_entrega_pendientes: ${error.message}`)
      return (data ?? []) as PedidoPendiente[]
    },
    async filasLote(courier, hasta) {
      // El lote se guarda en eventos_crudos ANTES de procesarse: es el más reciente hasta la importación.
      const tope = new Date(new Date(hasta).getTime() + 60_000).toISOString()
      const { data, error } = await s.from('eventos_crudos').select('payload')
        .eq('fuente', 'courier').like('id_externo', `${courier}:%`).lte('recibido_en', tope)
        .order('recibido_en', { ascending: false }).limit(3)
      if (error) throw new Error(`eventos_crudos: ${error.message}`)
      return (data ?? []).flatMap((r) => (Array.isArray(r.payload?.filas) ? r.payload.filas as FilaLote[] : []))
    },
    async origenAnuncio(clienteId, desde, hasta) {
      const { data, error } = await s.from('wa_mensajes').select('contenido')
        .eq('cliente_id', clienteId).eq('direccion', 'in')
        .not('contenido->referral->>ctwa_clid', 'is', null)
        .gte('creado_en', desde).lte('creado_en', hasta)
        .order('creado_en', { ascending: false }).limit(1)
      if (error) throw new Error(`wa_mensajes: ${error.message}`)
      const ref = data?.[0]?.contenido?.referral
      return ref?.ctwa_clid ? { ctwa_clid: String(ref.ctwa_clid), source_id: ref.source_id ?? null } : null
    },
    async actualizar(orderId, cambios) {
      const { error } = await s.from('shopify_pedidos').update(cambios).eq('shopify_order_id', orderId)
      if (error) throw new Error(`shopify_pedidos: ${error.message}`)
    },
    marcarPagado: (orderId) => marcarPagado(orderGid(orderId)),
    enviarCapi: (p, origen) =>
      enviarEventoEntregado(
        {
          pedido: { shopify_order_id: p.shopify_order_id, nombre: p.nombre, cliente_id: p.cliente_id, entregado_en: p.entregado_en },
          telefonoE164: p.telefono,
          valor: Number(p.total ?? 0),
          moneda: 'PYG',
          origenAnuncio: origen,
        },
        { actionSource: pe.action_source },
      ),
    agregarTags: (orderId, tags) => agregarTags(orderGid(orderId), tags),
    avisar: (texto) => avisar(texto),
    facturar: (orderId) => facturarPedidoEntregado(orderId),
  }
}

Deno.serve(conServiceRole(async () => {
  try {
    const { pe, prefijos, facturaActiva } = await leerConfig()
    const cfg: ConfigPostEntrega = {
      ahora: new Date(),
      prefijos,
      normalizarTelefono: normalizarTelefonoPY,
      limite: pe.limite,
      maxIntentos: pe.max_intentos,
      avisoTras: pe.aviso_tras,
      ventanaCtwaDias: pe.ventana_ctwa_dias,
      simuladoShopify: Deno.env.get('MODO_SIMULADO') === '1',
      facturaActiva,
    }
    const resumen = await procesarPostEntrega(repoSupabase(pe), cfg)
    if (resumen.detalle_errores.length) console.error('[post-entrega]', resumen.detalle_errores.slice(0, 20))
    return Response.json({ ok: true, ...resumen })
  } catch (e) {
    console.error('[post-entrega]', e)
    return Response.json({ ok: false, error: (e as Error)?.message ?? String(e) }, { status: 500 })
  }
}))
