// Tests de conServiceRole (valores inventados: no son claves reales).
import { assertEquals } from "jsr:@std/assert@1";
import { conServiceRole, esServiceRole } from "./auth_servicio.ts";

const SERVICE = "clave-service-role-de-prueba";
const ANON = "clave-anon-de-prueba";
const USUARIO = "jwt-de-usuario-de-prueba";

function req(auth?: string) {
  return new Request("http://localhost/procesar-envios", {
    method: "POST",
    headers: auth ? { Authorization: auth } : {},
  });
}

Deno.test("esServiceRole: solo el Bearer exacto de la service role", () => {
  assertEquals(esServiceRole(`Bearer ${SERVICE}`, SERVICE), true);
  assertEquals(esServiceRole(`bearer   ${SERVICE} `, SERVICE), true);
  assertEquals(esServiceRole(`Bearer ${ANON}`, SERVICE), false);
  assertEquals(esServiceRole(SERVICE, SERVICE), false); // sin "Bearer"
  assertEquals(esServiceRole(`Bearer ${SERVICE}x`, SERVICE), false);
  assertEquals(esServiceRole(null, SERVICE), false);
  assertEquals(esServiceRole(`Bearer ${SERVICE}`, undefined), false); // sin clave configurada
  assertEquals(esServiceRole("Bearer ", ""), false);
});

Deno.test("conServiceRole: anon → 401, usuario → 401, sin header → 401, service → 200", async () => {
  let llamadas = 0;
  const h = conServiceRole(() => (llamadas++, Response.json({ ok: true })), () => SERVICE);
  assertEquals((await h(req(`Bearer ${ANON}`))).status, 401);
  assertEquals((await h(req(`Bearer ${USUARIO}`))).status, 401);
  assertEquals((await h(req())).status, 401);
  assertEquals(llamadas, 0);
  const ok = await h(req(`Bearer ${SERVICE}`));
  assertEquals(ok.status, 200);
  assertEquals(await ok.json(), { ok: true });
  assertEquals(llamadas, 1);
});
