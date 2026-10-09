// _shared/sifen/soap.ts · Sobres SOAP 1.2 de los WS de SIFEN y parseo de sus respuestas.
//
// Fuentes (verificadas 2026-10-08, https://www.dnit.gov.py/web/e-kuatia/documentacion-tecnica):
// - MT v150 §7.4: SOAP 1.2 (ns http://www.w3.org/2003/05/soap-envelope), Document/Literal; el mensaje va
//   dentro de soap:Body. Ejemplo de request rEnviDe y de response rRetEnviDe/rProtDe.
// - MT v150 §7.2.4: sin espacios/saltos entre etiquetas ni prefijos en el XML de negocio.
// - MT v150 §9.1 siRecepDE: rEnviDe { dId N 1-15, xDE = XML del rDE }. Respuesta §9.1.3 rRetEnviDe/rProtDe
//   (dEstRes "Aprobado" | "Aprobado con observación" | "Rechazado", dProtAut, gResProc{dCodRes,dMsgRes}).
// - MT v150 §9.2 siRecepLoteDE: rEnvioLote { dId, xDE = rLoteDE comprimido (.zip) en Base64 }, hasta 50 DE
//   del mismo tipo, cada uno firmado. Respuesta rResEnviLoteDe {dCodRes 0300/0301, dProtConsLote, dTpoProces}.
// - MT v150 §9.3 siResultLoteDE: rEnviConsLoteDe { dId, dProtConsLote }. Respuesta rResEnviConsLoteDe
//   { dCodResLot 0360/0361/0362, gResProcLote[ id, dEstRes, dProtAut, gResProc{dCodRes,dMsgRes} ] }.
// - MT v150 §9.4 siConsDE + NT010 §1.9 (raíz renombrada a rEnviConsDeRequest): { dId, dCDC }.
//   Respuesta (Guía de Mejores Prácticas, oct-2024, "consulta"): rEnviConsDeResponse { dCodRes 0420/0422, xContenDE }.
// - MT v150 §9.5 siRecepEvento: rEnviEventoDe { dId, dEvReg = gGroupGesEve/rGesEve firmado }. Ejemplo §7.2.2.
//   Respuesta rRetEnviEventoDe { dFecProc, gResProcEVe[ dEstRes, dProtAut, id, gResProc ] } (0600 = registrado).
// - MT v150 §9.6 siConsRUC: rEnviConsRUC { dId, dRUCCons A 5-8 sin DV }. Respuesta rResEnviConsRUC
//   { dCodRes 0500/0501/0502, xContRUC{ dRUCCons, dRazCons, dCodEstCons, dDesEstCons, dRUCFactElec } }.
// - Guía de Mejores Prácticas (oct-2024) "recibe-lote": pasos 1-5 (rLoteDE → zip → Base64 → sobre) y
//   respuestas de ejemplo con prefijos env:/ns2: (el parser ignora prefijos).
// - Códigos: MT v150 cap. 12 (§12.2.6 0160-0163, §12.3.1.3 0260, §12.3.2.3 0300/0301,
//   §12.3.3.3 0360-0363, §12.3.4.3 0420/0421(*), §12.3.5.3 0500-0502, §12.3.6.3 0600) y Mejores Prácticas
//   (0364 consulta de lote extemporánea, >48 h). (*) El MT dice 0421/0422 en lugares distintos para
//   "CDC encontrado"; la guía de 2024 muestra 0422 → se aceptan ambos si viene xContenDE.

import { strFromU8, strToU8, unzipSync, zipSync } from "npm:fflate@0.8.2";
import type { RespuestaSifen } from "./tipos.ts";

export const NS_SIFEN = "http://ekuatia.set.gov.py/sifen/xsd";
export const NS_SOAP12 = "http://www.w3.org/2003/05/soap-envelope";

/** MT §9.2.1 / §9.2.2: hasta 50 DE por lote. */
export const MAX_DE_POR_LOTE = 50;
/** MT §12.3.1.1 (siRecepDE) y Mejores Prácticas "Motivos de rechazo e." (lote): 1000 KB. MT §12.3.2.1 dice
 *  10.000 KB para el lote, la guía de 2024 dice 1000 KB → se usa el menor. [VERIFICAR] */
export const MAX_BYTES_MENSAJE = 1000 * 1024;
/** Nombre del archivo dentro del zip: el MT no lo fija; se usa el de la librería TIPS-SA (en producción). [VERIFICAR] */
export const NOMBRE_ARCHIVO_LOTE = "xml_file.xml";

// ─── Utilidades ───

export function quitarDeclaracionXml(xml: string): string {
  return xml.replace(/^﻿?\s*<\?xml[^?]*\?>\s*/, "").trim();
}

function validarDId(dId: string): string {
  if (!/^\d{1,15}$/.test(dId)) throw new Error(`dId inválido "${dId}": numérico de 1 a 15 dígitos (MT §9.1.1 ASch02).`);
  return dId;
}

/** dId: "número secuencial autoincremental ... responsabilidad exclusiva del contribuyente" (MT §9.1.1). */
let ultimoDId = 0;
export function generarDId(ahora = Date.now()): string {
  // Milisegundos desde epoch (13 dígitos) monotónicos dentro del proceso; ≤15 dígitos.
  ultimoDId = Math.max(ultimoDId + 1, ahora);
  return String(ultimoDId);
}

function escaparTexto(s: string): string {
  return s.replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;");
}

function sobre(cuerpo: string): string {
  // MT §7.4 (con soap:Body en mayúscula según SOAP 1.2; el "soap:body" del ejemplo del MT es una errata).
  return `<?xml version="1.0" encoding="UTF-8"?><soap:Envelope xmlns:soap="${NS_SOAP12}"><soap:Header/><soap:Body>${cuerpo}</soap:Body></soap:Envelope>`;
}

function tamano(s: string): number {
  return new TextEncoder().encode(s).length;
}

function verificarTamano(s: string, que: string) {
  const t = tamano(s);
  if (t > MAX_BYTES_MENSAJE) throw new Error(`${que}: ${Math.ceil(t / 1024)} KB supera el máximo de ${MAX_BYTES_MENSAJE / 1024} KB.`);
}

/** CDC = atributo Id del <DE> (MT §7.6 / §10.1). */
export function cdcDeXml(xmlDE: string): string {
  const m = /<DE\s[^>]*\bId="(\d{44})"/.exec(xmlDE);
  if (!m) throw new Error("No se encontró <DE Id=\"<CDC de 44 dígitos>\"> en el XML.");
  return m[1];
}

// ─── Requests ───

/** siRecepDE (síncrono): rEnviDe con el rDE firmado dentro de xDE (MT §7.4 ejemplo, §9.1.1). */
export function soapEnviDe(dId: string, xmlFirmado: string): string {
  validarDId(dId);
  const rde = quitarDeclaracionXml(xmlFirmado);
  if (!rde.startsWith("<rDE")) throw new Error("xDE debe contener un <rDE> firmado.");
  if (!rde.includes(`<Signature xmlns="http://www.w3.org/2000/09/xmldsig#"`)) throw new Error("El rDE no está firmado.");
  const s = sobre(`<rEnviDe xmlns="${NS_SIFEN}"><dId>${validarDId(dId)}</dId><xDE>${rde}</xDE></rEnviDe>`);
  verificarTamano(s, "siRecepDE");
  return s;
}

/**
 * rLoteDE con los rDE firmados (MT §9.2.1 Schema 5A; §7.2.2.2: cada rDE con su propio namespace).
 * Valida: 1..50 DE, todos firmados, mismo tipo de DE y mismo RUC emisor (Mejores Prácticas "Motivos de
 * rechazo" a-c) y sin CDC repetidos (Mejores Prácticas "Motivos de bloqueo" g).
 * El rLoteDE va sin namespace propio, igual que la librería TIPS-SA. [VERIFICAR]
 */
export function armarLoteXml(xmlsFirmados: string[]): string {
  if (xmlsFirmados.length === 0) throw new Error("Lote vacío (SIFEN bloquea el RUC por lotes vacíos).");
  if (xmlsFirmados.length > MAX_DE_POR_LOTE) {
    throw new Error(`Lote con ${xmlsFirmados.length} DE: el máximo es ${MAX_DE_POR_LOTE} (MT §9.2.1).`);
  }
  const cdcs = new Set<string>();
  let tipo: string | undefined;
  let ruc: string | undefined;
  const partes = xmlsFirmados.map((x, i) => {
    const rde = quitarDeclaracionXml(x);
    if (!rde.startsWith("<rDE")) throw new Error(`Documento ${i + 1} del lote no es un <rDE>.`);
    if (!rde.includes(`xmlns="${NS_SIFEN}"`)) throw new Error(`Documento ${i + 1}: el rDE debe declarar xmlns="${NS_SIFEN}" (MT §7.2.2.2).`);
    if (!rde.includes("<Signature ")) throw new Error(`Documento ${i + 1} del lote no está firmado.`);
    const cdc = cdcDeXml(rde);
    if (cdcs.has(cdc)) throw new Error(`CDC repetido en el lote: ${cdc}.`);
    cdcs.add(cdc);
    // Estructura del CDC (MT §10.1): pos 1-2 tipo de DE, 3-10 RUC emisor.
    const t = cdc.slice(0, 2), r = cdc.slice(2, 10);
    if (tipo !== undefined && t !== tipo) throw new Error("Un lote solo puede tener DE de un mismo tipo (MT §9.2.2).");
    if (ruc !== undefined && r !== ruc) throw new Error("Un lote solo puede tener DE de un mismo RUC emisor.");
    tipo = t;
    ruc = r;
    return rde;
  });
  return `<rLoteDE>${partes.join("")}</rLoteDE>`;
}

/** Zip (deflate) + Base64 del rLoteDE (MT §9.2.1 BSch03; Mejores Prácticas "recibe-lote" pasos 3-4). */
export function zipLoteBase64(xmlsFirmados: string[]): string {
  const contenido = `<?xml version="1.0" encoding="UTF-8"?>${armarLoteXml(xmlsFirmados)}`;
  const zip = zipSync({ [NOMBRE_ARCHIVO_LOTE]: strToU8(contenido) }, { level: 9 });
  let bin = "";
  for (let i = 0; i < zip.length; i += 0x8000) bin += String.fromCharCode(...zip.subarray(i, i + 0x8000));
  return btoa(bin);
}

/** Inversa de zipLoteBase64 (para tests y para el transporte simulado). */
export function deszipLoteBase64(b64: string): string {
  const bin = atob(b64);
  const u = new Uint8Array(bin.length);
  for (let i = 0; i < bin.length; i++) u[i] = bin.charCodeAt(i);
  const archivos = unzipSync(u);
  const nombres = Object.keys(archivos);
  if (nombres.length !== 1) throw new Error(`El zip del lote debe tener 1 archivo (tiene ${nombres.length}).`);
  return strFromU8(archivos[nombres[0]]);
}

/** siRecepLoteDE (asíncrono): rEnvioLote { dId, xDE=base64(zip(rLoteDE)) } (MT §9.2.1; Mejores Prácticas). */
export function soapEnvioLote(dId: string, xmlsFirmados: string[]): string {
  const s = sobre(`<rEnvioLote xmlns="${NS_SIFEN}"><dId>${validarDId(dId)}</dId><xDE>${zipLoteBase64(xmlsFirmados)}</xDE></rEnvioLote>`);
  verificarTamano(s, "siRecepLoteDE");
  return s;
}

/** siResultLoteDE: rEnviConsLoteDe { dId, dProtConsLote N 1-15 } (MT §9.3.1). */
export function soapConsLote(dId: string, protocolo: string): string {
  if (!/^\d{1,20}$/.test(protocolo)) throw new Error(`Número de lote inválido "${protocolo}".`);
  // Nota: el MT dice N 1-15, pero la guía de 2024 muestra lotes de 17 dígitos (11158097383597290). Se acepta hasta 20.
  return sobre(`<rEnviConsLoteDe xmlns="${NS_SIFEN}"><dId>${validarDId(dId)}</dId><dProtConsLote>${protocolo}</dProtConsLote></rEnviConsLoteDe>`);
}

/** siConsDE: rEnviConsDeRequest { dId, dCDC } (MT §9.4.1 + NT010 §1.9). */
export function soapConsDE(dId: string, cdc: string): string {
  if (!/^\d{44}$/.test(cdc)) throw new Error(`CDC inválido "${cdc}": 44 dígitos.`);
  return sobre(`<rEnviConsDeRequest xmlns="${NS_SIFEN}"><dId>${validarDId(dId)}</dId><dCDC>${cdc}</dCDC></rEnviConsDeRequest>`);
}

/**
 * siRecepEvento: rEnviEventoDe { dId, dEvReg = gGroupGesEve > rGesEve(firmado) } (MT §9.5.1, ejemplo §7.2.2).
 * Acepta el evento firmado empezando en <gGroupGesEve> o en <rGesEve> (en ese caso lo envuelve).
 * El rGesEve/gGroupGesEve DEBE declarar xmlns="http://ekuatia.set.gov.py/sifen/xsd" ANTES de firmar:
 * con c14n exclusiva el namespace del rEve forma parte del digest. [VERIFICAR con eventos_xml.ts]
 */
export function soapEvento(dId: string, xmlEventoFirmado: string): string {
  let ev = quitarDeclaracionXml(xmlEventoFirmado);
  if (!ev.includes("<Signature ")) throw new Error("El evento no está firmado.");
  if (!/<rEve\s[^>]*\bId="[^"]+"/.test(ev)) throw new Error("El evento no tiene <rEve Id=\"...\">.");
  if (ev.startsWith("<rGesEve")) ev = `<gGroupGesEve>${ev}</gGroupGesEve>`;
  else if (!ev.startsWith("<gGroupGesEve")) throw new Error("El evento debe empezar en <gGroupGesEve> o <rGesEve>.");
  const s = sobre(`<rEnviEventoDe xmlns="${NS_SIFEN}"><dId>${validarDId(dId)}</dId><dEvReg>${ev}</dEvReg></rEnviEventoDe>`);
  verificarTamano(s, "siRecepEvento");
  return s;
}

/** siConsRUC: rEnviConsRUC { dId, dRUCCons A 5-8 sin DV } (MT §9.6.1). */
export function soapConsRuc(dId: string, ruc: string): string {
  const r = ruc.trim().split("-")[0];
  if (!/^[0-9A-Za-z]{5,8}$/.test(r)) throw new Error(`RUC inválido "${ruc}": 5 a 8 caracteres, sin DV (MT §9.6.1 RSch03).`);
  return sobre(`<rEnviConsRUC xmlns="${NS_SIFEN}"><dId>${validarDId(dId)}</dId><dRUCCons>${escaparTexto(r)}</dRUCCons></rEnviConsRUC>`);
}

// ─── Respuestas ───

/** RespuestaSifen del contrato + detalle opcional por servicio (compatible estructuralmente). */
export interface RespuestaWs extends RespuestaSifen {
  /** dFecProc. */
  fechaProceso?: string;
  /** Lote: resultado por DE (MT §9.3.3, gResProcLote). */
  documentos?: Array<{ cdc: string; estado: RespuestaSifen["estado"]; codigo?: string; mensaje?: string; protocolo?: string }>;
  /** Consulta DE: false si SIFEN respondió 0420 (no existe o fue rechazado → se puede reenviar). */
  existe?: boolean;
  /** Consulta RUC (MT §9.6.3, Schema XML 17). */
  contribuyente?: { ruc: string; razonSocial: string; estadoCodigo: string; estado: string; facturadorElectronico: boolean };
  /** dTpoProces (lote), segundos. */
  tiempoProceso?: number;
  /** El problema puede resolverse reintentando más tarde (0161/0162/0361, errores de red). */
  reintentable?: boolean;
  /** Error de red con posible recepción: CONSULTAR antes de reenviar (Mejores Prácticas punto 5). */
  consultarAntesDeReenviar?: boolean;
  /** Lote consultado después de 48 h (0364): consultar cada CDC con consulta DE. */
  consultarPorCdc?: boolean;
  /** HTTP status de la respuesta. */
  httpStatus?: number;
}

function re(nombre: string, flags = ""): RegExp {
  return new RegExp(`<(?:[\\w.-]+:)?${nombre}(?:\\s[^>]*)?>([\\s\\S]*?)</(?:[\\w.-]+:)?${nombre}>`, flags);
}

function desescapar(s: string): string {
  return s.replace(/&lt;/g, "<").replace(/&gt;/g, ">").replace(/&quot;/g, '"').replace(/&apos;/g, "'")
    .replace(/&#(\d+);/g, (_, n) => String.fromCharCode(Number(n)))
    .replace(/&#x([0-9a-f]+);/gi, (_, n) => String.fromCharCode(parseInt(n, 16)))
    .replace(/&amp;/g, "&");
}

/** Valor de la primera etiqueta `nombre` (ignora prefijos ns2:/env:). */
export function valor(xml: string, nombre: string): string | undefined {
  const m = re(nombre).exec(xml);
  return m ? desescapar(m[1].trim()) : undefined;
}

/** Contenido crudo (sin desescapar) de cada aparición de `nombre`. */
export function bloques(xml: string, nombre: string): string[] {
  return [...xml.matchAll(re(nombre, "g"))].map((m) => m[1]);
}

/** dEstRes → estado del contrato (MT §9.1.3 PP050: "Aprobado" | "Aprobado con observación" | "Rechazado"). */
export function estadoDesdeDEstRes(dEstRes: string | undefined): RespuestaSifen["estado"] | undefined {
  if (!dEstRes) return undefined;
  const t = dEstRes.normalize("NFD").replace(/[̀-ͯ]/g, "").toLowerCase().trim();
  if (t.startsWith("aprobado con")) return "aprobado_obs";
  if (t === "aprobado") return "aprobado";
  if (t.startsWith("rechaz")) return "rechazado";
  return undefined;
}

/** Códigos genéricos de servidor ocupado (MT §12.2.6: 0161, 0162) → reintentable. */
const CODIGOS_REINTENTABLES = new Set(["0161", "0162"]);

function falloSoap(body: string, status: number): RespuestaWs | undefined {
  // F5 BigIP de la SET: sin certificado de cliente válido redirige a /vdesk/hangup.php3 (observado
  // 2026-10-08 con GET a https://sifen-test.set.gov.py/de/ws/sync/recibe.wsdl?wsdl sin certificado).
  if (status >= 300 && status < 400) {
    return {
      ok: false,
      estado: "error",
      mensaje: `SIFEN respondió HTTP ${status} (redirección): normalmente la autenticación mutua TLS fue rechazada (certificado no válido / sin clientAuth / RUC no habilitado).`,
      httpStatus: status,
      xmlRespuesta: body || undefined,
    };
  }
  const fault = /<(?:[\w.-]+:)?Fault[\s>]/.test(body);
  if (fault) {
    const txt = valor(body, "Text") ?? valor(body, "faultstring") ?? valor(body, "Reason") ?? "SOAP Fault";
    return { ok: false, estado: "error", mensaje: `SOAP Fault: ${txt}`, httpStatus: status, xmlRespuesta: body };
  }
  return undefined;
}

function sinRaiz(raiz: string, body: string, status: number): RespuestaWs {
  return {
    ok: false,
    estado: "error",
    mensaje: `Respuesta inesperada de SIFEN (HTTP ${status}): no contiene <${raiz}>.`,
    httpStatus: status,
    xmlRespuesta: body || undefined,
    reintentable: status >= 500,
  };
}

function resGenerico(codigo: string | undefined, mensaje: string | undefined): Pick<RespuestaWs, "codigo" | "mensaje" | "reintentable"> {
  return { codigo, mensaje, reintentable: codigo ? CODIGOS_REINTENTABLES.has(codigo) : undefined };
}

/** rRetEnviDe/rProtDe (siRecepDE). 0260 = "Autorización del DE satisfactoria" (MT §12.3.1.3). */
export function parsearRetEnviDe(body: string, status = 200): RespuestaWs {
  const f = falloSoap(body, status);
  if (f) return f;
  const raiz = bloques(body, "rRetEnviDe")[0];
  if (raiz === undefined) return sinRaiz("rRetEnviDe", body, status);
  const prot = bloques(raiz, "rProtDe")[0] ?? raiz;
  const res = bloques(prot, "gResProc");
  const codigo = res.length ? valor(res[0], "dCodRes") : valor(prot, "dCodRes");
  const mensaje = res.map((r) => `${valor(r, "dCodRes")}: ${valor(r, "dMsgRes")}`).join(" | ") || valor(prot, "dMsgRes");
  // MT §12.2.6 AE02/AE03: 0161 "momentáneamente sin respuesta" y 0162 "paralizado" son caídas de SIFEN,
  // NO rechazos del documento: se devuelven como error reintentable (la cola reprograma, no marca rechazada).
  if (codigo === "0161" || codigo === "0162") {
    return { ok: false, estado: "error", ...resGenerico(codigo, mensaje), reintentable: true, consultarAntesDeReenviar: true, xmlRespuesta: body, httpStatus: status } as RespuestaWs;
  }
  const estado = estadoDesdeDEstRes(valor(prot, "dEstRes")) ?? (codigo === "0260" ? "aprobado" : "rechazado");
  const protocolo = valor(prot, "dProtAut");
  return {
    ok: estado === "aprobado" || estado === "aprobado_obs",
    estado,
    ...resGenerico(codigo, mensaje),
    protocolo: protocolo && !/^0+$/.test(protocolo) ? protocolo : undefined,
    fechaProceso: valor(prot, "dFecProc"),
    xmlRespuesta: body,
    httpStatus: status,
  };
}

/** rResEnviLoteDe (siRecepLoteDE). 0300 recibido (→ en_proceso), 0301 no encolado (MT §12.3.2.3). */
export function parsearResEnviLoteDe(body: string, status = 200): RespuestaWs {
  const f = falloSoap(body, status);
  if (f) return f;
  const raiz = bloques(body, "rResEnviLoteDe")[0];
  if (raiz === undefined) return sinRaiz("rResEnviLoteDe", body, status);
  const codigo = valor(raiz, "dCodRes");
  const mensaje = valor(raiz, "dMsgRes");
  const tpo = valor(raiz, "dTpoProces");
  const base = { ...resGenerico(codigo, mensaje), fechaProceso: valor(raiz, "dFecProc"), xmlRespuesta: body, httpStatus: status, tiempoProceso: tpo ? Number(tpo) : undefined };
  if (codigo === "0300") return { ok: true, estado: "en_proceso", protocolo: valor(raiz, "dProtConsLote"), ...base };
  return { ok: false, estado: "rechazado", ...base };
}

/** rResEnviConsLoteDe (siResultLoteDE). 0360 inexistente, 0361 en proceso, 0362 concluido, 0364 extemporáneo. */
export function parsearResEnviConsLoteDe(body: string, status = 200): RespuestaWs {
  const f = falloSoap(body, status);
  if (f) return f;
  const raiz = bloques(body, "rResEnviConsLoteDe")[0];
  if (raiz === undefined) return sinRaiz("rResEnviConsLoteDe", body, status);
  const codigo = valor(raiz, "dCodResLot") ?? valor(raiz, "dCodRes");
  const mensaje = valor(raiz, "dMsgResLot") ?? valor(raiz, "dMsgRes");
  const base = { codigo, mensaje, fechaProceso: valor(raiz, "dFecProc"), xmlRespuesta: body, httpStatus: status };
  if (codigo === "0361") return { ok: true, estado: "en_proceso", reintentable: true, ...base };
  if (codigo === "0364") return { ok: false, estado: "error", consultarPorCdc: true, ...base };
  if (codigo !== "0362") return { ok: false, estado: "error", ...base };
  const documentos = bloques(raiz, "gResProcLote").map((g) => {
    const res = bloques(g, "gResProc")[0] ?? g;
    const est = estadoDesdeDEstRes(valor(g, "dEstRes")) ?? "rechazado";
    const prot = valor(g, "dProtAut");
    return {
      cdc: valor(g, "id") ?? "",
      estado: est,
      codigo: valor(res, "dCodRes"),
      mensaje: valor(res, "dMsgRes"),
      protocolo: prot && !/^0+$/.test(prot) ? prot : undefined,
    };
  });
  const algunRechazo = documentos.some((d) => d.estado === "rechazado");
  const algunaObs = documentos.some((d) => d.estado === "aprobado_obs");
  return {
    ok: true,
    estado: algunRechazo ? "rechazado" : algunaObs ? "aprobado_obs" : "aprobado",
    documentos,
    ...base,
  };
}

/** rEnviConsDeResponse (siConsDE). 0422 (o 0421) con xContenDE = existe y aprobado; 0420 = no existe/rechazado. */
export function parsearConsDE(body: string, status = 200): RespuestaWs {
  const f = falloSoap(body, status);
  if (f) return f;
  const raiz = bloques(body, "rEnviConsDeResponse")[0] ?? bloques(body, "rResEnviConsDe")[0];
  if (raiz === undefined) return sinRaiz("rEnviConsDeResponse", body, status);
  const codigo = valor(raiz, "dCodRes");
  const mensaje = valor(raiz, "dMsgRes");
  const base = { ...resGenerico(codigo, mensaje), fechaProceso: valor(raiz, "dFecProc"), xmlRespuesta: body, httpStatus: status };
  const cont = bloques(raiz, "xContenDE")[0];
  // MT/Guía de Mejores Prácticas: 0421 = "RUC Certificado sin permiso"; 0422 = "CDC encontrado".
  if (codigo === "0421") {
    return { ok: false, estado: "error", ...base, mensaje: `0421: el RUC del certificado no tiene permiso para consultar este DE${mensaje ? ` (${mensaje})` : ""}` } as RespuestaWs;
  }
  if (codigo === "0422" && cont !== undefined) {
    const c = cont.includes("&lt;") ? desescapar(cont) : cont;
    return { ok: true, estado: "aprobado", existe: true, protocolo: valor(c, "dProtAut"), ...base };
  }
  if (codigo === "0420") return { ok: false, estado: "error", existe: false, ...base };
  return { ok: false, estado: "error", ...base };
}

/** rRetEnviEventoDe (siRecepEvento). 0600 = "Evento registrado correctamente" (MT §12.3.6.3). */
export function parsearRetEnviEventoDe(body: string, status = 200): RespuestaWs {
  const f = falloSoap(body, status);
  if (f) return f;
  const raiz = bloques(body, "rRetEnviEventoDe")[0];
  if (raiz === undefined) return sinRaiz("rRetEnviEventoDe", body, status);
  const g = bloques(raiz, "gResProcEVe")[0] ?? raiz;
  const res = bloques(g, "gResProc");
  const codigo = res.length ? valor(res[0], "dCodRes") : valor(g, "dCodRes");
  const mensaje = res.map((r) => `${valor(r, "dCodRes")}: ${valor(r, "dMsgRes")}`).join(" | ") || valor(g, "dMsgRes");
  const estado = estadoDesdeDEstRes(valor(g, "dEstRes")) ?? (codigo === "0600" ? "aprobado" : "rechazado");
  const prot = valor(g, "dProtAut");
  return {
    ok: estado === "aprobado" || estado === "aprobado_obs",
    estado,
    ...resGenerico(codigo, mensaje),
    protocolo: prot && !/^0+$/.test(prot) ? prot : undefined,
    fechaProceso: valor(raiz, "dFecProc"),
    xmlRespuesta: body,
    httpStatus: status,
  };
}

/** rResEnviConsRUC (siConsRUC). 0502 encontrado, 0500 no existe, 0501 sin permiso (MT §9.6.2 Tabla H). */
export function parsearConsRuc(body: string, status = 200): RespuestaWs {
  const f = falloSoap(body, status);
  if (f) return f;
  const raiz = bloques(body, "rResEnviConsRUC")[0];
  if (raiz === undefined) return sinRaiz("rResEnviConsRUC", body, status);
  const codigo = valor(raiz, "dCodRes");
  const mensaje = valor(raiz, "dMsgRes");
  const base = { ...resGenerico(codigo, mensaje), xmlRespuesta: body, httpStatus: status };
  const cont = bloques(raiz, "xContRUC")[0];
  if (codigo === "0502" && cont !== undefined) {
    return {
      ok: true,
      estado: "aprobado",
      existe: true,
      contribuyente: {
        ruc: valor(cont, "dRUCCons") ?? "",
        razonSocial: valor(cont, "dRazCons") ?? "",
        estadoCodigo: valor(cont, "dCodEstCons") ?? "",
        estado: valor(cont, "dDesEstCons") ?? "",
        facturadorElectronico: (valor(cont, "dRUCFactElec") ?? "N").toUpperCase() === "S",
      },
      ...base,
    };
  }
  if (codigo === "0500") return { ok: false, estado: "rechazado", existe: false, ...base };
  return { ok: false, estado: "error", ...base };
}
