// Datos de prueba INVENTADOS para los tests de SIFEN (sin tests propios; solo fixtures).
// RUC del emisor y del receptor: los del ejemplo oficial del Manual Técnico v150 (44444401-7 y 88899990-9).
import type { CredencialesSifen, DatosEmisor, DocumentoDE, ItemDE } from "./tipos.ts";
import type { DatosAutofactura, DatosRemision } from "./xml.ts";

export const EMISOR: DatosEmisor = {
  ruc: "44444401",
  dv: "7",
  razonSocial: "Empresa de Prueba S.A.",
  nombreFantasia: "Tienda Prueba",
  tipoContribuyente: 2,
  tipoRegimen: 8,
  direccion: "Calle Inventada",
  numeroCasa: "1167",
  departamento: { codigo: 11, descripcion: "ALTO PARANA" },
  distrito: { codigo: 145, descripcion: "CIUDAD DEL ESTE" },
  ciudad: { codigo: 3428, descripcion: "CIUDAD DEL ESTE" },
  telefono: "061000000",
  email: "prueba@ejemplo.com",
  actividades: [{ codigo: "47919", descripcion: "Venta al por menor por correo y por internet" }],
  establecimiento: "001",
  punto: "001",
};

export const CRED: Pick<CredencialesSifen, "timbrado" | "timbradoInicio"> = {
  timbrado: "12345678",
  timbradoInicio: "2026-01-01",
};

export const FECHA_FIRMA = "2026-10-08T10:00:05";
export const CDC_FE_PRUEBA_DIGEST = "yzGYhUx1/XYYzksWB+fPR3Qc50c="; // DigestValue del ejemplo del MT 13.8.3

export function item(p: Partial<ItemDE> = {}): ItemDE {
  return {
    codigo: "SKU-1",
    descripcion: "Producto de prueba",
    cantidad: 1,
    precioUnitario: 129000,
    ivaTasa: 10,
    ivaAfectacion: 1,
    unidadMedida: 77,
    ...p,
  };
}

export function docFE(p: Partial<DocumentoDE> = {}): DocumentoDE {
  return {
    tipo: 1,
    establecimiento: "001",
    punto: "001",
    numero: 1,
    fechaEmision: "2026-10-08T10:00:00",
    tipoEmision: 1,
    codigoSeguridad: "123456789",
    receptor: { tipo: "innominado" },
    items: [item()],
    moneda: "PYG",
    condicion: { tipo: 1, pagos: [{ tipo: 1, monto: 129000 }] },
    ...p,
  };
}

export const AUTOFACTURA: DatosAutofactura = {
  naturalezaVendedor: 1,
  documentoTipo: 1,
  documentoNumero: "1234567",
  nombre: "Vendedor Inventado",
  direccion: "Ruta Inventada",
  numeroCasa: "",
  departamento: 11,
  ciudad: { codigo: 3428, descripcion: "CIUDAD DEL ESTE" },
  lugar: { direccion: "Mercado Inventado", departamento: 11, ciudad: { codigo: 3428, descripcion: "CIUDAD DEL ESTE" } },
  constancia: { tipo: 1 },
};

export const REMISION: DatosRemision = {
  motivo: 1,
  responsable: 1,
  km: 10,
  transporte: {
    tipo: 1,
    modalidad: 1,
    responsableFlete: 1,
    inicio: "2026-10-08",
    fin: "2026-10-09",
    salida: { direccion: "Depósito Inventado", departamento: 11, ciudad: { codigo: 3428, descripcion: "CIUDAD DEL ESTE" } },
    entregas: [{ direccion: "Casa Inventada", numeroCasa: "12", departamento: 11, ciudad: { codigo: 3428, descripcion: "CIUDAD DEL ESTE" } }],
    vehiculos: [{ tipo: "Moto", marca: "Generica", tipoIdentificacion: 2, matricula: "ABC123" }],
    transportista: {
      naturaleza: 2,
      nombre: "Transportista Inventado",
      documentoTipo: 1,
      documentoNumero: "7654321",
      choferDocumento: "7654321",
      choferNombre: "Chofer Inventado",
      domicilioFiscal: "Calle Ficticia 1",
      direccionChofer: "Calle Ficticia 1",
    },
  },
};

/** Firma ficticia con la estructura de XMLDSig que exige el XSD (NO es una firma válida). */
export function firmaFicticia(cdc: string, digest = CDC_FE_PRUEBA_DIGEST): string {
  return `<Signature xmlns="http://www.w3.org/2000/09/xmldsig#">` +
    `<SignedInfo>` +
    `<CanonicalizationMethod Algorithm="http://www.w3.org/TR/2001/REC-xml-c14n-20010315"/>` +
    `<SignatureMethod Algorithm="http://www.w3.org/2001/04/xmldsig-more#rsa-sha256"/>` +
    `<Reference URI="#${cdc}">` +
    `<Transforms><Transform Algorithm="http://www.w3.org/2000/09/xmldsig#enveloped-signature"/>` +
    `<Transform Algorithm="http://www.w3.org/2001/10/xml-exc-c14n#"/></Transforms>` +
    `<DigestMethod Algorithm="http://www.w3.org/2001/04/xmlenc#sha256"/>` +
    `<DigestValue>${digest}</DigestValue>` +
    `</Reference>` +
    `</SignedInfo>` +
    `<SignatureValue>QUJDREVGR0g=</SignatureValue>` +
    `<KeyInfo><X509Data><X509Certificate>QUJDREVGR0g=</X509Certificate></X509Data></KeyInfo>` +
    `</Signature>`;
}

/** Inserta la firma ficticia después de </DE> (como hará firma.ts). */
export function firmar(xml: string, cdc: string, digest?: string): string {
  return xml.replace("</DE>", "</DE>" + firmaFicticia(cdc, digest));
}

/** Inserta la firma ficticia después de </rEve> (eventos). */
export function firmarEvento(xml: string): string {
  const id = /<rEve Id="(\d+)"/.exec(xml)?.[1] ?? "1";
  return xml.replace("</rEve>", "</rEve>" + firmaFicticia(id));
}
