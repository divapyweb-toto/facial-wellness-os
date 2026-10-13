// 12-10: los pedidos del bot de WhatsApp nacen confirmados (ORIGEN_WHATSAPP + CONFIRMADO): al llegar recién creados se
// programa UNA vez la oferta de pago con prioridad (prio:<id>). Ya no se dispara al pasar a "preparado".
// Datos inventados (repo público).
import { assert, assertEquals } from "jsr:@std/assert@1";
import { armarOfertaPrioridad, type Deps, estaPagado, type FilaEnvio, normalizarDesdeWebhook, procesarPedido } from "./procesar.ts";

const AHORA = new Date("2026-10-12T15:00:00.000Z"); // lunes 12:00 en Asunción

const pedidoRest = (extra: Record<string, unknown> = {}) => ({
  id: 5550001,
  admin_graphql_api_id: "gid://shopify/Order/5550001",
  name: "#1001",
  created_at: "2026-10-12T11:58:00-03:00", // hace 2 min
  cancelled_at: null,
  total_price: "129000.00",
  tags: "ORIGEN_WHATSAPP, CONFIRMADO, OFERTA_PAGO_ANTICIPADO",
  line_items: [{ quantity: 1, title: "Tiras nasales" }],
  shipping_address: { first_name: "Ana", last_name: "Prueba", name: "Ana Prueba", phone: "0981 000 000", address1: "Calle Falsa 123", city: "Asunción" },
  ...extra,
});

function dbFalsa(existe = true, estadoEnvio: string | null = null) {
  const envios = new Map<string, FilaEnvio & { estado: string }>();
  let disparos = 0;
  const deps: Deps = {
    normalizarTelefono: () => "+595981000000",
    ahora: () => AHORA,
    leerConfigConfirmacion: () => Promise.resolve({ recordatorio_min: 30, cancelar_h: 48 }),
    // El vendedor guarda el pedido apenas lo crea: el webhook llega con el pedido ya en la base.
    buscarPedido: () => Promise.resolve(existe ? { estado_confirmacion: "confirmado", es_borrador: false, estado_envio: estadoEnvio } : null),
    upsertCliente: () => Promise.resolve("c1"),
    upsertPedido: () => Promise.resolve(),
    programarEnvios: (filas) => {
      for (const f of filas) if (!envios.has(f.clave_unica)) envios.set(f.clave_unica, { ...f, estado: "pendiente" });
      return Promise.resolve();
    },
    // Igual que io.ts: sin cancelar el pedido, ni courier:… ni prio:… se cancelan.
    cancelarEnviosPendientes: (_id, opts) => {
      for (const e of envios.values()) {
        if (e.estado === "pendiente" && (opts?.incluirAvisos || !/^(courier|prio):/.test(e.clave_unica))) e.estado = "cancelado";
      }
      return Promise.resolve();
    },
    dispararEnvios: () => (disparos++, Promise.resolve()),
  };
  return { deps, envios, disparos: () => disparos };
}

Deno.test("pedido del bot recién creado (ya confirmado): prio:<id> pendiente, sale ya y el mismo webhook no lo cancela", async () => {
  for (const topic of ["orders/create", "orders/updated"]) {
    for (const existe of [true, false]) {
      const f = dbFalsa(existe);
      await procesarPedido(normalizarDesdeWebhook(topic, pedidoRest()), f.deps);
      const o = f.envios.get("prio:5550001")!;
      assertEquals([o.plantilla, o.categoria, o.estado, o.enviar_desde], ["voltra_pago_prioridad", "utilidad", "pendiente", AHORA.toISOString()], `${topic} ${existe}`);
      assertEquals(o.variables, { pedido: "#1001" });
      assert(f.disparos() >= 1);
    }
  }
});

Deno.test("una sola vez: más webhooks del mismo pedido no la duplican; si se cancela el pedido, se cancela", async () => {
  const f = dbFalsa();
  for (let i = 0; i < 3; i++) await procesarPedido(normalizarDesdeWebhook("orders/updated", pedidoRest()), f.deps);
  assertEquals([...f.envios.keys()].filter((k) => k.startsWith("prio:")), ["prio:5550001"]);
  await procesarPedido(normalizarDesdeWebhook("orders/updated", pedidoRest({ cancelled_at: "2026-10-12T12:01:00-03:00" })), f.deps);
  assertEquals(f.envios.get("prio:5550001")!.estado, "cancelado");
});

Deno.test("ya no se dispara al pasar a 'preparado': un pedido web preparado no programa la oferta", async () => {
  const f = dbFalsa();
  const web = pedidoRest({ tags: "CONFIRMADO", fulfillment_status: "fulfilled", fulfillments: [{ created_at: "2026-10-12T11:59:00-03:00", status: "success" }] });
  await procesarPedido(normalizarDesdeWebhook("orders/updated", web), f.deps);
  assertEquals(f.envios.has("prio:5550001"), false);
  assert(f.envios.has("courier:5550001:DESPACHADO")); // el "ya salió" sigue igual
});

Deno.test("sin oferta: web sin confirmar o confirmado (la manda wa-webhook), viejo, pagado, retiro, prueba, mayorista, cancelado o preparado", async () => {
  const casos: [Record<string, unknown>, string | null][] = [
    [{ tags: "releasit" }, null],
    [{ tags: "CONFIRMADO" }, null], // pedido web confirmado: la oferta va por wa-webhook al tocar Confirmo
    [{ tags: "ORIGEN_WHATSAPP" }, null], // del bot pero sin confirmar
    [{ created_at: "2026-10-12T10:00:00-03:00" }, null], // un update de un pedido de hace 2 h
    [{ tags: "ORIGEN_WHATSAPP, CONFIRMADO, PAGADO" }, null],
    [{ financial_status: "paid" }, null],
    [{ tags: "ORIGEN_WHATSAPP, CONFIRMADO, RETIRO_EN_CASA" }, null],
    [{ tags: "ORIGEN_WHATSAPP, CONFIRMADO, PRUEBA_E2E" }, null],
    [{ tags: "ORIGEN_WHATSAPP, CONFIRMADO, MAYORISTA" }, null],
    [{ tags: "ORIGEN_WHATSAPP, CONFIRMADO, SIN_MENSAJES" }, null],
    [{ cancelled_at: "2026-10-12T11:59:00-03:00" }, null],
    [{ fulfillment_status: "fulfilled" }, null],
    [{}, "DESPACHADO"],
  ];
  for (const [extra, estadoEnvio] of casos) {
    const f = dbFalsa(true, estadoEnvio);
    await procesarPedido(normalizarDesdeWebhook("orders/updated", pedidoRest(extra)), f.deps);
    assertEquals(f.envios.has("prio:5550001"), false, JSON.stringify({ extra, estadoEnvio }));
  }
  assertEquals(armarOfertaPrioridad(normalizarDesdeWebhook("draft_orders/create", pedidoRest()), "c1", AHORA), null);
});

Deno.test("estaPagado: PAGADO (Recibido) y PAGADO_QR también cuentan como pagado", () => {
  for (const tags of ["CONFIRMADO, PAGADO", "PAGADO_QR", "PAGO_VERIFICADO"]) {
    assert(estaPagado(normalizarDesdeWebhook("orders/updated", pedidoRest({ tags }))), tags);
  }
  assertEquals(estaPagado(normalizarDesdeWebhook("orders/updated", pedidoRest({ tags: "CONFIRMADO, PRIORIDAD" }))), false);
});
