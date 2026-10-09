import { assert, assertEquals, assertRejects, assertStringIncludes } from "@std/assert";
import { validar, validarOFallar } from "./validar_xsd.ts";
import { armarXmlDEConOpciones } from "./xml.ts";
import { armarQr, CSC_PRUEBA } from "./qr.ts";
import { xmlEventoCancelacion, xmlEventoInutilizacion } from "./eventos_xml.ts";
import { AUTOFACTURA, CDC_FE_PRUEBA_DIGEST, CRED, docFE, EMISOR, FECHA_FIRMA, firmar, firmarEvento, item, REMISION } from "./xml_fixtures_test.ts";
import type { DocumentoDE } from "./tipos.ts";

const op = { fechaFirma: FECHA_FIRMA };
const RUC = { tipo: "ruc" as const, ruc: "88899990", dv: "9", razonSocial: "Cliente Inventado S.A." };

function completo(doc: DocumentoDE): string {
  const { xml, cdc } = armarXmlDEConOpciones(doc, EMISOR, CRED, op);
  return armarQr({ xmlFirmado: firmar(xml, cdc), cdc, digestValue: CDC_FE_PRUEBA_DIGEST, csc: CSC_PRUEBA["0001"], cscId: "0001", ambiente: "test" }).xmlConQr;
}

function casos(): Array<[string, DocumentoDE]> {
  const fe = armarXmlDEConOpciones(docFE({ receptor: RUC }), EMISOR, CRED, op);
  const nota = { receptor: RUC, condicion: undefined, numero: 3, asociado: { tipo: 1 as const, cdc: fe.cdc } };
  return [
    ["FE innominada", docFE()],
    ["FE RUC mixta con descuento y envío", docFE({
      receptor: { ...RUC, email: "cliente@ejemplo.com", celular: "0981000000" },
      items: [item({ cantidad: 3, descuentoUnitario: 9000 }), item({ codigo: "B", precioUnitario: 105000, ivaTasa: 5 }), item({ codigo: "C", ivaTasa: 0, ivaAfectacion: 3, precioUnitario: 50000 }), item({ codigo: "ENVIO", descripcion: "Envío", precioUnitario: 25000 })],
      condicion: { tipo: 1, pagos: [{ tipo: 1, monto: 540000 }] },
      observacion: "Pedido #1001",
    })],
    ["FE innominada pagada con tarjeta y transferencia", docFE({ condicion: { tipo: 1, pagos: [{ tipo: 3, monto: 100000 }, { tipo: 5, monto: 29000 }] } })],
    ["FE cédula a crédito", docFE({ receptor: { tipo: "documento", documentoTipo: 1, documentoNumero: "1234567", nombre: "Cliente Inventado" }, condicion: { tipo: 2, pagos: [] } })],
    ["AF", docFE({ tipo: 4, autofactura: AUTOFACTURA as unknown as Record<string, unknown> })],
    ["NC", docFE({ ...nota, tipo: 5, motivoNota: 2 })],
    ["ND", docFE({ ...nota, tipo: 6, motivoNota: 6 })],
    ["NR", docFE({ tipo: 7, condicion: undefined, remision: REMISION as unknown as Record<string, unknown>, asociado: { tipo: 1, cdc: fe.cdc },
      receptor: { ...RUC, direccion: "Calle Inventada", numeroCasa: "10", ...{ departamento: 11, ciudad: { codigo: 3428, descripcion: "CIUDAD DEL ESTE" } } } as never })],
  ];
}

for (const motor of ["wasm", "binario"] as const) {
  Deno.test(`xsd (${motor}): los 5 tipos firmados + QR pasan siRecepDE_v150.xsd`, async () => {
    for (const [nombre, doc] of casos()) {
      const r = await validar(completo(doc), "rDE", { motor });
      assert(r.valido, `${nombre}: ${r.errores.join(" | ")}`);
    }
  });
  Deno.test(`xsd (${motor}): eventos firmados pasan siRecepEvento_v150.xsd`, async () => {
    const can = xmlEventoCancelacion({ cdc: "01444444017001001001452822017012515873260988", motivo: "Pedido anulado", id: 1, fechaFirma: FECHA_FIRMA });
    const inu = xmlEventoInutilizacion({ timbrado: "12345678", establecimiento: "001", punto: "001", desde: 5, hasta: 7, tipo: 1, motivo: "Saltos de numeración", id: 2, fechaFirma: FECHA_FIRMA });
    for (const x of [can.xml, inu.xml]) {
      const r = await validar(firmarEvento(x), "evento", { motor });
      assert(r.valido, r.errores.join(" | "));
    }
  });
  Deno.test(`xsd (${motor}): XML roto falla con mensaje legible`, async () => {
    const malo = completo(docFE()).replace("<dNumDoc>0000001</dNumDoc>", "<dNumDoc>1</dNumDoc>");
    const r = await validar(malo, "rDE", { motor });
    assertEquals(r.valido, false);
    assertStringIncludes(r.errores.join("\n"), "dNumDoc");
    const sinFirma = armarXmlDEConOpciones(docFE(), EMISOR, CRED, op).xml;
    assertEquals((await validar(sinFirma, "rDE", { motor })).valido, false);
    const mal = await validar("<rDE><sin cerrar", "rDE", { motor });
    assertEquals(mal.valido, false);
    assert(mal.errores.length > 0);
  });
}

Deno.test("xsd: validarOFallar tira Error en español", async () => {
  await assertRejects(() => validarOFallar("<rDE/>"), Error, "no cumple el XSD oficial siRecepDE_v150.xsd");
});
