// Tests de datos.ts con dependencias falsas. Datos inventados (repo público).
import { assert, assertEquals, assertFalse, assertStringIncludes } from "jsr:@std/assert@1";
import type { PrecioModelo } from "../_shared/claude.ts";
import { armarLoteClasificacion } from "./clasificar.ts";
import {
  armarConversacion,
  contextoDesdeFilas,
  type ContextoConversacion,
  type DepsDatos,
  type MensajeCrudo,
  mesAnterior,
  rangoMesAsuncion,
  recolectarMes,
  recortarMensajes,
  textoVisible,
} from "./datos.ts";
import { CFG_MEJORA_DEFAULT, type ConversacionResultado, type MensajeAnon } from "./tipos.ts";

const PRECIO: PrecioModelo = { entrada: 1, salida: 5, cache_escritura_5m: 1.25, cache_escritura_1h: 2, cache_lectura: 0.1, lote: 0.5 };
const cfg = CFG_MEJORA_DEFAULT;

function uuid(n: number): string {
  return `00000000-0000-4000-8000-${String(n).padStart(12, "0")}`;
}

function msg(conv: number, dir: "in" | "out", texto: string | null, min: number, extra: Partial<MensajeCrudo> = {}): MensajeCrudo {
  return { conversacion_id: uuid(conv), direccion: dir, tipo: "text", texto, creado_en: new Date(Date.UTC(2026, 8, 10, 12, min)).toISOString(), ...extra };
}

function res(conv: number, r: Partial<ConversacionResultado> = {}): ConversacionResultado {
  return {
    conversacion_id: uuid(conv),
    cliente_id: null,
    shopify_order_id: null,
    resultado: "sin_compra",
    costo_ia_usd: 0,
    costo_mensajes_usd: 0,
    tuvo_reclamo: false,
    paso_escalera: null,
    derivado: false,
    ...r,
  };
}

Deno.test("rangoMesAsuncion: mes completo en hora de Asunción (UTC-3)", () => {
  const r = rangoMesAsuncion("2026-09");
  assertEquals(r.mes, "2026-09-01");
  assertEquals(r.desde.toISOString(), "2026-09-01T03:00:00.000Z");
  assertEquals(r.hasta.toISOString(), "2026-10-01T03:00:00.000Z");
  assertEquals(rangoMesAsuncion("2026-12-01").hasta.toISOString(), "2027-01-01T03:00:00.000Z");
});

Deno.test("mesAnterior según la fecha local de Asunción", () => {
  assertEquals(mesAnterior(new Date("2026-10-01T12:00:00Z")), "2026-09-01");
  // 02:00 UTC del 1-ene = 23:00 del 31-dic en Asunción → mes local diciembre → anterior noviembre
  assertEquals(mesAnterior(new Date("2026-01-01T02:00:00Z")), "2025-11-01");
  assertEquals(mesAnterior(new Date("2026-01-01T12:00:00Z")), "2025-12-01");
});

Deno.test("textoVisible: audio transcripto, botones, ubicación, imagen con texto", () => {
  assertEquals(textoVisible(msg(1, "in", null, 0, { tipo: "audio", transcripcion: "pasame el precio" })), "[audio] pasame el precio");
  assertEquals(textoVisible(msg(1, "in", null, 0, { tipo: "audio" })), "[audio sin transcripción]");
  assertEquals(textoVisible(msg(1, "in", null, 0, { tipo: "interactive", boton: "Confirmar" })), "[botón] Confirmar");
  assertEquals(textoVisible(msg(1, "in", null, 0, { tipo: "location" })), "[ubicación]");
  assertEquals(textoVisible(msg(1, "in", null, 0, { tipo: "contacts" })), "[contacto]");
  assertEquals(textoVisible(msg(1, "in", null, 0, { tipo: "image", caption_img: "así llegó" })), "[image] así llegó");
  assertEquals(textoVisible(msg(1, "out", null, 0, { tipo: "template" })), "[plantilla]");
});

Deno.test("recortarMensajes: conversación larga → primeros y últimos, dentro del máximo", () => {
  const largos: MensajeAnon[] = Array.from({ length: 120 }, (_, i) => ({ de: i % 2 ? "V" : "C", texto: `mensaje ${i} ` + "x".repeat(80) }));
  const r = recortarMensajes(largos, cfg);
  assert(r.recortada);
  const largo = r.mensajes.reduce((s, m) => s + m.texto.length + 4, 0);
  assert(largo <= cfg.max_chars_conversacion, `largo ${largo}`);
  assertStringIncludes(r.mensajes[0].texto, "mensaje 0 ");
  assertStringIncludes(r.mensajes.at(-1)!.texto, "mensaje 119 ");
  assert(r.mensajes.some((m) => /mensajes omitidos/.test(m.texto)));
  const cortos: MensajeAnon[] = [{ de: "C", texto: "hola" }, { de: "V", texto: "¡Hola!" }];
  assertEquals(recortarMensajes(cortos, cfg), { mensajes: cortos, recortada: false });
  const enorme = recortarMensajes([{ de: "C", texto: "y".repeat(3000) }, { de: "V", texto: "z".repeat(3000) }], cfg);
  assert(enorme.mensajes.reduce((s, m) => s + m.texto.length, 0) <= cfg.max_chars_conversacion);
});

Deno.test("contextoDesdeFilas junta nombres, teléfonos, direcciones, pedidos y documentos", () => {
  const c = contextoDesdeFilas({
    conversacion_id: uuid(1),
    cliente: { nombre: "Nora Ficticia", wa_username: "nora_fic", telefono: "+595981000001" },
    pedidos: [{
      shopify_order_id: 5600000000001,
      nombre: "#1001",
      telefono: "+595981000001",
      envio: { first_name: "Nora", last_name: "Ficticia", address1: "Calle Falsa 123", address2: "Barrio Nada", phone: "0981 000 002" },
      cliente_shopify: { first_name: "Nora", last_name: "F.", phone: null },
      factura: null,
    }],
    pedidosChat: [{ shopify_order_id: 5600000000001, datos: { nombre: "Nora Ficticia", direccion: "Calle Falsa 123", referencia: "portón azul", ruc: "4000001-1" } }],
  });
  assertEquals(c.nombres, ["Nora Ficticia", "nora_fic", "Nora F."]);
  assertEquals(c.telefonos, ["+595981000001", "0981 000 002"]);
  assertEquals(c.direcciones, ["Calle Falsa 123", "Barrio Nada", "portón azul"]);
  assertEquals(c.pedidos, ["5600000000001", "#1001"]);
  assertEquals(c.documentos, ["4000001-1"]);
});

Deno.test("armarConversacion: descarta sin entrantes o con pocos mensajes", () => {
  assertEquals(armarConversacion(uuid(1), [msg(1, "out", "hola", 0), msg(1, "out", "?", 1)], undefined, undefined, cfg), { descartada: "sin_entrantes" });
  assertEquals(armarConversacion(uuid(1), [msg(1, "in", "hola", 0)], undefined, undefined, cfg), { descartada: "pocos_mensajes" });
});

// ---------- recolección completa con deps falsas ----------

const CTX: ContextoConversacion[] = [
  {
    conversacion_id: uuid(1),
    nombres: ["Teodora Inventada"],
    telefonos: ["+595981000011"],
    direcciones: ["Avda. Ficción 777 c/ Ninguna"],
    pedidos: ["#1301", "5600000000099"],
    documentos: ["4.000.111"],
  },
];

const CRUDOS = ["Teodora", "teodora", "Inventada", "0981 000 011", "981000011", "Ficción 777", "Ninguna", "1301", "5600000000099", "4.000.111", "4000111", "teo@correo.test"];

function depsFalsas(mensajes: MensajeCrudo[], resultados: ConversacionResultado[], contextos = CTX): DepsDatos & { rangos: string[][] } {
  const rangos: string[][] = [];
  return {
    rangos,
    mensajesEntre: (d, h) => {
      rangos.push([d, h]);
      return Promise.resolve(mensajes);
    },
    resultados: (ids) => Promise.resolve(resultados.filter((r) => ids.includes(r.conversacion_id))),
    contextos: (ids) => Promise.resolve(contextos.filter((c) => ids.includes(c.conversacion_id))),
    log: () => {},
  };
}

const MENSAJES: MensajeCrudo[] = [
  msg(1, "in", "Hola, soy Teodora Inventada. Cuánto sale el limpiador?", 0),
  msg(1, "out", "¡Hola Teodora! Sale Gs 129.000 + envío Gs 33.000 = Gs 162.000, pagás al recibir. ¿Te lo preparo?", 1),
  msg(1, "in", "dale, a Avda. Ficción 777 c/ Ninguna, mi cel 0981 000 011, CI 4.000.111, mail teo@correo.test", 2),
  msg(1, "out", "Listo, tu pedido #1301 quedó creado (id 5600000000099).", 3),
  msg(1, "in", null, 4, { tipo: "audio", transcripcion: "gracias teodora te saluda, mi otro número es 981-000-011" }),
  msg(2, "in", "precio?", 0),
  msg(2, "out", "Sale Gs 129.000. ¿Para qué ciudad sería?", 1),
  msg(3, "in", "hola", 0), // una sola: se descarta
  msg(4, "out", "plantilla", 0, { tipo: "template" }), // sin entrantes
  msg(4, "out", "otra", 1),
];

Deno.test("recolectarMes: anonimiza, pega el resultado, cuenta y descarta", async () => {
  const deps = depsFalsas(MENSAJES, [res(1, { resultado: "entregado", shopify_order_id: 5600000000099, costo_ia_usd: 0.012 }), res(2)]);
  const r = await recolectarMes("2026-09", { deps, cfg, precio: PRECIO });
  assertEquals(deps.rangos[0], ["2026-09-01T03:00:00.000Z", "2026-10-01T03:00:00.000Z"]);
  assertEquals(r.mes, "2026-09-01");
  assertEquals(r.total, 2);
  assertEquals(r.recortadas_por_tope, 0);
  assertEquals(r.conversaciones.map((c) => c.resultado), ["entregado", "sin_compra"]);
  assertEquals(r.conversaciones[0].costo_ia_usd, 0.012);
  assert(r.notas.some((n) => n.includes("pocos_mensajes: 1")));
  assert(r.notas.some((n) => n.includes("sin_entrantes: 1")));
  const t = r.conversaciones[0].transcripcion;
  for (const crudo of CRUDOS) assertFalse(t.includes(crudo), `"${crudo}" quedó en:\n${t}`);
  assertStringIncludes(t, "Gs 129.000");
  assertStringIncludes(t, "[NOMBRE_1]");
  assertStringIncludes(t, "[TEL_1]");
  assertStringIncludes(t, "[PEDIDO_");
  // el mismo teléfono en el audio queda con el mismo código
  assertEquals(t.match(/\[TEL_\d+\]/g)!.every((x) => x === "[TEL_1]"), true);
  assertStringIncludes(t, "C: [audio]");
});

Deno.test("nada crudo llega al lote que se manda a Claude (de punta a punta)", async () => {
  const deps = depsFalsas(MENSAJES, [res(1), res(2)]);
  const r = await recolectarMes("2026-09-01", { deps, cfg, precio: PRECIO });
  const lote = armarLoteClasificacion(r.conversaciones, { cfg, precio: PRECIO, simulado: false });
  const cuerpo = JSON.stringify(lote.pedidos);
  for (const crudo of CRUDOS) assertFalse(cuerpo.includes(crudo), `"${crudo}" en el lote`);
  assertFalse(/\+5959\d{8}/.test(cuerpo));
});

Deno.test("recolectarMes: sin conversaciones, y recorte por tope con nota", async () => {
  const vacio = await recolectarMes("2026-09", { deps: depsFalsas([], []), cfg });
  assertEquals(vacio.total, 0);
  assertEquals(vacio.conversaciones, []);

  const muchos: MensajeCrudo[] = [];
  const resultados: ConversacionResultado[] = [];
  for (let i = 1; i <= 200; i++) {
    muchos.push(msg(i, "in", "hola, cuánto sale? " + "bla ".repeat(400), 0), msg(i, "out", "Sale Gs 129.000. ¿Te lo preparo?", 1));
    resultados.push(res(i, { resultado: i % 4 === 0 ? "entregado" : "sin_compra" }));
  }
  const r = await recolectarMes("2026-09", { deps: depsFalsas(muchos, resultados, []), cfg, precio: PRECIO, presupuestoUsd: 0.05 });
  assertEquals(r.total, 200);
  assert(r.recortadas_por_tope > 0);
  assertEquals(r.conversaciones.length + r.recortadas_por_tope, 200);
  assert(r.notas.some((n) => n.includes("recortada")));
  assert(r.conversaciones.some((c) => c.resultado === "entregado"));

  // topeUsd (tope total del ciclo): usa su parte de clasificación (70 %)
  const r2 = await recolectarMes("2026-09", { deps: depsFalsas(muchos, resultados, []), cfg, precio: PRECIO, topeUsd: 0.05 });
  assert(r2.conversaciones.length < r.conversaciones.length || r2.recortadas_por_tope >= r.recortadas_por_tope);
});

Deno.test("control final: si algo crudo sobrevive, la conversación se descarta", () => {
  const ctx: ContextoConversacion = { conversacion_id: uuid(7), nombres: ["Zoe Prueba"], telefonos: ["+595981000011"], direcciones: [], pedidos: [], documentos: [] };
  // Nombre en mayúsculas y con acento: se tacha y la conversación pasa.
  const ok = armarConversacion(uuid(7), [msg(7, "in", "soy Zoe, ZOE prueba", 0), msg(7, "out", "Hola zoé", 1)], undefined, ctx, cfg);
  assert("conv" in ok);
  if ("conv" in ok) assertFalse(/zo[eé]/i.test(ok.conv.transcripcion));
  // Teléfono partido en pedazos que el detector no une: el control final lo ve y descarta todo.
  const partido = armarConversacion(uuid(7), [msg(7, "in", "mi cel es 0981 000 y lo que sigue 011", 0), msg(7, "out", "dale", 1)], undefined, ctx, cfg);
  assertEquals(partido, { descartada: "control_anonimizacion" });
});
