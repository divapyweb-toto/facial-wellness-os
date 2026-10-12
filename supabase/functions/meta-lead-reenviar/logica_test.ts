import { assertEquals, assertRejects } from "@std/assert";
import type { ConfigLead, EntradaLead } from "../_shared/meta_capi.ts";
import type { DepsLeadMeta } from "../shopify-webhook/lead_meta.ts";
import { automatico, type Candidato, type DepsReenvio, reenviar } from "./logica.ts";

const AHORA = new Date("2026-10-12T15:00:00Z");
const CFG: ConfigLead = { token: "t", datasetMensajeriaId: "ds", wabaId: "w", testEventCode: null };
const ped = (n: number, horasAtras: number, confirmado = true): Candidato => ({
  confirmado, shopifyOrderId: n, nombre: `#${n}`, clienteId: `c${n}`, total: 129000, creadoEn: new Date(AHORA.getTime() - horasAtras * 3_600_000).toISOString(),
});

function falsas(conCtwa: number[], candados: string[] = []) {
  const enviados: Array<{ e: EntradaLead; cfg: ConfigLead }> = [];
  const reservados = new Set(candados);
  const lead: DepsLeadMeta = {
    config: () => CFG,
    ahora: () => AHORA,
    origenAnuncio: (cliente) => Promise.resolve(conCtwa.some((n) => `c${n}` === cliente) ? { ctwa_clid: `clid-${cliente}` } : null),
    reservar: (id) => Promise.resolve(reservados.has(id) ? false : (reservados.add(id), true)),
    registrar: () => Promise.resolve(),
    enviar: (e, cfg) => (enviados.push({ e, cfg }), Promise.resolve({ ok: true, respuesta: { events_received: 1 } })),
  };
  const d: DepsReenvio = {
    lead,
    candidatos: () => Promise.resolve([ped(1001, 200), ped(1003, 120), ped(1005, 30, false), ped(1007, 10)]),
    existeCandado: (id) => Promise.resolve(reservados.has(id)),
  };
  return { d, enviados, reservados };
}

Deno.test("listar: clasifica sin mandar nada ni tocar candados", async () => {
  const f = falsas([1001, 1003, 1005], ["meta_lead:1005"]);
  const r = await reenviar("listar", {}, f.d);
  assertEquals(r.filas.map((x) => [x.pedido, x.estado]), [
    ["#1001", "fuera_de_plazo_7_dias"], ["#1003", "pendiente"], ["#1005", "ya_enviado"], ["#1007", "sin_ctwa_clid"],
  ]);
  assertEquals(f.enviados.length, 0);
  assertEquals(f.reservados.size, 1);
});

Deno.test("enviar: solo los pendientes, con candado; repetir no duplica", async () => {
  const f = falsas([1003, 1005]);
  const r = await reenviar("enviar", {}, f.d);
  assertEquals(r.filas.filter((x) => x.estado === "enviado").map((x) => x.pedido), ["#1003", "#1005"]);
  assertEquals(f.enviados.map((x) => [x.e.shopify_order_id, x.e.ctwa_clid, x.cfg.testEventCode]), [[1003, "clid-c1003", null], [1005, "clid-c1005", null]]);
  const otra = await reenviar("enviar", {}, f.d);
  assertEquals(otra.filas.filter((x) => x.estado === "ya_enviado").length, 2);
  assertEquals(f.enviados.length, 2);
});

Deno.test("enviar con lista: solo esos pedidos", async () => {
  const f = falsas([1003, 1005]);
  await reenviar("enviar", { pedidos: ["#1005"] }, f.d);
  assertEquals(f.enviados.map((x) => x.e.shopify_order_id), [1005]);
});

Deno.test("prueba: UN evento con test_event_code, sin candado (el pedido sigue pendiente)", async () => {
  const f = falsas([1003, 1005]);
  const r = await reenviar("prueba", { testEventCode: " TEST123 " }, f.d);
  assertEquals(f.enviados.length, 1);
  assertEquals(f.enviados[0].cfg.testEventCode, "TEST123");
  assertEquals(r.prueba?.pedido, "#1003");
  assertEquals(r.prueba?.respuesta?.events_received, 1);
  assertEquals(f.reservados.size, 0);
  await assertRejects(() => reenviar("prueba", {}, f.d), Error, "test_event_code");
});

Deno.test("sin configuración de Meta: error claro, nada se manda", async () => {
  const f = falsas([1003]);
  f.d.lead.config = () => null;
  await assertRejects(() => reenviar("enviar", {}, f.d), Error, "META_DATASET_MENSAJERIA_ID");
  assertEquals(f.enviados.length, 0);
});

Deno.test("Purchase: solo confirmados, candado propio, no choca con el LeadSubmitted del mismo pedido", async () => {
  const f = falsas([1003, 1005], ["meta_lead:1003"]);
  const r = await reenviar("enviar", { evento: "Purchase" }, f.d);
  assertEquals(r.filas.map((x) => [x.pedido, x.estado]), [["#1001", "fuera_de_plazo_7_dias"], ["#1003", "enviado"], ["#1007", "sin_ctwa_clid"]]);
  assertEquals(f.enviados.map((x) => [x.e.shopify_order_id, x.e.evento, x.e.valor, x.e.ctwa_clid]), [[1003, "Purchase", 129000, "clid-c1003"]]);
  assertEquals([...f.reservados].sort(), ["meta_lead:1003", "meta_purchase:1003"]);
});

Deno.test("pedidos en el orden pedido (los que vencen antes, primero)", async () => {
  const f = falsas([1003, 1005]);
  await reenviar("enviar", { pedidos: ["#1005", "#1003"] }, f.d);
  assertEquals(f.enviados.map((x) => x.e.shopify_order_id), [1005, 1003]);
});

Deno.test("automático (cron): LeadSubmitted de los de anuncio + Purchase de los confirmados; la segunda vuelta no repite", async () => {
  const f = falsas([1003, 1005]);
  const r = await automatico(f.d);
  assertEquals(r, { lead: { enviados: ["#1003", "#1005"], errores: [] }, purchase: { enviados: ["#1003"], errores: [] } });
  const r2 = await automatico(f.d);
  assertEquals(r2, { lead: { enviados: [], errores: [] }, purchase: { enviados: [], errores: [] } });
});
