// creativos-diario · control puro: días cuyo gasto del libro difiere más de 2 % del gasto por anuncio.
import type { OpcionesAviso } from "../_shared/telegram_politica.ts";
export interface FilaControl { fecha: string; creativos: number; anuncio: number | null }
export const TOLERANCIA = 0.02;

/** Días en [desde, hasta] (AAAA-MM-DD, inclusive) con gasto por anuncio conocido y diferencia mayor a la tolerancia. */
export function diasFueraDeRango(filas: FilaControl[], desde: string, hasta: string): FilaControl[] {
  return filas
    .filter((f) => f.fecha >= desde && f.fecha <= hasta && f.anuncio != null && f.anuncio > 0 &&
      Math.abs(f.creativos - f.anuncio) > TOLERANCIA * f.anuncio)
    .sort((a, b) => a.fecha.localeCompare(b.fecha));
}

/** 27-10: descuadre del libro de creativos → administración, 1 por día y fecha del libro. */
export function avisoDescuadreCreativos(fecha: string): OpcionesAviso {
  return { tipo: "creativos_libro_descuadre", destino: "admin", unaVezPorDia: true, clave: fecha };
}
