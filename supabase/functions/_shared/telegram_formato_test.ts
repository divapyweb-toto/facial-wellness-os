// Pruebas de los formatos de aviso a Telegram (datos inventados).
import { assert, assertEquals, assertStringIncludes, assertThrows } from "jsr:@std/assert@1";
import {
  callbackData,
  enlaceWaMe,
  escaparHtml,
  formatearGuaranies,
  formatoChatNecesitaEnrique,
  formatoFalla,
  formatoPedidoNuevo,
  LIMITE_TEXTO_TELEGRAM,
  recortar,
  textoConDecision,
} from "./telegram_formato.ts";

Deno.test("escaparHtml reemplaza < > &", () => {
  assertEquals(escaparHtml("a<b>&c"), "a&lt;b&gt;&amp;c");
  assertEquals(escaparHtml(null), "");
});

Deno.test("enlaceWaMe quita el + y codifica el resumen", () => {
  assertEquals(enlaceWaMe("+595981000000", "Hola Ana & cía?"), "https://wa.me/595981000000?text=Hola%20Ana%20%26%20c%C3%ADa%3F");
  assertEquals(enlaceWaMe("+595981000000"), "https://wa.me/595981000000");
  assertEquals(enlaceWaMe(null, "x"), null);
  assertEquals(enlaceWaMe("PY.0000TEST", "x"), null);
});

Deno.test("callbackData respeta el formato y el límite de 64 bytes", () => {
  assertEquals(callbackData("cancelar", 5001), "cancelar:5001");
  assertThrows(() => callbackData("reponer", "9".repeat(70)));
});

Deno.test("formatearGuaranies usa punto de miles", () => {
  assertEquals(formatearGuaranies(129000), "₲129.000");
  assertEquals(formatearGuaranies(1250000), "₲1.250.000");
});

Deno.test("pedido nuevo: botón cancelar y enlace wa.me", () => {
  const a = formatoPedidoNuevo({
    shopify_order_id: 5001,
    nombre_pedido: "#1001",
    total: 129000,
    productos: ["Tiras nasales x2"],
    ciudad: "Asunción",
    origen: "web",
    cliente: { nombre: "Ana <Prueba>", telefono: "+595981000000" },
  });
  assertStringIncludes(a.texto, "<b>Pedido nuevo #1001</b>");
  assertStringIncludes(a.texto, "Ana &lt;Prueba&gt;");
  assertStringIncludes(a.texto, "₲129.000");
  assertEquals(a.botones[0][0], { texto: "Cancelar pedido", callback: "cancelar:5001" });
  assertEquals(a.botones[0][1], { texto: "Escribirle", url: "https://wa.me/595981000000" });
});

Deno.test("pedido de cliente sin teléfono lo dice y no pone enlace", () => {
  const a = formatoPedidoNuevo({
    shopify_order_id: 5002,
    cliente: { nombre: "Beto Prueba", telefono: null, wa_user_id: "PY.0000TEST" },
  });
  assertStringIncludes(a.texto, "no tiene teléfono");
  assertEquals(a.botones, [[{ texto: "Cancelar pedido", callback: "cancelar:5002" }]]);
});

Deno.test("chat que necesita a Enrique: resumen, botones de decisión y wa.me con el resumen", () => {
  const a = formatoChatNecesitaEnrique({
    motivo: "Producto dañado",
    resumen: "Llegó la caja abierta. Mandó 2 fotos.",
    shopify_order_id: 5001,
    nombre_pedido: "#1001",
    ofrecerReponer: true,
    cliente: { nombre: "Ana Prueba", telefono: "+595981000000" },
  });
  assertStringIncludes(a.texto, "Te necesita un cliente");
  assertStringIncludes(a.texto, "Llegó la caja abierta");
  assertEquals(a.botones[0].map((b) => b.callback), ["reponer:5001", "escribo:5001"]);
  assertEquals(a.botones[1][0].callback, "cancelar:5001");
  assert(a.botones[2][0].url?.startsWith("https://wa.me/595981000000?text=Lleg%C3%B3"));
});

Deno.test("chat sin pedido ni teléfono: sin botones y lo dice", () => {
  const a = formatoChatNecesitaEnrique({
    motivo: "Pide hablar con una persona",
    resumen: "Consulta mayorista.",
    cliente: { telefono: null, wa_username: "cliente_prueba" },
  });
  assertEquals(a.botones, []);
  assertStringIncludes(a.texto, "usuario: cliente_prueba");
});

Deno.test("falla: título, detalles y qué hacer", () => {
  const a = formatoFalla({ titulo: "Canal sordo", detalles: ["3 h sin mensajes"], queHacer: "Revisá el token" });
  assertStringIncludes(a.texto, "<b>Atención: Canal sordo</b>");
  assertStringIncludes(a.texto, "• 3 h sin mensajes");
  assertStringIncludes(a.texto, "Qué hacer: Revisá el token");
});

Deno.test("recortar no pasa el límite de Telegram", () => {
  assertEquals(recortar("x".repeat(5000)).length, LIMITE_TEXTO_TELEGRAM);
  assertEquals(recortar("corto"), "corto");
});

Deno.test("textoConDecision agrega la decisión con hora de Asunción y no se pasa del límite", () => {
  const t = textoConDecision("x".repeat(5000), "pedido cancelado", ["nota"], new Date("2026-10-06T15:32:00Z"));
  assert(t.length <= LIMITE_TEXTO_TELEGRAM);
  assertStringIncludes(t, "Decisión (06-10 12:32):</b> pedido cancelado");
  assertStringIncludes(t, "• nota");
});
