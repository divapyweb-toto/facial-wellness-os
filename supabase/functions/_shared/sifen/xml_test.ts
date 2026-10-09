import { assert, assertEquals, assertStringIncludes, assertThrows } from "@std/assert";
import { aplicarLeyendasPrueba, armarXmlDE, armarXmlDEConOpciones, escaparXml, LEYENDA_EMISOR_PRUEBA } from "./xml.ts";
import { validarCdc } from "./cdc.ts";
import { AUTOFACTURA, CRED, docFE, EMISOR, FECHA_FIRMA, item, REMISION } from "./xml_fixtures_test.ts";

const op = { fechaFirma: FECHA_FIRMA };

function ordenDe(xml: string, tags: string[]): number[] {
  return tags.map((t) => xml.indexOf(`<${t}>`) >= 0 ? xml.indexOf(`<${t}>`) : xml.indexOf(`<${t} `));
}

Deno.test("xml: FE innominada con estructura, orden y CDC", () => {
  const { xml, cdc, totales } = armarXmlDEConOpciones(docFE(), EMISOR, CRED, op);
  assert(validarCdc(cdc));
  assertEquals(totales.total, 129000);
  assert(xml.startsWith(`<?xml version="1.0" encoding="UTF-8"?><rDE xmlns="http://ekuatia.set.gov.py/sifen/xsd"`));
  assertStringIncludes(xml, `<dVerFor>150</dVerFor><DE Id="${cdc}"><dDVId>${cdc[43]}</dDVId><dFecFirma>${FECHA_FIRMA}</dFecFirma><dSisFact>1</dSisFact>`);
  assertStringIncludes(xml, "<iTipIDRec>5</iTipIDRec><dDTipIDRec>Innominado</dDTipIDRec><dNumIDRec>0</dNumIDRec><dNomRec>Sin Nombre</dNomRec>");
  assertStringIncludes(xml, "<gCamFE><iIndPres>2</iIndPres><dDesIndPres>Operación electrónica</dDesIndPres></gCamFE>");
  assertStringIncludes(xml, "<iTipTra>1</iTipTra><dDesTipTra>Venta de mercadería</dDesTipTra>");
  assertStringIncludes(xml, "<dDesDepEmi>ALTO PARANA</dDesDepEmi>");
  assertStringIncludes(xml, "<dTotGralOpe>129000</dTotGralOpe><dIVA5>0</dIVA5><dIVA10>11727</dIVA10>");
  assertStringIncludes(xml, "<dBasGravIVA>117272.72727273</dBasGravIVA><dLiqIVAItem>11727.27272727</dLiqIVAItem><dBasExe>0</dBasExe>");
  const o = ordenDe(xml, ["gOpeDE", "gTimb", "gDatGralOpe", "gDtipDE", "gTotSub"]);
  assert(o.every((v, i) => v > 0 && (i === 0 || v > o[i - 1])), `orden incorrecto ${o}`);
  assert(!xml.includes("<Signature") && !xml.includes("gCamFuFD") && !xml.includes("<!--"));
  assert(!/>\s+</.test(xml), "sin espacios entre etiquetas");
});

Deno.test("xml: armarXmlDE (contrato) usa la hora actual de Asunción", () => {
  const { xml } = armarXmlDE(docFE(), EMISOR, CRED);
  assert(/<dFecFirma>\d{4}-\d\d-\d\dT\d\d:\d\d:\d\d<\/dFecFirma>/.test(xml));
});

Deno.test("xml: receptor con RUC y con cédula", () => {
  const r1 = armarXmlDEConOpciones(docFE({ receptor: { tipo: "ruc", ruc: "88899990", dv: "9", razonSocial: "Cliente & Hijos S.A." } }), EMISOR, CRED, op).xml;
  assertStringIncludes(r1, "<iNatRec>1</iNatRec><iTiOpe>1</iTiOpe><cPaisRec>PRY</cPaisRec><dDesPaisRe>Paraguay</dDesPaisRe><iTiContRec>1</iTiContRec><dRucRec>88899990</dRucRec><dDVRec>9</dDVRec><dNomRec>Cliente &amp; Hijos S.A.</dNomRec>");
  const r2 = armarXmlDEConOpciones(docFE({ receptor: { tipo: "documento", documentoTipo: 1, documentoNumero: "1234567", nombre: "Juana Pérez", email: "mal-email", celular: "0981000000" } }), EMISOR, CRED, op).xml;
  assertStringIncludes(r2, "<iNatRec>2</iNatRec><iTiOpe>2</iTiOpe>");
  assertStringIncludes(r2, "<iTipIDRec>1</iTipIDRec><dDTipIDRec>Cédula paraguaya</dDTipIDRec><dNumIDRec>1234567</dNumIDRec><dNomRec>Juana Pérez</dNomRec><dCelRec>0981000000</dCelRec>");
  assert(!r2.includes("dEmailRec"), "email inválido se omite");
});

Deno.test("xml: NC, ND, AF y NR", () => {
  const fe = armarXmlDEConOpciones(docFE({ receptor: { tipo: "ruc", ruc: "88899990", dv: "9", razonSocial: "Cliente S.A." } }), EMISOR, CRED, op);
  const base = { receptor: { tipo: "ruc" as const, ruc: "88899990", dv: "9", razonSocial: "Cliente S.A." }, condicion: undefined, numero: 2 };
  const nc = armarXmlDEConOpciones(docFE({ ...base, tipo: 5, motivoNota: 2, asociado: { tipo: 1, cdc: fe.cdc } }), EMISOR, CRED, op);
  assert(nc.cdc.startsWith("05"));
  assertStringIncludes(nc.xml, "<gCamNCDE><iMotEmi>2</iMotEmi><dDesMotEmi>Devolución</dDesMotEmi></gCamNCDE>");
  assertStringIncludes(nc.xml, `<gCamDEAsoc><iTipDocAso>1</iTipDocAso><dDesTipDocAso>Electrónico</dDesTipDocAso><dCdCDERef>${fe.cdc}</dCdCDERef></gCamDEAsoc>`);
  assert(!nc.xml.includes("gCamCond") && !nc.xml.includes("iTipTra"));
  const nd = armarXmlDEConOpciones(docFE({ ...base, tipo: 6, motivoNota: 6, asociado: { tipo: 1, cdc: fe.cdc } }), EMISOR, CRED, op);
  assert(nd.cdc.startsWith("06"));
  const af = armarXmlDEConOpciones(docFE({ tipo: 4, autofactura: AUTOFACTURA as unknown as Record<string, unknown>, condicion: { tipo: 1, pagos: [{ tipo: 1, monto: 129000 }] } }), EMISOR, CRED, op);
  assertStringIncludes(af.xml, "<dRucRec>44444401</dRucRec>");
  assertStringIncludes(af.xml, "<iTipDocAso>3</iTipDocAso><dDesTipDocAso>Constancia Electrónica</dDesTipDocAso><iTipCons>1</iTipCons>");
  assert(!af.xml.includes("gCamIVA") && !af.xml.includes("dIVA10"));
  const nr = armarXmlDEConOpciones(docFE({
    tipo: 7, condicion: undefined, remision: REMISION as unknown as Record<string, unknown>,
    receptor: { tipo: "ruc", ruc: "88899990", dv: "9", razonSocial: "Cliente S.A.", direccion: "Calle 1", ...{ departamento: 11, ciudad: { codigo: 3428, descripcion: "CIUDAD DEL ESTE" } } } as never,
  }), EMISOR, CRED, op);
  assertStringIncludes(nr.xml, "<dInfoFisc>");
  assertStringIncludes(nr.xml, "<gCamNRE><iMotEmiNR>1</iMotEmiNR>");
  assert(!nr.xml.includes("gTotSub") && !nr.xml.includes("gValorItem") && !nr.xml.includes("gOpeCom"));
});

Deno.test("xml: validaciones propias con mensaje claro", () => {
  assertThrows(() => armarXmlDEConOpciones(docFE({ fechaEmision: "2026-13-01T00:00:00" }), EMISOR, CRED, op), Error, "Fecha de emisión");
  assertThrows(() => armarXmlDEConOpciones(docFE(), { ...EMISOR, dv: "1" }, CRED, op), Error, "módulo 11");
  assertThrows(() => armarXmlDEConOpciones(docFE({ receptor: { tipo: "ruc", ruc: "88899990", dv: "1", razonSocial: "X S.A." } }), EMISOR, CRED, op), Error, "DV del receptor");
  assertThrows(() => armarXmlDEConOpciones(docFE({ tipo: 5, condicion: undefined, motivoNota: 1, receptor: { tipo: "ruc", ruc: "88899990", dv: "9", razonSocial: "X S.A." } }), EMISOR, CRED, op), Error, "documento asociado");
  assertThrows(() => armarXmlDEConOpciones(docFE({ items: [item({ precioUnitario: -1 })] }), EMISOR, CRED, op), Error, "precio");
  assertThrows(() => armarXmlDEConOpciones(docFE({ condicion: { tipo: 1, pagos: [{ tipo: 1, monto: 1000 }] } }), EMISOR, CRED, op), Error, "suma de los pagos");
  assertThrows(() => armarXmlDEConOpciones(docFE({ tipoEmision: 2 }), EMISOR, CRED, op), Error, "1050");
  assertThrows(() => armarXmlDEConOpciones(docFE({ items: [item({ precioUnitario: 7000000 })], condicion: { tipo: 1, pagos: [{ tipo: 1, monto: 7000000 }] } }), EMISOR, CRED, op), Error, "innominado");
  assertThrows(() => armarXmlDEConOpciones(docFE({ tipo: 5, condicion: undefined, motivoNota: 1, asociado: { tipo: 1, cdc: "01444444017001001001452822017012515873260988" } }), EMISOR, CRED, op), Error, "no puede ser innominada");
  assertThrows(() => armarXmlDEConOpciones(docFE(), EMISOR, { ...CRED, timbrado: "123" }, op), Error, "Timbrado");
  assertThrows(() => armarXmlDEConOpciones(docFE({ fechaEmision: "2025-12-31T10:00:00" }), EMISOR, CRED, op), Error, "timbrado");
});

Deno.test("xml: escape y leyendas de prueba", () => {
  assertEquals(escaparXml(`a<b>&"c'`), "a&lt;b&gt;&amp;&quot;c&apos;");
  const { doc, emisor } = aplicarLeyendasPrueba(docFE({ items: [item(), item({ codigo: "B" })] }), EMISOR);
  assertEquals(emisor.razonSocial, LEYENDA_EMISOR_PRUEBA);
  assertStringIncludes(doc.items[0].descripcion, "SIN VALOR COMERCIAL");
  assertEquals(doc.items[1].descripcion, "Producto de prueba");
  assertEquals(EMISOR.razonSocial, "Empresa de Prueba S.A.");
});
