// 12-10: pago anticipado con prioridad, sin descuento. Datos inventados (repo público).
import { assert, assertEquals, assertFalse } from "jsr:@std/assert@1";
import { claveOfertaPrioridad, leerConfigPagoPrioridad, motivoSinOfertaPrioridad, pedidoPagado, textoOfertaPrioridad } from "./pago_anticipado.ts";

const ON = { activo: true, alias: "alias@ejemplo.com", titular: "Voltra E.A.S." };

Deno.test("leerConfigPagoPrioridad: sin clave, rara, apagada o sin alias → apagada; titular por defecto", () => {
  for (const v of [null, "x", [], { activo: false, alias: "alias@ejemplo.com" }, { activo: true }, { activo: true, alias: "  " }, { activo: "true", alias: "a" }]) {
    assertEquals(leerConfigPagoPrioridad(v).activo, false, JSON.stringify(v));
  }
  assertEquals(leerConfigPagoPrioridad(ON), ON);
  assertEquals(leerConfigPagoPrioridad({ activo: true, alias: " alias@ejemplo.com " }), ON);
});

Deno.test("textoOfertaPrioridad: palabras del dueño, sin QR, sin descuento ni demoras inventadas", () => {
  const t = textoOfertaPrioridad(ON);
  assertEquals(
    t,
    "📦 ¡Tu pedido quedó confirmado!\nSi querés recibirlo antes, podés pagarlo ahora por transferencia y sale con prioridad en el primer despacho.\n💳 Alias: alias@ejemplo.com — Voltra E.A.S.\nSi preferís, pagás al recibir como siempre 👍",
  );
  assertFalse(/QR|descuento|menos|%|alta demanda|d[ií]as|garant|listo para salir/i.test(t));
  assertEquals(claveOfertaPrioridad(5550001), "prio:5550001");
});

Deno.test("pedidoPagado: PAGO_VERIFICADO, PAGADO, PAGADO_QR o Shopify paid; el resto no", () => {
  for (const tags of [["PAGO_VERIFICADO"], ["pagado"], ["PAGADO_QR"], "CONFIRMADO, PAGADO"]) assert(pedidoPagado({ tags }), JSON.stringify(tags));
  assert(pedidoPagado({ tags: [], raw: { financial_status: "paid" } }));
  assert(pedidoPagado({ tags: [], raw: { displayFinancialStatus: "PAID" } }));
  for (const tags of [[], ["OFERTA_PAGO_ANTICIPADO"], ["PAGO_ANTICIPADO_COMPROBANTE"], ["NO_PAGADO_X"]]) assertFalse(pedidoPagado({ tags }), JSON.stringify(tags));
  assertFalse(pedidoPagado({ tags: null, raw: { financial_status: "pending" } }));
});

Deno.test("motivoSinOfertaPrioridad: pagado, retiro, prueba, mayorista, cancelado, ya salió, comprobante u oferta vieja → no; WhatsApp sí", () => {
  const casos: Array<[Parameters<typeof motivoSinOfertaPrioridad>[0], string | null]> = [
    [{ tags: ["CONFIRMADO"] }, null],
    [{ tags: ["ORIGEN_WHATSAPP", "CONFIRMADO", "OFERTA_PAGO_ANTICIPADO"] }, null], // el vendedor lo pone al crearlo
    [{ tags: ["CONFIRMADO"], estado_envio: "EN_PREPARACION" }, null],
    [{ tags: ["CONFIRMADO", "PAGO_VERIFICADO"] }, "ya_pagado"],
    [{ tags: ["CONFIRMADO", "PAGADO"] }, "ya_pagado"],
    [{ tags: ["CONFIRMADO", "PAGADO_QR"] }, "ya_pagado"],
    [{ tags: ["CONFIRMADO"], raw: { financial_status: "paid" } }, "ya_pagado"],
    [{ tags: ["CONFIRMADO", "RETIRO_EN_CASA"] }, "retiro_en_casa"],
    [{ tags: ["PRUEBA_E2E"] }, "prueba_e2e"],
    [{ tags: ["MAYORISTA", "CONFIRMADO"] }, "mayorista"],
    [{ tags: ["SIN_MENSAJES"] }, "mayorista"],
    [{ tags: [], raw: { cancelled_at: "2026-10-12T10:00:00-03:00" } }, "cancelado"],
    [{ tags: [], estado_confirmacion: "cancelado_cliente" }, "cancelado"],
    [{ tags: [], estado_envio: "DESPACHADO" }, "envio_DESPACHADO"],
    [{ tags: [], estado_envio: "ENTREGADO" }, "envio_ENTREGADO"],
    [{ tags: ["CONFIRMADO"], raw: { fulfillment_status: "fulfilled" } }, "ya_preparado"], // ya despachado
    [{ tags: ["CONFIRMADO"], raw: { displayFulfillmentStatus: "FULFILLED" } }, "ya_preparado"],
    [{ tags: ["CONFIRMADO", "PAGO_ANTICIPADO_COMPROBANTE"] }, "comprobante_ya_recibido"],
    [{ tags: ["CONFIRMADO", "OFERTA_PAGO_ANTICIPADO"] }, "oferta_ya_enviada"], // web: la oferta vieja al confirmar
  ];
  for (const [p, esperado] of casos) assertEquals(motivoSinOfertaPrioridad(p), esperado, JSON.stringify(p));
});

Deno.test("seed_config_wa.sql: pago_prioridad apagado y sin alias (el alias va solo en la base)", async () => {
  const sql = await Deno.readTextFile(new URL("../../seed_config_wa.sql", import.meta.url));
  const json = (clave: string) => {
    const m = new RegExp(`\\('${clave}',\\s*'([^']*)'::jsonb\\)`).exec(sql);
    return m ? JSON.parse(m[1]) : undefined;
  };
  assertEquals(json("pago_prioridad"), { activo: false, alias: null, titular: "Voltra E.A.S." });
  assertEquals(leerConfigPagoPrioridad(json("pago_prioridad")).activo, false);
  // El descuento sigue apagado en la semilla (y ya no lo lee ningún código).
  assertEquals(json("pago_anticipado_descuento")?.activo, false);
  // La clave vieja pago_anticipado (con los datos de la cuenta en null) está en su propia semilla.
  assertEquals(json("pago_anticipado"), undefined);
});
