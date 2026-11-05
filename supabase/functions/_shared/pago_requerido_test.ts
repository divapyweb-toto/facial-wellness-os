// 05-11: pago anticipado obligatorio (_shared/pago_anticipado.ts): config, texto y cuándo se exige. Datos inventados.
import { assert, assertEquals, assertFalse } from "jsr:@std/assert@1";
import { exigePagoRequerido, idCandadoPagoRequerido, leerConfigPagoRequerido, montoGs, textoPagoRequerido } from "./pago_anticipado.ts";

Deno.test("leerConfigPagoRequerido: apagado por defecto; min_devoluciones 1 si falta o es raro", () => {
  for (const v of [null, undefined, {}, { activo: true }, { requerido: null }, "x"]) {
    assertEquals(leerConfigPagoRequerido(v), { activo: false, min_devoluciones: 1 }, JSON.stringify(v));
  }
  assertEquals(leerConfigPagoRequerido({ texto_recibido: "x", requerido: { activo: true } }), { activo: true, min_devoluciones: 1 });
  assertEquals(leerConfigPagoRequerido({ requerido: { activo: true, min_devoluciones: 2 } }), { activo: true, min_devoluciones: 2 });
  assertEquals(leerConfigPagoRequerido({ requerido: { activo: "true", min_devoluciones: 0 } }), { activo: false, min_devoluciones: 1 });
});

Deno.test("textoPagoRequerido: palabras del dueño, con pedido, total y cuenta; nunca menciona devoluciones", () => {
  const t = textoPagoRequerido({ alias: "alias@ejemplo.com", titular: "Empresa Prueba" }, { pedido: "#9001", total: "129.000" });
  assertEquals(t, "📦 ¡Tu pedido #9001 quedó confirmado! Esta vez te pedimos pagarlo por adelantado por transferencia (Gs 129.000) y sale en el primer despacho.\n" +
    "💳 Transferí a: alias@ejemplo.com — Empresa Prueba\nMandanos la foto del comprobante por acá 🙌");
  assertFalse(/devol|no entreg|rechaz/i.test(t));
  assertEquals(idCandadoPagoRequerido(9001), "auto_pago_requerido:9001");
  assertEquals(montoGs("1290000"), "1.290.000");
  assertEquals(montoGs(null), null);
});

Deno.test("exigePagoRequerido: solo prendido, con total, sin SIN_COBERTURA / retiro / ya exigido y con devoluciones >= mínimo", () => {
  const on = { activo: true, min_devoluciones: 1 };
  const p = { tags: ["CONFIRMADO"], total: 129000 };
  assert(exigePagoRequerido(on, 1, p));
  assertFalse(exigePagoRequerido({ ...on, activo: false }, 3, p));
  assertFalse(exigePagoRequerido(on, 0, p));
  assertFalse(exigePagoRequerido(on, null, p));
  assertFalse(exigePagoRequerido({ activo: true, min_devoluciones: 2 }, 1, p));
  assert(exigePagoRequerido({ activo: true, min_devoluciones: 2 }, 2, p));
  for (const tags of [["SIN_COBERTURA"], ["RETIRO_EN_CASA"], ["PAGO_ANTICIPADO_REQUERIDO"]]) assertFalse(exigePagoRequerido(on, 2, { ...p, tags }), tags[0]);
  assertFalse(exigePagoRequerido(on, 2, { ...p, total: null }));
});
