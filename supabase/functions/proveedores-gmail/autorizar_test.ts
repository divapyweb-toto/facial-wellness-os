// Pruebas de las partes puras de scripts/gmail-autorizar.mjs (sin red, sin navegador, sin Supabase). Datos DEMO.
import { assert, assertEquals, assertThrows } from "@std/assert";
import * as a from "../../../scripts/gmail-autorizar.mjs";

Deno.test("clienteMasNuevo: elige el client_secret_*.json más nuevo e ignora otros archivos", () => {
  const archivos: Record<string, number> = { "client_secret_viejo.json": 100, "client_secret_nuevo.json": 300, "otro.json": 999, "client_secret_x.txt": 500 };
  const fs = { readdirSync: () => Object.keys(archivos), statSync: (r: string) => ({ mtimeMs: archivos[r.split("/").pop()!] }) };
  assertEquals(a.clienteMasNuevo("/demo/Downloads", fs), "/demo/Downloads/client_secret_nuevo.json");
  assertEquals(a.clienteMasNuevo("/demo", { readdirSync: () => ["nada.pdf"], statSync: fs.statSync }), null);
});

Deno.test("leerCliente: app de escritorio y web; archivo inválido da error claro", () => {
  assertEquals(a.leerCliente(JSON.stringify({ installed: { client_id: "id-demo", client_secret: "s-demo" } })), { clientId: "id-demo", clientSecret: "s-demo", tipo: "escritorio" });
  assertEquals(a.leerCliente(JSON.stringify({ web: { client_id: "i", client_secret: "s" } })).tipo, "web");
  assertThrows(() => a.leerCliente("{}"), Error, "cliente OAuth");
});

Deno.test("urlConsentimiento: offline + consent + gmail.modify + PKCE (login_hint solo si se pasa)", () => {
  const { desafio, verificador } = a.pkce(new Uint8Array(32));
  assert(verificador.length >= 43);
  const u = new URL(a.urlConsentimiento({ clientId: "id-demo", redirectUri: "http://127.0.0.1:5555", state: "st", desafio }));
  assertEquals(u.origin + u.pathname, "https://accounts.google.com/o/oauth2/v2/auth");
  const p = u.searchParams;
  assertEquals(p.get("access_type"), "offline");
  assertEquals(p.get("prompt"), "consent");
  assertEquals(p.get("scope"), "https://www.googleapis.com/auth/gmail.modify");
  assertEquals(p.get("response_type"), "code");
  assertEquals(p.get("redirect_uri"), "http://127.0.0.1:5555");
  assertEquals(p.get("login_hint"), null, "sin cuenta escrita en el repo");
  const conCuenta = new URL(a.urlConsentimiento({ clientId: "id-demo", redirectUri: "http://127.0.0.1:5555", state: "st", desafio, loginHint: "cuenta@example.com" }));
  assertEquals(conCuenta.searchParams.get("login_hint"), "cuenta@example.com");
  assertEquals(p.get("state"), "st");
  assertEquals(p.get("code_challenge_method"), "S256");
  assertEquals(p.get("code_challenge"), desafio);
});

Deno.test("leerRedireccion: código ok; error, state distinto, sin código o sin el permiso de Gmail → error", () => {
  assertEquals(a.leerRedireccion("/?state=st&code=4/abc&scope=https://www.googleapis.com/auth/gmail.modify", "st"), { code: "4/abc" });
  assertEquals(a.leerRedireccion("/?state=st&code=xyz", "st"), { code: "xyz" });
  assertThrows(() => a.leerRedireccion("/?error=access_denied&state=st", "st"), Error, "Cancelaste");
  assertThrows(() => a.leerRedireccion("/?state=otro&code=x", "st"), Error, "state");
  assertThrows(() => a.leerRedireccion("/?state=st", "st"), Error, "código");
  assertThrows(() => a.leerRedireccion("/?state=st&code=x&scope=openid", "st"), Error, "permiso de Gmail");
});

Deno.test("cambiarCodigo y correoAutorizado con fetch falso (sin Google)", async () => {
  const llamadas: string[] = [];
  const f = ((url: string, init?: RequestInit) => {
    llamadas.push(url);
    if (url.includes("token")) {
      const b = new URLSearchParams(String(init?.body));
      assertEquals([b.get("grant_type"), b.get("code"), b.get("code_verifier")], ["authorization_code", "c1", "v1"]);
      return Promise.resolve(new Response(JSON.stringify({ access_token: "acc", refresh_token: "ref" })));
    }
    return Promise.resolve(new Response(JSON.stringify({ emailAddress: "demo@example.com" })));
  }) as typeof fetch;
  const t = await a.cambiarCodigo({ clientId: "i", clientSecret: "s", code: "c1", redirectUri: "http://127.0.0.1:1", verificador: "v1" }, f);
  assertEquals(t, { accessToken: "acc", refreshToken: "ref" });
  assertEquals(await a.correoAutorizado("acc", f), "demo@example.com");
  assertEquals(llamadas, [a.TOKEN_URL, a.PERFIL_URL]);
  const sinRefresh = (() => Promise.resolve(new Response(JSON.stringify({ access_token: "acc" })))) as typeof fetch;
  let error = "";
  await a.cambiarCodigo({ clientId: "i", clientSecret: "s", code: "c", redirectUri: "r", verificador: "v" }, sinRefresh).catch((e: Error) => error = e.message);
  assert(error.includes("refresh token"));
});

Deno.test("secretos: van por archivo (no por la línea de comandos) y se tapan en los errores", () => {
  assertEquals(a.archivoSecretos({ clientId: "i", clientSecret: "s", refreshToken: "r" }), "GMAIL_CLIENT_ID=i\nGMAIL_CLIENT_SECRET=s\nGMAIL_REFRESH_TOKEN=r\n");
  assertEquals(a.taparSecretos("error con secreto-demo y ref-demo", ["secreto-demo", "ref-demo", ""]), "error con ••• y •••");
});

Deno.test("el script no corre solo al importarlo (no abre navegador ni servidor)", () => {
  assertEquals(typeof a.urlConsentimiento, "function"); // si hubiera corrido principal(), la prueba colgaría esperando a Google
});
