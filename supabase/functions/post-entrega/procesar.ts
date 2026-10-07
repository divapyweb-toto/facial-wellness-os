// supabase/functions/post-entrega/procesar.ts · Dueño: H2 (ola 3)
// Lógica pura del post-entrega (todo el I/O entra por `Repo`; se prueba en memoria).
//
// Por cada pedido con ENTREGADO en pedido_estados que no terminó su post-entrega:
//   1. entregado_en = fecha real del courier (la fila del lote importado); si no se
//      encuentra, la hora en que se importó el ENTREGADO (entregado_fuente 'importacion').
//   2. marcarPagado en Shopify, UNA vez (pagado_marcado).
//   3. Conversions API, UNA vez (capi_enviado) + tag META_ENTREGA_ENVIADA.
//      Si la entrega tiene más de 7 días, Meta rechazaría el lote: se omite (capi_omitido).
//      En modo simulado no se cambia nada: cuando llegue el token, se envía de verdad.
//   4. Si algo falla: intentos + 1 y último error; al llegar a `avisoTras` (3) fallos,
//      un aviso a Telegram (una sola vez). Se reintenta en cada corrida hasta `maxIntentos`.
import type { Courier } from '../_shared/estados_courier.ts'
import { traducirEstado } from '../_shared/estados_courier.ts'
import { fechaISO, numeroDesdeReferencia } from '../importar-courier/procesar.ts'
import { dentroDePlazo, type OrigenAnuncio, type ResultadoCapi } from '../_shared/meta_capi.ts'

export const TAG_CAPI = 'META_ENTREGA_ENVIADA'

export interface PedidoPendiente {
  shopify_order_id: number
  nombre: string | null
  cliente_id: string | null
  telefono: string | null
  total: number | null
  tags: string[] | null
  creado_en: string | null
  entregado_en: string | null
  pagado_marcado: boolean
  capi_enviado: boolean
  capi_omitido: string | null
  post_entrega_intentos: number
  /** pedido_estados.creado_en del ENTREGADO (cuándo se importó). */
  entregado_registrado_en: string
  /** pedido_estados.fuente: 'courier_lucero' | 'courier_pap' | otro. */
  entregado_fuente_estado: string | null
}

export interface FilaLote {
  referencia?: string | null
  estado_crudo?: string | null
  telefono?: string | null
  fecha?: string | null
  extra?: Record<string, unknown> | null
}

export interface CambiosPedido {
  entregado_en?: string
  entregado_fuente?: 'courier' | 'importacion'
  pagado_marcado?: boolean
  capi_enviado?: boolean
  capi_omitido?: string
  post_entrega_intentos?: number
  post_entrega_ultimo_error?: string | null
  post_entrega_procesado_en?: string
}

export interface Repo {
  pendientes(limite: number, maxIntentos: number): Promise<PedidoPendiente[]>
  /** Filas de los lotes del courier recibidos hasta `hasta` (más recientes primero). */
  filasLote(courier: Courier, hasta: string): Promise<FilaLote[]>
  /** ctwa_clid del último mensaje entrante del cliente que vino de un anuncio, dentro de la ventana. */
  origenAnuncio(clienteId: string, desde: string, hasta: string): Promise<OrigenAnuncio | null>
  actualizar(orderId: number, cambios: CambiosPedido): Promise<void>
  marcarPagado(orderId: number): Promise<{ ok: boolean; error?: string; ya_pagado?: boolean }>
  enviarCapi(p: PedidoPendiente, origen: OrigenAnuncio | null): Promise<ResultadoCapi>
  agregarTags(orderId: number, tags: string[]): Promise<{ ok: boolean; error?: string }>
  avisar(texto: string): Promise<{ ok: boolean; error?: string }>
  /** factura/io.ts facturarPedidoEntregado (idempotente). Solo con cfg.facturaActiva. Opcional. */
  facturar?(orderId: number): Promise<{ accion: string; error?: string }>
}

export interface ConfigPostEntrega {
  ahora: Date
  prefijos: Record<Courier, string[]>
  normalizarTelefono: (x: string) => string | null
  limite: number
  maxIntentos: number
  avisoTras: number
  ventanaCtwaDias: number
  simuladoShopify: boolean
  /** config_wa['ola4.factura'].activo: factura electrónica al quedar ENTREGADO. */
  facturaActiva?: boolean
}

export interface ResumenPostEntrega {
  revisados: number
  fechas_guardadas: number
  fechas_de_courier: number
  pagados: number
  capi_enviados: number
  capi_simulados: number
  capi_omitidos: number
  con_anuncio: number
  errores: number
  avisos: number
  detalle_errores: string[]
}

// ─── Fecha real de entrega ────────────────────────────────────────────────

export function courierDeFuente(fuente: string | null): Courier | null {
  const m = /^courier_(lucero|pap)$/.exec(fuente ?? '')
  return m ? (m[1] as Courier) : null
}

/** Número del pedido sin '#': '#1001' → '1001'. */
export function numeroPedido(nombre: string | null): string | null {
  const d = String(nombre ?? '').replace(/^#/, '').trim()
  return /^\d+$/.test(d) ? String(parseInt(d, 10)) : null
}

/**
 * Busca, en las filas del lote, la de este pedido con estado ENTREGADO y devuelve su
 * fecha (YYYY-MM-DD). Primero por número de pedido; si no, por teléfono (solo si hay
 * una única fila entregada con ese teléfono, para no adivinar).
 */
export function fechaRealDesdeFilas(
  filas: FilaLote[],
  pedido: Pick<PedidoPendiente, 'nombre' | 'telefono'>,
  courier: Courier,
  prefijos: string[],
  normalizarTelefono: (x: string) => string | null,
): string | null {
  const num = numeroPedido(pedido.nombre)
  const entregadas = filas.filter((f) =>
    traducirEstado(courier, f.estado_crudo, { rendido: f.extra?.rendido === true }) === 'ENTREGADO' && fechaISO(f.fecha)
  )
  if (num) {
    const porNumero = entregadas.find((f) => numeroDesdeReferencia(String(f.referencia ?? ''), prefijos).numero === num)
    if (porNumero) return fechaISO(porNumero.fecha)
  }
  if (pedido.telefono) {
    const porTel = entregadas.filter((f) => f.telefono && normalizarTelefono(String(f.telefono)) === pedido.telefono)
    if (porTel.length === 1) return fechaISO(porTel[0].fecha)
  }
  return null
}

/**
 * El courier da solo el día. Se toma el mediodía de Asunción (UTC−3) de ese día,
 * sin pasar la hora en que se importó (la entrega no puede ser posterior a la importación).
 */
export function entregadoEnDesdeFecha(fecha: string, registradoEn: string): string {
  const mediodia = new Date(`${fecha}T12:00:00-03:00`)
  const reg = new Date(registradoEn)
  return (mediodia.getTime() > reg.getTime() ? reg : mediodia).toISOString()
}

const msj = (e: unknown) => (e instanceof Error ? e.message : String(e))

// ─── Proceso ──────────────────────────────────────────────────────────────

export async function procesarPostEntrega(repo: Repo, cfg: ConfigPostEntrega): Promise<ResumenPostEntrega> {
  const r: ResumenPostEntrega = {
    revisados: 0, fechas_guardadas: 0, fechas_de_courier: 0, pagados: 0, capi_enviados: 0,
    capi_simulados: 0, capi_omitidos: 0, con_anuncio: 0, errores: 0, avisos: 0, detalle_errores: [],
  }
  const lista = await repo.pendientes(cfg.limite, cfg.maxIntentos)
  const cacheLotes = new Map<string, FilaLote[]>()

  for (const p of lista) {
    r.revisados++
    const cambios: CambiosPedido = {}
    const fallas: string[] = []
    const etiqueta = p.nombre ?? String(p.shopify_order_id)

    // 1. Fecha real de entrega.
    let entregadoEn = p.entregado_en
    if (!entregadoEn) {
      try {
        const courier = courierDeFuente(p.entregado_fuente_estado)
        let fecha: string | null = null
        if (courier) {
          const clave = `${courier}|${p.entregado_registrado_en}`
          let filas = cacheLotes.get(clave)
          if (!filas) {
            filas = await repo.filasLote(courier, p.entregado_registrado_en)
            cacheLotes.set(clave, filas)
          }
          fecha = fechaRealDesdeFilas(filas, p, courier, cfg.prefijos[courier] ?? [], cfg.normalizarTelefono)
        }
        entregadoEn = fecha ? entregadoEnDesdeFecha(fecha, p.entregado_registrado_en) : p.entregado_registrado_en
        cambios.entregado_en = entregadoEn
        cambios.entregado_fuente = fecha ? 'courier' : 'importacion'
        r.fechas_guardadas++
        if (fecha) r.fechas_de_courier++
      } catch (e) {
        fallas.push(`fecha: ${msj(e)}`)
        entregadoEn = p.entregado_registrado_en
      }
    }

    // 2. Pagado en Shopify (una vez).
    if (!p.pagado_marcado && !cfg.simuladoShopify) {
      try {
        const pago = await repo.marcarPagado(p.shopify_order_id)
        if (pago.ok) {
          cambios.pagado_marcado = true
          r.pagados++
        } else fallas.push(`pagado: ${pago.error ?? 'error'}`)
      } catch (e) {
        fallas.push(`pagado: ${msj(e)}`)
      }
    }

    // 2b. Factura electrónica (ola 4). Su falla no frena ni reintenta el resto: la reintenta el cron de factura.
    if (cfg.facturaActiva && repo.facturar) {
      try {
        const f = await repo.facturar(p.shopify_order_id)
        if (f.accion === 'error' || f.accion === 'revisar') {
          r.detalle_errores.push(`${etiqueta} factura (${f.accion}): ${f.error ?? 'sin detalle'}`)
        }
      } catch (e) {
        r.detalle_errores.push(`${etiqueta} factura: ${msj(e)}`)
      }
    }

    // 3. Conversions API (una vez).
    if (!p.capi_enviado && !p.capi_omitido) {
      if ((p.tags ?? []).includes(TAG_CAPI)) {
        // Ya se mandó en una corrida anterior (la base perdió la marca): no se repite.
        cambios.capi_enviado = true
      } else if (!dentroDePlazo(entregadoEn, cfg.ahora)) {
        cambios.capi_omitido = 'fuera_de_plazo_7_dias'
        r.capi_omitidos++
      } else {
        try {
          let origen: OrigenAnuncio | null = null
          if (p.cliente_id) {
            const hasta = p.creado_en ?? entregadoEn ?? cfg.ahora.toISOString()
            const desde = new Date(new Date(hasta).getTime() - cfg.ventanaCtwaDias * 86_400_000).toISOString()
            origen = await repo.origenAnuncio(p.cliente_id, desde, hasta)
          }
          if (origen) r.con_anuncio++
          const res = await repo.enviarCapi({ ...p, entregado_en: entregadoEn }, origen)
          if (res.simulado) {
            r.capi_simulados++
          } else if (res.ok) {
            cambios.capi_enviado = true
            r.capi_enviados++
            const t = await repo.agregarTags(p.shopify_order_id, [TAG_CAPI])
            // El evento ya salió: el tag es solo una marca extra, su falla no reintenta el envío.
            if (!t.ok) r.detalle_errores.push(`${etiqueta} tag ${TAG_CAPI}: ${t.error ?? 'error'}`)
          } else {
            const partes = [
              res.principal.ok ? null : `principal: ${res.principal.error ?? 'error'}`,
              res.mensajeria.ok ? null : `mensajería: ${res.mensajeria.error ?? 'error'}`,
            ].filter(Boolean)
            fallas.push(`capi: ${partes.join('; ')}`)
          }
        } catch (e) {
          fallas.push(`capi: ${msj(e)}`)
        }
      }
    }

    // 4. Errores y aviso.
    if (fallas.length) {
      r.errores++
      const intentos = (p.post_entrega_intentos ?? 0) + 1
      const texto = fallas.join(' | ').slice(0, 500)
      cambios.post_entrega_intentos = intentos
      cambios.post_entrega_ultimo_error = texto
      r.detalle_errores.push(`${etiqueta}: ${texto}`)
      if (intentos === cfg.avisoTras) {
        const a = await repo.avisar(
          `⚠️ Post-entrega del pedido ${escapar(etiqueta)} falló ${intentos} veces.\n${escapar(texto)}\n` +
            `Se sigue reintentando cada 30 min (máximo ${cfg.maxIntentos} intentos).`,
        )
        if (a.ok) r.avisos++
      }
    } else {
      if (p.post_entrega_intentos > 0) cambios.post_entrega_ultimo_error = null
      cambios.post_entrega_procesado_en = cfg.ahora.toISOString()
    }

    if (Object.keys(cambios).length) {
      try {
        await repo.actualizar(p.shopify_order_id, cambios)
      } catch (e) {
        r.detalle_errores.push(`${etiqueta} guardar: ${msj(e)}`)
      }
    }
  }
  return r
}

function escapar(s: string): string {
  return s.replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;')
}
