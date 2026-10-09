// _shared/sifen/xml.ts · Arma el XML rDE (SIN Signature y SIN gCamFuFD) de los DE tipo 1, 4, 5, 6 y 7.
// Fuentes:
//  - Manual Técnico SIFEN v150 (DNIT), sección 10.4 y grupos AA–H (cada campo lleva su código del MT).
//  - Notas Técnicas vigentes al 2026-10-08 (NT 1 a 27): NT 10 (dDesTipTra, dKmR 1-1), NT 13 (dBasExe),
//    NT 23/24 (receptor innominado; tope innominado ₲ 7.000.000), NT 27 (solo evento de nominación).
//  - XSD oficiales: supabase/sifen/xsd/DE_v150.xsd + DE_Types_v150.xsd (el ORDEN de los elementos sigue
//    exactamente las secuencias del XSD). Catálogos: Departamentos_v141.xsd, Unidades_Medida_v141.xsd,
//    Monedas_v150.xsd, Paises_v100.xsd.
//  - MT 7.2.4 "mejores prácticas": sin espacios al inicio/fin de campos y SIN comentarios en el XML
//    generado (los códigos del MT van como comentarios del código TypeScript, no del XML).
// La firma (Signature) la agrega firma.ts y el QR (gCamFuFD) lo agrega qr.ts después de la firma.

import type {
  ArmarXmlDE,
  AsociadoDE,
  CredencialesSifen,
  DatosEmisor,
  DocumentoDE,
  ItemDE,
  ReceptorDE,
  TipoDE,
  TotalesDE,
} from "./tipos.ts";
import { armarCdc, rucConFormatoValido, validarCdc, validarRuc } from "./cdc.ts";
import { calcularTotales, DESCRIPCION_AFECTACION_IVA, type ItemCalculado, numXml } from "./totales.ts";

// ───────────────────────── Catálogos (con fuente) ─────────────────────────

export const NAMESPACE_SIFEN = "http://ekuatia.set.gov.py/sifen/xsd";
export const VERSION_FORMATO = 150; // AA002 dVerFor

/** C003 dDesTiDE (MT C003 / XSD tdDesTiDE). */
export const DESCRIPCION_TIPO_DE: Record<TipoDE, string> = {
  1: "Factura electrónica",
  4: "Autofactura electrónica",
  5: "Nota de crédito electrónica",
  6: "Nota de débito electrónica",
  7: "Nota de remisión electrónica",
};

/** B003 dDesTipEmi (MT B003). */
export const DESCRIPCION_TIPO_EMISION: Record<number, string> = { 1: "Normal", 2: "Contingencia" };

/** D012 dDesTipTra (MT D011/D012 + NT 10; valores exactos del XSD tdDesTiTran). */
export const TIPOS_TRANSACCION: Record<number, string> = {
  1: "Venta de mercadería",
  2: "Prestación de servicios",
  3: "Mixto (Venta de mercadería y servicios)",
  4: "Venta de activo fijo",
  5: "Venta de divisas",
  6: "Compra de divisas",
  7: "Promoción o entrega de muestras",
  8: "Donación",
  9: "Anticipo",
  10: "Compra de productos",
  11: "Compra de servicios",
  12: "Venta de crédito fiscal",
  13: "Muestras médicas (Art. 3 RG 24/2014)",
};

/** Monedas (Monedas_v150.xsd, ISO 4217). Solo PYG soportada por ahora. */
export const MONEDAS: Record<string, string> = { PYG: "Guarani" };

/** Países (Paises_v100.xsd). Solo PRY (operaciones locales B2B/B2C). */
export const PAISES: Record<string, string> = { PRY: "Paraguay" };

/** Departamentos (Departamentos_v141.xsd: tDepartamentos / tDesDepartamento). */
export const DEPARTAMENTOS: Record<number, string> = {
  1: "CAPITAL",
  2: "CONCEPCION",
  3: "SAN PEDRO",
  4: "CORDILLERA",
  5: "GUAIRA",
  6: "CAAGUAZU",
  7: "CAAZAPA",
  8: "ITAPUA",
  9: "MISIONES",
  10: "PARAGUARI",
  11: "ALTO PARANA",
  12: "CENTRAL",
  13: "NEEMBUCU",
  14: "AMAMBAY",
  15: "PTE. HAYES",
  16: "BOQUERON",
  17: "ALTO PARAGUAY",
  18: "CANINDEYU",
  19: "CHACO",
  20: "NUEVA ASUNCION",
};

/** Unidades de medida (Unidades_Medida_v141.xsd: cUniMed → dDesUniMed; MT Tabla 5 + NT 23). */
export const UNIDADES_MEDIDA: Record<number, string> = {
  87: "m", 2366: "CPM", 2329: "UI", 110: "M3", 77: "UNI", 86: "g", 89: "LT", 90: "MG", 91: "CM", 92: "CM2",
  93: "CM3", 94: "PUL", 96: "MM2", 79: "kg/m2", 97: "AA", 98: "ME", 99: "TN", 100: "Hs", 101: "Mi", 104: "DET",
  103: "Ya", 108: "MT", 109: "M2", 95: "MM", 666: "Se", 102: "Di", 83: "kg", 88: "ML", 625: "Km", 660: "ml",
  885: "GL", 891: "pm", 869: "ha", 569: "ración", 111: "4A", 112: "Ci", 113: "DOC", 114: "GLL", 115: "GRO",
  116: "E4", 117: "KT", 118: "M5", 119: "MCU", 120: "MIL", 121: "PAR", 122: "FOT", 123: "FTK", 124: "PCE",
  125: "KLT", 126: "RM", 127: "RO", 128: "kWh", 129: "U(JGO)", 130: "DR", 131: "BX", 132: "SET", 133: "PK",
  134: "BG", 135: "DPC", 136: "JR", 137: "BL", 138: "AB", 139: "BK", 140: "BW",
};

/** E607 dDesTiPag (MT E606/E607; el 17 dice "7=" por errata en el MT, es "Pago Móvil"). */
export const TIPOS_PAGO: Record<number, string> = {
  1: "Efectivo",
  2: "Cheque",
  3: "Tarjeta de crédito",
  4: "Tarjeta de débito",
  5: "Transferencia",
  6: "Giro",
  7: "Billetera electrónica",
  8: "Tarjeta empresarial",
  9: "Vale",
  10: "Retención",
  11: "Pago por anticipo",
  12: "Valor fiscal",
  13: "Valor comercial",
  14: "Compensación",
  15: "Permuta",
  16: "Pago bancario",
  17: "Pago Móvil",
  18: "Donación",
  19: "Promoción",
  20: "Consumo Interno",
  21: "Pago Electrónico",
};

/** E402 dDesMotEmi (MT E401/E402; XSD tdDesMotEmi). */
export const MOTIVOS_NOTA: Record<number, string> = {
  1: "Devolución y Ajuste de precios",
  2: "Devolución",
  3: "Descuento",
  4: "Bonificación",
  5: "Crédito incobrable",
  6: "Recupero de costo",
  7: "Recupero de gasto",
  8: "Ajuste de precio",
};

/** E012 dDesIndPres (MT E011/E012). */
export const INDICADOR_PRESENCIA: Record<number, string> = {
  1: "Operación presencial",
  2: "Operación electrónica",
  3: "Operación telemarketing",
  4: "Venta a domicilio",
  5: "Operación bancaria",
  6: "Operación cíclica",
};

/** D209 dDTipIDRec (MT D208/D209 + NT 23). */
export const TIPOS_DOC_RECEPTOR: Record<number, string> = {
  1: "Cédula paraguaya",
  2: "Pasaporte",
  3: "Cédula extranjera",
  4: "Carnet de residencia",
  5: "Innominado",
  6: "Tarjeta Diplomática de exoneración fiscal",
};

/** E305 / E986 dDTipIDVen / dDTipIDTrans (MT E304/E305; XSD tdDtipDoc). */
export const TIPOS_DOC_PERSONA: Record<number, string> = {
  1: "Cédula paraguaya",
  2: "Pasaporte",
  3: "Cédula extranjera",
  4: "Carnet de residencia",
};

/** E302 dDesNatVen (MT E301/E302). */
export const NATURALEZA_VENDEDOR: Record<number, string> = { 1: "No contribuyente", 2: "Extranjero" };

/** E502 dDesMotEmiNR (MT E501/E502). */
export const MOTIVOS_REMISION: Record<number, string> = {
  1: "Traslado por ventas",
  2: "Traslado por consignación",
  3: "Exportación",
  4: "Traslado por compra",
  5: "Importación",
  6: "Traslado por devolución",
  7: "Traslado entre locales de la empresa",
  8: "Traslado de bienes por transformación",
  9: "Traslado de bienes por reparación",
  10: "Traslado por emisor móvil",
  11: "Exhibición o Demostración",
  12: "Participación en ferias",
  13: "Traslado de encomienda",
  14: "Decomiso",
};

/** E504 dDesRespEmiNR (MT E503/E504). */
export const RESPONSABLE_REMISION: Record<number, string> = {
  1: "Emisor de la factura",
  2: "Poseedor de la factura y bienes",
  3: "Empresa transportista",
  4: "Despachante de Aduanas",
  5: "Agente de transporte o intermediario",
};

/** E902 / E904 (MT). */
export const TIPO_TRANSPORTE: Record<number, string> = { 1: "Propio", 2: "Tercero" };
export const MODALIDAD_TRANSPORTE: Record<number, string> = { 1: "Terrestre", 2: "Fluvial", 3: "Aéreo", 4: "Multimodal" };

/** H003 dDesTipDocAso, H010 dDTipoDocAso, H015 dDesTipCons (MT grupo H; XSD). */
export const TIPO_DOC_ASOCIADO: Record<number, string> = { 1: "Electrónico", 2: "Impreso", 3: "Constancia Electrónica" };
export const TIPO_DOC_IMPRESO: Record<number, string> = { 1: "Factura", 2: "Nota de crédito", 3: "Nota de débito", 4: "Nota de remisión" };
export const TIPO_CONSTANCIA: Record<number, string> = {
  1: "Constancia de no ser contribuyente",
  2: "Constancia de microproductores",
};

/** NT 24 (Decreto 872/2023): innominado no permitido si el total es ≥ ₲ 7.000.000. */
export const TOPE_INNOMINADO_PYG = 7_000_000;

/** Literales obligatorios en el ambiente de TEST. */
export const LEYENDA_EMISOR_PRUEBA = "DE generado en ambiente de prueba - sin valor comercial ni fiscal"; // MT D105
export const LEYENDA_ITEM_PRUEBA =
  "DOCUMENTO ELECTRÓNICO SIN VALOR COMERCIAL NI FISCAL - GENERADO EN AMBIENTE DE PRUEBA"; // Guía de Pruebas e-kuatia (set de pruebas, ítem)

/** [VERIFICAR] literal exacto del Art. 3 Inc. 7 RG 41/2014 que exige B006 en la nota de remisión (NT 7). */
export const LEYENDA_REMISION_POR_DEFECTO =
  "Nota de remisión electrónica emitida conforme al Art. 3 Inc. 7 de la Resolución General N° 41/2014";

// ─────────────────── Datos opcionales extra (sin cambiar el contrato) ───────────────────

/** Campos opcionales que el emisor puede agregar al receptor (no están en ReceptorDE). */
export interface ReceptorExtra {
  /** D205 iTiContRec. Si falta y tipo='ruc': 2 si el RUC empieza con "80" (persona jurídica), si no 1. [VERIFICAR] */
  tipoContribuyente?: 1 | 2;
  /** D209 para documentoTipo 9 ("Otro"). */
  documentoDescripcion?: string;
  departamento?: number; // D219 cDepRec
  distrito?: { codigo: number; descripcion: string }; // D221/D222
  ciudad?: { codigo: number; descripcion: string }; // D223/D224
  codigoCliente?: string; // D217
}

export interface DireccionLocal {
  direccion: string;
  numeroCasa?: string;
  departamento: number;
  distrito?: { codigo: number; descripcion: string };
  ciudad: { codigo: number; descripcion: string };
  telefono?: string;
}

/** doc.autofactura (grupo gCamAE E300 + constancia H014-H017 + D011). */
export interface DatosAutofactura {
  naturalezaVendedor: 1 | 2; // E301
  documentoTipo: 1 | 2 | 3 | 4; // E304
  documentoNumero: string; // E306
  nombre: string; // E307
  direccion: string; // E308
  numeroCasa?: string; // E309
  departamento: number; // E310
  distrito?: { codigo: number; descripcion: string }; // E312/E313
  ciudad: { codigo: number; descripcion: string }; // E314/E315
  lugar: DireccionLocal; // E316–E322 (lugar de la transacción)
  /** H014: 1 constancia de no ser contribuyente, 2 microproductores (requiere número y control). */
  constancia?: { tipo: 1 | 2; numero?: string; control?: string };
  /** D011; por defecto 10 "Compra de productos". [VERIFICAR] */
  tipoTransaccion?: number;
}

/** doc.remision (grupos gCamNRE E500 y gTransp E900). */
export interface DatosRemision {
  motivo: number; // E501
  motivoDescripcion?: string; // E502 si motivo = 99
  responsable: 1 | 2 | 3 | 4 | 5; // E503
  km: number; // E505 (1-1 desde NT 10)
  fechaFuturaFactura?: string; // E506 AAAA-MM-DD
  infoFisco?: string; // B006 (obligatorio en NR)
  transporte: {
    tipo?: 1 | 2; // E901
    modalidad: 1 | 2 | 3 | 4; // E903
    responsableFlete: 1 | 2 | 3 | 4 | 5; // E905
    inicio: string; // E909 AAAA-MM-DD
    fin: string; // E910 AAAA-MM-DD
    salida: DireccionLocal; // E920
    entregas: DireccionLocal[]; // E940 (1-99)
    vehiculos: Array<{ tipo: string; marca: string; tipoIdentificacion: 1 | 2; numeroId?: string; matricula?: string }>; // E960
    transportista?: {
      naturaleza: 1 | 2; // E981
      nombre: string; // E982
      ruc?: string; // E983
      dv?: string; // E984
      documentoTipo?: 1 | 2 | 3 | 4; // E985
      documentoNumero?: string; // E987
      choferDocumento: string; // E990
      choferNombre: string; // E991
      domicilioFiscal: string; // E992 (1-1 en el XSD)
      direccionChofer: string; // E993 (1-1 en el XSD)
    };
  };
}

/** Datos extra del documento asociado impreso (H005–H011). */
export interface AsociadoExtra {
  timbrado?: string;
  establecimiento?: string;
  punto?: string;
  numero?: number;
  tipoDocumentoImpreso?: 1 | 2 | 3 | 4;
  fecha?: string; // AAAA-MM-DD
}

/** Opciones que no están en la firma del contrato (útiles para tests y para E). */
export interface OpcionesXml {
  /** dFecFirma (A004). Por defecto: ahora, hora de Asunción. */
  fechaFirma?: string;
  /** E011 iIndPres. Por defecto 2 "Operación electrónica" (venta online). */
  indicadorPresencia?: number;
  /** D011 para FE. Por defecto 1 "Venta de mercadería". */
  tipoTransaccion?: number;
  /** E643 cuando condición = crédito. Por defecto "30 días". [VERIFICAR] */
  plazoCredito?: string;
}

// ───────────────────────────── utilidades ─────────────────────────────

/** Escape XML de texto y atributos. */
/**
 * Datos de contacto del receptor TAL COMO quedan en el XML (lo que no cumple el formato se omite).
 * El KuDE usa esta misma función: MT §13.2 "No puede existir información en el KuDE que no forme
 * parte del formato del DE firmado (XML)".
 */
export function contactoReceptorDE(r: ReceptorDE & { departamento?: unknown; ciudad?: unknown }): {
  direccion?: string; numeroCasa?: string; telefono?: string; celular?: string; email?: string;
} {
  const out: { direccion?: string; numeroCasa?: string; telefono?: string; celular?: string; email?: string } = {};
  const dir = limpiarTexto(r.direccion);
  if (dir && r.departamento && r.ciudad) { out.direccion = dir; out.numeroCasa = limpiarTexto(r.numeroCasa) || "0"; } // D213/D218
  const tel = limpiarTexto(r.telefono);
  if (tel.length >= 6 && tel.length <= 15) out.telefono = tel; // D214
  const cel = limpiarTexto(r.celular);
  if (cel.length >= 10 && cel.length <= 20) out.celular = cel; // D215
  const mail = limpiarTexto(r.email);
  if (mail.length >= 3 && mail.length <= 80 && RE_EMAIL.test(mail)) out.email = mail; // D216
  return out;
}

export function escaparXml(s: string): string {
  return s.replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;").replace(/"/g, "&quot;").replace(/'/g, "&apos;");
}

/** Limpia texto: sin caracteres de control, espacios colapsados y sin espacios al inicio/fin (MT 7.2.4). */
export function limpiarTexto(s: unknown): string {
  // deno-lint-ignore no-control-regex
  return String(s ?? "").replace(/[\u0000-\u001F\u007F]/g, " ").replace(/\s+/g, " ").trim();
}

function t(nombre: string, valor: string | number | undefined | null): string {
  if (valor === undefined || valor === null) return "";
  const v = typeof valor === "number" ? numXml(valor) : limpiarTexto(valor);
  if (v === "") return "";
  return `<${nombre}>${escaparXml(v)}</${nombre}>`;
}

function g(nombre: string, ...hijos: string[]): string {
  return `<${nombre}>${hijos.join("")}</${nombre}>`;
}

function err(msg: string): never {
  throw new Error(msg);
}

/** Fecha/hora actual en Asunción, formato AAAA-MM-DDThh:mm:ss. */
export function ahoraAsuncion(fecha: Date = new Date()): string {
  const p = new Intl.DateTimeFormat("en-CA", {
    timeZone: "America/Asuncion",
    year: "numeric",
    month: "2-digit",
    day: "2-digit",
    hour: "2-digit",
    minute: "2-digit",
    second: "2-digit",
    hourCycle: "h23",
  }).formatToParts(fecha);
  const v = (k: string) => p.find((x) => x.type === k)?.value ?? "00";
  return `${v("year")}-${v("month")}-${v("day")}T${v("hour")}:${v("minute")}:${v("second")}`;
}

function fechaValida(s: string): boolean {
  const m = /^(\d{4})-(\d{2})-(\d{2})$/.exec(s);
  if (!m) return false;
  const d = new Date(Date.UTC(+m[1], +m[2] - 1, +m[3]));
  return d.getUTCFullYear() === +m[1] && d.getUTCMonth() === +m[2] - 1 && d.getUTCDate() === +m[3];
}

function fechaHoraValida(s: string): boolean {
  const m = /^(\d{4}-\d{2}-\d{2})T(\d{2}):(\d{2}):(\d{2})$/.exec(s ?? "");
  return !!m && fechaValida(m[1]) && +m[2] < 24 && +m[3] < 60 && +m[4] < 60;
}

function numeroCasa(valor: string | undefined, campo: string): string {
  const v = limpiarTexto(valor ?? "");
  if (v === "") return "0"; // MT D108/E309/E922/E942: "Si no tiene numeración, colocar 0"
  if (!/^\d{1,6}$/.test(v)) err(`${campo}: el número de casa debe ser numérico de hasta 6 dígitos ("${valor}"). Si no tiene, dejar vacío (se informa 0).`);
  return String(Number(v));
}

function departamento(codigo: number, campo: string): string {
  const d = DEPARTAMENTOS[codigo];
  if (!d) err(`${campo}: código de departamento inexistente (${codigo}). Ver Departamentos_v141.xsd.`);
  return d;
}

function ciudad(c: { codigo: number; descripcion: string } | undefined, campo: string): { codigo: number; descripcion: string } {
  if (!c || !Number.isInteger(c.codigo) || c.codigo < 1 || c.codigo > 99999) err(`${campo}: código de ciudad inválido.`);
  const d = limpiarTexto(c.descripcion);
  if (d.length < 1 || d.length > 30) err(`${campo}: la descripción de la ciudad debe tener 1 a 30 caracteres.`);
  return { codigo: c.codigo, descripcion: d };
}

function distritoOpt(c: { codigo: number; descripcion: string } | undefined, campo: string): { codigo: number; descripcion: string } | undefined {
  if (!c || !c.codigo) return undefined;
  if (!Number.isInteger(c.codigo) || c.codigo < 1 || c.codigo > 9999) err(`${campo}: código de distrito inválido.`);
  const d = limpiarTexto(c.descripcion);
  if (d.length < 1 || d.length > 30) err(`${campo}: la descripción del distrito debe tener 1 a 30 caracteres.`);
  return { codigo: c.codigo, descripcion: d };
}

const RE_EMAIL = /^[0-9a-zA-Z]([0-9a-zA-Z.\-_])*@([0-9a-zA-Z][0-9a-zA-Z\-_]*\.)+[a-zA-Z]{2,9}$/; // XSD tEmail

function textoLargo(valor: unknown, min: number, max: number, campo: string): string {
  const v = limpiarTexto(valor);
  if (v.length < min || v.length > max) err(`${campo}: debe tener entre ${min} y ${max} caracteres (tiene ${v.length}).`);
  return v;
}

// ───────────────────────────── validaciones ─────────────────────────────

function validarEmisor(e: DatosEmisor): void {
  if (!e) err("Faltan los datos del emisor.");
  const ruc = String(e.ruc ?? "").trim().toUpperCase();
  if (!rucConFormatoValido(ruc)) err(`RUC del emisor inválido ("${e.ruc}"): 3 a 8 caracteres sin DV.`);
  if (!validarRuc(ruc, e.dv)) err(`El DV del emisor (${e.dv}) no corresponde al RUC ${ruc} según módulo 11 (MT D102).`);
  if (e.tipoContribuyente !== 1 && e.tipoContribuyente !== 2) err("Tipo de contribuyente del emisor inválido (D103: 1 física, 2 jurídica).");
  if (e.tipoRegimen !== undefined && !(Number.isInteger(e.tipoRegimen) && e.tipoRegimen >= 1 && e.tipoRegimen <= 8)) {
    err(`Tipo de régimen del emisor inválido (${e.tipoRegimen}); D104 admite 1 a 8.`);
  }
  textoLargo(e.razonSocial, 4, 255, "Razón social del emisor (D105)");
  textoLargo(e.direccion, 1, 255, "Dirección del emisor (D107)");
  numeroCasa(e.numeroCasa, "Emisor (D108)");
  departamento(e.departamento?.codigo, "Emisor (D111)");
  ciudad(e.ciudad, "Emisor (D115)");
  distritoOpt(e.distrito, "Emisor (D113)");
  const tel = limpiarTexto(e.telefono);
  if (tel.length < 6 || tel.length > 15) err("Teléfono del emisor (D117): 6 a 15 caracteres, con prefijo de ciudad.");
  if (!RE_EMAIL.test(limpiarTexto(e.email))) err(`Email del emisor inválido (D118): "${e.email}".`);
  if (!Array.isArray(e.actividades) || e.actividades.length < 1 || e.actividades.length > 9) {
    err("El emisor debe tener entre 1 y 9 actividades económicas (gActEco D130).");
  }
  for (const a of e.actividades) {
    if (!/^[0-9A-Z]{1,8}$/.test(String(a.codigo ?? ""))) err(`Código de actividad económica inválido (D131): "${a.codigo}".`);
    textoLargo(a.descripcion, 1, 300, "Descripción de actividad económica (D132)");
  }
}

function validarDocumento(doc: DocumentoDE, cred: Pick<CredencialesSifen, "timbrado" | "timbradoInicio">): void {
  if (!doc) err("Falta el documento.");
  if (![1, 4, 5, 6, 7].includes(doc.tipo)) err(`Tipo de documento no soportado (${doc.tipo}). Válidos: 1 FE, 4 AF, 5 NC, 6 ND, 7 NR.`);
  if (doc.moneda !== "PYG") err(`Moneda no soportada (${doc.moneda}). Solo PYG.`);
  if (!/^\d{8}$/.test(String(cred?.timbrado ?? ""))) err(`Timbrado inválido ("${cred?.timbrado}"): deben ser 8 dígitos (C004).`);
  if (!fechaValida(String(cred?.timbradoInicio ?? "")) || cred.timbradoInicio < "2018-05-01") {
    err(`Fecha de inicio del timbrado inválida ("${cred?.timbradoInicio}"): AAAA-MM-DD desde 2018-05-01 (C008).`);
  }
  if (!/^\d{3}$/.test(doc.establecimiento ?? "")) err(`Establecimiento inválido ("${doc.establecimiento}"): 3 dígitos (C005).`);
  if (!/^\d{3}$/.test(doc.punto ?? "")) err(`Punto de expedición inválido ("${doc.punto}"): 3 dígitos (C006).`);
  if (!Number.isInteger(doc.numero) || doc.numero < 1 || doc.numero > 9999999) err(`Número de documento inválido (${doc.numero}): 1 a 9999999 (C007).`);
  if (!fechaHoraValida(doc.fechaEmision)) err(`Fecha de emisión inválida ("${doc.fechaEmision}"): formato AAAA-MM-DDThh:mm:ss (D002).`);
  if (doc.fechaEmision.slice(0, 10) < cred.timbradoInicio) err("La fecha de emisión es anterior al inicio de vigencia del timbrado.");
  // B002: la contingencia (2) está "en definición" en el MT §14 y SIFEN la rechaza (código 1050). Solo 1.
  if (doc.tipoEmision !== 1) err(`Tipo de emisión no permitido (${doc.tipoEmision}): solo 1 "Normal"; la contingencia (2) la rechaza SIFEN (código 1050).`);
  // NT 23 (validación 1331): NC, ND y NR no pueden emitirse a un receptor innominado.
  if ((doc.tipo === 5 || doc.tipo === 6 || doc.tipo === 7) && doc.receptor?.tipo === "innominado") {
    err(`Una ${DESCRIPCION_TIPO_DE[doc.tipo].toLowerCase()} no puede ser innominada (NT 23). Si la factura original fue innominada, primero registrar el evento de nominación (NT 14) o cancelarla dentro de las 48 h.`);
  }
  if (!/^\d{9}$/.test(doc.codigoSeguridad ?? "") || doc.codigoSeguridad === "000000000") {
    err(`Código de seguridad inválido ("${doc.codigoSeguridad}"): 9 dígitos entre 000000001 y 999999999 (B004).`);
  }
  if (doc.codigoSeguridad === String(doc.numero).padStart(9, "0")) err("El código de seguridad no puede ser igual al número del documento (MT 10.3).");

  if (doc.tipo === 5 || doc.tipo === 6) {
    if (!doc.asociado) err("La nota de crédito/débito necesita el documento asociado (grupo H, obligatorio si C002 = 5 o 6).");
    if (!MOTIVOS_NOTA[doc.motivoNota ?? 0]) err(`Motivo de la nota inválido (${doc.motivoNota}). E401 admite 1 a 8.`);
    if (doc.asociado.tipo === 3) err("Una NC/ND no puede asociarse a una constancia electrónica (validación H002a).");
  }
  if (doc.tipo === 1 || doc.tipo === 4) {
    if (!doc.condicion) err("La factura/autofactura necesita la condición de la operación (E600, obligatorio si C002 = 1 o 4).");
    if (doc.tipo === 4 && doc.condicion.tipo !== 1) err("La autofactura debe ser al contado (validación E601).");
  } else if (doc.condicion) {
    err("La condición de la operación solo se informa en factura y autofactura (validación E600a).");
  }
  if (doc.tipo === 4 && !doc.autofactura) err("La autofactura necesita los datos del vendedor (doc.autofactura → gCamAE).");
  if (doc.tipo === 7 && !doc.remision) err("La nota de remisión necesita los datos del traslado (doc.remision → gCamNRE y gTransp).");
  if (doc.asociado) validarAsociado(doc.asociado as AsociadoDE & AsociadoExtra, doc.tipo);
}

function validarAsociado(a: AsociadoDE & AsociadoExtra, tipo: TipoDE): void {
  if (![1, 2, 3].includes(a.tipo)) err(`Tipo de documento asociado inválido (${a.tipo}). H002: 1, 2 o 3.`);
  if (tipo === 4 && a.tipo !== 3) err("En autofactura el documento asociado debe ser constancia electrónica (H002 = 3).");
  if (tipo !== 4 && a.tipo === 3) err("Solo la autofactura se asocia a una constancia electrónica (validación H002a).");
  if (a.tipo === 1) {
    if (!a.cdc || !validarCdc(a.cdc)) err(`CDC del documento asociado inválido ("${a.cdc ?? ""}") (H004).`);
    if ((tipo === 5 || tipo === 6) && !a.cdc.startsWith("01")) err("Una NC/ND solo puede asociarse a una factura electrónica (validación H001a).");
  }
  if (a.tipo === 2) {
    if (!/^\d{8}$/.test(a.timbrado ?? "")) err("Documento asociado impreso: falta timbrado de 8 dígitos (H005).");
    if (!/^\d{3}$/.test(a.establecimiento ?? "") || !/^\d{3}$/.test(a.punto ?? "")) err("Documento asociado impreso: establecimiento y punto de 3 dígitos (H006/H007).");
    if (!Number.isInteger(a.numero) || (a.numero ?? 0) < 1) err("Documento asociado impreso: número inválido (H008).");
    if (!TIPO_DOC_IMPRESO[a.tipoDocumentoImpreso ?? 0]) err("Documento asociado impreso: tipo de documento impreso inválido (H009).");
    if (!fechaValida(a.fecha ?? "")) err("Documento asociado impreso: fecha AAAA-MM-DD inválida (H011).");
  }
}

// ───────────────────────────── bloques XML ─────────────────────────────

function xmlEmisor(e: DatosEmisor): string {
  const dist = distritoOpt(e.distrito, "Emisor (D113)");
  const ciu = ciudad(e.ciudad, "Emisor (D115)");
  return g(
    "gEmis", // D100
    t("dRucEm", String(e.ruc).trim().toUpperCase()), // D101
    t("dDVEmi", String(e.dv)), // D102
    t("iTipCont", String(e.tipoContribuyente)), // D103
    e.tipoRegimen !== undefined ? t("cTipReg", String(e.tipoRegimen)) : "", // D104
    t("dNomEmi", textoLargo(e.razonSocial, 4, 255, "D105")), // D105
    e.nombreFantasia && limpiarTexto(e.nombreFantasia).length >= 4 ? t("dNomFanEmi", e.nombreFantasia) : "", // D106
    t("dDirEmi", e.direccion), // D107
    t("dNumCas", numeroCasa(e.numeroCasa, "Emisor (D108)")), // D108
    t("cDepEmi", String(e.departamento.codigo)), // D111
    t("dDesDepEmi", departamento(e.departamento.codigo, "D112")), // D112 (texto del XSD)
    dist ? t("cDisEmi", String(dist.codigo)) + t("dDesDisEmi", dist.descripcion) : "", // D113/D114
    t("cCiuEmi", String(ciu.codigo)), // D115
    t("dDesCiuEmi", ciu.descripcion), // D116
    t("dTelEmi", e.telefono), // D117
    t("dEmailE", e.email), // D118
    ...e.actividades.map((a) => g("gActEco", t("cActEco", a.codigo), t("dDesActEco", a.descripcion))), // D130–D132
  );
}

function tipoContribuyenteReceptor(r: ReceptorDE & ReceptorExtra): 1 | 2 {
  if (r.tipoContribuyente === 1 || r.tipoContribuyente === 2) return r.tipoContribuyente;
  // [VERIFICAR] heurística: los RUC de personas jurídicas en Paraguay empiezan con 80 (8 dígitos).
  return /^80\d{6}$/.test(String(r.ruc)) ? 2 : 1;
}

function xmlReceptor(rIn: ReceptorDE, doc: DocumentoDE, emisor: DatosEmisor, totalGeneral: number): string {
  // Autofactura: el receptor es el propio emisor (validaciones D201 y D206e).
  const r: ReceptorDE & ReceptorExtra = doc.tipo === 4
    ? {
      tipo: "ruc",
      ruc: String(emisor.ruc).trim().toUpperCase(),
      dv: emisor.dv,
      razonSocial: emisor.razonSocial,
      tipoContribuyente: emisor.tipoContribuyente,
    }
    : { ...(rIn as ReceptorDE & ReceptorExtra) };
  if (!r || !["ruc", "innominado", "documento"].includes(r.tipo)) err(`Tipo de receptor inválido ("${r?.tipo}").`);
  if (r.pais && r.pais !== "PRY") err("Solo se soportan receptores de Paraguay (D203 = PRY; B2F no soportado).");

  const partes: string[] = [];
  if (r.tipo === "ruc") {
    const ruc = String(r.ruc ?? "").trim().toUpperCase();
    if (!rucConFormatoValido(ruc)) err(`RUC del receptor inválido ("${r.ruc}"): 3 a 8 caracteres sin DV (D206).`);
    if (!validarRuc(ruc, r.dv ?? "")) err(`El DV del receptor (${r.dv}) no corresponde al RUC ${ruc} según módulo 11 (D207).`);
    const nombre = textoLargo(r.razonSocial ?? r.nombre, 4, 255, "Razón social del receptor (D211)");
    partes.push(
      t("iNatRec", "1"), // D201 contribuyente
      t("iTiOpe", doc.tipo === 4 ? "2" : "1"), // D202: B2B; autofactura exige B2C (validación D202a)
      t("cPaisRec", "PRY"), // D203
      t("dDesPaisRe", PAISES.PRY), // D204
      t("iTiContRec", String(tipoContribuyenteReceptor(r))), // D205
      t("dRucRec", ruc), // D206
      t("dDVRec", String(r.dv)), // D207
      t("dNomRec", nombre), // D211
    );
  } else if (r.tipo === "documento") {
    const tipoDoc = r.documentoTipo ?? 1;
    if (![1, 2, 3, 4, 6, 9].includes(tipoDoc)) err(`Tipo de documento del receptor inválido (${tipoDoc}). D208: 1, 2, 3, 4, 6 o 9.`);
    const desc = tipoDoc === 9 ? textoLargo(r.documentoDescripcion ?? "Otro", 4, 41, "D209") : TIPOS_DOC_RECEPTOR[tipoDoc];
    const num = limpiarTexto(r.documentoNumero);
    if (!/^[0-9A-Za-z-]{1,20}$/.test(num)) err(`Número de documento del receptor inválido ("${r.documentoNumero}"): 1 a 20 letras/números/guion (D210).`);
    const nombre = textoLargo(r.nombre ?? r.razonSocial, 4, 255, "Nombre del receptor (D211)");
    partes.push(
      t("iNatRec", "2"), // D201 no contribuyente
      t("iTiOpe", "2"), // D202 B2C (validación D202: no contribuyente ⇒ B2C)
      t("cPaisRec", "PRY"), // D203
      t("dDesPaisRe", PAISES.PRY), // D204
      t("iTipIDRec", String(tipoDoc)), // D208
      t("dDTipIDRec", desc), // D209
      t("dNumIDRec", num), // D210
      t("dNomRec", nombre), // D211
    );
  } else {
    // innominado (D208 = 5): solo B2C y total < ₲ 7.000.000 (validaciones D208b y D208c, NT 24)
    if (totalGeneral >= TOPE_INNOMINADO_PYG) {
      err(`No se puede facturar como innominado un total de ₲ ${totalGeneral}: desde ₲ ${TOPE_INNOMINADO_PYG} hay que identificar al cliente (NT 24, D208c).`);
    }
    partes.push(
      t("iNatRec", "2"), // D201
      t("iTiOpe", "2"), // D202 B2C
      t("cPaisRec", "PRY"), // D203
      t("dDesPaisRe", PAISES.PRY), // D204
      t("iTipIDRec", "5"), // D208 Innominado
      t("dDTipIDRec", TIPOS_DOC_RECEPTOR[5]), // D209 "Innominado"
      t("dNumIDRec", "0"), // D210: "En caso de DE innominado, completar con 0"
      t("dNomRec", "Sin Nombre"), // D211: "En caso de DE innominado, completar con Sin Nombre"
    );
  }

  // Dirección (D213, D218–D224): D218/D219/D223 son obligatorios si se informa D213. Obligatoria en NR.
  const dir = limpiarTexto(r.direccion);
  const tieneUbicacion = !!(r.departamento && r.ciudad);
  if (doc.tipo === 7 && (!dir || !tieneUbicacion)) {
    err("En la nota de remisión la dirección del receptor es obligatoria (D213) con departamento y ciudad (D219/D223).");
  }
  if (dir && tieneUbicacion) {
    const dist = distritoOpt(r.distrito, "Receptor (D221)");
    const ciu = ciudad(r.ciudad, "Receptor (D223)");
    partes.push(
      t("dDirRec", textoLargo(dir, 1, 255, "D213")), // D213
      t("dNumCasRec", numeroCasa(r.numeroCasa, "Receptor (D218)")), // D218
      t("cDepRec", String(r.departamento)), // D219
      t("dDesDepRec", departamento(r.departamento!, "D220")), // D220
      dist ? t("cDisRec", String(dist.codigo)) + t("dDesDisRec", dist.descripcion) : "", // D221/D222
      t("cCiuRec", String(ciu.codigo)), // D223
      t("dDesCiuRec", ciu.descripcion), // D224
    );
  }
  // Contacto opcional: si el dato no cumple el formato del XSD se omite (no bloquea la factura).
  const contacto = contactoReceptorDE(r);
  if (contacto.telefono) partes.push(t("dTelRec", contacto.telefono)); // D214
  if (contacto.celular) partes.push(t("dCelRec", contacto.celular)); // D215
  if (contacto.email) partes.push(t("dEmailRec", contacto.email)); // D216
  const cod = limpiarTexto(r.codigoCliente);
  if (cod.length >= 3 && cod.length <= 15) partes.push(t("dCodCliente", cod)); // D217
  return g("gDatRec", ...partes); // D200
}

function xmlOpeCom(doc: DocumentoDE, op: OpcionesXml): string {
  if (doc.tipo === 7) return ""; // D010: no informar si C002 = 7
  let tipTra = "";
  if (doc.tipo === 1 || doc.tipo === 4) {
    // D011/D012 obligatorios si C002 = 1 o 4
    const af = doc.autofactura as unknown as DatosAutofactura | undefined;
    const cod = doc.tipo === 4 ? (af?.tipoTransaccion ?? 10) : (op.tipoTransaccion ?? 1);
    if (!TIPOS_TRANSACCION[cod]) err(`Tipo de transacción inválido (${cod}). D011 admite 1 a 13.`);
    tipTra = t("iTipTra", String(cod)) + t("dDesTipTra", TIPOS_TRANSACCION[cod]);
  }
  return g(
    "gOpeCom", // D010
    tipTra, // D011/D012
    t("iTImp", "1"), // D013: 1 = IVA
    t("dDesTImp", "IVA"), // D014
    t("cMoneOpe", doc.moneda), // D015
    t("dDesMoneOpe", MONEDAS[doc.moneda]), // D016
  );
}

function xmlCamAE(af: DatosAutofactura): string {
  if (!NATURALEZA_VENDEDOR[af.naturalezaVendedor]) err("Autofactura: naturaleza del vendedor inválida (E301: 1 o 2).");
  if (!TIPOS_DOC_PERSONA[af.documentoTipo]) err("Autofactura: tipo de documento del vendedor inválido (E304: 1 a 4).");
  const num = limpiarTexto(af.documentoNumero);
  if (!/^[0-9A-Za-z-]{1,20}$/.test(num)) err("Autofactura: número de documento del vendedor inválido (E306).");
  const ciu = ciudad(af.ciudad, "Autofactura (E314)");
  const dist = distritoOpt(af.distrito, "Autofactura (E312)");
  const l = af.lugar;
  if (!l) err("Autofactura: falta el lugar de la transacción (E316–E322).");
  const lCiu = ciudad(l.ciudad, "Autofactura (E321)");
  const lDist = distritoOpt(l.distrito, "Autofactura (E319)");
  return g(
    "gCamAE", // E300
    t("iNatVen", String(af.naturalezaVendedor)), // E301
    t("dDesNatVen", NATURALEZA_VENDEDOR[af.naturalezaVendedor]), // E302
    t("iTipIDVen", String(af.documentoTipo)), // E304
    t("dDTipIDVen", TIPOS_DOC_PERSONA[af.documentoTipo]), // E305
    t("dNumIDVen", num), // E306
    t("dNomVen", textoLargo(af.nombre, 4, 60, "Nombre del vendedor (E307)")), // E307
    t("dDirVen", textoLargo(af.direccion, 1, 255, "E308")), // E308
    t("dNumCasVen", numeroCasa(af.numeroCasa, "Autofactura (E309)")), // E309
    t("cDepVen", String(af.departamento)), // E310
    t("dDesDepVen", departamento(af.departamento, "E311")), // E311
    dist ? t("cDisVen", String(dist.codigo)) + t("dDesDisVen", dist.descripcion) : "", // E312/E313
    t("cCiuVen", String(ciu.codigo)), // E314
    t("dDesCiuVen", ciu.descripcion), // E315
    t("dDirProv", textoLargo(l.direccion, 1, 255, "E316")), // E316
    t("cDepProv", String(l.departamento)), // E317
    t("dDesDepProv", departamento(l.departamento, "E318")), // E318
    lDist ? t("cDisProv", String(lDist.codigo)) + t("dDesDisProv", lDist.descripcion) : "", // E319/E320
    t("cCiuProv", String(lCiu.codigo)), // E321
    t("dDesCiuProv", lCiu.descripcion), // E322
  );
}

function xmlCamNRE(r: DatosRemision): string {
  const desc = r.motivo === 99 ? textoLargo(r.motivoDescripcion, 5, 60, "Motivo de remisión (E502)") : MOTIVOS_REMISION[r.motivo];
  if (!desc) err(`Motivo de remisión inválido (${r.motivo}). E501: 1 a 14 o 99.`);
  if (!RESPONSABLE_REMISION[r.responsable]) err(`Responsable de la remisión inválido (${r.responsable}). E503: 1 a 5.`);
  if (!Number.isInteger(r.km) || r.km < 1 || r.km > 99999) err("Kilómetros estimados inválidos (E505: 1 a 99999).");
  if (r.fechaFuturaFactura !== undefined && !fechaValida(r.fechaFuturaFactura)) err("Fecha futura de la factura inválida (E506: AAAA-MM-DD).");
  return g(
    "gCamNRE", // E500
    t("iMotEmiNR", String(r.motivo)), // E501
    t("dDesMotEmiNR", desc), // E502
    t("iRespEmiNR", String(r.responsable)), // E503
    t("dDesRespEmiNR", RESPONSABLE_REMISION[r.responsable]), // E504
    t("dKmR", String(r.km)), // E505
    r.fechaFuturaFactura ? t("dFecEm", r.fechaFuturaFactura) : "", // E506
  );
}

function xmlLocal(prefijo: "Sal" | "Ent", l: DireccionLocal, campo: string): string {
  if (!l) err(`${campo}: faltan los datos del local.`);
  const ciu = ciudad(l.ciudad, campo);
  const dist = distritoOpt(l.distrito, campo);
  const tel = limpiarTexto(l.telefono);
  const P = prefijo;
  return g(
    `gCam${P}`, // E920 / E940
    t(`dDirLoc${P}`, textoLargo(l.direccion, 1, 255, campo)), // E921 / E941
    t(`dNumCas${P}`, numeroCasa(l.numeroCasa, campo)), // E922 / E942
    t(`cDep${P}`, String(l.departamento)), // E925 / E945
    t(`dDesDep${P}`, departamento(l.departamento, campo)), // E926 / E946
    dist ? t(`cDis${P}`, String(dist.codigo)) + t(`dDesDis${P}`, dist.descripcion) : "", // E927-E928 / E947-E948
    t(`cCiu${P}`, String(ciu.codigo)), // E929 / E949
    t(`dDesCiu${P}`, ciu.descripcion), // E930 / E950
    tel.length >= 6 && tel.length <= 15 ? t(`dTel${P}`, tel) : "", // E931 / E951
  );
}

function xmlTransp(r: DatosRemision): string {
  const tr = r.transporte;
  if (!tr) err("Nota de remisión: faltan los datos del transporte (gTransp E900).");
  const tipo = tr.tipo ?? 1;
  if (!TIPO_TRANSPORTE[tipo]) err("Tipo de transporte inválido (E901: 1 propio, 2 tercero).");
  if (!MODALIDAD_TRANSPORTE[tr.modalidad]) err("Modalidad de transporte inválida (E903: 1 a 4).");
  if (![1, 2, 3, 4, 5].includes(tr.responsableFlete)) err("Responsable del flete inválido (E905: 1 a 5).");
  if (!fechaValida(tr.inicio) || !fechaValida(tr.fin)) err("Fechas de traslado inválidas (E909/E910: AAAA-MM-DD).");
  if (tr.fin < tr.inicio) err("La fecha de fin del traslado es anterior a la de inicio (E910).");
  if (!Array.isArray(tr.entregas) || tr.entregas.length < 1 || tr.entregas.length > 99) err("Debe haber de 1 a 99 locales de entrega (gCamEnt E940).");
  if (!Array.isArray(tr.vehiculos) || tr.vehiculos.length < 1 || tr.vehiculos.length > 4) err("Debe haber de 1 a 4 vehículos (gVehTras E960).");
  const vehiculos = tr.vehiculos.map((v, i) => {
    const c = `Vehículo ${i + 1}`;
    if (v.tipoIdentificacion === 1 && !limpiarTexto(v.numeroId)) err(`${c}: falta el número de identificación (E963, obligatorio si E967 = 1).`);
    if (v.tipoIdentificacion === 2 && limpiarTexto(v.matricula).length !== 6) err(`${c}: la matrícula debe tener 6 caracteres (E965).`);
    if (v.tipoIdentificacion !== 1 && v.tipoIdentificacion !== 2) err(`${c}: tipo de identificación inválido (E967: 1 o 2).`);
    return g(
      "gVehTras", // E960
      t("dTiVehTras", textoLargo(v.tipo, 4, 10, `${c} (E961)`)), // E961
      t("dMarVeh", textoLargo(v.marca, 1, 10, `${c} (E962)`)), // E962
      t("dTipIdenVeh", String(v.tipoIdentificacion)), // E967
      v.tipoIdentificacion === 1 ? t("dNroIDVeh", textoLargo(v.numeroId, 1, 20, `${c} (E963)`)) : "", // E963
      v.tipoIdentificacion === 2 ? t("dNroMatVeh", v.matricula) : "", // E965
    );
  });
  let trans = "";
  if (tr.transportista) {
    const x = tr.transportista;
    if (x.naturaleza !== 1 && x.naturaleza !== 2) err("Naturaleza del transportista inválida (E981: 1 o 2).");
    let id = "";
    if (x.naturaleza === 1) {
      const ruc = String(x.ruc ?? "").trim().toUpperCase();
      if (!validarRuc(ruc, x.dv ?? "")) err("RUC/DV del transportista inválido (E983/E984, módulo 11).");
      id = t("dRucTrans", ruc) + t("dDVTrans", String(x.dv)); // E983/E984
    } else {
      if (!TIPOS_DOC_PERSONA[x.documentoTipo ?? 0]) err("Tipo de documento del transportista inválido (E985: 1 a 4).");
      id = t("iTipIDTrans", String(x.documentoTipo)) + t("dDTipIDTrans", TIPOS_DOC_PERSONA[x.documentoTipo!]) + // E985/E986
        t("dNumIDTrans", x.documentoNumero); // E987
    }
    trans = g(
      "gCamTrans", // E980
      t("iNatTrans", String(x.naturaleza)), // E981
      t("dNomTrans", textoLargo(x.nombre, 4, 60, "Transportista (E982)")), // E982
      id,
      t("dNumIDChof", limpiarTexto(x.choferDocumento)), // E990
      t("dNomChof", textoLargo(x.choferNombre, 4, 60, "Chofer (E991)")), // E991
      t("dDomFisc", textoLargo(x.domicilioFiscal, 1, 150, "Domicilio fiscal del transportista (E992)")), // E992
      t("dDirChof", textoLargo(x.direccionChofer, 1, 255, "Dirección del chofer (E993)")), // E993
    );
  } else if (!(tr.modalidad === 1 && tr.vehiculos.every((v) => v.tipoIdentificacion === 1))) {
    // E980: obligatorio si C002 = 7; opcional solo cuando E903 = 1 y E967 = 1
    err("Nota de remisión: faltan los datos del transportista (gCamTrans E980).");
  }
  return g(
    "gTransp", // E900
    t("iTipTrans", String(tipo)), // E901
    t("dDesTipTrans", TIPO_TRANSPORTE[tipo]), // E902
    t("iModTrans", String(tr.modalidad)), // E903
    t("dDesModTrans", MODALIDAD_TRANSPORTE[tr.modalidad]), // E904
    t("iRespFlete", String(tr.responsableFlete)), // E905
    t("dIniTras", tr.inicio), // E909
    t("dFinTras", tr.fin), // E910
    xmlLocal("Sal", tr.salida, "Local de salida (E920)"),
    ...tr.entregas.map((l, i) => xmlLocal("Ent", l, `Local de entrega ${i + 1} (E940)`)),
    ...vehiculos,
    trans,
  );
}

function xmlCamCond(doc: DocumentoDE, total: number, op: OpcionesXml): string {
  const c = doc.condicion!;
  if (c.tipo !== 1 && c.tipo !== 2) err("Condición de la operación inválida (E601: 1 contado, 2 crédito).");
  const pagos = c.pagos ?? [];
  if (c.tipo === 1 && pagos.length === 0) err("Operación al contado sin formas de pago (gPaConEIni E605, obligatorio si E601 = 1).");
  if (pagos.length > 999) err("Máximo 999 formas de pago (E605).");
  const xmlPagos = pagos.map((p, i) => {
    const desc = TIPOS_PAGO[p.tipo];
    if (!desc) err(`Pago ${i + 1}: tipo de pago inválido (${p.tipo}). E606 admite 1 a 21.`);
    if (p.tipo === 2) err(`Pago ${i + 1}: cheque no soportado (requiere número y banco, gPagCheq E630).`);
    if (!(Number.isFinite(p.monto) && p.monto > 0)) err(`Pago ${i + 1}: el monto debe ser mayor a 0 (E608).`);
    // E620 gPagTarCD "se activa si E606 = 3 o 4". [VERIFICAR] denominación 99/forma 9 cuando no se conoce la tarjeta.
    const tarjeta = p.tipo === 3 || p.tipo === 4
      ? g("gPagTarCD", t("iDenTarj", "99"), t("dDesDenTarj", "Tarjeta"), t("iForProPa", "9")) // E621/E622/E626
      : "";
    return g(
      "gPaConEIni", // E605
      t("iTiPago", String(p.tipo)), // E606
      t("dDesTiPag", desc), // E607
      t("dMonTiPag", p.monto), // E608
      t("cMoneTiPag", doc.moneda), // E609
      t("dDMoneTiPag", MONEDAS[doc.moneda]), // E610
      tarjeta,
    );
  });
  if (c.tipo === 1) {
    const suma = pagos.reduce((a, p) => a + p.monto, 0);
    if (Math.abs(suma - total) > 0.5) err(`La suma de los pagos (₲ ${suma}) no coincide con el total del documento (₲ ${total}).`);
  }
  const cred = c.tipo === 2
    ? g(
      "gPagCred", // E640
      t("iCondCred", "1"), // E641: 1 = Plazo
      t("dDCondCred", "Plazo"), // E642
      t("dPlazoCre", textoLargo(op.plazoCredito ?? "30 días", 2, 15, "Plazo del crédito (E643)")), // E643
      pagos.length ? t("dMonEnt", pagos.reduce((a, p) => a + p.monto, 0)) : "", // E645 (entrega inicial)
    )
    : "";
  return g(
    "gCamCond", // E600
    t("iCondOpe", String(c.tipo)), // E601
    t("dDCondOpe", c.tipo === 1 ? "Contado" : "Crédito"), // E602
    ...xmlPagos,
    cred,
  );
}

function xmlItem(c: ItemCalculado, tipo: TipoDE, i: number): string {
  const it: ItemDE = c.item;
  const n = `Ítem ${i + 1}`;
  const codigo = textoLargo(it.codigo, 1, 50, `${n}: código interno (E701)`);
  const desc = textoLargo(it.descripcion, 1, 2000, `${n}: descripción (E708)`);
  const uni = UNIDADES_MEDIDA[it.unidadMedida];
  if (!uni) err(`${n}: unidad de medida inexistente (${it.unidadMedida}). Ver Unidades_Medida_v141.xsd (77 = UNI).`);
  const valor = tipo === 7 ? "" : g(
    "gValorItem", // E720 (no informar si C002 = 7)
    t("dPUniProSer", c.precioUnitario), // E721
    t("dTotBruOpeItem", c.totalBruto), // E727 = E721 * E711
    g(
      "gValorRestaItem", // EA001
      t("dDescItem", c.descuentoUnitario), // EA002 (0 si no hay)
      c.descuentoUnitario > 0 ? t("dPorcDesIt", c.porcentajeDescuento) : "", // EA003 = EA002*100/E721
      t("dDescGloItem", 0), // EA004
      t("dAntPreUniIt", 0), // EA006
      t("dAntGloPreUniIt", 0), // EA007
      t("dTotOpeItem", c.totalOperacion), // EA008
    ),
  );
  const iva = tipo === 4 || tipo === 7 ? "" : g(
    "gCamIVA", // E730 (no se informa en AF ni NR)
    t("iAfecIVA", String(c.afectacion)), // E731
    t("dDesAfecIVA", DESCRIPCION_AFECTACION_IVA[c.afectacion]), // E732
    t("dPropIVA", c.proporcionIva), // E733
    t("dTasaIVA", String(c.tasaIva)), // E734
    t("dBasGravIVA", c.baseGravada), // E735
    t("dLiqIVAItem", c.liquidacionIva), // E736
    t("dBasExe", c.baseExenta), // E737 (NT 13)
  );
  return g(
    "gCamItem", // E700
    t("dCodInt", codigo), // E701
    t("dDesProSer", desc), // E708
    t("cUniMed", String(it.unidadMedida)), // E709
    t("dDesUniMed", uni), // E710
    t("dCantProSer", c.cantidad), // E711
    valor,
    iva,
  );
}

function xmlTotSub(tipo: TipoDE, f: ReturnType<typeof calcularTotales>["campos"]): string {
  if (tipo === 7) return ""; // F001: no informar si C002 = 7
  const af = tipo === 4; // C002 = 4: no informar F002-F005, F015-F020, F023, F025, F026
  return g(
    "gTotSub", // F001
    af ? "" : t("dSubExe", f.dSubExe), // F002
    af ? "" : t("dSubExo", f.dSubExo), // F003
    af ? "" : t("dSub5", f.dSub5), // F004
    af ? "" : t("dSub10", f.dSub10), // F005
    t("dTotOpe", f.dTotOpe), // F008
    t("dTotDesc", f.dTotDesc), // F009
    t("dTotDescGlotem", f.dTotDescGlotem), // F033
    t("dTotAntItem", f.dTotAntItem), // F034
    t("dTotAnt", f.dTotAnt), // F035
    t("dPorcDescTotal", f.dPorcDescTotal), // F010
    t("dDescTotal", f.dDescTotal), // F011
    t("dAnticipo", f.dAnticipo), // F012
    t("dRedon", f.dRedon), // F013
    t("dTotGralOpe", f.dTotGralOpe), // F014
    af ? "" : t("dIVA5", f.dIVA5), // F015
    af ? "" : t("dIVA10", f.dIVA10), // F016
    af ? "" : t("dLiqTotIVA5", f.dLiqTotIVA5), // F036
    af ? "" : t("dLiqTotIVA10", f.dLiqTotIVA10), // F037
    af ? "" : t("dTotIVA", f.dTotIVA), // F017
    af ? "" : t("dBaseGrav5", f.dBaseGrav5), // F018
    af ? "" : t("dBaseGrav10", f.dBaseGrav10), // F019
    af ? "" : t("dTBasGraIVA", f.dTBasGraIVA), // F020
  );
}

function xmlAsociado(doc: DocumentoDE): string {
  const a = doc.asociado as (AsociadoDE & AsociadoExtra) | undefined;
  if (!a) {
    if (doc.tipo === 4) {
      // H001 obligatorio en AF; H002 = 3 constancia electrónica
      const af = doc.autofactura as unknown as DatosAutofactura | undefined;
      return xmlAsociadoConstancia(af?.constancia ?? { tipo: 1 });
    }
    return "";
  }
  if (a.tipo === 3) {
    const af = doc.autofactura as unknown as DatosAutofactura | undefined;
    return xmlAsociadoConstancia(af?.constancia ?? { tipo: 1 });
  }
  if (a.tipo === 1) {
    return g(
      "gCamDEAsoc", // H001
      t("iTipDocAso", "1"), // H002
      t("dDesTipDocAso", TIPO_DOC_ASOCIADO[1]), // H003
      t("dCdCDERef", a.cdc), // H004
    );
  }
  return g(
    "gCamDEAsoc", // H001
    t("iTipDocAso", "2"), // H002
    t("dDesTipDocAso", TIPO_DOC_ASOCIADO[2]), // H003
    t("dNTimDI", a.timbrado), // H005
    t("dEstDocAso", a.establecimiento), // H006
    t("dPExpDocAso", a.punto), // H007
    t("dNumDocAso", String(a.numero).padStart(7, "0")), // H008
    t("iTipoDocAso", String(a.tipoDocumentoImpreso)), // H009
    t("dDTipoDocAso", TIPO_DOC_IMPRESO[a.tipoDocumentoImpreso!]), // H010
    t("dFecEmiDI", a.fecha), // H011
  );
}

function xmlAsociadoConstancia(c: { tipo: 1 | 2; numero?: string; control?: string }): string {
  if (!TIPO_CONSTANCIA[c.tipo]) err("Tipo de constancia inválido (H014: 1 o 2).");
  if (c.tipo === 2) {
    if (!/^\d{11}$/.test(c.numero ?? "")) err("Constancia de microproductor: número de 11 dígitos obligatorio (H016).");
    if (limpiarTexto(c.control).length !== 8) err("Constancia de microproductor: número de control de 8 caracteres obligatorio (H017).");
  }
  return g(
    "gCamDEAsoc", // H001
    t("iTipDocAso", "3"), // H002 constancia electrónica (validación H002 para AF)
    t("dDesTipDocAso", TIPO_DOC_ASOCIADO[3]), // H003
    t("iTipCons", String(c.tipo)), // H014
    t("dDesTipCons", TIPO_CONSTANCIA[c.tipo]), // H015
    c.tipo === 2 ? t("dNumCons", c.numero) + t("dNumControl", c.control) : "", // H016/H017
  );
}

// ───────────────────────────── función principal ─────────────────────────────

/** Igual que armarXmlDE pero con opciones extra (fecha de firma fija, indicador de presencia, etc.). */
export function armarXmlDEConOpciones(
  doc: DocumentoDE,
  emisor: DatosEmisor,
  cred: Pick<CredencialesSifen, "timbrado" | "timbradoInicio">,
  op: OpcionesXml = {},
): { xml: string; cdc: string; totales: TotalesDE } {
  validarEmisor(emisor);
  validarDocumento(doc, cred);
  const fechaFirma = op.fechaFirma ?? ahoraAsuncion();
  if (!fechaHoraValida(fechaFirma)) err(`Fecha de firma inválida ("${fechaFirma}"): AAAA-MM-DDThh:mm:ss (A004).`);

  const calc = calcularTotales(doc.items, doc.tipo, doc.moneda);
  const totales = calc.totales;

  const cdc = armarCdc({
    tipo: doc.tipo,
    ruc: emisor.ruc,
    dv: emisor.dv,
    establecimiento: doc.establecimiento,
    punto: doc.punto,
    numero: doc.numero,
    tipoContribuyente: emisor.tipoContribuyente,
    fechaEmision: doc.fechaEmision,
    tipoEmision: doc.tipoEmision,
    codigoSeguridad: doc.codigoSeguridad,
  });

  // B006 dInfoFisc: obligatorio en NR (NT 7, RG 41/2014 Art. 3 Inc. 7)
  const remision = doc.remision as unknown as DatosRemision | undefined;
  const infoFisc = doc.tipo === 7 ? (remision?.infoFisco ?? LEYENDA_REMISION_POR_DEFECTO) : undefined;
  const infoEmi = doc.observacion ? textoLargo(doc.observacion, 1, 3000, "Observación (B005)") : undefined;

  let indPres = "";
  if (doc.tipo === 1) {
    const ip = op.indicadorPresencia ?? 2;
    if (!INDICADOR_PRESENCIA[ip]) err(`Indicador de presencia inválido (${ip}). E011: 1 a 6.`);
    indPres = g("gCamFE", t("iIndPres", String(ip)), t("dDesIndPres", INDICADOR_PRESENCIA[ip])); // E010/E011/E012
  }

  const de = [
    t("dDVId", cdc[43]), // A003
    t("dFecFirma", fechaFirma), // A004
    t("dSisFact", "1"), // A005: 1 = sistema de facturación del contribuyente (XSD: máximo 1). [VERIFICAR] NT 10 lo lista como eliminado, pero el XSD v150 vigente lo exige.
    g(
      "gOpeDE", // B001
      t("iTipEmi", String(doc.tipoEmision)), // B002
      t("dDesTipEmi", DESCRIPCION_TIPO_EMISION[doc.tipoEmision]), // B003
      t("dCodSeg", doc.codigoSeguridad), // B004
      t("dInfoEmi", infoEmi), // B005
      t("dInfoFisc", infoFisc), // B006
    ),
    g(
      "gTimb", // C001
      t("iTiDE", String(doc.tipo)), // C002
      t("dDesTiDE", DESCRIPCION_TIPO_DE[doc.tipo]), // C003
      t("dNumTim", cred.timbrado), // C004
      t("dEst", doc.establecimiento), // C005
      t("dPunExp", doc.punto), // C006
      t("dNumDoc", String(doc.numero).padStart(7, "0")), // C007
      t("dFeIniT", cred.timbradoInicio), // C008
    ),
    g(
      "gDatGralOpe", // D001
      t("dFeEmiDE", doc.fechaEmision), // D002
      xmlOpeCom(doc, op), // D010
      xmlEmisor(emisor), // D100
      xmlReceptor(doc.receptor, doc, emisor, totales.total), // D200
    ),
    g(
      "gDtipDE", // E001
      indPres, // E010 gCamFE (C002 = 1)
      doc.tipo === 4 ? xmlCamAE(doc.autofactura as unknown as DatosAutofactura) : "", // E300 gCamAE
      doc.tipo === 5 || doc.tipo === 6
        ? g("gCamNCDE", t("iMotEmi", String(doc.motivoNota)), t("dDesMotEmi", MOTIVOS_NOTA[doc.motivoNota!])) // E400/E401/E402
        : "",
      doc.tipo === 7 ? xmlCamNRE(remision!) : "", // E500 gCamNRE
      doc.tipo === 1 || doc.tipo === 4 ? xmlCamCond(doc, totales.total, op) : "", // E600 gCamCond
      ...calc.items.map((c, i) => xmlItem(c, doc.tipo, i)), // E700 gCamItem
      doc.tipo === 7 ? xmlTransp(remision!) : "", // E900 gTransp (obligatorio si C002 = 7)
    ),
    xmlTotSub(doc.tipo, calc.campos), // F001
    xmlAsociado(doc), // H001
  ].join("");

  const xml = `<?xml version="1.0" encoding="UTF-8"?>` +
    `<rDE xmlns="${NAMESPACE_SIFEN}" xmlns:xsi="http://www.w3.org/2001/XMLSchema-instance" xsi:schemaLocation="${NAMESPACE_SIFEN} siRecepDE_v150.xsd">` + // AA001
    t("dVerFor", String(VERSION_FORMATO)) + // AA002
    `<DE Id="${cdc}">${de}</DE>` + // A001 / A002
    `</rDE>`;
  return { xml, cdc, totales };
}

/** Contrato (tipos.ts): arma el rDE sin Signature ni gCamFuFD. dFecFirma = ahora (hora de Asunción). */
export const armarXmlDE: ArmarXmlDE = (doc, emisor, cred) => armarXmlDEConOpciones(doc, emisor, cred);

/**
 * Ambiente de TEST: aplica los literales obligatorios (MT D105 y Guía de Pruebas): razón social del emisor
 * y descripción del primer ítem. Devuelve copias; no modifica los originales. Lo llama el orquestador
 * cuando ambiente = "test".
 */
export function aplicarLeyendasPrueba(doc: DocumentoDE, emisor: DatosEmisor): { doc: DocumentoDE; emisor: DatosEmisor } {
  const items = doc.items.map((it, i) => (i === 0 ? { ...it, descripcion: LEYENDA_ITEM_PRUEBA } : { ...it }));
  return { doc: { ...doc, items }, emisor: { ...emisor, razonSocial: LEYENDA_EMISOR_PRUEBA } };
}
