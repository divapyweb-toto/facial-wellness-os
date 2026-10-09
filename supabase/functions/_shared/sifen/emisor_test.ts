// Integración en MODO SIMULADO con los módulos REALES de B (xml/qr/xsd/eventos), C (firma/certificado) y D (kude):
// solo SIFEN (la red) es un doble. Datos inventados.
import { assert, assertEquals } from "jsr:@std/assert@1";
import { credencialesDesdeEnv, crearEmisorPropioDesdeEntorno, emisorDesdeConfig, nombreEmisor } from "./emisor.ts";
import { CONFIG_DESDE_PEDIDO_DEFECTO, documentoDesdePedido, notaCreditoDesdeFactura } from "./desde_pedido.ts";
import { crearEmisorFacturaSend, pedidoFacturaDesdeDoc } from "./emisor_facturasend.ts";
import { digitoVerificadorRuc } from "../facturacion.ts";

const envSim = (n: string) => ({ MODO_SIMULADO: "1" } as Record<string, string>)[n];
const BASE = { numero: 1, fechaEmision: "2026-10-08T10:00:00", codigoSeguridad: "123456789" };

Deno.test("credenciales: sin secretos → simulado y test; prod sin autorización → simulado", () => {
  assertEquals(credencialesDesdeEnv(() => undefined).simulado, true);
  const e = credencialesDesdeEnv((n) => ({
    SIFEN_AMBIENTE: "prod", SIFEN_CERT_P12_BASE64: "AA==", SIFEN_CERT_CLAVE: "x", SIFEN_TIMBRADO: "12345678",
    SIFEN_TIMBRADO_INICIO: "2026-01-01", SIFEN_CSC: "C",
  } as Record<string, string>)[n]);
  assertEquals([e.simulado, e.cred.ambiente], [true, "test"]);
  assert(e.motivo?.includes("PRODUCCION_AUTORIZADA"));
  assertEquals(nombreEmisor("facturasend"), "facturasend");
  assertEquals(nombreEmisor(undefined), "propio");
});

Deno.test("simulado con módulos reales: FE innominada y con RUC aprobadas, XML firmado con QR, KuDE PDF; NC asociada; eventos", async () => {
  const r = await crearEmisorPropioDesdeEntorno({ env: envSim });
  assertEquals(r.simulado, true);
  assertEquals(r.modulosSimulados, []); // B, C y D presentes: solo la red es simulada
  const em = r.emisor;
  const ped = {
    shopify_order_id: 1, nombre: "#1", total: 250000, estado_envio: "ENTREGADO", tags: [],
    raw: {
      total_price: "250000",
      line_items: [{ title: "Producto A", quantity: 1, price: "129000", discount_allocations: [{ amount: "10000" }] }, { title: "Producto B", quantity: 1, price: "98000" }],
      shipping_lines: [{ price: "33000" }],
    },
  };
  const d1 = documentoDesdePedido(ped, CONFIG_DESDE_PEDIDO_DEFECTO, BASE);
  assert(d1.ok);
  const fe = await em.emitir(d1.doc);
  assertEquals(fe.estado, "aprobada", fe.mensaje);
  assert(/^\d{44}$/.test(fe.cdc!));
  assert(fe.xmlFirmado!.includes("<Signature") && fe.xmlFirmado!.includes("dCarQR"));
  assertEquals(fe.totales?.total, 250000);
  assertEquals(new TextDecoder().decode(fe.kudePdf!.slice(0, 4)), "%PDF");

  const ruc = "80012345";
  const conRuc = documentoDesdePedido({ ...ped, raw: { ...ped.raw, note_attributes: [{ name: "Ruc", value: `${ruc}-${digitoVerificadorRuc(ruc)}` }, { name: "Razon social", value: "Empresa Ficticia SA" }] } }, CONFIG_DESDE_PEDIDO_DEFECTO, { ...BASE, numero: 2 });
  assert(conRuc.ok);
  const fe2 = await em.emitir(conRuc.doc);
  assertEquals(fe2.estado, "aprobada", fe2.mensaje);

  const nc = await em.emitir(notaCreditoDesdeFactura(conRuc.doc, fe2.cdc!, { ...BASE, numero: 1 }));
  assertEquals(nc.estado, "aprobada", nc.mensaje);

  assertEquals((await em.cancelar(fe.cdc!, "Pedido devuelto por el cliente")).estado, "aprobado");
  assertEquals((await em.inutilizar({ tipo: 1, establecimiento: "001", punto: "001", desde: 10, hasta: 12, motivo: "Numeración saltada por error" })).estado, "aprobado");
});

Deno.test("fábrica: 'facturasend' envuelve el adaptador; con cdcPrevio no reenvía", async () => {
  let llamadas = 0;
  const fs = crearEmisorFacturaSend(undefined, () => (llamadas++, Promise.resolve({ ok: true, simulado: true, cdc: "9".repeat(44), numero_completo: "001-001-0000001", pdf_path: "1/x.pdf" })));
  const em = await emisorDesdeConfig("facturasend", { propio: () => { throw new Error("no"); }, facturasend: () => fs });
  const d = documentoDesdePedido({ shopify_order_id: 1, nombre: "#1", total: 1000, estado_envio: "ENTREGADO", tags: [], raw: { total_price: "1000", line_items: [{ title: "X", quantity: 1, price: "1000" }] } }, CONFIG_DESDE_PEDIDO_DEFECTO, BASE);
  assert(d.ok);
  const r = await em.emitir(d.doc);
  assertEquals([r.estado, r.kudePath], ["aprobada", "1/x.pdf"]);
  assertEquals((await em.emitir(d.doc, { cdcPrevio: r.cdc })).estado, "enviada");
  assertEquals(llamadas, 1);
  assertEquals(pedidoFacturaDesdeDoc(d.doc).pedido.total, 1000);
  assertEquals((await em.cancelar("x", "y")).ok, false);
});
