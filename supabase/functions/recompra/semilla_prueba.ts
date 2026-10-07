// Solo para tests: la config de recompra sale de supabase/seed_recompra.sql (así tests y semilla no se desalinean).
import { configDesdeValor, type RecompraCfg } from "./calendario.ts";

export function cfgDeSemilla(): RecompraCfg {
  const sql = Deno.readTextFileSync(new URL("../../seed_recompra.sql", import.meta.url));
  const m = sql.match(/\('recompra',\s*'([\s\S]*?)'::jsonb\)/);
  if (!m) throw new Error("no encontré config recompra en seed_recompra.sql");
  return configDesdeValor(JSON.parse(m[1].replace(/''/g, "'")));
}
