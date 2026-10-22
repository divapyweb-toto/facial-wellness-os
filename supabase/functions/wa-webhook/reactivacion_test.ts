// 21-10 · reactivación sin pedido nuevo: los 4 caminos (paquete en el courier / pedido abierto × sí / no), de punta a
// punta (webhook → cierre de seguimiento-chat) contra un "mundo" en memoria. Datos inventados (repo público).
import { assert, assertEquals, assertFalse } from "jsr:@std/assert@1";
import type { Deps } from "./procesar.ts";
import { atenderReactivacion } from "./reactivacion.ts";
import { correrReactivaciones } from "../seguimiento-chat/reactivaciones.ts";
import { leerReactivaciones, respuestaReactivacion } from "../_shared/reactivaciones.ts";

const AHORA = new Date("2026-10-22T12:00:00Z"); // 09:00 PY
const VENCE = "2026-10-22T15:00:00Z"; // 12:00 PY

type Orden = { id: string; nombre: string; tags: string[]; estado: string; cancelada: boolean };
type Venta = { ref: string; estado: string };

function mundo() {
  const ordenes = new Map<string, Orden>([
    ["9000000000001", { id: "9000000000001", nombre: "#9001", tags: ["CANCELADO_CLIENTE", "releasit_cod_form"], estado: "cancelado_cliente", cancelada: true }],
    ["9000000000002", { id: "9000000000002", nombre: "#9002", tags: ["CANCELADO_CLIENTE", "releasit_cod_form"], estado: "cancelado_cliente", cancelada: false }],
  ]);
  const ventas: Venta[] = [{ ref: "VT-9001", estado: "pendiente" }]; // el #9001 ya salió con el courier
  const eventos = new Map<string, unknown>();
  const avisos: string[] = [];
  const textos: Array<{ to: string; texto: string }> = [];
  const pedidosCreados: string[] = [];
  const cfg = {
    lista: [
      { cliente_id: "cli-a", shopify_order_id: "9000000000001", pedido: "#9001", venta: "VT-9001", nombre: "Ana", total: 112000, courier: "Lucero", modo: "en_courier", vence: VENCE },
      { cliente_id: "cli-b", shopify_order_id: "9000000000002", pedido: "#9002", nombre: "Beto", total: 158000, modo: "reabrir", vence: VENCE },
    ],
  };
  let reloj = AHORA;
  const deps = {
    ahora: () => reloj,
    config: (c: string) => Promise.resolve(c === "reactivaciones" ? cfg : null),
    eventoCrudoExiste: (id: string) => Promise.resolve(eventos.has(id)),
    guardarEventoCrudo: (id: string, p: unknown) => Promise.resolve(eventos.has(id) ? false : (eventos.set(id, p), true)),
    buscarPedido: (id: string) => Promise.resolve(ordenes.has(id) ? { shopify_order_id: id, estado_confirmacion: ordenes.get(id)!.estado, tags: [...ordenes.get(id)!.tags] } : null),
    actualizarPedido: (id: string, c: { estado_confirmacion: string; tags: string[] }) => {
      const o = ordenes.get(id)!;
      o.estado = c.estado_confirmacion;
      o.tags = c.tags;
      return Promise.resolve();
    },
    quitarTags: (g: string, t: string[]) => {
      const o = ordenes.get(g.split("/").pop()!)!;
      o.tags = o.tags.filter((x) => !t.includes(x));
      return Promise.resolve();
    },
    agregarTags: (g: string, t: string[]) => {
      const o = ordenes.get(g.split("/").pop()!)!;
      o.tags = [...new Set([...o.tags, ...t])];
      return Promise.resolve();
    },
    avisar: (t: string) => (avisos.push(t), Promise.resolve()),
    enviarTexto: (to: string, texto: string) => (textos.push({ to, texto }), Promise.resolve({ ok: true })),
  } as unknown as Deps;
  const cierre = (simular = false) =>
    correrReactivaciones({
      config: () => Promise.resolve(cfg),
      eventos: (ids) => Promise.resolve(ids.filter((i) => eventos.has(i)).map((i) => ({ id_externo: i, payload: eventos.get(i) }))),
      tomar: (id, p) => Promise.resolve(eventos.has(id) ? false : (eventos.set(id, p), true)),
      cancelarEnShopify: (id) => {
        ordenes.get(String(id))!.cancelada = true;
        return Promise.resolve(null);
      },
      avisar: (t) => (avisos.push(t), Promise.resolve()),
      vaciar: () => ((cfg.lista = []), Promise.resolve()),
    }, reloj, simular);
  /**
   * Lo que Despacho vería: las ventas ya cargadas + los pedidos de Shopify despachables (src/pages/despacho/
   * DespachoPagina.jsx clasificarEstado: cancelled_at o una etiqueta con "cancelado" → no se despacha). Un pedido ya
   * cargado como venta no se cuenta dos veces.
   */
  const despacho = () => {
    const abiertos = [...ordenes.values()].filter((o) => !o.cancelada && !o.tags.some((t) => t.toLowerCase().includes("cancelado")));
    return [...ventas.map((v) => v.ref), ...abiertos.filter((o) => !ventas.some((v) => v.ref === `VT-${o.nombre.slice(1)}`)).map((o) => o.nombre)];
  };
  return { deps, ordenes, ventas, eventos, avisos, textos, pedidosCreados, cierre, despacho, pasar: (h: number) => (reloj = new Date(reloj.getTime() + h * 3_600_000)) };
}

const atender = (w: ReturnType<typeof mundo>, cliente: string, texto: string, boton?: { accion: string; orderId: string }) =>
  atenderReactivacion(w.deps, { clienteId: cliente, conversacionId: `conv-${cliente}`, destino: "+595981000000", texto, botonConfirmacion: boton ?? null });

Deno.test("21-10 reactivación · paquete en el courier + 'sí' → mismo pedido, venta viva, Telegram, sin pedido nuevo", async () => {
  const w = mundo();
  assertEquals(await atender(w, "cli-a", "Sí, dale"), { manejado: true });
  const o = w.ordenes.get("9000000000001")!;
  assertEquals(o.estado, "confirmado");
  assertFalse(o.tags.includes("CANCELADO_CLIENTE"));
  assert(o.tags.includes("REACTIVADO"));
  assertEquals(w.avisos, ["✅ Ana reactivó #9001: el paquete VT-9001 ya está en Lucero, avisar que lo entreguen"]);
  assert(w.textos[0].texto.includes("Queda en camino con Lucero"));
  assertEquals(w.ventas, [{ ref: "VT-9001", estado: "pendiente" }]);
  assertEquals(w.despacho(), ["VT-9001"]); // una sola venta: el pedido anulado no vuelve a Despacho
  // Después del cierre de las 12:00 no pasa nada más.
  w.pasar(4);
  assertEquals((await w.cierre()).hechos.filter((h) => h.pedido === "#9001"), []);
  assertEquals(w.avisos.filter((a) => a.includes("#9001") || a.includes("VT-9001")).length, 1);
});

Deno.test("21-10 reactivación · paquete en el courier + 'no' → Telegram para que lo devuelvan", async () => {
  const w = mundo();
  assertEquals(await atender(w, "cli-a", "No gracias"), { manejado: true });
  assert(w.textos[0].texto.startsWith("Dale, sin problema Ana"));
  const r = await w.cierre();
  assertEquals(r.hechos.map((h) => h.accion), ["avisar"]);
  assertEquals(w.avisos, ["❌ Ana no reactivó (dijo que no): pedir a Lucero que devuelva VT-9001"]);
  assertEquals(w.despacho(), ["VT-9001"]);
  assertEquals((await w.cierre()).hechos, []); // una sola vez
});

Deno.test("21-10 reactivación · paquete en el courier sin respuesta → a las 12:00 Telegram; un 'sí' tardío ya no reactiva", async () => {
  const w = mundo();
  assertEquals((await w.cierre()).hechos, []); // 09:00: todavía no venció
  w.pasar(3);
  assertEquals((await w.cierre()).hechos.filter((h) => h.pedido === "#9001").map((h) => h.motivo), ["vencido"]);
  assert(w.avisos.includes("❌ Ana no reactivó (no contestó): pedir a Lucero que devuelva VT-9001"));
  assertEquals(await atender(w, "cli-a", "sí"), { manejado: false });
  assertEquals(w.ordenes.get("9000000000001")!.estado, "cancelado_cliente");
});

Deno.test("21-10 reactivación · pedido abierto + 'sí' → el MISMO pedido sigue (sin CANCELADO_CLIENTE), nunca dos", async () => {
  const w = mundo();
  assertEquals(await atender(w, "cli-b", "dale, lo quiero"), { manejado: true });
  const o = w.ordenes.get("9000000000002")!;
  assertEquals([o.estado, o.cancelada], ["confirmado", false]);
  assertFalse(o.tags.includes("CANCELADO_CLIENTE"));
  assert(o.tags.includes("CONFIRMADO"));
  assertEquals(w.avisos, ["✅ Beto reactivó #9002: sigue el mismo pedido (sin pedido nuevo), ya está confirmado"]);
  assertEquals(w.despacho().filter((x) => x === "#9002").length, 1);
  w.pasar(4);
  assertEquals((await w.cierre()).hechos.filter((h) => h.pedido === "#9002"), []); // no lo cancela al vencer
  assertFalse(o.cancelada);
});

Deno.test("21-10 reactivación · pedido abierto + 'no' o sin respuesta → se cancela de verdad en Shopify", async () => {
  const w = mundo();
  await atender(w, "cli-b", "no, ya no lo quiero");
  await w.cierre();
  assert(w.ordenes.get("9000000000002")!.cancelada);
  assertEquals(w.avisos, ["❌ Beto no reactivó #9002 (dijo que no): quedó cancelado en Shopify"]);
  assertFalse(w.despacho().includes("#9002"));
  const v = mundo();
  v.pasar(3);
  await v.cierre();
  assert(v.ordenes.get("9000000000002")!.cancelada);
});

Deno.test("21-10 reactivación · botones: Confirmo de la confirmación vieja = sí; Cancelar = no; Confirmo de un resumen del bot = sí", async () => {
  const a = mundo();
  assertEquals(await atender(a, "cli-b", "[botón] Confirmo", { accion: "conf_si", orderId: "9000000000002" }), { manejado: true });
  assertEquals(a.ordenes.get("9000000000002")!.estado, "confirmado");
  const b = mundo();
  await atender(b, "cli-b", "[botón] Cancelar pedido", { accion: "conf_cancelar", orderId: "9000000000002" });
  await b.cierre();
  assert(b.ordenes.get("9000000000002")!.cancelada);
  const c = mundo();
  assertEquals(await atender(c, "cli-a", "[botón] Confirmo (crear_pedido_cod:confirmar)"), { manejado: true });
  assertEquals(c.despacho(), ["VT-9001"]);
  // El botón de OTRO pedido no toca esta reactivación.
  const d = mundo();
  assertEquals(await atender(d, "cli-b", "[botón] Confirmo", { accion: "conf_si", orderId: "123" }), { manejado: false });
});

Deno.test("21-10 reactivación · pregunta o condición → va al vendedor con la marca (no arma pedido nuevo); otro cliente o ya decidido → nada", async () => {
  const w = mundo();
  const r = await atender(w, "cli-a", "¿Y cuándo llega?");
  assertEquals(r.manejado, false);
  assert(!r.manejado && r.marca?.includes("NO armes un pedido nuevo"));
  assertEquals(w.avisos, []);
  assertEquals(await atender(w, "cli-x", "sí"), { manejado: false });
  await atender(w, "cli-a", "sí");
  const despues = await atender(w, "cli-a", "gracias, ¿a qué hora pasa?");
  assertEquals(despues, { manejado: false }); // ya decidió: el vendedor lo atiende como siempre
});

Deno.test("21-10 respuestaReactivacion: sí, no y lo que no es ni una cosa ni la otra", () => {
  for (const t of ["Sí", "si dale", "Dale", "ok", "bueno", "Sí, que me lo traigan", "lo quiero", "sí 🙌", "confirmo"]) assertEquals(respuestaReactivacion(t), "si", t);
  for (const t of ["No", "no gracias", "ya no lo quiero", "No, ya compré en otro lado", "cancelalo"]) assertEquals(respuestaReactivacion(t), "no", t);
  for (const t of ["¿Cuándo llega?", "sí pero el viernes", "No tengo número de casa", "hola", "Sí, no tengo número"]) assertEquals(respuestaReactivacion(t), null, t);
  assertEquals(leerReactivaciones({ lista: [{ cliente_id: "x" }, null] }), []);
});

Deno.test("22-10 reactivación · con los dos casos cerrados la lista se vacía (el freno queda inactivo)", async () => {
  const w = mundo();
  await atender(w, "cli-a", "sí");
  assertFalse((await w.cierre()).vaciada); // falta el otro
  await atender(w, "cli-b", "no");
  assert((await w.cierre()).vaciada);
  assertEquals(await atender(w, "cli-b", "sí"), { manejado: false });
});
