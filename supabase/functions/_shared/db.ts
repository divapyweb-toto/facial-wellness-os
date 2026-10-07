// Cliente de Supabase con service role (solo para Edge Functions) y helpers de datos.
// SUPABASE_URL y SUPABASE_SERVICE_ROLE_KEY los inyecta Supabase; nunca van en el código.
import { createClient, type SupabaseClient } from "npm:@supabase/supabase-js@2";
import type { FuenteEvento } from "./tipos.ts";

let cliente: SupabaseClient | null = null;

/** Cliente con service role (pasa por encima de RLS). Se crea una sola vez. */
export function db(): SupabaseClient {
  if (cliente) return cliente;
  const url = Deno.env.get("SUPABASE_URL");
  const key = Deno.env.get("SUPABASE_SERVICE_ROLE_KEY");
  if (!url || !key) {
    throw new Error("Faltan SUPABASE_URL o SUPABASE_SERVICE_ROLE_KEY en el entorno");
  }
  cliente = createClient(url, key, {
    auth: { persistSession: false, autoRefreshToken: false },
  });
  return cliente;
}

/**
 * Guarda el webhook tal cual llegó, ANTES de procesarlo.
 * Devuelve true si es nuevo y false si ya existía (mismo fuente + id_externo).
 * Cualquier otro error de base se lanza.
 */
export async function guardarEventoCrudo(
  fuente: FuenteEvento,
  idExterno: string,
  payload: unknown,
): Promise<boolean> {
  const { data, error } = await db()
    .from("eventos_crudos")
    .upsert(
      { fuente, id_externo: idExterno, payload },
      { onConflict: "fuente,id_externo", ignoreDuplicates: true },
    )
    .select("id");
  if (error) throw new Error(`guardarEventoCrudo: ${error.message}`);
  return Array.isArray(data) && data.length > 0;
}
