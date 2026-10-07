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

/** Envuelve un handler: si el Bearer no es la service role, responde 401 sin ejecutarlo. */
export function conServiceRole(
  handler: (req: Request) => Response | Promise<Response>,
  claveServicio: () => string | undefined = () => Deno.env.get("SUPABASE_SERVICE_ROLE_KEY"),
): (req: Request) => Promise<Response> {
  return async (req) => {
    if (!esServiceRole(req.headers.get("Authorization"), claveServicio())) {
      return Response.json({ ok: false, error: "solo service role" }, { status: 401 });
    }
    return await handler(req);
  };
}
