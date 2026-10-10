// Tests de validar.ts. Datos inventados (repo público): RUC de prueba con DV calculado, no de personas reales.
import { assert, assertEquals } from "jsr:@std/assert@1";
import { dvModulo11 } from "../_shared/sifen/cdc.ts";
import { rucValido, validarPedido } from "./validar.ts";
import { cuerpoValido, DV, RUC } from "./prueba_utiles.ts";

const CTX = { hoy: "2026-10-10", facturarDesde: null as string | null };

Deno.test("RUC: DV módulo 11 de cdc.ts, solo dígitos 3 a 8", () => {
  assert(rucValido(RUC, DV));
  assert(!rucValido(RUC, String((Number(DV) + 1) % 10)));
  assert(!rucValido("012345", String(dvModulo11("012345"))), "no empieza con 0");
  assert(!rucValido("12", String(dvModulo11("12"))), "mínimo 3 dígitos");
  assert(!rucValido("123456789", String(dvModulo11("123456789"))), "máximo 8 dígitos");
  assert(!rucValido("1234A", "1"), "sin letras (la cola de facturas no las acepta)");
});

Deno.test("pedido válido: total = Σ cantidad × precio + envío", () => {
  const r = validarPedido(cuerpoValido(), CTX);
  assert(r.ok);
  if (r.ok) {
    assertEquals(r.total, 10 * 50000 + 30000);
    assertEquals(r.pedido.condicion, "contado");
    assertEquals(r.pedido.plazo_dias, null);
  }
});

Deno.test("rechaza: RUC con DV mal, sin razón social, ítem en 0, precio 0, cobro raro", () => {
  const r = validarPedido(cuerpoValido({
    fiscal: { ruc: RUC, dv: String((Number(DV) + 1) % 10), razon_social: " ", email: "no-es-mail" },
    items: [{ variant_id: "gid://shopify/ProductVariant/1", cantidad: 0, precio_unitario: 1000 }],
    cobro: "efectivo",
  }), CTX);
  assert(!r.ok);
  if (!r.ok) {
    assert(r.errores.ruc && r.errores.razon_social && r.errores.email && r.errores.items && r.errores.cobro);
  }
  const r2 = validarPedido(cuerpoValido({ items: [{ variant_id: "gid://shopify/ProductVariant/1", cantidad: 2, precio_unitario: 0 }] }), CTX);
  assert(!r2.ok && r2.errores.items.includes("precio"));
  const r3 = validarPedido(cuerpoValido({ items: [{ variant_id: "111", cantidad: 2, precio_unitario: 10 }] }), CTX);
  assert(!r3.ok && r3.errores.items.includes("variante"));
  const r4 = validarPedido(cuerpoValido({ items: [{ variant_id: "gid://shopify/ProductVariant/1", cantidad: 1.5, precio_unitario: 10 }] }), CTX);
  assert(!r4.ok, "cantidad con decimales");
});

Deno.test("crédito: plazo 1..365 obligatorio y no con transferencia anticipada", () => {
  assert(!validarPedido(cuerpoValido({ condicion: "credito" }), CTX).ok);
  assert(!validarPedido(cuerpoValido({ condicion: "credito", plazo_dias: 400 }), CTX).ok);
  const ok = validarPedido(cuerpoValido({ condicion: "credito", plazo_dias: 30 }), CTX);
  assert(ok.ok && ok.pedido.plazo_dias === 30);
  const t = validarPedido(cuerpoValido({ condicion: "credito", plazo_dias: 30, cobro: "transferencia_anticipada", comprobante_ref: "ABC123" }), CTX);
  assert(!t.ok && !!t.errores.condicion);
  assert(!validarPedido(cuerpoValido({ condicion: "a_cuenta" }), CTX).ok);
});

Deno.test("transferencia anticipada exige comprobante (salvo anterior al corte)", () => {
  assert(!validarPedido(cuerpoValido({ cobro: "transferencia_anticipada" }), CTX).ok);
  assert(validarPedido(cuerpoValido({ cobro: "transferencia_anticipada", comprobante_ref: "UENO-123" }), CTX).ok);
  assert(validarPedido(cuerpoValido({ cobro: "transferencia_anticipada", anterior_al_corte: true, fecha_entrega: "2026-09-20" }), CTX).ok);
});

Deno.test("anterior al corte: fecha real, no futura, y antes del corte si hay corte", () => {
  assert(!validarPedido(cuerpoValido({ anterior_al_corte: true }), CTX).ok);
  assert(!validarPedido(cuerpoValido({ anterior_al_corte: true, fecha_entrega: "2026-02-30" }), CTX).ok);
  assert(!validarPedido(cuerpoValido({ anterior_al_corte: true, fecha_entrega: "2026-10-11" }), CTX).ok);
  assert(validarPedido(cuerpoValido({ anterior_al_corte: true, fecha_entrega: "2026-10-01" }), CTX).ok);
  const conCorte = { hoy: "2026-10-10", facturarDesde: "2026-10-05T00:00:00-03:00" };
  assert(validarPedido(cuerpoValido({ anterior_al_corte: true, fecha_entrega: "2026-10-04" }), conCorte).ok);
  const r = validarPedido(cuerpoValido({ anterior_al_corte: true, fecha_entrega: "2026-10-06" }), conCorte);
  assert(!r.ok && r.errores.fecha_entrega.includes("corte"));
});

Deno.test("sin clave de idempotencia → error", () => {
  assert(!validarPedido(cuerpoValido({ clave_idempotencia: "" }), CTX).ok);
  assert(!validarPedido(cuerpoValido({ clave_idempotencia: "x; drop" }), CTX).ok);
});
