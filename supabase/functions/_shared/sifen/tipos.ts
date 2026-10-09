// _shared/sifen/tipos.ts · CONTRATO común del sistema propio de facturación electrónica (SIFEN).
// Lo usan: xml.ts/cdc.ts/qr.ts (generación), firma.ts/ws.ts (firma y web services),
// kude.ts (PDF), emisor.ts (orquestación) y el panel de Voltra OS.
// Regla: ningún archivo cambia estas formas sin actualizar docs/sifen-contrato.md.
// Fuente de la estructura: Manual Técnico SIFEN v150 (DNIT) y sus Notas Técnicas vigentes.

/** iTiDE del Manual Técnico: 1 Factura electrónica, 4 Autofactura, 5 Nota de crédito, 6 Nota de débito, 7 Nota de remisión. */
export type TipoDE = 1 | 4 | 5 | 6 | 7;
/** iTipEmi: 1 normal, 2 contingencia. */
export type TipoEmision = 1 | 2;
export type AmbienteSifen = "test" | "prod";

/** Datos fijos del emisor (Voltra). No son secretos: viven en config, no en .env. */
export interface DatosEmisor {
  ruc: string; // sin DV, ej. "80177762"
  dv: string; // "3"
  razonSocial: string;
  nombreFantasia?: string;
  tipoContribuyente: 1 | 2; // 1 persona física, 2 persona jurídica
  tipoRegimen?: number; // iTipReg si corresponde (verificar en el MT)
  direccion: string;
  numeroCasa: string; // "1167"
  departamento: { codigo: number; descripcion: string };
  distrito: { codigo: number; descripcion: string };
  ciudad: { codigo: number; descripcion: string };
  telefono: string;
  email: string;
  actividades: Array<{ codigo: string; descripcion: string }>;
  establecimiento: string; // "001"
  punto: string; // "001"
}

/** Secretos y datos del timbrado: SIEMPRE desde variables de entorno (ver ENV_SIFEN). */
export interface CredencialesSifen {
  ambiente: AmbienteSifen;
  timbrado: string; // 8 dígitos
  timbradoInicio: string; // "AAAA-MM-DD"
  csc: string;
  cscId: string; // "0001"
  certP12: Uint8Array; // .p12 / .pfx
  certClave: string;
  /** true solo si SIFEN_PRODUCCION_AUTORIZADA=si. Sin esto, ws.ts NUNCA llama a producción. */
  produccionAutorizada: boolean;
}

/** Nombres de las variables de entorno / secretos de Supabase. */
export const ENV_SIFEN = {
  ambiente: "SIFEN_AMBIENTE", // "test" | "prod" (por defecto test)
  certP12Base64: "SIFEN_CERT_P12_BASE64",
  certClave: "SIFEN_CERT_CLAVE",
  timbrado: "SIFEN_TIMBRADO",
  timbradoInicio: "SIFEN_TIMBRADO_INICIO",
  csc: "SIFEN_CSC",
  cscId: "SIFEN_CSC_ID",
  produccionAutorizada: "SIFEN_PRODUCCION_AUTORIZADA", // "si" solo cuando Enrique escriba "autorizo producción SIFEN"
  simulado: "MODO_SIMULADO", // "1" = sin red: firma con cert de prueba y SIFEN simulado
} as const;

export type TipoReceptor = "ruc" | "innominado" | "documento";

export interface ReceptorDE {
  tipo: TipoReceptor;
  // "ruc": contribuyente
  ruc?: string; // sin DV
  dv?: string;
  razonSocial?: string;
  // "documento": no contribuyente identificado (cédula, etc.)
  documentoTipo?: number; // iTipIDRec (1 cédula paraguaya, ... verificar en el MT)
  documentoNumero?: string;
  nombre?: string;
  // comunes (opcionales)
  direccion?: string;
  numeroCasa?: string;
  telefono?: string;
  celular?: string;
  email?: string;
  pais?: string; // "PRY"
}

export interface ItemDE {
  codigo: string;
  descripcion: string;
  cantidad: number;
  /** Guaraníes, IVA INCLUIDO, por unidad. */
  precioUnitario: number;
  /** Descuento por unidad en Gs (IVA incluido). */
  descuentoUnitario?: number;
  ivaTasa: 0 | 5 | 10;
  /** iAfecIVA: 1 gravado, 2 exonerado, 3 exento, 4 gravado parcial. */
  ivaAfectacion: 1 | 2 | 3 | 4;
  /** cUniMed: 77 = unidad (verificar tabla del MT). */
  unidadMedida: number;
}

export interface PagoDE {
  /** iTiPago: 1 efectivo, ... (tabla del MT). */
  tipo: number;
  monto: number;
}

/** Documento asociado (NC, ND, NR, autofactura). */
export interface AsociadoDE {
  /** 1 electrónico (por CDC), 2 impreso, 3 constancia electrónica. */
  tipo: 1 | 2 | 3;
  cdc?: string;
}

export interface DocumentoDE {
  tipo: TipoDE;
  establecimiento: string; // "001"
  punto: string; // "001"
  numero: number; // correlativo (7 dígitos en el CDC)
  /** Fecha/hora de emisión en hora de Asunción, "AAAA-MM-DDThh:mm:ss". */
  fechaEmision: string;
  tipoEmision: TipoEmision;
  /** 9 dígitos aleatorios (dCodSeg). */
  codigoSeguridad: string;
  receptor: ReceptorDE;
  items: ItemDE[];
  moneda: "PYG";
  /** Factura/autofactura/ND: condición de la operación. 1 contado. */
  condicion?: { tipo: 1 | 2; pagos: PagoDE[] };
  asociado?: AsociadoDE;
  /** NC/ND: iMotEmi (1 devolución y ajuste de precios, 2 devolución, 3 descuento, ...). */
  motivoNota?: number;
  /** Nota de remisión: motivo y responsable del traslado (campos del MT, grupo gCamNRE). */
  remision?: Record<string, unknown>;
  /** Autofactura: datos del vendedor (grupo gCamAE). */
  autofactura?: Record<string, unknown>;
  /** Referencia interna (no va al XML). */
  shopifyOrderId?: number;
  observacion?: string;
}

export interface TotalesDE {
  total: number; // dTotGralOpe
  totalIva: number; // dTotIVA
  iva10: number;
  iva5: number;
  base10: number; // dBaseGrav10
  base5: number;
  gravado10: number; // dSub10 (IVA incluido)
  gravado5: number;
  exento: number;
  exonerado: number;
  descuentoTotal: number;
}

// ─── Firmas de los módulos (cada agente implementa la suya) ───

/** xml.ts: arma el rDE SIN firma ni QR. Valida reglas propias antes (no contra XSD: eso es validarXsd). */
export type ArmarXmlDE = (doc: DocumentoDE, emisor: DatosEmisor, cred: Pick<CredencialesSifen, "timbrado" | "timbradoInicio">) => {
  xml: string;
  cdc: string;
  totales: TotalesDE;
};

/** firma.ts: firma XMLDSig del nodo DE (Id = CDC). Devuelve el XML firmado y el DigestValue (base64). */
export type FirmarXml = (xml: string, idReferencia: string, certP12: Uint8Array, clave: string) => Promise<{
  xmlFirmado: string;
  digestValue: string;
}>;

/** qr.ts: URL del QR (con cHashQR por CSC) e inserción de gCamFuFD/dCarQR en el XML firmado. */
export type ArmarQr = (args: {
  xmlFirmado: string;
  cdc: string;
  digestValue: string;
  csc: string;
  cscId: string;
  ambiente: AmbienteSifen;
}) => { urlQr: string; xmlConQr: string };

/** Respuesta normalizada de SIFEN (ws.ts). */
export interface RespuestaSifen {
  ok: boolean;
  /** 'aprobado' | 'aprobado_obs' | 'rechazado' | 'en_proceso' | 'error_red' | 'error'. */
  estado: "aprobado" | "aprobado_obs" | "rechazado" | "en_proceso" | "error_red" | "error";
  codigo?: string; // dCodRes
  mensaje?: string; // dMsgRes
  protocolo?: string; // dProtAut / dProtConsLote
  xmlRespuesta?: string;
}

/** kude.ts: PDF del KuDE con la marca Voltra. */
export type GenerarKude = (args: {
  doc: DocumentoDE;
  emisor: DatosEmisor;
  timbrado: string;
  timbradoInicio: string;
  cdc: string;
  totales: TotalesDE;
  urlQr: string;
  ambiente: AmbienteSifen;
  simulado?: boolean; // marca de agua "SIN VALOR FISCAL"
}) => Promise<Uint8Array>;

// ─── Emisor intercambiable (sistema propio o proveedor homologado) ───

export interface ResultadoEmision {
  ok: boolean;
  estado: "aprobada" | "rechazada" | "enviada" | "error";
  cdc?: string;
  numeroCompleto?: string; // "001-001-0000001"
  xmlFirmado?: string;
  kudePdf?: Uint8Array;
  urlQr?: string;
  totales?: TotalesDE;
  codigo?: string;
  mensaje?: string;
  simulado?: boolean;
}

export interface Emisor {
  nombre: "propio" | "facturasend";
  emitir(doc: DocumentoDE): Promise<ResultadoEmision>;
  consultar(cdc: string): Promise<RespuestaSifen>;
  cancelar(cdc: string, motivo: string): Promise<RespuestaSifen>;
  inutilizar(args: { tipo: TipoDE; establecimiento: string; punto: string; desde: number; hasta: number; motivo: string }): Promise<RespuestaSifen>;
  consultarRuc(ruc: string): Promise<{ ok: boolean; existe: boolean; razonSocial?: string; estado?: string; mensaje?: string }>;
}
