// _shared/sifen/qr.ts · URL del código QR (con cHashQR por CSC) e inserción de gCamFuFD/dCarQR.
// Fuentes: Manual Técnico SIFEN v150, sección 13.8 "Código QR" (13.8.2 conformación, 13.8.3 metodología,
// 13.8.4 ejemplo paso a paso, 13.8.4.5 inserción con &amp;) y grupo J (J001 gCamFuFD, J002 dCarQR),
// que en el XSD (rDE) va DESPUÉS de ds:Signature.
// CSC de prueba publicados en la "Guía de Pruebas para e-kuatia" (DNIT): IdCSC 0001 = ABCD0000000000000000000000000000,
// IdCSC 0002 = EFGH0000000000000000000000000000 (son públicos, no son secretos).
//
// Orden de parámetros (MT 13.8.4.1): nVersion, Id, dFeEmiDE (hex), dRucRec | dNumIDRec, dTotGralOpe, dTotIVA,
// cItems, DigestValue (hex), IdCSC. cHashQR = SHA-256 hex de (parámetros + CSC). Si dTotGralOpe o dTotIVA no
// existen en el DE se completa con 0.
// URL base (MT 13.8.2): producción https://ekuatia.set.gov.py/consultas/qr? · test https://ekuatia.set.gov.py/consultas-test/qr?
// [VERIFICAR] el MT en 13.8.4.4 muestra también "https://www.ekuatia.set.gov.py/..."; el ejemplo final usa sin "www".

import type { AmbienteSifen, ArmarQr } from "./tipos.ts";
import { validarCdc } from "./cdc.ts";

export const URL_QR: Record<AmbienteSifen, string> = {
  prod: "https://ekuatia.set.gov.py/consultas/qr?",
  test: "https://ekuatia.set.gov.py/consultas-test/qr?",
};

/** CSC genéricos publicados por la DNIT para el ambiente de pruebas (Guía de Pruebas e-kuatia). */
export const CSC_PRUEBA = {
  "0001": "ABCD0000000000000000000000000000",
  "0002": "EFGH0000000000000000000000000000",
} as const;

export const VERSION_QR = "150"; // AA002 / nVersion

/** Cadena → hexadecimal de sus bytes UTF-8 (MT 13.8.3: dFeEmiDE y DigestValue se convierten a hex). */
export function aHex(s: string): string {
  return Array.from(new TextEncoder().encode(s)).map((b) => b.toString(16).padStart(2, "0")).join("");
}

/** SHA-256 en hexadecimal (síncrono, sin dependencias). */
export function sha256Hex(texto: string): string {
  const K = new Uint32Array([
    0x428a2f98, 0x71374491, 0xb5c0fbcf, 0xe9b5dba5, 0x3956c25b, 0x59f111f1, 0x923f82a4, 0xab1c5ed5,
    0xd807aa98, 0x12835b01, 0x243185be, 0x550c7dc3, 0x72be5d74, 0x80deb1fe, 0x9bdc06a7, 0xc19bf174,
    0xe49b69c1, 0xefbe4786, 0x0fc19dc6, 0x240ca1cc, 0x2de92c6f, 0x4a7484aa, 0x5cb0a9dc, 0x76f988da,
    0x983e5152, 0xa831c66d, 0xb00327c8, 0xbf597fc7, 0xc6e00bf3, 0xd5a79147, 0x06ca6351, 0x14292967,
    0x27b70a85, 0x2e1b2138, 0x4d2c6dfc, 0x53380d13, 0x650a7354, 0x766a0abb, 0x81c2c92e, 0x92722c85,
    0xa2bfe8a1, 0xa81a664b, 0xc24b8b70, 0xc76c51a3, 0xd192e819, 0xd6990624, 0xf40e3585, 0x106aa070,
    0x19a4c116, 0x1e376c08, 0x2748774c, 0x34b0bcb5, 0x391c0cb3, 0x4ed8aa4a, 0x5b9cca4f, 0x682e6ff3,
    0x748f82ee, 0x78a5636f, 0x84c87814, 0x8cc70208, 0x90befffa, 0xa4506ceb, 0xbef9a3f7, 0xc67178f2,
  ]);
  const datos = new TextEncoder().encode(texto);
  const largoBits = datos.length * 8;
  const total = Math.ceil((datos.length + 9) / 64) * 64;
  const m = new Uint8Array(total);
  m.set(datos);
  m[datos.length] = 0x80;
  const dv = new DataView(m.buffer);
  dv.setUint32(total - 8, Math.floor(largoBits / 2 ** 32));
  dv.setUint32(total - 4, largoBits >>> 0);
  const H = new Uint32Array([0x6a09e667, 0xbb67ae85, 0x3c6ef372, 0xa54ff53a, 0x510e527f, 0x9b05688c, 0x1f83d9ab, 0x5be0cd19]);
  const W = new Uint32Array(64);
  const rotr = (x: number, n: number) => (x >>> n) | (x << (32 - n));
  for (let off = 0; off < total; off += 64) {
    for (let i = 0; i < 16; i++) W[i] = dv.getUint32(off + i * 4);
    for (let i = 16; i < 64; i++) {
      const s0 = rotr(W[i - 15], 7) ^ rotr(W[i - 15], 18) ^ (W[i - 15] >>> 3);
      const s1 = rotr(W[i - 2], 17) ^ rotr(W[i - 2], 19) ^ (W[i - 2] >>> 10);
      W[i] = (W[i - 16] + s0 + W[i - 7] + s1) >>> 0;
    }
    let [a, b, c, d, e, f, g, h] = H;
    for (let i = 0; i < 64; i++) {
      const S1 = rotr(e, 6) ^ rotr(e, 11) ^ rotr(e, 25);
      const ch = (e & f) ^ (~e & g);
      const t1 = (h + S1 + ch + K[i] + W[i]) >>> 0;
      const S0 = rotr(a, 2) ^ rotr(a, 13) ^ rotr(a, 22);
      const maj = (a & b) ^ (a & c) ^ (b & c);
      const t2 = (S0 + maj) >>> 0;
      h = g;
      g = f;
      f = e;
      e = (d + t1) >>> 0;
      d = c;
      c = b;
      b = a;
      a = (t1 + t2) >>> 0;
    }
    H[0] = (H[0] + a) >>> 0;
    H[1] = (H[1] + b) >>> 0;
    H[2] = (H[2] + c) >>> 0;
    H[3] = (H[3] + d) >>> 0;
    H[4] = (H[4] + e) >>> 0;
    H[5] = (H[5] + f) >>> 0;
    H[6] = (H[6] + g) >>> 0;
    H[7] = (H[7] + h) >>> 0;
  }
  return Array.from(H).map((x) => x.toString(16).padStart(8, "0")).join("");
}

export interface ParametrosQr {
  cdc: string; // Id (A002)
  fechaEmision: string; // dFeEmiDE (D002) tal cual figura en el XML
  receptor: { campo: "dRucRec" | "dNumIDRec"; valor: string }; // D206 o D210
  totalGeneral: string; // dTotGralOpe (F014) o "0"
  totalIva: string; // dTotIVA (F017) o "0"
  cantidadItems: number; // ocurrencias de E701 (gCamItem)
  digestValue: string; // DigestValue (XS17), base64
  cscId: string; // IdCSC, 4 dígitos
}

/** Paso 1 del MT 13.8.4.1: cadena de parámetros en el orden oficial. */
export function cadenaParametrosQr(p: ParametrosQr): string {
  return `nVersion=${VERSION_QR}` +
    `&Id=${p.cdc}` +
    `&dFeEmiDE=${aHex(p.fechaEmision)}` +
    `&${p.receptor.campo}=${p.receptor.valor}` +
    `&dTotGralOpe=${p.totalGeneral}` +
    `&dTotIVA=${p.totalIva}` +
    `&cItems=${p.cantidadItems}` +
    `&DigestValue=${aHex(p.digestValue)}` +
    `&IdCSC=${p.cscId}`;
}

/** Pasos 2–4 del MT 13.8.4: hash con el CSC y URL final (con "&" crudos; en el XML van como &amp;). */
export function urlQr(p: ParametrosQr, csc: string, ambiente: AmbienteSifen): string {
  const params = cadenaParametrosQr(p);
  const hash = sha256Hex(params + csc);
  return `${URL_QR[ambiente]}${params}&cHashQR=${hash}`;
}

function valorTag(xml: string, tag: string): string | undefined {
  const m = new RegExp(`<(?:[A-Za-z0-9_]+:)?${tag}(?:\\s[^>]*)?>([^<]*)</(?:[A-Za-z0-9_]+:)?${tag}>`).exec(xml);
  return m ? m[1].trim() : undefined;
}

/** Extrae del XML firmado los datos que van al QR. */
export function parametrosDesdeXml(xml: string, cdc: string, digestValue: string, cscId: string): ParametrosQr {
  const fecha = valorTag(xml, "dFeEmiDE");
  if (!fecha) throw new Error("QR: el XML no tiene dFeEmiDE (D002).");
  const ruc = valorTag(xml, "dRucRec");
  const numId = valorTag(xml, "dNumIDRec");
  const receptor = ruc !== undefined
    ? { campo: "dRucRec" as const, valor: ruc }
    : { campo: "dNumIDRec" as const, valor: numId ?? "0" };
  const cantidadItems = (xml.match(/<(?:[A-Za-z0-9_]+:)?gCamItem>/g) ?? []).length;
  if (cantidadItems < 1) throw new Error("QR: el XML no tiene ítems (gCamItem).");
  return {
    cdc,
    fechaEmision: fecha,
    receptor,
    totalGeneral: valorTag(xml, "dTotGralOpe") ?? "0",
    totalIva: valorTag(xml, "dTotIVA") ?? "0",
    cantidadItems,
    digestValue,
    cscId,
  };
}

/** Contrato (tipos.ts): arma la URL del QR e inserta <gCamFuFD><dCarQR> después de la Signature, como hijo de rDE. */
export const armarQr: ArmarQr = ({ xmlFirmado, cdc, digestValue, csc, cscId, ambiente }) => {
  if (!validarCdc(cdc)) throw new Error(`QR: CDC inválido ("${cdc}").`);
  if (!URL_QR[ambiente]) throw new Error(`QR: ambiente inválido ("${ambiente}"). Use "test" o "prod".`);
  if (!/^[0-9]{1,4}$/.test(String(cscId ?? ""))) throw new Error(`QR: IdCSC inválido ("${cscId}"), deben ser hasta 4 dígitos.`);
  const idCsc = String(cscId).padStart(4, "0");
  if (!csc || typeof csc !== "string" || csc.trim().length === 0) throw new Error("QR: falta el CSC (código secreto del contribuyente).");
  if (!digestValue || !/^[A-Za-z0-9+/=]+$/.test(digestValue)) throw new Error("QR: DigestValue inválido (se espera base64).");
  if (!xmlFirmado.includes(`Id="${cdc}"`)) throw new Error("QR: el CDC no coincide con el Id del DE en el XML firmado.");
  const fin = /<\/(?:[A-Za-z0-9_]+:)?Signature>/.exec(xmlFirmado);
  if (!fin) throw new Error("QR: el XML no está firmado (no se encontró </Signature>). El QR va después de la firma.");
  if (/<(?:[A-Za-z0-9_]+:)?gCamFuFD[\s>]/.test(xmlFirmado)) throw new Error("QR: el XML ya tiene gCamFuFD.");
  const dvXml = valorTag(xmlFirmado, "DigestValue");
  if (dvXml !== undefined && dvXml !== digestValue) {
    throw new Error("QR: el DigestValue recibido no coincide con el de la firma del XML.");
  }
  const cierre = xmlFirmado.lastIndexOf("</rDE>");
  if (cierre < 0 || cierre < fin.index) throw new Error("QR: estructura inesperada; la Signature debe estar dentro de rDE.");
  const posInsercion = fin.index + fin[0].length;
  if (xmlFirmado.slice(posInsercion, cierre).trim() !== "") {
    throw new Error("QR: hay contenido entre la Signature y el cierre de rDE; no se puede ubicar gCamFuFD.");
  }

  const params = parametrosDesdeXml(xmlFirmado, cdc, digestValue, idCsc);
  const url = urlQr(params, csc.trim(), ambiente);
  // MT 13.8.4.5: reemplazar "&" por "&amp;" antes de insertar la URL en <dCarQR>.
  const nodo = `<gCamFuFD><dCarQR>${url.replace(/&/g, "&amp;")}</dCarQR></gCamFuFD>`; // J001 / J002
  const xmlConQr = xmlFirmado.slice(0, posInsercion) + nodo + xmlFirmado.slice(posInsercion);
  return { urlQr: url, xmlConQr };
};
