// supabase/functions/pap-sync/logica.ts
// ═══════════════════════════════════════════════════════════
// Lógica PURA del sincronizador de Punto a Punto (sin red, sin base, sin Deno.env).
//
// El panel de rastreo de PaP (rastreo.puntoapunto.com.py) es una app Angular sobre
// ASP.NET Boilerplate (ABP). Inspección pública del 09-10-2026 en docs/pap-panel-inspeccion.md:
//   · login:     POST {base}/api/TokenAuth/Authenticate  {userNameOrEmailAddress, password, rememberClient}
//                → {result:{accessToken, expireInSeconds, ...}} (JWT, se manda como Bearer)
//   · Gestión:   POST {base}/api/services/app/PortalReportService/ListGestionToXls   (ConsultaGestionInputDto)
//   · Paquetes:  POST {base}/api/services/app/PortalReportService/ListPaqueteMensajeroToXLS (PaqueteByMensajeroInput)
//   Ambos reportes devuelven el .xlsx armado por el servidor (los mismos archivos que Enrique baja a mano).
//
// El parseo replica lo mínimo de src/lib/importarPaP.js (combinar) y de
// src/lib/importarCourierWA.js (filasDesdePaP + armarPayloadCourier): misma prioridad
// (Paquete manda en el estado, Gestión aporta teléfono/fechas/tesorería), solo referencias VT-.
// Si cambia una regla allá, cambiarla acá (src/ no se puede importar desde Deno: usa imports sin extensión).
// ═══════════════════════════════════════════════════════════
import type { FilaCourier } from '../importar-courier/procesar.ts'

export const BASE_PAP = 'https://rastreo.puntoapunto.com.py/trackerservices'

export const RUTAS_PAP = {
  login: '/api/TokenAuth/Authenticate',
  gestion: '/api/services/app/PortalReportService/ListGestionToXls',
  paquetes: '/api/services/app/PortalReportService/ListPaqueteMensajeroToXLS',
} as const

export type TipoReporte = 'gestion' | 'paquetes'

/** Columnas sin las cuales el cruce no sirve (vistas en los Excel bajados a mano, jul-ago 2026). */
export const COLUMNAS_REQUERIDAS: Record<TipoReporte, string[]> = {
  gestion: ['NroGuia', 'NroGuiaRef', 'Estado', 'Motivo', 'Telefono', 'FechaIng', 'FechaEnt', 'Recurso', 'EstadoDepTesor'],
  paquetes: ['NroGuia', 'NroGuiaRef', 'Estado', 'Motivo', 'FechaEvento', 'Fecha Ingreso'],
}

/** El panel rechaza rangos de Gestión mayores a 60 días ("Rango Maximo: 2 Meses"). */
export const DIAS_MAX = 60
export const DIAS_POR_DEFECTO = 30

// ─── Fechas ────────────────────────────────────────────────
// Paraguay es UTC-3 todo el año (sin horario de verano desde oct-2024).
const OFFSET_ASU_MS = 3 * 3_600_000

/** Fecha calendario de Asunción 'YYYY-MM-DD' de un instante. */
export function fechaAsuncion(d: Date): string {
  return new Date(d.getTime() - OFFSET_ASU_MS).toISOString().slice(0, 10)
}

/**
 * Rango que se pide a PaP: desde las 00:00 de Asunción de hace `dias` días hasta ahora.
 * El navegador manda moment(...).toISOString(): mismo formato ISO en UTC.
 */
export function rangoFechas(ahora: Date, dias = DIAS_POR_DEFECTO): { desde: string; hasta: string } {
  const n = Math.min(Math.max(Math.trunc(dias) || DIAS_POR_DEFECTO, 1), DIAS_MAX)
  const hoy = fechaAsuncion(ahora)
  const inicio = new Date(`${hoy}T03:00:00.000Z`) // 00:00 en Asunción
  inicio.setUTCDate(inicio.getUTCDate() - n)
  return { desde: inicio.toISOString(), hasta: ahora.toISOString() }
}

// ─── Cuerpos de los pedidos (los mismos campos que manda el panel) ──
export function cuerpoLogin(usuario: string, clave: string) {
  return { userNameOrEmailAddress: usuario, password: clave, rememberClient: false }
}

/** Reporte de Gestión: por fecha de INGRESO, con "Incluir Tesorería" (trae EstadoDepTesor = rendido). */
export function cuerpoGestion(r: { desde: string; hasta: string }) {
  return { fechaIngDesde: r.desde, fechaIngHasta: r.hasta, filtros: [] as string[], incluirTesoreria: true }
}

/** Reporte de Paquetes ("mensajeros"): por fecha de ENTREGA/evento. */
export function cuerpoPaquetes(r: { desde: string; hasta: string }) {
  return { fechaEnt: r.desde, fechaEntHasta: r.hasta }
}

// ─── Clasificar respuestas ─────────────────────────────────
export type TipoLogin = 'ok' | 'credenciales' | 'bloqueado' | 'servidor'

export interface ResultadoLogin {
  tipo: TipoLogin
  token?: string
  expiraEnSeg?: number
  status?: number
  /** Texto corto para el registro. NUNCA incluye usuario ni clave. */
  detalle: string
}

// deno-lint-ignore no-explicit-any
type Json = any

function parsearJson(texto: string): Json | null {
  try { return JSON.parse(texto) } catch { return null }
}

/**
 * ABP envuelve las respuestas: {result:{accessToken,...}, success, error, __abp}.
 * Un login con clave mala en la plantilla ABP Zero es una UserFriendlyException
 * ("Login failed!" / "Invalid user name or password") → HTTP 500 con __abp y error.
 */
export function clasificarLogin(status: number, texto: string): ResultadoLogin {
  const j = parsearJson(texto)
  const r = j?.result ?? j
  const token = typeof r?.accessToken === 'string' && r.accessToken.length > 20 ? r.accessToken : null
  if (status === 200 && token) {
    return { tipo: 'ok', token, expiraEnSeg: Number(r?.expireInSeconds) || undefined, status, detalle: 'ok' }
  }
  const msg = [j?.error?.message, j?.error?.details].filter(Boolean).join(' · ').slice(0, 200)
  if (/bloquead|locked|lockout/i.test(msg)) return { tipo: 'bloqueado', status, detalle: msg || 'usuario bloqueado' }
  if (status === 401 || status === 403) return { tipo: 'credenciales', status, detalle: msg || `HTTP ${status}` }
  if (j?.__abp && j?.error) {
    // Error "amistoso" de ABP en el login = usuario/clave/tenant rechazados.
    if (/login|usuario|user|password|contrase|clave|tenant|inactiv/i.test(msg)) {
      return { tipo: 'credenciales', status, detalle: msg }
    }
    return { tipo: 'servidor', status, detalle: msg || `HTTP ${status}` }
  }
  if (status === 200) return { tipo: 'servidor', status, detalle: 'login 200 sin accessToken (¿cambió el formato?)' }
  return { tipo: 'servidor', status, detalle: `HTTP ${status}` }
}

export type TipoDescarga = 'ok' | 'sesion' | 'endpoint' | 'formato' | 'servidor'

export interface ResultadoDescarga {
  tipo: TipoDescarga
  bytes?: Uint8Array
  status?: number
  detalle: string
}

/** Un .xlsx es un ZIP: empieza con 'PK\x03\x04'. */
export function esXlsx(b: Uint8Array | undefined | null): boolean {
  return !!b && b.length > 4 && b[0] === 0x50 && b[1] === 0x4b && b[2] === 0x03 && b[3] === 0x04
}

export function clasificarDescarga(status: number, bytes: Uint8Array): ResultadoDescarga {
  if (status === 200 && esXlsx(bytes)) return { tipo: 'ok', bytes, status, detalle: `${bytes.length} bytes` }
  if (status === 401 || status === 403) return { tipo: 'sesion', status, detalle: `HTTP ${status}` }
  if (status === 404 || status === 405) return { tipo: 'endpoint', status, detalle: `HTTP ${status}: la ruta del reporte ya no existe` }
  if (status === 200) {
    const inicio = new TextDecoder().decode(bytes.slice(0, 120)).replace(/\s+/g, ' ')
    return { tipo: 'formato', status, detalle: `HTTP 200 pero no es un Excel (empieza con "${inicio.slice(0, 60)}")` }
  }
  return { tipo: 'servidor', status, detalle: `HTTP ${status}` }
}

// ─── Formato del Excel ─────────────────────────────────────
export function detectarTipo(headers: string[]): TipoReporte | 'desconocido' {
  if (headers.includes('FechaEnt') || headers.includes('Recurso')) return 'gestion'
  if (headers.includes('Recibido Por') || headers.includes('FechaGestion')) return 'paquetes'
  return 'desconocido'
}

/** Firma del formato: las columnas en orden. Si cambia, PaP tocó el reporte. */
export function firmaFormato(headers: string[]): string {
  return headers.map((h) => String(h).trim()).join('|')
}

export function columnasFaltantes(tipo: TipoReporte, headers: string[]): string[] {
  const set = new Set(headers.map((h) => String(h).trim()))
  return COLUMNAS_REQUERIDAS[tipo].filter((c) => !set.has(c))
}

// ─── Referencias y teléfonos (copia mínima de src/lib/referencias.js) ──
/** 'VT-1003' / '#vt1003' / 'VT-01003' → 'VT-1003'; cualquier otra cosa → null. */
export function refVoltra(ref: unknown): string | null {
  const m = String(ref ?? '').trim().match(/^#?\s*VT\s*[-\s]?\s*0*(\d+)$/i)
  return m ? `VT-${parseInt(m[1], 10)}` : null
}

function limpiarTel(tel: unknown): string {
  return String(tel ?? '').replace(/[^\d+]/g, '')
}

/** Igual que toISODate de importarPaP.js. */
export function aFechaISO(v: unknown): string | null {
  if (!v) return null
  if (v instanceof Date && !isNaN(v.getTime())) return v.toISOString().split('T')[0]
  if (typeof v === 'string') {
    const m = v.match(/(\d{2})\/(\d{2})\/(\d{4})/)
    if (m) return `${m[3]}-${m[2]}-${m[1]}`
    if (/^\d{4}-\d{2}-\d{2}/.test(v)) return v.split('T')[0].split(' ')[0]
  }
  return null
}

type Fila = Record<string, unknown>
const txt = (v: unknown) => (v == null ? '' : String(v))

/**
 * combinar() + filasDesdePaP() + armarPayloadCourier() en un paso:
 * cruza Paquetes y Gestión por NroGuia y devuelve SOLO las filas de pedidos de Voltra (VT-),
 * sin repetidas (misma referencia + estado + rendido). Nada de nombre ni dirección del cliente.
 */
export function combinarAFilas(paquetes: Fila[], gestion: Fila[]): FilaCourier[] {
  const pmap = new Map<string, Fila>()
  const gmap = new Map<string, Fila>()
  for (const r of paquetes) pmap.set(txt(r['NroGuia']), r)
  for (const r of gestion) gmap.set(txt(r['NroGuia']), r)

  const vistos = new Set<string>()
  const out: FilaCourier[] = []
  for (const guia of new Set([...pmap.keys(), ...gmap.keys()])) {
    if (!guia || guia === 'undefined') continue
    const p = pmap.get(guia)
    const g = gmap.get(guia)
    const ref = refVoltra((p && p['NroGuiaRef']) ? p['NroGuiaRef'] : (g ? g['NroGuiaRef'] : ''))
    if (!ref) continue // Facial Wellness u otra cosa: no se manda (ver importarCourierWA.js)

    const estado = txt((p && p['Estado']) ? p['Estado'] : (g ? g['Estado'] : '')).trim()
    const motivo = txt((p && p['Motivo']) || (g && g['Motivo']) || '')
    const importe = parseInt(txt(p ? p['Importe'] : g?.['Importe']) || '0', 10) || 0
    const fIng = aFechaISO(g ? g['FechaIng'] : (p ? p['Fecha Ingreso'] : null))
    const fEnt = aFechaISO(g ? g['FechaEnt'] : (p ? p['FechaEvento'] : null))
    const rendido = txt(g ? g['EstadoDepTesor'] : '') === 'Rendido Tesorero'
    const fRendido = aFechaISO(g ? g['FechaDepositoTesoreroCliente'] : null)

    const k = `${ref}|${estado}|${rendido}`
    if (vistos.has(k)) continue
    vistos.add(k)
    out.push({
      referencia: ref,
      estado_crudo: estado,
      telefono: limpiarTel(g ? g['Telefono'] : ''),
      fecha: fEnt || fIng || null,
      extra: {
        nro_guia: guia,
        rendido,
        fecha_rendido: fRendido,
        motivo,
        importe,
        ruta_asignada: !!txt(g ? g['Recurso'] : ''),
      },
    })
  }
  return out
}

// ─── Estado del sincronizador (tabla pap_sync_estado, una fila) ──
export interface EstadoSync {
  activo: boolean
  fallos_login: number
  frenado: boolean
  errores_seguidos: number
  aviso_errores_enviado: boolean
  firma_gestion: string | null
  firma_paquetes: string | null
  ultimo_ok_en: string | null
}

export const ESTADO_INICIAL: EstadoSync = {
  activo: true,
  fallos_login: 0,
  frenado: false,
  errores_seguidos: 0,
  aviso_errores_enviado: false,
  firma_gestion: null,
  firma_paquetes: null,
  ultimo_ok_en: null,
}

/** Logins fallidos seguidos que frenan el sync. PaP bloquea la cuenta a los 5 (300 s). */
export const MAX_FALLOS_LOGIN = 2
/** Errores de red/servidor seguidos antes de avisar (una vez). */
export const MAX_ERRORES_SEGUIDOS = 3
/** Criterio de abandono de Enrique: el panel cambia más de 2 veces en 3 meses. */
export const VENTANA_CAMBIOS_DIAS = 90
export const MAX_CAMBIOS_EN_VENTANA = 2

export interface Transicion {
  estado: EstadoSync
  aviso: string | null
}

/** Después de un intento de login: cuenta fallos y frena al segundo seguido (avisa UNA vez). */
export function trasLogin(e: EstadoSync, r: ResultadoLogin): Transicion {
  if (r.tipo === 'ok') {
    return { estado: { ...e, fallos_login: 0, frenado: false }, aviso: null }
  }
  if (r.tipo === 'credenciales' || r.tipo === 'bloqueado') {
    const fallos = e.fallos_login + 1
    const frena = fallos >= MAX_FALLOS_LOGIN
    const aviso = frena && !e.frenado
      ? `Punto a Punto: el login falló ${fallos} veces seguidas (${r.tipo === 'bloqueado' ? 'usuario bloqueado' : 'usuario o clave rechazados'}). ` +
        'Frené la descarga automática para que no te bloqueen la cuenta. Revisá PAP_USUARIO/PAP_CLAVE y reactivá ' +
        '(ver docs/pap-panel-inspeccion.md, sección "Reactivar").'
      : null
    return { estado: { ...e, fallos_login: fallos, frenado: e.frenado || frena }, aviso }
  }
  return trasError(e, `login: ${r.detalle}`)
}

/** Error de red/servidor (no cuenta como login fallido). Avisa una vez al llegar a MAX_ERRORES_SEGUIDOS. */
export function trasError(e: EstadoSync, detalle: string): Transicion {
  const n = e.errores_seguidos + 1
  const avisa = n >= MAX_ERRORES_SEGUIDOS && !e.aviso_errores_enviado
  return {
    estado: { ...e, errores_seguidos: n, aviso_errores_enviado: e.aviso_errores_enviado || avisa },
    aviso: avisa ? `Punto a Punto: ${n} sincronizaciones seguidas fallaron (último error: ${detalle.slice(0, 150)}).` : null,
  }
}

export function trasExito(e: EstadoSync, ahora: Date): EstadoSync {
  return { ...e, errores_seguidos: 0, aviso_errores_enviado: false, ultimo_ok_en: ahora.toISOString() }
}

/**
 * Compara la firma nueva con la guardada. Primera vez (null) no es un cambio, y tampoco
 * la vuelta a la normalidad después de una falla ya registrada (firma '!…').
 */
export function cambioDeFormato(anterior: string | null, nueva: string): boolean {
  return anterior != null && !anterior.startsWith('!') && anterior !== nueva
}
