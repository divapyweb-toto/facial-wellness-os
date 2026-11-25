// _shared/regalos.ts · 25-11-2026. Black Friday 27-30/11: el pedido con la etiqueta REGALO_INHALADOR lleva 1 Inhalador
// de Menta de regalo. No hay línea a ₲0 en Shopify (SIFEN rechaza precio 0), así que el regalo vive en la etiqueta:
//  · lista-despacho: nota de armado del paquete.
//  · stock-shopify: reserva 1 inhalador por pedido pendiente sin descontar.
//  · El descuento real del stock lo hace la base (migración 20261125000001_regalo_inhalador_stock.sql, tabla
//    regalos_etiqueta): misma etiqueta y mismo producto. Si se agrega un regalo, se agrega en los dos lados.
export interface Regalo { etiqueta: string; titulo: string; cantidad: number; nota: string }

export const REGALOS: readonly Regalo[] = [
  { etiqueta: "regalo_inhalador", titulo: "Inhalador de menta", cantidad: 1, nota: "🎁 + 1 Inhalador de Menta (regalo)" },
];

const norm = (tags: readonly string[]) => new Set(tags.map((t) => String(t).trim().toLowerCase()).filter(Boolean));

/** Regalos que corresponden a un pedido según sus etiquetas (mayúsculas o minúsculas da igual). */
export function regalosDe(tags: readonly string[]): Regalo[] {
  const t = norm(tags);
  return REGALOS.filter((r) => t.has(r.etiqueta));
}
