// scripts/activar-prompt.mjs · 07-10-2026
// Lo llama desplegar.sh después de las semillas. Si el prompt de supabase/vendedor/prompt_sistema.md (o los
// ejemplos de supabase/vendedor/ejemplos_estilo.json) es distinto del de la versión ACTIVA en
// vendedor_versiones, archiva la activa y crea la siguiente versión con el contenido del archivo.
// Si son iguales, no hace nada. Así un solo despliegue deja el vendedor al día (antes había que correr
// logs/aplicar_vN.mjs a mano). Usa SUPABASE_PROJECT_REF y SUPABASE_SERVICE_ROLE_KEY del entorno; nunca los imprime.
//   node scripts/activar-prompt.mjs            → aplica si cambió
//   node scripts/activar-prompt.mjs --dry-run  → solo dice qué haría
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const RAIZ = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const DRY = process.argv.includes('--dry-run');
const ref = (process.env.SUPABASE_PROJECT_REF ?? '').trim();
const clave = (process.env.SUPABASE_SERVICE_ROLE_KEY ?? '').trim();
if (!ref || !clave) {
  console.error('    X   faltan SUPABASE_PROJECT_REF / SUPABASE_SERVICE_ROLE_KEY');
  process.exit(1);
}
const B = `https://${ref}.supabase.co/rest/v1`;
const H = { apikey: clave, Authorization: `Bearer ${clave}`, 'Content-Type': 'application/json', Prefer: 'return=representation' };
const q = async (m, u, b) => {
  const r = await fetch(B + u, { method: m, headers: H, body: b ? JSON.stringify(b) : undefined });
  const t = await r.text();
  if (!r.ok) throw new Error(`${m} ${u.split('?')[0]} → HTTP ${r.status}: ${t.slice(0, 200)}`);
  return t ? JSON.parse(t) : null;
};

const prompt = fs.readFileSync(path.join(RAIZ, 'supabase/vendedor/prompt_sistema.md'), 'utf8');
const ejemplos = JSON.parse(fs.readFileSync(path.join(RAIZ, 'supabase/vendedor/ejemplos_estilo.json'), 'utf8'));

const [activa] = await q('GET', '/vendedor_versiones?estado=eq.activa&select=numero,prompt,ejemplos');
const igual = activa && activa.prompt === prompt && JSON.stringify(activa.ejemplos ?? []) === JSON.stringify(ejemplos);
if (igual) {
  console.log(`    OK  el vendedor ya usa este prompt (versión ${activa.numero}); no cambio nada`);
  process.exit(0);
}
const [ultima] = await q('GET', '/vendedor_versiones?select=numero&order=numero.desc&limit=1');
const nueva = (ultima?.numero ?? 0) + 1;
if (DRY) {
  console.log(`    --  activaría la versión ${nueva} (la activa es ${activa?.numero ?? 'ninguna'})`);
  process.exit(0);
}
if (activa) await q('PATCH', '/vendedor_versiones?estado=eq.activa', { estado: 'archivada' });
await q('POST', '/vendedor_versiones', {
  numero: nueva, estado: 'activa', prompt, ejemplos, origen: 'manual', activada_en: new Date().toISOString(),
  notas: 'Activada por desplegar.sh desde supabase/vendedor/prompt_sistema.md',
});
console.log(`    OK  versión ${nueva} del vendedor activa (la ${activa?.numero ?? '-'} quedó archivada); tarda hasta 5 min en tomarla`);
