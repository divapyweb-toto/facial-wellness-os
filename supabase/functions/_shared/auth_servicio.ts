// Solo la service role puede llamar a las funciones de cron (procesar-envios, salud-canal,
// shopify-conciliar). verify_jwt de Supabase acepta CUALQUIER JWT válido del proyecto,
// incluida la anon key pública: por eso además se compara el Bearer contra
// SUPABASE_SERVICE_ROLE_KEY en tiempo constante. La anon key o un usuario logueado → 401.
// El cron (migración 20261006000003) manda la service role leída de Vault ('service_role_key'):
// tiene que ser el mismo valor que Supabase inyecta como SUPABASE_SERVICE_ROLE_KEY.
import { igualesSeguro } from "./telegram.ts";

export function esServiceRole(authorization: string | null, claveServicio: string | undefined): boolean {
  if (!claveServicio) return false; // sin clave configurada no se acepta nada
  const m = /^Bearer\s+(.+)$/i.exec((authorization ?? "").trim());
  if (!m) return false;
  return igualesSeguro(m[1].trim(), claveServicio);
}

/**
 * Llave propia del cron (07-10): el encabezado x-cron-secret tiene que ser igual a CRON_SECRET (secreto de
 * funciones; el mismo valor está en Vault 'cron_secret', ver migración 20261007000014). Sin CRON_SECRET
 * configurado no se acepta nada por esta vía.
 */
export function esCron(encabezado: string | null, secreto: string | undefined): boolean {
  if (!secreto || secreto.length < 32 || !encabezado) return false;
  return igualesSeguro(encabezado.trim(), secreto);
}

/** Envuelve un handler: si no es la service role ni el cron con su llave, responde 401 sin ejecutarlo. */
export function conServiceRole(
  handler: (req: Request) => Response | Promise<Response>,
  claveServicio: () => string | undefined = () => Deno.env.get("SUPABASE_SERVICE_ROLE_KEY"),
  secretoCron: () => string | undefined = () => Deno.env.get("CRON_SECRET"),
): (req: Request) => Promise<Response> {
  return async (req) => {
    const ok = esServiceRole(req.headers.get("Authorization"), claveServicio()) ||
      esCron(req.headers.get("x-cron-secret"), secretoCron());
    if (!ok) {
      return Response.json({ ok: false, error: "solo service role" }, { status: 401 });
    }
    return await handler(req);
  };
}
