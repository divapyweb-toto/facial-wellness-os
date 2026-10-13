// 12-10: al pasar a "preparado" (fulfilled) se programa UNA vez la oferta de pago con prioridad (prio:<id>).
// Datos inventados (repo público).
import { assert, assertEquals } from "jsr:@std/assert@1";
import { armarOfertaPrioridad, type Deps, estaPagado, type FilaEnvio, normalizarDesdeWebhook, procesarPedido } from "./procesar.ts";

const AHORA = new Date("2026-10-12T15:00:00.000Z"); // lunes 12:00 en Asunción
const FULFILL = [{ created_at: "2026-10-12T11:58:00-03:00", status: "success" }];

const pedidoRest = (extra: Record<string, unknown> = {}) => ({
  id: 5550001,
  admin_graphql_api_id: "gid://shopify/Order/5550001",
  name: "#1001",
  created_at: "2026-10-12T09:00:00-03:00",
  cancelled_at: null,
  total_price: "129000.00",
  tags: "CONFIRMADO",
  fulfillment_status: "fulfilled",
  fulfillments: FULFILL,
  line_items: [{ quantity: 1, title: "Tiras nasales" }],
  shipping_address: { first_name: "Ana", last_name: "Prueba", name: "Ana Prueba", phone: "0981 000 000", address1: "Calle Falsa 123", city: "Asunción" },
  ...extra,
});

function dbFalsa(estadoEnvio: string | null = null) {
  const envios = new Map<string, FilaEnvio>();
  const programados: string[][] = [];
  const deps: Deps = {
    normalizarTelefono: () => "+595981000000",
    ahora: () => AHORA,
    leerConfigConfirmacion: () => Promise.resolve({ recordatorio_min: 30, cancelar_h: 48 }),
    buscarPedido: () => Promise.resolve({ estado_confirmacion: "confirmado", es_borrador: false, estado_envio: estadoEnvio }),
    upsertCliente: () => Promise.resolve("c1"),
    upsertPedido: () => Promise.resolve(),
    programarEnvios: (filas) => {
      programados.push(filas.map((f) => f.clave_unica));
      for (const f of filas) if (!envios.has(f.clave_unica)) envios.set(f.clave_unica, f);
      return Promise.resolve();
    },
    cancelarEnviosPendientes: () => Promise.resolve(),
  };
  return { deps, envios, programados };
}

Deno.test("preparado (fulfilled recién): se programa prio:<id> con el número de pedido, antes del 'ya salió'", async () => {
  const f = dbFalsa();
  await procesarPedido(normalizarDesdeWebhook("orders/updated", pedidoRest()), f.deps);
  const o = f.envios.get("prio:5550001")!;
  assertEquals(o.plantilla, "voltra_pago_prioridad");
  assertEquals(o.variables, { pedido: "#1001" });
  assertEquals(o.categoria, "utilidad");
  assertEquals(o.enviar_desde, "2026-10-12T14:59:59.000Z");
  assert(o.enviar_desde < f.envios.get("courier:5550001:DESPACHADO")!.enviar_desde);
  assertEquals(f.programados[0][0], "prio:5550001");
});

Deno.test("una sola vez: más orders/updated del mismo pedido no duplican la oferta (clave única)", async () => {
  const f = dbFalsa();
  for (let i = 0; i < 3; i++) await procesarPedido(normalizarDesdeWebhook("orders/updated", pedidoRest()), f.deps);
  assertEquals([...f.envios.keys()].filter((k) => k.startsWith("prio:")), ["prio:5550001"]);
});

Deno.test("sin oferta: no preparado, preparado hace días, pagado, retiro, prueba, mayorista, cancelado, ya despachado u oferta vieja", async () => {
  const casos: [Record<string, unknown>, string | null][] = [
    [{ fulfillment_status: null, fulfillments: [] }, null],
    [{ fulfillments: [{ created_at: "2026-10-10T10:00:00-03:00", status: "success" }] }, null], // un update de un pedido viejo
    [{ fulfillments: undefined }, null], // sin dato del fulfillment: no se arriesga
    [{ tags: "CONFIRMADO, PAGADO" }, null],
    [{ tags: "CONFIRMADO, PAGO_VERIFICADO" }, null],
    [{ financial_status: "paid" }, null],
    [{ tags: "CONFIRMADO, RETIRO_EN_CASA" }, null],
    [{ tags: "CONFIRMADO, PRUEBA_E2E" }, null],
    [{ tags: "CONFIRMADO, MAYORISTA" }, null],
    [{ cancelled_at: "2026-10-12T11:00:00-03:00" }, null],
    [{}, "DESPACHADO"],
    [{ tags: "CONFIRMADO, OFERTA_PAGO_ANTICIPADO" }, null], // web que ya recibió la oferta vieja al confirmar
  ];
  for (const [extra, estadoEnvio] of casos) {
    const f = dbFalsa(estadoEnvio);
    await procesarPedido(normalizarDesdeWebhook("orders/updated", pedidoRest(extra)), f.deps);
    assertEquals(f.envios.has("prio:5550001"), false, JSON.stringify({ extra, estadoEnvio }));
  }
  // Pedido de WhatsApp (nace con OFERTA_PAGO_ANTICIPADO + ORIGEN_WHATSAPP): sí.
  const w = dbFalsa();
  await procesarPedido(normalizarDesdeWebhook("orders/updated", pedidoRest({ tags: "ORIGEN_WHATSAPP, CONFIRMADO, OFERTA_PAGO_ANTICIPADO" })), w.deps);
  assert(w.envios.has("prio:5550001"));
});

Deno.test("fin de semana: la oferta sale el sábado (el 'ya salió' espera al lunes)", () => {
  const sabado = new Date("2026-10-10T15:00:00.000Z");
  const p = normalizarDesdeWebhook("orders/updated", pedidoRest({ fulfillments: [{ created_at: "2026-10-10T11:50:00-03:00", status: "success" }] }));
  assertEquals(armarOfertaPrioridad(p, "c1", sabado)!.enviar_desde, "2026-10-10T14:59:59.000Z");
});

Deno.test("estaPagado: PAGADO (Recibido) y PAGADO_QR también cuentan como pagado", () => {
  for (const tags of ["CONFIRMADO, PAGADO", "PAGADO_QR", "PAGO_VERIFICADO"]) {
    assert(estaPagado(normalizarDesdeWebhook("orders/updated", pedidoRest({ tags }))), tags);
  }
  assertEquals(estaPagado(normalizarDesdeWebhook("orders/updated", pedidoRest({ tags: "CONFIRMADO, PRIORIDAD" }))), false);
});
