#!/usr/bin/env node
// Batería oficial de pruebas SIFEN (Guía de Pruebas e-kuatia, feb-2026) en el ambiente TEST.
//
//   node scripts/bateria-pruebas-sifen.mjs
//
// Qué hace: invoca `deno run` sobre scripts/bateria-pruebas-sifen.ts (el código SIFEN es Deno, igual que las
// Edge Functions). Elegimos esta vía porque es la más simple que funciona: el mismo código que corre en
// producción, sin compilar ni duplicar nada para Node. Requisito: Deno instalado (`brew install deno`).
//
// Variables: las de ENV_SIFEN (SIFEN_CERT_P12_BASE64, SIFEN_CERT_CLAVE, SIFEN_TIMBRADO, SIFEN_TIMBRADO_INICIO,
// SIFEN_CSC, SIFEN_CSC_ID) desde el entorno o desde .env.local (ignorado por Git). Si falta alguna → MODO
// SIMULADO (sin red), y el reporte lo dice. NUNCA producción: SIFEN_AMBIENTE se fuerza a "test" y
// SIFEN_PRODUCCION_AUTORIZADA se borra antes de llamar a Deno.
// Reporte: docs/sifen-bateria/reporte-<fecha>.md y .json (+ KuDE en PDF). docs/ está en .gitignore.

import { spawnSync } from 'node:child_process';
import { existsSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

const RAIZ = join(dirname(fileURLToPath(import.meta.url)), '..');

if ((process.env.SIFEN_AMBIENTE ?? 'test') === 'prod') {
  console.error('La batería NUNCA corre en producción. Sacá SIFEN_AMBIENTE=prod del entorno.');
  process.exit(2);
}

const deno = spawnSync('deno', ['--version'], { encoding: 'utf8' });
if (deno.status !== 0) {
  console.error('Falta Deno. Instalalo con: brew install deno');
  process.exit(2);
}

const env = { ...process.env, SIFEN_AMBIENTE: 'test' };
delete env.SIFEN_PRODUCCION_AUTORIZADA;

const args = ['run', '-A', '--no-check', `--config=${join(RAIZ, 'supabase/functions/deno.json')}`];
const envLocal = join(RAIZ, '.env.local');
if (existsSync(envLocal)) args.push(`--env-file=${envLocal}`);
args.push(join(RAIZ, 'scripts/bateria-pruebas-sifen.ts'));

const faltan = ['SIFEN_CERT_P12_BASE64', 'SIFEN_CERT_CLAVE', 'SIFEN_TIMBRADO', 'SIFEN_TIMBRADO_INICIO', 'SIFEN_CSC']
  .filter((v) => !env[v]);
if (faltan.length && !existsSync(envLocal)) {
  console.log(`MODO SIMULADO: faltan ${faltan.join(', ')} (sin red; no sirve como evidencia de habilitación).`);
}

const r = spawnSync('deno', args, { cwd: RAIZ, env, stdio: 'inherit' });
process.exit(r.status ?? 1);
