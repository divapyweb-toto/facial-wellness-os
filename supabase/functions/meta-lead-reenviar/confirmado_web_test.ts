import { assert, assertEquals } from "@std/assert";
import { enviarConfirmadosWeb, motivoNoEnviar, type DepsConfirmado, type PedidoConfirmadoWeb } from "./confirmado_web.ts";

const AHORA = new Date("2026-10-22T15:00:00Z");
const ped = (o: Partial<PedidoConfirmadoWeb> = {}): PedidoConfirmadoWeb => ({
  shopify_order_id: 9001, nombre: "#9001", tags: ["CONFIRMADO", "releasit_cod_form"], estado_confirmacion: "confirmado",
  confirmado_en: "2026-10-22T14:30:00Z", cancelado: false, total: 112000, telefono: "+595981000000", cliente_id: "c-1",
  raw: { shipping_address: { first_name: "Ana", last_name: "Prueba", city: "Asunción" }, note_attributes: [{ name: "IP address", value: "190.0.0.1" }] }, ...o,
});

Deno.test("22-10: qué pedidos web mandan PedidoConfirmado", () => {
  assertEquals(motivoNoEnviar(ped(), AHORA), null);
  assertEquals(motivoNoEnviar(ped({ tags: ["CONFIRMADO", "ORIGEN_WHATSAPP"] }), AHORA), "whatsapp");
  assertEquals(motivoNoEnviar(ped({ tags: ["CONFIRMADO", "PRUEBA_E2E"] }), AHORA), "prueba");
  assertEquals(motivoNoEnviar(ped({ estado_confirmacion: "pendiente" }), AHORA), "sin_confirmar");
  assertEquals(motivoNoEnviar(ped({ cancelado: true }), AHORA), "cancelado");
  assertEquals(motivoNoEnviar(ped({ confirmado_en: "2026-10-14T14:30:00Z" }), AHORA), "mas_de_7_dias");
});

Deno.test("22-10: una sola vez por pedido, payload correcto (evento, event_id, event_time, valor, datos cifrados) y reintento si Meta falla", async () => {
  const candados = new Set<string>(), enviados: Record<string, unknown>[] = [];
  let falla = 1;
  const d: DepsConfirmado = {
    candidatos: () => Promise.resolve([ped(), ped({ shopify_order_id: 9002, nombre: "#9002", tags: ["PRUEBA"] })]),
    tomarCandado: (id) => { if (candados.has(id)) return Promise.resolve(false); candados.add(id); return Promise.resolve(true); },
    soltarCandado: (id) => { candados.delete(id); return Promise.resolve(); },
    registrar: () => Promise.resolve(),
    enviar: (p) => { enviados.push(p as Record<string, unknown>); if (falla-- > 0) return Promise.resolve({ ok: false, error: "500" }); return Promise.resolve({ ok: true }); },
  };
  assertEquals((await enviarConfirmadosWeb(d, AHORA))[0].resultado, "error: 500");   // falla: se suelta el candado
  assertEquals((await enviarConfirmadosWeb(d, AHORA))[0].resultado, "enviado");      // reintento
  assertEquals((await enviarConfirmadosWeb(d, AHORA)).length, 0);                     // ya enviado: nada más
  const ev = (enviados[1].data as Record<string, unknown>[])[0];
  assertEquals(ev.event_name, "PedidoConfirmado");
  assertEquals(ev.event_id, "confirmado:9001");
  assertEquals(ev.event_time, Math.floor(Date.parse("2026-10-22T14:30:00Z") / 1000));
  assertEquals((ev.custom_data as Record<string, unknown>).value, 112000);
  assertEquals((ev.custom_data as Record<string, unknown>).currency, "PYG");
  const ud = ev.user_data as Record<string, unknown>;
  assert(Array.isArray(ud.ph) && String((ud.ph as string[])[0]).length === 64);   // teléfono cifrado
  assertEquals(ud.client_ip_address, "190.0.0.1");
  assert(!("fbc" in ud));                                                      // sin cookie guardada, no se inventa
  assertEquals(enviados.length, 2);                                            // el de PRUEBA nunca salió
});
