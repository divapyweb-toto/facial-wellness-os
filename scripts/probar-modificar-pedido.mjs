#!/usr/bin/env -S deno run -A --config supabase/functions/deno.json
// scripts/probar-modificar-pedido.mjs · Dueño: W2 (19-10) · prueba real de modificar_pedido con pedidos PRUEBA.
//
// Se corre con DENO (importa los módulos .ts del vendedor), desde la raíz de fw-os:
//   deno run -A --config supabase/functions/deno.json scripts/probar-modificar-pedido.mjs            → DRY-RUN (por defecto): solo imprime el plan
//   deno run -A --config supabase/functions/deno.json scripts/probar-modificar-pedido.mjs --ejecutar → crea, modifica y cancela de verdad
//   Opcional: --solo editar | --solo reemplazar
//
// Variables (de .env.produccion o exportadas; nunca se imprimen):
//   SHOPIFY_STORE, SHOPIFY_CLIENT_ID, SHOPIFY_CLIENT_SECRET, SUPABASE_URL, SUPABASE_SERVICE_ROLE_KEY,
//   PRUEBA_TELEFONO (+595… de prueba, con WhatsApp de Enrique), PRUEBA_CONVERSACION_ID (wa_conversaciones.id de ese
//   teléfono: la tabla wa_modificaciones_pedido la exige), PRUEBA_HANDLE (opcional: producto; si no, el 1.º disponible).
// Requiere la migración 20261019000002_modificaciones_pedido.sql aplicada.
//
// Qué hace por cada tipo (1 pedido de cada uno):
//   1. orderCreate de 1 unidad con tags PRUEBA + PRUEBA_E2E + CONFIRMADO (PRUEBA_E2E: ni el webhook ni el cron mandan
//      eventos a Meta; CONFIRMADO: no sale la plantilla de confirmación) y nota "PRUEBA - NO DESPACHAR".
//   2. modificar_pedido confirmar=false (pasa a 2 unidades) y confirmar=true con el toque de Confirmo simulado.
//      "editar": pedido creado por Voltra OS → orderEdit. "reemplazar": Releasit no se puede crear por API, así que se
//      FUERZA el camino de reemplazo sobre un pedido de Voltra OS (borrador → pago pendiente → cancelar el original).
//   3. Imprime cómo quedaron los pedidos en Shopify (total, líneas, tags, cancelado).
//   4. Limpieza: cancela TODO lo que creó (original y reemplazo) con reposición y sin aviso. No borra filas de la base.
// WhatsApp y Telegram NO se mandan: se reemplazan por un registro en consola.

import { existsSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

const RAIZ = join(dirname(fileURLToPath(import.meta.url)), "..");
const ENV_FILE = Deno.env.get("ENV_PRODUCCION") ?? join(RAIZ, ".env.produccion");
const args = Deno.args;
const EJECUTAR = args.includes("--ejecutar");
const SOLO = args.includes("--solo") ? args[args.indexOf("--solo") + 1] : null;
const TIPOS = ["editar", "reemplazar"].filter((t) => !SOLO || t === SOLO);
const env = (k) => (Deno.env.get(k) ?? "").trim();

function cargarEnv() {
  if (!existsSync(ENV_FILE)) return;
  for (const linea of Deno.readTextFileSync(ENV_FILE).split("\n")) {
    const m = /^\s*([A-Z0-9_]+)\s*=\s*(.*)\s*$/.exec(linea);
    if (m && !Deno.env.get(m[1])) Deno.env.set(m[1], m[2].replace(/^["']|["']$/g, ""));
  }
}

const plan = () => {
  console.log("PLAN (dry-run; agregá --ejecutar para hacerlo de verdad):");
  for (const t of TIPOS) {
    console.log(`  [${t}] orderCreate 1 unidad · tags PRUEBA, PRUEBA_E2E, CONFIRMADO · nota "PRUEBA - NO DESPACHAR" · tel PRUEBA_TELEFONO`);
    console.log(`  [${t}] modificar_pedido confirmar=false → 2 unidades (resumen por consola, sin WhatsApp)`);
    console.log(`  [${t}] modificar_pedido confirmar=true con "[botón] Confirmo (vend_mod:<id>)"` +
      (t === "reemplazar" ? " · camino forzado a reemplazo: draftOrderCreate(taxExempt) → draftOrderComplete(paymentPending) → orderCancel" : " · orderEditBegin → SetQuantity/AddVariant + descuento → Commit"));
    console.log(`  [${t}] imprimir pedidos · cancelar todo lo creado (restock, sin aviso)`);
  }
};

if (!EJECUTAR && !args.includes("--verificar")) {
  plan();
  Deno.exit(0);
}

cargarEnv();
// 19-10: .env.produccion trae SUPABASE_PROJECT_REF, no la URL.
if (!env("SUPABASE_URL") && env("SUPABASE_PROJECT_REF")) Deno.env.set("SUPABASE_URL", `https://${env("SUPABASE_PROJECT_REF")}.supabase.co`);
// 19-10: sin PRUEBA_CONVERSACION_ID se usa la última conversación del teléfono de prueba (solo lectura).
if (!env("PRUEBA_CONVERSACION_ID") && env("PRUEBA_TELEFONO") && env("SUPABASE_URL") && env("SUPABASE_SERVICE_ROLE_KEY")) {
  const h = { apikey: env("SUPABASE_SERVICE_ROLE_KEY"), Authorization: `Bearer ${env("SUPABASE_SERVICE_ROLE_KEY")}` };
  const tel = `%2B${env("PRUEBA_TELEFONO").replace(/\D/g, "")}`;
  const cl = await (await fetch(`${env("SUPABASE_URL")}/rest/v1/wa_clientes?select=id&telefono=eq.${tel}`, { headers: h })).json();
  if (cl?.[0]?.id) {
    const cv = await (await fetch(`${env("SUPABASE_URL")}/rest/v1/wa_conversaciones?select=id&cliente_id=eq.${cl[0].id}&order=creado_en.desc&limit=1`, { headers: h })).json();
    if (cv?.[0]?.id) Deno.env.set("PRUEBA_CONVERSACION_ID", cv[0].id);
  }
}
const faltan = ["SHOPIFY_STORE", "SHOPIFY_CLIENT_ID", "SHOPIFY_CLIENT_SECRET", "SUPABASE_URL", "SUPABASE_SERVICE_ROLE_KEY", "PRUEBA_TELEFONO", "PRUEBA_CONVERSACION_ID"]
  .filter((k) => !env(k));
if (args.includes("--verificar")) {
  console.log(`archivo ${ENV_FILE} ${existsSync(ENV_FILE) ? "existe" : "NO existe"} · faltan: ${faltan.join(", ") || "ninguna"}`);
  Deno.exit(0);
}
if (faltan.length) {
  console.error(`Faltan variables: ${faltan.join(", ")}`);
  Deno.exit(1);
}

const { gql } = await import("../supabase/functions/_shared/shopify.ts");
const { db } = await import("../supabase/functions/_shared/db.ts");
const { depsHerramientasReales, depsOrquestadorReales } = await import("../supabase/functions/_shared/vendedor/io.ts");
const { depsPedidosWebReales } = await import("../supabase/functions/_shared/vendedor/pedidos_web_io.ts");
const { modificarPedidoHerr } = await import("../supabase/functions/_shared/vendedor/pedidos_web.ts");

const TEL = `+${env("PRUEBA_TELEFONO").replace(/\D/g, "")}`;
const CONV = env("PRUEBA_CONVERSACION_ID");
const creados = []; // gids a cancelar al final

const registro = (q) => (...a) => (console.log(`    [${q}]`, JSON.stringify(a[1] ?? a[0]).slice(0, 400)), Promise.resolve({ ok: true, wa_message_id: "prueba" }));

async function crearPedidoPrueba(variante, precio, envio) {
  const r = await gql(`mutation($order: OrderCreateOrderInput!, $options: OrderCreateOptionsInput) {
    orderCreate(order: $order, options: $options) { order { id legacyResourceId name } userErrors { field message } } }`, {
    order: {
      currency: "PYG", taxesIncluded: true, phone: TEL, financialStatus: "PENDING",
      lineItems: [{ variantId: variante, quantity: 1, priceSet: { shopMoney: { amount: String(precio), currencyCode: "PYG" } } }],
      shippingLines: [{ title: "Envío", priceSet: { shopMoney: { amount: String(envio), currencyCode: "PYG" } } }],
      shippingAddress: { firstName: "PRUEBA", lastName: "NO DESPACHAR", address1: "Prueba 123", city: "Ciudad del Este", countryCode: "PY", phone: TEL },
      tags: ["PRUEBA", "PRUEBA_E2E", "CONFIRMADO"],
      note: "PRUEBA - NO DESPACHAR",
      customAttributes: [{ key: "origen", value: "prueba_modificar_pedido" }],
    },
    options: { inventoryBehaviour: "DECREMENT_OBEYING_POLICY", sendReceipt: false, sendFulfillmentReceipt: false },
  });
  const ue = r.orderCreate.userErrors ?? [];
  if (ue.length || !r.orderCreate.order) throw new Error(`orderCreate: ${JSON.stringify(ue)}`);
  creados.push(r.orderCreate.order.id);
  // 19-10: como en la vida real, el cliente escribe después: el webhook alcanza a guardar el pedido (1-3 s).
  await new Promise((ok) => setTimeout(ok, 5000));
  return { id: Number(r.orderCreate.order.legacyResourceId), gid: r.orderCreate.order.id, nombre: r.orderCreate.order.name };
}

async function mostrar(gid) {
  const r = await gql(`query($id: ID!) { order(id: $id) { name cancelledAt tags currentTotalPriceSet { shopMoney { amount } }
    lineItems(first: 20) { nodes { title currentQuantity } } } }`, { id: gid });
  const o = r.order;
  console.log(`    ${o.name}: total ${o.currentTotalPriceSet.shopMoney.amount} · ${o.lineItems.nodes.filter((l) => l.currentQuantity > 0).map((l) => `${l.title} x${l.currentQuantity}`).join(", ")} · tags ${o.tags.join(",")} · ${o.cancelledAt ? "CANCELADO" : "vigente"}`);
}

let fallas = 0;
try {
  const cfg = await depsOrquestadorReales.config();
  const productos = await depsHerramientasReales.catalogoShopify(cfg.vendedor.catalogo_estado || "ACTIVE");
  const prod = productos.find((p) => p.handle === env("PRUEBA_HANDLE")) ?? productos.find((p) => p.variantes.some((v) => v.disponible));
  if (!prod) throw new Error("no hay productos disponibles en el catálogo");
  const v = prod.variantes.find((x) => x.disponible) ?? prod.variantes[0];
  const { data: conv } = await db().from("wa_conversaciones").select("cliente_id").eq("id", CONV).maybeSingle();
  if (!conv) throw new Error("PRUEBA_CONVERSACION_ID no existe en wa_conversaciones");

  for (const tipo of TIPOS) {
    console.log(`\n=== ${tipo.toUpperCase()} ===`);
    const orig = await crearPedidoPrueba(v.id, v.price, cfg.envio.costo_gs);
    console.log(`  creado ${orig.nombre} (${orig.id})`);
    const pedidosWeb = tipo === "reemplazar"
      ? { ...depsPedidosWebReales, pedidoCompleto: async (id) => {
        const p = await depsPedidosWebReales.pedidoCompleto(id);
        return p ? { ...p, app: "Releasit (simulado para la prueba)", merchant_editable: false } : p;
      } }
      : depsPedidosWebReales;
    const deps = {
      ...depsHerramientasReales,
      enviarTexto: registro("whatsapp texto"), enviarInteractivo: registro("whatsapp botones"), enviarMedia: registro("whatsapp media"),
      avisar: (t) => (console.log(`    [telegram] ${t.replace(/<[^>]+>/g, "")}`), Promise.resolve({ ok: true })),
      pedidosWeb,
    };
    const ctx = (texto) => ({
      conversacionId: CONV, clienteId: conv.cliente_id, destino: TEL, telefono: TEL, waUserId: null, nombreCliente: "PRUEBA",
      textoEntrada: texto, mensajeEntradaId: "prueba", ahora: new Date(), cfg, revisar: () => ({ ok: true, motivos: [] }),
    });
    const num = Number(orig.nombre.replace(/\D/g, ""));
    const dbg1 = await pedidosWeb.candidatos({ numero: num, limite: 1 }).catch((e) => `ERROR ${e}`);
    const dbg2 = await pedidosWeb.idPorNumero?.(num).catch((e) => `ERROR ${e}`);
    console.log(`  diagnóstico: candidatos=${typeof dbg1 === "string" ? dbg1 : dbg1.length} idPorNumero=${dbg2}`);
    const r1 = await modificarPedidoHerr.ejecutor({ confirmar: false, pedido: orig.nombre, items: [{ handle: prod.handle, cantidad: 2 }] }, ctx("quiero 2"), deps);
    console.log("  paso 1:", JSON.stringify(r1.resultado));
    if (!r1.resultado.ok) { fallas++; continue; }
    const id = r1.resultado.modificacion_id;
    const sinConfirmo = await modificarPedidoHerr.ejecutor({ confirmar: true }, ctx("y cuánto es?"), deps);
    console.log("  sin Confirmo (tiene que fallar):", sinConfirmo.resultado.error);
    if (sinConfirmo.resultado.ok) fallas++;
    const r2 = await modificarPedidoHerr.ejecutor({ confirmar: true }, ctx(`[botón] Confirmo (vend_mod:${id})`), deps);
    console.log("  paso 2:", JSON.stringify(r2.resultado));
    if (!r2.resultado.ok) fallas++;
    const r3 = await modificarPedidoHerr.ejecutor({ confirmar: true }, ctx(`[botón] Confirmo (vend_mod:${id})`), deps);
    console.log("  doble Confirmo (ya_hecho):", JSON.stringify(r3.resultado).slice(0, 200));
    if (!r3.resultado.ya_hecho) fallas++;
    // 19-10: el reemplazo se busca por su número directo en Shopify (shopify_pedidos puede no tenerlo todavía).
    const idNuevo = r2.resultado.reemplazado ? await depsPedidosWebReales.idPorNumero(Number(String(r2.resultado.pedido).replace(/\D/g, ""))) : null;
    const nuevo = idNuevo ? { shopify_order_id: idNuevo } : null;
    if (nuevo) creados.push(`gid://shopify/Order/${nuevo.shopify_order_id}`);
    await mostrar(orig.gid);
    if (nuevo) await mostrar(`gid://shopify/Order/${nuevo.shopify_order_id}`);
    const esperado = tipo === "editar" ? "editar" : "reemplazar";
    if ((esperado === "reemplazar") !== !!r2.resultado.reemplazado) { fallas++; console.log(`  X camino esperado ${esperado}`); }
  }
} catch (e) {
  fallas++;
  console.error("ERROR:", e instanceof Error ? e.message : e);
} finally {
  console.log("\n=== LIMPIEZA ===");
  for (const gid of creados) {
    const r = await depsPedidosWebReales.cancelarOrden(gid, "PRUEBA de modificar_pedido: cancelado por el script").catch((e) => ({ ok: false, error: String(e) }));
    console.log(`  ${gid}: ${r.ok ? "cancelado" : `no se canceló (${r.error}) — si ya estaba cancelado está bien; si no, cancelalo a mano`}`);
  }
  console.log(fallas ? `\n${fallas} falla(s)` : "\nOK: todo como se esperaba");
  Deno.exit(fallas ? 1 : 0);
}
