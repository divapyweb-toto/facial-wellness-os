// Tests de conServiceRole (valores inventados: no son claves reales).
import { assertEquals } from "jsr:@std/assert@1";
import { conServiceRole, esCron, esServiceRole } from "./auth_servicio.ts";

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

const CRON = "llave-del-cron-de-prueba-0123456789abcdef";

Deno.test("esCron: solo con CRON_SECRET configurado, largo y encabezado idéntico", () => {
  assertEquals(esCron(CRON, CRON), true);
  assertEquals(esCron(CRON + "x", CRON), false);
  assertEquals(esCron(null, CRON), false);
  assertEquals(esCron(CRON, undefined), false);
  assertEquals(esCron("corta", "corta"), false); // secreto de menos de 32 caracteres: no se acepta
});

Deno.test("conServiceRole: el cron pasa con su llave aunque la service role no coincida; la anon sola no", async () => {
  const h = conServiceRole(() => new Response("ok"), () => SERVICE, () => CRON);
  const conCron = await h(new Request("http://x", { method: "POST", headers: { Authorization: `Bearer ${ANON}`, "x-cron-secret": CRON } }));
  assertEquals(conCron.status, 200);
  const malaLlave = await h(new Request("http://x", { method: "POST", headers: { Authorization: `Bearer ${ANON}`, "x-cron-secret": "otra" } }));
  assertEquals(malaLlave.status, 401);
  const soloAnon = await h(new Request("http://x", { method: "POST", headers: { Authorization: `Bearer ${ANON}` } }));
  assertEquals(soloAnon.status, 401);
  const sinCronConfig = conServiceRole(() => new Response("ok"), () => SERVICE, () => undefined);
  assertEquals((await sinCronConfig(new Request("http://x", { method: "POST", headers: { "x-cron-secret": CRON } }))).status, 401);
});
