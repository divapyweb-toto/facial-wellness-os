import { assertEquals, assertThrows } from "@std/assert";
import { calcularTotales, numXml, redondear } from "./totales.ts";
import { item } from "./xml_fixtures_test.ts";

Deno.test("totales: pedido x1 a 129.000 (IVA 10 % incluido)", () => {
  const r = calcularTotales([item()]);
  assertEquals(r.totales, {
    total: 129000, totalIva: 11727, iva10: 11727, iva5: 0, base10: 117273, base5: 0,
    gravado10: 129000, gravado5: 0, exento: 0, exonerado: 0, descuentoTotal: 0,
  });
  assertEquals(r.items[0].baseGravada, 117272.72727273); // E735 = EA008/1,1 (8 decimales)
  assertEquals(r.items[0].liquidacionIva, 11727.27272727); // E736 = E735*0,1
});

Deno.test("totales: pedido x3", () => {
  const r = calcularTotales([item({ cantidad: 3 })]);
  assertEquals(r.totales.total, 387000);
  assertEquals(r.totales.iva10, 35182); // 387000/11 = 35181,82
  assertEquals(r.totales.base10, 351818);
  assertEquals(r.items[0].totalBruto, 387000);
});

Deno.test("totales: con descuento por unidad", () => {
  const r = calcularTotales([item({ cantidad: 2, precioUnitario: 199000, descuentoUnitario: 20000 })]);
  assertEquals(r.items[0].totalBruto, 398000); // E727
  assertEquals(r.items[0].totalOperacion, 358000); // EA008 = (199000-20000)*2
  assertEquals(r.items[0].porcentajeDescuento, 10.05025126); // EA003
  assertEquals(r.campos.dTotDesc, 40000); // F009 = EA002*E711
  assertEquals(r.campos.dDescTotal, 40000); // F011
  assertEquals(r.totales.total, 358000); // F014 = F008 - F013
  assertEquals(r.totales.iva10, 32545); // 358000/11 = 32545,45
  assertEquals(r.totales.base10 + r.totales.iva10, 358000);
});

Deno.test("totales: envío como ítem IVA 10 %", () => {
  const r = calcularTotales([item(), item({ codigo: "ENVIO", descripcion: "Envío", precioUnitario: 25000 })]);
  assertEquals(r.totales.total, 154000);
  assertEquals(r.totales.iva10, 14000); // 11727,27 + 2272,73 = 14000
  assertEquals(r.totales.base10, 140000);
});

Deno.test("totales: mixto 10 % / 5 % / exento", () => {
  const r = calcularTotales([
    item({ precioUnitario: 110000 }),
    item({ codigo: "B", precioUnitario: 105000, ivaTasa: 5 }),
    item({ codigo: "C", precioUnitario: 50000, ivaTasa: 0, ivaAfectacion: 3 }),
  ]);
  assertEquals(r.totales, {
    total: 265000, totalIva: 15000, iva10: 10000, iva5: 5000, base10: 100000, base5: 100000,
    gravado10: 110000, gravado5: 105000, exento: 50000, exonerado: 0, descuentoTotal: 0,
  });
  assertEquals(r.campos.dTBasGraIVA, 200000);
  assertEquals(r.items[2].baseGravada, 0);
  assertEquals(r.items[2].proporcionIva, 0);
});

Deno.test("totales: autofactura sin IVA y validaciones", () => {
  const r = calcularTotales([item({ precioUnitario: 50000, cantidad: 2 })], 4);
  assertEquals(r.totales.total, 100000);
  assertEquals(r.totales.totalIva, 0);
  assertThrows(() => calcularTotales([]), Error, "al menos 1");
  assertThrows(() => calcularTotales([item({ cantidad: 0 })]), Error, "cantidad");
  assertThrows(() => calcularTotales([item({ precioUnitario: 0 })]), Error, "precio");
  assertThrows(() => calcularTotales([item({ precioUnitario: 100.5 })]), Error, "entero");
  assertThrows(() => calcularTotales([item({ descuentoUnitario: 129000 })]), Error, "descuento");
  assertThrows(() => calcularTotales([item({ ivaTasa: 0 })]), Error, "tasa");
  assertThrows(() => calcularTotales([item({ ivaAfectacion: 4 })]), Error, "parcial");
});

Deno.test("totales: formato numérico", () => {
  assertEquals(numXml(129000), "129000");
  assertEquals(numXml(117272.72727273), "117272.72727273");
  assertEquals(numXml(10.5), "10.5");
  assertEquals(numXml(0), "0");
  assertEquals(redondear(1.005, 2), 1.01);
  assertEquals(redondear(2.5), 3);
});
