// scripts/politica-telegram-sql.ts · 27-10. Genera el SQL de config.telegram_politica desde _shared/telegram_tipos.ts.
// Uso: deno run --allow-read scripts/politica-telegram-sql.ts > supabase/migrations/<fecha>_telegram_politica.sql
import { politicaInicial, TIPOS_AVISO } from "../supabase/functions/_shared/telegram_tipos.ts";

const pol = JSON.stringify(politicaInicial()).replaceAll("'", "''");
console.log(`-- Generado por scripts/politica-telegram-sql.ts (${Object.keys(TIPOS_AVISO).length} tipos registrados).
-- Vuelta atrás: update config set valor = 'todos' where clave = 'telegram_politica';
insert into public.config (clave, valor) values ('telegram_politica', '${pol}')
on conflict (clave) do update set valor = excluded.valor, actualizado = now();`);
