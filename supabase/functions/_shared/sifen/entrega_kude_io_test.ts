// Tests de las Deps reales (entrega_kude_io.ts) con entorno inyectado: sin base, sin Meta, sin red real.
import { assert, assertEquals, assertFalse, assertRejects } from "@std/assert";
import { _limpiarCacheEntrega, depsEntregaKude } from "./entrega_kude_io.ts";
import { _configurarWA } from "../wa.ts";

const AHORA = new Date("2026-10-29T20:00:00Z");

Deno.test("plantillaAprobada: APPROVED true, con caché; error no se cachea", async () => {
  _limpiarCacheEntrega();
  let consultas = 0;
  const d = depsEntregaKude("voltra_factura", { estadoPlantilla: () => (consultas++, Promise.resolve({ estado: "APPROVED" })) });
  assert(await d.plantillaAprobada("voltra_factura"));
  assert(await d.plantillaAprobada("voltra_factura"));
  assertEquals(consultas, 1);
  _limpiarCacheEntrega();
  const p = depsEntregaKude("voltra_factura", { estadoPlantilla: () => Promise.resolve({ estado: "PENDING" }) });
  assertFalse(await p.plantillaAprobada("voltra_factura"));
  _limpiarCacheEntrega();
  let n = 0;
  const e = depsEntregaKude("voltra_factura", { estadoPlantilla: () => (n++, Promise.resolve({ estado: null, error: "HTTP 500" })) });
  await assertRejects(() => e.plantillaAprobada("voltra_factura"));
  await assertRejects(() => e.plantillaAprobada("voltra_factura"));
  assertEquals(n, 2);
  _limpiarCacheEntrega();
});

Deno.test("ventanaAbierta: normaliza el teléfono y compara contra 24 h", async () => {
  const pedidos: string[] = [];
  const d = depsEntregaKude("voltra_factura", {
    ahora: () => AHORA,
    ultimaEntrada: (t) => (pedidos.push(t), Promise.resolve(t === "+595981000000" ? "2026-10-29T08:00:00Z" : "2026-10-27T08:00:00Z")),
  });
  assert(await d.ventanaAbierta("0981 000 000"));
  assertFalse(await d.ventanaAbierta("+595982000000"));
  assertFalse(await d.ventanaAbierta("021 000 000"));
  assertEquals(pedidos, ["+595981000000", "+595982000000"]);
});

Deno.test("enviarDocumentoWa arma el documento con filename y caption", async () => {
  const cuerpos: Record<string, unknown>[] = [];
  _configurarWA({
    token: () => "t", phoneNumberId: () => "P", palabrasProhibidas: () => Promise.resolve([]),
    registrar: () => Promise.resolve(), resolverDestino: () => Promise.resolve({ clienteId: null, conversacionId: null }),
    fetch: (_u, i) => (cuerpos.push(JSON.parse(String(i?.body))), Promise.resolve(new Response(JSON.stringify({ messages: [{ id: "w" }] })))),
  });
  const d = depsEntregaKude();
  const r = await d.enviarDocumentoWa({ pdfUrl: "https://e.com/f.pdf", numeroCompleto: "001-001-0000007", total: 1, nombre: "Ana", telefono: "+595981000000", email: null, pedido: null });
  assert(r.ok);
  assertEquals(cuerpos[0].document, { link: "https://e.com/f.pdf", filename: "Factura 001-001-0000007.pdf", caption: "Hola, Ana. Te enviamos tu factura electrónica N.º 001-001-0000007. ¡Gracias por tu compra!" });
  const rp = await d.enviarPlantillaFactura({ pdfUrl: "https://e.com/f.pdf", numeroCompleto: "001-001-0000007", total: 1, nombre: "Ana", telefono: "+595981000000", email: null, pedido: null });
  assert(rp.ok);
  assertEquals((cuerpos[1].template as { name: string }).name, "voltra_factura");
  _configurarWA();
});

Deno.test("enviarCorreo sin email no llama; sin clave queda simulado", async () => {
  const prev = Deno.env.get("RESEND_API_KEY");
  Deno.env.delete("RESEND_API_KEY");
  let red = 0;
  const d = depsEntregaKude("voltra_factura", { fetch: () => (red++, Promise.resolve(new Response("{}"))) });
  const base = { pdfUrl: "https://e.com/f.pdf", numeroCompleto: "n", total: 1, nombre: null, telefono: null, pedido: null };
  assertEquals(await d.enviarCorreo({ ...base, email: null }), { ok: false, error: "sin email" });
  assertEquals(await d.enviarCorreo({ ...base, email: "a@ejemplo.com" }), { ok: true, simulado: true });
  assertEquals(red, 0);
  if (prev) Deno.env.set("RESEND_API_KEY", prev);
});
