import { assert, assertEquals, assertThrows } from "@std/assert";
import { idEventoAleatorio, xmlEventoCancelacion, xmlEventoInutilizacion, xmlEventoReceptor } from "./eventos_xml.ts";

const CDC = "01444444017001001001452822017012515873260988";

Deno.test("eventos: cancelación", () => {
  const r = xmlEventoCancelacion({ cdc: CDC, motivo: "Pedido anulado por el cliente & reintegro", id: 15, fechaFirma: "2026-10-08T11:00:00" });
  assertEquals(r.idEvento, "15");
  assertEquals(r.xml, `<?xml version="1.0" encoding="UTF-8"?><gGroupGesEve xmlns="http://ekuatia.set.gov.py/sifen/xsd" xmlns:xsi="http://www.w3.org/2001/XMLSchema-instance"><rGesEve xsi:schemaLocation="http://ekuatia.set.gov.py/sifen/xsd siRecepEvento_v150.xsd"><rEve Id="15"><dFecFirma>2026-10-08T11:00:00</dFecFirma><dVerFor>150</dVerFor><gGroupTiEvt><rGeVeCan><Id>${CDC}</Id><mOtEve>Pedido anulado por el cliente &amp; reintegro</mOtEve></rGeVeCan></gGroupTiEvt></rEve></rGesEve></gGroupGesEve>`);
});

Deno.test("eventos: inutilización", () => {
  const r = xmlEventoInutilizacion({ timbrado: "12345678", establecimiento: "001", punto: "001", desde: 5, hasta: 7, tipo: 1, motivo: "Saltos de numeración por error", id: 9 });
  assert(r.xml.includes("<rGeVeInu><dNumTim>12345678</dNumTim><dEst>001</dEst><dPunExp>001</dPunExp><dNumIn>0000005</dNumIn><dNumFin>0000007</dNumFin><iTiDE>1</iTiDE><mOtEve>Saltos de numeración por error</mOtEve></rGeVeInu>"));
});

Deno.test("eventos: validaciones", () => {
  assertThrows(() => xmlEventoCancelacion({ cdc: CDC.slice(0, 43) + "1", motivo: "motivo largo" }), Error, "CDC");
  assertThrows(() => xmlEventoCancelacion({ cdc: CDC, motivo: "abc" }), Error, "5 y 500");
  assertThrows(() => xmlEventoInutilizacion({ timbrado: "12345678", establecimiento: "001", punto: "001", desde: 1, hasta: 1001, tipo: 1, motivo: "rango grande" }), Error, "1000");
  assertThrows(() => xmlEventoInutilizacion({ timbrado: "12345678", establecimiento: "001", punto: "001", desde: 5, hasta: 4, tipo: 1, motivo: "invertido" }), Error, "menor");
  for (let i = 0; i < 100; i++) {
    const id = idEventoAleatorio();
    assert(id >= 1 && id <= 9_999_999_999);
  }
});

Deno.test("eventos del receptor: notificación con RUC, conformidad total y validaciones", () => {
  const rec = { tipo: 1 as const, nombre: "Voltra E.A.S.", ruc: "80177762", dv: "3" };
  const n = xmlEventoReceptor({ evento: "notificacion", cdc: CDC, fechaEmision: "2026-10-08T10:00:00", fechaRecepcion: "2026-10-08T12:00:00", receptor: rec, totalGs: 162000, id: 9, fechaFirma: "2026-10-08T12:00:00" });
  assert(n.xml.includes(`<rGeVeNotRec><Id>${CDC}</Id><dFecEmi>2026-10-08T10:00:00</dFecEmi><dFecRecep>2026-10-08T12:00:00</dFecRecep><iTipRec>1</iTipRec><dNomRec>Voltra E.A.S.</dNomRec><dRucRec>80177762</dRucRec><dDVRec>3</dDVRec><dTotalGs>162000</dTotalGs></rGeVeNotRec>`));
  assertEquals(n.idEvento, "9");
  const c = xmlEventoReceptor({ evento: "conformidad", cdc: CDC, id: 10, fechaFirma: "2026-10-08T12:00:00" });
  assert(c.xml.includes(`<rGeVeConf><Id>${CDC}</Id><iTipConf>1</iTipConf></rGeVeConf>`));
  assertThrows(() => xmlEventoReceptor({ evento: "conformidad", cdc: CDC, parcial: true }), Error, "fecha de recepción");
  assertThrows(() => xmlEventoReceptor({ evento: "disconformidad", cdc: CDC, motivo: "no" }), Error, "entre 5 y 500");
  assertThrows(() => xmlEventoReceptor({ evento: "disconformidad", cdc: "123", motivo: "Mercadería dañada" }), Error, "CDC inválido");
  assertThrows(() => xmlEventoReceptor({ evento: "desconocimiento", cdc: CDC, fechaEmision: "2026-10-08", fechaRecepcion: "2026-10-08T12:00:00", receptor: rec, motivo: "No reconozco" }), Error, "AAAA-MM-DDThh:mm:ss");
  assertThrows(() => xmlEventoReceptor({ evento: "notificacion", cdc: CDC, fechaEmision: "2026-10-08T10:00:00", fechaRecepcion: "2026-10-08T12:00:00", receptor: { ...rec, ruc: "80177762-3" }, totalGs: 1 }), Error, "RUC");
});
