import { assert, assertEquals, assertMatch, assertNotEquals, assertThrows } from "@std/assert";
import { armarCdc, codigoSeguridad, dvDelCdc, dvModulo11, formatearCdcKude, validarCdc, validarRuc } from "./cdc.ts";

// Ejemplo oficial MT v150 §10.1: 01 44444401 7 001 001 0014528 2 20170125 1 587326098 + DV 8
const CDC_MT = "01444444017001001001452822017012515873260988";

Deno.test("cdc: DV módulo 11 del ejemplo oficial del MT = 8", () => {
  assertEquals(dvModulo11(CDC_MT.slice(0, 43)), 8);
  assert(validarCdc(CDC_MT));
  assertEquals(dvDelCdc(CDC_MT), "8");
});

Deno.test("cdc: armarCdc reproduce el ejemplo del MT", () => {
  const cdc = armarCdc({
    tipo: 1, ruc: "44444401", dv: "7", establecimiento: "001", punto: "001", numero: 14528,
    tipoContribuyente: 2, fechaEmision: "2017-01-25T09:35:17", tipoEmision: 1, codigoSeguridad: "587326098",
  });
  assertEquals(cdc, CDC_MT);
  assertEquals(cdc.length, 44);
  assertEquals(formatearCdcKude(cdc), "0144 4444 0170 0100 1001 4528 2201 7012 5158 7326 0988");
});

Deno.test("cdc: RUC corto se completa con ceros y DV de RUC", () => {
  assert(validarRuc("44444401", "7"));
  assert(!validarRuc("44444401", "6"));
  assert(validarRuc("88899990", "9"));
  const ruc = "1234567";
  const dv = String(dvModulo11(ruc));
  const cdc = armarCdc({ tipo: 5, ruc, dv, establecimiento: "002", punto: "003", numero: 7, tipoContribuyente: 1,
    fechaEmision: "2026-10-08T00:00:00", tipoEmision: 1, codigoSeguridad: "000000123" });
  assertEquals(cdc.slice(0, 11), "05" + "01234567" + dv);
  assert(validarCdc(cdc));
});

Deno.test("cdc: letras del RUC se convierten a ASCII para el DV", () => {
  assertEquals(dvModulo11("1234567A"), dvModulo11("123456765"));
});

Deno.test("cdc: errores claros", () => {
  assertThrows(() => armarCdc({ tipo: 1, ruc: "44444401", dv: "3", establecimiento: "001", punto: "001", numero: 1,
    tipoContribuyente: 2, fechaEmision: "2026-10-08", tipoEmision: 1, codigoSeguridad: "123456789" }), Error, "DV");
  assertThrows(() => armarCdc({ tipo: 1, ruc: "44444401", dv: "7", establecimiento: "1", punto: "001", numero: 1,
    tipoContribuyente: 2, fechaEmision: "2026-10-08", tipoEmision: 1, codigoSeguridad: "123456789" }), Error, "establecimiento");
  assert(!validarCdc(CDC_MT.slice(0, 43) + "7"));
});

Deno.test("cdc: codigoSeguridad 9 dígitos aleatorio y distinto al número", () => {
  const vistos = new Set<string>();
  for (let i = 0; i < 200; i++) {
    const c = codigoSeguridad(5);
    assertMatch(c, /^\d{9}$/);
    assertNotEquals(c, "000000000");
    assertNotEquals(c, "000000005");
    vistos.add(c);
  }
  assert(vistos.size > 195);
});
