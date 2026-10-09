// _shared/sifen/eventos_xml.ts · XML de eventos del emisor: cancelación e inutilización (SIN firma).
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
    `<gGroupGesEve xmlns="${NAMESPACE_SIFEN}" xmlns:xsi="http://www.w3.org/2001/XMLSchema-instance">` + // GDE000
    `<rGesEve xsi:schemaLocation="${NAMESPACE_SIFEN} siRecepEvento_v150.xsd">` + // GDE001
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
