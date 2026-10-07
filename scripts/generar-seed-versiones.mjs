// scripts/generar-seed-versiones.mjs · Integración (06-10-2026)
// Arma supabase/seed_vendedor_versiones.sql desde supabase/vendedor/prompt_sistema.md: la versión 1 del
// vendedor ('activa', origen 'semilla'). El prompt va entre comillas de dólar ($prompt_v1$ … $prompt_v1$), así
// no hay que escapar comillas ni barras. Idempotente: solo inserta si la tabla está vacía y on conflict do
// nothing (nunca pisa versiones aplicadas por el ciclo mensual).
//   node scripts/generar-seed-versiones.mjs             → regenera el .sql
//   node scripts/generar-seed-versiones.mjs --verificar → solo compara (sale con 1 si difiere)
import fs from "node:fs";
import path from "node:path";
import process from "node:process";
import { fileURLToPath } from "node:url";

const RAIZ = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const MD = path.join(RAIZ, "supabase/vendedor/prompt_sistema.md");
const SALIDA = path.join(RAIZ, "supabase/seed_vendedor_versiones.sql");
export const ETIQUETA = "$prompt_v1$";

export function armarSeed(prompt) {
  if (prompt.includes(ETIQUETA)) throw new Error(`el prompt contiene ${ETIQUETA}: cambiar la etiqueta`);
  if (prompt.includes("\0")) throw new Error("el prompt tiene un carácter nulo");
  return [
    "-- GENERADO por scripts/generar-seed-versiones.mjs desde supabase/vendedor/prompt_sistema.md. NO editar a mano.",
    "-- Versión 1 del vendedor (activa, origen 'semilla'): el vendedor la usa como prompt mientras sea la activa.",
    "-- Solo se inserta si vendedor_versiones está vacía; on conflict do nothing (número o activa ya ocupados).",
    "-- Requiere la migración 20261006000012_mejora_mensual.sql. No toca config_wa.",
    "insert into public.vendedor_versiones (numero, estado, prompt, ejemplos, faq, objeciones, origen, activada_en, notas)",
    `select 1, 'activa', ${ETIQUETA}${prompt}${ETIQUETA},`,
    "       '[]'::jsonb, '[]'::jsonb, '[]'::jsonb, 'semilla', now(), 'Prompt inicial (supabase/vendedor/prompt_sistema.md)'",
    " where not exists (select 1 from public.vendedor_versiones)",
    "on conflict do nothing;",
    "",
  ].join("\n");
}

const esPrincipal = process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url);
if (esPrincipal) {
  const nuevo = armarSeed(fs.readFileSync(MD, "utf8"));
  const actual = fs.existsSync(SALIDA) ? fs.readFileSync(SALIDA, "utf8") : "";
  if (process.argv.includes("--verificar")) {
    if (nuevo !== actual) {
      console.error("seed_vendedor_versiones.sql está desfasado: corré node scripts/generar-seed-versiones.mjs");
      process.exit(1);
    }
    console.log("seed_vendedor_versiones.sql al día");
  } else {
    fs.writeFileSync(SALIDA, nuevo);
    console.log(`seed_vendedor_versiones.sql: prompt de ${nuevo.length} caracteres`);
  }
}
