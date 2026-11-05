// 05-11: pedidos confirmados hace +48 h que no salen (datos inventados).
import { assert, assertEquals, assertStringIncludes } from "jsr:@std/assert@1";
import { armarLista, type ListaDespacho, type PedidoLista } from "../lista-despacho/logica.ts";
import type { FilaPedido } from "../lista-despacho/carga.ts";
import { correrPedidos48h, type Deps48h, idCandadoAviso, idCandadoCliente, textoReconfirmar } from "./pedidos_48h.ts";

// 15:00 UTC = 12:00 de Paraguay (horario del cliente).
const AHORA = new Date("2026-11-05T15:00:00Z");
const haceHoras = (h: number) => new Date(AHORA.getTime() - h * 3_600_000).toISOString();

function fila(id: number, o: { tags?: string; ciudad?: string; calle?: string; horas?: number; cliente?: string | null } = {}): FilaPedido {
  return {
    shopify_order_id: id, nombre: `#${id}`, estado_envio: null, es_borrador: false, creado_en: haceHoras((o.horas ?? 49) + 1),
    cliente_id: o.cliente === undefined ? `c-${id}` : o.cliente, estado_confirmacion: "confirmado", confirmado_en: haceHoras(o.horas ?? 49),
    raw: {
      name: `#${id}`, tags: o.tags ?? "CONFIRMADO", total_price: "112000", financial_status: "pending",
      line_items: [{ name: "Raspador de lengua", quantity: 1 }],
      shipping_address: { first_name: "ana maría", city: o.ciudad ?? "Luque", address1: o.calle ?? "Calle Palma 123" },
    },
  };
}

function deps(filas: FilaPedido[], o: { activo?: boolean; ventana?: boolean; tomados?: string[]; lista?: ListaDespacho; telegramOk?: boolean } = {}) {
  const tomados = new Set(o.tomados ?? []);
  const encolados: Array<Record<string, unknown>> = [], avisos: string[] = [], escrituras: string[] = [];
  const d: Deps48h = {
    config: () => Promise.resolve(o.activo === false ? null : { activo: true }),
    cargar: (ahora) => Promise.resolve({ lista: o.lista ?? armarLista(filas, [], new Set(), ahora), filas }),
    candados: (ids) => Promise.resolve(new Set(ids.filter((i) => tomados.has(i)))),
    ventanas: (cs) => Promise.resolve(new Map(cs.map((c) => [c, o.ventana ?? true]))),
    tomar: (id) => { escrituras.push(id); if (tomados.has(id)) return Promise.resolve(false); tomados.add(id); return Promise.resolve(true); },
    soltar: (id) => { escrituras.push(`-${id}`); tomados.delete(id); return Promise.resolve(); },
    encolar: (f) => { escrituras.push(String(f.clave_unica)); encolados.push(f); return Promise.resolve(null); },
    avisar: (t) => { escrituras.push("telegram"); avisos.push(t); return Promise.resolve(o.telegramOk === false ? { ok: false, error: "x" } : { ok: true }); },
  };
  return { d, encolados, avisos, escrituras, tomados };
}

Deno.test("47 h desde la confirmación → nada", async () => {
  const { d, escrituras } = deps([fila(9001, { calle: "", horas: 47 })]);
  const r = await correrPedidos48h(d, AHORA);
  assertEquals([r.hechos.length, escrituras.length], [0, 0]);
});

Deno.test("49 h, falta la dirección y ventana abierta → texto libre UNA vez (la segunda corrida no hace nada)", async () => {
  const x = deps([fila(9002, { calle: "" })]);
  const r1 = await correrPedidos48h(x.d, AHORA);
  assertEquals(r1.hechos.map((h) => [h.pedido, h.accion, h.ok]), [["#9002", "texto_libre", true]]);
  assertEquals(x.encolados.length, 1);
  const f = x.encolados[0];
  assertEquals([f.plantilla, f.categoria, f.clave_unica, f.shopify_order_id, f.cliente_id], ["texto_libre", "utilidad", "texto_libre:reconfirmar_48h:9002", 9002, "c-9002"]);
  assertEquals((f.variables as { texto: string }).texto,
    "Ana, tu pedido #9002 sigue esperando para salir: nos falta la dirección (calle o barrio y una referencia) o tu ubicación 📍. ¿Nos pasás esos datos por acá? Apenas lo tengamos, sale 🙌");
  assert(x.tomados.has(idCandadoCliente("9002")));
  const r2 = await correrPedidos48h(x.d, AHORA);
  assertEquals([r2.hechos.length, x.encolados.length], [0, 1]);
});

Deno.test("ventana cerrada → plantilla voltra_completar_direccion {nombre, pedido}", async () => {
  const x = deps([fila(9003, { calle: "" })], { ventana: false });
  await correrPedidos48h(x.d, AHORA);
  assertEquals(x.encolados.map((f) => [f.plantilla, f.clave_unica, f.variables]),
    [["voltra_completar_direccion", "reconfirmar_48h:9003", { nombre: "Ana", pedido: "#9003" }]]);
});

Deno.test("otro flujo ya le pidió el dato y no contestó → igual sale esta UNA vez (marcado como previo)", async () => {
  const x = deps([fila(9004, { calle: "" })], { tomados: ["auto_completar_direccion:9004"] });
  const r = await correrPedidos48h(x.d, AHORA);
  assertEquals(r.hechos.map((h) => [h.accion, h.previo]), [["texto_libre", true]]);
});

Deno.test("ciudad no reconocida → le pide la ciudad", async () => {
  const x = deps([fila(9005, { ciudad: "Casa" })]);
  const r = await correrPedidos48h(x.d, AHORA);
  assertEquals(r.hechos.map((h) => [h.clave, h.accion]), [["ciudad", "texto_libre"]]);
  assertStringIncludes((x.encolados[0].variables as { texto: string }).texto, "nos falta la ciudad. ¿Nos pasás el nombre de tu ciudad o tu ubicación 📍 por acá?");
});

Deno.test("texto: ciudad y dirección juntas; sin nombre arranca con Hola", () => {
  assertEquals(textoReconfirmar({ primerNombre: null, pedido: "#9006", faltaCiudad: true, faltaDireccion: true }),
    "Hola, tu pedido #9006 sigue esperando para salir: nos falta la ciudad y la dirección (calle o barrio y una referencia) o tu ubicación 📍. ¿Nos pasás esos datos por acá? Apenas lo tengamos, sale 🙌");
});

Deno.test("despachable → nada (ya está en la lista de las 12:30)", async () => {
  const x = deps([fila(9007)]);
  const lista = armarLista([fila(9007)], [], new Set(), AHORA);
  assertEquals([...lista.porCourier.values()].flat().length, 1);
  const r = await correrPedidos48h(x.d, AHORA);
  assertEquals([r.hechos.length, x.escrituras.length], [0, 0]);
});

Deno.test("SIN_COBERTURA o comprobante sin verificar → nada (otros flujos)", async () => {
  const x = deps([fila(9008, { tags: "CONFIRMADO, SIN_COBERTURA" }), fila(9009, { tags: "CONFIRMADO, PAGO_ANTICIPADO_COMPROBANTE" })]);
  const r = await correrPedidos48h(x.d, AHORA);
  assertEquals([r.candidatos, r.hechos.length, x.escrituras.length], [2, 0, 0]);
});

const listaCon = (nombre: string, clave: string, motivo: string): ListaDespacho => ({
  porCourier: new Map(), retiros: [], sinConfirmar: 0,
  noDespachar: [{ p: { nombre, direccionOk: true } as PedidoLista, clave, quien: "Enrique", motivo }],
});

Deno.test("otro motivo (no lo resuelve el cliente) → UN Telegram a Enrique; la segunda corrida no repite", async () => {
  const x = deps([fila(9010)], { lista: listaCon("#9010", "no_recibe", "No recibe: historial de no recepción · resuelve Enrique") });
  const r1 = await correrPedidos48h(x.d, AHORA);
  assertEquals(r1.hechos.map((h) => [h.accion, h.ok]), [["telegram", true]]);
  assertEquals(x.avisos, ["⏳ <b>#9010</b>: confirmado hace 49 h y no sale: No recibe: historial de no recepción · resuelve Enrique."]);
  assert(x.tomados.has(idCandadoAviso("9010")));
  await correrPedidos48h(x.d, AHORA);
  assertEquals(x.avisos.length, 1);
});

Deno.test("Telegram falla → suelta el candado (se reintenta)", async () => {
  const x = deps([fila(9011)], { lista: listaCon("#9011", "sin_flete", "Falta flete"), telegramOk: false });
  const r = await correrPedidos48h(x.d, AHORA);
  assertEquals([r.hechos[0].ok, x.tomados.has(idCandadoAviso("9011"))], [false, false]);
});

Deno.test("falta un dato del cliente pero no tiene WhatsApp → Telegram a Enrique", async () => {
  const x = deps([fila(9012, { calle: "", cliente: null })]);
  await correrPedidos48h(x.d, AHORA);
  assertEquals(x.avisos, ["⏳ <b>#9012</b>: confirmado hace 49 h y no sale: falta la dirección (calle o barrio y una referencia) y no tiene WhatsApp para pedírselo."]);
});

Deno.test("CIUDAD_POR_PIN (ciudad ya corregida con el pin) → no se le pregunta la ciudad al cliente", async () => {
  const x = deps([fila(9013, { ciudad: "Casa", tags: "CONFIRMADO, CIUDAD_POR_PIN" })]);
  const r = await correrPedidos48h(x.d, AHORA);
  assertEquals(x.encolados.length, 0);
  assertEquals(r.hechos.map((h) => h.accion), ["telegram"]);
  assertStringIncludes(x.avisos[0], "CIUDAD_POR_PIN");
});

Deno.test("de noche (21:00 PY) → espera, sin escribir nada; a las 8:00 sale", async () => {
  const noche = new Date("2026-11-06T00:00:00Z");
  const x = deps([fila(9014, { calle: "" })]);
  const r = await correrPedidos48h(x.d, noche);
  assertEquals([r.hechos.map((h) => h.accion), x.escrituras], [["esperar_horario"], []]);
  const r2 = await correrPedidos48h(x.d, new Date("2026-11-06T11:00:00Z"));
  assertEquals(r2.hechos.map((h) => h.accion), ["texto_libre"]);
});

Deno.test("apagado por defecto (config_wa.pedidos_48h vacío) → no hace nada", async () => {
  const x = deps([fila(9015, { calle: "" })], { activo: false });
  const r = await correrPedidos48h(x.d, AHORA);
  assertEquals([r.activo, r.hechos.length, x.escrituras.length], [false, 0, 0]);
});

Deno.test("simular → informa qué haría sin tomar candados ni escribir (aunque esté apagado)", async () => {
  const lista = armarLista([fila(9016, { calle: "" }), fila(9017)], [], new Set(), AHORA);
  lista.noDespachar.push(...listaCon("#9017", "no_recibe", "No recibe").noDespachar);
  const x = deps([fila(9016, { calle: "" }), fila(9017)], { activo: false, lista });
  const r = await correrPedidos48h(x.d, AHORA, true);
  assertEquals(r.hechos.map((h) => [h.pedido, h.accion]), [["#9016", "texto_libre"], ["#9017", "telegram"]]);
  assertEquals(x.escrituras, []);
});
