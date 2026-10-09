// Tests de firma.ts: firma + verificación con xml-crypto y verificación PROPIA independiente
// (c14n hecha a mano para este caso + RSA con WebCrypto). Datos inventados.
import { assert, assertEquals, assertMatch, assertRejects, assertThrows } from "jsr:@std/assert@1";
import { ALG, firmarConCertificado, firmarXml, firmarXmlConOpciones, verificarFirma } from "./firma.ts";
import { cargarP12, generarCertificadoPrueba } from "./certificado.ts";

const NS = "http://ekuatia.set.gov.py/sifen/xsd";
const CDC_PRUEBA = "01" + "80000000" + "0" + "001" + "001" + "0000001" + "2" + "20261008" + "1" + "123456789" + "2";

function rdePrueba(cdc = CDC_PRUEBA, extra = "") {
  return `<rDE xmlns="${NS}" xmlns:xsi="http://www.w3.org/2001/XMLSchema-instance" xsi:schemaLocation="${NS} siRecepDE_v150.xsd"><dVerFor>150</dVerFor><DE Id="${cdc}"><dDVId>2</dDVId><dFecFirma>2026-10-08T10:00:00</dFecFirma><gDatGralOpe><dFeEmiDE>2026-10-08T09:59:00</dFeEmiDE></gDatGralOpe><gDtipDE><gCamItem><dDesProSer>DOCUMENTO ELECTRÓNICO SIN VALOR COMERCIAL NI FISCAL - GENERADO EN AMBIENTE DE PRUEBA &amp; más</dDesProSer><dCantProSer>2</dCantProSer></gCamItem></gDtipDE>${extra}</DE></rDE>`;
}

function eventoPrueba(id = "123") {
  return `<gGroupGesEve xmlns="${NS}" xmlns:xsi="http://www.w3.org/2001/XMLSchema-instance"><rGesEve xsi:schemaLocation="${NS} siRecepEvento_v150.xsd"><rEve Id="${id}"><dFecFirma>2026-10-08T10:00:00</dFecFirma><dVerFor>150</dVerFor><gGroupTiEvt><rGeVeCan><Id>${CDC_PRUEBA}</Id><mOtEve>Prueba de cancelación</mOtEve></rGeVeCan></gGroupTiEvt></rEve></rGesEve></gGroupGesEve>`;
}

// ── Verificación propia (independiente de xml-crypto) ──
// Válida para XML generado SIN prefijos, sin comentarios y con atributos ya en orden (como exige MT §7.2.4).
function b64aBytes(b64: string) {
  const bin = atob(b64);
  return Uint8Array.from(bin, (c) => c.charCodeAt(0));
}
function expandirVacios(x: string) {
  return x.replace(/<(\w+)((?:\s[^<>]*?)?)\/>/g, "<$1$2></$1>");
}
/** exc-c14n del elemento con Id: subárbol sin la Signature, con xmlns del elemento (único ns visible). */
function excC14nElemento(xml: string, tag: string, id: string, ns: string) {
  const ini = xml.indexOf(`<${tag} Id="${id}"`);
  const fin = xml.indexOf(`</${tag}>`, ini) + `</${tag}>`.length;
  const el = xml.slice(ini, fin);
  return expandirVacios(el.replace(`<${tag} Id=`, `<${tag} xmlns="${ns}" Id=`));
}
async function verificacionPropia(xmlFirmado: string, tag: string, id: string, ns = NS) {
  const certB64 = /<X509Certificate>([^<]+)<\/X509Certificate>/.exec(xmlFirmado)![1];
  const digest = /<DigestValue>([^<]+)<\/DigestValue>/.exec(xmlFirmado)![1];
  const sv = /<SignatureValue>([^<]+)<\/SignatureValue>/.exec(xmlFirmado)![1];
  // 1) Digest = SHA-256(exc-c14n(elemento)) (MT §7.6: enveloped + exc-c14n; DigestMethod sha256)
  const c14n = excC14nElemento(xmlFirmado, tag, id, ns);
  const h = new Uint8Array(await crypto.subtle.digest("SHA-256", new TextEncoder().encode(c14n)));
  const digestPropio = btoa(String.fromCharCode(...h));
  // 2) SignatureValue = RSA-SHA256 sobre exc-c14n(SignedInfo)
  const si = /<SignedInfo>[\s\S]*<\/SignedInfo>/.exec(xmlFirmado)![0];
  const siC14n = expandirVacios(si).replace("<SignedInfo>", `<SignedInfo xmlns="${ALG.nsDsig}">`);
  const { X509Certificate } = await import("node:crypto");
  const spki = new Uint8Array(new X509Certificate(Buffer.from(certB64, "base64")).publicKey.export({ type: "spki", format: "der" }));
  const clave = await crypto.subtle.importKey("spki", spki, { name: "RSASSA-PKCS1-v1_5", hash: "SHA-256" }, false, ["verify"]);
  const firmaOk = await crypto.subtle.verify("RSASSA-PKCS1-v1_5", clave, b64aBytes(sv), new TextEncoder().encode(siC14n));
  return { digestOk: digestPropio === digest, firmaOk, digestPropio };
}
import { Buffer } from "node:buffer";

Deno.test("firma rDE: estructura y algoritmos del MT §7.6", async () => {
  const c = await generarCertificadoPrueba();
  const { xmlFirmado, digestValue } = await firmarXml(rdePrueba(), CDC_PRUEBA, c.p12, c.clave);
  // Signature hija de rDE, inmediatamente después de </DE>, sin prefijo y con su xmlns (MT §7.2.2.1)
  assert(xmlFirmado.includes(`</DE><Signature xmlns="${ALG.nsDsig}"><SignedInfo>`));
  assert(xmlFirmado.endsWith("</Signature></rDE>"));
  assert(xmlFirmado.includes(`<Reference URI="#${CDC_PRUEBA}">`));
  assert(xmlFirmado.includes(`<SignatureMethod Algorithm="${ALG.rsaSha256}"/>`));
  assert(xmlFirmado.includes(`<CanonicalizationMethod Algorithm="${ALG.c14nExclusiva}"/>`));
  assert(xmlFirmado.includes(`<Transforms><Transform Algorithm="${ALG.enveloped}"/><Transform Algorithm="${ALG.c14nExclusiva}"/></Transforms>`));
  assert(xmlFirmado.includes(`<DigestMethod Algorithm="${ALG.sha256}"/>`));
  assertMatch(xmlFirmado, /<KeyInfo><X509Data><X509Certificate>[A-Za-z0-9+/=]+<\/X509Certificate><\/X509Data><\/KeyInfo>/);
  for (const prohibido of ["X509SubjectName", "X509IssuerSerial", "X509IssuerName", "X509SKI", "KeyValue", "RSAKeyValue"]) {
    assert(!xmlFirmado.includes(prohibido), `no debe incluir ${prohibido} (MT §7.6)`);
  }
  assertMatch(digestValue, /^[A-Za-z0-9+/]{43}=$/); // SHA-256 en base64 = 44 caracteres
  assert(!xmlFirmado.includes("\n"), "sin saltos de línea (MT §7.2.4)");
});

Deno.test("firma rDE: verifica con xml-crypto y con verificación propia (WebCrypto)", async () => {
  const c = await generarCertificadoPrueba();
  const { xmlFirmado, digestValue } = await firmarXml(rdePrueba(), CDC_PRUEBA, c.p12, c.clave);
  assertEquals(verificarFirma(xmlFirmado, CDC_PRUEBA), { ok: true, errores: [] });
  const p = await verificacionPropia(xmlFirmado, "DE", CDC_PRUEBA);
  assert(p.digestOk, "digest propio == DigestValue");
  assertEquals(p.digestPropio, digestValue);
  assert(p.firmaOk, "RSA-SHA256 verificada con WebCrypto");
});

Deno.test("firma rDE: cambiar 1 carácter invalida la firma (ambas verificaciones)", async () => {
  const c = await generarCertificadoPrueba();
  const { xmlFirmado } = await firmarXml(rdePrueba(), CDC_PRUEBA, c.p12, c.clave);
  const alterado = xmlFirmado.replace("<dCantProSer>2</dCantProSer>", "<dCantProSer>3</dCantProSer>");
  assert(alterado !== xmlFirmado);
  assertEquals(verificarFirma(alterado).ok, false);
  assertEquals((await verificacionPropia(alterado, "DE", CDC_PRUEBA)).digestOk, false);
  // Alterar el SignedInfo (no el DE) también la invalida
  const alteradoSi = xmlFirmado.replace(`URI="#${CDC_PRUEBA}"`, `URI="#${CDC_PRUEBA.slice(0, -1)}3"`);
  assertEquals(verificarFirma(alteradoSi).ok, false);
});

Deno.test("firma rDE: sigue verificando dentro del sobre SOAP y del rLoteDE (c14n exclusiva)", async () => {
  const c = await generarCertificadoPrueba();
  const { xmlFirmado } = await firmarXml(rdePrueba(), CDC_PRUEBA, c.p12, c.clave);
  const enSobre = `<soap:Envelope xmlns:soap="http://www.w3.org/2003/05/soap-envelope"><soap:Header/><soap:Body><rEnviDe xmlns="${NS}"><dId>1</dId><xDE>${xmlFirmado}</xDE></rEnviDe></soap:Body></soap:Envelope>`;
  assert(verificarFirma(enSobre).ok, "verifica en contexto SOAP");
  assert(verificarFirma(`<rLoteDE>${xmlFirmado}</rLoteDE>`).ok, "verifica dentro de rLoteDE");
});

Deno.test("firma rDE inclusiva (ejemplo MT): válida sola, pero se rompe dentro del sobre SOAP (riesgo documentado)", async () => {
  const c = await generarCertificadoPrueba();
  const { xmlFirmado } = await firmarXmlConOpciones(rdePrueba(), CDC_PRUEBA, c.p12, c.clave, { canonicalizacion: "inclusiva" });
  assert(xmlFirmado.includes(`<CanonicalizationMethod Algorithm="${ALG.c14nInclusiva}"/>`));
  assert(verificarFirma(xmlFirmado).ok);
  const enSobre = `<soap:Envelope xmlns:soap="http://www.w3.org/2003/05/soap-envelope"><soap:Body><rEnviDe xmlns="${NS}"><xDE>${xmlFirmado}</xDE></rEnviDe></soap:Body></soap:Envelope>`;
  assertEquals(verificarFirma(enSobre).ok, false);
});

Deno.test("firma opción solo_enveloped (NT016) también verifica", async () => {
  const c = await generarCertificadoPrueba();
  const { xmlFirmado } = await firmarXmlConOpciones(rdePrueba(), CDC_PRUEBA, c.p12, c.clave, { transforms: "solo_enveloped" });
  assert(xmlFirmado.includes(`<Transforms><Transform Algorithm="${ALG.enveloped}"/></Transforms>`));
  assert(verificarFirma(xmlFirmado, CDC_PRUEBA).ok);
});

Deno.test("firma de evento: Signature hija de rGesEve tras rEve, URI=#Id del evento (MT §11.5 GDE008)", async () => {
  const c = await generarCertificadoPrueba();
  const { xmlFirmado, digestValue } = await firmarXml(eventoPrueba("987"), "987", c.p12, c.clave);
  assert(xmlFirmado.includes(`</rEve><Signature xmlns="${ALG.nsDsig}">`));
  assert(xmlFirmado.includes("</Signature></rGesEve></gGroupGesEve>"));
  assert(xmlFirmado.includes(`<Reference URI="#987">`));
  assert(verificarFirma(xmlFirmado, "987").ok);
  const p = await verificacionPropia(xmlFirmado, "rEve", "987");
  assert(p.digestOk && p.firmaOk);
  assertEquals(p.digestPropio, digestValue);
  assertEquals(verificarFirma(xmlFirmado.replace("Prueba de cancelación", "Prueba de cancelacion")).ok, false);
});

Deno.test("firma: con .p12 generado por scripts/sifen-cert-prueba.sh (openssl)", async () => {
  const hayOpenssl = await new Deno.Command("sh", { args: ["-c", "command -v openssl"] }).output().then((o) => o.success).catch(() => false);
  if (!hayOpenssl) return;
  const dir = await Deno.makeTempDir({ prefix: "sifen-firma-" });
  try {
    const script = new URL("../../../../scripts/sifen-cert-prueba.sh", import.meta.url).pathname;
    const out = await new Deno.Command("bash", { args: [script, dir, "80000002", "7"] }).output();
    assert(out.success, new TextDecoder().decode(out.stderr));
    const texto = new TextDecoder().decode(out.stdout);
    const clave = /Clave del \.p12: (\S+)/.exec(texto)![1];
    const p12 = await Deno.readFile(`${dir}/sifen-prueba-RUC80000002.p12`);
    const { xmlFirmado } = await firmarXml(rdePrueba(), CDC_PRUEBA, p12, clave);
    assert(verificarFirma(xmlFirmado, CDC_PRUEBA).ok);
    assert((await verificacionPropia(xmlFirmado, "DE", CDC_PRUEBA)).firmaOk);
  } finally {
    await Deno.remove(dir, { recursive: true });
  }
});

Deno.test("firma: errores claros (Id inexistente, duplicado, ya firmado, clave mala)", async () => {
  const c = await generarCertificadoPrueba();
  const cert = cargarP12(c.p12, c.clave);
  assertThrows(() => firmarConCertificado(rdePrueba(), "999", cert), Error, "No hay ningún elemento");
  assertThrows(() => firmarConCertificado(rdePrueba(), "x' or '1'='1", cert), Error, "inválido");
  const dup = rdePrueba(CDC_PRUEBA, `<x Id="${CDC_PRUEBA}"></x>`);
  assertThrows(() => firmarConCertificado(dup, CDC_PRUEBA, cert), Error, "único");
  const { xmlFirmado } = firmarConCertificado(rdePrueba(), CDC_PRUEBA, cert);
  assertThrows(() => firmarConCertificado(xmlFirmado, CDC_PRUEBA, cert), Error, "ya contiene una firma");
  await assertRejects(() => firmarXml(rdePrueba(), CDC_PRUEBA, c.p12, "mala"), Error, "clave");
});
