// deno test shopify-webhook/
// Datos inventados (repo público): 0981000000, "Ana Prueba".
import { assert, assertEquals } from "jsr:@std/assert@1";
import {
  type Deps,
  type DepsWebhook,
  type FilaEnvio,
  type FilaPedido,
  formatoGs,
  manejarWebhook,
  normalizarDesdeGraphQL,
  normalizarDesdeWebhook,
  procesarPedido,
  TAG_BORRADOR_RELEASIT,
} from "./procesar.ts";
import { calcularHmacShopify, estadoAShopify, verificarHmacShopify } from "../_shared/shopify.ts";

const SECRETO = "secreto-de-prueba";
const AHORA = new Date("2026-10-06T15:00:00.000Z");

// Normalizador simulado: el real (_shared/telefono.ts, de A) se usa en io.ts.
function normalizarMock(x: string): string | null {
  let d = x.replace(/\D/g, "");
  if (d.startsWith("595")) d = d.slice(3);
  if (d.startsWith("0")) d = d.slice(1);
  return /^9\d{8}$/.test(d) ? "+595" + d : null;
}

function pedidoRest(extra: Record<string, unknown> = {}) {
  return {
    id: 5550001,
    admin_graphql_api_id: "gid://shopify/Order/5550001",
    name: "#1001",
    created_at: "2026-10-06T11:59:00-03:00",
    cancelled_at: null,
    phone: null,
    total_price: "129000.00",
    tags: "releasit",
    note_attributes: [],
    line_items: [{ quantity: 1, title: "Tiras nasales" }],
    shipping_address: {
      first_name: "Ana",
      last_name: "Prueba",
      name: "Ana Prueba",
      phone: "0981 000 000",
      address1: "Calle Falsa 123",
      city: "Ciudad del Este",
    },
    customer: { first_name: "Ana", last_name: "Prueba", phone: null },
    ...extra,
  };
}

/** Base de datos en memoria que respeta las restricciones únicas del contrato. */
function dbFalsa() {
  const clientes = new Map<string, { id: string; nombre: string | null }>();
  const pedidos = new Map<number, FilaPedido & { estado_confirmacion: string }>();
  const envios = new Map<string, FilaEnvio & { estado: string }>();
  let n = 0;
  const deps: Deps = {
    normalizarTelefono: normalizarMock,
    ahora: () => AHORA,
    leerConfigConfirmacion: () => Promise.resolve({ recordatorio_h: 4, retener_h: 48, cancelar_h: 72 }),
    buscarPedido: (id) => {
      const p = pedidos.get(id);
      return Promise.resolve(p ? { estado_confirmacion: p.estado_confirmacion, es_borrador: p.es_borrador } : null);
    },
    upsertCliente: ({ telefono, nombre }) => {
      const c = clientes.get(telefono) ?? { id: `c${++n}`, nombre };
      clientes.set(telefono, c);
      return Promise.resolve(c.id);
    },
    upsertPedido: (p) => {
      const prev = pedidos.get(p.shopify_order_id);
      pedidos.set(p.shopify_order_id, {
        ...p,
        estado_confirmacion: p.estado_confirmacion ?? prev?.estado_confirmacion ?? "pendiente",
      });
      return Promise.resolve();
    },
    programarEnvios: (filas) => {
      for (const f of filas) if (!envios.has(f.clave_unica)) envios.set(f.clave_unica, { ...f, estado: "pendiente" });
      return Promise.resolve();
    },
    cancelarEnviosPendientes: (id, opts) => {
      for (const e of envios.values()) {
        if (e.shopify_order_id === id && e.estado === "pendiente" && (opts?.incluirAvisos || !e.clave_unica.startsWith("courier:"))) e.estado = "cancelado";
      }
      return Promise.resolve();
    },
  };
  return { deps, clientes, pedidos, envios };
}

async function requestFirmado(body: string, headers: Record<string, string> = {}, secreto = SECRETO) {
  return new Request("https://x.supabase.co/functions/v1/shopify-webhook", {
    method: "POST",
    body,
    headers: {
      "Content-Type": "application/json",
      "X-Shopify-Hmac-Sha256": await calcularHmacShopify(body, secreto),
      "X-Shopify-Topic": "orders/create",
      "X-Shopify-Webhook-Id": "wh-1",
      ...headers,
    },
  });
}

function depsWebhook() {
  const vistos = new Set<string>();
  const procesados: string[] = [];
  const tareas: Promise<unknown>[] = [];
  const d: DepsWebhook = {
    secreto: SECRETO,
    guardarEventoCrudo: (_f, id) => {
      const nuevo = !vistos.has(id);
      vistos.add(id);
      return Promise.resolve(nuevo);
    },
    enSegundoPlano: (t) => tareas.push(t),
    procesar: (topic, _p, id) => {
      procesados.push(`${topic}|${id}`);
      return Promise.resolve();
    },
  };
  return { d, procesados, tareas };
}

// ---------------------------------------------------------------------------
// HMAC
// ---------------------------------------------------------------------------

Deno.test("HMAC: vector conocido (base64 de HMAC-SHA256)", async () => {
  // HMAC-SHA256(key="key", "The quick brown fox jumps over the lazy dog")
  const b64 = await calcularHmacShopify("The quick brown fox jumps over the lazy dog", "key");
  assertEquals(b64, "97yD9DBThCSxMpjmqm+xQ+9NWaFJRhdZl0edvC0aPNg=");
});

Deno.test("HMAC válido → 200 y se procesa", async () => {
  const { d, procesados, tareas } = depsWebhook();
  const r = await manejarWebhook(await requestFirmado(JSON.stringify(pedidoRest())), d);
  assertEquals(r.status, 200);
  await Promise.all(tareas);
  assertEquals(procesados, ["orders/create|wh-1"]);
});

Deno.test("HMAC inválido → 401 y no se guarda ni procesa", async () => {
  const { d, procesados } = depsWebhook();
  const body = JSON.stringify(pedidoRest());
  const r1 = await manejarWebhook(await requestFirmado(body, {}, "otro-secreto"), d);
  assertEquals(r1.status, 401);
  const r2 = await manejarWebhook(
    new Request("https://x/", { method: "POST", body, headers: { "X-Shopify-Webhook-Id": "a" } }),
    d,
  );
  assertEquals(r2.status, 401);
  // cuerpo alterado después de firmar
  const req = await requestFirmado(body);
  const alterado = new Request(req.url, { method: "POST", headers: req.headers, body: body.replace("129000", "1") });
  assertEquals((await manejarWebhook(alterado, d)).status, 401);
  assertEquals(procesados.length, 0);
  assertEquals(await verificarHmacShopify(body, "no-es-base64!!", SECRETO), false);
});

Deno.test("webhook repetido (mismo X-Shopify-Webhook-Id) → 200 sin reprocesar", async () => {
  const { d, procesados, tareas } = depsWebhook();
  const body = JSON.stringify(pedidoRest());
  assertEquals((await manejarWebhook(await requestFirmado(body), d)).status, 200);
  const r = await manejarWebhook(await requestFirmado(body), d);
  assertEquals(r.status, 200);
  assertEquals(await r.text(), "repetido");
  await Promise.all(tareas);
  assertEquals(procesados.length, 1);
});

Deno.test("tópico no manejado → se guarda, 200, no se procesa", async () => {
  const { d, procesados } = depsWebhook();
  const r = await manejarWebhook(await requestFirmado("{}", { "X-Shopify-Topic": "products/update" }), d);
  assertEquals(r.status, 200);
  assertEquals(procesados.length, 0);
});

// ---------------------------------------------------------------------------
// Proceso de pedidos
// ---------------------------------------------------------------------------

Deno.test("pedido Releasit nuevo → cliente con teléfono normalizado, pedido y 4 envíos", async () => {
  const f = dbFalsa();
  const r = await procesarPedido(normalizarDesdeWebhook("orders/create", pedidoRest()), f.deps);
  assertEquals(r.accion, "programado");
  assertEquals([...f.clientes.keys()], ["+595981000000"]);
  const p = f.pedidos.get(5550001)!;
  assertEquals(p.telefono, "+595981000000");
  assertEquals(p.nombre, "#1001");
  assertEquals(p.total, 129000);
  assertEquals(p.es_borrador, false);
  assertEquals(p.estado_confirmacion, "pendiente");
  assertEquals(p.cliente_id, "c1");

  assertEquals([...f.envios.keys()].sort(), ["canc:5550001", "conf:5550001", "rec:5550001", "ret:5550001"]);
  const t = (k: string) => new Date(f.envios.get(k)!.enviar_desde).getTime() - AHORA.getTime();
  assertEquals(t("conf:5550001"), 0); // sin espera: sale al instante (07-10)
  assertEquals(t("rec:5550001"), 4 * 3_600_000);
  assertEquals(t("ret:5550001"), 48 * 3_600_000);
  assertEquals(t("canc:5550001"), 72 * 3_600_000);
  const conf = f.envios.get("conf:5550001")!;
  assertEquals(conf.plantilla, "voltra_confirmacion_pedido_v3");
  assertEquals(conf.categoria, "utilidad");
  assertEquals(conf.variables.nombre, "Ana Prueba");
  assertEquals(conf.variables.productos, "1 Tiras nasales");
  assertEquals(conf.variables.total_texto, "129.000");
  assertEquals(conf.variables.ciudad, "Ciudad del Este");
});

Deno.test("teléfono: usa order.phone o note_attributes si shipping no lo trae", () => {
  const a = normalizarDesdeWebhook("orders/create", pedidoRest({ phone: "+595981000000", shipping_address: {} }));
  assertEquals(a.telefonoCrudo, "+595981000000");
  const b = normalizarDesdeWebhook(
    "orders/create",
    pedidoRest({ shipping_address: {}, note_attributes: [{ name: "WhatsApp", value: "0981000000" }] }),
  );
  assertEquals(b.telefonoCrudo, "0981000000");
});

Deno.test("pedido sin teléfono válido → se guarda, no se programa", async () => {
  const f = dbFalsa();
  const r = await procesarPedido(
    normalizarDesdeWebhook("orders/create", pedidoRest({ shipping_address: { phone: "021 000 000" } })),
    f.deps,
  );
  assertEquals(r.accion, "sin_telefono");
  assertEquals(f.pedidos.get(5550001)!.telefono, null);
  assertEquals(f.envios.size, 0);
});

Deno.test("borrador con tag abandoned_checkout_releasit_cod_form → se guarda, no se programa", async () => {
  const f = dbFalsa();
  const borrador = {
    id: 9990001,
    admin_graphql_api_id: "gid://shopify/DraftOrder/9990001",
    name: "#D1",
    status: "open",
    tags: TAG_BORRADOR_RELEASIT,
    total_price: "129000.00",
    shipping_address: { phone: "0981000000", name: "Ana Prueba" },
  };
  const r = await procesarPedido(normalizarDesdeWebhook("draft_orders/create", borrador), f.deps);
  assertEquals(r.accion, "borrador_guardado");
  const p = f.pedidos.get(9990001)!;
  assertEquals(p.es_borrador, true);
  assertEquals(p.tags, [TAG_BORRADOR_RELEASIT]);
  assertEquals(f.envios.size, 0);
});

Deno.test("pedido actualizado → actualiza tags sin duplicar envíos", async () => {
  const f = dbFalsa();
  await procesarPedido(normalizarDesdeWebhook("orders/create", pedidoRest()), f.deps);
  const r = await procesarPedido(
    normalizarDesdeWebhook("orders/updated", pedidoRest({ tags: "releasit, VIP" })),
    f.deps,
  );
  assertEquals(r.accion, "actualizado");
  assertEquals(f.pedidos.get(5550001)!.tags, ["releasit", "VIP"]);
  assertEquals(f.envios.size, 4);
  assertEquals(f.clientes.size, 1);
  assert([...f.envios.values()].every((e) => e.estado === "pendiente"));
});

Deno.test("orders/updated antes que orders/create (Shopify no garantiza orden) → programa igual, una vez", async () => {
  const f = dbFalsa();
  await procesarPedido(normalizarDesdeWebhook("orders/updated", pedidoRest()), f.deps);
  await procesarPedido(normalizarDesdeWebhook("orders/create", pedidoRest()), f.deps);
  assertEquals(f.envios.size, 4);
});

Deno.test("tag CONFIRMADO en Shopify → estado confirmado y cancela envíos pendientes", async () => {
  const f = dbFalsa();
  await procesarPedido(normalizarDesdeWebhook("orders/create", pedidoRest()), f.deps);
  const r = await procesarPedido(
    normalizarDesdeWebhook("orders/updated", pedidoRest({ tags: "releasit, CONFIRMADO" })),
    f.deps,
  );
  assertEquals(r.estadoConfirmacion, "confirmado");
  assertEquals(f.pedidos.get(5550001)!.estado_confirmacion, "confirmado");
  assert([...f.envios.values()].every((e) => e.estado === "cancelado"));
});

Deno.test("estado cambiado por otro módulo (sin tag) no se pisa ni se reprograma", async () => {
  const f = dbFalsa();
  await procesarPedido(normalizarDesdeWebhook("orders/create", pedidoRest()), f.deps);
  f.pedidos.get(5550001)!.estado_confirmacion = "a_corregir";
  await procesarPedido(normalizarDesdeWebhook("orders/updated", pedidoRest()), f.deps);
  assertEquals(f.pedidos.get(5550001)!.estado_confirmacion, "a_corregir");
});

Deno.test("pedido cancelado en Shopify → cancela envíos pendientes", async () => {
  const f = dbFalsa();
  await procesarPedido(normalizarDesdeWebhook("orders/create", pedidoRest()), f.deps);
  await procesarPedido(
    normalizarDesdeWebhook("orders/updated", pedidoRest({ cancelled_at: "2026-10-06T13:00:00-03:00" })),
    f.deps,
  );
  assert([...f.envios.values()].every((e) => e.estado === "cancelado"));
});

Deno.test("conciliación: nodo GraphQL se normaliza igual que el webhook", async () => {
  const nodo = {
    id: "gid://shopify/Order/5550001",
    legacyResourceId: "5550001",
    name: "#1001",
    createdAt: "2026-10-06T14:59:00Z",
    cancelledAt: null,
    phone: null,
    tags: ["releasit"],
    customAttributes: [],
    totalPriceSet: { shopMoney: { amount: "129000.0" } },
    lineItems: { nodes: [{ quantity: 1, title: "Tiras nasales" }] },
    shippingAddress: { phone: "0981 000 000", name: "Ana Prueba", address1: "Calle Falsa 123", city: "Ciudad del Este" },
    billingAddress: null,
    customer: { firstName: "Ana", lastName: "Prueba", defaultPhoneNumber: null },
  };
  const g = normalizarDesdeGraphQL(nodo);
  const w = normalizarDesdeWebhook("orders/create", pedidoRest());
  for (const k of ["shopifyOrderId", "gid", "nombre", "telefonoCrudo", "nombreCliente", "total", "productos", "ciudad", "tags", "esBorrador"] as const) {
    assertEquals(g[k], w[k], k);
  }
  const f = dbFalsa();
  await procesarPedido(g, f.deps);
  assertEquals(f.envios.size, 4);
});

Deno.test("formatoGs y estadoAShopify", () => {
  assertEquals(formatoGs(129000), "129.000");
  assertEquals(formatoGs(1249000.4), "1.249.000");
  assertEquals(estadoAShopify("DESPACHADO"), "IN_TRANSIT");
  assertEquals(estadoAShopify("ENTREGADO"), "DELIVERED");
  assertEquals(estadoAShopify("INTENTO_FALLIDO"), "ATTEMPTED_DELIVERY");
  assertEquals(estadoAShopify("NO_ENTREGADO"), "FAILURE");
  assertEquals(estadoAShopify("EN_PREPARACION"), null);
  assertEquals(estadoAShopify("OUT_FOR_DELIVERY"), "OUT_FOR_DELIVERY");
});

Deno.test("con el normalizarTelefonoPY real de _shared/telefono.ts", async () => {
  const { normalizarTelefonoPY } = await import("../_shared/telefono.ts");
  const f = dbFalsa();
  f.deps.normalizarTelefono = normalizarTelefonoPY;
  await procesarPedido(normalizarDesdeWebhook("orders/create", pedidoRest()), f.deps);
  assertEquals(f.pedidos.get(5550001)!.telefono, "+595981000000");
  assertEquals(f.envios.size, 4);
});

Deno.test("confirmación al instante: dispara procesar-envios, salvo el pedido de prueba del despliegue (PRUEBA_E2E)", async () => {
  for (const [tags, esperado] of [["releasit_cod_form", 1], ["PRUEBA_E2E", 0]] as const) {
    let disparos = 0;
    const deps: Deps = {
      normalizarTelefono: (x) => x ? "+595981000000" : null,
      ahora: () => new Date("2026-10-07T12:00:00Z"),
      leerConfigConfirmacion: () => Promise.resolve({ recordatorio_h: 1, retener_h: 48, cancelar_h: 72 }),
      buscarPedido: () => Promise.resolve(null),
      upsertCliente: () => Promise.resolve("cli-1"),
      upsertPedido: () => Promise.resolve(),
      programarEnvios: () => Promise.resolve(),
      cancelarEnviosPendientes: () => Promise.resolve(),
      dispararEnvios: () => (disparos++, Promise.resolve()),
    };
    const ped = normalizarDesdeWebhook("orders/create", { id: 5550002, name: "#1003", phone: "0981000000", tags, line_items: [{ title: "T", quantity: 1, price: "79000" }], total_price: "112000", shipping_address: { first_name: "Ana", address1: "Calle 1", city: "CDE", phone: "0981000000" } });
    await procesarPedido(ped, deps);
    assertEquals(disparos, esperado, tags);
  }
});

Deno.test("evento temprano a Meta: solo pedido nuevo, no cancelado, no PRUEBA_E2E, con cliente; no se espera", async () => {
  const casos: Array<[string, Record<string, unknown>, number]> = [
    ["nuevo", {}, 1],
    ["prueba e2e", { tags: "PRUEBA_E2E" }, 0],
    ["cancelado", { cancelled_at: "2026-10-06T12:00:00-03:00" }, 0],
    ["sin teléfono", { shipping_address: { first_name: "Ana", city: "CDE" } }, 0],
  ];
  for (const [nombre, extra, esperado] of casos) {
    const f = dbFalsa();
    const llamadas: unknown[] = [];
    // Promesa que nunca resuelve: si procesarPedido la esperara, el test se colgaría.
    f.deps.notificarPedidoMeta = (p) => (llamadas.push(p), new Promise(() => {}));
    await procesarPedido(normalizarDesdeWebhook("orders/create", pedidoRest(extra)), f.deps);
    assertEquals(llamadas.length, esperado, nombre);
    if (esperado) {
      assertEquals(llamadas[0], { shopifyOrderId: 5550001, clienteId: "c1", total: 129000, creadoEn: "2026-10-06T11:59:00-03:00" });
      // orders/updated del mismo pedido (ya existe): no se repite.
      await procesarPedido(normalizarDesdeWebhook("orders/updated", pedidoRest()), f.deps);
      assertEquals(llamadas.length, 1);
    }
  }
  // Borrador: nunca.
  const b = dbFalsa();
  let n = 0;
  b.deps.notificarPedidoMeta = () => (n++, Promise.resolve());
  await procesarPedido(normalizarDesdeWebhook("draft_orders/create", pedidoRest()), b.deps);
  assertEquals(n, 0);
  // Si la función tira, el webhook sigue igual.
  const t = dbFalsa();
  t.deps.notificarPedidoMeta = () => {
    throw new Error("boom");
  };
  const r = await procesarPedido(normalizarDesdeWebhook("orders/create", pedidoRest()), t.deps);
  assertEquals(r.accion, "programado");
});

Deno.test("marcado PREPARADO en Shopify (confirmado) → un aviso 'ya salió' con courier y plazo por ciudad; no se repite ni se cancela", async () => {
  const f = dbFalsa();
  f.deps.courierDePedido = () => Promise.resolve("lucero");
  await procesarPedido(normalizarDesdeWebhook("orders/create", pedidoRest()), f.deps);
  const preparado = pedidoRest({ tags: "CONFIRMADO", fulfillment_status: "fulfilled" });
  await procesarPedido(normalizarDesdeWebhook("orders/updated", preparado), f.deps);
  await procesarPedido(normalizarDesdeWebhook("orders/updated", { ...preparado, tags: "CONFIRMADO, VIP" }), f.deps);
  const aviso = f.envios.get("courier:5550001:DESPACHADO")!;
  assertEquals(aviso.plantilla, "voltra_pedido_despachado");
  assertEquals(aviso.estado, "pendiente");
  assertEquals(aviso.variables, { nombre: "Ana", productos: "1 Tiras nasales", courier: "Lucero del Este", plazo: "hoy mismo o en 24 h", total: formatoGs(129000) });
  assertEquals([...f.envios.keys()].filter((k) => k.endsWith(":DESPACHADO")).length, 1);
});

Deno.test("sin preparar, cancelado o prueba E2E → no hay aviso 'ya salió'", async () => {
  for (const extra of [{}, { fulfillment_status: "fulfilled", cancelled_at: "2026-10-06T12:00:00-03:00" }, { fulfillment_status: "fulfilled", tags: "PRUEBA_E2E" }]) {
    const f = dbFalsa();
    await procesarPedido(normalizarDesdeWebhook("orders/updated", pedidoRest(extra)), f.deps);
    assertEquals([...f.envios.keys()].filter((k) => k.startsWith("courier:")).length, 0, JSON.stringify(extra));
  }
});

Deno.test("recordatorio de entrega en todas las ciudades: CDE +2 h, Asunción/Central día siguiente 8:00, interior 2.º día 8:00", async () => {
  const casos = [
    ["Ciudad del Este", "voltra_entrega_proxima", "2026-10-06T17:00:00.000Z"], // AHORA 15:00 UTC + 2 h
    ["Asunción", "voltra_entrega_hoy", "2026-10-07T11:00:00.000Z"],
    ["Luque", "voltra_entrega_hoy", "2026-10-07T11:00:00.000Z"],
    ["Encarnación", "voltra_entrega_proxima", "2026-10-08T11:00:00.000Z"],
  ] as const;
  for (const [ciudad, plantilla, cuando] of casos) {
    const f = dbFalsa();
    const p = pedidoRest({ tags: "CONFIRMADO", fulfillment_status: "fulfilled", shipping_address: { ...pedidoRest().shipping_address, city: ciudad } });
    await procesarPedido(normalizarDesdeWebhook("orders/updated", p), f.deps);
    const r = f.envios.get("courier:5550001:ENTREGA_HOY")!;
    assertEquals([r.plantilla, r.enviar_desde], [plantilla, cuando], ciudad);
    assertEquals(r.variables, { nombre: "Ana", total: formatoGs(129000) });
  }
});

Deno.test("pedido cancelado después de despachado: el 'hoy te llega' pendiente se cancela", async () => {
  const f = dbFalsa();
  const p = pedidoRest({ tags: "CONFIRMADO", fulfillment_status: "fulfilled", shipping_address: { ...pedidoRest().shipping_address, city: "Asunción" } });
  await procesarPedido(normalizarDesdeWebhook("orders/updated", p), f.deps);
  await procesarPedido(normalizarDesdeWebhook("orders/updated", { ...p, cancelled_at: "2026-10-06T13:00:00-03:00" }), f.deps);
  assertEquals(f.envios.get("courier:5550001:ENTREGA_HOY")!.estado, "cancelado");
});

Deno.test("fin de semana: despachado el sábado → 'ya salió' el lunes 8:00 y recordatorio contado desde el lunes", async () => {
  const f = dbFalsa();
  f.deps.ahora = () => new Date("2026-10-10T15:00:00.000Z"); // sábado 12:00 en Asunción
  const p = pedidoRest({ tags: "CONFIRMADO", fulfillment_status: "fulfilled", shipping_address: { ...pedidoRest().shipping_address, city: "Asunción" } });
  await procesarPedido(normalizarDesdeWebhook("orders/updated", p), f.deps);
  assertEquals(f.envios.get("courier:5550001:DESPACHADO")!.enviar_desde, "2026-10-12T11:00:00.000Z");
  assertEquals(f.envios.get("courier:5550001:ENTREGA_HOY")!.enviar_desde, "2026-10-13T11:00:00.000Z");
});

Deno.test("09-10: pedido ya ENTREGADO/NO_ENTREGADO por el courier → no se programan 'ya salió' ni 'hoy te llega'", async () => {
  for (const estado_envio of ["ENTREGADO", "NO_ENTREGADO"]) {
    const f = dbFalsa();
    await procesarPedido(normalizarDesdeWebhook("orders/create", pedidoRest()), f.deps);
    const buscar = f.deps.buscarPedido;
    f.deps.buscarPedido = async (id) => {
      const p = await buscar(id);
      return p ? { ...p, estado_envio } : null;
    };
    const p = pedidoRest({ tags: "CONFIRMADO", fulfillment_status: "fulfilled" });
    await procesarPedido(normalizarDesdeWebhook("orders/updated", p), f.deps);
    assertEquals([...f.envios.keys()].filter((k) => k.startsWith("courier:")).length, 0, estado_envio);
  }
});
