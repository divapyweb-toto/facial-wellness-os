// supabase/functions/_shared/estados_courier.ts
// ═══════════════════════════════════════════════════════════
// Traducción del estado que escribe cada courier → EstadoEnvio de Voltra OS.
// Fuente: tabla "Traducción de estados para el importador" del plan de
// construcción, verificada contra los archivos reales (jul-ago 2026):
//
//   · Lucero (columna Estado, y su hoja "Leyenda"): cargado / preparando /
//     aceptado / empaquetado / en_camino / entregado / fallido / devuelto /
//     cancelado. En el archivo vienen capitalizados ("Entregado", "Fallido").
//   · Punto a Punto (columna Estado de Gestión/Paquete): Entregado, Custodio,
//     Devolucion en proceso, No Gestionado, NO INGRESO A PAP, Borrador,
//     Asignado a ruta, En Oficina. El rendido va en otra columna
//     (EstadoDepTesor = "Rendido Tesorero").
//
// Lo que la tabla no cubre devuelve null (no se inventa un estado): ver
// ESTADOS_SIN_TRADUCCION más abajo.
// ═══════════════════════════════════════════════════════════
import type { EstadoEnvio } from './tipos.ts'

export type Courier = 'lucero' | 'pap'

export interface ExtraEstado {
  /** true si el courier ya rindió (pagó) el envío. */
  rendido?: boolean
}

// 'En camino', 'en_camino', 'EN-CAMINO', 'Devolución en proceso' → forma única.
export function normalizarEstado(s: unknown): string {
  return String(s ?? '')
    .normalize('NFD').replace(/[̀-ͯ]/g, '')
    .toLowerCase().trim()
    .replace(/[\s\-]+/g, '_')
}

const LUCERO: Record<string, EstadoEnvio> = {
  cargado: 'EN_PREPARACION',
  preparando: 'EN_PREPARACION',
  aceptado: 'EN_PREPARACION',
  empaquetado: 'EN_PREPARACION',
  en_camino: 'DESPACHADO',
  fallido: 'INTENTO_FALLIDO',
  entregado: 'ENTREGADO',
  devuelto: 'NO_ENTREGADO',
  cancelado: 'CANCELADO',
  // Lucero marca el rendido en la columna "Rendido" (Sí/No); se acepta
  // también como estado crudo para quien lo mande así.
  rendido: 'RENDIDO',
}

const PAP: Record<string, EstadoEnvio> = {
  entregado: 'ENTREGADO',
  devolucion_en_proceso: 'NO_ENTREGADO_RESCATABLE',
  // "Con ruta asignada y sin entrega": PaP lo escribe literal así.
  asignado_a_ruta: 'DESPACHADO',
  rendido_tesorero: 'RENDIDO',
  rendido: 'RENDIDO',
}

// Estados vistos en los archivos reales (o en el código existente) que la
// tabla del plan NO traduce. Se documentan para el reporte y la UI.
export const ESTADOS_SIN_TRADUCCION: Record<Courier, string[]> = {
  lucero: ['borrador'],
  pap: ['custodio', 'no_gestionado', 'no_ingreso_a_pap', 'borrador', 'en_oficina', 'devuelto'],
}

export function traducirEstado(
  courier: Courier,
  estadoCrudo: unknown,
  extra?: ExtraEstado,
): EstadoEnvio | null {
  const e = normalizarEstado(estadoCrudo)
  const mapa = courier === 'lucero' ? LUCERO : courier === 'pap' ? PAP : null
  if (!mapa) return null
  if (e && mapa[e]) return mapa[e]
  // Sin estado operativo pero marcado como rendido: el único dato es la plata.
  if (!e && extra?.rendido) return 'RENDIDO'
  return null
}
