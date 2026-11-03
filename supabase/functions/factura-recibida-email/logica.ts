// factura-recibida-email/logica.ts · 03-11-2026. Puro (sin red ni base): valida el cuerpo que manda el Apps Script,
// clasifica y sanea los adjuntos, lee el XML de SIFEN y arma la fila de public.facturas_recibidas.
// Contrato: docs/contrato-imprimir-facturas-03-11.md §2.
// XML de SIFEN (Manual Técnico v150): rDE > DE(@Id = CDC) > gTimb(dEst, dPunExp, dNumDoc), gDatGralOpe(dFeEmiDE,
//   gEmis(dRucEm, dDVEmi, dNomEmi), gDatRec(dRucRec)), gTotSub(dTotGralOpe). El lector ignora prefijos (ns2:).
import { valor } from "../_shared/sifen/soap.ts";

/** RUC de Voltra EAS (sin DV). Si el XML dice otro receptor, la factura no es de Voltra. */
export const RUC_VOLTRA = "80177762";
export const MAX_ADJUNTOS = 6;
export const MAX_BYTES = 5 * 1024 * 1024;

export interface AdjuntoEntrada {
  nombre: string;
  tipo: string;
  base64: string;
}

export interface CuerpoValido {
  id: string;
  remitente: string | null;
  asunto: string | null;
  /** ISO normalizado. */
  fecha: string;
  adjuntos: AdjuntoEntrada[];
}

export type Clase = "pdf" | "xml";

export interface AdjuntoListo {
  clase: Clase;
  nombre: string;
  /** Ruta dentro del bucket 'facturas': recibidas/<id>/<nombre saneado>. */
  ruta: string;
  contentType: string;
  bytes: Uint8Array;
}

export interface DatosSifen {
  cdc: string | null;
  proveedor: string | null;
  ruc_emisor: string | null;
  numero: string | null;
  fecha_doc: string | null;
  total: number | null;
  receptor_ruc: string | null;
}

export interface FilaRecibida {
  gmail_id: string;
  recibida_en: string;
  remitente: string | null;
  asunto: string | null;
  proveedor: string | null;
  ruc_emisor: string | null;
  numero: string | null;
  cdc: string | null;
  fecha_doc: string | null;
  total: number | null;
  receptor_ruc: string | null;
  pdf_path: string | null;
  xml_path: string | null;
  es_de_voltra: boolean | null;
  /** Solo se manda cuando el XML dice otro receptor: así un reenvío no deshace un descarte hecho a mano. */
  descartada?: true;
}

// Gmail usa ids hexadecimales; se acota para que el id no pueda salir del prefijo en Storage.
const ID_VALIDO = /^[A-Za-z0-9_-]{1,64}$/;

const texto = (v: unknown, max: number): string | null => {
  if (typeof v !== "string") return null;
  const t = v.trim();
  return t ? t.slice(0, max) : null;
};

/** Valida el cuerpo. Error = 400 (el script no etiqueta y el correo se reintenta). */
export function validarCuerpo(b: unknown): { ok: true; datos: CuerpoValido } | { ok: false; error: string } {
  if (!b || typeof b !== "object") return { ok: false, error: "cuerpo inválido" };
  const o = b as Record<string, unknown>;
  const id = typeof o.id === "string" ? o.id.trim() : "";
  if (!ID_VALIDO.test(id)) return { ok: false, error: "id inválido" };
  const f = typeof o.fecha === "string" ? new Date(o.fecha) : null;
  if (!f || Number.isNaN(f.getTime())) return { ok: false, error: "fecha inválida" };
  if (!Array.isArray(o.adjuntos)) return { ok: false, error: "adjuntos debe ser una lista" };
  if (o.adjuntos.length > MAX_ADJUNTOS) return { ok: false, error: `más de ${MAX_ADJUNTOS} adjuntos` };
  const adjuntos: AdjuntoEntrada[] = [];
  for (const a of o.adjuntos) {
    const x = (a ?? {}) as Record<string, unknown>;
    if (typeof x.base64 !== "string" || typeof x.nombre !== "string") return { ok: false, error: "adjunto sin nombre o base64" };
    adjuntos.push({ nombre: x.nombre, tipo: typeof x.tipo === "string" ? x.tipo : "", base64: x.base64 });
  }
  return {
    ok: true,
    datos: { id, remitente: texto(o.remitente, 300), asunto: texto(o.asunto, 500), fecha: f.toISOString(), adjuntos },
  };
}

/** pdf / xml según tipo MIME o extensión (Gmail a veces manda application/octet-stream). null = se ignora. */
export function clasificarAdjunto(nombre: string, tipo: string): Clase | null {
  const t = (tipo ?? "").toLowerCase().split(";")[0].trim();
  const n = (nombre ?? "").toLowerCase().trim();
  if (t === "application/pdf" || n.endsWith(".pdf")) return "pdf";
  if (t === "text/xml" || t === "application/xml" || n.endsWith(".xml")) return "xml";
  return null;
}

/** Nombre seguro para Storage: sin tildes ni barras, solo [A-Za-z0-9._-], con extensión, sin repetir dentro del correo. */
export function sanearNombre(nombre: string, clase: Clase, usados: Set<string>): string {
  const ext = "." + clase;
  let base = (nombre ?? "").normalize("NFD").replace(/[̀-ͯ]/g, "");
  base = base.split(/[\\/]/).pop() ?? "";
  if (base.toLowerCase().endsWith(ext)) base = base.slice(0, -ext.length);
  base = base.replace(/[^A-Za-z0-9._-]+/g, "_").replace(/_+/g, "_").replace(/^[._-]+|[._-]+$/g, "").slice(0, 100);
  if (!base) base = "adjunto";
  let final = base + ext;
  for (let i = 2; usados.has(final.toLowerCase()); i++) final = `${base}_${i}${ext}`;
  usados.add(final.toLowerCase());
  return final;
}

/** Bytes que ocupa un base64 sin decodificarlo (para cortar antes de gastar memoria). */
export function bytesDeBase64(b64: string): number {
  const s = b64.replace(/\s+/g, "");
  const relleno = s.endsWith("==") ? 2 : s.endsWith("=") ? 1 : 0;
  return Math.floor((s.length * 3) / 4) - relleno;
}

/** Decodifica base64 estándar o URL-safe (Apps Script Utilities.base64Encode usa el estándar). null si no es base64. */
export function decodificarBase64(b64: string): Uint8Array | null {
  const s = b64.replace(/\s+/g, "").replace(/-/g, "+").replace(/_/g, "/");
  if (!/^[A-Za-z0-9+/]*={0,2}$/.test(s)) return null;
  try {
    const bin = atob(s);
    const out = new Uint8Array(bin.length);
    for (let i = 0; i < bin.length; i++) out[i] = bin.charCodeAt(i);
    return out;
  } catch {
    return null;
  }
}

/** Arma lo que se sube. Lo que no es PDF/XML, pasa de 5 MB o no decodifica se omite (con motivo) y no frena el resto. */
export function prepararAdjuntos(id: string, adjuntos: AdjuntoEntrada[]): { listos: AdjuntoListo[]; omitidos: string[] } {
  const usados = new Set<string>();
  const listos: AdjuntoListo[] = [];
  const omitidos: string[] = [];
  for (const a of adjuntos) {
    const clase = clasificarAdjunto(a.nombre, a.tipo);
    if (!clase) { omitidos.push(`${a.nombre}: no es PDF ni XML`); continue; }
    if (bytesDeBase64(a.base64) > MAX_BYTES) { omitidos.push(`${a.nombre}: más de 5 MB`); continue; }
    const bytes = decodificarBase64(a.base64);
    if (!bytes || bytes.length === 0) { omitidos.push(`${a.nombre}: base64 inválido`); continue; }
    const nombre = sanearNombre(a.nombre, clase, usados);
    listos.push({
      clase,
      nombre,
      ruta: `recibidas/${id}/${nombre}`,
      contentType: clase === "pdf" ? "application/pdf" : "application/xml",
      bytes,
    });
  }
  return { listos, omitidos };
}

const soloDigitos = (s: string | undefined) => (s ?? "").replace(/\D/g, "");

/** RUC sin DV: "80177762-1" → "80177762"; "80177762" → "80177762". */
export function rucSinDv(r: string | undefined | null): string | null {
  const t = (r ?? "").trim();
  if (!t) return null;
  const d = soloDigitos(t.split("-")[0]);
  return d || null;
}

/** Lee un XML de SIFEN (rDE/DE, también envuelto en sobres). null si no es un DE. */
export function parsearXmlSifen(xml: string): DatosSifen | null {
  const x = (xml ?? "").replace(/^﻿/, "");
  // "<DE " o "<ns2:DE ": el < seguido de "r" (rDE) no entra.
  const de = /<(?:[\w.-]+:)?DE(?=[\s>])([^>]*)>/.exec(x);
  if (!de) return null;
  const idAttr = /\sId\s*=\s*["']([^"']+)["']/.exec(de[1])?.[1]?.trim();
  const cdc = idAttr && /^\d{44}$/.test(idAttr) ? idAttr : null;

  const rucEm = soloDigitos(valor(x, "dRucEm"));
  const dvEm = soloDigitos(valor(x, "dDVEmi"));
  const est = soloDigitos(valor(x, "dEst"));
  const pun = soloDigitos(valor(x, "dPunExp"));
  const num = soloDigitos(valor(x, "dNumDoc"));
  const fe = /^(\d{4}-\d{2}-\d{2})/.exec(valor(x, "dFeEmiDE") ?? "")?.[1] ?? null;
  const totTxt = (valor(x, "dTotGralOpe") ?? "").replace(/,/g, ".").trim();
  const total = totTxt && Number.isFinite(Number(totTxt)) ? Number(totTxt) : null;

  const datos: DatosSifen = {
    cdc,
    proveedor: valor(x, "dNomEmi")?.replace(/\s+/g, " ").trim() || null,
    ruc_emisor: rucEm ? (dvEm ? `${rucEm}-${dvEm}` : rucEm) : null,
    numero: est && pun && num ? `${est.padStart(3, "0")}-${pun.padStart(3, "0")}-${num.padStart(7, "0")}` : null,
    fecha_doc: fe,
    total,
    receptor_ruc: rucSinDv(valor(x, "dRucRec")),
  };
  // Un DE sin nada de lo que buscamos no se toma como factura.
  if (!datos.cdc && !datos.ruc_emisor && !datos.numero) return null;
  return datos;
}

const decodificador = new TextDecoder("utf-8");

/**
 * Fila para el upsert por gmail_id.
 * - Sin XML de SIFEN legible: es_de_voltra = null y no se descarta (lo decide una persona con el PDF).
 * - XML con receptor 80177762: es_de_voltra = true.
 * - XML con otro receptor o sin RUC receptor (consumidor final): es_de_voltra = false y descartada = true.
 * PDF: si hay varios, el que lleva el CDC en el nombre; si no, el primero.
 */
export function armarFila(c: CuerpoValido, listos: AdjuntoListo[]): FilaRecibida {
  let sifen: DatosSifen | null = null;
  let xmlPath: string | null = null;
  for (const a of listos.filter((l) => l.clase === "xml")) {
    const d = parsearXmlSifen(decodificador.decode(a.bytes));
    if (d) { sifen = d; xmlPath = a.ruta; break; }
    xmlPath ??= a.ruta;
  }
  const pdfs = listos.filter((l) => l.clase === "pdf");
  const pdf = (sifen?.cdc ? pdfs.find((p) => p.nombre.includes(sifen!.cdc!)) : undefined) ?? pdfs[0];
  const esDeVoltra = sifen ? sifen.receptor_ruc === RUC_VOLTRA : null;
  return {
    gmail_id: c.id,
    recibida_en: c.fecha,
    remitente: c.remitente,
    asunto: c.asunto,
    proveedor: sifen?.proveedor ?? null,
    ruc_emisor: sifen?.ruc_emisor ?? null,
    numero: sifen?.numero ?? null,
    cdc: sifen?.cdc ?? null,
    fecha_doc: sifen?.fecha_doc ?? null,
    total: sifen?.total ?? null,
    receptor_ruc: sifen?.receptor_ruc ?? null,
    pdf_path: pdf?.ruta ?? null,
    xml_path: xmlPath,
    es_de_voltra: esDeVoltra,
    ...(esDeVoltra === false ? { descartada: true as const } : {}),
  };
}
