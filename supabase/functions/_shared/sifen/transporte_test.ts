// Tests de transporte.ts: clasificación de errores, TransporteSimulado y mTLS REAL contra un servidor
// HTTPS local que exige certificado de cliente (node:https con requestCert, CA/certs generados en memoria).
import { assert, assertEquals, assertMatch, assertRejects } from "jsr:@std/assert@1";
import https from "node:https";
import forge from "npm:node-forge@1.4.0";
import { generarParRsa } from "./certificado.ts";
import { clasificarErrorRed, ErrorTransporte, TransporteMtlsDeno, TransporteSimulado, transporteDesdeEnv } from "./transporte.ts";
import { generarCertificadoPrueba } from "./certificado.ts";

Deno.test("clasificarErrorRed: qué errores permiten reintentar sin riesgo de duplicado", () => {
  const c = (m: string, name = "TypeError") => clasificarErrorRed(Object.assign(new Error(m), { name }));
  assertEquals([c("dns error: failed to lookup address").tipo, c("dns error").posibleRecepcion], ["dns", false]);
  assertEquals([c("Connection refused (os error 61)").tipo, c("Connection refused").posibleRecepcion], ["conexion", false]);
  assertEquals([c("invalid peer certificate: UnknownIssuer").tipo, c("tls handshake eof").posibleRecepcion], ["tls", false]);
  assertEquals([c("signal timed out", "TimeoutError").tipo, c("x", "TimeoutError").posibleRecepcion], ["timeout", true]);
  assertEquals([c("connection reset by peer").tipo, c("connection reset by peer").posibleRecepcion], ["corte", true]);
  assertEquals(c("algo raro").posibleRecepcion, true, "ante la duda: consultar antes de reenviar");
});

Deno.test("TransporteSimulado: aprobado, rechazado, timeout, lento, sin conexión", async () => {
  const t = new TransporteSimulado({ escenario: "rechazado", codigoRechazo: "1003", mensajeRechazo: "DV del CDC inválido" });
  const soapRuc = `<soap:Envelope xmlns:soap="x"><soap:Body><rEnviConsRUC xmlns="y"><dId>1</dId><dRUCCons>80000005</dRUCCons></rEnviConsRUC></soap:Body></soap:Envelope>`;
  assertMatch((await t.post("u", soapRuc)).body, /<ns2:dCodRes>0500</);
  t.escenario = "aprobado";
  assertMatch((await t.post("u", soapRuc)).body, /<ns2:dCodRes>0502</);
  t.escenario = "timeout";
  const e = await assertRejects(() => t.post("u", soapRuc), ErrorTransporte);
  assertEquals([e.tipo, e.posibleRecepcion], ["timeout", true]);
  t.escenario = "sin_conexion";
  const e2 = await assertRejects(() => t.post("u", soapRuc), ErrorTransporte);
  assertEquals(e2.posibleRecepcion, false);
  const lento = new TransporteSimulado({ escenario: "lento", demoraMs: 30, timeoutMs: 1000 });
  assertEquals((await lento.post("u", soapRuc)).status, 200);
  const muyLento = new TransporteSimulado({ escenario: "lento", demoraMs: 5000, timeoutMs: 20 });
  assertEquals((await assertRejects(() => muyLento.post("u", soapRuc), ErrorTransporte)).tipo, "timeout");
  assertEquals(t.contar("rEnviConsRUC"), 4);
});

Deno.test("transporteDesdeEnv: MODO_SIMULADO=1 → simulado; si no, mTLS con el .p12", async () => {
  const c = await generarCertificadoPrueba();
  assert(transporteDesdeEnv({ certP12: c.p12, certClave: c.clave }, (n) => n === "MODO_SIMULADO" ? "1" : undefined) instanceof TransporteSimulado);
  const t = transporteDesdeEnv({ certP12: c.p12, certClave: c.clave }, () => undefined);
  assert(t instanceof TransporteMtlsDeno);
  (t as TransporteMtlsDeno).cerrar();
});

// ── mTLS real ──
async function emitir(cn: string, ca?: { key: forge.pki.rsa.PrivateKey; cert: forge.pki.Certificate }, ext: Record<string, unknown>[] = []) {
  const { privateKey, publicKey } = await generarParRsa();
  const cert = forge.pki.createCertificate();
  cert.publicKey = publicKey;
  cert.serialNumber = "0" + Math.floor(Math.random() * 1e9).toString(16);
  cert.validity.notBefore = new Date(Date.now() - 864e5);
  cert.validity.notAfter = new Date(Date.now() + 864e5);
  cert.setSubject([{ name: "commonName", value: cn }]);
  cert.setIssuer(ca ? ca.cert.subject.attributes : [{ name: "commonName", value: cn }]);
  cert.setExtensions(ext);
  cert.sign(ca?.key ?? privateKey, forge.md.sha256.create());
  return { key: privateKey, cert, keyPem: forge.pki.privateKeyToPem(privateKey), certPem: forge.pki.certificateToPem(cert) };
}

Deno.test("TransporteMtlsDeno: mTLS real contra servidor local que exige certificado de cliente", async () => {
  const ca = await emitir("CA PRUEBA LOCAL", undefined, [{ name: "basicConstraints", cA: true }, { name: "keyUsage", keyCertSign: true, cRLSign: true }]);
  const srv = await emitir("localhost", ca, [{ name: "subjectAltName", altNames: [{ type: 2, value: "localhost" }] }, { name: "extKeyUsage", serverAuth: true }]);
  const cli = await emitir("CLIENTE RUC80000000-0", ca, [{ name: "extKeyUsage", clientAuth: true }]);
  const recibidos: string[] = [];
  const server = https.createServer(
    { key: srv.keyPem, cert: srv.certPem, ca: ca.certPem, requestCert: true, rejectUnauthorized: true, minVersion: "TLSv1.2" },
    (req, res) => {
      let b = "";
      req.on("data", (c: Uint8Array) => b += new TextDecoder().decode(c));
      req.on("end", () => {
        // deno-lint-ignore no-explicit-any
        const peer = (req.socket as any).getPeerCertificate?.()?.subject?.CN ?? "?";
        recibidos.push(`${req.method} ${req.headers["content-type"]} ${peer} ${b}`);
        res.writeHead(200, { "content-type": "application/soap+xml" });
        res.end("<ok/>");
      });
    },
  );
  await new Promise<void>((r) => server.listen(0, "127.0.0.1", () => r()));
  const puerto = (server.address() as { port: number }).port;
  const url = `https://localhost:${puerto}/de/ws/sync/recibe.wsdl`;
  try {
    const t = new TransporteMtlsDeno({ certPem: cli.certPem, keyPem: cli.keyPem, caCerts: [ca.certPem], timeoutMs: 5000 });
    const r = await t.post(url, "<soap/>");
    assertEquals(r, { status: 200, body: "<ok/>" });
    assertEquals(recibidos[0], "POST application/xml; charset=utf-8 CLIENTE RUC80000000-0 <soap/>");
    t.cerrar();

    // Sin certificado de cliente: el servidor corta el handshake → error SIN posible recepción.
    const sinCert = Deno.createHttpClient({ caCerts: [ca.certPem] });
    const e = await assertRejects(() => fetch(url, { method: "POST", body: "x", client: sinCert } as RequestInit).then((r) => r.text()));
    const ce = clasificarErrorRed(e);
    assertEquals([ce.tipo, ce.posibleRecepcion], ["tls", false], ce.message);
    sinCert.close();
    assertEquals(recibidos.length, 1, "el servidor nunca procesó la petición sin certificado");

    // Certificado de otra CA → rechazado.
    const otraCa = await emitir("OTRA CA");
    const intruso = await emitir("INTRUSO", otraCa, [{ name: "extKeyUsage", clientAuth: true }]);
    const t2 = new TransporteMtlsDeno({ certPem: intruso.certPem, keyPem: intruso.keyPem, caCerts: [ca.certPem], timeoutMs: 5000 });
    await assertRejects(() => t2.post(url, "<soap/>"), ErrorTransporte);
    t2.cerrar();
    assertEquals(recibidos.length, 1);
  } finally {
    await new Promise<void>((r) => server.close(() => r()));
  }
});

Deno.test("TransporteMtlsDeno: puerto cerrado → error de conexión sin posible recepción", async () => {
  const c = await generarCertificadoPrueba();
  const t = new TransporteMtlsDeno({ certPem: c.certificadoPem, keyPem: c.clavePrivadaPem, timeoutMs: 3000 });
  const l = Deno.listen({ hostname: "127.0.0.1", port: 0 });
  const puerto = (l.addr as Deno.NetAddr).port;
  l.close(); // puerto libre y cerrado
  const e = await assertRejects(() => t.post(`https://127.0.0.1:${puerto}/x`, "<a/>"), ErrorTransporte);
  assertEquals(e.tipo, "conexion");
  assertEquals(e.posibleRecepcion, false);
  t.cerrar();
});
