// lista-despacho/motor_test.ts · 16-11 (paquete b). Pedidos que todavía no están en Ventas: el courier sale del motor
// (misma rpc motor_courier que Despacho), no de la lista vieja. Si el motor no responde, la lista lo dice.
// Datos INVENTADOS (N.º de pedido, ciudades reales solo como nombre de ciudad).
import { assert, assertEquals } from "@std/assert";
import { armarLista, claveMotor, consultasMotor, type DecisionMotor, motorRige, textoLista } from "./logica.ts";
import { decisionesMotor } from "./carga.ts";

const AHORA = new Date("2026-11-16T15:30:00Z");
const ped = (n: number, tags: string, prod: string, ciudad: string, extra: Record<string, unknown> = {}) => ({
  nombre: `#${n}`, estado_envio: null, es_borrador: false, creado_en: "2026-11-16T10:00:00-03:00",
  raw: { name: `#${n}`, tags, financial_status: "pending", total_price: "112000", shipping_address: { city: ciudad, address1: "Calle Inventada 123" },
    line_items: [{ name: prod, quantity: 1 }], ...extra },
});
const courierDe = (l: ReturnType<typeof armarLista>, nombre: string) =>
  [...l.porCourier.entries()].find(([, ps]) => ps.some((p) => p.nombre === nombre))?.[0] ?? null;

Deno.test("sin venta, Villarrica contra entrega: con el motor = lucero (antes la lista vieja decía pap)", () => {
  const f = [ped(9301, "CONFIRMADO", "Raspador de Lengua", "Villarrica")];
  const motor = new Map<string, DecisionMotor | null>([[claveMotor("Villarrica", "Raspador de Lengua", 112000, true), { ganador: "lucero", sin_cobertura: false }]]);
  const l = armarLista(f, [], new Set(), AHORA, undefined, motor);
  assertEquals(courierDe(l, "#9301"), "lucero");
  assert(!textoLista(l, AHORA)!.includes("motor sin respuesta"));
});

Deno.test("el motor manda aunque el respaldo diga otra cosa (ganador pap)", () => {
  const f = [ped(9302, "CONFIRMADO", "Raspador de Lengua", "Asunción")];
  const motor = new Map([[claveMotor("Asunción", "Raspador de Lengua", 112000, true), { ganador: "pap", sin_cobertura: false }]]);
  assertEquals(courierDe(armarLista(f, [], new Set(), AHORA, undefined, motor), "#9302"), "pap");
});

Deno.test("motor activo sin respuesta: queda el respaldo y la lista avisa 'motor sin respuesta: revisar courier'", () => {
  const f = [ped(9303, "CONFIRMADO", "Raspador de Lengua", "Concepción")];
  const l = armarLista(f, [], new Set(), AHORA, undefined, new Map([[claveMotor("Concepción", "Raspador de Lengua", 112000, true), null]]));
  assertEquals(courierDe(l, "#9303"), "pap");
  const p = [...l.porCourier.values()].flat()[0];
  assertEquals(p.motorSinRespuesta, true);
  assert(textoLista(l, AHORA)!.includes("motor sin respuesta: revisar courier"));
});

Deno.test("motor sin_cobertura en contra entrega → no sale (sin cobertura), no por la lista vieja", () => {
  const f = [ped(9304, "CONFIRMADO", "Raspador de Lengua", "Villarrica")];
  const motor = new Map([[claveMotor("Villarrica", "Raspador de Lengua", 112000, true), { ganador: null, sin_cobertura: true }]]);
  const l = armarLista(f, [], new Set(), AHORA, undefined, motor);
  assertEquals([...l.porCourier.values()].flat().length, 0);
  // Sin la tabla (2.ª pasada de carga.ts) queda "ciudad por confirmar"; con la tabla, "sin cobertura". Nunca sale por PaP.
  assertEquals(l.noDespachar.length, 1);
  assert(["sin_cobertura", "ciudad"].includes(l.noDespachar[0].clave));
});

Deno.test("lo ya cargado en Ventas se respeta (el motor no reasigna) y motor apagado = como antes", () => {
  const f = [ped(9305, "CONFIRMADO", "Raspador de Lengua", "Villarrica"), ped(9306, "CONFIRMADO", "Raspador de Lengua", "Concepción")];
  const motor = new Map([[claveMotor("Villarrica", "Raspador de Lengua", 112000, true), { ganador: "lucero", sin_cobertura: false }]]);
  const l = armarLista(f, [{ n_referencia: "VT-9305", transportadora: "pap", despachado_at: null }], new Set(), AHORA, undefined, motor);
  assertEquals(courierDe(l, "#9305"), "pap");
  const sinMotor = armarLista(f, [], new Set(), AHORA);
  assertEquals(courierDe(sinMotor, "#9306"), "pap");
  assert(![...sinMotor.porCourier.values()].flat().some((p) => p.motorSinRespuesta));
});

Deno.test("consultas al motor: solo pedidos sin courier en Ventas, una por clave; pagado va con cod=false; JawFlex manda el producto", () => {
  const f = [
    ped(9307, "CONFIRMADO", "Raspador de Lengua", "Villarrica"),
    ped(9308, "CONFIRMADO", "Raspador de Lengua", "Villarrica"),
    ped(9309, "CONFIRMADO, PAGADO, PAGO_VERIFICADO", "Raspador de Lengua", "Asunción", { financial_status: "paid" }),
    ped(9310, "CONFIRMADO", "Raspador de Lengua", "Luque"),
    { ...ped(9311, "CONFIRMADO", "x", "Limpio"), raw: { ...ped(9311, "CONFIRMADO", "x", "Limpio").raw, line_items: [{ name: "Raspador de Lengua", quantity: 1 }, { name: "Ejercitador de Mandíbula JawFlex", quantity: 1 }] } },
  ];
  const c = consultasMotor(f, [{ n_referencia: "VT-9310", transportadora: "lucero", despachado_at: null }]);
  const claves = c.map((x) => claveMotor(x.ciudad, x.producto, x.cobro, x.cod));
  assertEquals(claves.length, 3);
  assert(claves.includes(claveMotor("Villarrica", "Raspador de Lengua", 112000, true)));
  assert(claves.includes(claveMotor("Asunción", "Raspador de Lengua", 112000, false)));
  assert(claves.includes(claveMotor("Limpio", "Ejercitador de Mandíbula JawFlex", 112000, true)));
});

Deno.test("interruptor: activo y desde (hora PY) como en Despacho; cualquier cosa rara = apagado", () => {
  assertEquals(motorRige('{"activo": true, "desde": "2026-11-03"}', AHORA), true);
  assertEquals(motorRige('{"activo": true, "desde": "2026-12-01"}', AHORA), false);
  assertEquals(motorRige('{"activo": false}', AHORA), false);
  assertEquals(motorRige("roto", AHORA), false);
  assertEquals(motorRige(null, AHORA), false);
});

Deno.test("decisionesMotor: rpc lenta (tope) o con error → null (sin respuesta); respuesta válida → decisión", async () => {
  const lenta = () => new Promise<{ data: unknown; error: unknown }>(() => {});
  const consultas = [
    { ciudad: "Villarrica", producto: "Raspador de Lengua", cobro: 112000, cod: true },
    { ciudad: "Concepción", producto: "Raspador de Lengua", cobro: 112000, cod: true },
    { ciudad: "Luque", producto: "Raspador de Lengua", cobro: 112000, cod: true },
  ];
  const m = await decisionesMotor(consultas, (args) => {
    if (args.p_ciudad === "Villarrica") return Promise.resolve({ data: { ganador: "lucero", regla: "guarda_lucero" }, error: null });
    if (args.p_ciudad === "Concepción") return Promise.resolve({ data: null, error: { message: "caída" } });
    return lenta();
  }, 30);
  assertEquals(m.get(claveMotor("Villarrica", "Raspador de Lengua", 112000, true)), { ganador: "lucero", sin_cobertura: false });
  assertEquals(m.get(claveMotor("Concepción", "Raspador de Lengua", 112000, true)), null);
  assertEquals(m.get(claveMotor("Luque", "Raspador de Lengua", 112000, true)), null);
});
