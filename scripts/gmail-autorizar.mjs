#!/usr/bin/env node
// scripts/gmail-autorizar.mjs · 21-11-2026. Lo corre Enrique UNA vez en su Mac para que Voltra OS pueda leer y contestar
// el Gmail de Voltra (función proveedores-gmail). Nunca muestra ni guarda en archivos del repo ningún secreto.
//
// Uso:  node scripts/gmail-autorizar.mjs [ruta/al/client_secret_XXXX.json]
//       (sin ruta usa el client_secret_*.json más nuevo de ~/Downloads)
// Qué hace:
//   1. Lee el archivo del cliente OAuth que bajaste de Google Cloud (tipo "App de escritorio").
//   2. Abre el navegador para que des el permiso con la cuenta de Voltra (alcance gmail.modify: leer, etiquetar y mandar).
//   3. Recibe la respuesta de Google en 127.0.0.1 (solo tu Mac), cambia el código por el permiso permanente (refresh token)
//      y lo guarda como secretos de Supabase (GMAIL_CLIENT_ID, GMAIL_CLIENT_SECRET, GMAIL_REFRESH_TOKEN).
//   4. Prueba el permiso pidiendo el perfil y muestra solo el correo autorizado.
import { createHash, randomBytes } from "node:crypto";
import { spawn, spawnSync } from "node:child_process";
import { createServer } from "node:http";
import { mkdtempSync, readdirSync, readFileSync, rmSync, statSync, writeFileSync } from "node:fs";
import { homedir, tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { fileURLToPath } from "node:url";

export const ALCANCE = "https://www.googleapis.com/auth/gmail.modify";
export const AUTH_URL = "https://accounts.google.com/o/oauth2/v2/auth";
export const TOKEN_URL = "https://oauth2.googleapis.com/token";
export const PERFIL_URL = "https://gmail.googleapis.com/gmail/v1/users/me/profile";
// La cuenta NO va escrita acá (repo público): se puede sugerir con --cuenta=<correo> o la variable GMAIL_CUENTA.
export const CUENTA = (process.argv.find((x) => x.startsWith("--cuenta="))?.slice(9) || process.env.GMAIL_CUENTA || "").trim().toLowerCase() || null;
export const PROYECTO = "xboufewtyouxrsdvhnhy";
export const FW_OS = join(homedir(), "Negocios", "fw-os");

/**
 * El client_secret_*.json más nuevo de la carpeta (por fecha de modificación); null si no hay.
 * @param {string} carpeta
 * @param {{ readdirSync: (d: string) => string[]; statSync: (r: string) => { mtimeMs: number } }} [fs]
 */
export function clienteMasNuevo(carpeta, fs = { readdirSync: (d) => readdirSync(d), statSync: (r) => statSync(r) }) {
  let mejor = null;
  for (const nombre of fs.readdirSync(carpeta)) {
    if (!/^client_secret_.*\.json$/i.test(nombre)) continue;
    const ruta = join(carpeta, nombre);
    const t = fs.statSync(ruta).mtimeMs;
    if (!mejor || t > mejor.t) mejor = { ruta, t };
  }
  return mejor?.ruta ?? null;
}

/** Saca client_id y client_secret del JSON de Google ("installed" = app de escritorio; "web" también sirve con aviso). */
export function leerCliente(texto) {
  const j = JSON.parse(texto);
  const c = j.installed ?? j.web;
  if (!c?.client_id || !c?.client_secret) throw new Error("El archivo no parece un cliente OAuth de Google (falta client_id o client_secret).");
  return { clientId: c.client_id, clientSecret: c.client_secret, tipo: j.installed ? "escritorio" : "web" };
}

/** PKCE: verificador y desafío S256. @param {Uint8Array} [bytes] */
export function pkce(bytes = randomBytes(32)) {
  const verificador = Buffer.from(bytes).toString("base64url");
  return { verificador, desafio: createHash("sha256").update(verificador).digest("base64url") };
}

/** URL de consentimiento: offline (para tener refresh token), prompt=consent (para que lo dé siempre), gmail.modify. */
export function urlConsentimiento({ clientId, redirectUri, state, desafio, loginHint = CUENTA }) {
  const p = new URLSearchParams({
    client_id: clientId,
    redirect_uri: redirectUri,
    response_type: "code",
    scope: ALCANCE,
    access_type: "offline",
    prompt: "consent",
    include_granted_scopes: "true",
    state,
    code_challenge: desafio,
    code_challenge_method: "S256",
  });
  if (loginHint) p.set("login_hint", loginHint);
  return `${AUTH_URL}?${p}`;
}

/** Lee la vuelta de Google (/?code=…&state=…). Error si Google dio error, falta el código o el state no coincide. */
export function leerRedireccion(url, stateEsperado) {
  const u = new URL(url, "http://127.0.0.1");
  const error = u.searchParams.get("error");
  if (error) throw new Error(error === "access_denied" ? "Cancelaste el permiso en Google." : `Google devolvió un error: ${error}`);
  if (u.searchParams.get("state") !== stateEsperado) throw new Error("La respuesta no coincide con este pedido (state distinto). Volvé a correr el script.");
  const code = u.searchParams.get("code");
  if (!code) throw new Error("Google no mandó el código.");
  const alcances = (u.searchParams.get("scope") ?? "").split(/\s+/);
  if (u.searchParams.has("scope") && !alcances.includes(ALCANCE)) throw new Error("No se marcó el permiso de Gmail en la pantalla de Google. Volvé a correr y tildalo.");
  return { code };
}

/** Cambia el código por los tokens. Nunca imprime nada. */
export async function cambiarCodigo({ clientId, clientSecret, code, redirectUri, verificador }, f = fetch) {
  const r = await f(TOKEN_URL, {
    method: "POST",
    headers: { "content-type": "application/x-www-form-urlencoded" },
    body: new URLSearchParams({ client_id: clientId, client_secret: clientSecret, code, redirect_uri: redirectUri, grant_type: "authorization_code", code_verifier: verificador }),
  });
  const j = await r.json().catch(() => ({}));
  if (!r.ok) throw new Error(`Google no aceptó el código (${j.error ?? `HTTP ${r.status}`}).`);
  if (!j.refresh_token) throw new Error("Google no devolvió el permiso permanente (refresh token). Sacá el acceso de la app en myaccount.google.com/permissions y volvé a correr.");
  return { accessToken: j.access_token, refreshToken: j.refresh_token };
}

/** Correo de la cuenta autorizada (prueba que el permiso funciona). */
export async function correoAutorizado(accessToken, f = fetch) {
  const r = await f(PERFIL_URL, { headers: { authorization: `Bearer ${accessToken}` } });
  const j = await r.json().catch(() => ({}));
  if (!r.ok || !j.emailAddress) throw new Error(`No pude leer el perfil de Gmail (HTTP ${r.status}).`);
  return j.emailAddress;
}

/** Contenido del archivo temporal para `supabase secrets set --env-file` (los valores no pasan por la línea de comandos). */
export function archivoSecretos({ clientId, clientSecret, refreshToken }) {
  return `GMAIL_CLIENT_ID=${clientId}\nGMAIL_CLIENT_SECRET=${clientSecret}\nGMAIL_REFRESH_TOKEN=${refreshToken}\n`;
}

/** Saca de un texto cualquier valor secreto (por si la CLI de Supabase los repite en un error). */
export function taparSecretos(texto, valores) {
  return valores.filter(Boolean).reduce((t, v) => t.split(v).join("•••"), String(texto ?? ""));
}

function guardarSecretos(valores) {
  const dir = mkdtempSync(join(tmpdir(), "voltra-gmail-"));
  const archivo = join(dir, "secretos.env");
  try {
    writeFileSync(archivo, archivoSecretos(valores), { mode: 0o600 });
    const r = spawnSync("supabase", ["secrets", "set", "--env-file", archivo, "--project-ref", PROYECTO], { cwd: FW_OS, encoding: "utf8" });
    if (r.status !== 0) {
      const detalle = taparSecretos(`${r.stderr ?? ""}${r.error?.message ?? ""}`, Object.values(valores)).trim();
      throw new Error(`No pude guardar los secretos en Supabase. ${detalle || "¿Está instalada la CLI de Supabase y tenés la sesión abierta (supabase login)?"}`);
    }
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
}

async function principal() {
  const ruta = process.argv[2] ? resolve(process.argv[2]) : clienteMasNuevo(join(homedir(), "Downloads"));
  if (!ruta) throw new Error("No encontré ningún client_secret_*.json en Descargas. Pasá la ruta: node scripts/gmail-autorizar.mjs /ruta/al/archivo.json");
  const cliente = leerCliente(readFileSync(ruta, "utf8"));
  console.log(`Uso el archivo: ${ruta.split("/").pop()}`);
  if (cliente.tipo === "web") console.log("Ojo: el cliente es de tipo 'Web'. Si Google dice 'redirect_uri_mismatch', creá uno de tipo 'App de escritorio'.");

  const state = randomBytes(16).toString("hex");
  const { verificador, desafio } = pkce();
  // Primero levanta el servidor en un puerto libre; después abre el navegador.
  let resolverCodigo, rechazarCodigo;
  const codigo = new Promise((a, b) => { resolverCodigo = a; rechazarCodigo = b; });
  const servidor = createServer((req, res) => {
    if (!req.url?.startsWith("/?")) { res.writeHead(404).end(); return; }
    try {
      const r = leerRedireccion(req.url, state);
      res.writeHead(200, { "content-type": "text/html; charset=utf-8" }).end("<h2>Listo. Ya podés cerrar esta pestaña y volver a la Terminal.</h2>");
      resolverCodigo(r);
    } catch (e) {
      res.writeHead(400, { "content-type": "text/html; charset=utf-8" }).end(`<h2>No se pudo: ${String(e.message).replace(/</g, "&lt;")}</h2>`);
      rechazarCodigo(e);
    } finally {
      servidor.close();
    }
  });
  await new Promise((a) => servidor.listen(0, "127.0.0.1", a));
  const redirectUri = `http://127.0.0.1:${servidor.address().port}`;
  const url = urlConsentimiento({ clientId: cliente.clientId, redirectUri, state, desafio });
  console.log("\nSe abre el navegador. Entrá con la cuenta de Voltra y aceptá el permiso de Gmail.");
  console.log("Si Google avisa 'Google no verificó esta app': tocá 'Configuración avanzada' → 'Ir a … (no seguro)'. Es tu propia app.");
  console.log(`Si no se abre solo, copiá este enlace en el navegador:\n${url}\n`);
  spawn("open", [url], { stdio: "ignore", detached: true }).on("error", () => null).unref();

  const tiempo = setTimeout(() => { servidor.close(); rechazarCodigo(new Error("Pasaron 5 minutos sin respuesta. Volvé a correr el script.")); }, 5 * 60_000);
  const { code } = await codigo.finally(() => clearTimeout(tiempo));
  const tokens = await cambiarCodigo({ ...cliente, code, redirectUri, verificador });
  const correo = await correoAutorizado(tokens.accessToken);
  if (CUENTA && correo.toLowerCase() !== CUENTA) console.log(`Ojo: autorizaste ${correo}, no ${CUENTA}. Si fue un error, volvé a correr y elegí la cuenta de Voltra.`);
  guardarSecretos({ clientId: cliente.clientId, clientSecret: cliente.clientSecret, refreshToken: tokens.refreshToken });
  console.log(`\nListo: Voltra OS ya tiene permiso para el correo ${correo}. Los secretos quedaron guardados en Supabase (no se mostraron).`);
  console.log("Importante: en Google Cloud → Pantalla de consentimiento de OAuth, la app tiene que estar 'En producción'.");
  console.log("Si queda 'En prueba', Google corta el permiso a los 7 días y hay que volver a correr este script.");
}

// Solo corre si se ejecuta directo (las pruebas importan las funciones sin abrir nada).
const directo = process.argv[1] && resolve(process.argv[1]) === fileURLToPath(import.meta.url);
if (directo) {
  principal().catch((e) => {
    console.error(`\nNo se pudo: ${e.message}`);
    process.exit(1);
  });
}
