// supabase/functions/pap-sync/xlsx.ts
// Lectura del Excel de PaP con la MISMA librería y opciones que src/lib/importarPaP.js
// (xlsx 0.18.5, cellDates, primera hoja, defval ''). Versión fija para que no cambie sola.
import * as XLSX from 'npm:xlsx@0.18.5'

export interface Hoja {
  rows: Record<string, unknown>[]
  headers: string[]
}

export function leerXlsx(bytes: Uint8Array): Hoja {
  const wb = XLSX.read(bytes, { type: 'array', cellDates: true })
  const ws = wb.Sheets[wb.SheetNames[0]]
  if (!ws) return { rows: [], headers: [] }
  const rows = XLSX.utils.sheet_to_json<Record<string, unknown>>(ws, { defval: '' })
  // Encabezados desde la fila 1 (sirven aunque el reporte venga vacío).
  const aoa = XLSX.utils.sheet_to_json<unknown[]>(ws, { header: 1, blankrows: false })
  const headers = ((aoa[0] ?? []) as unknown[]).map((h) => String(h ?? '').trim()).filter(Boolean)
  return { rows, headers }
}

/** Solo para los tests: arma un .xlsx en memoria con datos inventados. */
export function escribirXlsx(filas: unknown[][]): Uint8Array<ArrayBuffer> {
  const wb = XLSX.utils.book_new()
  XLSX.utils.book_append_sheet(wb, XLSX.utils.aoa_to_sheet(filas), 'Hoja1')
  return new Uint8Array(XLSX.write(wb, { type: 'array', bookType: 'xlsx' }) as ArrayBuffer)
}
