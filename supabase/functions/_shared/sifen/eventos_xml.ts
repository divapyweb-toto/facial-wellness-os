// _shared/sifen/eventos_xml.ts · XML de eventos (SIN firma): emisor (cancelación, inutilización) y receptor (notificación, conformidad, disconformidad, desconocimiento).
// Fuentes:
//  - Manual Técnico SIFEN v150, sección 11.5 "Formato de eventos" (GDE000–GDE008) y 11.5.1
//    "Formato de eventos emisor": cancelación GEC001–GEC003, inutilización GEI001–GEI008.
//  - NT 10 (1.7): se agrega la serie (dSerieNum) al evento de inutilización.
//  - XSD oficiales Evento_v150.xsd / Evento_Types_v150.xsd / siRecepEvento_v150.xsd (raíz gGroupGesEve):
//      gGroupGesEve > rGesEve (1-15) > [ rEve(@Id) > dFecFirma, dVerFor, gGroupTiEvt > (rGeVeCan | rGeVeInu) ] + ds:Signature
//    El XSD vigente no tiene dTiGDE (GDE006 del MT): el tipo lo define el elemento dentro de gGroupTiEvt.
//  - MT 7.x (ejemplo rEnviEventoDe): rGesEve lleva xsi:schemaLocation ".../sifen/xsd siRecepEvento_v150.xsd".
// La firma la agrega firma.ts (Signature como hermana de rEve, dentro de rGesEve, referenciando Id del rEve).
// El sobre SOAP (rEnviEventoDe/dId/dEvReg) lo arma ws.ts.

import type { TipoDE } from "./tipos.ts";
import { validarCdc } from "./cdc.ts";
import { ahoraAsuncion, escaparXml, limpiarTexto, NAMESPACE_SIFEN, VERSION_FORMATO } from "./xml.ts";

export interface EventoBase {
  /** GDE003 Id del evento: entero de 1 a 9999999999 (XSD tdIdEve). Por defecto, aleatorio. */
  id?: number;
  /** GDE004 dFecFirma AAAA-MM-DDThh:mm:ss (hora de Asunción). Por defecto, ahora. */
  fechaFirma?: string;
}

export interface EventoCancelacion extends EventoBase {
  cdc: string; // GEC002
  motivo: string; // GEC003 (5-500)
}

export interface EventoInutilizacion extends EventoBase {
  timbrado: string; // GEI002 (8 dígitos)
  establecimiento: string; // GEI003
  punto: string; // GEI004
  desde: number; // GEI005
  hasta: number; // GEI006
  tipo: TipoDE; // GEI007
  motivo: string; // GEI008
  serie?: string; // dSerieNum (NT 10), 2 letras mayúsculas
}

export interface XmlEvento {
  xml: string;
  /** Id del rEve (lo que firma.ts usa como referencia). */
  idEvento: string;
}

/** Id de evento aleatorio dentro del rango del XSD (1..9999999999). */
export function idEventoAleatorio(): number {
  const b = new Uint32Array(2);
  crypto.getRandomValues(b);
  return ((b[0] % 9_999_999) * 1000 + (b[1] % 1000)) + 1; // 1..9_999_999_000 aprox.
}

function idValido(id: number): number {
  if (!Number.isInteger(id) || id < 1 || id > 9_999_999_999) throw new Error(`Id de evento inválido (${id}): entero de 1 a 9999999999 (GDE003).`);
  return id;
}

function fechaFirmaValida(f: string): string {
  if (!/^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}$/.test(f)) throw new Error(`Fecha de firma del evento inválida ("${f}"): AAAA-MM-DDThh:mm:ss (GDE004).`);
  return f;
}

function motivoValido(m: string): string {
  const v = limpiarTexto(m);
  if (v.length < 5 || v.length > 500) throw new Error(`El motivo del evento debe tener entre 5 y 500 caracteres (tiene ${v.length}).`);
  return v;
}

function envolver(id: number, fechaFirma: string, grupo: string): XmlEvento {
  const idEvento = String(idValido(id));
  const xml = `<?xml version="1.0" encoding="UTF-8"?>` +
    // 27-10: igual que TIPS-SA (en producción): schemaLocation en gGroupGesEve y rGesEve sin atributos. Con el
    // schemaLocation en rGesEve, SIFEN TEST devolvía 0160 "XML mal formado" en la inutilización. La firma (rEve) no cambia.
    `<gGroupGesEve xmlns="${NAMESPACE_SIFEN}" xmlns:xsi="http://www.w3.org/2001/XMLSchema-instance" xsi:schemaLocation="${NAMESPACE_SIFEN} siRecepEvento_v150.xsd">` + // GDE000
    `<rGesEve>` + // GDE001
    `<rEve Id="${idEvento}">` + // GDE002 / GDE003
    `<dFecFirma>${fechaFirmaValida(fechaFirma)}</dFecFirma>` + // GDE004
    `<dVerFor>${VERSION_FORMATO}</dVerFor>` + // GDE005
    `<gGroupTiEvt>${grupo}</gGroupTiEvt>` + // GDE007
    `</rEve>` +
    `</rGesEve>` +
    `</gGroupGesEve>`;
  return { xml, idEvento };
}

/** Evento de cancelación (rGeVeCan, GEC001). Plazo: 48 h FE / 168 h otros DE desde la aprobación (MT 11.6.1). */
export function xmlEventoCancelacion(ev: EventoCancelacion): XmlEvento {
  if (!validarCdc(ev?.cdc)) throw new Error(`Cancelación: CDC inválido ("${ev?.cdc ?? ""}").`);
  const grupo = `<rGeVeCan>` + // GEC001
    `<Id>${ev.cdc}</Id>` + // GEC002
    `<mOtEve>${escaparXml(motivoValido(ev.motivo))}</mOtEve>` + // GEC003
    `</rGeVeCan>`;
  return envolver(ev.id ?? idEventoAleatorio(), ev.fechaFirma ?? ahoraAsuncion(), grupo);
}

/** Evento de inutilización de numeración (rGeVeInu, GEI001). Rango máximo 1000 números (GEI005). */
export function xmlEventoInutilizacion(ev: EventoInutilizacion): XmlEvento {
  if (!/^\d{8}$/.test(String(ev?.timbrado ?? ""))) throw new Error(`Inutilización: timbrado inválido ("${ev?.timbrado}"), 8 dígitos (GEI002).`);
  if (!/^\d{3}$/.test(ev.establecimiento ?? "")) throw new Error("Inutilización: establecimiento de 3 dígitos (GEI003).");
  if (!/^\d{3}$/.test(ev.punto ?? "")) throw new Error("Inutilización: punto de expedición de 3 dígitos (GEI004).");
  for (const [n, v] of [["desde", ev.desde], ["hasta", ev.hasta]] as const) {
    if (!Number.isInteger(v) || v < 1 || v > 9999999) throw new Error(`Inutilización: número "${n}" inválido (${v}), 1 a 9999999.`);
  }
  if (ev.hasta < ev.desde) throw new Error("Inutilización: el número final es menor que el inicial.");
  if (ev.hasta - ev.desde + 1 > 1000) throw new Error("Inutilización: el rango máximo es de 1000 números (GEI005).");
  if (![1, 4, 5, 6, 7].includes(ev.tipo)) throw new Error(`Inutilización: tipo de documento inválido (${ev.tipo}).`);
  if (ev.serie !== undefined && !/^[A-Z]{2}$/.test(ev.serie)) throw new Error("Inutilización: la serie debe ser 2 letras mayúsculas (dSerieNum).");
  const grupo = `<rGeVeInu>` + // GEI001
    `<dNumTim>${ev.timbrado}</dNumTim>` + // GEI002
    `<dEst>${ev.establecimiento}</dEst>` + // GEI003
    `<dPunExp>${ev.punto}</dPunExp>` + // GEI004
    `<dNumIn>${String(ev.desde).padStart(7, "0")}</dNumIn>` + // GEI005
    `<dNumFin>${String(ev.hasta).padStart(7, "0")}</dNumFin>` + // GEI006
    `<iTiDE>${ev.tipo}</iTiDE>` + // GEI007
    `<mOtEve>${escaparXml(motivoValido(ev.motivo))}</mOtEve>` + // GEI008
    (ev.serie ? `<dSerieNum>${ev.serie}</dSerieNum>` : "") + // NT 10
    `</rGeVeInu>`;
  return envolver(ev.id ?? idEventoAleatorio(), ev.fechaFirma ?? ahoraAsuncion(), grupo);
}

// ─── Eventos del receptor (MT v150 11.5.2; XSD Evento_v150.xsd: trGeVeNotRec, trGeVeConf, trGeVeDisconf, trGeVeDescon) ───
// Los firma quien RECIBIÓ el DTE (el RUC del certificado debe ser el receptor del documento). Guía de Pruebas §4.3
// pide 3 de cada uno + 3 "ajustes" (un evento nuevo sobre un CDC que ya tenía otro).

/** Receptor que se informa en notificación y desconocimiento. tipo 1 = contribuyente (RUC y DV), 2 = no contribuyente. */
export interface ReceptorEvento {
  tipo: 1 | 2; // iTipRec
  nombre: string; // dNomRec (4-255)
  ruc?: string; // dRucRec (sin DV)
  dv?: string; // dDVRec
  documentoTipo?: number; // dTipIDRec
  documentoNumero?: string; // dNumID
}

export type EventoReceptor = EventoBase & { cdc: string } & (
  | { evento: "notificacion"; fechaEmision: string; fechaRecepcion: string; receptor: ReceptorEvento; totalGs: number }
  | { evento: "conformidad"; parcial?: boolean; fechaRecepcion?: string }
  | { evento: "disconformidad"; motivo: string }
  | { evento: "desconocimiento"; fechaEmision: string; fechaRecepcion: string; receptor: ReceptorEvento; motivo: string }
);

function fechaHora(f: string, campo: string): string {
  if (!/^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}$/.test(f ?? "")) throw new Error(`${campo} inválida ("${f}"): AAAA-MM-DDThh:mm:ss.`);
  return f;
}

function receptorXml(r: ReceptorEvento, rangoTipoDoc: RegExp): string {
  const nombre = limpiarTexto(r?.nombre ?? "");
  if (nombre.length < 4 || nombre.length > 255) throw new Error("Evento del receptor: nombre de 4 a 255 caracteres (dNomRec).");
  let x = `<iTipRec>${r.tipo}</iTipRec><dNomRec>${escaparXml(nombre)}</dNomRec>`;
  if (r.tipo === 1) {
    if (!/^[1-9]\d{2,7}$/.test(r.ruc ?? "") || !/^\d$/.test(r.dv ?? "")) throw new Error("Evento del receptor: contribuyente con RUC (3-8 dígitos, sin DV) y DV de 1 dígito.");
    x += `<dRucRec>${r.ruc}</dRucRec><dDVRec>${r.dv}</dDVRec>`;
  } else if (r.tipo === 2) {
    if (!rangoTipoDoc.test(String(r.documentoTipo ?? "")) || !/^[0-9A-Za-z-]{1,20}$/.test(r.documentoNumero ?? "")) {
      throw new Error("Evento del receptor: no contribuyente con tipo y número de documento.");
    }
    x += `<dTipIDRec>${r.documentoTipo}</dTipIDRec><dNumID>${r.documentoNumero}</dNumID>`;
  } else throw new Error(`Evento del receptor: tipo de receptor inválido (${(r as { tipo?: unknown })?.tipo}), 1 o 2.`);
  return x;
}

/** Evento del receptor: notificación de recepción, conformidad, disconformidad o desconocimiento. */
export function xmlEventoReceptor(ev: EventoReceptor): XmlEvento {
  if (!validarCdc(ev?.cdc)) throw new Error(`Evento del receptor: CDC inválido ("${ev?.cdc ?? ""}").`);
  const id = `<Id>${ev.cdc}</Id>`;
  let grupo: string;
  switch (ev.evento) {
    case "notificacion": {
      if (!Number.isFinite(ev.totalGs) || ev.totalGs < 0) throw new Error("Notificación de recepción: total en guaraníes inválido (dTotalGs).");
      grupo = `<rGeVeNotRec>${id}` +
        `<dFecEmi>${fechaHora(ev.fechaEmision, "Fecha de emisión del DE")}</dFecEmi>` +
        `<dFecRecep>${fechaHora(ev.fechaRecepcion, "Fecha de recepción")}</dFecRecep>` +
        receptorXml(ev.receptor, /^([1-6]|9)$/) +
        `<dTotalGs>${Math.round(ev.totalGs)}</dTotalGs></rGeVeNotRec>`;
      break;
    }
    case "conformidad":
      // iTipConf: 1 conformidad total, 2 parcial (dFecRecep obligatoria en la parcial).
      if (ev.parcial && !ev.fechaRecepcion) throw new Error("Conformidad parcial: falta la fecha de recepción.");
      grupo = `<rGeVeConf>${id}<iTipConf>${ev.parcial ? 2 : 1}</iTipConf>` +
        (ev.fechaRecepcion ? `<dFecRecep>${fechaHora(ev.fechaRecepcion, "Fecha de recepción")}</dFecRecep>` : "") +
        `</rGeVeConf>`;
      break;
    case "disconformidad":
      grupo = `<rGeVeDisconf>${id}<mOtEve>${escaparXml(motivoValido(ev.motivo))}</mOtEve></rGeVeDisconf>`;
      break;
    case "desconocimiento":
      grupo = `<rGeVeDescon>${id}` +
        `<dFecEmi>${fechaHora(ev.fechaEmision, "Fecha de emisión del DE")}</dFecEmi>` +
        `<dFecRecep>${fechaHora(ev.fechaRecepcion, "Fecha de recepción")}</dFecRecep>` +
        receptorXml(ev.receptor, /^[1-4]$/) +
        `<mOtEve>${escaparXml(motivoValido(ev.motivo))}</mOtEve></rGeVeDescon>`;
      break;
    default:
      throw new Error(`Evento del receptor desconocido: ${(ev as { evento?: unknown })?.evento}`);
  }
  return envolver(ev.id ?? idEventoAleatorio(), ev.fechaFirma ?? ahoraAsuncion(), grupo);
}
