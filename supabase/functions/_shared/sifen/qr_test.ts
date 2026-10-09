import { assert, assertEquals, assertStringIncludes, assertThrows } from "@std/assert";
import { aHex, armarQr, cadenaParametrosQr, CSC_PRUEBA, sha256Hex, URL_QR, urlQr } from "./qr.ts";
import { armarXmlDEConOpciones } from "./xml.ts";
import { CDC_FE_PRUEBA_DIGEST, CRED, docFE, EMISOR, FECHA_FIRMA, firmar } from "./xml_fixtures_test.ts";

// Ejemplo oficial del MT v150 §13.8.3/13.8.4
const MT = {
  cdc: "01444444017001001001452822017012515873260988",
  fechaEmision: "2017-01-25T09:35:17",
  receptor: { campo: "dRucRec" as const, valor: "88899990" },
  totalGeneral: "300000",
  totalIva: "27272",
  cantidadItems: 2,
  digestValue: "yzGYhUx1/XYYzksWB+fPR3Qc50c=",
  cscId: "0001",
};

Deno.test("qr: ejemplo oficial del MT (hex y cHashQR 97ddbb3c…74ed)", () => {
  assertEquals(aHex(MT.fechaEmision), "323031372d30312d32355430393a33353a3137");
  assertEquals(aHex(MT.digestValue), "797a4759685578312f5859597a6b7357422b6650523351633530633d");
  const p = cadenaParametrosQr(MT);
  assertEquals(p, "nVersion=150&Id=01444444017001001001452822017012515873260988&dFeEmiDE=323031372d30312d32355430393a33353a3137&dRucRec=88899990&dTotGralOpe=300000&dTotIVA=27272&cItems=2&DigestValue=797a4759685578312f5859597a6b7357422b6650523351633530633d&IdCSC=0001");
  assertEquals(sha256Hex(p + CSC_PRUEBA["0001"]), "97ddbb3c1e7d65af03a70ffe21f2b34846ab1c89e0566c35222086766b7374ed");
  assertEquals(urlQr(MT, CSC_PRUEBA["0001"], "prod"), `https://ekuatia.set.gov.py/consultas/qr?${p}&cHashQR=97ddbb3c1e7d65af03a70ffe21f2b34846ab1c89e0566c35222086766b7374ed`);
});

Deno.test("qr: sha256 propio coincide con WebCrypto", async () => {
  for (const s of ["", "abc", "x".repeat(1000), "ñandú €"]) {
    const d = new Uint8Array(await crypto.subtle.digest("SHA-256", new TextEncoder().encode(s)));
    assertEquals(sha256Hex(s), Array.from(d).map((b) => b.toString(16).padStart(2, "0")).join(""));
  }
});

Deno.test("qr: armarQr con CSC de prueba inserta gCamFuFD después de la Signature", async () => {
  const { xml, cdc } = armarXmlDEConOpciones(docFE(), EMISOR, CRED, { fechaFirma: FECHA_FIRMA });
  const xmlFirmado = firmar(xml, cdc);
  const r = armarQr({ xmlFirmado, cdc, digestValue: CDC_FE_PRUEBA_DIGEST, csc: CSC_PRUEBA["0001"], cscId: "1", ambiente: "test" });
  assert(r.urlQr.startsWith(URL_QR.test + "nVersion=150&Id=" + cdc));
  assertStringIncludes(r.urlQr, "&dNumIDRec=0&dTotGralOpe=129000&dTotIVA=11727&cItems=1&");
  assertStringIncludes(r.urlQr, "&IdCSC=0001&cHashQR=");
  const params = r.urlQr.slice(URL_QR.test.length, r.urlQr.indexOf("&cHashQR="));
  const d = new Uint8Array(await crypto.subtle.digest("SHA-256", new TextEncoder().encode(params + CSC_PRUEBA["0001"])));
  assert(r.urlQr.endsWith(Array.from(d).map((b) => b.toString(16).padStart(2, "0")).join("")));
  assert(r.xmlConQr.endsWith(`</Signature><gCamFuFD><dCarQR>${r.urlQr.replace(/&/g, "&amp;")}</dCarQR></gCamFuFD></rDE>`));
  assert(!r.xmlConQr.includes("ABCD0000"), "el CSC nunca va en la URL");
});

Deno.test("qr: errores", () => {
  const { xml, cdc } = armarXmlDEConOpciones(docFE(), EMISOR, CRED, { fechaFirma: FECHA_FIRMA });
  const base = { cdc, digestValue: CDC_FE_PRUEBA_DIGEST, csc: CSC_PRUEBA["0001"], cscId: "0001", ambiente: "test" as const };
  assertThrows(() => armarQr({ ...base, xmlFirmado: xml }), Error, "no está firmado");
  assertThrows(() => armarQr({ ...base, xmlFirmado: firmar(xml, cdc), digestValue: "OTRO=" }), Error, "no coincide");
  assertThrows(() => armarQr({ ...base, xmlFirmado: firmar(xml, cdc), csc: "" }), Error, "CSC");
});
