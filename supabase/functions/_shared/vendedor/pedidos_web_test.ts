// Pruebas de pedidos_web.ts (buscar_pedido, modificar_pedido, guardar_factura). Datos inventados: repo público.
import { assert, assertEquals, assertMatch, assertStringIncludes } from "@std/assert";
import { _limpiarCacheCatalogo } from "./herramientas.ts";
import { digitoVerificadorRuc } from "../facturacion.ts";
import {
  buscarPedidoHerr,
  calcularModificacion,
  type CandidatoPedido,
  confirmoResumen,
  type DepsPedidosWeb,
  elegirCamino,
  esPendienteSinChat,
  guardarFacturaHerr,
  inputBorradorReemplazo,
  mezclarAtributos,
  type ModificacionPedido,
  modificarPedidoHerr,
  nombreCorto,
  type PedidoWeb,
  planEdicion,
  puntajeNombre,
  tagNoSeCopia,
  tagReemplaza,
  tagReemplazado,
  telefonoEnmascarado,
  textoReemplazo,
  textoTelegramModificacion,
  validarFactura,
} from "./pedidos_web.ts";
import { CLIENTE, configPrueba, CONV, ctxPrueba, depsPrueba, PRODUCTOS, TEL } from "./prueba_utiles.ts";
import type { CtxTurno, DepsHerramientas, ProductoShopify } from "./tipos.ts";

// ---------- datos ----------

const PACK: ProductoShopify = {
  id: "gid://shopify/Product/3",
  handle: "pack-prueba",
  title: "Pack de prueba",
  imagen: null,
  variantes: [{ id: "gid://shopify/ProductVariant/31", title: "Default Title", price: 120000, disponible: true }],
};
const AGOTADO: ProductoShopify = {
  id: "gid://shopify/Product/4",
  handle: "agotado-prueba",
  title: "Botella de prueba",
  imagen: null,
  variantes: [{ id: "gid://shopify/ProductVariant/41", title: "Default Title", price: 79000, disponible: false }],
};
const CATALOGO = [...PRODUCTOS, PACK, AGOTADO];

function pedido(over: Partial<PedidoWeb> = {}): PedidoWeb {
  return {
    shopify_order_id: 7000001,
    gid: "gid://shopify/Order/7000001",
    nombre: "#1072",
    creado_en: "2026-10-06T14:00:00Z",
    telefono: TEL,
    email: null,
    cliente_id: CLIENTE,
    customer_gid: "gid://shopify/Customer/9",
    nombre_cliente: "Ana Prueba",
    total: 112000,
    envio: 33000,
    cancelado: false,
    despachado: false,
    estado_confirmacion: "confirmado",
    app: "Releasit COD Form",
    merchant_editable: false,
    tags: ["releasit_cod_form", "CONFIRMADO"],
    atributos: [{ key: "Ruc", value: "" }, { key: "utm_source", value: "facebook" }],
    nota: "Nota del cliente",
    direccion: { firstName: "Ana", lastName: "", address1: "Calle Falsa 123", address2: null, city: "Ciudad del Este", countryCode: "PY", phone: TEL },
    lineas: [{ line_item_id: "gid://shopify/LineItem/501", variante_id: "gid://shopify/ProductVariant/11", handle: "tiras-prueba", titulo: "Tiras Nasales de prueba", cantidad: 1, total: 79000 }],
    ...over,
  };
}

type RegPw = {
  modificaciones: ModificacionPedido[];
  vinculos: Array<{ conv: string; id: number; fuente: string }>;
  ediciones: Array<{ gid: string; plan: unknown; total: number }>;
  borradores: Record<string, unknown>[];
  etiquetas: Array<{ gid: string; tags: string[] }>;
  cancelados: string[];
  atributos: Array<{ gid: string; nuevos: unknown }>;
  candados: Array<[number, number]>;
};

function depsPw(o: {
  pedidos?: PedidoWeb[];
  candidatos?: CandidatoPedido[];
  vinculados?: number[];
  conChat?: number[];
  editar?: { ok: boolean; error?: string; no_editable?: boolean; total?: number };
  cancelarOk?: boolean;
  reemplazoExistente?: { shopify_order_id: number; nombre: string } | null;
  tomarFalla?: boolean;
} = {}): { pw: DepsPedidosWeb; reg: RegPw } {
  const reg: RegPw = { modificaciones: [], vinculos: [], ediciones: [], borradores: [], etiquetas: [], cancelados: [], atributos: [], candados: [] };
  const pedidos = new Map((o.pedidos ?? [pedido()]).map((p) => [p.shopify_order_id, p]));
  let n = 0;
  let ultimoNuevo = 1079;
  const pw: DepsPedidosWeb = {
    candidatos: (f) => {
      let l = o.candidatos ?? [cand()];
      if (f.numero) l = l.filter((c) => c.nombre === `#${f.numero}`);
      if (f.desdeISO) l = l.filter((c) => c.creado_en >= f.desdeISO!);
      return Promise.resolve(l.slice(0, f.limite ?? 50));
    },
    pedidoCompleto: (id) => Promise.resolve(pedidos.get(id) ?? null),
    vinculados: () => Promise.resolve([...(o.vinculados ?? []), ...reg.vinculos.map((v) => v.id)]),
    pedidosConChat: (ids) => Promise.resolve(ids.filter((i) => (o.conChat ?? []).includes(i))),
    vincular: (conv, id, fuente) => (reg.vinculos.push({ conv, id, fuente }), Promise.resolve()),
    guardarModificacion: (fila) => {
      const ex = fila.id ? reg.modificaciones.find((m) => m.id === fila.id) : undefined;
      if (ex) return Promise.resolve(Object.assign(ex, fila));
      const nueva = { ...fila, id: `mod-${++n}`, creado_en: "2026-10-06T14:59:00Z" } as ModificacionPedido;
      reg.modificaciones.push(nueva);
      return Promise.resolve(nueva);
    },
    modificacion: (id) => Promise.resolve(reg.modificaciones.find((m) => m.id === id) ?? null),
    ultimaModificacion: () => Promise.resolve(reg.modificaciones[reg.modificaciones.length - 1] ?? null),
    tomarModificacion: (id) => {
      const m = reg.modificaciones.find((x) => x.id === id);
      if (o.tomarFalla || !m || m.estado !== "resumen") return Promise.resolve(false);
      m.estado = "ejecutando";
      return Promise.resolve(true);
    },
    editarOrden: (gid, plan, total) => (reg.ediciones.push({ gid, plan, total }), Promise.resolve(o.editar ?? { ok: true, total })),
    crearDesdeBorrador: (input) => {
      reg.borradores.push(input);
      ultimoNuevo++;
      return Promise.resolve({ ok: true, shopify_order_id: 7000000 + ultimoNuevo, nombre: `#${ultimoNuevo}`, total: null });
    },
    reemplazoExistente: () => Promise.resolve(o.reemplazoExistente ?? null),
    etiquetar: (gid, tags) => (reg.etiquetas.push({ gid, tags }), Promise.resolve({ ok: true })),
    cancelarOrden: (gid) => (reg.cancelados.push(gid), Promise.resolve(o.cancelarOk === false ? { ok: false, error: "boom" } : { ok: true })),
    actualizarAtributos: (gid, nuevos) => (reg.atributos.push({ gid, nuevos }), Promise.resolve({ ok: true })),
    transferirCandadosMeta: (a, b) => (reg.candados.push([a, b]), Promise.resolve([`meta_purchase:${b}`])),
  };
  return { pw, reg };
}

function armar(oPw: Parameters<typeof depsPw>[0] = {}, over: Partial<DepsHerramientas> = {}, entradas: string[] = []) {
  _limpiarCacheCatalogo();
  const { deps, reg } = depsPrueba({ catalogoShopify: () => Promise.resolve(CATALOGO), entradasDesde: () => Promise.resolve(entradas), ...over });
  const { pw, reg: regPw } = depsPw(oPw);
  const d = { ...deps, pedidosWeb: pw } as DepsHerramientas;
  return { deps: d, reg, regPw };
}

const ctx = (over: Partial<CtxTurno> = {}) => ctxPrueba(over);
const modificar = (i: Record<string, unknown>, c: CtxTurno, d: DepsHerramientas) => modificarPedidoHerr.ejecutor(i, c, d);
const tapConfirmo = (id: string) => `[pedido #1072 de la tienda, confirmado, sin despachar]\n[botón] Confirmo (vend_mod:${id})`;

// ---------- precios ----------

Deno.test("precios: 1 → 2 da 158.000 (oferta ×2 + envío)", () => {
  const c = calcularModificacion([{ handle: "tiras-prueba", cantidad: 2 }], pedido(), CATALOGO, ctx());
  assert(c.ok);
  assertEquals(c.total, 158000);
  assertEquals(c.lineas[0].total, 125000);
  assertEquals(c.envio, 33000);
});

Deno.test("precios: 1 → 3 da 188.000", () => {
  const c = calcularModificacion([{ handle: "tiras-prueba", cantidad: 3 }], pedido(), CATALOGO, ctx());
  assert(c.ok);
  assertEquals(c.total, 188000);
});

Deno.test("precios: agregar otro producto = suma + 33.000 de envío", () => {
  const c = calcularModificacion([{ handle: "tiras-prueba", cantidad: 1 }, { handle: "raspador-prueba", cantidad: 1 }], pedido(), CATALOGO, ctx());
  assert(c.ok);
  assertEquals(c.total, 79000 + 79000 + 33000);
});

Deno.test("precios: el pack no tiene ×2 (2 × precio + envío)", () => {
  const c = calcularModificacion([{ handle: "pack-prueba", cantidad: 2 }], pedido(), CATALOGO, ctx());
  assert(c.ok);
  assertEquals(c.total, 240000 + 33000);
});

Deno.test("precios: retiro en la oficina no suma envío", () => {
  const c = calcularModificacion([{ handle: "tiras-prueba", cantidad: 2 }], pedido({ tags: ["RETIRO_EN_CASA"], total: 79000 }), CATALOGO, ctx());
  assert(c.ok);
  assertEquals(c.total, 125000);
});

Deno.test("precios: rechaza sin cambios, cantidad > máximo, desconocido, repetido y sin stock", () => {
  const sin = calcularModificacion([{ handle: "tiras-prueba", cantidad: 1 }], pedido(), CATALOGO, ctx());
  assert(!sin.ok && sin.error.startsWith("sin_cambios"));
  const mucho = calcularModificacion([{ handle: "tiras-prueba", cantidad: 4 }], pedido(), CATALOGO, ctx());
  assert(!mucho.ok && mucho.error.startsWith("cantidad_invalida"));
  const des = calcularModificacion([{ handle: "nada", cantidad: 1 }], pedido(), CATALOGO, ctx());
  assert(!des.ok && des.error.startsWith("producto_desconocido"));
  const rep = calcularModificacion([{ handle: "tiras-prueba", cantidad: 1 }, { handle: "tiras-prueba", cantidad: 1 }], pedido(), CATALOGO, ctx());
  assert(!rep.ok && rep.error.startsWith("producto_repetido"));
  const ago = calcularModificacion([{ handle: "tiras-prueba", cantidad: 1 }, { handle: "agotado-prueba", cantidad: 1 }], pedido(), CATALOGO, ctx());
  assert(!ago.ok && ago.error.startsWith("sin_stock"));
});

Deno.test("precios: mantiene la variante que ya tenía el pedido (color)", () => {
  const p = pedido({ lineas: [{ ...pedido().lineas[0], variante_id: "gid://shopify/ProductVariant/12" }] });
  const c = calcularModificacion([{ handle: "tiras-prueba", cantidad: 2 }], p, CATALOGO, ctx());
  assert(c.ok);
  assertEquals(c.lineas[0].variante_id, "gid://shopify/ProductVariant/12");
});

// ---------- camino, etiquetas y textos ----------

Deno.test("camino: Voltra OS edita, Releasit reemplaza, tienda online editable edita", () => {
  assertEquals(elegirCamino({ app: "Voltra OS", merchant_editable: false }), "editar");
  assertEquals(elegirCamino({ app: "Releasit COD Form", merchant_editable: false }), "reemplazar");
  assertEquals(elegirCamino({ app: "Releasit COD Form", merchant_editable: true }), "reemplazar");
  assertEquals(elegirCamino({ app: "Online Store", merchant_editable: true }), "editar");
  assertEquals(elegirCamino({ app: null, merchant_editable: null }), "reemplazar");
});

Deno.test("etiquetas y Telegram", () => {
  assertEquals(tagReemplaza("#1072"), "REEMPLAZA_A_#1072");
  assertEquals(tagReemplazado("1080"), "REEMPLAZADO_POR_#1080");
  assertEquals(textoReemplazo("#1080", "#1072"), "#1080 reemplaza a #1072");
  const t = textoTelegramModificacion({
    camino: "reemplazar", viejo: "#1072", nuevo: "#1080", cliente: "Ana",
    d: { pedido_nombre: "#1072", camino: "reemplazar", lineas_antes: [{ titulo: "Tiras", cantidad: 1, total: 79000 }], total_antes: 112000, lineas: [{ handle: "t", titulo: "Tiras", variante_id: "v", cantidad: 2, total: 125000 }], envio: 33000, total: 158000 },
  });
  assertEquals(t.split("\n")[0], "🔁 <b>#1080 reemplaza a #1072</b>");
  assertStringIncludes(t, "Gs 158.000");
  assert(tagNoSeCopia("A_CORREGIR") && tagNoSeCopia("CANCELADO_CLIENTE") && tagNoSeCopia("REEMPLAZADO_POR_#1") && !tagNoSeCopia("ORIGEN_WHATSAPP"));
});

Deno.test("borrador de reemplazo: taxExempt, precios fijos, etiquetas, atributos y dirección", () => {
  const p = pedido({ tags: ["releasit_cod_form", "A_CORREGIR", "CONFIRMADO", "SIN_COBERTURA"] });
  const c = calcularModificacion([{ handle: "tiras-prueba", cantidad: 3 }], p, CATALOGO, ctx());
  assert(c.ok);
  const { input } = inputBorradorReemplazo(p, { pedido_nombre: p.nombre, camino: "reemplazar", lineas_antes: [], total_antes: p.total, lineas: c.lineas, envio: c.envio, total: c.total }, "mod-9") as { input: Record<string, unknown> };
  assertEquals(input.taxExempt, true);
  const lineas = input.lineItems as Array<{ quantity: number; priceOverride: { amount: string; currencyCode: string } }>;
  // 155.000 / 3 no es exacto: 2 × 51.666 + 1 × 51.668 (misma regla que crear_pedido_cod).
  assertEquals(lineas.map((l) => [l.quantity, l.priceOverride.amount]), [[2, "51666"], [1, "51668"]]);
  assertEquals(lineas.reduce((a, l) => a + Number(l.priceOverride.amount) * l.quantity, 0) + 33000, 188000);
  assertEquals((input.shippingLine as { priceWithCurrency: { amount: string } }).priceWithCurrency.amount, "33000");
  assertEquals(input.tags, ["releasit_cod_form", "SIN_COBERTURA", "CONFIRMADO", "REEMPLAZA_A_#1072"]);
  const attrs = input.customAttributes as Array<{ key: string; value: string }>;
  assert(attrs.some((a) => a.key === "utm_source" && a.value === "facebook"));
  assert(attrs.some((a) => a.key === "reemplaza_a" && a.value === "#1072"));
  assertEquals((input.shippingAddress as { lastName: string }).lastName, "-");
  assertEquals(input.phone, TEL);
  assertStringIncludes(String(input.note), "Reemplaza al pedido #1072");
});

Deno.test("plan de edición: 1 → 2 quita la línea y agrega 2 unidades a 62.500", () => {
  const p = pedido({ app: "Voltra OS" });
  const c = calcularModificacion([{ handle: "tiras-prueba", cantidad: 2 }], p, CATALOGO, ctx());
  assert(c.ok);
  const plan = planEdicion(p, c.lineas);
  assert(plan.ok);
  assertEquals(plan.plan.quitar, ["gid://shopify/LineItem/501"]);
  assertEquals(plan.plan.agregar.map((u) => u.precio), [62500, 62500]);
  // Agregar otro producto: la línea vieja queda igual.
  const c2 = calcularModificacion([{ handle: "tiras-prueba", cantidad: 1 }, { handle: "raspador-prueba", cantidad: 1 }], p, CATALOGO, ctx());
  assert(c2.ok);
  const plan2 = planEdicion(p, c2.lineas);
  assert(plan2.ok);
  assertEquals(plan2.plan.quitar, []);
  assertEquals(plan2.plan.agregar.map((u) => [u.variante_id, u.precio]), [["gid://shopify/ProductVariant/21", 79000]]);
});

// ---------- modificar_pedido: flujo ----------

Deno.test("modificar: paso 1 manda resumen con Confirmo/Corregir y guarda la modificación", async () => {
  const { deps, reg, regPw } = armar();
  const r = await modificar({ confirmar: false, pedido: "#1072", items: [{ handle: "tiras-prueba", cantidad: 2 }] }, ctx(), deps);
  assertEquals(r.resultado.ok, true);
  assertEquals(r.terminal, true);
  assertEquals(r.resultado.total, 158000);
  assertEquals(regPw.modificaciones[0].estado, "resumen");
  const ia = reg.interactivos[0].interactive as { body: { text: string }; action: { buttons: Array<{ reply: { id: string; title: string } }> } };
  assertEquals(ia.action.buttons.map((b) => b.reply.id), ["vend_mod:mod-1", "vend_modc:mod-1"]);
  assertEquals(ia.action.buttons.map((b) => b.reply.title), ["Confirmo", "Corregir"]);
  assertStringIncludes(ia.body.text, "Total Gs 158.000");
  assertStringIncludes(ia.body.text, "número de pedido nuevo");
  assertEquals(regPw.borradores.length + regPw.ediciones.length, 0);
});

Deno.test("modificar: se niega con pedido despachado, cancelado, reemplazado o de otro cliente", async () => {
  for (const [over, codigo] of [
    [{ despachado: true }, "ya_despachado"],
    [{ cancelado: true }, "pedido_cancelado"],
    [{ tags: ["REEMPLAZADO_POR_#1080"] }, "ya_reemplazado"],
    [{ cliente_id: "otro", telefono: "+595981999999" }, "pedido_de_otro_cliente"],
  ] as Array<[Partial<PedidoWeb>, string]>) {
    const { deps, reg } = armar({ pedidos: [pedido(over)], candidatos: [cand()] });
    const r = await modificar({ confirmar: false, pedido: "1072", items: [{ handle: "tiras-prueba", cantidad: 2 }] }, ctx(), deps);
    assertEquals(r.esError, true, codigo);
    assertMatch(String(r.resultado.error), new RegExp(`^${codigo}`));
    assertEquals(reg.interactivos.length, 0);
  }
});

Deno.test("modificar: un pedido de otro teléfono encontrado con buscar_pedido en este chat sí se puede", async () => {
  const { deps } = armar({ pedidos: [pedido({ cliente_id: "otro", telefono: "+595981999999" })], candidatos: [cand()], vinculados: [7000001] });
  const r = await modificar({ confirmar: false, pedido: "1072", items: [{ handle: "tiras-prueba", cantidad: 2 }] }, ctx(), deps);
  assertEquals(r.resultado.ok, true);
});

async function conResumen(oPw: Parameters<typeof depsPw>[0] = {}, entradas: string[] = []) {
  const a = armar(oPw, {}, entradas);
  await modificar({ confirmar: false, pedido: "#1072", items: [{ handle: "tiras-prueba", cantidad: 2 }] }, ctx(), a.deps);
  return a;
}

Deno.test("modificar: paso 2 sin Confirmo (ni sí) no ejecuta", async () => {
  const { deps, regPw } = await conResumen();
  const r = await modificar({ confirmar: true }, ctx({ textoEntrada: "y cuánto sale?" }), deps);
  assertMatch(String(r.resultado.error), /^falta_confirmo/);
  assertEquals(regPw.borradores.length, 0);
  assertEquals(regPw.modificaciones[0].estado, "resumen");
});

Deno.test("modificar: Corregir u otro botón no confirman; vencido tampoco", async () => {
  const a = await conResumen();
  let r = await modificar({ confirmar: true }, ctx({ textoEntrada: "[botón] Corregir (vend_modc:mod-1)" }), a.deps);
  assertMatch(String(r.resultado.error), /^falta_confirmo/);
  r = await modificar({ confirmar: true }, ctx({ textoEntrada: "[botón] Confirmo (vend_mod:mod-999)" }), a.deps);
  assertMatch(String(r.resultado.error), /^falta_confirmo/);
  r = await modificar({ confirmar: true }, ctx({ textoEntrada: tapConfirmo("mod-1"), ahora: new Date("2026-10-07T15:00:00Z") }), a.deps);
  assertMatch(String(r.resultado.error), /^resumen_vencido/);
  assertEquals(a.regPw.borradores.length, 0);
});

Deno.test("modificar: Releasit → borrador + etiqueta + cancelación + candados de Meta + Telegram", async () => {
  const { deps, reg, regPw } = await conResumen();
  const r = await modificar({ confirmar: true }, ctx({ textoEntrada: tapConfirmo("mod-1") }), deps);
  assertEquals(r.resultado.ok, true);
  assertEquals(r.resultado.pedido, "#1080");
  assertEquals(r.resultado.pedido_anterior, "#1072");
  assertStringIncludes(String(r.resultado.texto_respuesta), "#1080 (reemplaza al #1072)");
  assertEquals(regPw.borradores.length, 1);
  assertEquals(regPw.ediciones.length, 0);
  assertEquals(regPw.etiquetas, [{ gid: "gid://shopify/Order/7000001", tags: ["REEMPLAZADO_POR_#1080"] }]);
  assertEquals(regPw.cancelados, ["gid://shopify/Order/7000001"]);
  assertEquals(regPw.candados, [[7000001, 7001080]]);
  assertEquals(regPw.modificaciones[0].estado, "hecho");
  assertEquals(regPw.modificaciones[0].nuevo_nombre, "#1080");
  assert(reg.avisos.some((a) => a.texto.startsWith("🔁 <b>#1080 reemplaza a #1072</b>")));
  assert(regPw.vinculos.some((v) => v.id === 7001080 && v.fuente === "modificacion"));
  // No es un pedido nuevo para el orquestador (no dispara permiso de ofertas ni oferta de prioridad).
  assertEquals(r.pedidoCreado, undefined);
});

Deno.test("modificar: un sí escrito después del resumen confirma (como crear_pedido_cod)", async () => {
  const { deps, regPw } = await conResumen();
  const r = await modificar({ confirmar: true }, ctx({ textoEntrada: "[pedido #1072 de la tienda, confirmado]\nsi dale" }), deps);
  assertEquals(r.resultado.ok, true);
  assertEquals(regPw.borradores.length, 1);
});

Deno.test("modificar: sí y después Corregir en los mensajes desde el resumen → no confirma", async () => {
  const { deps } = await conResumen({}, ["si", "[botón] Corregir (vend_modc:mod-1)"]);
  const r = await modificar({ confirmar: true }, ctx({ textoEntrada: "mmm" }), deps);
  assertMatch(String(r.resultado.error), /^falta_confirmo/);
});

Deno.test("modificar: pedido del bot (Voltra OS) → edición directa, mismo número", async () => {
  const { deps, reg, regPw } = await conResumen({ pedidos: [pedido({ app: "Voltra OS", tags: ["ORIGEN_WHATSAPP", "CONFIRMADO"] })] });
  const r = await modificar({ confirmar: true }, ctx({ textoEntrada: tapConfirmo("mod-1") }), deps);
  assertEquals(r.resultado.ok, true);
  assertEquals(r.resultado.pedido, "#1072");
  assertEquals(regPw.ediciones.length, 1);
  assertEquals(regPw.ediciones[0].total, 158000);
  assertEquals(regPw.borradores.length + regPw.cancelados.length, 0);
  assert(reg.avisos.some((a) => a.texto.startsWith("✏️ <b>#1072 modificado</b>")));
});

Deno.test("modificar: si Shopify no deja editar, cae a reemplazo", async () => {
  const { deps, regPw } = await conResumen({ pedidos: [pedido({ app: "Voltra OS" })], editar: { ok: false, no_editable: true, error: "The order cannot be edited" } });
  const r = await modificar({ confirmar: true }, ctx({ textoEntrada: tapConfirmo("mod-1") }), deps);
  assertEquals(r.resultado.reemplazado, true);
  assertEquals(regPw.borradores.length, 1);
});

Deno.test("modificar: edición que falla por otra cosa → fallido + Telegram, sin reemplazo", async () => {
  const { deps, reg, regPw } = await conResumen({ pedidos: [pedido({ app: "Voltra OS" })], editar: { ok: false, error: "total_no_coincide" } });
  const r = await modificar({ confirmar: true }, ctx({ textoEntrada: tapConfirmo("mod-1") }), deps);
  assertMatch(String(r.resultado.error), /^edicion_fallida/);
  assertEquals(regPw.modificaciones[0].estado, "fallido");
  assertEquals(regPw.borradores.length, 0);
  assert(reg.avisos.some((a) => a.texto.includes("Falló un cambio de pedido")));
});

Deno.test("idempotencia: doble Confirmo no crea dos pedidos", async () => {
  const { deps, regPw } = await conResumen();
  const c = ctx({ textoEntrada: tapConfirmo("mod-1") });
  const r1 = await modificar({ confirmar: true }, c, deps);
  const r2 = await modificar({ confirmar: true }, c, deps);
  assertEquals(r1.resultado.ok, true);
  assertEquals(r2.resultado.ya_hecho, true);
  assertEquals(regPw.borradores.length, 1);
  assertEquals(regPw.cancelados.length, 1);
});

Deno.test("idempotencia: dos turnos a la vez → el que no toma la fila no ejecuta", async () => {
  const { deps, regPw } = await conResumen({ tomarFalla: true });
  const r = await modificar({ confirmar: true }, ctx({ textoEntrada: tapConfirmo("mod-1") }), deps);
  assertMatch(String(r.resultado.error), /^en_proceso/);
  assertEquals(regPw.borradores.length, 0);
});

Deno.test("idempotencia: si ya existe un REEMPLAZA_A_ en Shopify, no se crea otro", async () => {
  const { deps, regPw } = await conResumen({ reemplazoExistente: { shopify_order_id: 7001090, nombre: "#1090" } });
  const r = await modificar({ confirmar: true }, ctx({ textoEntrada: tapConfirmo("mod-1") }), deps);
  assertEquals(r.resultado.pedido, "#1090");
  assertEquals(regPw.borradores.length, 0);
});

Deno.test("modificar: si no se puede cancelar el original queda 'parcial' y va alerta", async () => {
  const { deps, reg, regPw } = await conResumen({ cancelarOk: false });
  const r = await modificar({ confirmar: true }, ctx({ textoEntrada: tapConfirmo("mod-1") }), deps);
  assertEquals(r.resultado.cancelado_original, false);
  assertEquals(regPw.modificaciones[0].estado, "parcial");
  assert(reg.avisos.some((a) => a.texto.startsWith("🚨") && a.texto.includes("NO despaches #1072")));
});

Deno.test("modificar: el pedido salió entre el resumen y el Confirmo → no ejecuta", async () => {
  const p = pedido();
  const a = await conResumen({ pedidos: [p] });
  p.despachado = true;
  const r = await modificar({ confirmar: true }, ctx({ textoEntrada: tapConfirmo("mod-1") }), a.deps);
  assertMatch(String(r.resultado.error), /^ya_despachado/);
  assertEquals(a.regPw.borradores.length, 0);
  assertEquals(a.regPw.modificaciones[0].estado, "fallido");
});

Deno.test("modificar: sin deps.pedidosWeb no rompe", async () => {
  const { deps } = depsPrueba();
  const r = await modificar({ confirmar: false }, ctx(), deps);
  assertMatch(String(r.resultado.error), /^no_disponible/);
});

Deno.test("confirmoResumen: botón con marcas antepuestas, sí escrito, otro botón", () => {
  const acept = configPrueba().aceptaciones;
  assert(confirmoResumen("mod-1", tapConfirmo("mod-1"), [], acept));
  assert(confirmoResumen("mod-1", "[pedido #1 de la tienda]\nDale", [], acept));
  assert(!confirmoResumen("mod-1", "[botón] Sí (vend_conf:pc-1)", [], acept));
  assert(!confirmoResumen("mod-1", "[botón] Corregir (vend_modc:mod-1)", ["si"], acept));
  assert(confirmoResumen("mod-1", "?", ["[botón] Confirmo (vend_mod:mod-1)"], acept));
});

// ---------- buscar_pedido ----------

function cand(over: Partial<CandidatoPedido> = {}): CandidatoPedido {
  return {
    shopify_order_id: 7000001, nombre: "#1072", telefono: "+595981000123", cliente_id: null, nombre_cliente: "José Pérez",
    creado_en: "2026-10-06T14:50:00Z", estado_confirmacion: "pendiente", total: 112000, cancelado: false, conversacion_id: null, ...over,
  };
}

Deno.test("buscar: por número, con teléfono enmascarado y nombre corto; queda vinculado", async () => {
  const { deps, regPw } = armar({ candidatos: [cand()], pedidos: [pedido({ telefono: "+595981000123", nombre_cliente: "José Pérez" })] });
  const r = await buscarPedidoHerr.ejecutor({ numero: "#1072" }, ctx(), deps);
  const ps = r.resultado.pedidos as Array<Record<string, unknown>>;
  assertEquals(ps.length, 1);
  assertEquals(ps[0].pedido, "#1072");
  assertEquals(ps[0].telefono, "termina en 123");
  assertEquals(ps[0].a_nombre_de, "José P.");
  assertEquals(ps[0].productos, "Tiras Nasales de prueba x1");
  assertEquals(ps[0].origen, "web (Releasit COD Form)");
  assertEquals(ps[0].despachado, false);
  assert(!JSON.stringify(r.resultado).includes("777123"));
  assertEquals(regPw.vinculos, [{ conv: CONV, id: 7000001, fuente: "busqueda" }]);
});

Deno.test("buscar: por nombre sin tildes, hasta 3, varios no vinculan", async () => {
  const lista = [
    cand({ shopify_order_id: 1, nombre: "#1", nombre_cliente: "José Pérez" }),
    cand({ shopify_order_id: 2, nombre: "#2", nombre_cliente: "Jose Perez Gómez" }),
    cand({ shopify_order_id: 3, nombre: "#3", nombre_cliente: "María López" }),
  ];
  const { deps, regPw } = armar({ candidatos: lista, pedidos: [] });
  const r = await buscarPedidoHerr.ejecutor({ nombre: "jose perez" }, ctx(), deps);
  assertEquals((r.resultado.pedidos as unknown[]).length, 2);
  assertEquals(regPw.vinculos.length, 0);
  assertStringIncludes(String(r.resultado.nota), "varios");
});

Deno.test("buscar: recién hecho = pendiente de la última hora, sin chat y sin cancelar", async () => {
  const lista = [
    cand({ shopify_order_id: 1, nombre: "#1", creado_en: "2026-10-06T14:55:00Z" }),
    cand({ shopify_order_id: 2, nombre: "#2", creado_en: "2026-10-06T14:56:00Z", conversacion_id: "otra" }),
    cand({ shopify_order_id: 3, nombre: "#3", creado_en: "2026-10-06T14:57:00Z", cancelado: true }),
    cand({ shopify_order_id: 4, nombre: "#4", creado_en: "2026-10-06T14:58:00Z" }),
    cand({ shopify_order_id: 5, nombre: "#5", creado_en: "2026-10-06T13:00:00Z" }),
    cand({ shopify_order_id: 6, nombre: "#6", creado_en: "2026-10-06T14:59:00Z", estado_confirmacion: "confirmado" }),
  ];
  const { deps } = armar({ candidatos: lista, conChat: [4], pedidos: [] });
  const r = await buscarPedidoHerr.ejecutor({ recien_hecho: true }, ctx(), deps);
  assertEquals((r.resultado.pedidos as Array<{ pedido: string }>).map((p) => p.pedido), ["#1"]);
});

Deno.test("buscar: sin resultado pide número o teléfono", async () => {
  const { deps } = armar({ candidatos: [] });
  const r = await buscarPedidoHerr.ejecutor({ numero: "9999" }, ctx(), deps);
  assertEquals((r.resultado.pedidos as unknown[]).length, 0);
  assertStringIncludes(String(r.resultado.nota), "el número de pedido o el teléfono que pusiste");
});

Deno.test("utilidades de búsqueda", () => {
  assert(puntajeNombre("jose", "José Pérez") > 0);
  assert(puntajeNombre("perz", "José Pérez") > 0);
  assertEquals(puntajeNombre("carlos", "José Pérez"), 0);
  assertEquals(telefonoEnmascarado("+595981000123"), "termina en 123");
  assertEquals(nombreCorto("Ana María Prueba"), "Ana P.");
  assert(esPendienteSinChat(cand(), new Set()));
  assert(!esPendienteSinChat(cand({ estado_confirmacion: "confirmado" }), new Set()));
});

// ---------- guardar_factura ----------

const RUC_OK = `4012344-${digitoVerificadorRuc("4012344")}`;
const RUC_MAL = `4012344-${(digitoVerificadorRuc("4012344") + 1) % 10}`;

Deno.test("factura: RUC válido se guarda mezclando atributos, con aviso y sin derivar", async () => {
  const { deps, reg, regPw } = armar();
  const r = await guardarFacturaHerr.ejecutor({ factura: `${RUC_OK} Carlos Benítez`, pedido: "#1072" }, ctx(), deps);
  assertEquals(r.resultado.ok, true);
  assertEquals(regPw.atributos[0].nuevos, [{ key: "factura", value: `${RUC_OK} Carlos Benítez` }, { key: "Ruc", value: RUC_OK }, { key: "Razon social", value: "Carlos Benítez" }]);
  assertEquals(reg.humano.length, 0);
  assert(reg.avisos.some((a) => a.texto.startsWith("🧾 #1072")));
});

Deno.test("factura: sin número de pedido usa el último pedido del chat", async () => {
  const { deps, regPw } = armar({}, { pedidoTiendaAbierto: () => Promise.resolve({ shopify_order_id: 7000001, creado_en: "2026-10-06T14:00:00Z" }) });
  const r = await guardarFacturaHerr.ejecutor({ factura: `${RUC_OK} Carlos Benítez` }, ctx(), deps);
  assertEquals(r.resultado.ok, true);
  assertEquals(regPw.atributos[0].gid, "gid://shopify/Order/7000001");
});

Deno.test("factura: DV inválido, sin DV y sin razón → mismos mensajes que crear_pedido_cod", async () => {
  const { deps, regPw } = armar();
  let r = await guardarFacturaHerr.ejecutor({ factura: `${RUC_MAL} Carlos`, pedido: "#1072" }, ctx(), deps);
  assertMatch(String(r.resultado.error), /^ruc_invalido/);
  r = await guardarFacturaHerr.ejecutor({ factura: "4012344 Carlos Benítez", pedido: "#1072" }, ctx(), deps);
  assertMatch(String(r.resultado.error), /^ruc_sin_dv/);
  assertStringIncludes(String(r.resultado.error), RUC_OK);
  r = await guardarFacturaHerr.ejecutor({ factura: RUC_OK, pedido: "#1072" }, ctx(), deps);
  assertMatch(String(r.resultado.error), /razón social/);
  assertEquals(regPw.atributos.length, 0);
});

Deno.test("factura: factura_sin_validar guarda el texto tal cual sin Ruc", async () => {
  const { deps, regPw } = armar();
  const r = await guardarFacturaHerr.ejecutor({ factura: `${RUC_MAL} Carlos`, pedido: "#1072", factura_sin_validar: true }, ctx(), deps);
  assertEquals(r.resultado.ok, true);
  assertEquals(regPw.atributos[0].nuevos, [{ key: "factura", value: `${RUC_MAL} Carlos` }]);
});

Deno.test("factura: pedido reemplazado o de otro cliente → no", async () => {
  let a = armar({ pedidos: [pedido({ tags: ["REEMPLAZADO_POR_#1080"] })] });
  let r = await guardarFacturaHerr.ejecutor({ factura: `${RUC_OK} Carlos`, pedido: "#1072" }, ctx(), a.deps);
  assertMatch(String(r.resultado.error), /^ya_reemplazado/);
  a = armar({ pedidos: [pedido({ cliente_id: "x", telefono: "+595981999999" })], candidatos: [cand()] });
  r = await guardarFacturaHerr.ejecutor({ factura: `${RUC_OK} Carlos`, pedido: "#1072" }, ctx(), a.deps);
  assertMatch(String(r.resultado.error), /^pedido_de_otro_cliente/);
});

Deno.test("validarFactura y mezclarAtributos", () => {
  const v = validarFactura(`${RUC_OK} Carlos`, false);
  assert(v.ok && v.ruc === RUC_OK);
  assertEquals(
    mezclarAtributos([{ key: "a", value: "1" }, { key: "Factura", value: "vieja" }], [{ key: "factura", value: "nueva" }]),
    [{ key: "a", value: "1" }, { key: "factura", value: "nueva" }],
  );
});
