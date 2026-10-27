import { assert, assertEquals } from "@std/assert";
import { armarLista, esKit, NOTA_ARMADO_KIT, textoLista } from "./logica.ts";
import { NOTA_ARMADO_JAWFLEX } from "../_shared/telegram_formato.ts";

const AHORA = new Date("2026-10-27T15:30:00Z");

const ped = (n: number, tags: string, prods: [string, number][], extra: Record<string, unknown> = {}, estado: string | null = null, ciudad = "Asunción") => ({
  nombre: `#${n}`, estado_envio: estado, es_borrador: false, creado_en: "2026-10-27T10:00:00-03:00",
  raw: { name: `#${n}`, tags, financial_status: "pending", total_price: "158000", shipping_address: { city: ciudad },
    line_items: prods.map(([name, quantity]) => ({ name, quantity })), ...extra },
});

Deno.test("confirmado sale agrupado por courier; sin confirmar, cancelado, reemplazado y ya preparado no", () => {
  const l = armarLista([
    ped(1, "CONFIRMADO, releasit_cod_form", [["Raspador de Lengua: aliento más limpio", 1]]),
    ped(2, "releasit_cod_form", [["Raspador de Lengua: aliento más limpio", 1]]),
    ped(3, "CANCELADO_CLIENTE", [["Parches Bucales: dormí por la nariz", 1]]),
    ped(4, "CONFIRMADO, REEMPLAZADO_POR_#1128", [["Parches Bucales: dormí por la nariz", 1]]),
    ped(5, "CONFIRMADO", [["Parches Bucales: dormí por la nariz", 3]], {}, "EN_PREPARACION"),
    ped(6, "CONFIRMADO, DESPACHADO", [["Parches Bucales: dormí por la nariz", 2]], {}, "DESPACHADO"),
    ped(9, "CONFIRMADO", [["Raspador de Lengua", 1]], { fulfillment_status: "fulfilled" }),
  ], [], new Set(), AHORA);
  const todos = [...l.porCourier.values()].flat();
  assertEquals(todos.map((p) => p.nombre), ["#1"]);
  assertEquals(l.sinConfirmar, 1);
});

Deno.test("retiro de más de 7 días no se repite", () => {
  const viejo = { ...ped(50, "CONFIRMADO, RETIRO_EN_CASA", [["Pack GUDAIR", 1]]), creado_en: "2026-10-19T10:00:00-03:00" };
  assertEquals(armarLista([viejo], [], new Set(), AHORA).retiros.length, 0);
});

Deno.test("ya con salida en ventas o fila en entregas no se lista", () => {
  const l = armarLista([ped(7, "CONFIRMADO", [["Raspador de Lengua", 1]]), ped(8, "CONFIRMADO", [["Raspador de Lengua", 1]])],
    [{ n_referencia: "VT-7", transportadora: "lucero", despachado_at: "2026-10-27T13:00:00Z" }], new Set(["VT-8"]));
  assertEquals([...l.porCourier.values()].flat().length, 0);
});

Deno.test("nota de armado: JawFlex ×3 por pares y Kit Deporte; JawFlex ×2 sin nota", () => {
  const l = armarLista([
    ped(10, "CONFIRMADO", [["Ejercitador de Mandíbula: entrená en minutos", 3]]),
    ped(11, "CONFIRMADO", [["Kit Deporte: Botella Deportiva + Tiras Nasales", 1]]),
    ped(12, "CONFIRMADO", [["Ejercitador de Mandíbula: entrená en minutos", 2]]),
  ], [], new Set());
  const p = new Map([...l.porCourier.values()].flat().map((x) => [x.nombre, x]));
  assertEquals(p.get("#10")!.armado, [NOTA_ARMADO_JAWFLEX]);
  assertEquals(p.get("#11")!.armado, [NOTA_ARMADO_KIT]);
  assertEquals(p.get("#12")!.armado, []);
  assert(esKit("Kit Deporte (Botella Flexible + Tiras nasales)") && !esKit("Botella Deportiva Flexible"));
  const t = textoLista(l, AHORA)!;
  assert(t.includes("ARMAR: 1 par suave + 1 par medio + 1 par duro") && t.includes("ARMAR: 1 botella + 1 tiras"));
});

Deno.test("pagado = cobrar 0 y va primero; factura, retiro y total distinto salen en la lista", () => {
  const l = armarLista([
    ped(20, "CONFIRMADO", [["Raspador de Lengua", 1]], { note: "Factura: 80012345-6 Juan" }),
    ped(21, "CONFIRMADO, PAGADO, PAGO_VERIFICADO, PRIORIDAD", [["Raspador de Lengua", 1]], { financial_status: "paid" }),
    ped(22, "CONFIRMADO, RETIRO_EN_CASA", [["Parches Bucales", 1]]),
    ped(23, "CONFIRMADO, TOTAL_DISTINTO", [["Parches Bucales", 1]], { note: "Total distinto: el cliente dijo 79.000" }),
  ], [], new Set());
  const lista = [...l.porCourier.values()].flat();
  const pagado = lista.find((p) => p.nombre === "#21")!;
  assert(pagado.pagado && pagado.prioridad);
  assertEquals(l.retiros.map((p) => p.nombre), ["#22"]);
  const t = textoLista(l, AHORA)!;
  assert(t.includes("PAGADO · cobrar 0") && t.includes("Cobrar Gs 158.000"));
  assert(t.includes("factura: 80012345-6 Juan") && t.includes("Retiro en persona (1)") && t.includes("total distinto: el cliente dijo 79.000"));
  const grupo = [...l.porCourier.values()].find((g) => g.some((p) => p.nombre === "#21"))!;
  assertEquals(grupo[0].nombre, "#21");
});

Deno.test("No despachar con el motivo: faltan datos, comprobante sin verificar, sin cobertura sin pago", () => {
  const l = armarLista([
    ped(30, "CONFIRMADO, FALTAN_DATOS, SIN_PIN", [["Pack GUDAIR", 1]]),
    ped(31, "CONFIRMADO, PAGO_ANTICIPADO_COMPROBANTE", [["Raspador de Lengua", 1]]),
    ped(32, "CONFIRMADO, SIN_COBERTURA", [["Raspador de Lengua", 3]], {}, null, "Colonia Manitoba"),
    ped(33, "CONFIRMADO, SIN_COBERTURA, SIN_COBERTURA_CANCELADO", [["Raspador de Lengua", 1]]),
  ], [], new Set());
  assertEquals(l.noDespachar.map((x) => x.p.nombre), ["#30", "#31", "#32"]);
  const t = textoLista(l, AHORA)!;
  assert(t.includes("No despachar (3)") && t.includes("sin pin") && t.includes("verificá el pago") && t.includes("espera el pago anticipado"));
});

Deno.test("sin nada para despachar no hay mensaje; prueba marca el texto", () => {
  assertEquals(textoLista(armarLista([ped(40, "releasit_cod_form", [["Raspador", 1]])], [], new Set()), AHORA), null);
  const t = textoLista(armarLista([ped(41, "CONFIRMADO", [["Raspador", 1]])], [], new Set()), AHORA, true)!;
  assert(t.startsWith("🧪 PRUEBA"));
});
