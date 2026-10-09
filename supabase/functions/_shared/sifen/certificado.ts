// _shared/sifen/certificado.ts · Carga del certificado del contribuyente (.p12/.pfx) y credenciales SIFEN.
//
// Fuentes (verificadas el 2026-10-08 en https://www.dnit.gov.py/web/e-kuatia/documentacion-tecnica):
// - Manual Técnico SIFEN v150 (MT), §7.5 "Estándar de certificado digital":
//   · el mismo certificado sirve para FIRMAR y para la conexión TLS con autenticación mutua;
//   · para la conexión debe tener Extended Key Usage = clientAuth;
//   · persona jurídica: RUC en Subject, atributo "SerialNumber" OID 2.5.4.5;
//     persona física: RUC en SubjectAlternativeName, "SerialNumber" OID 2.5.4.5;
//   · formato del valor: "RUCXXXXXXXX-X" (RUC + guion + DV, sin espacios).
// - MT §7.7: RSA 2048 (software) o 2048/4096 (hardware), SHA-2.
// - Nota Técnica 16 (NT016) §1.3, validación AC01: KeyUsage debe definir firma digital y no repudio.
// - Guía de Pruebas e-kuatia (feb-2026) §4.1: en el ambiente de TEST de SIFEN se exige un certificado
//   cualificado VÁLIDO con el RUC del contribuyente; los autogenerados solo sirven para el escenario
//   "certificado NO VÁLIDO". Por eso el autofirmado de este archivo es SOLO para firmar localmente
//   (MODO_SIMULADO=1) y para tests: SIFEN lo va a rechazar.
//
// Nada de secretos en este archivo: el .p12 y su clave llegan por variables de entorno (ENV_SIFEN).

import forge from "npm:node-forge@1.4.0";
import { type AmbienteSifen, type CredencialesSifen, ENV_SIFEN } from "./tipos.ts";

/** Datos útiles de un certificado ya cargado. */
export interface CertificadoCargado {
  /** Clave privada en PEM (PKCS#8 o PKCS#1 según forge). Uso: firma XML y mTLS. */
  clavePrivadaPem: string;
  /** Certificado del titular (end-entity) en PEM. */
  certificadoPem: string;
  /** Cadena completa en PEM (titular primero, luego intermedias si el .p12 las trae). Uso: mTLS. */
  cadenaPem: string;
  /** DER del certificado del titular en base64 (sin saltos): valor de <X509Certificate> (MT §7.6, XS21). */
  certificadoBase64: string;
  /** RUC sin DV si el certificado lo trae (MT §7.5), si no, undefined. */
  ruc?: string;
  dv?: string;
  /** Subject e issuer legibles ("CN=..., serialNumber=..."). */
  sujeto: string;
  emisor: string;
  validoDesde: Date;
  venceEl: Date;
  /** true si tiene extendedKeyUsage con clientAuth (MT §7.5, requisito para la conexión mTLS). */
  clientAuth: boolean;
  /** true si sujeto == emisor (autofirmado: no sirve contra SIFEN real). */
  autofirmado: boolean;
}

/** Error de carga con mensaje claro para el panel/logs (nunca incluye la clave). */
export class ErrorCertificado extends Error {
  constructor(mensaje: string) {
    super(mensaje);
    this.name = "ErrorCertificado";
  }
}

const OID_SERIAL_NUMBER = "2.5.4.5"; // MT §7.5
const RE_RUC = /RUC\s*(\d{1,8})\s*-\s*(\d)/i;

function nombreLegible(attrs: forge.pki.CertificateField[]): string {
  return attrs
    .map((a) => `${a.shortName ?? a.name ?? a.type}=${a.value}`)
    .join(", ");
}

/** Extrae RUC/DV según MT §7.5: Subject SerialNumber (jurídica) → SAN (física) → CN como último recurso. */
function extraerRuc(cert: forge.pki.Certificate): { ruc?: string; dv?: string } {
  const candidatos: string[] = [];
  for (const a of cert.subject.attributes) {
    if (a.type === OID_SERIAL_NUMBER && typeof a.value === "string") candidatos.push(a.value);
  }
  // SubjectAlternativeName: forge no decodifica directoryName/otherName, así que se busca el patrón
  // "RUCxxxxxxxx-x" en los bytes crudos de la extensión (OID 2.5.29.17). [VERIFICAR con un certificado
  // real de persona física de un PSC paraguayo: la codificación exacta dentro del SAN.]
  for (const ext of cert.extensions as Array<{ id?: string; value?: string }>) {
    if (ext.id === "2.5.29.17" && typeof ext.value === "string") candidatos.push(ext.value);
  }
  for (const a of cert.subject.attributes) {
    if (a.shortName === "CN" && typeof a.value === "string") candidatos.push(a.value);
  }
  for (const c of candidatos) {
    const m = RE_RUC.exec(c);
    if (m) return { ruc: m[1], dv: m[2] };
  }
  return {};
}

function tieneClientAuth(cert: forge.pki.Certificate): boolean {
  const eku = cert.getExtension("extKeyUsage") as { clientAuth?: boolean } | null;
  return !!eku?.clientAuth;
}

function derBase64(cert: forge.pki.Certificate): string {
  return forge.util.encode64(forge.asn1.toDer(forge.pki.certificateToAsn1(cert)).getBytes());
}

function bytesABinario(b: Uint8Array): string {
  let s = "";
  const paso = 0x8000;
  for (let i = 0; i < b.length; i += paso) s += String.fromCharCode(...b.subarray(i, i + paso));
  return s;
}

function mismoModulo(cert: forge.pki.Certificate, key: forge.pki.rsa.PrivateKey): boolean {
  const pub = cert.publicKey as forge.pki.rsa.PublicKey;
  return !!pub?.n && pub.n.equals(key.n);
}

/**
 * Carga un .p12/.pfx (bytes + clave). Devuelve PEMs, base64 DER, RUC, vencimiento y clientAuth.
 * Lanza ErrorCertificado con mensaje claro si la clave es incorrecta o falta la clave privada.
 */
export function cargarP12(p12: Uint8Array, clave: string): CertificadoCargado {
  if (!p12 || p12.length === 0) throw new ErrorCertificado("El certificado .p12 está vacío.");
  let p: forge.pkcs12.Pkcs12Pfx;
  try {
    const asn1 = forge.asn1.fromDer(forge.util.createBuffer(bytesABinario(p12)));
    p = forge.pkcs12.pkcs12FromAsn1(asn1, false, clave);
  } catch (e) {
    const msg = (e as Error).message ?? String(e);
    if (/mac|password|invalid/i.test(msg)) {
      throw new ErrorCertificado("No se pudo abrir el .p12: la clave (SIFEN_CERT_CLAVE) es incorrecta o el archivo está dañado.");
    }
    throw new ErrorCertificado(`No se pudo leer el .p12 (¿es un .p12/.pfx en base64 correcto?): ${msg}`);
  }

  type Bolsa = { cert?: forge.pki.Certificate; key?: forge.pki.PrivateKey };
  const certBags: Bolsa[] = p.getBags({ bagType: forge.pki.oids.certBag })[forge.pki.oids.certBag] ?? [];
  const keyBags: Bolsa[] = [
    ...(p.getBags({ bagType: forge.pki.oids.pkcs8ShroudedKeyBag })[forge.pki.oids.pkcs8ShroudedKeyBag] ?? []),
    ...(p.getBags({ bagType: forge.pki.oids.keyBag })[forge.pki.oids.keyBag] ?? []),
  ];
  const certs: forge.pki.Certificate[] = certBags.map((b) => b.cert).filter((c): c is forge.pki.Certificate => !!c);
  const key = keyBags.map((b) => b.key).find((k) => !!k) as forge.pki.rsa.PrivateKey | undefined;
  if (!key) throw new ErrorCertificado("El .p12 no contiene clave privada (se necesita para firmar).");
  if (certs.length === 0) throw new ErrorCertificado("El .p12 no contiene certificados.");

  // El certificado del titular es el que corresponde a la clave privada; el resto es la cadena.
  const titular = certs.find((c) => mismoModulo(c, key));
  if (!titular) throw new ErrorCertificado("Ningún certificado del .p12 corresponde a la clave privada.");
  const resto = certs.filter((c) => c !== titular);

  const { ruc, dv } = extraerRuc(titular);
  const sujeto = nombreLegible(titular.subject.attributes);
  const emisor = nombreLegible(titular.issuer.attributes);
  const certificadoPem = forge.pki.certificateToPem(titular);
  return {
    clavePrivadaPem: forge.pki.privateKeyToPem(key),
    certificadoPem,
    cadenaPem: [certificadoPem, ...resto.map((c) => forge.pki.certificateToPem(c))].join(""),
    certificadoBase64: derBase64(titular),
    ruc,
    dv,
    sujeto,
    emisor,
    validoDesde: titular.validity.notBefore,
    venceEl: titular.validity.notAfter,
    clientAuth: tieneClientAuth(titular),
    autofirmado: titular.isIssuer(titular),
  };
}

/** Avisos no bloqueantes sobre el certificado (vencido, sin clientAuth, autofirmado, RUC distinto). */
export function avisosCertificado(c: CertificadoCargado, rucEsperado?: string, ahora = new Date()): string[] {
  const a: string[] = [];
  if (c.venceEl.getTime() < ahora.getTime()) a.push(`El certificado venció el ${c.venceEl.toISOString().slice(0, 10)}.`);
  else if (c.venceEl.getTime() - ahora.getTime() < 30 * 864e5) {
    a.push(`El certificado vence pronto (${c.venceEl.toISOString().slice(0, 10)}).`);
  }
  if (c.validoDesde.getTime() > ahora.getTime()) a.push("El certificado todavía no es válido (fecha de inicio futura).");
  if (!c.clientAuth) a.push("El certificado no tiene extendedKeyUsage clientAuth: SIFEN rechaza la conexión mTLS (MT §7.5).");
  if (c.autofirmado) a.push("Certificado AUTOFIRMADO: solo sirve para pruebas locales; SIFEN lo rechaza (Guía de Pruebas §4.1).");
  if (!c.ruc) a.push("No se encontró 'RUCxxxxxxx-x' en SerialNumber/SAN del certificado (MT §7.5).");
  else if (rucEsperado && c.ruc !== rucEsperado) a.push(`El RUC del certificado (${c.ruc}) no coincide con el del emisor (${rucEsperado}).`);
  return a;
}

// ─── Certificado autofirmado de PRUEBA (solo firma local / tests / MODO_SIMULADO) ───

export interface OpcionesCertPrueba {
  /** RUC inventado sin DV (por defecto 80000000) y DV (por defecto 0). Datos de prueba, no reales. */
  ruc?: string;
  dv?: string;
  cn?: string;
  /** Días de validez (por defecto 365). Negativo = certificado ya vencido (para tests). */
  dias?: number;
  /** Clave del .p12 generado (por defecto "prueba"). */
  clave?: string;
  /** Agregar clientAuth (por defecto true). */
  clientAuth?: boolean;
}

export interface CertPrueba {
  p12: Uint8Array;
  clave: string;
  clavePrivadaPem: string;
  certificadoPem: string;
}

const cacheCertPrueba = new Map<string, Promise<CertPrueba>>();

/** Par RSA 2048 vía WebCrypto (mucho más rápido que forge puro) convertido a objetos forge. */
export async function generarParRsa(): Promise<{ privateKey: forge.pki.rsa.PrivateKey; publicKey: forge.pki.rsa.PublicKey }> {
  const kp = await crypto.subtle.generateKey(
    { name: "RSASSA-PKCS1-v1_5", modulusLength: 2048, publicExponent: new Uint8Array([1, 0, 1]), hash: "SHA-256" },
    true,
    ["sign", "verify"],
  );
  const pkcs8 = new Uint8Array(await crypto.subtle.exportKey("pkcs8", kp.privateKey));
  const asn1 = forge.asn1.fromDer(forge.util.createBuffer(bytesABinario(pkcs8)));
  const privateKey = forge.pki.privateKeyFromAsn1(asn1) as forge.pki.rsa.PrivateKey;
  const publicKey = forge.pki.setRsaPublicKey(privateKey.n, privateKey.e);
  return { privateKey, publicKey };
}

/**
 * Genera (y cachea por proceso) un .p12 AUTOFIRMADO de prueba, con RUC inventado en SerialNumber
 * (formato MT §7.5), KeyUsage firma+no repudio (NT016 AC01) y EKU clientAuth (MT §7.5).
 */
export function generarCertificadoPrueba(op: OpcionesCertPrueba = {}): Promise<CertPrueba> {
  const o = { ruc: "80000000", dv: "0", cn: "VOLTRA PRUEBA SIN VALOR FISCAL", dias: 365, clave: "prueba", clientAuth: true, ...op };
  const k = JSON.stringify(o);
  let p = cacheCertPrueba.get(k);
  if (!p) {
    p = (async () => {
      const { privateKey, publicKey } = await generarParRsa();
      const cert = forge.pki.createCertificate();
      cert.publicKey = publicKey;
      cert.serialNumber = "01" + forge.util.bytesToHex(forge.random.getBytesSync(8));
      const ahora = Date.now();
      cert.validity.notBefore = new Date(ahora - (o.dias < 0 ? 400 : 1) * 864e5);
      cert.validity.notAfter = new Date(ahora + o.dias * 864e5);
      const attrs: forge.pki.CertificateField[] = [
        { name: "commonName", value: o.cn },
        { type: OID_SERIAL_NUMBER, value: `RUC${o.ruc}-${o.dv}` },
        { name: "countryName", value: "PY" },
      ];
      cert.setSubject(attrs);
      cert.setIssuer(attrs);
      const exts: Array<Record<string, unknown>> = [
        { name: "basicConstraints", cA: false },
        { name: "keyUsage", digitalSignature: true, nonRepudiation: true, keyEncipherment: true },
      ];
      if (o.clientAuth) exts.push({ name: "extKeyUsage", clientAuth: true });
      cert.setExtensions(exts);
      cert.sign(privateKey, forge.md.sha256.create());
      const asn1 = forge.pkcs12.toPkcs12Asn1(privateKey, [cert], o.clave, { algorithm: "3des" });
      const der = forge.asn1.toDer(asn1).getBytes();
      const bytes = new Uint8Array(der.length);
      for (let i = 0; i < der.length; i++) bytes[i] = der.charCodeAt(i);
      return {
        p12: bytes,
        clave: o.clave,
        clavePrivadaPem: forge.pki.privateKeyToPem(privateKey),
        certificadoPem: forge.pki.certificateToPem(cert),
      };
    })();
    cacheCertPrueba.set(k, p);
  }
  return p;
}

// ─── Credenciales desde variables de entorno (ENV_SIFEN de tipos.ts) ───

export type LectorEnv = (nombre: string) => string | undefined;

const lectorDeno: LectorEnv = (n) => {
  try {
    return Deno.env.get(n);
  } catch {
    return undefined; // sin permiso --allow-env
  }
};

export type ResultadoCredenciales =
  | {
    ok: true;
    credenciales: CredencialesSifen;
    /** MODO_SIMULADO=1: firma con autofirmado y SIFEN simulado (sin red). */
    simulado: boolean;
    certificado: CertificadoCargado;
    avisos: string[];
  }
  | { ok: false; error: string; faltan: string[] };

/**
 * Valores públicos de la Guía de Pruebas e-kuatia §2 ("Set de Pruebas: CSC"): IdCSC 0001 /
 * CSC ABCD0000000000000000000000000000. Solo se usan en MODO_SIMULADO si no hay CSC configurado.
 */
const CSC_GENERICO_PRUEBA = { cscId: "0001", csc: "ABCD0000000000000000000000000000" };

function decodificarBase64(b64: string): Uint8Array {
  const limpio = b64.replace(/\s+/g, "");
  const bin = atob(limpio);
  const out = new Uint8Array(bin.length);
  for (let i = 0; i < bin.length; i++) out[i] = bin.charCodeAt(i);
  return out;
}

/**
 * Lee ENV_SIFEN y arma CredencialesSifen.
 * - MODO_SIMULADO=1: si falta el certificado usa un AUTOFIRMADO de prueba; timbrado/CSC faltantes se
 *   completan con valores de prueba (marcados en `avisos`). Nunca sirve para SIFEN real.
 * - Sin MODO_SIMULADO: exige certificado, clave, timbrado, inicio de timbrado, CSC e IdCSC; si falta
 *   algo devuelve { ok:false, faltan:[...] } con el nombre exacto de cada variable.
 * - produccionAutorizada = (SIFEN_PRODUCCION_AUTORIZADA === "si") — docs/sifen-contrato.md.
 */
export async function credencialesDesdeEnv(leer: LectorEnv = lectorDeno): Promise<ResultadoCredenciales> {
  const v = (n: string) => {
    const x = leer(n);
    return x === undefined || x.trim() === "" ? undefined : x.trim();
  };
  const simulado = v(ENV_SIFEN.simulado) === "1";
  const ambienteTxt = (v(ENV_SIFEN.ambiente) ?? "test").toLowerCase();
  if (ambienteTxt !== "test" && ambienteTxt !== "prod") {
    return { ok: false, error: `${ENV_SIFEN.ambiente} debe ser "test" o "prod" (vino "${ambienteTxt}").`, faltan: [] };
  }
  const ambiente = ambienteTxt as AmbienteSifen;
  const produccionAutorizada = v(ENV_SIFEN.produccionAutorizada) === "si";
  const avisos: string[] = [];

  const certB64 = v(ENV_SIFEN.certP12Base64);
  const certClave = leer(ENV_SIFEN.certClave) ?? undefined; // la clave puede tener espacios: no se recorta
  let timbrado = v(ENV_SIFEN.timbrado);
  let timbradoInicio = v(ENV_SIFEN.timbradoInicio);
  let csc = v(ENV_SIFEN.csc);
  let cscId = v(ENV_SIFEN.cscId);

  if (!simulado) {
    const faltan: string[] = [];
    if (!certB64) faltan.push(ENV_SIFEN.certP12Base64);
    if (certClave === undefined) faltan.push(ENV_SIFEN.certClave);
    if (!timbrado) faltan.push(ENV_SIFEN.timbrado);
    if (!timbradoInicio) faltan.push(ENV_SIFEN.timbradoInicio);
    if (!csc) faltan.push(ENV_SIFEN.csc);
    if (!cscId) faltan.push(ENV_SIFEN.cscId);
    if (faltan.length) {
      return {
        ok: false,
        faltan,
        error: `Faltan variables SIFEN: ${faltan.join(", ")}. (Para firmar localmente sin SIFEN usá ${ENV_SIFEN.simulado}=1.)`,
      };
    }
  } else {
    if (!timbrado) {
      timbrado = "12345678";
      avisos.push("MODO_SIMULADO: timbrado de prueba 12345678.");
    }
    if (!timbradoInicio) {
      timbradoInicio = "2026-01-01";
      avisos.push("MODO_SIMULADO: inicio de timbrado de prueba 2026-01-01.");
    }
    if (!csc || !cscId) {
      csc = CSC_GENERICO_PRUEBA.csc;
      cscId = CSC_GENERICO_PRUEBA.cscId;
      avisos.push("MODO_SIMULADO: CSC genérico de la Guía de Pruebas (IdCSC 0001).");
    }
  }

  if (!/^\d{8}$/.test(timbrado!)) return { ok: false, faltan: [], error: `${ENV_SIFEN.timbrado} debe tener 8 dígitos.` };
  if (!/^\d{4}-\d{2}-\d{2}$/.test(timbradoInicio!)) {
    return { ok: false, faltan: [], error: `${ENV_SIFEN.timbradoInicio} debe ser AAAA-MM-DD.` };
  }
  if (!/^\d{1,4}$/.test(cscId!)) return { ok: false, faltan: [], error: `${ENV_SIFEN.cscId} debe ser numérico (ej. 0001).` };

  let certP12: Uint8Array;
  let clave: string;
  if (certB64) {
    try {
      certP12 = decodificarBase64(certB64);
    } catch {
      return { ok: false, faltan: [], error: `${ENV_SIFEN.certP12Base64} no es base64 válido.` };
    }
    clave = certClave ?? "";
  } else {
    const prueba = await generarCertificadoPrueba();
    certP12 = prueba.p12;
    clave = prueba.clave;
    avisos.push("MODO_SIMULADO: se firma con un certificado AUTOFIRMADO de prueba (sin valor fiscal).");
  }

  let certificado: CertificadoCargado;
  try {
    certificado = cargarP12(certP12, clave);
  } catch (e) {
    return { ok: false, faltan: [], error: (e as Error).message };
  }
  avisos.push(...avisosCertificado(certificado).filter((a) => !(simulado && /AUTOFIRMADO/.test(a))));
  if (!simulado && certificado.venceEl.getTime() < Date.now()) {
    return { ok: false, faltan: [], error: `El certificado venció el ${certificado.venceEl.toISOString().slice(0, 10)}.` };
  }

  return {
    ok: true,
    simulado,
    certificado,
    avisos,
    credenciales: {
      ambiente,
      timbrado: timbrado!,
      timbradoInicio: timbradoInicio!,
      csc: csc!,
      cscId: cscId!.padStart(4, "0"),
      certP12,
      certClave: clave,
      produccionAutorizada,
    },
  };
}
