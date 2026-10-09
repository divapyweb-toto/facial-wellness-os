// supabase/functions/pap-sync/sync.ts
// Orquestación de una corrida: login → Gestión → Paquetes → parseo → procesarFilas.
// Todo el I/O entra por `DepsSync` (los tests usan dobles en memoria y respuestas inventadas).
import type { FilaCourier, Resumen } from '../importar-courier/procesar.ts'
import type { ClientePaP } from './cliente_pap.ts'
import {
  cambioDeFormato, columnasFaltantes, combinarAFilas, cuerpoGestion, cuerpoPaquetes, detectarTipo,
  type EstadoSync, firmaFormato, MAX_CAMBIOS_EN_VENTANA, rangoFechas, trasError, trasExito, trasLogin,
  type TipoReporte, VENTANA_CAMBIOS_DIAS,
} from './logica.ts'
import type { Hoja } from './xlsx.ts'

export type TipoEvento = 'ok' | 'login_fallido' | 'error' | 'cambio_formato' | 'frenado'

export interface DepsSync {
  ahora: () => Date
  credenciales: () => { usuario?: string; clave?: string }
  pap: ClientePaP
  leerXlsx: (b: Uint8Array) => Hoja
  estado: {
    leer(): Promise<EstadoSync>
    guardar(e: EstadoSync): Promise<void>
    registrarEvento(tipo: TipoEvento, detalle: Record<string, unknown>): Promise<void>
    contarEventos(tipo: TipoEvento, desdeISO: string): Promise<number>
  }
  procesar: (filas: FilaCourier[]) => Promise<Resumen>
  avisar: (texto: string) => Promise<unknown>
  pausa: (ms: number) => Promise<void>
  dias?: number
  pausaMs?: number
}

export interface ResultadoSync {
  ok: boolean
  motivo?: string
  filas_gestion?: number
  filas_paquetes?: number
  filas_voltra?: number
  resumen?: Resumen
}

const PAUSA_MS = 3_000

export async function ejecutarSync(d: DepsSync): Promise<ResultadoSync> {
  let estado = await d.estado.leer()
  if (!estado.activo) return { ok: false, motivo: 'desactivado' }
  if (estado.frenado) return { ok: false, motivo: 'frenado_por_login' } // no se toca PaP: evita el bloqueo

  const { usuario, clave } = d.credenciales()
  if (!usuario || !clave) return { ok: false, motivo: 'faltan_secretos' }

  const avisos: string[] = []
  const guardar = async () => {
    await d.estado.guardar(estado)
    for (const a of avisos) await d.avisar(a).catch(() => {})
  }
  const fallar = async (motivo: string): Promise<ResultadoSync> => {
    const t = trasError(estado, motivo)
    estado = t.estado
    if (t.aviso) avisos.push(t.aviso)
    await d.estado.registrarEvento('error', { motivo })
    await guardar()
    return { ok: false, motivo }
  }

  // 1. Login.
  const login = await d.pap.login(usuario, clave)
  const t = trasLogin(estado, login)
  estado = t.estado
  if (t.aviso) avisos.push(t.aviso)
  if (login.tipo !== 'ok' || !login.sesion) {
    if (login.tipo === 'credenciales' || login.tipo === 'bloqueado') {
      await d.estado.registrarEvento('login_fallido', { tipo: login.tipo, status: login.status ?? null, detalle: login.detalle })
      if (estado.frenado) await d.estado.registrarEvento('frenado', { fallos: estado.fallos_login })
      await guardar()
      return { ok: false, motivo: `login_${login.tipo}` }
    }
    await d.estado.registrarEvento('error', { motivo: `login: ${login.detalle}` })
    await guardar()
    return { ok: false, motivo: `login: ${login.detalle}` }
  }

  // 2. Reportes (con pausa entre pedidos: frecuencia y ritmo de una persona).
  const rango = rangoFechas(d.ahora(), d.dias)
  const hojas: Partial<Record<TipoReporte, Hoja>> = {}
  for (const tipo of ['gestion', 'paquetes'] as const) {
    await d.pausa(d.pausaMs ?? PAUSA_MS)
    const cuerpo = tipo === 'gestion' ? cuerpoGestion(rango) : cuerpoPaquetes(rango)
    const r = await d.pap.bajar(tipo, login.sesion, cuerpo)
    const claveFirma = tipo === 'gestion' ? 'firma_gestion' : 'firma_paquetes'
    if (r.tipo === 'endpoint' || r.tipo === 'formato') {
      // Marca '!clase:status' en la firma: la misma falla repetida no se vuelve a registrar ni avisar.
      const marca = `!${r.tipo}:${r.status ?? ''}`
      if (estado[claveFirma] !== marca) {
        await registrarCambio(d, avisos, tipo, r.tipo, r.detalle)
        estado = { ...estado, [claveFirma]: marca }
      }
      return await fallar(`${tipo}: ${r.detalle}`)
    }
    if (r.tipo !== 'ok' || !r.bytes) return await fallar(`${tipo}: ${r.detalle}`)

    let hoja: Hoja
    try { hoja = d.leerXlsx(r.bytes) } catch (e) {
      if (estado[claveFirma] !== '!ilegible') {
        await registrarCambio(d, avisos, tipo, 'formato', `no se pudo leer el Excel: ${(e as Error)?.message ?? e}`)
        estado = { ...estado, [claveFirma]: '!ilegible' }
      }
      return await fallar(`${tipo}: Excel ilegible`)
    }

    // 3. ¿Cambió el formato? (columnas en orden). Avisa una sola vez por formato nuevo.
    const firma = firmaFormato(hoja.headers)
    const clave = claveFirma
    const faltan = hoja.headers.length ? columnasFaltantes(tipo, hoja.headers) : []
    const detectado = hoja.headers.length ? detectarTipo(hoja.headers) : tipo
    const firmaNueva = hoja.headers.length > 0 && estado[clave] !== firma
    if (hoja.headers.length && cambioDeFormato(estado[clave], firma)) {
      await registrarCambio(d, avisos, tipo, 'columnas', `columnas nuevas: ${firma.slice(0, 300)}`)
    }
    if (hoja.headers.length) estado = { ...estado, [clave]: firma }
    if (faltan.length || (detectado !== tipo && detectado !== 'desconocido')) {
      // Se avisa una vez por formato; si sigue igual en la próxima corrida, solo cuenta como error.
      if (firmaNueva) {
        avisos.push(`Punto a Punto: al reporte de ${tipo === 'gestion' ? 'Gestión' : 'Paquetes'} le faltan columnas (${faltan.join(', ') || 'tipo distinto'}). No procesé nada.`)
      }
      return await fallar(`${tipo}: faltan columnas ${faltan.join(', ')}`)
    }
    hojas[tipo] = hoja
  }

  // 4. Mismo cruce que la pantalla Entregas, solo VT-, y al importador común.
  const filas = combinarAFilas(hojas.paquetes?.rows ?? [], hojas.gestion?.rows ?? [])
  let resumen: Resumen | undefined
  if (filas.length) {
    try { resumen = await d.procesar(filas) } catch (e) {
      return await fallar(`procesar: ${(e as Error)?.message ?? e}`)
    }
  }

  estado = trasExito(estado, d.ahora())
  await d.estado.registrarEvento('ok', {
    filas_gestion: hojas.gestion?.rows.length ?? 0,
    filas_paquetes: hojas.paquetes?.rows.length ?? 0,
    filas_voltra: filas.length,
    procesadas: resumen?.procesadas ?? 0,
    avisos_programados: resumen?.avisos_programados ?? 0,
    sin_pedido: resumen?.sin_pedido ?? 0,
    estados_no_reconocidos: resumen?.estados_no_reconocidos ?? [],
    errores: (resumen?.errores ?? []).length,
  })
  await guardar()
  return {
    ok: true,
    filas_gestion: hojas.gestion?.rows.length ?? 0,
    filas_paquetes: hojas.paquetes?.rows.length ?? 0,
    filas_voltra: filas.length,
    resumen,
  }
}

/** Registra un cambio de formato/endpoint y, si ya van más de 2 en 90 días, recuerda el criterio de abandono. */
async function registrarCambio(d: DepsSync, avisos: string[], tipo: TipoReporte, clase: string, detalle: string) {
  await d.estado.registrarEvento('cambio_formato', { reporte: tipo, clase, detalle: detalle.slice(0, 500) })
  const desde = new Date(d.ahora().getTime() - VENTANA_CAMBIOS_DIAS * 86_400_000).toISOString()
  const n = await d.estado.contarEventos('cambio_formato', desde).catch(() => 0)
  const nombre = tipo === 'gestion' ? 'Gestión' : 'Paquetes'
  avisos.push(
    `Punto a Punto cambió el reporte de ${nombre} (${clase}): ${detalle.slice(0, 160)}. ` +
      `Cambios en los últimos 90 días: ${n}.` +
      (n > MAX_CAMBIOS_EN_VENTANA
        ? ' Superó tu criterio de abandono (más de 2 cambios en 3 meses): evaluá volver a la importación manual.'
        : ''),
  )
}
