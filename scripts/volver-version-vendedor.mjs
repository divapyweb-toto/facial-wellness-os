#!/usr/bin/env node
// scripts/volver-version-vendedor.mjs · 19-10-2026 (interruptor del encargo v35)
// Reactiva una versión ANTERIOR del prompt del vendedor (vendedor_versiones), por ejemplo la 34 si la v35 vende peor.
// Archiva la activa y pone la elegida como activa. El vendedor la toma en hasta 5 min (caché de versión).
//   node scripts/volver-version-vendedor.mjs --version 34 --dry-run   → solo dice qué haría
//   node scripts/volver-version-vendedor.mjs --version 34             → la activa
// Lee SUPABASE_PROJECT_REF y SUPABASE_SERVICE_ROLE_KEY de .env.produccion (o del entorno). Nunca imprime secretos.
// El código de las funciones se vuelve atrás aparte: scripts/volver-vendedor-codigo.sh <ref de git>.
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const RAIZ = path.join(path.dirname(fileURLToPath(import.meta.url)), '..');
const ENV = path.join(RAIZ, '.env.produccion');
if (fs.existsSync(ENV)) {
  for (const l of fs.readFileSync(ENV, 'utf8').split('\n')) {
    const m = /^\s*([A-Z0-9_]+)\s*=\s*(.*)\s*$/.exec(l);
    if (m && !process.env[m[1]]) process.env[m[1]] = m[2].replace(/^['"]|['"]$/g, '');
  }
}
const DRY = process.argv.includes('--dry-run');
const iv = process.argv.indexOf('--version');
const numero = iv >= 0 ? Number(process.argv[iv + 1]) : NaN;
if (!Number.isInteger(numero) || numero < 1) {
  console.error('Uso: node scripts/volver-version-vendedor.mjs --version <número> [--dry-run]');
  process.exit(1);
}
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

const [activa] = await q('GET', '/vendedor_versiones?estado=eq.activa&select=numero');
const [destino] = await q('GET', `/vendedor_versiones?numero=eq.${numero}&select=numero,estado`);
if (!destino) {
  console.error(`    X   no existe la versión ${numero}`);
  process.exit(1);
}
if (activa?.numero === numero) {
  console.log(`    OK  la versión ${numero} ya está activa; no cambio nada`);
  process.exit(0);
}
if (DRY) {
  console.log(`    --  activaría la versión ${numero} y archivaría la ${activa?.numero ?? '-'}`);
  process.exit(0);
}
if (activa) await q('PATCH', '/vendedor_versiones?estado=eq.activa', { estado: 'archivada' });
await q('PATCH', `/vendedor_versiones?numero=eq.${numero}`, { estado: 'activa', activada_en: new Date().toISOString() });
console.log(`    OK  versión ${numero} activa (la ${activa?.numero ?? '-'} quedó archivada) a las ${new Date().toISOString()}; tarda hasta 5 min`);
