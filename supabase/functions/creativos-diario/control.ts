// creativos-diario · control puro: días cuyo gasto del libro difiere más de 2 % del gasto por anuncio.
export interface FilaControl { fecha: string; creativos: number; anuncio: number | null }
export const TOLERANCIA = 0.02;

/** Días en [desde, hasta] (AAAA-MM-DD, inclusive) con gasto por anuncio conocido y diferencia mayor a la tolerancia. */
export function diasFueraDeRango(filas: FilaControl[], desde: string, hasta: string): FilaControl[] {
  return filas
    .filter((f) => f.fecha >= desde && f.fecha <= hasta && f.anuncio != null && f.anuncio > 0 &&
      Math.abs(f.creativos - f.anuncio) > TOLERANCIA * f.anuncio)
    .sort((a, b) => a.fecha.localeCompare(b.fecha));
}
