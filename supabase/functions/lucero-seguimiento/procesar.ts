// supabase/functions/lucero-seguimiento/procesar.ts · Dueño: W (09-10-2026)
// ═══════════════════════════════════════════════════════════
// Seguimiento automático de Lucero del Este para pedidos de Voltra (VT-…).
// Lógica pura: todo el I/O entra por `Deps` (io.ts), así se prueba con dobles.
//
// Fuente: la página PÚBLICA https://www.luceroexpress.com.py/envio.php?id=<EnvioID>
// (sin login; verificada el 09-10-2026). Muestra Referencia (nuestro código, p. ej.
// VT-1003), Empresa, Estado (badge: 'entregado', 'en_camino'…) y un historial con la
// fecha de cada estado ('2026-10-07 13:05'). La búsqueda pública por NUESTRA
// referencia (seguimiento.php?codigo=) NO encuentra los códigos VT-: el EnvioID es
// obligatorio y sale del export de Lucero (entregas.guia_transportadora).
//
// Por cada guía abierta (máx. `tope` por corrida, `pausa_ms` entre consultas):
//   1. consulta la página y la parsea; si no encuentra el estado NO inventa nada:
//      cuenta 'sin_parsear'.
//   2. si la Referencia de la página no es la de la guía → no se toca nada.
//   3. arma una FilaCourier y la pasa por el pipeline común (importar-courier/procesar.ts
//      → pedido_estados → post-entrega), igual que al importar el Excel.
//   4. actualiza `entregas` con la precedencia acordada: manda el courier, un estado
//      terminal no se degrada y una fila con vinculo_metodo='manual' no se pisa.
// Si más de la mitad de las consultas de una corrida falla → UN aviso por Telegram.
// ═══════════════════════════════════════════════════════════
import type { FilaCourier, Resumen } from '../importar-courier/procesar.ts'

export interface ConfigSeguimiento {
  /** Máximo de guías consultadas por corrida. */
  tope: number
  /** Pausa entre una consulta y la siguiente (≥ 3000 ms). */
  pausa_ms: number
}

export const CONFIG_DEFECTO: ConfigSeguimiento = { tope: 30, pausa_ms: 3000 }
export const PAUSA_MINIMA_MS = 3000
export const TOPE_MAXIMO = 40

export function normalizarConfig(c: Partial<ConfigSeguimiento> | null | undefined): ConfigSeguimiento {
  const tope = Math.floor(Number(c?.tope ?? CONFIG_DEFECTO.tope))
  const pausa = Math.floor(Number(c?.pausa_ms ?? CONFIG_DEFECTO.pausa_ms))
  return {
    tope: Number.isFinite(tope) && tope > 0 ? Math.min(tope, TOPE_MAXIMO) : CONFIG_DEFECTO.tope,
    pausa_ms: Number.isFinite(pausa) ? Math.max(pausa, PAUSA_MINIMA_MS) : CONFIG_DEFECTO.pausa_ms,
  }
}

/** Fila de `entregas` candidata (Lucero, Voltra, con EnvioID y sin estado terminal). */
export interface GuiaAbierta {
  nro_guia_pap: string
  n_referencia: string | null
  envio_id: string
  categoria: string | null
  estado_pap: string | null
  vinculo_metodo: string | null
  importe: number | null
}

export interface PaginaLucero {
  status: number
  html: string
}

export interface Deps {
  guiasAbiertas(tope: number): Promise<GuiaAbierta[]>
  consultar(envioId: string): Promise<PaginaLucero>
  esperar(ms: number): Promise<void>
  /** Guarda el lote en eventos_crudos (post-entrega lee de ahí la fecha real de entrega). */
  guardarLote(filas: FilaCourier[]): Promise<void>
  /** procesarFilas('lucero', filas, repo real, cfg real). */
  procesarFilas(filas: FilaCourier[]): Promise<Resumen>
  /** Update condicionado (no terminal y no manual). true si cambió una fila. */
  actualizarEntrega(nroGuia: string, cambios: CambiosEntrega): Promise<boolean>
  marcarConsultada(nroGuia: string, error: string | null): Promise<void>
  avisar(texto: string): Promise<void>
}

// ─── Parseo de la página ────────────────────────────────────
export const ESTADOS_LUCERO = [
  'borrador', 'cargado', 'preparando', 'aceptado', 'empaquetado', 'en_camino',
  'fallido', 'entregado', 'devuelto', 'cancelado',
] as const

export interface PasoHistorial {
  estado: string
  fecha: string | null
}

export type Parseo =
  | {
    tipo: 'ok'
    referencia: string
    empresa: string
    /** Como viene en el badge: 'entregado', 'en_camino'. */
    estado: string
    /** Como lo escribe Lucero en su export: 'Entregado', 'En camino'. */
    estado_crudo: string
    /** 'YYYY-MM-DD HH:MM' del estado actual, o null si la página no la trae. */
    fecha: string | null
    historial: PasoHistorial[]
  }
  | { tipo: 'no_encontrado' }
  | { tipo: 'sin_parsear'; motivo: string }

const texto = (s: string) =>
  s.replace(/<[^>]+>/g, ' ').replace(/&nbsp;/g, ' ').replace(/&amp;/g, '&').replace(/\s+/g, ' ').trim()

const FECHA_RE = /^(\d{4}-\d{2}-\d{2})(?: (\d{2}:\d{2}))?/

function fechaValida(s: string | null | undefined): string | null {
  const m = String(s ?? '').trim().match(FECHA_RE)
  return m ? (m[2] ? `${m[1]} ${m[2]}` : m[1]) : null
}

function campoKV(html: string, clave: string): string | null {
  const re = new RegExp(`<div class="k">\\s*${clave}\\s*</div>\\s*<div class="v">([\\s\\S]*?)</div>`, 'i')
  const m = html.match(re)
  return m ? texto(m[1]) : null
}

export function estadoCrudo(badge: string): string {
  const t = badge.replace(/_/g, ' ').trim()
  return t ? t[0].toUpperCase() + t.slice(1) : t
}

export function parsearPagina(html: string): Parseo {
  if (/No se encontr[óo] el env[íi]o solicitado/i.test(html)) return { tipo: 'no_encontrado' }
  const estadoTxt = campoKV(html, 'Estado')
  if (!estadoTxt) return { tipo: 'sin_parsear', motivo: 'sin_campo_estado' }
  const estado = estadoTxt.toLowerCase().replace(/\s+/g, '_')
  if (!(ESTADOS_LUCERO as readonly string[]).includes(estado)) {
    return { tipo: 'sin_parsear', motivo: `estado_desconocido:${estado.slice(0, 40)}` }
  }
  const referencia = campoKV(html, 'Referencia') ?? ''
  if (!referencia) return { tipo: 'sin_parsear', motivo: 'sin_referencia' }
  const empresa = campoKV(html, 'Empresa') ?? ''

  // Historial (lista): cada fila trae label, fecha ('—' si no pasó) y badge.
  const historial: PasoHistorial[] = []
  let fechaActual: string | null = null
  const filaRe = /<div class="tl-row([^"]*)">([\s\S]*?)(?=<div class="tl-row|<!--|$)/g
  for (const m of html.matchAll(filaRe)) {
    const clases = m[1]
    const cuerpo = m[2]
    const badge = cuerpo.match(/class="badge">([\s\S]*?)</)
    const fecha = cuerpo.match(/class="tl-date">([\s\S]*?)</)
    if (!badge) continue
    const est = texto(badge[1]).toLowerCase()
    const f = fechaValida(fecha ? texto(fecha[1]) : null)
    historial.push({ estado: est, fecha: f })
    if (/\bcurrent\b/.test(clases) && est === estado) fechaActual = f
  }
  if (!fechaActual) fechaActual = historial.find((p) => p.estado === estado && p.fecha)?.fecha ?? null

  return { tipo: 'ok', referencia, empresa, estado, estado_crudo: estadoCrudo(estado), fecha: fechaActual, historial }
}

// ─── Referencias ────────────────────────────────────────────
/** 'VT-1003' / 'vt 01003' / '#VT1003' → 'VT-1003'; cualquier otra cosa → null. */
export function refVoltra(ref: string | null | undefined): string | null {
  const m = String(ref ?? '').trim().match(/^#?\s*VT\s*[-\s]?\s*0*(\d+)$/i)
  return m ? `VT-${parseInt(m[1], 10)}` : null
}

// ─── Entregas ───────────────────────────────────────────────
/** Mismo criterio que categoriaLucero() de src/lib/exportLucero.js (export EN VIVO: fallido es reintentable). */
export function categoriaLucero(estado: string): string {
  if (estado === 'entregado') return 'entregado'
  if (estado === 'devuelto' || estado === 'cancelado') return 'devuelto'
  if (estado === 'borrador') return 'no_despachado'
  return 'en_proceso'
}

export const CATEGORIAS_TERMINALES = new Set(['entregado', 'devuelto'])

export interface CambiosEntrega {
  estado_pap: string
  categoria: string
  fecha_entrega?: string
  cobrado?: number
}

/** null = no se toca la fila (manual, terminal o sin cambios). */
export function cambiosEntrega(g: GuiaAbierta, p: Extract<Parseo, { tipo: 'ok' }>): CambiosEntrega | null {
  if (g.vinculo_metodo === 'manual') return null
  if (CATEGORIAS_TERMINALES.has(g.categoria ?? '')) return null
  const categoria = categoriaLucero(p.estado)
  const c: CambiosEntrega = { estado_pap: p.estado_crudo, categoria }
  if (categoria === 'entregado') {
    if (p.fecha) c.fecha_entrega = p.fecha.slice(0, 10)
    c.cobrado = g.importe ?? 0
  }
  if (g.estado_pap === c.estado_pap && g.categoria === c.categoria && !c.fecha_entrega) return null
  return c
}

export function filaCourier(ref: string, envioId: string, p: Extract<Parseo, { tipo: 'ok' }>): FilaCourier {
  return {
    referencia: ref,
    estado_crudo: p.estado_crudo,
    telefono: '',
    fecha: p.fecha,
    // rendido:false → no se afirma nada sobre la plata (la página no lo muestra).
    extra: { envio_id: envioId, rendido: false, fuente_web: 'envio.php' },
  }
}

// ─── Corrida ────────────────────────────────────────────────
export interface ResumenSeguimiento {
  candidatas: number
  consultadas: number
  ok: number
  sin_parsear: number
  no_encontrado: number
  error_red: number
  referencia_distinta: number
  entregas_actualizadas: number
  entregas_protegidas: number
  aviso_enviado: boolean
  pipeline: Resumen | null
  motivos: string[]
}

/** Guías que se consultan antes de guardar sus estados (tanda chica: poco que perder si se corta). */
export const TANDA = 5

/** Suma los resúmenes del pipeline de cada tanda en uno solo. */
export function sumarResumen(a: Resumen, b: Resumen): Resumen {
  return {
    procesadas: a.procesadas + b.procesadas,
    avisos_programados: a.avisos_programados + b.avisos_programados,
    sin_pedido: a.sin_pedido + b.sin_pedido,
    repetidas: a.repetidas + b.repetidas,
    estado_no_reconocido: a.estado_no_reconocido + b.estado_no_reconocido,
    estados_no_reconocidos: [...new Set([...a.estados_no_reconocidos, ...b.estados_no_reconocidos])],
    otra_tienda: a.otra_tienda + b.otra_tienda,
    cancelados_cliente: a.cancelados_cliente + b.cancelados_cliente,
    errores: [...a.errores, ...b.errores],
  }
}

export async function correrSeguimiento(deps: Deps, cfgIn: Partial<ConfigSeguimiento> = {}): Promise<ResumenSeguimiento> {
  const cfg = normalizarConfig(cfgIn)
  const r: ResumenSeguimiento = {
    candidatas: 0, consultadas: 0, ok: 0, sin_parsear: 0, no_encontrado: 0, error_red: 0,
    referencia_distinta: 0, entregas_actualizadas: 0, entregas_protegidas: 0, aviso_enviado: false,
    pipeline: null, motivos: [],
  }
  const motivos = new Set<string>()
  const guias = (await deps.guiasAbiertas(cfg.tope)).slice(0, cfg.tope)
  r.candidatas = guias.length
  // Se guarda de a TANDA guías: si la Edge Function se corta por tiempo, lo ya consultado no se pierde.
  // marcarConsultada va DESPUÉS de guardar: una guía cortada a mitad de tanda sigue primera en la cola.
  // Reprocesar una guía no duplica avisos (pedido_estados es idempotente por pedido+estado).
  let filas: FilaCourier[] = []
  let actualizar: { guia: GuiaAbierta; cambios: CambiosEntrega }[] = []
  let marcas: { nro: string; error: string | null }[] = []
  const volcar = async () => {
    // Pipeline común primero (pedido_estados → post-entrega), después la tabla de entregas.
    if (filas.length) {
      await deps.guardarLote(filas)
      const res = await deps.procesarFilas(filas)
      r.pipeline = r.pipeline ? sumarResumen(r.pipeline, res) : res
    }
    for (const { guia, cambios } of actualizar) {
      try {
        if (await deps.actualizarEntrega(guia.nro_guia_pap, cambios)) r.entregas_actualizadas++
      } catch (e) {
        motivos.add(`entregas:${String((e as Error)?.message ?? e).slice(0, 80)}`)
      }
    }
    for (const m of marcas) await deps.marcarConsultada(m.nro, m.error)
    filas = []
    actualizar = []
    marcas = []
  }

  for (let i = 0; i < guias.length; i++) {
    const g = guias[i]
    if (i > 0) await deps.esperar(cfg.pausa_ms)
    r.consultadas++
    let error: string | null = null
    try {
      const pag = await deps.consultar(g.envio_id)
      if (pag.status !== 200) {
        r.error_red++
        error = `http_${pag.status}`
      } else {
        const p = parsearPagina(pag.html)
        if (p.tipo === 'no_encontrado') {
          r.no_encontrado++
          error = 'no_encontrado'
        } else if (p.tipo === 'sin_parsear') {
          r.sin_parsear++
          error = `sin_parsear:${p.motivo}`
        } else {
          const esperado = refVoltra(g.n_referencia)
          const enPagina = refVoltra(p.referencia)
          if (!esperado || esperado !== enPagina) {
            r.referencia_distinta++
            error = 'referencia_distinta'
          } else {
            r.ok++
            filas.push(filaCourier(esperado, g.envio_id, p))
            const c = cambiosEntrega(g, p)
            if (c) actualizar.push({ guia: g, cambios: c })
            else if (g.vinculo_metodo === 'manual') r.entregas_protegidas++
          }
        }
      }
    } catch (e) {
      r.error_red++
      error = `error_red:${(e as Error)?.message ?? String(e)}`.slice(0, 200)
    }
    if (error) motivos.add(error.split(':').slice(0, 2).join(':'))
    marcas.push({ nro: g.nro_guia_pap, error })
    if (marcas.length >= TANDA) await volcar()
  }
  await volcar()

  r.motivos = [...motivos]
  const fallas = r.sin_parsear + r.error_red + r.no_encontrado + r.referencia_distinta
  if (r.consultadas > 0 && fallas * 2 > r.consultadas) {
    await deps.avisar(
      `<b>Seguimiento Lucero: falló ${fallas} de ${r.consultadas} consultas</b>\n` +
        `Sin parsear: ${r.sin_parsear} · Error de red: ${r.error_red} · No encontrado: ${r.no_encontrado} · ` +
        `Referencia distinta: ${r.referencia_distinta}\n` +
        `Motivos: ${r.motivos.join(', ').replace(/[<>&]/g, '') || '—'}\n` +
        `Si es "sin_parsear", la página de Lucero cambió de formato: revisar lucero-seguimiento/procesar.ts.`,
    )
    r.aviso_enviado = true
  }
  return r
}
