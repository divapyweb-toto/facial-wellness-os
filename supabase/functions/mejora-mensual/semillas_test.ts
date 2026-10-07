// Semillas de la integración: versión 1 del vendedor, config_wa.mejora_mensual y la regla de no pisar
// valores de producción (config_wa.vendedor.tope_mensual_usd y whatsapp_enrique).
import { assert, assertEquals } from "@std/assert";
import { CONFIG_POR_DEFECTO } from "./aprobacion.ts";
import { CFG_MEJORA_DEFAULT } from "./tipos.ts";

const R = new URL("../../", import.meta.url);
const leer = (f: string) => Deno.readTextFile(new URL(f, R));

Deno.test("seed_vendedor_versiones.sql: versión 1 activa con el prompt EXACTO de prompt_sistema.md (si no, regenerar)", async () => {
  const sql = await leer("seed_vendedor_versiones.sql");
  const md = await leer("vendedor/prompt_sistema.md");
  const m = /\$prompt_v1\$([\s\S]*)\$prompt_v1\$/.exec(sql);
  assert(m, "falta el prompt entre $prompt_v1$");
  assertEquals(m[1], md, "corré node scripts/generar-seed-versiones.mjs");
  assert(sql.includes("select 1, 'activa'"));
  assert(sql.includes("'semilla'"));
  assert(sql.includes("where not exists (select 1 from public.vendedor_versiones)"));
  assert(sql.includes("on conflict do nothing"));
  assert(!/config_wa/.test(sql.replace(/^--.*$/gm, "")));
});

Deno.test("seed_mejora_mensual.sql: defaults de M1 + claves de M3, sin pisar lo existente", async () => {
  const sql = await leer("seed_mejora_mensual.sql");
  const json = /\('mejora_mensual',\s*'([\s\S]*?)'::jsonb\)/.exec(sql);
  assert(json);
  const v = JSON.parse(json[1]);
  assertEquals(v, { ...CFG_MEJORA_DEFAULT, reserva_usd: CONFIG_POR_DEFECTO.reserva_usd, usd_por_conversacion: CONFIG_POR_DEFECTO.usd_por_conversacion });
  assert(sql.includes("on conflict (clave) do nothing"));
  // El merge pone lo existente a la DERECHA (gana lo que ya estaba).
  assert(/'::jsonb \|\| valor\s+where clave = 'mejora_mensual'/.test(sql));
});

Deno.test("semillas: precios_claude existe y ninguna pisa tope_mensual_usd ni whatsapp_enrique de producción", async () => {
  const nombres: string[] = [];
  for await (const e of Deno.readDir(R)) if (/^seed_.*\.sql$/.test(e.name)) nombres.push(e.name);
  let precios = false;
  for (const n of nombres) {
    const sql = (await leer(n)).replace(/^\s*--.*$/gm, "");
    if (sql.includes("'precios_claude'")) precios = true;
    // Todo insert a config_wa termina en on conflict (do nothing, o do update solo si estaba vacío).
    for (const ins of sql.split(/insert into public\.config_wa/).slice(1)) {
      const fin = ins.split(/\bupdate public\.config_wa/)[0]; // hasta la próxima sentencia sobre config_wa
      assert(/on conflict \(clave\) do (nothing|update set valor = excluded\.valor\s+where public\.config_wa\.valor = '\{\}'::jsonb)/.test(fin), `${n}: insert sin on conflict seguro`);
    }
    // Ningún update menciona las claves protegidas.
    for (const up of sql.split(/update public\.config_wa/).slice(1)) {
      const fin = up.slice(0, up.indexOf(";"));
      assert(!/tope_mensual_usd|whatsapp_enrique/.test(fin), `${n}: un update toca una clave protegida`);
    }
  }
  assert(precios, "ninguna semilla carga config_wa.precios_claude");
});
