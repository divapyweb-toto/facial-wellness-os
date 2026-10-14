// 14-10: formato nuevo de Releasit (×2/×3 con envío 0, ×3 con descuento fijo 49.000, mixto pack + 1). Datos inventados.
// Factura (SIFEN) + valor a Meta (Lead / Purchase / PedidoEntregado) + total del webhook.
import { assert, assertEquals } from "jsr:@std/assert@1";
import { CONFIG_DESDE_PEDIDO_DEFECTO as CFG, documentoDesdePedido, sumaItems, type PedidoSifen } from "./desde_pedido.ts";
import { armarPayloadLead } from "../meta_capi.ts";
import { normalizarDesdeWebhook } from "../../shopify-webhook/procesar.ts";

const BASE = { numero: 7, fechaEmision: "2026-10-14T18:00:00", codigoSeguridad: "123456789" };
const RASP = { title: "Raspador de Lengua", price: "79000" };
const PACK = { title: "Pack GUDAIR", price: "120000" };

function raw(lineas: Array<{ title: string; price: string; quantity: number }>, o: { envio?: number; descuento?: number } = {}) {
  const bruto = lineas.reduce((s, l) => s + Number(l.price) * l.quantity, 0);
  const total = bruto - (o.descuento ?? 0) + (o.envio ?? 0);
  return {
    id: 777, name: "#9902", created_at: "2026-10-14T21:00:00Z", total_price: String(total), subtotal_price: String(bruto - (o.descuento ?? 0)),
    total_discounts: String(o.descuento ?? 0), taxes_included: true, total_tax: "0", tags: "CONFIRMADO", financial_status: "pending",
    shipping_lines: [{ title: o.envio ? "Envío a todo Paraguay" : "Envio GRATIS", price: String(o.envio ?? 0) }],
    shipping_address: { name: "Cliente Prueba", city: "Asunción", address1: "Calle Inventada 1", phone: "0981000000" },
    line_items: lineas.map((l, i) => ({ ...l, discount_allocations: o.descuento && i === 0 ? [{ amount: String(o.descuento) }] : [] })),
  };
}
const ped = (r: Record<string, unknown>): PedidoSifen => ({ shopify_order_id: 777, nombre: "#9902", total: null, estado_envio: "ENTREGADO", tags: [], raw: r });

const casos: Array<[string, Record<string, unknown>, number]> = [
  ["x2 nuevo", raw([{ ...RASP, quantity: 2 }]), 158000],
  ["x3 nuevo", raw([{ ...RASP, quantity: 3 }], { descuento: 49000 }), 188000],
  ["mixto pack + 1", raw([{ ...PACK, quantity: 1 }, { ...RASP, quantity: 1 }]), 199000],
  ["x2 viejo (control)", raw([{ ...RASP, quantity: 2 }], { descuento: 33000, envio: 33000 }), 158000],
];

Deno.test("SIFEN: envío 0 no agrega línea de envío, el descuento se reparte en enteros y la suma = total cobrado", () => {
  for (const [nombre, r, total] of casos) {
    const res = documentoDesdePedido(ped(r), CFG, BASE);
    assert(res.ok, `${nombre}: ${!res.ok ? res.motivo : ""}`);
    if (!res.ok) continue;
    const items = res.doc.items;
    assertEquals(sumaItems(items), total, nombre);
    const envio = items.filter((i) => i.codigo === CFG.envio_codigo);
    if (nombre.includes("viejo")) assertEquals(envio.length, 1, `${nombre}: envío cobrado como ítem`);
    else assertEquals(envio.length, 0, `${nombre}: sin ítem de envío en 0`);
    for (const i of items) {
      assert(i.precioUnitario > 0, `${nombre}: precio > 0`);
      assert(Number.isInteger(i.descuentoUnitario ?? 0), `${nombre}: descuento entero`);
    }
  }
});

Deno.test("Meta: el valor del evento es el total cobrado (158.000 / 188.000 / 199.000)", () => {
  for (const [nombre, r, total] of casos) {
    const n = normalizarDesdeWebhook("orders/create", r);
    assertEquals(n.total, total, `${nombre}: total del webhook`);
    const p = armarPayloadLead({ shopify_order_id: 777, valor: n.total ?? 0, moneda: "PYG", ctwa_clid: "clid-inventado", evento: "Purchase" }, { ahora: new Date("2026-10-14T21:05:00Z"), wabaId: "w" });
    assertEquals((p!.data as Array<{ custom_data: { value: number } }>)[0].custom_data.value, total, `${nombre}: value a Meta`);
  }
});
