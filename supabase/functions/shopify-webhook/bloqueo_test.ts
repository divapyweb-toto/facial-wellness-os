// 20-11: lista de bloqueo de pedidos falsos. Datos inventados (repo público): teléfonos 0981 000 00x, IPs de documentación.
import { assert, assertEquals } from "jsr:@std/assert@1";
import { bloquesIpv6, coincideBloqueo, ipsDelPedido, listaBloqueoDesde } from "./bloqueo.ts";
import { normalizarDesdeWebhook, procesarPedido } from "./procesar.ts";

const AHORA = new Date("2026-11-20T15:00:00Z"); // 12:00 PY
const norm = (x: string) => {
  let d = x.replace(/\D/g, "");
  if (d.startsWith("595")) d = d.slice(3);
  if (d.startsWith("0")) d = d.slice(1);
  return /^9\d{8}$/.test(d) ? "+595" + d : null;
};
const LISTA = listaBloqueoDesde(JSON.stringify({
  telefonos: [{ v: "595981000001", hasta: null, motivo: "broma DEMO" }, "0981000002"],
  ips: [{ v: "198.51.100.7", hasta: "2026-11-27" }, { v: "198.51.100.8", hasta: "2026-11-19" }],
  prefijos_ipv6: [{ v: "2001:db8:aa:bb", hasta: null }],
}));
const raw = (o: Record<string, unknown> = {}) => ({
  id: 9100, name: "#9100", phone: null, note_attributes: [], shipping_address: { phone: "0981 999 999", city: "Luque" }, customer: {}, ...o,
});

Deno.test("lista: texto JSON o ilegible; entradas con o sin vencimiento", () => {
  assertEquals(LISTA.telefonos.length, 2);
  assertEquals(LISTA.ips[0], { v: "198.51.100.7", hasta: "2026-11-27", motivo: null });
  assertEquals(listaBloqueoDesde("no es json"), { telefonos: [], ips: [], prefijosIpv6: [] });
  assertEquals(listaBloqueoDesde(null), { telefonos: [], ips: [], prefijosIpv6: [] });
});

Deno.test("IPv6: expande '::' y compara los primeros 4 bloques (/64)", () => {
  assertEquals(bloquesIpv6("2001:db8:aa:bb::1"), ["2001", "db8", "aa", "bb", "0", "0", "0", "1"]);
  assertEquals(bloquesIpv6("2001:0db8:00aa:00bb:1:2:3:4")?.slice(0, 4), ["2001", "db8", "aa", "bb"]);
  assertEquals(bloquesIpv6("198.51.100.7"), null);
});

Deno.test("coincide por teléfono (envío, atributo de Releasit), IPv4 vigente y prefijo IPv6; no por IPv4 vencida", () => {
  assertEquals(coincideBloqueo(raw({ shipping_address: { phone: "0981 000 001" } }), LISTA, AHORA, norm)?.por, "telefono");
  assertEquals(coincideBloqueo(raw({ note_attributes: [{ name: "Teléfono", value: "0981000002" }] }), LISTA, AHORA, norm)?.por, "telefono");
  assertEquals(coincideBloqueo(raw({ note_attributes: [{ name: "IP address", value: "198.51.100.7" }] }), LISTA, AHORA, norm)?.por, "ip");
  assertEquals(coincideBloqueo(raw({ note_attributes: [{ name: "IP address", value: "198.51.100.8" }] }), LISTA, AHORA, norm), null, "IPv4 vencida");
  assertEquals(coincideBloqueo(raw({ note_attributes: [{ name: "IP address", value: "2001:db8:aa:bb:ad57:1:2:3" }] }), LISTA, AHORA, norm)?.por, "prefijo_ipv6");
  assertEquals(coincideBloqueo(raw({ note_attributes: [{ name: "IP address", value: "2001:db8:aa:cc::9" }] }), LISTA, AHORA, norm), null, "otra /64");
  assertEquals(coincideBloqueo(raw(), LISTA, AHORA, norm), null, "pedido normal");
  // conciliación (GraphQL): customAttributes {key, value}
  assertEquals(ipsDelPedido({ customAttributes: [{ key: "IP address", value: "198.51.100.7" }] }), ["198.51.100.7"]);
  // la IPv4 vale hasta el día "hasta" incluido (Paraguay)
  assert(coincideBloqueo(raw({ browser_ip: "198.51.100.7" }), LISTA, new Date("2026-11-28T02:00:00Z"), norm), "27/11 23:00 PY todavía vale");
  assertEquals(coincideBloqueo(raw({ browser_ip: "198.51.100.7" }), LISTA, new Date("2026-11-28T04:00:00Z"), norm), null);
});

Deno.test("pedido bloqueado: se cancela en Shopify, no se programa WhatsApp ni Meta, tag BLOQUEADO_FRAUDE, Telegram 1 por día", async () => {
  const pedidos: Array<{ tags: string[] }> = [], envios: unknown[] = [], cancelados: Array<{ gid: string; nota: string }> = [], avisos: Array<{ t: string; o: unknown }> = [];
  let meta = 0;
  const deps = {
    normalizarTelefono: norm, ahora: () => AHORA,
    leerConfigConfirmacion: () => Promise.resolve({ recordatorio_h: 4, retener_h: 48, cancelar_h: 72 }),
    buscarPedido: () => Promise.resolve(null),
    upsertCliente: () => Promise.resolve("c1"),
    upsertPedido: (p: { tags: string[] }) => (pedidos.push(p), Promise.resolve()),
    programarEnvios: (f: unknown[]) => (envios.push(...f), Promise.resolve()),
    cancelarEnviosPendientes: () => Promise.resolve(),
    notificarPedidoMeta: () => (meta++, Promise.resolve()),
    avisar: (t: string, _b: undefined, o: unknown) => (avisos.push({ t, o }), Promise.resolve({ ok: true })),
    leerBloqueo: () => Promise.resolve(LISTA),
    cancelarPorBloqueo: (gid: string, nota: string) => (cancelados.push({ gid, nota }), Promise.resolve({ ok: true })),
  };
  const ped = normalizarDesdeWebhook("orders/create", {
    id: 9101, admin_graphql_api_id: "gid://shopify/Order/9101", name: "#9101", created_at: "2026-11-20T11:59:00-03:00", cancelled_at: null,
    total_price: "112000.00", tags: "releasit", note_attributes: [{ name: "IP address", value: "2001:db8:aa:bb:1::2" }],
    line_items: [{ quantity: 1, title: "Producto DEMO" }], shipping_address: { name: "Demo", phone: "0981 777 777", city: "Luque" }, customer: {},
  });
  const r = await procesarPedido(ped, deps as never);
  assertEquals(r.accion, "bloqueado");
  assertEquals([envios.length, meta], [0, 0]);
  assertEquals(cancelados[0].gid, "gid://shopify/Order/9101");
  assert(cancelados[0].nota.includes("prefijo IPv6 2001:db8:aa:bb"));
  assert(pedidos.at(-1)!.tags.includes("BLOQUEADO_FRAUDE"));
  assertEquals(avisos.length, 1);
  assertEquals(avisos[0].o, { tipo: "pedido_bloqueado", destino: "enrique", pedido: "#9101", clave: "dia", unaVezPorDia: true });
  assert(avisos[0].t.includes("cancelado en Shopify"));
  // un pedido normal con la misma lista sigue el camino de siempre
  const normal = normalizarDesdeWebhook("orders/create", { ...(ped.raw as Record<string, unknown>), id: 9102, name: "#9102", admin_graphql_api_id: "gid://shopify/Order/9102", note_attributes: [] });
  const r2 = await procesarPedido(normal, deps as never);
  assertEquals(r2.accion, "programado");
  assert(envios.length > 0);
  // ya cancelado en Shopify (el orders/updated que sigue a la cancelación): no se vuelve a bloquear
  const yaCanc = normalizarDesdeWebhook("orders/updated", { ...(ped.raw as Record<string, unknown>), cancelled_at: "2026-11-20T12:00:01-03:00" });
  assertEquals((await procesarPedido(yaCanc, deps as never)).accion, "actualizado");
  assertEquals(cancelados.length, 1);
});
