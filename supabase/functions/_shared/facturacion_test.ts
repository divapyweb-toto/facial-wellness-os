import { assert, assertEquals } from "jsr:@std/assert@1";
import {
  _configurarFactura,
  armarSeguimientoConFactura,
  CONFIG_FACTURA_DEFECTO,
  datosFiscalesDesdePedido,
  digitoVerificadorRuc,
  emitirFactura,
  normalizarRuc,
  type PedidoFactura,
} from "./facturacion.ts";

const pedido: PedidoFactura = {
  shopify_order_id: 9001,
  nombre: "#1001",
  numero: 5,
  fecha: new Date("2026-10-06T15:00:00Z"),
  items: [{ descripcion: "Tiras nasales", cantidad: 1, precioUnitario: 129000 }],
  total: 129000,
};
const PDF = new TextEncoder().encode("%PDF-1.4 prueba");
const guardarPdf = () => Promise.resolve({ url: "https://storage.test/f.pdf", path: "9001/001-001-0000005.pdf" });
const json = (o: unknown, status = 200) => Promise.resolve(new Response(JSON.stringify(o), { status }));
const envReal = { FACTURASEND_API_KEY: "k", FACTURASEND_TENANT: "t" };

Deno.test("RUC: dígito verificador y normalización", () => {
  assertEquals(digitoVerificadorRuc("80000001"), digitoVerificadorRuc("80000001"));
  const dv = digitoVerificadorRuc("1234567");
  assertEquals(normalizarRuc(`1.234.567-${dv}`), `1234567-${dv}`);
  assertEquals(normalizarRuc(`1234567-${(dv + 1) % 10}`), null);
  assertEquals(normalizarRuc("abc"), null);
});

Deno.test("datos fiscales: consumidor final, RUC válido y RUC inválido", () => {
  const dv = digitoVerificadorRuc("1234567");
  const raw = (v: string) => ({ note_attributes: [{ name: "RUC", value: v }] });
  assertEquals(datosFiscalesDesdePedido(raw("no"), ["ruc"]).pidioRuc, false);
  const ok = datosFiscalesDesdePedido(raw(`1234567-${dv} Ana Prueba`), ["ruc"]);
  assert(ok.pidioRuc && ok.rucValido);
  assertEquals(ok.datos.razonSocial, "Ana Prueba");
  const mal = datosFiscalesDesdePedido(raw(`1234567-${(dv + 1) % 10} Ana`), ["ruc"]);
  assert(mal.pidioRuc && !mal.rucValido);
});

Deno.test("sin credenciales: simulador, sin fetch, CDC empieza con 99", async () => {
  let llamadas = 0;
  _configurarFactura({ env: () => undefined, fetch: () => { llamadas++; return json({}); }, guardarPdf });
  const r = await emitirFactura(pedido, {});
  assert(r.ok && r.simulado);
  assert(r.cdc!.startsWith("99") && r.cdc!.length === 44);
  assertEquals(r.numero_completo, "001-001-0000005");
  assertEquals(llamadas, 0);
  _configurarFactura();
});

Deno.test("FacturaSend éxito: crea el lote y baja el PDF", async () => {
  const urls: string[] = [];
  _configurarFactura({
    env: (n) => (envReal as Record<string, string>)[n],
    guardarPdf,
    fetch: (u) => {
      urls.push(String(u));
      if (String(u).endsWith("/lote/create")) return json({ success: true, result: { deList: [{ cdc: "01" + "0".repeat(42), estado: "Aprobado" }] } });
      return Promise.resolve(new Response(PDF, { headers: { "content-type": "application/pdf" } }));
    },
  });
  const r = await emitirFactura(pedido, {});
  assert(r.ok && !r.simulado);
  assertEquals(r.pdf_url, "https://storage.test/f.pdf");
  assertEquals(urls.length, 2);
  _configurarFactura();
});

Deno.test("FacturaSend error: ok=false y no baja PDF; red caída también", async () => {
  _configurarFactura({ env: (n) => (envReal as Record<string, string>)[n], guardarPdf, fetch: () => json({ success: false, error: "rechazado" }, 400) });
  let r = await emitirFactura(pedido, {});
  assert(!r.ok && r.error!.includes("rechazado"));
  _configurarFactura({ env: (n) => (envReal as Record<string, string>)[n], guardarPdf, fetch: () => Promise.reject(new Error("caído")) });
  r = await emitirFactura(pedido, {});
  assert(!r.ok && r.error!.includes("caído"));
  _configurarFactura();
});

Deno.test("seguimiento con factura: documento adjunto y botones con el pedido", () => {
  const m = armarSeguimientoConFactura({ orderId: 9001, nombre: "Ana", productos: "Tiras", pdfUrl: "https://x.test/f.pdf", numeroCompleto: "001-001-0000005" });
  assertEquals(m.plantilla, "voltra_seguimiento_factura");
  const c = m.componentes as Array<Record<string, unknown>>;
  assertEquals(c.length, 4);
  assert(JSON.stringify(c[3]).includes("seg_problema:9001"));
  assert(CONFIG_FACTURA_DEFECTO.iva === 10);
});
