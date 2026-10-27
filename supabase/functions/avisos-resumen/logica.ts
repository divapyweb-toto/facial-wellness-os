// avisos-resumen/logica.ts · 27-10. Arma el resumen agrupado de los avisos de Enrique que no son urgentes
// (plazo PaP, despachados +5 días, sin despachar +24 h, rendición, sin WhatsApp). Puro, sin red.

export interface FilaResumen { id: number; tipo: string; texto: string; pedido: string | null; creado_en: string }

/** Tope por mensaje (Telegram corta en 4096). */
export const LIMITE_MENSAJE = 3800;

/** 'mañana' antes de las 12 h de PY (UTC−3), 'tarde' después. */
export function franja(ahora: Date): "mañana" | "tarde" {
  const horaPY = (ahora.getUTCHours() + 21) % 24;
  return horaPY < 12 ? "mañana" : "tarde";
}

/** Agrupa por tipo (en orden de llegada) y parte en mensajes de hasta LIMITE_MENSAJE, con los ids de cada mensaje. */
export function armarResumenAvisos(filas: FilaResumen[], titulos: Record<string, string>, ahora: Date): { texto: string; ids: number[] }[] {
  if (!filas.length) return [];
  const grupos = new Map<string, FilaResumen[]>();
  for (const f of [...filas].sort((a, b) => a.creado_en.localeCompare(b.creado_en))) {
    if (!grupos.has(f.tipo)) grupos.set(f.tipo, []);
    grupos.get(f.tipo)!.push(f);
  }
  const cab = (n: number) => `<b>📋 Resumen de avisos · ${franja(ahora)}</b>${n > 1 ? ` (parte ${n})` : ""}\n${filas.length} aviso(s) para revisar.`;
  const mensajes: { texto: string; ids: number[] }[] = [];
  let actual = { texto: cab(1), ids: [] as number[] };
  const empujar = (bloque: string, ids: number[]) => {
    if (actual.ids.length && actual.texto.length + bloque.length > LIMITE_MENSAJE) {
      mensajes.push(actual);
      actual = { texto: cab(mensajes.length + 1), ids: [] };
    }
    actual.texto += bloque;
    actual.ids.push(...ids);
  };
  for (const [tipo, lista] of grupos) {
    empujar(`\n\n<b>${titulos[tipo] ?? tipo}</b> (${lista.length})`, []);
    for (const f of lista) empujar(`\n\n${f.texto.trim().slice(0, LIMITE_MENSAJE - 300)}`, [f.id]);
  }
  if (actual.ids.length) mensajes.push(actual);
  return mensajes;
}
