// Paridad pantalla ↔ servidor: src/lib/mayorista.js (lo que ve Enrique) y validar.ts (lo que acepta la función)
// tienen que dar lo mismo con los mismos casos. Si alguien cambia una regla en un lado solo, esto falla.
import { assertEquals } from "jsr:@std/assert@1";
import { dvModulo11 } from "../_shared/sifen/cdc.ts";
import { validarPedido } from "./validar.ts";
import { cuerpoValido } from "./prueba_utiles.ts";
// @ts-ignore: módulo JS del front sin tipos
import * as front from "../../../src/lib/mayorista.js";

Deno.test("DV módulo 11: front (dvRuc) = cdc.ts (dvModulo11) para 3..8 dígitos", () => {
  for (let i = 0; i < 3000; i++) {
    const largo = 3 + (i % 6);
    let n = String(1 + (i * 7919) % 9);
    while (n.length < largo) n += String((i * 31 + n.length * 17) % 10);
    assertEquals(front.dvRuc(n), dvModulo11(n), `RUC ${n}`);
  }
});

/** Form de la pantalla → payload (armarPayload) → validarPedido del servidor. */
function form(extra: Record<string, unknown> = {}) {
  const c = cuerpoValido();
  const cli = c.cliente as Record<string, unknown>;
  const fis = c.fiscal as Record<string, unknown>;
  return {
    nombre: cli.nombre, telefono: cli.telefono, direccion: cli.direccion, referencia: "", ciudad: cli.ciudad,
    ruc: `${fis.ruc}-${fis.dv}`, razon_social: fis.razon_social, email: "",
    items: c.items, envio: "30.000", cobro: "contra_entrega", comprobante_ref: "",
    condicion: "contado", plazo_dias: "", anterior_al_corte: false, fecha_entrega: "", nota: "",
    ...extra,
  };
}

const CASOS: Array<[string, Record<string, unknown>]> = [
  ["válido", {}],
  ["DV mal", { ruc: "1234567-0" }],
  ["sin razón social", { razon_social: "" }],
  ["crédito sin plazo", { condicion: "credito" }],
  ["crédito 45 días", { condicion: "credito", plazo_dias: "45" }],
  ["crédito + transferencia", { condicion: "credito", plazo_dias: "30", cobro: "transferencia_anticipada", comprobante_ref: "ABC123" }],
  ["transferencia sin comprobante", { cobro: "transferencia_anticipada" }],
  ["transferencia con comprobante", { cobro: "transferencia_anticipada", comprobante_ref: "UENO-1" }],
  ["cantidad 0", { items: [{ variant_id: "gid://shopify/ProductVariant/1", cantidad: 0, precio_unitario: 1000 }] }],
  ["precio 0", { items: [{ variant_id: "gid://shopify/ProductVariant/1", cantidad: 1, precio_unitario: 0 }] }],
  ["sin ítems", { items: [] }],
  ["anterior sin fecha", { anterior_al_corte: true }],
  ["anterior futura", { anterior_al_corte: true, fecha_entrega: "2026-10-11" }],
  ["anterior ok", { anterior_al_corte: true, fecha_entrega: "2026-09-15" }],
  ["teléfono corto", { telefono: "0981" }],
];

Deno.test("mismo veredicto en la pantalla y en el servidor", () => {
  const ctx = { hoy: "2026-10-10", facturarDesde: null };
  for (const [nombre, extra] of CASOS) {
    const f = form(extra);
    const enPantalla = front.validarPedidoMayorista(f, ctx);
    const enServidor = validarPedido(front.armarPayload(f, "11111111-2222-4333-8444-555555555555"), ctx);
    assertEquals(enServidor.ok, enPantalla.ok, `caso "${nombre}": pantalla ${enPantalla.ok} / servidor ${enServidor.ok}`);
    if (enPantalla.ok && enServidor.ok) assertEquals(enServidor.total, enPantalla.total, `total "${nombre}"`);
  }
});
