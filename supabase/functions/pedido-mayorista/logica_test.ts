// Tests de logica.ts con Deps de mentira (sin Shopify ni Supabase). Datos inventados.
import { assert, assertEquals } from "jsr:@std/assert@1";
import { type Candado, type Deps, inputOrderCreate, manejar, type ResultadoOrden, tagsDelPedido } from "./logica.ts";
import { validarPedido } from "./validar.ts";
import { cuerpoValido } from "./prueba_utiles.ts";

const AHORA = new Date("2026-10-10T15:00:00Z");

type Op = Partial<{
  orden: ResultadoOrden | (() => Promise<ResultadoOrden>);
  facturarDesde: string | null;
  retencionFalta: boolean;
  registrarFalla: boolean;
  entregadoFalla: boolean;
}>;

function mock(op: Op = {}) {
  const st = {
    llamadas: [] as string[],
    candados: new Map<string, Candado & { payload?: unknown }>(),
    inputs: [] as Record<string, unknown>[],
    fiscales: [] as Record<string, unknown>[],
    retenidas: [] as Array<{ id: number; motivo: string }>,
    entregados: [] as Array<{ id: number; instante: string; pagado: boolean }>,
    pagados: [] as string[],
    preparados: [] as string[],
    capi: [] as number[],
  };
  const orden: ResultadoOrden = {
    ok: true,
    shopify_order_id: 9001,
    gid: "gid://shopify/Order/9001",
    nombre: "#1050",
    total: 530000,
    nodo: { id: "gid://shopify/Order/9001" },
  };
  const deps: Deps = {
    ahora: () => AHORA,
    usuario: (t) => Promise.resolve(t === "jwt-ok" ? { id: "u-1" } : null),
    facturarDesde: () => Promise.resolve(op.facturarDesde ?? null),
    catalogo: () => Promise.resolve([{ id: "gid://shopify/Product/1", titulo: "Producto A", estado: "ACTIVE", variantes: [] }]),
    reservarClave(clave, payload) {
      st.llamadas.push("reservar");
      if (st.candados.has(clave)) return Promise.resolve(false);
      st.candados.set(clave, { procesado: false, error: null, payload });
      return Promise.resolve(true);
    },
    leerClave: (clave) => Promise.resolve(st.candados.get(clave) ?? null),
    cerrarClave(clave, datos, error) {
      st.llamadas.push(error ? "cerrar_error" : "cerrar");
      st.candados.set(clave, { ...(datos as object), procesado: true, error } as Candado);
      return Promise.resolve();
    },
    liberarClave(clave) {
      st.llamadas.push("liberar");
      st.candados.delete(clave);
      return Promise.resolve();
    },
    async crearOrden(input) {
      st.llamadas.push("crearOrden");
      st.inputs.push(input);
      const o = op.orden ?? orden;
      return typeof o === "function" ? await o() : o;
    },
    registrarPedido() {
      st.llamadas.push("registrar");
      return op.registrarFalla ? Promise.reject(new Error("db caída")) : Promise.resolve();
    },
    guardarDatosFiscales(fila) {
      st.llamadas.push("fiscal");
      st.fiscales.push(fila);
      return Promise.resolve();
    },
    omitirCapi(id) {
      st.capi.push(id);
      return Promise.resolve();
    },
    marcarPagado(gid) {
      st.llamadas.push("pagado");
      st.pagados.push(gid);
      return Promise.resolve({ ok: true });
    },
    retenerFactura(id, motivo) {
      st.llamadas.push("retener");
      if (op.retencionFalta) return Promise.resolve({ ok: false, tablaFalta: true, error: "relation does not exist" });
      st.retenidas.push({ id, motivo });
      return Promise.resolve({ ok: true });
    },
    marcarEntregado(id, instante, pagado) {
      st.llamadas.push("entregado");
      if (op.entregadoFalla) return Promise.reject(new Error("update falló"));
      st.entregados.push({ id, instante, pagado });
      return Promise.resolve();
    },
    marcarPreparado(gid) {
      st.llamadas.push("preparado");
      st.preparados.push(gid);
      return Promise.resolve({ ok: true });
    },
  };
  return { deps, st };
}

Deno.test("sin sesión → 401 y no toca Shopify", async () => {
  const { deps, st } = mock();
  const r = await manejar("", cuerpoValido(), deps);
  assertEquals(r.status, 401);
  const r2 = await manejar("jwt-vencido", cuerpoValido(), deps);
  assertEquals(r2.status, 401);
  assertEquals(st.inputs.length, 0);
});

Deno.test("acción inválida → 400; catálogo con sesión → 200", async () => {
  const { deps } = mock();
  assertEquals((await manejar("jwt-ok", { accion: "borrar" }, deps)).status, 400);
  const c = await manejar("jwt-ok", { accion: "catalogo" }, deps);
  assertEquals(c.status, 200);
  assertEquals((c.body.productos as unknown[]).length, 1);
});

Deno.test("el servidor valida de nuevo: RUC con DV mal → 400 sin crear nada", async () => {
  const { deps, st } = mock();
  const r = await manejar("jwt-ok", cuerpoValido({ fiscal: { ruc: "1234567", dv: "0", razon_social: "X S.A." } }), deps);
  assertEquals(r.status, 400);
  assert(String(r.body.error).includes("RUC"));
  assertEquals(st.llamadas, []);
});

Deno.test("contra entrega contado: tags MAYORISTA + CONFIRMADO, atributos, datos fiscales; no se marca pagado", async () => {
  const { deps, st } = mock();
  const r = await manejar("jwt-ok", cuerpoValido(), deps);
  assertEquals(r.status, 200);
  assertEquals(r.body.ok, true);
  assertEquals(r.body.shopify_order_id, 9001);
  const order = (st.inputs[0].order ?? {}) as Record<string, unknown>;
  assertEquals(order.tags, ["MAYORISTA", "CONFIRMADO"]);
  assertEquals(order.taxesIncluded, true);
  assertEquals(order.financialStatus, "PENDING");
  assertEquals(order.lineItems, [{ variantId: "gid://shopify/ProductVariant/111", quantity: 10, priceSet: { shopMoney: { amount: "50000", currencyCode: "PYG" } } }]);
  assertEquals(order.shippingLines, [{ title: "Envío", priceSet: { shopMoney: { amount: "30000", currencyCode: "PYG" } } }]);
  assert(!("email" in order), "sin email a Shopify (no manda correos)");
  const attrs = Object.fromEntries((order.customAttributes as Array<{ key: string; value: string }>).map((a) => [a.key, a.value]));
  assertEquals(attrs.Ruc, `1234567-${(cuerpoValido().fiscal as { dv: string }).dv}`);
  assertEquals(attrs["Razon social"], "EMPRESA DE PRUEBA S.A.");
  assertEquals(attrs.condicion, "contado");
  assert(!("plazo_dias" in attrs));
  const opts = st.inputs[0].options as Record<string, unknown>;
  assertEquals([opts.sendReceipt, opts.sendFulfillmentReceipt, opts.inventoryBehaviour], [false, false, "DECREMENT_OBEYING_POLICY"]);
  assertEquals(st.fiscales[0].origen, "mayorista");
  assertEquals(st.fiscales[0].cargado_por, "u-1");
  assertEquals(st.pagados, []);
  assertEquals(st.retenidas, []);
  assertEquals(st.entregados, []);
  assertEquals(st.preparados, []);
  assertEquals(st.capi, [9001]);
  // el candado guarda el pedido ANTES de los pasos que pueden fallar
  assertEquals(st.llamadas.slice(0, 4), ["reservar", "crearOrden", "cerrar", "registrar"]);
});

Deno.test("transferencia anticipada: PAGO_VERIFICADO y pagado en Shopify", async () => {
  const { deps, st } = mock();
  const r = await manejar("jwt-ok", cuerpoValido({ cobro: "transferencia_anticipada", comprobante_ref: "UENO-778" }), deps);
  assertEquals(r.status, 200);
  assertEquals((st.inputs[0].order as Record<string, unknown>).tags, ["MAYORISTA", "CONFIRMADO", "PAGO_VERIFICADO"]);
  assertEquals(st.pagados, ["gid://shopify/Order/9001"]);
  assertEquals(r.body.pagado, true);
});

Deno.test("crédito: tag CREDITO, atributo plazo_dias y nota NO COBRAR", async () => {
  const { deps, st } = mock();
  await manejar("jwt-ok", cuerpoValido({ condicion: "credito", plazo_dias: 30 }), deps);
  const order = st.inputs[0].order as Record<string, unknown>;
  assertEquals(order.tags, ["MAYORISTA", "CONFIRMADO", "CREDITO"]);
  assert((order.customAttributes as Array<{ key: string; value: string }>).some((a) => a.key === "plazo_dias" && a.value === "30"));
  assert(String(order.note).includes("NO COBRAR"));
  assertEquals(st.fiscales[0].condicion, "credito");
  assertEquals(st.fiscales[0].plazo_dias, 30);
});

Deno.test("doble clic (misma clave): un solo pedido en Shopify, el segundo devuelve el mismo", async () => {
  const { deps, st } = mock();
  const [a, b] = await Promise.all([manejar("jwt-ok", cuerpoValido(), deps), manejar("jwt-ok", cuerpoValido(), deps)]);
  assertEquals(st.inputs.length, 1);
  const estados = [a.status, b.status].sort();
  // El segundo llega mientras el primero crea (409) o después (200 repetido): nunca dos pedidos.
  assert(estados[0] === 200);
  const c = await manejar("jwt-ok", cuerpoValido(), deps);
  assertEquals(c.status, 200);
  assertEquals(c.body.repetido, true);
  assertEquals(c.body.shopify_order_id, 9001);
  assertEquals(st.inputs.length, 1);
});

Deno.test("Shopify rechaza (userErrors) → libera la clave y se puede reintentar", async () => {
  const { deps, st } = mock({ orden: { ok: false, definitivo: true, error: "lineItems.0: sin stock" } });
  const r = await manejar("jwt-ok", cuerpoValido(), deps);
  assertEquals(r.status, 422);
  assertEquals(r.body.reintentable, true);
  assertEquals(st.candados.size, 0);
  assertEquals(st.fiscales.length, 0);
});

Deno.test("error de red (no se sabe si se creó) → la clave queda bloqueada con el error, no se duplica", async () => {
  const { deps, st } = mock({ orden: { ok: false, definitivo: false, error: "timeout" } });
  const r = await manejar("jwt-ok", cuerpoValido(), deps);
  assertEquals(r.status, 502);
  const r2 = await manejar("jwt-ok", cuerpoValido(), deps);
  assertEquals(r2.status, 409);
  assert(String(r2.body.error).includes("incierto"));
  assertEquals(st.inputs.length, 1);
});

Deno.test("anterior al corte: ANTERIOR_AL_CORTE + SIN_MENSAJES, retenida ANTES de entregado, preparado al final", async () => {
  const { deps, st } = mock();
  const r = await manejar("jwt-ok", cuerpoValido({ anterior_al_corte: true, fecha_entrega: "2026-09-20" }), deps);
  assertEquals(r.status, 200);
  const order = st.inputs[0].order as Record<string, unknown>;
  assertEquals(order.tags, ["MAYORISTA", "CONFIRMADO", "ANTERIOR_AL_CORTE", "SIN_MENSAJES"]);
  assertEquals((st.inputs[0].options as Record<string, unknown>).inventoryBehaviour, "BYPASS");
  assertEquals(st.retenidas, [{ id: 9001, motivo: "anterior_al_corte" }]);
  assertEquals(st.entregados, [{ id: 9001, instante: "2026-09-20T15:00:00.000Z", pagado: true }]);
  assertEquals(st.pagados.length, 1, "cobrado → pagado en Shopify");
  const i = (x: string) => st.llamadas.indexOf(x);
  assert(i("retener") < i("entregado") && i("entregado") < i("preparado"));
  assertEquals(r.body.entregado, true);
  assertEquals(r.body.avisos, []);
});

Deno.test("anterior al corte: si no se pudo marcar entregado, NO se marca preparado (evita 'tu pedido ya salió')", async () => {
  const { deps, st } = mock({ entregadoFalla: true });
  const r = await manejar("jwt-ok", cuerpoValido({ anterior_al_corte: true, fecha_entrega: "2026-09-20" }), deps);
  assertEquals(r.status, 200);
  assertEquals(st.preparados, []);
  assert((r.body.avisos as string[]).some((a) => a.includes("entregado")));
});

Deno.test("anterior al corte: si el registro falla, no se marca entregado ni preparado", async () => {
  const { deps, st } = mock({ registrarFalla: true });
  const r = await manejar("jwt-ok", cuerpoValido({ anterior_al_corte: true, fecha_entrega: "2026-09-20" }), deps);
  assertEquals(st.entregados, []);
  assertEquals(st.preparados, []);
  assertEquals(st.capi, []);
  assert((r.body.avisos as string[]).length >= 2);
});

Deno.test("anterior al corte sin la tabla de P1: el pedido se crea igual y avisa que NO quedó retenido", async () => {
  const { deps } = mock({ retencionFalta: true });
  const r = await manejar("jwt-ok", cuerpoValido({ anterior_al_corte: true, fecha_entrega: "2026-09-20" }), deps);
  assertEquals(r.status, 200);
  assert((r.body.avisos as string[]).some((a) => a.includes("facturas_retenidas")));
});

Deno.test("anterior al corte con fecha posterior al corte → 400", async () => {
  const { deps, st } = mock({ facturarDesde: "2026-10-01T00:00:00-03:00" });
  const r = await manejar("jwt-ok", cuerpoValido({ anterior_al_corte: true, fecha_entrega: "2026-10-03" }), deps);
  assertEquals(r.status, 400);
  assertEquals(st.inputs.length, 0);
});

Deno.test("total distinto en Shopify → aviso", async () => {
  const { deps } = mock({
    orden: { ok: true, shopify_order_id: 1, gid: "gid://shopify/Order/1", nombre: "#1", total: 999, nodo: {} },
  });
  const r = await manejar("jwt-ok", cuerpoValido(), deps);
  assert((r.body.avisos as string[]).some((a) => a.includes("Shopify calculó")));
});

Deno.test("inputOrderCreate sin envío → sin shippingLines; tagsDelPedido combinado", () => {
  const v = validarPedido(cuerpoValido({ envio: 0 }), { hoy: "2026-10-10" });
  assert(v.ok);
  if (!v.ok) return;
  assertEquals((inputOrderCreate(v.pedido).order as Record<string, unknown>).shippingLines, []);
  const v2 = validarPedido(cuerpoValido({ cobro: "transferencia_anticipada", anterior_al_corte: true, fecha_entrega: "2026-09-01" }), { hoy: "2026-10-10" });
  assert(v2.ok);
  if (v2.ok) assertEquals(tagsDelPedido(v2.pedido), ["MAYORISTA", "CONFIRMADO", "PAGO_VERIFICADO", "ANTERIOR_AL_CORTE", "SIN_MENSAJES"]);
});
