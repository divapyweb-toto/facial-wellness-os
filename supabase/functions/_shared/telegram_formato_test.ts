// Pruebas de los formatos de aviso a Telegram (datos inventados).
import { assert, assertEquals, assertStringIncludes, assertThrows } from "jsr:@std/assert@1";
import {
  callbackData,
  enlaceWaMe,
  escaparHtml,
  etiquetasAbiertas,
  formatearGuaranies,
  formatoChatNecesitaEnrique,
  formatoFalla,
  formatoPedidoNuevo,
  htmlATextoPlano,
  LIMITE_TEXTO_TELEGRAM,
  partirAviso,
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

// ─── 23-10: recortar a prueba de HTML (la auditoría del 22-10 rebotó por un <i> sin cerrar) ───
const valido = (t: string) => {
  assertEquals(etiquetasAbiertas(t), [], `etiquetas abiertas en: …${t.slice(-80)}`);
  assert(!/&[#a-zA-Z0-9]{0,10}$/.test(t.replace(/\n…\(recortado\)$/, "")), "entidad partida");
  assert(!/<[^>]*$/.test(t), "etiqueta a medio escribir");
};

Deno.test("recortar: texto plano corta en el último salto de línea y avisa", () => {
  const t = recortar(Array.from({ length: 400 }, (_, i) => `línea ${i} con texto`).join("\n"));
  assert(t.length <= LIMITE_TEXTO_TELEGRAM);
  assert(t.endsWith("con texto\n…(recortado)"));
});

Deno.test("recortar: cierra un <i> o <b> que el corte deja abierto, en cualquier punto", () => {
  for (const tag of ["i", "b"]) {
    const linea = `<${tag}>${"x".repeat(300)}</${tag}>`;
    for (let corrimiento = 0; corrimiento < 320; corrimiento += 7) {
      const t = recortar("y".repeat(corrimiento) + linea.repeat(20), 4096);
      assert(t.length <= 4096);
      valido(t);
    }
  }
  // Una sola línea sin saltos: corta dentro de la etiqueta y la cierra.
  const t = recortar("<i>" + "z".repeat(5000) + "</i>", 100);
  assert(t.length <= 100);
  assert(t.startsWith("<i>zz"));
  assert(t.includes("</i>\n…(recortado)"));
});

Deno.test("recortar: no deja <a href=...> a medias ni el enlace sin cerrar", () => {
  const enlace = `<a href="https://voltra.test/bandeja?x=1&amp;c=abc">Abrir en la bandeja</a>`;
  for (let n = 50; n < 200; n++) {
    const t = recortar("ab ".repeat(10) + enlace + " fin " + "q".repeat(300), n);
    assert(t.length <= n);
    valido(t);
  }
});

Deno.test("recortar: no parte un &amp; ni un emoji en el borde", () => {
  for (let n = 30; n < 60; n++) {
    const t = recortar("a".repeat(20) + "&amp;&lt;&gt;🙌".repeat(20), n);
    assert(t.length <= n);
    valido(t);
    assert(!/[\uD800-\uDBFF]\n/.test(t), "medio emoji");
  }
});

Deno.test("recortar: texto plano con < suelto (se escapa después) no se pierde", () => {
  assertEquals(recortar("precio < 100 y más texto", 160), "precio < 100 y más texto");
  assert(recortar("precio < 100 " + "x".repeat(200), 50).startsWith("precio < 100 x"));
});

Deno.test("htmlATextoPlano: saca etiquetas, deja el enlace y desescapa", () => {
  assertEquals(
    htmlATextoPlano(`<b>Hola</b> <i>a &amp; b &lt;c&gt;</i> <a href="https://x.test/?a=1&amp;b=2">abrir</a>`),
    "Hola a & b <c> abrir (https://x.test/?a=1&b=2)",
  );
});

Deno.test("partirAviso: un aviso largo se parte entre casos, cada parte válida y sin perder casos", () => {
  const casos = Array.from({ length: 30 }, (_, i) =>
    [`• <b>Cliente ${i}</b>`, `   ${"detalle ".repeat(25)}`, `   <i>${"resumen &amp; ".repeat(15)}</i>`, `   <a href="https://x.test/?c=${i}">Abrir en la bandeja</a>`].join("\n")
  );
  const texto = ["<b>Auditoría del vendedor · 22/10/2026</b>", "40 revisadas", "", ...casos, "", "<i>nota final</i>"].join("\n");
  assert(texto.length > 4096);
  const partes = partirAviso(texto);
  assert(partes.length >= 2);
  for (const p of partes) {
    assert(p.length <= LIMITE_TEXTO_TELEGRAM);
    valido(p);
  }
  for (let i = 0; i < 30; i++) assertEquals(partes.filter((p) => p.includes(`<b>Cliente ${i}</b>`)).length, 1);
  assert(partes[1].startsWith(`<i>(sigue 2/${partes.length})</i>`));
  assertStringIncludes(partes.at(-1)!, "nota final");
  assertEquals(partirAviso("corto"), ["corto"]);
});
