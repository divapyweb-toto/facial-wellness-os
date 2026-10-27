// stock-shopify · lógica pura (18-10-2026).
// Stock REAL = stock_actual de Voltra OS − unidades de pedidos válidos todavía no descontados (no cargados en Despacho).
// Un Pack sin descontar consume sus componentes. El Pack en Shopify vale lo que alcancen sus componentes.
// Voltra OS manda: la sincronización reescribe en Shopify este número (nunca menos de 0).

export type Familia = "Kit Deporte" | "Raspador" | "Tiras" | "Parches" | "Pack" | "JawFlex" | "Botella" | "Bebird" | "Otros";
export function familia(texto: string): Familia {
  const t = texto.toLowerCase();
  // 26-10: el kit menciona a sus componentes ("Botella + Tiras"): va antes que tiras. "deport" solo no (la botella es "Deportiva").
  if (/kit ?deporte/.test(t) || (/botella/.test(t) && /tira|nasal/.test(t))) return "Kit Deporte";
  if (/pack|gudair/.test(t)) return "Pack";
  if (/raspador|lengua/.test(t)) return "Raspador";
  if (/tira|nasal/.test(t)) return "Tiras";
  if (/parche|bucal/.test(t)) return "Parches";
  if (/jaw|mand[ií]bula|ejercitador/.test(t)) return "JawFlex";
  if (/botella/.test(t)) return "Botella";
  if (/bebird|o[ií]do/.test(t)) return "Bebird";
  return "Otros";
}

export interface Producto { id: string; nombre: string; stock: number; esCombo: boolean; componentes: Array<{ id: string; qty: number }> }
export interface PedidoPendiente { lineas: Array<{ titulo: string; cantidad: number }> }

export interface StockReal { familia: Familia; stockActual: number | null; sinDescontar: number; real: number }

export function stockReal(productos: Producto[], pendientes: PedidoPendiente[]): Map<Familia, StockReal> {
  const porFam = new Map<Familia, Producto>();
  for (const p of productos) if (!porFam.has(familia(p.nombre))) porFam.set(familia(p.nombre), p);
  const byId = new Map(productos.map((p) => [p.id, p]));
  const consumo = new Map<Familia, number>();
  const suma = (f: Familia, n: number) => consumo.set(f, (consumo.get(f) ?? 0) + n);
  for (const ped of pendientes) {
    for (const l of ped.lineas) {
      const f = familia(l.titulo), prod = porFam.get(f);
      if (prod?.esCombo) for (const c of prod.componentes) { const cp = byId.get(c.id); if (cp) suma(familia(cp.nombre), l.cantidad * c.qty); }
      else suma(f, l.cantidad);
      if (prod?.esCombo) suma(f, l.cantidad); // para mostrarlo en la fila del Pack
    }
  }
  const out = new Map<Familia, StockReal>();
  for (const [f, p] of porFam) {
    if (p.esCombo) continue;
    out.set(f, { familia: f, stockActual: p.stock, sinDescontar: consumo.get(f) ?? 0, real: Math.max(0, p.stock - (consumo.get(f) ?? 0)) });
  }
  for (const [f, p] of porFam) {
    if (!p.esCombo) continue;
    const alcanza = p.componentes.map((c) => {
      const cp = byId.get(c.id);
      return cp ? Math.floor((out.get(familia(cp.nombre))?.real ?? 0) / (c.qty || 1)) : 0;
    });
    out.set(f, { familia: f, stockActual: null, sinDescontar: consumo.get(f) ?? 0, real: alcanza.length ? Math.min(...alcanza) : 0 });
  }
  return out;
}

export const UMBRAL_ALERTA = 10;
