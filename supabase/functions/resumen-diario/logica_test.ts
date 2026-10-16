import { assert, assertEquals, assertStringIncludes } from "@std/assert";
import { armarResumen, diaParaguay, type Pedido } from "./logica.ts";

const AHORA = new Date("2026-10-17T00:30:00Z"); // 21:30 del 16-10 en Paraguay
const p = (o: Partial<Pedido>): Pedido => ({
  nombre: "#1", creadoEn: "2026-10-16T15:00:00Z", total: 112000, tags: [], canceladoEn: null, esBorrador: false, nota: "",
  lineas: [{ titulo: "Raspador de Lengua", cantidad: 1 }], estadoConfirmacion: "confirmado", estadoEnvio: "DESPACHADO", clienteId: null, ...o,
});
const base = {
  hoy: "2026-10-16", ahora: AHORA, chatsAnuncioHoy: [{ clienteId: "c1" }, { clienteId: "c2" }], chatsBotV33: 98, botV33YaAvisado: null,
  stock: [{ nombre: "Raspador de Lengua", stock: 18 }, { nombre: "Botella Flexible", stock: 47 }],
};
const pedidos = [
  p({ nombre: "#1" }), p({ nombre: "#2", tags: ["ORIGEN_WHATSAPP"], clienteId: "c1", lineas: [{ titulo: "Pack GUDAIR", cantidad: 1 }] }),
  p({ nombre: "#3", total: 158000, lineas: [{ titulo: "Tiras nasales", cantidad: 2 }] }),
  p({ nombre: "#4 PRUEBA" }), p({ nombre: "#5", canceladoEn: "2026-10-16T16:00:00Z" }), p({ nombre: "#6", esBorrador: true }),
  p({ nombre: "#7", creadoEn: "2026-10-16T02:00:00Z" }), // 15-10 23:00 en Paraguay: es de ayer
  p({ nombre: "#8", creadoEn: "2026-10-14T12:00:00Z", estadoEnvio: null }), // confirmado, +24 h, sin despachar
];
const meta = {
  hoy: [{ nombre: "CAMPAÑA VENTAS WEB", gasto: 40000, presupuesto: 100000 }, { nombre: "CAMPAÑA VENTAS WHATSAPP", gasto: 60000, presupuesto: 100000 }],
  ayer: [{ nombre: "CAMPAÑA VENTAS WEB", gasto: 30000, presupuesto: 100000 }],
  gasto7d: 700000,
  prueba: { gasto: 34422, mejor: { nombre: "VID JAWFLEX V4", ctr: 1.93, inicios: 2, compras: 0 } },
};

Deno.test("día en hora de Paraguay (UTC−3)", () => {
  assertEquals(diaParaguay("2026-10-17T02:59:00Z"), "2026-10-16");
  assertEquals(diaParaguay("2026-10-17T03:00:00Z"), "2026-10-17");
});

Deno.test("cuenta solo pedidos válidos del día, por canal y producto; CPA; alertas", () => {
  const { texto } = armarResumen({ ...base, pedidos, meta });
  assertStringIncludes(texto, "Pedidos válidos hoy: <b>3</b> (web 2 · WhatsApp 1) · piso 5-6/día ⚠️");
  assertStringIncludes(texto, "Raspador 1 · Tiras 1 · Pack 1 · JawFlex 0");
  assertStringIncludes(texto, "Unidades: 4 · Facturado: Gs 382.000");
  assertStringIncludes(texto, "Meta hoy: Gs 100.000 (web 40.000 · WhatsApp 60.000)");
  assertStringIncludes(texto, "CPA hoy: Gs 33.333 (web 20.000 · WA 60.000)");
  assertStringIncludes(texto, "50% terminó en pedido");
  assertStringIncludes(texto, "Bot v33: 98/100 chats (falta poco");
  assertStringIncludes(texto, "Prueba de productos: Gs 34.422 hoy");
  assertStringIncludes(texto, "CTR 1,9% · 2 inicios de pago · 0 compras");
  assertStringIncludes(texto, "Web gastó 40% del presupuesto (2.º día bajo 50%");
  assertStringIncludes(texto, "1 pedido sin despachar hace +24 h");
  assertStringIncludes(texto, "Raspador: 18 unidades");
  assertStringIncludes(texto, "CPA 7 días"); // 700.000 / 5 válidos en 7 días = 140.000 > 41.000
  assert(!texto.includes("Botella:"), "stock de Botella no alcanza el tope");
  assert(texto.split("\n").length <= 25, "máximo ~25 líneas");
});

Deno.test("Meta caída: el mensaje sale igual con los pedidos", () => {
  const { texto } = armarResumen({ ...base, pedidos, meta: null, prueba: true });
  assertStringIncludes(texto, "PRUEBA");
  assertStringIncludes(texto, "Meta no respondió");
  assertStringIncludes(texto, "Pedidos válidos hoy: <b>3</b>");
});

Deno.test("bot v33: 100/100 se muestra un día y después desaparece", () => {
  const a = armarResumen({ ...base, pedidos, meta, chatsBotV33: 100 });
  assert(a.botV33Listo); assertStringIncludes(a.texto, "100/100 ✅ listo para mejoras");
  const b = armarResumen({ ...base, pedidos, meta, chatsBotV33: 104, botV33YaAvisado: "2026-10-15" });
  assert(!b.texto.includes("Bot v33"));
});
