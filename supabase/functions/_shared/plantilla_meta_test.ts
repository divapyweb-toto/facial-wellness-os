import { assertEquals } from "@std/assert";
import { subirEjemplo } from "./plantilla_meta.ts";

Deno.test("subirEjemplo: app → sesión → subida devuelve el handle; error claro si falla un paso", async () => {
  Deno.env.set("WA_TOKEN", "t");
  const urls: string[] = [];
  const ok = (async (u: string) => {
    urls.push(u);
    const body = u.includes("/app?") ? { id: "77" } : u.includes("/uploads?") ? { id: "upload:abc" } : { h: "4::HANDLE" };
    return new Response(JSON.stringify(body));
  }) as unknown as typeof fetch;
  assertEquals(await subirEjemplo(new Uint8Array([1, 2, 3]), "application/pdf", "f.pdf", ok), { ok: true, handle: "4::HANDLE" });
  assertEquals(urls[1].includes("/77/uploads?") && urls[1].includes("file_length=3"), true);
  assertEquals(urls[2].endsWith("/upload:abc"), true);
  const mal = (async () => new Response(JSON.stringify({ error: { message: "x" } }))) as unknown as typeof fetch;
  assertEquals(await subirEjemplo(new Uint8Array([1]), "application/pdf", "f.pdf", mal), { ok: false, error: "app: x" });
});
