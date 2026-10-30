// _shared/invocar.ts · 30-10. Llamada interna entre Edge Functions. db().functions.invoke dejó de pasar (non-2xx en vivo);
// esto manda la service role y además x-cron-secret, la llave propia del cron que acepta conServiceRole.
// `llego` = la función destino respondió de verdad (no un rechazo de autenticación ni una caída de red).
export interface RespuestaInterna {
  llego: boolean;
  status: number;
  datos: Record<string, unknown>;
  error?: string;
}

export async function invocarFuncion(nombre: string, cuerpo: unknown, f: typeof fetch = fetch): Promise<RespuestaInterna> {
  const url = Deno.env.get("SUPABASE_URL");
  const clave = Deno.env.get("SUPABASE_SERVICE_ROLE_KEY") ?? "";
  if (!url) return { llego: false, status: 0, datos: {}, error: "falta SUPABASE_URL" };
  try {
    const r = await f(`${url}/functions/v1/${nombre}`, {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
        Authorization: `Bearer ${clave}`,
        apikey: clave,
        "x-cron-secret": Deno.env.get("CRON_SECRET") ?? "",
      },
      body: JSON.stringify(cuerpo),
      signal: AbortSignal.timeout(60_000),
    });
    const datos = await r.json().catch(() => ({})) as Record<string, unknown>;
    const llego = r.status !== 401 && r.status !== 403 && r.status < 500;
    return { llego, status: r.status, datos, ...(llego ? {} : { error: `${nombre}: HTTP ${r.status} ${String(datos.error ?? datos.message ?? datos.msg ?? "")}`.trim() }) };
  } catch (e) {
    return { llego: false, status: 0, datos: {}, error: `${nombre}: ${e instanceof Error ? e.message : String(e)}` };
  }
}
