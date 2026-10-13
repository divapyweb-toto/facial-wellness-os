#!/usr/bin/env node
// Arma/actualiza supabase/seed_anuncios.sql (config_wa.anuncios_producto = {"<ad_id>": "<handle>"}) a partir de
// los anuncios de Meta. Uso (desde la raíz de fw-os):
//   node scripts/mapear-anuncios.mjs < anuncios.json
// anuncios.json = lo que devuelve Meta: [{"id": "...", "name": "IMG WHATSAPP TIRAS NASALES 1 07-10-26"}, ...]
// (también acepta {"data": [...]}). El producto sale del nombre (nomenclatura "IMG|VID WHATSAPP <PRODUCTO> <n> <fecha>").
// Lo que ya estaba en el seed se conserva; los nombres que no se reconocen se listan y no entran.
// Después: aplicar el seed en Supabase (no pisa los ids que ya estén cargados).
import { readFile, writeFile } from "node:fs/promises";
import { armarSeedAnuncios, leerSeedAnuncios, mapearAnuncios, nombreDeHandle } from "../supabase/functions/_shared/anuncios.ts";

const SEED = new URL("../supabase/seed_anuncios.sql", import.meta.url);

async function leerStdin() {
  const partes = [];
  for await (const p of process.stdin) partes.push(p);
  return Buffer.concat(partes).toString("utf8");
}

const crudo = await leerStdin();
let datos;
try {
  datos = JSON.parse(crudo);
} catch {
  console.error("La entrada no es JSON. Pasale el JSON de Meta por stdin: node scripts/mapear-anuncios.mjs < anuncios.json");
  process.exit(1);
}
const anuncios = Array.isArray(datos) ? datos : Array.isArray(datos?.data) ? datos.data : null;
if (!anuncios) {
  console.error('Se esperaba una lista [{"id","name"}] o {"data": [...]}.');
  process.exit(1);
}

const previo = await readFile(SEED, "utf8").then(leerSeedAnuncios).catch(() => ({ mapeo: {}, nombres: {} }));
const r = mapearAnuncios(anuncios, previo);
await writeFile(SEED, armarSeedAnuncios(r.mapeo, r.nombres));

const nuevos = Object.keys(r.mapeo).filter((id) => !(id in previo.mapeo));
const cambiados = Object.keys(r.mapeo).filter((id) => id in previo.mapeo && previo.mapeo[id] !== r.mapeo[id]);
console.log(`seed_anuncios.sql: ${Object.keys(r.mapeo).length} anuncios (${nuevos.length} nuevos, ${cambiados.length} cambiados).`);
for (const id of nuevos) console.log(`  + ${id} → ${nombreDeHandle(r.mapeo[id])} (${r.nombres[id] ?? ""})`);
for (const id of cambiados) console.log(`  ~ ${id} → ${nombreDeHandle(r.mapeo[id])} (antes ${previo.mapeo[id]}; en la base NO se pisa solo)`);
if (r.sinProducto.length) {
  console.log(`Sin producto reconocido (no entraron, revisá el nombre):`);
  for (const a of r.sinProducto) console.log(`  ? ${a.id} "${a.name}"`);
}
