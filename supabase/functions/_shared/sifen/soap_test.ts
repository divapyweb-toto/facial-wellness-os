import { assert, assertEquals, assertMatch, assertThrows } from "jsr:@std/assert@1";
import {
  armarLoteXml,
  deszipLoteBase64,
  generarDId,
  parsearConsDE,
  parsearConsRuc,
  parsearResEnviConsLoteDe,
  parsearResEnviLoteDe,
  parsearRetEnviDe,
  parsearRetEnviEventoDe,
  soapConsDE,
  soapConsLote,
  soapConsRuc,
  soapEnviDe,
  soapEnvioLote,
  soapEvento,
  valor,
} from "./soap.ts";
import { firmarConCertificado } from "./firma.ts";
import { cargarP12, generarCertificadoPrueba } from "./certificado.ts";
const NS_FX = "http://ekuatia.set.gov.py/sifen/xsd";
const CDC_PRUEBA = "01" + "80000000" + "0" + "001" + "001" + "0000001" + "2" + "20261008" + "1" + "123456789" + "2";
function rdePrueba(cdc = CDC_PRUEBA) {
  return `<rDE xmlns="${NS_FX}" xmlns:xsi="http://www.w3.org/2001/XMLSchema-instance" xsi:schemaLocation="${NS_FX} siRecepDE_v150.xsd"><dVerFor>150</dVerFor><DE Id="${cdc}"><dDVId>2</dDVId><gCamItem><dDesProSer>PRUEBA</dDesProSer></gCamItem></DE></rDE>`;
}
function eventoPrueba(id = "123") {
  return `<gGroupGesEve xmlns="${NS_FX}" xmlns:xsi="http://www.w3.org/2001/XMLSchema-instance"><rGesEve xsi:schemaLocation="${NS_FX} siRecepEvento_v150.xsd"><rEve Id="${id}"><dVerFor>150</dVerFor><gGroupTiEvt><rGeVeCan><Id>${CDC_PRUEBA}</Id><mOtEve>Prueba</mOtEve></rGeVeCan></gGroupTiEvt></rEve></rGesEve></gGroupGesEve>`;
}

const NS = "http://ekuatia.set.gov.py/sifen/xsd";
const cdcN = (n: number) => CDC_PRUEBA.slice(0, 18) + String(n).padStart(7, "0") + CDC_PRUEBA.slice(25);

async function firmado(cdc = CDC_PRUEBA) {
  const c = cargarP12((await generarCertificadoPrueba()).p12, "prueba");
  return `<?xml version="1.0" encoding="UTF-8"?>` + firmarConCertificado(rdePrueba(cdc), cdc, c).xmlFirmado;
}

Deno.test("soapEnviDe: SOAP 1.2, rEnviDe/dId/xDE con el rDE sin declaración (MT §7.4, §9.1.1)", async () => {
  const s = soapEnviDe("123", await firmado());
  assert(s.startsWith(`<?xml version="1.0" encoding="UTF-8"?><soap:Envelope xmlns:soap="http://www.w3.org/2003/05/soap-envelope"><soap:Header/><soap:Body><rEnviDe xmlns="${NS}"><dId>123</dId><xDE><rDE xmlns="${NS}"`));
  assert(s.endsWith("</rDE></xDE></rEnviDe></soap:Body></soap:Envelope>"));
  assertEquals(s.split("<?xml").length, 2, "una sola declaración XML");
  assertThrows(() => soapEnviDe("1234567890123456", "<rDE/>"), Error, "dId");
  assertThrows(() => soapEnviDe("1", rdePrueba()), Error, "firmado");
});

Deno.test("lote: zip+base64 de rLoteDE, ida y vuelta, validaciones del MT/guía", async () => {
  const a = await firmado(cdcN(1)), b = await firmado(cdcN(2));
  const s = soapEnvioLote("77", [a, b]);
  assertMatch(s, new RegExp(`<rEnvioLote xmlns="${NS}"><dId>77</dId><xDE>[A-Za-z0-9+/=]+</xDE></rEnvioLote>`));
  const lote = deszipLoteBase64(valor(s, "xDE")!);
  assert(lote.startsWith(`<?xml version="1.0" encoding="UTF-8"?><rLoteDE><rDE xmlns="${NS}"`));
  assertEquals((lote.match(/<rDE /g) ?? []).length, 2);
  assert(lote.includes(cdcN(1)) && lote.includes(cdcN(2)));
  assertThrows(() => armarLoteXml([]), Error, "vacío");
  assertThrows(() => armarLoteXml([a, a]), Error, "repetido");
  assertThrows(() => armarLoteXml(Array(51).fill(a)), Error, "50");
  const otroTipo = await firmado("05" + CDC_PRUEBA.slice(2));
  assertThrows(() => armarLoteXml([a, otroTipo]), Error, "mismo tipo");
  assertThrows(() => armarLoteXml([a, rdePrueba(cdcN(3))]), Error, "firmado");
});

Deno.test("consultas y evento: raíces exactas", async () => {
  assertMatch(soapConsLote("1", "11158097383597290"), /<rEnviConsLoteDe xmlns="[^"]+"><dId>1<\/dId><dProtConsLote>11158097383597290<\/dProtConsLote><\/rEnviConsLoteDe>/);
  assertMatch(soapConsDE("2", CDC_PRUEBA), new RegExp(`<rEnviConsDeRequest xmlns="${NS}"><dId>2</dId><dCDC>${CDC_PRUEBA}</dCDC></rEnviConsDeRequest>`));
  assertMatch(soapConsRuc("3", "80000005-6"), /<rEnviConsRUC xmlns="[^"]+"><dId>3<\/dId><dRUCCons>80000005<\/dRUCCons><\/rEnviConsRUC>/);
  assertThrows(() => soapConsDE("1", "123"), Error, "CDC");
  assertThrows(() => soapConsRuc("1", "12"), Error, "RUC");
  const c = cargarP12((await generarCertificadoPrueba()).p12, "prueba");
  const ev = firmarConCertificado(eventoPrueba("55"), "55", c).xmlFirmado;
  const s = soapEvento("4", ev);
  assert(s.includes(`<rEnviEventoDe xmlns="${NS}"><dId>4</dId><dEvReg><gGroupGesEve xmlns="${NS}"`));
  assert(s.endsWith("</gGroupGesEve></dEvReg></rEnviEventoDe></soap:Body></soap:Envelope>"));
  const soloRGes = ev.replace(/^<gGroupGesEve[^>]*>/, "").replace(/<\/gGroupGesEve>$/, "");
  assert(soapEvento("5", soloRGes).includes("<dEvReg><gGroupGesEve><rGesEve"));
  assertThrows(() => soapEvento("1", eventoPrueba()), Error, "firmado");
});

Deno.test("generarDId: numérico ≤15 dígitos y creciente", () => {
  const a = generarDId(), b = generarDId();
  assertMatch(a, /^\d{1,15}$/);
  assert(BigInt(b) > BigInt(a));
});

// Respuestas tomadas de los ejemplos oficiales (MT §7.4; Guía de Mejores Prácticas oct-2024).
const ENV = (b: string) => `<?xml version="1.0" encoding="UTF-8"?><env:Envelope xmlns:env="http://www.w3.org/2003/05/soap-envelope"><env:Header/><env:Body>${b}</env:Body></env:Envelope>`;

Deno.test("parsear rRetEnviDe: rechazo 0160 (ejemplo MT §7.4) y aprobado 0260", () => {
  const r = parsearRetEnviDe(ENV(`<ns2:rRetEnviDe xmlns:ns2="${NS}"><ns2:rProtDe><ns2:dId>0</ns2:dId><ns2:dFecProc>2019-06-03T12:00:00</ns2:dFecProc><ns2:dDigVal>0</ns2:dDigVal><ns2:gResProc><ns2:dEstRes>Rechazado</ns2:dEstRes><ns2:dProtAut>0000000000</ns2:dProtAut><ns2:dCodRes>0160</ns2:dCodRes><ns2:dMsgRes>XML malformado</ns2:dMsgRes></ns2:gResProc></ns2:rProtDe></ns2:rRetEnviDe>`));
  assertEquals([r.ok, r.estado, r.codigo, r.protocolo], [false, "rechazado", "0160", undefined]);
  assertMatch(r.mensaje!, /XML malformado/);
  const a = parsearRetEnviDe(ENV(`<ns2:rRetEnviDe xmlns:ns2="${NS}"><ns2:rProtDe><ns2:Id>${CDC_PRUEBA}</ns2:Id><ns2:dEstRes>Aprobado</ns2:dEstRes><ns2:dProtAut>1234567890</ns2:dProtAut><ns2:gResProc><ns2:dCodRes>0260</ns2:dCodRes><ns2:dMsgRes>Autorización del DE satisfactoria</ns2:dMsgRes></ns2:gResProc></ns2:rProtDe></ns2:rRetEnviDe>`));
  assertEquals([a.ok, a.estado, a.codigo, a.protocolo], [true, "aprobado", "0260", "1234567890"]);
  const o = parsearRetEnviDe(ENV(`<ns2:rRetEnviDe xmlns:ns2="${NS}"><ns2:rProtDe><ns2:dEstRes>Aprobado con observación</ns2:dEstRes><ns2:gResProc><ns2:dCodRes>1005</ns2:dCodRes><ns2:dMsgRes>Transmisión extemporánea del DE</ns2:dMsgRes></ns2:gResProc></ns2:rProtDe></ns2:rRetEnviDe>`));
  assertEquals([o.ok, o.estado], [true, "aprobado_obs"]);
});

Deno.test("parsear lote: 0300 / 0301 / 0361 / 0362 / 0364 (Mejores Prácticas 2024)", () => {
  const r = parsearResEnviLoteDe(ENV(`<ns2:rResEnviLoteDe xmlns:ns2="${NS}"><ns2:dFecProc>2024-10-08T14:51:21-03:00</ns2:dFecProc><ns2:dCodRes>0300</ns2:dCodRes><ns2:dMsgRes>Lote recibido con &#233;xito</ns2:dMsgRes><ns2:dProtConsLote>11158097383597290</ns2:dProtConsLote><ns2:dTpoProces>0</ns2:dTpoProces></ns2:rResEnviLoteDe>`));
  assertEquals([r.ok, r.estado, r.protocolo, r.mensaje], [true, "en_proceso", "11158097383597290", "Lote recibido con éxito"]);
  assertEquals(parsearResEnviLoteDe(ENV(`<ns2:rResEnviLoteDe xmlns:ns2="${NS}"><ns2:dCodRes>0301</ns2:dCodRes><ns2:dMsgRes>Lote no encolado</ns2:dMsgRes></ns2:rResEnviLoteDe>`)).estado, "rechazado");
  const p = parsearResEnviConsLoteDe(ENV(`<ns2:rResEnviConsLoteDe xmlns:ns2="${NS}"><ns2:dFecProc>2024-10-08T14:53:53-03:00</ns2:dFecProc><ns2:dCodResLot>0361</ns2:dCodResLot><ns2:dMsgResLot>Lote {1} en procesamiento</ns2:dMsgResLot></ns2:rResEnviConsLoteDe>`));
  assertEquals([p.ok, p.estado, p.reintentable], [true, "en_proceso", true]);
  const c = parsearResEnviConsLoteDe(ENV(`<ns2:rResEnviConsLoteDe xmlns:ns2="${NS}"><ns2:dFecProc>2024-10-08T03:58:16-03:00</ns2:dFecProc><ns2:dCodResLot>0362</ns2:dCodResLot><ns2:dMsgResLot>Procesamiento de lote {11444651783497640} concluido</ns2:dMsgResLot><ns2:gResProcLote><ns2:id>07800252985001001000311822024021016361562161</ns2:id><ns2:dEstRes>Rechazado</ns2:dEstRes><ns2:gResProc><ns2:dCodRes>0160</ns2:dCodRes><ns2:dMsgRes>XML malformado: [El valor del elemento: dDirRec es invalido]</ns2:dMsgRes></ns2:gResProc></ns2:gResProcLote><ns2:gResProcLote><ns2:id>${CDC_PRUEBA}</ns2:id><ns2:dEstRes>Aprobado</ns2:dEstRes><ns2:dProtAut>222</ns2:dProtAut><ns2:gResProc><ns2:dCodRes>0260</ns2:dCodRes><ns2:dMsgRes>ok</ns2:dMsgRes></ns2:gResProc></ns2:gResProcLote></ns2:rResEnviConsLoteDe>`));
  assertEquals([c.ok, c.estado, c.codigo], [true, "rechazado", "0362"]);
  assertEquals(c.documentos, [
    { cdc: "07800252985001001000311822024021016361562161", estado: "rechazado", codigo: "0160", mensaje: "XML malformado: [El valor del elemento: dDirRec es invalido]", protocolo: undefined },
    { cdc: CDC_PRUEBA, estado: "aprobado", codigo: "0260", mensaje: "ok", protocolo: "222" },
  ]);
  const x = parsearResEnviConsLoteDe(ENV(`<ns2:rResEnviConsLoteDe xmlns:ns2="${NS}"><ns2:dCodResLot>0364</ns2:dCodResLot><ns2:dMsgResLot>Consulta extemporánea</ns2:dMsgResLot></ns2:rResEnviConsLoteDe>`));
  assertEquals([x.ok, x.consultarPorCdc], [false, true]);
});

Deno.test("parsear consulta DE 0420/0422, evento 0600, RUC 0502/0500, Fault, 302 F5, raíz ausente", () => {
  const no = parsearConsDE(ENV(`<ns2:rEnviConsDeResponse xmlns:ns2="${NS}"><ns2:dFecProc>2024-10-09T09:28:39-03:00</ns2:dFecProc><ns2:dCodRes>0420</ns2:dCodRes><ns2:dMsgRes>Documento No Existe en SIFEN o ha sido Rechazado</ns2:dMsgRes></ns2:rEnviConsDeResponse>`));
  assertEquals([no.ok, no.existe, no.codigo], [false, false, "0420"]);
  const si = parsearConsDE(ENV(`<ns2:rEnviConsDeResponse xmlns:ns2="${NS}"><ns2:dCodRes>0422</ns2:dCodRes><ns2:dMsgRes>CDC encontrado</ns2:dMsgRes><ns2:xContenDE>&lt;rContDe&gt;&lt;dProtAut&gt;999&lt;/dProtAut&gt;&lt;/rContDe&gt;</ns2:xContenDE></ns2:rEnviConsDeResponse>`));
  assertEquals([si.ok, si.estado, si.existe, si.protocolo], [true, "aprobado", true, "999"]);
  const ev = parsearRetEnviEventoDe(ENV(`<ns2:rRetEnviEventoDe xmlns:ns2="${NS}"><ns2:dFecProc>x</ns2:dFecProc><ns2:gResProcEVe><ns2:dEstRes>Aprobado</ns2:dEstRes><ns2:dProtAut>5</ns2:dProtAut><ns2:id>1</ns2:id><ns2:gResProc><ns2:dCodRes>0600</ns2:dCodRes><ns2:dMsgRes>Evento registrado correctamente</ns2:dMsgRes></ns2:gResProc></ns2:gResProcEVe></ns2:rRetEnviEventoDe>`));
  assertEquals([ev.ok, ev.estado, ev.codigo, ev.protocolo], [true, "aprobado", "0600", "5"]);
  const ruc = parsearConsRuc(ENV(`<ns2:rResEnviConsRUC xmlns:ns2="${NS}"><ns2:dCodRes>0502</ns2:dCodRes><ns2:dMsgRes>RUC encontrado</ns2:dMsgRes><ns2:xContRUC><ns2:dRUCCons>80000005</ns2:dRUCCons><ns2:dRazCons>EMPRESA DE PRUEBA S.A.</ns2:dRazCons><ns2:dCodEstCons>ACT</ns2:dCodEstCons><ns2:dDesEstCons>ACTIVO</ns2:dDesEstCons><ns2:dRUCFactElec>S</ns2:dRUCFactElec></ns2:xContRUC></ns2:rResEnviConsRUC>`));
  assertEquals(ruc.contribuyente, { ruc: "80000005", razonSocial: "EMPRESA DE PRUEBA S.A.", estadoCodigo: "ACT", estado: "ACTIVO", facturadorElectronico: true });
  assertEquals(parsearConsRuc(ENV(`<ns2:rResEnviConsRUC xmlns:ns2="${NS}"><ns2:dCodRes>0500</ns2:dCodRes><ns2:dMsgRes>RUC no existe</ns2:dMsgRes></ns2:rResEnviConsRUC>`)).existe, false);
  const f = parsearRetEnviDe(ENV(`<env:Fault><env:Code><env:Value>env:Receiver</env:Value></env:Code><env:Reason><env:Text xml:lang="es">Error interno</env:Text></env:Reason></env:Fault>`), 500);
  assertEquals(f.estado, "error");
  assertMatch(f.mensaje!, /Error interno/);
  const red = parsearRetEnviDe("", 302);
  assertMatch(red.mensaje!, /autenticación mutua/);
  assertEquals(parsearRetEnviDe("<html>502</html>", 502).reintentable, true);
});
