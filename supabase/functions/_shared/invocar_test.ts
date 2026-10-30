import { assertEquals } from "@std/assert";
import { invocarFuncion } from "./invocar.ts";

Deno.env.set("SUPABASE_URL", "https://x.supabase.co");
Deno.env.set("SUPABASE_SERVICE_ROLE_KEY", "clave");
Deno.env.set("CRON_SECRET", "cron");

const con = (status: number, cuerpo: unknown) => ((_u: string, _i: RequestInit) => Promise.resolve(new Response(JSON.stringify(cuerpo), { status }))) as unknown as typeof fetch;

Deno.test("manda service role y x-cron-secret a la función pedida", async () => {
  let url = "", h: Record<string, string> = {};
  const f = ((u: string, i: RequestInit) => (url = u, h = i.headers as Record<string, string>, Promise.resolve(new Response("{}")))) as unknown as typeof fetch;
  await invocarFuncion("sifen-cola", { a: 1 }, f);
  assertEquals([url, h.Authorization, h["x-cron-secret"]], ["https://x.supabase.co/functions/v1/sifen-cola", "Bearer clave", "cron"]);
});

Deno.test("422 de negocio llegó; 401, 500 y red caída no llegaron", async () => {
  assertEquals((await invocarFuncion("p", {}, con(422, { error: "ambiguo" }))).llego, true);
  assertEquals((await invocarFuncion("p", {}, con(200, { ok: true }))).llego, true);
  const r = await invocarFuncion("p", {}, con(401, { error: "solo service role" }));
  assertEquals([r.llego, r.error], [false, "p: HTTP 401 solo service role"]);
  assertEquals((await invocarFuncion("p", {}, con(500, {}))).llego, false);
  const caida = (() => Promise.reject(new Error("red"))) as unknown as typeof fetch;
  assertEquals((await invocarFuncion("p", {}, caida)).llego, false);
});
