// Tests de desde_pedido.ts · datos FICTICIOS (nada real: repo público).
import { assert, assertEquals } from "jsr:@std/assert@1";
import { digitoVerificadorRuc } from "../facturacion.ts";
import {
  CONFIG_DESDE_PEDIDO_DEFECTO as CFG,
  codigoSeguridadAleatorio,
  documentoDesdePedido,
  esDevuelto,
  esFacturable,
  fechaSifen,
  motivoNoFacturable,
  notaCreditoDesdeFactura,
  type PedidoSifen,
  rucDesdeTexto,
  sumaItems,
} from "./desde_pedido.ts";

const BASE = { numero: 7, fechaEmision: "2026-10-08T10:00:00", codigoSeguridad: "123456789" };
const envio = (precio = "33000") => [{ title: "Envío", price: precio }];

function pedido(raw: Record<string, unknown>, over: Partial<PedidoSifen> = {}): PedidoSifen {
  return { shopify_order_id: 5001, nombre: "#9001", total: null, estado_envio: "ENTREGADO", tags: [], raw, ...over };
}
const rucValido = (base: string) => `${base}-${digitoVerificadorRuc(base)}`;

Deno.test("consumidor final: innominado, producto + envío como ítem aparte, suma = total_price", () => {
  const r = documentoDesdePedido(pedido({
    total_price: "162000",
    line_items: [{ title: "Producto A", quantity: 1, price: "129000", sku: "" }],
    shipping_lines: envio(),
  }), CFG, BASE);
  assert(r.ok);
  assertEquals(r.doc.receptor.tipo, "innominado");
  assertEquals(r.doc.items.length, 2);
  assertEquals(r.doc.items[1], { codigo: "ENVIO", descripcion: "Envío a domicilio", cantidad: 1, precioUnitario: 33000, ivaTasa: 10, ivaAfectacion: 1, unidadMedida: 77 });
  assertEquals(sumaItems(r.doc.items), 162000);
  assertEquals(r.doc.condicion, { tipo: 1, pagos: [{ tipo: 1, monto: 162000 }] });
  assertEquals(r.doc.tipoEmision, 1);
  assertEquals(r.doc.numero, 7);
});

Deno.test("cliente con RUC (Releasit: atributos Ruc y Razon social separados, sin guion) → receptor 'ruc'", () => {
  const ruc = rucValido("4567891");
  const r = documentoDesdePedido(pedido({
    total_price: "129000",
    note_attributes: [{ name: "Ruc", value: ruc.replace("-", "") }, { name: "Razon social", value: "Comercial Ficticia" }],
    line_items: [{ title: "Producto A", quantity: 1, price: "129000" }],
  }), CFG, BASE);
  assert(r.ok);
  assertEquals(r.doc.receptor.tipo, "ruc");
  assertEquals(`${r.doc.receptor.ruc}-${r.doc.receptor.dv}`, ruc);
  assertEquals(r.doc.receptor.razonSocial, "Comercial Ficticia");
  assertEquals(r.avisos, []);
});

Deno.test("vendedor IA: atributo factura 'RUC-DV Nombre' y nota 'Factura: …'", () => {
  const ruc = rucValido("80012345");
  const a = documentoDesdePedido(pedido({ total_price: "1000", note_attributes: [{ name: "factura", value: `${ruc} Empresa Inventada SA` }], line_items: [{ title: "X", quantity: 1, price: "1000" }] }), CFG, BASE);
  assert(a.ok && a.doc.receptor.tipo === "ruc" && a.doc.receptor.razonSocial === "Empresa Inventada SA");
  const b = documentoDesdePedido(pedido({ total_price: "1000", note: `Pedido por WhatsApp\nFactura: ${ruc} Otra Empresa`, line_items: [{ title: "X", quantity: 1, price: "1000" }] }), CFG, BASE);
  assert(b.ok && b.doc.receptor.tipo === "ruc" && b.doc.receptor.razonSocial === "Otra Empresa");
});

Deno.test("RUC inválido → consumidor final + aviso (no se frena la factura); 'no' = no quiere factura, sin aviso", () => {
  const malo = `4567891-${(digitoVerificadorRuc("4567891") + 1) % 10}`;
  const r = documentoDesdePedido(pedido({ total_price: "1000", note_attributes: [{ name: "Ruc", value: malo }, { name: "Razon social", value: "Ana" }], line_items: [{ title: "X", quantity: 1, price: "1000" }] }), CFG, BASE);
  assert(r.ok);
  assertEquals(r.doc.receptor.tipo, "innominado");
  assertEquals(r.avisos.length, 1);
  const no = documentoDesdePedido(pedido({ total_price: "1000", note_attributes: [{ name: "Ruc", value: "no" }, { name: "Razon social", value: "no" }], line_items: [{ title: "X", quantity: 1, price: "1000" }] }), CFG, BASE);
  assert(no.ok);
  assertEquals(no.doc.receptor.tipo, "innominado");
  assertEquals(no.avisos, []);
  assertEquals(rucDesdeTexto("1.234.567-" + digitoVerificadorRuc("1234567")), { ruc: "1234567", dv: String(digitoVerificadorRuc("1234567")) });
});

Deno.test("cédula + nombre → receptor 'documento'", () => {
  const r = documentoDesdePedido(pedido({ total_price: "1000", note_attributes: [{ name: "Cédula", value: "1.234.567" }], shipping_address: { name: "Ana Prueba" }, line_items: [{ title: "X", quantity: 1, price: "1000" }] }), CFG, BASE);
  assert(r.ok);
  assertEquals(r.doc.receptor, { tipo: "documento", documentoTipo: 1, documentoNumero: "1234567", nombre: "Ana Prueba", pais: "PRY", email: undefined });
});

Deno.test("pedido ×3 con upsell: oferta en el precio, upsell como otro line_item, envío aparte", () => {
  const r = documentoDesdePedido(pedido({
    total_price: "312000",
    line_items: [
      { title: "Producto A", variant_title: "Pack x3", quantity: 1, price: "249000", product_id: 11 },
      { title: "Producto B (upsell)", quantity: 1, price: "30000", product_id: 12 },
    ],
    shipping_lines: envio(),
  }), CFG, BASE);
  assert(r.ok);
  assertEquals(r.doc.items.map((i) => [i.codigo, i.descripcion, i.cantidad, i.precioUnitario]), [
    ["P11", "Producto A (Pack x3)", 1, 249000],
    ["P12", "Producto B (upsell)", 1, 30000],
    ["ENVIO", "Envío a domicilio", 1, 33000],
  ]);
  assertEquals(sumaItems(r.doc.items), 312000);
});

Deno.test("downsell / pack ×2 con descuento SOLO en discount_allocations (Releasit)", () => {
  const r = documentoDesdePedido(pedido({
    total_price: "232000",
    line_items: [{ title: "Producto A", quantity: 2, price: "129000", total_discount: "0", discount_allocations: [{ amount: "59000" }] }],
    shipping_lines: envio(),
  }), CFG, BASE);
  assert(r.ok);
  // 59.000 / 2 no es entero → la línea se parte: 1 u. con 29.500 de descuento… 59000/2 = 29500 sí es entero.
  assertEquals(r.doc.items[0].descuentoUnitario, 29500);
  assertEquals(sumaItems(r.doc.items), 232000);
  // Descuento que no divide exacto: 3 u., 10.001 Gs → 2 u. con 3.333 y 1 u. con 3.335.
  const x = documentoDesdePedido(pedido({ total_price: "289999", line_items: [{ title: "P", quantity: 3, price: "100000", discount_allocations: [{ amount: "10001" }] }] }), CFG, BASE);
  assert(x.ok);
  assertEquals(x.doc.items.map((i) => [i.cantidad, i.descuentoUnitario]), [[2, 3333], [1, 3335]]);
});

Deno.test("multi-producto: 2 productos + envío + descuento; 3 productos + envío + descuento (IVA 10 %, totales = total_price)", () => {
  const dos = documentoDesdePedido(pedido({
    total_price: "250000",
    line_items: [
      { title: "Producto A", quantity: 1, price: "129000", discount_allocations: [{ amount: "10000" }] },
      { title: "Producto B", quantity: 1, price: "98000" },
    ],
    shipping_lines: envio(),
  }), CFG, BASE);
  assert(dos.ok);
  assertEquals(dos.doc.items.length, 3);
  assert(dos.doc.items.every((i) => i.ivaTasa === 10 && i.ivaAfectacion === 1));
  assertEquals(sumaItems(dos.doc.items), 250000);

  const tres = documentoDesdePedido(pedido({
    total_price: "349000",
    line_items: [
      { title: "Producto A", quantity: 2, price: "100000", discount_allocations: [{ amount: "20000" }, { amount: "4000" }] },
      { title: "Producto B", quantity: 1, price: "90000" },
      { title: "Producto C", quantity: 1, price: "50000", discount_allocations: [{ amount: "0" }] },
    ],
    shipping_lines: envio(),
  }), CFG, BASE);
  assert(tres.ok);
  assertEquals(tres.doc.items.length, 4);
  assertEquals(tres.doc.items[0].descuentoUnitario, 12000);
  assertEquals(sumaItems(tres.doc.items), 349000);
});

Deno.test("suma que no cuadra → ok:false (a revisar), nunca emitir mal", () => {
  const r = documentoDesdePedido(pedido({ total_price: "200000", line_items: [{ title: "X", quantity: 1, price: "129000" }], shipping_lines: envio() }), CFG, BASE);
  assert(!r.ok);
  assert(r.motivo.includes("no coincide"));
});

Deno.test("Shopify sumó IVA encima (taxes_included=false, total_tax>0) → revisar", () => {
  const r = documentoDesdePedido(pedido({ total_price: "137900", taxes_included: false, total_tax: "7900", line_items: [{ title: "X", quantity: 1, price: "129000" }] }), CFG, BASE);
  assert(!r.ok);
  assert(r.motivo.includes("impuestos"));
});

Deno.test("innominado ≥ Gs 7.000.000 (NT-024) → revisar", () => {
  const r = documentoDesdePedido(pedido({ total_price: "7000000", line_items: [{ title: "X", quantity: 1, price: "7000000" }] }), CFG, BASE);
  assert(!r.ok);
});

Deno.test("envío todo-incluido (modo separar_del_total): se separa 33.000 del producto", () => {
  const r = documentoDesdePedido(pedido({ total_price: "129000", line_items: [{ title: "X", quantity: 1, price: "129000" }] }), { ...CFG, envio_modo: "separar_del_total" }, BASE);
  assert(r.ok);
  assertEquals(r.doc.items.map((i) => i.precioUnitario - (i.descuentoUnitario ?? 0)), [96000, 33000]);
});

Deno.test("pagado por QR: forma de pago transferencia/billetera", () => {
  const r = documentoDesdePedido(pedido({ total_price: "1000", line_items: [{ title: "X", quantity: 1, price: "1000" }] }, { tags: ["PAGADO_QR"] }), CFG, BASE);
  assert(r.ok);
  assertEquals(r.doc.condicion?.pagos[0].tipo, CFG.pago_tipo_qr);
});

Deno.test("facturable / devuelto / filtros de cancelados, borradores y pruebas", () => {
  assert(esFacturable("ENTREGADO") && esFacturable("RENDIDO"));
  assert(!esFacturable("NO_ENTREGADO") && !esFacturable("DESPACHADO"));
  assert(esDevuelto("NO_ENTREGADO") && esDevuelto("CANCELADO"));
  assertEquals(motivoNoFacturable(pedido({})), null);
  assert(motivoNoFacturable(pedido({ cancelled_at: "2026-10-01T00:00:00Z" })));
  assert(motivoNoFacturable(pedido({ test: true })));
  assert(motivoNoFacturable(pedido({}, { tags: ["PRUEBA_E2E"] })));
  assert(motivoNoFacturable(pedido({}, { es_borrador: true })));
  assert(motivoNoFacturable(pedido({}, { estado_confirmacion: "cancelado_cliente" })));
});

Deno.test("NC por el total asociada por CDC, mismo receptor y sin condición", () => {
  const fe = documentoDesdePedido(pedido({ total_price: "1000", line_items: [{ title: "X", quantity: 1, price: "1000" }] }), CFG, BASE);
  assert(fe.ok);
  const nc = notaCreditoDesdeFactura(fe.doc, "0".repeat(44), { ...BASE, numero: 1 });
  assertEquals(nc.tipo, 5);
  assertEquals(nc.asociado, { tipo: 1, cdc: "0".repeat(44) });
  assertEquals(nc.motivoNota, 2);
  assertEquals(nc.condicion, undefined);
  assertEquals(nc.receptor, fe.doc.receptor);
});

Deno.test("fecha en hora de Asunción y código de seguridad de 9 dígitos", () => {
  assertEquals(fechaSifen(new Date("2026-10-08T15:30:00Z")), "2026-10-08T12:30:00");
  let i = 0;
  const seq = [0, 0.000000001, 0.5];
  assertEquals(codigoSeguridadAleatorio(() => seq[i++]), "000000001");
  assert(/^\d{9}$/.test(codigoSeguridadAleatorio()));
});

// ─── 10-10: medio de pago PAGO_VERIFICADO y pedido_datos_fiscales (P2) — datos INVENTADOS ───

const rawMayorista = (extra: Record<string, unknown> = {}) => ({
  total_price: "112000",
  line_items: [{ title: "Producto inventado", quantity: 1, price: "79000" }],
  shipping_lines: envio(),
  ...extra,
});

Deno.test("PAGO_VERIFICADO (transferencia anticipada) → iTiPago 5; PAGADO_QR gana; sin etiqueta → 1 efectivo", () => {
  const pago = (tags: string[]) => {
    const r = documentoDesdePedido(pedido(rawMayorista(), { tags }), CFG, BASE);
    assert(r.ok);
    return r.doc.condicion;
  };
  assertEquals(pago(["PAGO_VERIFICADO"]), { tipo: 1, pagos: [{ tipo: 5, monto: 112000 }] });
  assertEquals(pago(["PAGO_VERIFICADO", "PAGADO_QR"])?.pagos[0].tipo, CFG.pago_tipo_qr);
  assertEquals(pago([])?.pagos[0].tipo, 1);
});

Deno.test("pedido_datos_fiscales manda sobre los atributos: receptor 'ruc' de la tabla aunque el pedido diga otro RUC", () => {
  const r = documentoDesdePedido(pedido(
    rawMayorista({ note_attributes: [{ name: "Ruc", value: rucValido("80011111") }, { name: "Razon social", value: "Atributo SA" }] }),
    { datos_fiscales: { ruc: "80022222", dv: String(digitoVerificadorRuc("80022222")), razon_social: "Mayorista Inventado SRL", email: "compras@example.com", condicion: "contado", origen: "mayorista" } },
  ), CFG, BASE);
  assert(r.ok);
  assertEquals([r.doc.receptor.tipo, r.doc.receptor.ruc, r.doc.receptor.razonSocial, r.doc.receptor.email], ["ruc", "80022222", "Mayorista Inventado SRL", "compras@example.com"]);
  assertEquals(r.doc.condicion?.tipo, 1);
  // RUC "base-DV" en la columna ruc y dv vacío también vale.
  const r2 = documentoDesdePedido(pedido(rawMayorista(), { datos_fiscales: { ruc: rucValido("80033333"), dv: null, razon_social: "Otra Inventada SA" } }), CFG, BASE);
  assert(r2.ok && r2.doc.receptor.ruc === "80033333");
});

Deno.test("pedido_datos_fiscales con RUC inválido / vacío / sin razón social → 'revisar' (nunca consumidor final silencioso)", () => {
  const dvMalo = String((digitoVerificadorRuc("80022222") + 1) % 10);
  for (const df of [
    { ruc: "80022222", dv: dvMalo, razon_social: "Mayorista Inventado SRL" },
    { ruc: null, dv: null, razon_social: "Mayorista Inventado SRL" },
    { ruc: "80022222", dv: String(digitoVerificadorRuc("80022222")), razon_social: "  " },
  ]) {
    const r = documentoDesdePedido(pedido(rawMayorista(), { datos_fiscales: df }), CFG, BASE);
    assert(!r.ok, JSON.stringify(df));
    assert(/RUC inválido|razón social/.test(r.motivo), r.motivo);
  }
});

Deno.test("crédito con plazo_dias (tabla o atributos del pedido mayorista) → iCondOpe 2, sin pagos, plazo 'N días'; sin plazo → revisar", () => {
  const df = { ruc: "80022222", dv: String(digitoVerificadorRuc("80022222")), razon_social: "Mayorista Inventado SRL", condicion: "credito", plazo_dias: 30 };
  const r = documentoDesdePedido(pedido(rawMayorista(), { datos_fiscales: df, tags: ["MAYORISTA"] }), CFG, BASE);
  assert(r.ok);
  assertEquals(r.doc.condicion as unknown, { tipo: 2, pagos: [], plazoCredito: "30 días" });
  assertEquals(r.total, 112000);
  // Sin fila: atributos "condicion"/"plazo_dias" del pedido creado en Shopify.
  const attrs = [{ name: "Ruc", value: rucValido("80022222") }, { name: "Razon social", value: "Mayorista Inventado SRL" }, { name: "condicion", value: "credito" }, { name: "plazo_dias", value: "15" }];
  const r2 = documentoDesdePedido(pedido(rawMayorista({ note_attributes: attrs })), CFG, BASE);
  assert(r2.ok);
  assertEquals(r2.doc.condicion as unknown, { tipo: 2, pagos: [], plazoCredito: "15 días" });
  // Crédito sin plazo / plazo absurdo / condición rara / crédito a innominado → revisar.
  for (const over of [{ plazo_dias: null }, { plazo_dias: 0 }, { plazo_dias: 9999 }, { condicion: "canje" }]) {
    const x = documentoDesdePedido(pedido(rawMayorista(), { datos_fiscales: { ...df, ...over } }), CFG, BASE);
    assert(!x.ok, JSON.stringify(over));
  }
  const innom = documentoDesdePedido(pedido(rawMayorista({ note_attributes: [{ name: "condicion", value: "credito" }, { name: "plazo_dias", value: "30" }] })), CFG, BASE);
  assert(!innom.ok && innom.motivo.includes("crédito"));
});
