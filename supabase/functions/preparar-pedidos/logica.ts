// Referencias de Voltra ('VT-1003', '#VT-1003', 'vt1003') → nombre del pedido en Shopify ('#1003').
// Lo que no es de Voltra (FW, texto raro) se descarta: FW no está en esta tienda de Shopify.
export function nombresDeRefs(refs: unknown): string[] {
  if (!Array.isArray(refs)) return [];
  const out = new Set<string>();
  for (const r of refs) {
    const m = /^\s*#?\s*VT-?0*(\d{1,9})\s*$/i.exec(String(r ?? ""));
    if (m) out.add(`#${m[1]}`);
  }
  return [...out].slice(0, 200);
}
