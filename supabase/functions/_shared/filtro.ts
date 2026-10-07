// Filtro de palabras prohibidas para todo texto saliente.
// La lista viene de config_wa.palabras_prohibidas (datos, no código).
// Ignora mayúsculas y tildes. Coincide al inicio de palabra, así "garantía"
// atrapa "garantías" y "cura" atrapa "curar", pero "cura" no atrapa "procuramos".

function normalizar(s: string): string {
  return s.normalize("NFD").replace(/\p{M}/gu, "").toLowerCase();
}

function escaparRegex(s: string): string {
  return s.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
}

/** Devuelve la palabra de la lista que aparece (tal como está en la lista) o null. */
export function contienePalabraProhibida(texto: string, lista: string[]): string | null {
  if (!texto || !Array.isArray(lista) || lista.length === 0) return null;
  const t = normalizar(texto);
  for (const palabra of lista) {
    const p = normalizar(String(palabra ?? "")).trim();
    if (!p) continue;
    const patron = escaparRegex(p).replace(/\s+/g, "\\s+");
    const re = new RegExp(`(^|[^\\p{L}\\p{N}])${patron}`, "u");
    if (re.test(t)) return palabra;
  }
  return null;
}
