// scripts/generar-bateria-embebida.mjs · Integración (06-10-2026)
// Copia la batería del vendedor (supabase/vendedor/pruebas/NN_*.json + _comun.json) a un módulo TypeScript
// dentro de la función mejora-mensual: una Edge Function solo despliega lo que IMPORTA (los .json que se
// leen con Deno.readDir no viajan). El test mejora-mensual/bateria_embebida_test.ts falla si el módulo
// quedó desfasado de la carpeta.
//
//   node scripts/generar-bateria-embebida.mjs             → regenera el módulo
//   node scripts/generar-bateria-embebida.mjs --verificar → solo compara (sale con 1 si difiere)
import fs from "node:fs";
import path from "node:path";
import process from "node:process";
import { fileURLToPath } from "node:url";

const RAIZ = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const DIR = path.join(RAIZ, "supabase/vendedor/pruebas");
const SALIDA = path.join(RAIZ, "supabase/functions/mejora-mensual/bateria_embebida.ts");

export function armarModulo() {
  const nombres = fs.readdirSync(DIR).filter((n) => /^\d+.*\.json$/.test(n)).sort();
  const casos = nombres.map((n) => JSON.parse(fs.readFileSync(path.join(DIR, n), "utf8")));
  const comun = JSON.parse(fs.readFileSync(path.join(DIR, "_comun.json"), "utf8"));
  return [
    "// GENERADO por scripts/generar-bateria-embebida.mjs desde supabase/vendedor/pruebas/. NO editar a mano:",
    "// cambiar los .json y correr `node scripts/generar-bateria-embebida.mjs`. Datos de prueba (sin clientes reales).",
    'import type { CasoBateria, Comun } from "./probar.ts";',
    "",
    `export const CASOS_BATERIA = ${JSON.stringify(casos, null, 2)} as unknown as CasoBateria[];`,
    "",
    `export const COMUN_BATERIA = ${JSON.stringify(comun, null, 2)} as unknown as Comun;`,
    "",
  ].join("\n");
}

const esPrincipal = process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url);
if (esPrincipal) {
  const nuevo = armarModulo();
  const actual = fs.existsSync(SALIDA) ? fs.readFileSync(SALIDA, "utf8") : "";
  if (process.argv.includes("--verificar")) {
    if (nuevo !== actual) {
      console.error("bateria_embebida.ts está desfasado: corré node scripts/generar-bateria-embebida.mjs");
      process.exit(1);
    }
    console.log("bateria_embebida.ts al día");
  } else {
    fs.writeFileSync(SALIDA, nuevo);
    console.log(`bateria_embebida.ts: ${(nuevo.match(/"id":/g) ?? []).length} casos`);
  }
}
