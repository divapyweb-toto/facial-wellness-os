// _shared/sifen/firma.ts · Firma XMLDSig ENVELOPED del DE (rDE/DE) y de eventos (rGesEve/rEve).
//
// Fuentes (verificadas 2026-10-08, https://www.dnit.gov.py/web/e-kuatia/documentacion-tecnica):
// - MT v150 §7.2.2.1 "Particularidad de la firma digital": <Signature xmlns="http://www.w3.org/2000/09/xmldsig#">
//   va como hija de <rDE>, inmediatamente DESPUÉS de <DE>; namespace declarado en la etiqueta Signature, sin prefijos.
// - MT v150 §7.6 (Schema XML 1, xmldsig-core-schema-v150.xsd) + ejemplo de la página 39:
//   · Reference URI = "#" + CDC (atributo Id del DE)
//   · CanonicalizationMethod (XS04) = http://www.w3.org/TR/2001/REC-xml-c14n-20010315 en el ejemplo
//   · SignatureMethod (XS06)        = http://www.w3.org/2001/04/xmldsig-more#rsa-sha256
//   · Transforms (XS13)             = http://www.w3.org/2000/09/xmldsig#enveloped-signature
//                                     + http://www.w3.org/2001/10/xml-exc-c14n#
//   · DigestMethod (XS16)           = http://www.w3.org/2001/04/xmlenc#sha256
//   · KeyInfo/X509Data/X509Certificate (XS19-XS21); NO incluir X509SubjectName, X509IssuerSerial,
//     X509IssuerName, X509SKI ni KeyValue/RSAKeyValue (MT §7.6).
// - MT v150 §7.7: transformaciones exigidas Enveloped + C14N exclusiva (xml-exc-c14n#).
// - NT016 (vigente desde 22-09-2023) §1.1: CanonicalizationMethod admite c14n INCLUSIVA o EXCLUSIVA
//   (con o sin comentarios); SignatureMethod rsa-sha256/384/512; DigestMethod sha256/384/512.
// - MT v150 §11.5 (Schema XML 19, GDE008): en eventos la Signature es hija de <rGesEve>, firma el grupo
//   <rEve Id="..."> (GDE002/GDE003).
//
// DECISIÓN (anotada para el reporte): por defecto CanonicalizationMethod = c14n EXCLUSIVA
// (http://www.w3.org/2001/10/xml-exc-c14n#), permitida por NT016. Motivo: con c14n INCLUSIVA el
// SignedInfo arrastra los namespaces de los ancestros (xmlns:xsi del rDE y, si SIFEN verifica dentro del
// sobre SOAP, también xmlns:soap) y la firma dejaría de verificar al moverse de contexto. La exclusiva no
// depende del contexto. Es además lo que usa la librería abierta TIPS-SA/facturacionelectronicapy-xmlsign
// (en producción vía FacturaSend). La inclusiva del ejemplo del MT queda disponible con
// { canonicalizacion: "inclusiva" }. [VERIFICAR en el ambiente de test de SIFEN / prevalidador.]

import { SignedXml } from "npm:xml-crypto@6.3.2";
import { DOMParser } from "npm:@xmldom/xmldom@0.8.15";
import type { FirmarXml } from "./tipos.ts";
import { type CertificadoCargado, cargarP12 } from "./certificado.ts";

export const ALG = {
  c14nInclusiva: "http://www.w3.org/TR/2001/REC-xml-c14n-20010315",
  c14nExclusiva: "http://www.w3.org/2001/10/xml-exc-c14n#",
  rsaSha256: "http://www.w3.org/2001/04/xmldsig-more#rsa-sha256",
  enveloped: "http://www.w3.org/2000/09/xmldsig#enveloped-signature",
  sha256: "http://www.w3.org/2001/04/xmlenc#sha256",
  nsDsig: "http://www.w3.org/2000/09/xmldsig#",
} as const;

export interface OpcionesFirma {
  /** CanonicalizationMethod del SignedInfo. Por defecto "exclusiva" (ver DECISIÓN arriba). */
  canonicalizacion?: "exclusiva" | "inclusiva";
  /** Transforms del Reference. Por defecto enveloped + exc-c14n (MT §7.6 ejemplo y §7.7). NT016 §1.1 lista
   *  XS12 1-1 solo con enveloped-signature → "solo_enveloped" queda disponible. [VERIFICAR en test SIFEN] */
  transforms?: "enveloped_y_exc_c14n" | "solo_enveloped";
}

export interface ResultadoFirma {
  xmlFirmado: string;
  digestValue: string;
}

const RE_ID = /^[A-Za-z0-9_-]{1,64}$/;

function contarIds(xml: string, id: string): number {
  return xml.split(`Id="${id}"`).length - 1;
}

/**
 * Firma con un certificado ya cargado (evita re-abrir el .p12 por cada DE de un lote).
 * La Signature se inserta como hermana inmediatamente posterior al elemento con Id=idReferencia
 * (DE → dentro de rDE, MT §7.2.2.1; rEve → dentro de rGesEve, MT §11.5 GDE008).
 */
export function firmarConCertificado(
  xml: string,
  idReferencia: string,
  cert: CertificadoCargado,
  op: OpcionesFirma = {},
): ResultadoFirma {
  if (!RE_ID.test(idReferencia)) throw new Error(`Id de referencia inválido: "${idReferencia}"`);
  const n = contarIds(xml, idReferencia);
  if (n === 0) throw new Error(`No hay ningún elemento con Id="${idReferencia}" en el XML.`);
  if (n > 1) throw new Error(`Hay ${n} elementos con Id="${idReferencia}"; debe ser único.`);
  if (xml.includes(`<Signature xmlns="${ALG.nsDsig}"`)) {
    throw new Error("El XML ya contiene una firma; firmar sobre un XML ya firmado no está permitido.");
  }

  const sig = new SignedXml({
    privateKey: cert.clavePrivadaPem,
    publicCert: cert.certificadoPem, // genera KeyInfo/X509Data/X509Certificate (solo eso: MT §7.6)
    canonicalizationAlgorithm: op.canonicalizacion === "inclusiva" ? ALG.c14nInclusiva : ALG.c14nExclusiva,
    signatureAlgorithm: ALG.rsaSha256,
  });
  sig.addReference({
    xpath: `//*[@Id='${idReferencia}']`,
    uri: `#${idReferencia}`, // MT §7.6: "#" + CDC en el atributo URI de Reference
    transforms: op.transforms === "solo_enveloped" ? [ALG.enveloped] : [ALG.enveloped, ALG.c14nExclusiva], // MT §7.6 ejemplo y §7.7
    digestAlgorithm: ALG.sha256,
  });
  sig.computeSignature(xml, {
    location: { reference: `//*[@Id='${idReferencia}']`, action: "after" },
  });
  const xmlFirmado = sig.getSignedXml();
  const m = /<DigestValue>([^<]+)<\/DigestValue>/.exec(xmlFirmado);
  if (!m) throw new Error("No se encontró DigestValue en el XML firmado.");
  return { xmlFirmado, digestValue: m[1].trim() };
}

/** Firma con opciones (canonicalización). Misma semántica que firmarXml. */
export function firmarXmlConOpciones(
  xml: string,
  idReferencia: string,
  certP12: Uint8Array,
  clave: string,
  op: OpcionesFirma = {},
): Promise<ResultadoFirma> {
  return Promise.resolve().then(() => firmarConCertificado(xml, idReferencia, cargarP12(certP12, clave), op));
}

/** Contrato (tipos.ts): firma XMLDSig del nodo con Id=idReferencia (CDC del DE o Id del evento). */
export const firmarXml: FirmarXml = (xml, idReferencia, certP12, clave) =>
  firmarXmlConOpciones(xml, idReferencia, certP12, clave);

export interface ResultadoVerificacion {
  ok: boolean;
  errores: string[];
}

/**
 * Autoverificación criptográfica (integridad + valor de firma) con el certificado del propio KeyInfo.
 * NO valida la cadena de confianza ni la LCR (eso lo hace SIFEN, MT §7.8). Sirve para detectar un XML
 * modificado después de firmar antes de enviarlo.
 * `idReferencia` opcional: si se pasa, exige que la firma referencie "#id".
 */
export function verificarFirma(xmlFirmado: string, idReferencia?: string): ResultadoVerificacion {
  try {
    const doc = new DOMParser().parseFromString(xmlFirmado, "text/xml");
    const firmas = doc.getElementsByTagNameNS(ALG.nsDsig, "Signature");
    if (firmas.length === 0) return { ok: false, errores: ["No hay <Signature>."] };
    const errores: string[] = [];
    for (let i = 0; i < firmas.length; i++) {
      const s = firmas[i];
      const certNodo = s.getElementsByTagNameNS(ALG.nsDsig, "X509Certificate")[0];
      const b64 = certNodo?.textContent?.replace(/\s+/g, "");
      if (!b64) {
        errores.push("Falta X509Certificate en KeyInfo.");
        continue;
      }
      const pem = `-----BEGIN CERTIFICATE-----\n${b64.match(/.{1,64}/g)!.join("\n")}\n-----END CERTIFICATE-----\n`;
      if (idReferencia) {
        const ref = s.getElementsByTagNameNS(ALG.nsDsig, "Reference")[0];
        if (ref?.getAttribute("URI") !== `#${idReferencia}`) {
          errores.push(`La firma no referencia #${idReferencia}.`);
          continue;
        }
      }
      const v = new SignedXml({ publicCert: pem });
      v.loadSignature(s as unknown as Node);
      try {
        if (!v.checkSignature(xmlFirmado)) errores.push("Firma inválida.");
      } catch (e) {
        errores.push((e as Error).message);
      }
    }
    return { ok: errores.length === 0, errores };
  } catch (e) {
    return { ok: false, errores: [(e as Error).message] };
  }
}
