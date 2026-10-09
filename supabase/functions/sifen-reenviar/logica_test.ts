import { assertEquals } from "jsr:@std/assert@1";
import { type DepsReenviar, type FacturaReenvio, reenviarKude } from "./logica.ts";

const ID = "11111111-2222-3333-4444-555555555555";
function deps(f: FacturaReenvio | null, enviarOk = true) {
  const log = { enviados: 0, marcados: 0 };
  const d: DepsReenviar = {
    usuario: (t) => Promise.resolve(t === "ok" ? { id: "u1" } : null),
    leerFactura: () => Promise.resolve(f),
    enviar: () => (log.enviados++, Promise.resolve(enviarOk ? { ok: true, wa_message_id: "w1" } : { ok: false, error: "x" })),
    marcarEnviado: () => (log.marcados++, Promise.resolve()),
  };
  return { d, log };
}
const fila = (o: Partial<FacturaReenvio> = {}): FacturaReenvio => ({ id: ID, estado: "aprobada", kude_path: "a.pdf", numero_completo: "001-001-0000001", shopify_order_id: 1, ...o });

Deno.test("sifen-reenviar: exige sesión, uuid, factura aprobada con KuDE; marca el envío", async () => {
  assertEquals((await reenviarKude("", {}, deps(fila()).d)).status, 401);
  assertEquals((await reenviarKude("malo", { factura_id: ID }, deps(fila()).d)).status, 401);
  assertEquals((await reenviarKude("ok", { factura_id: "x" }, deps(fila()).d)).status, 400);
  assertEquals((await reenviarKude("ok", { factura_id: ID }, deps(null).d)).status, 404);
  assertEquals((await reenviarKude("ok", { factura_id: ID }, deps(fila({ estado: "pendiente" })).d)).status, 409);
  assertEquals((await reenviarKude("ok", { factura_id: ID }, deps(fila({ kude_path: null })).d)).status, 409);
  assertEquals((await reenviarKude("ok", { factura_id: ID }, deps(fila(), false).d)).status, 502);
  const x = deps(fila());
  assertEquals((await reenviarKude("ok", { factura_id: ID }, x.d)).status, 200);
  assertEquals(x.log, { enviados: 1, marcados: 1 });
});
