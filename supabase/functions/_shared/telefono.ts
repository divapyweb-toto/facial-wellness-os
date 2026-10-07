// Normalización de celulares de Paraguay a E.164: '+5959XXXXXXXX'.
// Acepta: 0981 123 456 · 981123456 · +595981123456 · 595 981 123 456 ·
// 00595981123456 · 5950981123456 (el 0 de más es un error común).
// Devuelve null para fijos (021…, 061…), extranjeros o basura.

export function normalizarTelefonoPY(x: string): string | null {
  if (typeof x !== "string") return null;
  let d = x.replace(/\D/g, "");
  if (d.startsWith("00")) d = d.slice(2);
  if (d.startsWith("595")) {
    d = d.slice(3);
    if (d.startsWith("0")) d = d.slice(1);
  } else if (d.startsWith("0")) {
    d = d.slice(1);
  }
  // Celular PY: 9 + 8 dígitos (09XX XXX XXX sin el 0).
  if (!/^9\d{8}$/.test(d)) return null;
  return "+595" + d;
}
