import { assert, assertEquals, assertMatch, assertThrows } from "jsr:@std/assert@1";
import { avisosCertificado, cargarP12, credencialesDesdeEnv, ErrorCertificado, generarCertificadoPrueba } from "./certificado.ts";
import { ENV_SIFEN } from "./tipos.ts";

const b64 = (u: Uint8Array) => btoa(String.fromCharCode(...u));
const lector = (m: Record<string, string>) => (n: string) => m[n];

Deno.test("cargarP12: PEMs, base64 DER, RUC (SerialNumber, MT §7.5), vencimiento, clientAuth", async () => {
  const c = await generarCertificadoPrueba({ ruc: "80000003", dv: "4", dias: 30 });
  const k = cargarP12(c.p12, c.clave);
  assertMatch(k.clavePrivadaPem, /^-----BEGIN RSA PRIVATE KEY-----/);
  assertMatch(k.certificadoPem, /^-----BEGIN CERTIFICATE-----/);
  assertMatch(k.certificadoBase64, /^MII[A-Za-z0-9+/=]+$/);
  assertEquals(k.ruc, "80000003");
  assertEquals(k.dv, "4");
  assert(k.clientAuth);
  assert(k.autofirmado);
  assert(Math.abs(k.venceEl.getTime() - (Date.now() + 30 * 864e5)) < 120_000);
  assertMatch(k.sujeto, /serialNumber=RUC80000003-4/);
});

Deno.test("cargarP12: clave incorrecta y bytes basura dan error claro", async () => {
  const c = await generarCertificadoPrueba();
  assertThrows(() => cargarP12(c.p12, "otra"), ErrorCertificado, "clave");
  assertThrows(() => cargarP12(new Uint8Array([1, 2, 3]), "x"), ErrorCertificado);
  assertThrows(() => cargarP12(new Uint8Array(), "x"), ErrorCertificado, "vacío");
});

Deno.test("avisosCertificado: sin clientAuth, vencido, RUC distinto", async () => {
  const c = cargarP12((await generarCertificadoPrueba({ clientAuth: false, dias: -1 })).p12, "prueba");
  const a = avisosCertificado(c, "12345678").join(" | ");
  assertMatch(a, /clientAuth/);
  assertMatch(a, /venció/);
  assertMatch(a, /no coincide/);
});

Deno.test("cargarP12: lee el .p12 de OpenSSL 3 (formato por defecto, AES/PBKDF2)", async () => {
  const ok = await new Deno.Command("sh", { args: ["-c", "command -v openssl"] }).output().then((o) => o.success).catch(() => false);
  if (!ok) return;
  const dir = await Deno.makeTempDir({ prefix: "sifen-cert-" });
  try {
    const run = (args: string[]) => new Deno.Command("openssl", { args, stderr: "null" }).output();
    await run(["req", "-x509", "-newkey", "rsa:2048", "-nodes", "-days", "2", "-keyout", `${dir}/k.pem`, "-out", `${dir}/c.pem`,
      "-subj", "/CN=PRUEBA/serialNumber=RUC80000009-1", "-addext", "extendedKeyUsage=clientAuth"]);
    await run(["pkcs12", "-export", "-inkey", `${dir}/k.pem`, "-in", `${dir}/c.pem`, "-out", `${dir}/x.p12`, "-passout", "pass:abc 123"]);
    const k = cargarP12(await Deno.readFile(`${dir}/x.p12`), "abc 123");
    assertEquals(k.ruc, "80000009");
    assert(k.clientAuth);
  } finally {
    await Deno.remove(dir, { recursive: true });
  }
});

Deno.test("credencialesDesdeEnv: sin MODO_SIMULADO lista exactamente lo que falta", async () => {
  const r = await credencialesDesdeEnv(lector({ [ENV_SIFEN.timbrado]: "12345678" }));
  assert(!r.ok);
  if (!r.ok) {
    assertEquals(r.faltan, [ENV_SIFEN.certP12Base64, ENV_SIFEN.certClave, ENV_SIFEN.timbradoInicio, ENV_SIFEN.csc, ENV_SIFEN.cscId]);
    assertMatch(r.error, /SIFEN_CERT_P12_BASE64/);
  }
});

Deno.test("credencialesDesdeEnv: MODO_SIMULADO=1 sin nada → autofirmado + valores de prueba", async () => {
  const r = await credencialesDesdeEnv(lector({ [ENV_SIFEN.simulado]: "1" }));
  assert(r.ok);
  if (r.ok) {
    assert(r.simulado);
    assertEquals(r.credenciales.ambiente, "test");
    assertEquals(r.credenciales.produccionAutorizada, false);
    assertEquals(r.credenciales.cscId, "0001");
    assert(r.certificado.autofirmado);
    assert(r.avisos.some((a) => /AUTOFIRMADO/.test(a)));
  }
});

Deno.test("credencialesDesdeEnv: completas (cert en base64), prod autorizada solo con 'si'", async () => {
  const c = await generarCertificadoPrueba({ ruc: "80000004", dv: "2" });
  const base = {
    [ENV_SIFEN.certP12Base64]: b64(c.p12),
    [ENV_SIFEN.certClave]: c.clave,
    [ENV_SIFEN.timbrado]: "12345678",
    [ENV_SIFEN.timbradoInicio]: "2026-10-01",
    [ENV_SIFEN.csc]: "ABCD0000000000000000000000000000",
    [ENV_SIFEN.cscId]: "1",
    [ENV_SIFEN.ambiente]: "prod",
  };
  const r1 = await credencialesDesdeEnv(lector(base));
  assert(r1.ok);
  if (r1.ok) {
    assertEquals(r1.credenciales.ambiente, "prod");
    assertEquals(r1.credenciales.produccionAutorizada, false);
    assertEquals(r1.credenciales.cscId, "0001");
    assertEquals(r1.certificado.ruc, "80000004");
  }
  const r2 = await credencialesDesdeEnv(lector({ ...base, [ENV_SIFEN.produccionAutorizada]: "si" }));
  assert(r2.ok && r2.credenciales.produccionAutorizada);
  const r3 = await credencialesDesdeEnv(lector({ ...base, [ENV_SIFEN.produccionAutorizada]: "true" }));
  assert(r3.ok && !r3.credenciales.produccionAutorizada);
  const r4 = await credencialesDesdeEnv(lector({ ...base, [ENV_SIFEN.certClave]: "mala" }));
  assert(!r4.ok && /clave/.test(r4.error));
  const r5 = await credencialesDesdeEnv(lector({ ...base, [ENV_SIFEN.ambiente]: "produccion" }));
  assert(!r5.ok);
  const r6 = await credencialesDesdeEnv(lector({ ...base, [ENV_SIFEN.timbrado]: "123" }));
  assert(!r6.ok && /8 dígitos/.test(r6.error));
});
