import { assertEquals } from "@std/assert";
import {
  armarFila,
  bytesDeBase64,
  clasificarAdjunto,
  decodificarBase64,
  MAX_BYTES,
  parsearXmlSifen,
  prepararAdjuntos,
  rucSinDv,
  sanearNombre,
  validarCuerpo,
} from "./logica.ts";

// XML INVENTADO con la estructura de un DE de SIFEN v150 (emisor y CDC ficticios; receptor = RUC de Voltra).
const CDC = "01800000001001001000012322026103011234567890";
const xmlDe = (rucRec: string | null, prefijo = "") => `<?xml version="1.0" encoding="UTF-8"?>
<${prefijo}rDE xmlns${prefijo ? ":" + prefijo.slice(0, -1) : ""}="http://ekuatia.set.gov.py/sifen/xsd">
  <${prefijo}dVerFor>150</${prefijo}dVerFor>
  <${prefijo}DE Id="${CDC}">
    <${prefijo}dDVId>0</${prefijo}dDVId>
    <${prefijo}gTimb>
      <${prefijo}iTiDE>1</${prefijo}iTiDE>
      <${prefijo}dNumTim>12345678</${prefijo}dNumTim>
      <${prefijo}dEst>1</${prefijo}dEst>
      <${prefijo}dPunExp>001</${prefijo}dPunExp>
      <${prefijo}dNumDoc>1232</${prefijo}dNumDoc>
    </${prefijo}gTimb>
    <${prefijo}gDatGralOpe>
      <${prefijo}dFeEmiDE>2026-10-30T10:15:00</${prefijo}dFeEmiDE>
      <${prefijo}gEmis>
        <${prefijo}dRucEm>80000000</${prefijo}dRucEm>
        <${prefijo}dDVEmi>1</${prefijo}dDVEmi>
        <${prefijo}dNomEmi>PROVEEDOR  DE PRUEBA &amp; CIA S.A.</${prefijo}dNomEmi>
      </${prefijo}gEmis>
      <${prefijo}gDatRec>
        <${prefijo}iNatRec>1</${prefijo}iNatRec>
        ${rucRec ? `<${prefijo}dRucRec>${rucRec}</${prefijo}dRucRec><${prefijo}dDVRec>6</${prefijo}dDVRec>` : ""}
        <${prefijo}dNomRec>RECEPTOR</${prefijo}dNomRec>
      </${prefijo}gDatRec>
    </${prefijo}gDatGralOpe>
    <${prefijo}gTotSub>
      <${prefijo}dTotOpe>150000</${prefijo}dTotOpe>
      <${prefijo}dTotGralOpe>150000.00</${prefijo}dTotGralOpe>
    </${prefijo}gTotSub>
  </${prefijo}DE>
</${prefijo}rDE>`;

const b64 = (s: string | Uint8Array) => {
  const bytes = typeof s === "string" ? new TextEncoder().encode(s) : s;
  let bin = "";
  for (const b of bytes) bin += String.fromCharCode(b);
  return btoa(bin);
};
const PDF = b64("%PDF-1.4\n%prueba\n");

const cuerpo = (adjuntos: unknown[]) => ({
  id: "18f2a3b4c5d6e7f8", remitente: "Proveedor <facturas@ejemplo.test>", asunto: "Factura 001-001-0001232",
  fecha: "2026-10-30T13:20:00.000Z", adjuntos,
});

Deno.test("parsearXmlSifen: CDC, emisor, número 3-3-7, fecha, total y receptor", () => {
  assertEquals(parsearXmlSifen(xmlDe("80177762")), {
    cdc: CDC,
    proveedor: "PROVEEDOR DE PRUEBA & CIA S.A.",
    ruc_emisor: "80000000-1",
    numero: "001-001-0001232",
    fecha_doc: "2026-10-30",
    total: 150000,
    receptor_ruc: "80177762",
  });
});

Deno.test("parsearXmlSifen: con prefijo ns2: y con BOM también lee", () => {
  const d = parsearXmlSifen("﻿" + xmlDe("80177762", "ns2:"));
  assertEquals(d?.cdc, CDC);
  assertEquals(d?.numero, "001-001-0001232");
  assertEquals(d?.receptor_ruc, "80177762");
});

Deno.test("parsearXmlSifen: XML que no es un DE → null", () => {
  assertEquals(parsearXmlSifen("<?xml version='1.0'?><pedido><dato>1</dato></pedido>"), null);
  assertEquals(parsearXmlSifen("no es xml"), null);
  assertEquals(parsearXmlSifen("<rDE><dVerFor>150</dVerFor></rDE>"), null);
});

Deno.test("rucSinDv: con y sin DV", () => {
  assertEquals(rucSinDv("80177762-1"), "80177762");
  assertEquals(rucSinDv(" 80177762 "), "80177762");
  assertEquals(rucSinDv(""), null);
  assertEquals(rucSinDv(undefined), null);
});

Deno.test("clasificarAdjunto: por MIME o por extensión; lo demás se ignora", () => {
  assertEquals(clasificarAdjunto("kude.pdf", "application/octet-stream"), "pdf");
  assertEquals(clasificarAdjunto("factura", "application/pdf"), "pdf");
  assertEquals(clasificarAdjunto("DE.XML", "application/octet-stream"), "xml");
  assertEquals(clasificarAdjunto("de", "text/xml; charset=utf-8"), "xml");
  assertEquals(clasificarAdjunto("foto.jpg", "image/jpeg"), null);
});

Deno.test("sanearNombre: sin tildes, barras ni espacios; con extensión; sin repetir", () => {
  const u = new Set<string>();
  assertEquals(sanearNombre("Factura Nº 001-001 más.pdf", "pdf", u), "Factura_N_001-001_mas.pdf");
  assertEquals(sanearNombre("../../etc/passwd", "xml", u), "passwd.xml");
  assertEquals(sanearNombre("otra factura.PDF", "pdf", u), "otra_factura.pdf");
  // Repetido (sin importar mayúsculas) → sufijo _2.
  assertEquals(sanearNombre("factura n 001-001 mas.pdf", "pdf", u), "factura_n_001-001_mas_2.pdf");
  assertEquals(sanearNombre("···", "pdf", u), "adjunto.pdf");
});

Deno.test("base64: tamaño sin decodificar y decodificación (estándar y URL-safe)", () => {
  assertEquals(bytesDeBase64(b64("hola")), 4);
  assertEquals(new TextDecoder().decode(decodificarBase64(b64("hola"))!), "hola");
  assertEquals(decodificarBase64("%%no base64%%"), null);
  const raro = new Uint8Array([251, 255, 254]);
  const urlSafe = b64(raro).replace(/\+/g, "-").replace(/\//g, "_");
  assertEquals(decodificarBase64(urlSafe), raro);
});

Deno.test("validarCuerpo: id, fecha, lista y máximo 6 adjuntos", () => {
  const ok = validarCuerpo(cuerpo([{ nombre: "a.pdf", tipo: "application/pdf", base64: PDF }]));
  assertEquals(ok.ok, true);
  if (ok.ok) assertEquals(ok.datos.fecha, "2026-10-30T13:20:00.000Z");
  assertEquals(validarCuerpo(null), { ok: false, error: "cuerpo inválido" });
  assertEquals(validarCuerpo({ ...cuerpo([]), id: "../x" }), { ok: false, error: "id inválido" });
  assertEquals(validarCuerpo({ ...cuerpo([]), fecha: "ayer" }), { ok: false, error: "fecha inválida" });
  assertEquals(validarCuerpo({ ...cuerpo([]), adjuntos: "x" }), { ok: false, error: "adjuntos debe ser una lista" });
  const siete = Array.from({ length: 7 }, (_, i) => ({ nombre: `${i}.pdf`, tipo: "application/pdf", base64: PDF }));
  assertEquals(validarCuerpo(cuerpo(siete)), { ok: false, error: "más de 6 adjuntos" });
  assertEquals(validarCuerpo(cuerpo([{ nombre: "a.pdf" }])), { ok: false, error: "adjunto sin nombre o base64" });
});

Deno.test("prepararAdjuntos: rutas recibidas/<id>/, omite lo que no es PDF/XML o pasa de 5 MB", () => {
  const grande = "A".repeat(Math.ceil(((MAX_BYTES + 10) * 4) / 3));
  const { listos, omitidos } = prepararAdjuntos("18f2a3b4c5d6e7f8", [
    { nombre: "KuDE 1232.pdf", tipo: "application/pdf", base64: PDF },
    { nombre: "de.xml", tipo: "application/octet-stream", base64: b64(xmlDe("80177762")) },
    { nombre: "logo.png", tipo: "image/png", base64: b64("x") },
    { nombre: "enorme.pdf", tipo: "application/pdf", base64: grande },
  ]);
  assertEquals(listos.map((l) => [l.clase, l.ruta, l.contentType]), [
    ["pdf", "recibidas/18f2a3b4c5d6e7f8/KuDE_1232.pdf", "application/pdf"],
    ["xml", "recibidas/18f2a3b4c5d6e7f8/de.xml", "application/xml"],
  ]);
  assertEquals(omitidos, ["logo.png: no es PDF ni XML", "enorme.pdf: más de 5 MB"]);
});

const fila = (adjuntos: { nombre: string; tipo: string; base64: string }[]) => {
  const v = validarCuerpo(cuerpo(adjuntos));
  if (!v.ok) throw new Error(v.error);
  return armarFila(v.datos, prepararAdjuntos(v.datos.id, v.datos.adjuntos).listos);
};

Deno.test("armarFila: PDF + XML a nombre de Voltra → es_de_voltra true, sin descartar", () => {
  assertEquals(fila([
    { nombre: "kude.pdf", tipo: "application/pdf", base64: PDF },
    { nombre: "de.xml", tipo: "text/xml", base64: b64(xmlDe("80177762")) },
  ]), {
    gmail_id: "18f2a3b4c5d6e7f8",
    recibida_en: "2026-10-30T13:20:00.000Z",
    remitente: "Proveedor <facturas@ejemplo.test>",
    asunto: "Factura 001-001-0001232",
    proveedor: "PROVEEDOR DE PRUEBA & CIA S.A.",
    ruc_emisor: "80000000-1",
    numero: "001-001-0001232",
    cdc: CDC,
    fecha_doc: "2026-10-30",
    total: 150000,
    receptor_ruc: "80177762",
    pdf_path: "recibidas/18f2a3b4c5d6e7f8/kude.pdf",
    xml_path: "recibidas/18f2a3b4c5d6e7f8/de.xml",
    es_de_voltra: true,
  });
});

Deno.test("armarFila: XML con otro receptor → es_de_voltra false y descartada", () => {
  const f = fila([{ nombre: "de.xml", tipo: "text/xml", base64: b64(xmlDe("4567890")) }]);
  assertEquals([f.es_de_voltra, f.descartada, f.receptor_ruc, f.pdf_path], [false, true, "4567890", null]);
});

Deno.test("armarFila: XML sin RUC receptor (consumidor final) → no es de Voltra, descartada", () => {
  const f = fila([{ nombre: "de.xml", tipo: "text/xml", base64: b64(xmlDe(null)) }]);
  assertEquals([f.es_de_voltra, f.descartada, f.receptor_ruc], [false, true, null]);
});

Deno.test("armarFila: solo PDF → es_de_voltra null, no se descarta ni se manda descartada", () => {
  const f = fila([{ nombre: "factura.pdf", tipo: "application/pdf", base64: PDF }]);
  assertEquals([f.es_de_voltra, "descartada" in f, f.numero, f.xml_path], [null, false, null, null]);
});

Deno.test("armarFila: XML que no es de SIFEN se guarda pero no decide nada", () => {
  const f = fila([{ nombre: "otro.xml", tipo: "text/xml", base64: b64("<pedido/>") }]);
  assertEquals([f.xml_path, f.es_de_voltra, f.cdc], ["recibidas/18f2a3b4c5d6e7f8/otro.xml", null, null]);
});

Deno.test("armarFila: con varios PDF elige el que lleva el CDC en el nombre", () => {
  const f = fila([
    { nombre: "condiciones.pdf", tipo: "application/pdf", base64: PDF },
    { nombre: `${CDC}.pdf`, tipo: "application/pdf", base64: PDF },
    { nombre: "de.xml", tipo: "text/xml", base64: b64(xmlDe("80177762")) },
  ]);
  assertEquals(f.pdf_path, `recibidas/18f2a3b4c5d6e7f8/${CDC}.pdf`);
});
