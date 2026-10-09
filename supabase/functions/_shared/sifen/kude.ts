// _shared/sifen/kude.ts · KuDE (representación gráfica del DE) en PDF, con la marca Voltra.
//
// Fuente normativa: Manual Técnico SIFEN v150 (DNIT), capítulo 13 "Gráfica (KuDE)":
//   13.3   Denominación ("KuDE de Factura Electrónica", etc.), paginado "2/5", subtotales/totales
//          en la ÚLTIMA página y QR "al menos" en la primera.
//   13.4.1 Campos del encabezado (D105, D106, D131, D107, D116, D101, C004, C008, C007, D002,
//          E602, E644, D016, D018, D206/D210, D211, D213, D214, D216, D012).
//   13.4.2 Ítems (E701-E707 código, E708 descripción, E710 unidad, E711 cantidad, E721 precio
//          unitario, EA002 descuento, E732 valor de venta por tasa: exentas / 5 % / 10 %).
//   13.4.3 Subtotales y totales (F002/F004/F005 subtotales, F007 total de la operación,
//          F022 total en guaraníes, F014/F015 liquidación IVA 5 %/10 %, F016 total IVA).
//   13.4.4 Consulta en SIFEN: URL prod https://ekuatia.set.gov.py/consultas/ y test
//          https://ekuatia.set.gov.py/consultas-test/, CDC en once grupos de 4 posiciones.
//   13.4.5 Información adicional de interés del emisor (J003).
//   13.8.1 QR: mínimo 25 mm de ancho (22 mm contenido + 3 mm de margen); si es mayor, margen = 10 %.
//   Gráficas Nº 09 (FE) y Nº 10 (NCE): textos exactos de las leyendas
//     "Consulte la validez de esta Factura Electrónica con el número de CDC impreso abajo en:"
//     "ESTE DOCUMENTO ES UNA REPRESENTACIÓN GRÁFICA DE UN DOCUMENTO ELECTRÓNICO (XML)".
//   Campo C008 / D002: "Para el KuDE el formato de la fecha ... debe contener los guiones separadores".
//   Campo D211: innominado → "Sin Nombre"; D210: innominado → 0.
//
// Tipografía Inter (SIL OFL 1.1, ver supabase/sifen/fuentes/OFL.txt), embebida con pdf-lib + fontkit.

import { degrees, PDFDocument, type PDFFont, type PDFPage, rgb, StandardFonts } from "npm:pdf-lib@1.17.1";
import fontkit from "npm:@pdf-lib/fontkit@1.1.1";
import QRCode from "npm:qrcode@1.5.4";
import type { DocumentoDE, GenerarKude, ItemDE, TipoDE } from "./tipos.ts";
import { contactoReceptorDE, TIPOS_TRANSACCION } from "./xml.ts";

// tipoTransaccion opcional: si xml.ts usó otro código (op.tipoTransaccion), pasarlo igual acá.
type ArgsKude = Parameters<GenerarKude>[0] & { tipoTransaccion?: number };

// ─── Marca Voltra ───
const AZUL = rgb(0x2e / 255, 0x8b / 255, 0xd4 / 255); // #2E8BD4
const AZUL_SUAVE = rgb(0xea / 255, 0xf3 / 255, 0xfb / 255); // fondo de realce (imprime casi blanco)
const TINTA = rgb(0x10 / 255, 0x16 / 255, 0x1c / 255); // #10161C
const GRIS = rgb(0x4a / 255, 0x55 / 255, 0x60 / 255); // etiquetas
const LINEA = rgb(0xc4 / 255, 0xce / 255, 0xd8 / 255);
const CEBRA = rgb(0xf4 / 255, 0xf7 / 255, 0xfa / 255);
const BLANCO = rgb(1, 1, 1);

// ─── Página A4 (13.5: cualquier formato de papel estándar) ───
const ANCHO = 595.28;
const ALTO = 841.89;
const MARGEN = 34;
const UTIL = ANCHO - 2 * MARGEN;

/** Denominación por tipo (MT v150 §13.3). */
const NOMBRE_DOC: Record<TipoDE, string> = {
  1: "Factura Electrónica",
  4: "Autofactura Electrónica",
  5: "Nota de Crédito Electrónica",
  6: "Nota de Débito Electrónica",
  7: "Nota de Remisión Electrónica",
};

/** E401/E402 dDesMotEmi (MT v150, grupo E5). */
const MOTIVO_NOTA: Record<number, string> = {
  1: "Devolución y Ajuste de precios",
  2: "Devolución",
  3: "Descuento",
  4: "Bonificación",
  5: "Crédito incobrable",
  6: "Recupero de costo",
  7: "Recupero de gasto",
  8: "Ajuste de precio",
};

/** E710 dDesUniMed (MT v150, tabla de unidades de medida). Solo las que usa Voltra; resto: código. */
const UNIDAD: Record<number, string> = { 77: "UNI", 86: "g", 83: "kg", 89: "L" };

// ─── Formatos ───

/** Montos en guaraníes con punto de miles: 112000 → "112.000". */
export function formatoGs(n: number): string {
  const v = Math.round(n);
  const s = Math.abs(v).toString().replace(/\B(?=(\d{3})+(?!\d))/g, ".");
  return v < 0 ? `-${s}` : s;
}

function formatoCantidad(n: number): string {
  if (Number.isInteger(n)) return formatoGs(n);
  const [ent, dec] = n.toFixed(4).replace(/0+$/, "").split(".");
  return `${formatoGs(Number(ent))},${dec}`;
}

/** CDC en once grupos de 4 posiciones (MT v150 §10.1 "Representación Gráfica" y §13.4.4). */
export function cdcEnGrupos(cdc: string): string {
  return (cdc.replace(/\D/g, "").match(/.{1,4}/g) ?? []).join(" ");
}

/** D002 para el KuDE con guiones separadores: "2026-10-08T14:30:00" → "2026-10-08 14:30:00". */
function fechaHora(iso: string): string {
  return iso.replace("T", " ").slice(0, 19);
}

/** URL de consulta pública según ambiente (MT v150 §13.4.4). */
export function urlConsulta(ambiente: "test" | "prod"): string {
  return ambiente === "prod" ? "https://ekuatia.set.gov.py/consultas/" : "https://ekuatia.set.gov.py/consultas-test/";
}

/** Leyenda de consulta (Gráficas Nº 09 y 10 del MT v150). */
export function leyendaConsulta(tipo: TipoDE): string {
  return `Consulte la validez de esta ${NOMBRE_DOC[tipo]} con el número de CDC impreso abajo en:`;
}

export const LEYENDA_XML = "ESTE DOCUMENTO ES UNA REPRESENTACIÓN GRÁFICA DE UN DOCUMENTO ELECTRÓNICO (XML)";
export const MARCA_AGUA = "SIN VALOR FISCAL — PRUEBA";

// ─── Fuentes ───

export interface FuentesKude {
  regular: Uint8Array;
  semibold: Uint8Array;
  bold: Uint8Array;
}
let fuentesCache: FuentesKude | null | undefined;

/** Permite inyectar las fuentes (p. ej. si el bundle de la Edge Function no incluye los .ttf). */
export function establecerFuentesKude(f: FuentesKude | null): void {
  fuentesCache = f;
}

async function cargarFuentes(): Promise<FuentesKude | null> {
  if (fuentesCache !== undefined) return fuentesCache;
  try {
    const base = new URL("../../../sifen/fuentes/", import.meta.url);
    const [regular, semibold, bold] = await Promise.all([
      Deno.readFile(new URL("Inter-Regular.ttf", base)),
      Deno.readFile(new URL("Inter-SemiBold.ttf", base)),
      Deno.readFile(new URL("Inter-Bold.ttf", base)),
    ]);
    fuentesCache = { regular, semibold, bold };
  } catch (e) {
    console.warn("kude: no se encontraron las fuentes Inter, uso Helvetica:", (e as Error).message);
    fuentesCache = null;
  }
  return fuentesCache;
}

// ─── Dibujo ───

interface Fx {
  r: PDFFont;
  s: PDFFont;
  b: PDFFont;
  /** Helvetica (WinAnsi) no puede codificar todo; Inter sí. */
  limpiar: (t: string) => string;
}

interface Ctx {
  fx: Fx;
  textos: string[];
}

function ancho(f: PDFFont, t: string, size: number) {
  return f.widthOfTextAtSize(t, size);
}

/** Escribe una línea. `top` = borde superior de la línea (coordenadas desde arriba). */
function txt(
  ctx: Ctx,
  page: PDFPage,
  t: string,
  x: number,
  top: number,
  font: PDFFont,
  size: number,
  opt: { color?: ReturnType<typeof rgb>; align?: "left" | "right" | "center"; w?: number } = {},
) {
  const s = ctx.fx.limpiar(t);
  if (!s) return;
  let xx = x;
  if (opt.align === "right") xx = x + (opt.w ?? 0) - ancho(font, s, size);
  if (opt.align === "center") xx = x + ((opt.w ?? 0) - ancho(font, s, size)) / 2;
  page.drawText(s, { x: xx, y: ALTO - top - size * 0.92, size, font, color: opt.color ?? TINTA });
  ctx.textos.push(s);
}

/** Corta un texto en líneas que entren en `w`. Palabras más largas que `w` se parten. */
function cortar(fx: Fx, t: string, font: PDFFont, size: number, w: number): string[] {
  const out: string[] = [];
  for (const parrafo of fx.limpiar(t).split(/\r?\n/)) {
    let linea = "";
    for (const palabra0 of parrafo.split(/\s+/).filter(Boolean)) {
      let palabra = palabra0;
      while (ancho(font, palabra, size) > w) {
        // partir palabra larga
        let i = palabra.length - 1;
        while (i > 1 && ancho(font, palabra.slice(0, i), size) > w) i--;
        if (linea) {
          out.push(linea);
          linea = "";
        }
        out.push(palabra.slice(0, i));
        palabra = palabra.slice(i);
      }
      const prueba = linea ? `${linea} ${palabra}` : palabra;
      if (ancho(font, prueba, size) <= w) linea = prueba;
      else {
        out.push(linea);
        linea = palabra;
      }
    }
    out.push(linea);
  }
  return out.length ? out : [""];
}

function caja(page: PDFPage, x: number, top: number, w: number, h: number, opt: { fill?: ReturnType<typeof rgb>; borde?: boolean } = {}) {
  page.drawRectangle({
    x,
    y: ALTO - top - h,
    width: w,
    height: h,
    color: opt.fill,
    borderColor: opt.borde === false ? undefined : LINEA,
    borderWidth: opt.borde === false ? 0 : 0.7,
  });
}

function hlinea(page: PDFPage, x: number, top: number, w: number, color = LINEA, grosor = 0.6) {
  page.drawLine({ start: { x, y: ALTO - top }, end: { x: x + w, y: ALTO - top }, thickness: grosor, color });
}

// ─── Modelo de líneas "Etiqueta: valor" ───

interface Campo {
  etiqueta: string;
  valor: string;
}

/** Alto de un bloque de campos (etiqueta regular + valor semibold, con ajuste de línea). */
function medirCampos(fx: Fx, campos: Campo[], w: number, size: number): number {
  const lh = size * 1.42;
  let h = 0;
  for (const c of campos) h += cortarCampo(fx, c, w, size).length * lh;
  return h;
}

function cortarCampo(fx: Fx, c: Campo, w: number, size: number): string[] {
  const et = `${c.etiqueta}: `;
  const wEt = ancho(fx.r, fx.limpiar(et), size);
  const primera = cortar(fx, c.valor || "—", fx.s, size, Math.max(40, w - wEt));
  if (primera.length === 1) return primera;
  // continuación con el ancho completo bajo la etiqueta
  const resto = cortar(fx, primera.slice(1).join(" "), fx.s, size, w);
  return [primera[0], ...resto];
}

function dibujarCampos(ctx: Ctx, page: PDFPage, campos: Campo[], x: number, top: number, w: number, size: number) {
  const lh = size * 1.42;
  let y = top;
  for (const c of campos) {
    const et = `${c.etiqueta}: `;
    const wEt = ancho(ctx.fx.r, ctx.fx.limpiar(et), size);
    const lineas = cortarCampo(ctx.fx, c, w, size);
    txt(ctx, page, et, x, y, ctx.fx.r, size, { color: GRIS });
    lineas.forEach((l, i) => txt(ctx, page, l, i === 0 ? x + wEt : x, y + i * lh, ctx.fx.s, size));
    y += lineas.length * lh;
  }
}

// ─── Datos derivados del DE ───

function receptorTexto(doc: DocumentoDE): { id: string; nombre: string } {
  const r = doc.receptor;
  if (r.tipo === "ruc") return { id: `${r.ruc ?? ""}-${r.dv ?? ""}`, nombre: r.razonSocial ?? r.nombre ?? "" };
  if (r.tipo === "documento") return { id: r.documentoNumero ?? "", nombre: r.nombre ?? r.razonSocial ?? "" };
  // Innominado: D210 = 0 y D211 = "Sin Nombre" (MT v150, grupo D3).
  return { id: "0", nombre: "Sin Nombre" };
}

/** E732 dValorVenta por ítem = (precio − descuento) × cantidad, en la columna de su tasa (MT §13.4.2). */
function valoresItem(it: ItemDE): { exe: number; c5: number; c10: number } {
  const v = Math.round((it.precioUnitario - (it.descuentoUnitario ?? 0)) * it.cantidad);
  // iAfecIVA 2 exonerado / 3 exento → Exentas. 1 gravado y 4 gravado parcial → columna de su tasa.
  // [VERIFICAR] gravado parcial (4): el MT reparte la base; Voltra no lo usa hoy.
  if (it.ivaAfectacion === 2 || it.ivaAfectacion === 3 || it.ivaTasa === 0) return { exe: v, c5: 0, c10: 0 };
  return it.ivaTasa === 5 ? { exe: 0, c5: v, c10: 0 } : { exe: 0, c5: 0, c10: v };
}

// ─── Columnas de la tabla de ítems (MT §13.4.2) ───
const COLS = [
  { k: "cod", t: "Cód.", w: 58, a: "left" },
  { k: "desc", t: "Descripción", w: 152, a: "left" },
  { k: "uni", t: "Unidad", w: 32, a: "center" },
  { k: "cant", t: "Cant.", w: 32, a: "right" },
  { k: "pu", t: "Precio unit.", w: 54, a: "right" },
  { k: "dto", t: "Descuento", w: 48, a: "right" },
  { k: "exe", t: "Exentas", w: 48, a: "right" },
  { k: "c5", t: "5%", w: 48, a: "right" },
  { k: "c10", t: "10%", w: UTIL - (58 + 152 + 32 + 32 + 54 + 48 + 48 + 48), a: "right" },
] as const;
const PAD = 4;
const FS_ITEM = 7.6;
const LH_ITEM = FS_ITEM * 1.32;
const ALTO_CAB_TABLA = 28;
const ALTO_PIE = 132; // bloque de consulta (QR + CDC + leyendas), en todas las páginas
const QR_TOTAL = 104; // pt ≈ 36,7 mm (≥ 25 mm, MT §13.8.1)

interface FilaItem {
  celdas: Record<string, string[]>;
  alto: number;
}

// ─── Generador ───

export interface KudeDetalle {
  pdf: Uint8Array;
  /** Textos dibujados (para tests). */
  textos: string[];
  paginas: number;
  /** Matriz del QR dibujado (true = módulo oscuro), para verificar que decodifica a urlQr. */
  qr: { tamano: number; modulos: boolean[] };
}

export async function generarKudeDetalle(args: ArgsKude): Promise<KudeDetalle> {
  const { doc, emisor, totales } = args;
  const pdf = await PDFDocument.create();
  const nombreDoc = NOMBRE_DOC[doc.tipo];
  const numero = `${doc.establecimiento}-${doc.punto}-${String(doc.numero).padStart(7, "0")}`;
  pdf.setTitle(`KuDE de ${nombreDoc} ${numero}`);
  pdf.setSubject(`CDC ${args.cdc}`);
  pdf.setAuthor(emisor.razonSocial);
  pdf.setCreator("Voltra OS · SIFEN propio");
  pdf.setProducer("pdf-lib");
  pdf.setLanguage("es-PY");

  const bytes = await cargarFuentes();
  let fx: Fx;
  if (bytes) {
    pdf.registerFontkit(fontkit);
    const [r, s, b] = await Promise.all([
      pdf.embedFont(bytes.regular, { subset: true }),
      pdf.embedFont(bytes.semibold, { subset: true }),
      pdf.embedFont(bytes.bold, { subset: true }),
    ]);
    fx = { r, s, b, limpiar: (t) => t.replace(/\t/g, " ") };
  } else {
    const [r, s, b] = await Promise.all([
      pdf.embedFont(StandardFonts.Helvetica),
      pdf.embedFont(StandardFonts.HelveticaBold),
      pdf.embedFont(StandardFonts.HelveticaBold),
    ]);
    // WinAnsi: reemplaza lo que no se puede codificar.
    fx = {
      r,
      s,
      b,
      limpiar: (t) =>
        [...t.replace(/\t/g, " ")].map((ch) => {
          try {
            r.encodeText(ch);
            return ch;
          } catch {
            return "?";
          }
        }).join(""),
    };
  }
  const ctx: Ctx = { fx, textos: [] };

  // ── Bloque emisor (MT §13.4.1 "Datos del emisor" y "Datos de timbrado") ──
  const colIzqW = UTIL * 0.58 - 16;
  const colDerX = MARGEN + UTIL * 0.58 + 12;
  const colDerW = UTIL * 0.42 - 24;
  const fantasia = emisor.nombreFantasia || emisor.razonSocial;
  const actividades = emisor.actividades.map((a) => a.descripcion).join("; ");
  const camposEmisor: Campo[] = [
    { etiqueta: "Actividad económica", valor: actividades }, // D131
    { etiqueta: "Dirección", valor: `${emisor.direccion} Nº ${emisor.numeroCasa}` }, // D107/D108
    { etiqueta: "Ciudad", valor: `${emisor.ciudad.descripcion} · ${emisor.departamento.descripcion}` }, // D116
    { etiqueta: "Teléfono", valor: emisor.telefono }, // D115
    { etiqueta: "Correo", valor: emisor.email }, // D117
  ];
  const FS_EM = 8;
  const altoEmisorIzq = 26 + 14 + medirCampos(fx, camposEmisor, colIzqW, FS_EM);
  const camposTimbrado: Campo[] = [
    { etiqueta: "RUC", valor: `${emisor.ruc}-${emisor.dv}` }, // D101-D102
    { etiqueta: "Timbrado Nº", valor: args.timbrado }, // C004
    { etiqueta: "Fecha de inicio de vigencia", valor: args.timbradoInicio }, // C008 AAAA-MM-DD
  ];
  const FS_TIM = 8.6;
  const tituloDoc = nombreDoc.toLocaleUpperCase("es");
  // Denominación en una sola línea: se achica hasta entrar en el panel.
  let fsTit = 13;
  while (ancho(fx.b, fx.limpiar(tituloDoc), fsTit) > colDerW && fsTit > 9) fsTit -= 0.25;
  const titLineas = cortar(fx, tituloDoc, fx.b, fsTit, colDerW);
  const altoTimbrado = medirCampos(fx, camposTimbrado, colDerW, FS_TIM) + 10 + titLineas.length * 16 + 18;
  const altoEmisor = Math.max(altoEmisorIzq, altoTimbrado) + 20;

  // ── Bloque datos generales + receptor (MT §13.4.1) ──
  const rec = receptorTexto(doc);
  const camposGen: Campo[] = [{ etiqueta: "Fecha y hora de emisión", valor: fechaHora(doc.fechaEmision) }]; // D002
  if (doc.condicion) {
    camposGen.push({ etiqueta: "Condición de venta", valor: doc.condicion.tipo === 1 ? "Contado" : "Crédito" }); // E602
  }
  camposGen.push({ etiqueta: "Moneda", valor: "PYG · Guaraní" }); // D015/D016 (sin tipo de cambio: PYG)
  if (doc.asociado) {
    // Grupo H (documento asociado). H002 iTipDocAso: 1 electrónico, 2 impreso, 3 constancia.
    const tipoAso = { 1: "Electrónico", 2: "Impreso", 3: "Constancia electrónica" }[doc.asociado.tipo];
    camposGen.push({ etiqueta: "Tipo de documento asociado", valor: tipoAso });
  }
  // Documento asociado a ancho completo (el CDC agrupado no entra en media columna).
  const camposAso: Campo[] = [];
  if (doc.asociado?.cdc) {
    camposAso.push({ etiqueta: "Documento asociado (CDC)", valor: cdcEnGrupos(doc.asociado.cdc) }); // H002 dCdCDERef
  }
  const camposRec: Campo[] = [
    { etiqueta: "RUC/Documento de identidad Nº", valor: rec.id }, // D206/D210
    { etiqueta: "Nombre o razón social", valor: rec.nombre }, // D211
  ];
  const r = doc.receptor;
  // MT §13.2: el KuDE no puede mostrar nada que no esté en el XML → mismos datos que xml.ts.
  const ct = contactoReceptorDE(r);
  if (ct.direccion) camposRec.push({ etiqueta: "Dirección", valor: `${ct.direccion} Nº ${ct.numeroCasa}` }); // D213/D218
  if (ct.telefono) camposRec.push({ etiqueta: "Teléfono", valor: ct.telefono }); // D214
  if (ct.celular) camposRec.push({ etiqueta: "Celular", valor: ct.celular }); // D215
  if (ct.email) camposRec.push({ etiqueta: "Correo electrónico", valor: ct.email }); // D216
  if (doc.tipo === 1 || doc.tipo === 4) {
    // D012 dDesTipTra: mismo código que xml.ts (FE: 1 venta de mercadería; AF: 10 compra de productos).
    const af = doc.autofactura as { tipoTransaccion?: number } | undefined;
    const codTra = args.tipoTransaccion ?? (doc.tipo === 4 ? (af?.tipoTransaccion ?? 10) : 1);
    camposRec.push({ etiqueta: "Tipo de transacción", valor: TIPOS_TRANSACCION[codTra] ?? String(codTra) });
  }
  if ((doc.tipo === 5 || doc.tipo === 6) && doc.motivoNota) {
    camposRec.push({ etiqueta: "Motivo de emisión", valor: MOTIVO_NOTA[doc.motivoNota] ?? String(doc.motivoNota) }); // E402
  }
  const FS_DAT = 8;
  const colDatW = UTIL / 2 - 20;
  const altoCols = Math.max(medirCampos(fx, camposGen, colDatW, FS_DAT), medirCampos(fx, camposRec, colDatW, FS_DAT));
  const altoAso = camposAso.length ? medirCampos(fx, camposAso, UTIL - 20, FS_DAT) + 10 : 0;
  const altoDatos = altoCols + altoAso + 18;

  // ── Filas de ítems ──
  const filas: FilaItem[] = doc.items.map((it) => {
    const v = valoresItem(it);
    const celdas: Record<string, string[]> = {
      cod: cortar(fx, it.codigo, fx.r, FS_ITEM, COLS[0].w - 2 * PAD),
      desc: cortar(fx, it.descripcion, fx.r, FS_ITEM, COLS[1].w - 2 * PAD),
      uni: [UNIDAD[it.unidadMedida] ?? String(it.unidadMedida)],
      cant: [formatoCantidad(it.cantidad)],
      pu: [formatoGs(it.precioUnitario)],
      dto: [it.descuentoUnitario ? formatoGs(it.descuentoUnitario) : "0"],
      exe: [formatoGs(v.exe)],
      c5: [formatoGs(v.c5)],
      c10: [formatoGs(v.c10)],
    };
    const n = Math.max(celdas.cod.length, celdas.desc.length);
    return { celdas, alto: n * LH_ITEM + 2 * PAD + 1 };
  });

  // ── Totales (MT §13.4.3) ──
  const FS_TOT = 8.4;
  const RH_TOT = 17;
  const tieneDto = totales.descuentoTotal > 0;
  const obs = doc.observacion?.trim();
  const obsLineas = obs ? cortar(fx, obs, fx.r, 7.6, UTIL - 20) : [];
  const altoTotales = RH_TOT * (4 + (tieneDto ? 1 : 0)) + 8 + (obs ? 16 + obsLineas.length * 10.5 + 6 : 0);

  // ── Paginado (MT §13.3) ──
  const topCuerpo = MARGEN + 22 + altoEmisor + 8 + altoDatos + 8;
  const topFilas = topCuerpo + ALTO_CAB_TABLA;
  const limite = ALTO - MARGEN - ALTO_PIE - 8;
  const paginasFilas: number[][] = [[]];
  let y = topFilas;
  filas.forEach((f, i) => {
    if (y + f.alto > limite && paginasFilas[paginasFilas.length - 1].length > 0) {
      paginasFilas.push([]);
      y = topFilas;
    }
    paginasFilas[paginasFilas.length - 1].push(i);
    y += f.alto;
  });
  if (y + altoTotales > limite) {
    // Los totales no entran: página nueva. Se lleva el último ítem para que la tabla no quede vacía.
    const ult = paginasFilas[paginasFilas.length - 1];
    paginasFilas.push(ult.length > 1 ? [ult.pop()!] : []);
  }
  const totalPaginas = paginasFilas.length;

  // ── QR (MT §13.8) ──
  const qr = QRCode.create(args.urlQr, { errorCorrectionLevel: "M" });
  const qrN: number = qr.modules.size;
  const qrMod: boolean[] = Array.from({ length: qrN * qrN }, (_, i) => Boolean(qr.modules.data[i]));

  const urlCons = urlConsulta(args.ambiente);
  const conMarca = args.simulado === true || args.ambiente === "test";

  for (let p = 0; p < totalPaginas; p++) {
    const page = pdf.addPage([ANCHO, ALTO]);
    page.drawRectangle({ x: 0, y: 0, width: ANCHO, height: ALTO, color: BLANCO });

    // Barra superior: denominación (MT §13.3) + página n/total.
    caja(page, MARGEN, MARGEN, UTIL, 22, { fill: AZUL, borde: false });
    txt(ctx, page, `KuDE de ${nombreDoc}`, MARGEN + 10, MARGEN + 6.5, fx.s, 9.5, { color: BLANCO });
    txt(ctx, page, `Página ${p + 1}/${totalPaginas}`, MARGEN, MARGEN + 7, fx.r, 8.5, {
      color: BLANCO,
      align: "right",
      w: UTIL - 10,
    });

    // Emisor
    const topEm = MARGEN + 22;
    caja(page, MARGEN, topEm, UTIL, altoEmisor);
    // panel derecho (timbrado) con fondo suave
    caja(page, colDerX - 12, topEm, MARGEN + UTIL - (colDerX - 12), altoEmisor, { fill: AZUL_SUAVE });
    txt(ctx, page, fantasia, MARGEN + 12, topEm + 10, fx.b, 21, { color: AZUL }); // D106
    txt(ctx, page, emisor.razonSocial, MARGEN + 12, topEm + 38, fx.s, 9.6); // D105
    dibujarCampos(ctx, page, camposEmisor, MARGEN + 12, topEm + 54, colIzqW, FS_EM);
    dibujarCampos(ctx, page, camposTimbrado, colDerX, topEm + 10, colDerW, FS_TIM);
    let yt = topEm + 10 + medirCampos(fx, camposTimbrado, colDerW, FS_TIM) + 10;
    for (const l of titLineas) {
      txt(ctx, page, l, colDerX, yt, fx.b, fsTit); // C002 denominación
      yt += 16;
    }
    txt(ctx, page, `Nº ${numero}`, colDerX, yt + 1, fx.b, 13, { color: AZUL }); // C007

    // Datos generales + receptor
    const topDat = topEm + altoEmisor + 8;
    caja(page, MARGEN, topDat, UTIL, altoDatos);
    page.drawLine({
      start: { x: MARGEN + UTIL / 2, y: ALTO - topDat - 8 },
      end: { x: MARGEN + UTIL / 2, y: ALTO - topDat - 9 - altoCols },
      thickness: 0.6,
      color: LINEA,
    });
    dibujarCampos(ctx, page, camposGen, MARGEN + 10, topDat + 9, colDatW, FS_DAT);
    dibujarCampos(ctx, page, camposRec, MARGEN + UTIL / 2 + 10, topDat + 9, colDatW, FS_DAT);
    if (camposAso.length) {
      hlinea(page, MARGEN + 10, topDat + 9 + altoCols + 4, UTIL - 20);
      dibujarCampos(ctx, page, camposAso, MARGEN + 10, topDat + 9 + altoCols + 10, UTIL - 20, FS_DAT);
    }

    // Encabezado de tabla (repetido en cada página)
    caja(page, MARGEN, topCuerpo, UTIL, ALTO_CAB_TABLA, { fill: AZUL, borde: false });
    let x = MARGEN;
    const xCol: Record<string, number> = {};
    for (const c of COLS) {
      xCol[c.k] = x;
      x += c.w;
    }
    const xVV = xCol.exe;
    const wVV = MARGEN + UTIL - xVV;
    txt(ctx, page, "Valor de venta", xVV, topCuerpo + 4, fx.s, 7.4, { color: BLANCO, align: "center", w: wVV });
    page.drawLine({
      start: { x: xVV + 4, y: ALTO - topCuerpo - 14 },
      end: { x: xVV + wVV - 4, y: ALTO - topCuerpo - 14 },
      thickness: 0.5,
      color: BLANCO,
    });
    for (const c of COLS) {
      const enVV = c.k === "exe" || c.k === "c5" || c.k === "c10";
      const top = enVV ? topCuerpo + 17 : topCuerpo + 10;
      txt(ctx, page, c.t, xCol[c.k] + PAD, top, fx.s, 7.4, { color: BLANCO, align: c.a, w: c.w - 2 * PAD });
    }

    // Filas
    let yf = topFilas;
    paginasFilas[p].forEach((idx, j) => {
      const f = filas[idx];
      if (j % 2 === 1) caja(page, MARGEN, yf, UTIL, f.alto, { fill: CEBRA, borde: false });
      for (const c of COLS) {
        f.celdas[c.k].forEach((l, li) =>
          txt(ctx, page, l, xCol[c.k] + PAD, yf + PAD + li * LH_ITEM, fx.r, FS_ITEM, { align: c.a, w: c.w - 2 * PAD })
        );
      }
      yf += f.alto;
      hlinea(page, MARGEN, yf, UTIL, LINEA, 0.4);
    });
    if (paginasFilas[p].length === 0) {
      txt(ctx, page, "(continúa de la página anterior)", MARGEN + PAD, yf + 6, fx.r, 7.4, { color: GRIS });
      yf += 20;
    }
    if (p < totalPaginas - 1) {
      txt(ctx, page, "Continúa en la página siguiente…", MARGEN, yf + 6, fx.r, 7.6, { color: GRIS, align: "right", w: UTIL });
    }
    // marco de la tabla
    caja(page, MARGEN, topCuerpo, UTIL, yf - topCuerpo);

    // Totales solo en la última página (MT §13.3)
    if (p === totalPaginas - 1) {
      let yy = yf + 8;
      const xNum = xCol.c10;
      const wNum = MARGEN + UTIL - xNum;
      const fila = (etq: string, valor: string, opt: { fuerte?: boolean; fill?: ReturnType<typeof rgb> } = {}) => {
        caja(page, MARGEN, yy, UTIL, RH_TOT, { fill: opt.fill });
        const f = opt.fuerte ? fx.b : fx.s;
        const size = opt.fuerte ? 9.4 : FS_TOT;
        txt(ctx, page, etq, MARGEN + 8, yy + (RH_TOT - size) / 2, f, size);
        txt(ctx, page, valor, xNum + PAD, yy + (RH_TOT - size) / 2, f, size, { align: "right", w: wNum - 2 * PAD });
        yy += RH_TOT;
      };
      // SUBTOTAL por columna: F002 (exentas = exento + exonerado), F004 (5 %), F005 (10 %).
      caja(page, MARGEN, yy, UTIL, RH_TOT);
      txt(ctx, page, "SUBTOTAL:", MARGEN + 8, yy + (RH_TOT - FS_TOT) / 2, fx.s, FS_TOT);
      for (
        const [k, v] of [["exe", totales.exento + totales.exonerado], ["c5", totales.gravado5], ["c10", totales.gravado10]] as const
      ) {
        const c = COLS.find((cc) => cc.k === k)!;
        txt(ctx, page, formatoGs(v), xCol[k] + PAD, yy + (RH_TOT - FS_TOT) / 2, fx.s, FS_TOT, { align: "right", w: c.w - 2 * PAD });
      }
      yy += RH_TOT;
      if (tieneDto) fila("TOTAL DESCUENTO (ya aplicado en el valor de venta):", formatoGs(totales.descuentoTotal)); // F009 dTotDesc
      fila("TOTAL A PAGAR (TOTAL DE LA OPERACIÓN):", formatoGs(totales.total), { fuerte: true, fill: AZUL_SUAVE }); // F007/F008
      fila("TOTAL EN GUARANÍES:", formatoGs(totales.total)); // F022 (moneda PYG)
      // LIQUIDACIÓN IVA: F014 (5 %), F015 (10 %), F016 total.
      caja(page, MARGEN, yy, UTIL, RH_TOT);
      const yl = yy + (RH_TOT - FS_TOT) / 2;
      txt(ctx, page, "LIQUIDACIÓN IVA:", MARGEN + 8, yl, fx.s, FS_TOT);
      txt(ctx, page, `(5%)  ${formatoGs(totales.iva5)}`, MARGEN + 130, yl, fx.s, FS_TOT);
      txt(ctx, page, `(10%)  ${formatoGs(totales.iva10)}`, MARGEN + 250, yl, fx.s, FS_TOT);
      txt(ctx, page, "TOTAL IVA:", xCol.exe + PAD, yl, fx.s, FS_TOT);
      txt(ctx, page, formatoGs(totales.totalIva), xNum + PAD, yl, fx.s, FS_TOT, { align: "right", w: wNum - 2 * PAD });
      yy += RH_TOT;
      if (obs) {
        // MT §13.4.5: información de interés del facturador electrónico emisor.
        yy += 8;
        txt(ctx, page, "Información de interés del facturador electrónico emisor:", MARGEN + 2, yy, fx.s, 7.8);
        yy += 13;
        for (const l of obsLineas) {
          txt(ctx, page, l, MARGEN + 2, yy, fx.r, 7.6);
          yy += 10.5;
        }
      }
    }

    // Pie de consulta + QR en TODAS las páginas (MT §13.3 exige al menos la primera; §13.4.4).
    const topPie = ALTO - MARGEN - ALTO_PIE;
    caja(page, MARGEN, topPie, UTIL, ALTO_PIE);
    const qrX = MARGEN + 10;
    const qrTop = topPie + (ALTO_PIE - QR_TOTAL) / 2;
    dibujarQr(page, qrN, qrMod, qrX, qrTop, QR_TOTAL);
    const tx = qrX + QR_TOTAL + 14;
    const tw = MARGEN + UTIL - tx - 10;
    let yp = topPie + 14;
    for (const l of cortar(fx, leyendaConsulta(doc.tipo), fx.r, 8.6, tw)) {
      txt(ctx, page, l, tx, yp, fx.r, 8.6);
      yp += 12;
    }
    txt(ctx, page, urlCons, tx, yp, fx.s, 9, { color: AZUL });
    yp += 18;
    const cdcTxt = `CDC: ${cdcEnGrupos(args.cdc)}`;
    let fsCdc = 11;
    while (ancho(fx.s, cdcTxt, fsCdc) > tw - 16 && fsCdc > 7) fsCdc -= 0.25;
    caja(page, tx, yp, Math.min(tw, ancho(fx.s, cdcTxt, fsCdc) + 16), fsCdc + 12, { fill: AZUL_SUAVE, borde: false });
    page.drawRectangle({ x: tx, y: ALTO - yp - fsCdc - 12, width: 2.2, height: fsCdc + 12, color: AZUL });
    txt(ctx, page, cdcTxt, tx + 9, yp + 6, fx.s, fsCdc);
    yp += fsCdc + 12 + 12;
    let fsLey = 7.8;
    while (ancho(fx.s, LEYENDA_XML, fsLey) > tw && fsLey > 5.5) fsLey -= 0.2;
    txt(ctx, page, LEYENDA_XML, tx, yp, fx.s, fsLey);

    if (conMarca) dibujarMarcaAgua(ctx, page);
  }

  const out = await pdf.save({ useObjectStreams: false });
  return { pdf: out, textos: ctx.textos, paginas: totalPaginas, qr: { tamano: qrN, modulos: qrMod } };
}

function dibujarQr(page: PDFPage, n: number, mod: boolean[], x: number, top: number, total: number) {
  // Margen seguro = 10 % del ancho total por lado (MT §13.8.1).
  const quiet = total * 0.1;
  const m = (total - 2 * quiet) / n;
  page.drawRectangle({ x, y: ALTO - top - total, width: total, height: total, color: BLANCO });
  for (let row = 0; row < n; row++) {
    let c = 0;
    while (c < n) {
      if (!mod[row * n + c]) {
        c++;
        continue;
      }
      let fin = c;
      while (fin < n && mod[row * n + fin]) fin++;
      page.drawRectangle({
        x: x + quiet + c * m,
        y: ALTO - top - quiet - (row + 1) * m,
        width: (fin - c) * m + 0.02, // solapa mínima: evita líneas blancas al rasterizar
        height: m + 0.02,
        color: rgb(0, 0, 0),
      });
      c = fin;
    }
  }
}

function dibujarMarcaAgua(ctx: Ctx, page: PDFPage) {
  const f = ctx.fx.b;
  const t = ctx.fx.limpiar(MARCA_AGUA);
  const ang = Math.atan2(ALTO, ANCHO) * 0.78;
  let size = 52;
  const maxW = Math.hypot(ANCHO, ALTO) * 0.7;
  while (f.widthOfTextAtSize(t, size) > maxW) size -= 1;
  const w = f.widthOfTextAtSize(t, size);
  const capH = size * 0.72;
  const cx = ANCHO / 2;
  const cy = ALTO / 2;
  const x = cx - (w / 2) * Math.cos(ang) + (capH / 2) * Math.sin(ang);
  const y = cy - (w / 2) * Math.sin(ang) - (capH / 2) * Math.cos(ang);
  page.drawText(t, { x, y, size, font: f, color: rgb(0.85, 0.12, 0.12), opacity: 0.16, rotate: degrees((ang * 180) / Math.PI) });
  // franja legible en el borde superior, por si la marca diagonal queda tapada
  page.drawText(t, {
    x: ANCHO - MARGEN - f.widthOfTextAtSize(t, 7.5),
    y: ALTO - MARGEN + 6,
    size: 7.5,
    font: f,
    color: rgb(0.75, 0.1, 0.1),
  });
  ctx.textos.push(t);
}

/** Contrato (tipos.ts): PDF del KuDE con la marca Voltra. */
export const generarKude: GenerarKude = async (args) => (await generarKudeDetalle(args)).pdf;
