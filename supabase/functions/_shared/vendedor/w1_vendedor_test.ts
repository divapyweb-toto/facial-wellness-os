// Pruebas de w1_vendedor.ts y extrasVendedor (19-10, paquete 1). Datos inventados: repo público.
import { assert, assertEquals, assertFalse } from "jsr:@std/assert@1";
import { extrasVendedor, MODELO_TOPE_DEFAULT } from "./config.ts";
import { CFG_VENDEDOR_DEFAULT, type CfgVendedor } from "./tipos.ts";
import {
  accionesHechas,
  alertasTope,
  bloqueParaAcuse,
  confirmacionBloqueada,
  esEntranteNoVendedor,
  esOfertaNuestra,
  type FilaW1,
  handleDeOferta,
  hayPosteriorParaVendedor,
  juntandoDatos,
  mesAsuncion,
  nivelTope,
} from "./w1_vendedor.ts";

const cfgV = (x: Record<string, unknown> = {}) => ({ ...CFG_VENDEDOR_DEFAULT, ...x }) as CfgVendedor;
const txt = (direccion: "in" | "out", texto: string, id: string): FilaW1 => ({ direccion, texto, tipo: "text", contenido: {}, estado: "entregado", wa_message_id: id });
const botones = (id: string, cuerpo: string, ids: string[]): FilaW1 => ({
  direccion: "out", texto: `[button] ${cuerpo}`, tipo: "interactive", estado: "entregado", wa_message_id: id,
  contenido: { interactive: { type: "button", body: { text: cuerpo }, action: { buttons: ids.map((i) => ({ type: "reply", reply: { id: i, title: "x" } })) } } },
});

Deno.test("extrasVendedor: defaults (Haiku 4.5, duro = tope × 1,3, alertas 70/90, 18 s) y valores de config", () => {
  assertEquals(extrasVendedor(cfgV()), { modelo_tope: MODELO_TOPE_DEFAULT, tope_duro_usd: 58.5, alertas_tope_pct: [70, 90], espera_agrupar_datos_s: 18 });
  const x = extrasVendedor(cfgV({ tope_mensual_usd: 90, modelo_tope: "m", tope_duro_usd: 120, alertas_tope_pct: [50, 80, 150, "x"], espera_agrupar_datos_s: 15 }));
  assertEquals(x, { modelo_tope: "m", tope_duro_usd: 120, alertas_tope_pct: [50, 80], espera_agrupar_datos_s: 15 });
  assertEquals(extrasVendedor(cfgV({ tope_mensual_usd: 90 })).tope_duro_usd, 117);
  // Un tope duro menor que el tope no vale: queda el tope.
  assertEquals(extrasVendedor(cfgV({ tope_mensual_usd: 90, tope_duro_usd: 10 })).tope_duro_usd, 90);
});

Deno.test("tope: niveles y alertas cruzadas", () => {
  const e = extrasVendedor(cfgV({ tope_mensual_usd: 90 }));
  assertEquals([nivelTope(10, 90, e), nivelTope(90, 90, e), nivelTope(116.9, 90, e), nivelTope(117, 90, e)], ["normal", "barato", "barato", "duro"]);
  assertEquals(alertasTope(60, 90, e).map((a) => a.clave), []);
  assertEquals(alertasTope(63, 90, e).map((a) => a.clave), ["70"]);
  assertEquals(alertasTope(81, 90, e).map((a) => a.clave), ["70", "90"]);
  assertEquals(alertasTope(95, 90, e).map((a) => a.clave), ["70", "90", "100"]);
  assertEquals(alertasTope(120, 90, e).map((a) => a.clave), ["70", "90", "100", "duro"]);
  assert(alertasTope(81, 90, e)[1].texto.includes("USD 81.00 de 90.00"));
  assertEquals(mesAsuncion(new Date("2026-11-01T02:00:00Z")), "2026-10"); // 23 h del 31-10 en Asunción
});

Deno.test("no van al vendedor: reacción, botones de permiso / testimonio, marca no_vendedor", () => {
  const boton = (id: string): FilaW1 => ({ direccion: "in", texto: "x", tipo: "interactive", contenido: { interactive: { button_reply: { id } } }, estado: "recibido", wa_message_id: id });
  assert(esEntranteNoVendedor({ ...txt("in", "", "r"), tipo: "reaction" }));
  assert(esEntranteNoVendedor(boton("cons_si:abc")));
  assert(esEntranteNoVendedor(boton("tst_no:abc")));
  assert(esEntranteNoVendedor({ ...txt("in", "si", "s"), contenido: { no_vendedor: true } }));
  assertFalse(esEntranteNoVendedor(boton("vend_conf:pc-1")));
  assertFalse(esEntranteNoVendedor(txt("in", "hola", "h")));
  const filas = [txt("in", "hola", "A"), { ...txt("in", "", "R"), tipo: "reaction" }];
  assertEquals(hayPosteriorParaVendedor(filas, "A"), false);
  assertEquals(hayPosteriorParaVendedor([...filas, txt("in", "y?", "B")], "A"), true);
  assertEquals(hayPosteriorParaVendedor(filas, "Z"), null);
  assertEquals(bloqueParaAcuse([txt("out", "listo", "o"), boton("cons_si:abc"), txt("in", "ok", "A")], "A", "ok"), ["ok"]);
});

Deno.test("juntando datos: pedimos datos, parece dirección o mensaje cortado; acuses y preguntas no", () => {
  const pide = [txt("out", "Pasame tu nombre y dirección.", "o")];
  assert(juntandoDatos(pide, "Ana Prueba"));
  assert(juntandoDatos([], "Calle Falsa 123 casi Mcal López"));
  assert(juntandoDatos([], "vivo en el barrio san"));
  assert(juntandoDatos([], "frente a la plaza y"));
  assert(juntandoDatos([], "Confirmar (vend_corr:pc-1)"));
  assertFalse(juntandoDatos(pide, "ok"));
  assertFalse(juntandoDatos([], "cuánto sale?"));
  assertFalse(juntandoDatos([], "hola"));
  // El resumen con Confirmo / Corregir no es "pedir datos" aunque diga la dirección.
  assertFalse(juntandoDatos([botones("o", "Dirección: Calle 1, Asunción. Total Gs 112.000", ["vend_conf:pc-1", "vend_corr:pc-1"])], "perfecto"));
});

Deno.test("oferta nuestra y handle de los botones", () => {
  const p1 = botones("o", "Sale 79.000 + envío, pagás al recibir.", ["vend_p1:q1:tiras-x", "vend_p1:duda:tiras-x"]);
  assert(esOfertaNuestra(p1));
  assert(esOfertaNuestra(txt("out", "Salen Gs 79.000, pagás al recibir.", "o")));
  assertFalse(esOfertaNuestra(txt("out", "Te llega el jueves, cualquier cosa escribime.", "o")));
  assertFalse(esOfertaNuestra(botones("o", "Total Gs 112.000", ["vend_conf:pc-1"])));
  assertEquals(handleDeOferta([p1, txt("out", "otra cosa", "o2")]), "tiras-x");
  assertEquals(handleDeOferta([botones("o", "Elegí", ["vend_cant:raspador-x:2"])]), "raspador-x");
  assertEquals(handleDeOferta([txt("out", "Sale 79.000", "o")]), null);
});

Deno.test("un solo resumen vigente: viejo con otro total → bloquea; mismo total, el vigente o sin historial → pasa", () => {
  const r1 = botones("o1", "Tiras x1 + envío = Gs 112.000", ["vend_conf:pc-1"]);
  const r2 = botones("o2", "Tiras x2 envío gratis = Gs 125.000", ["vend_conf:pc-2"]);
  const r2b = botones("o3", "Tiras x1 + envío = Gs 112.000 (otra referencia)", ["vend_conf:pc-3"]);
  const vig = (id: string) => ({ id, estado: "resumen" });
  assert(confirmacionBloqueada({ textoCliente: "Confirmo (vend_conf:pc-1)", filas: [r1, r2], vigente: vig("pc-2") })?.error.startsWith("boton_de_resumen_viejo"));
  assertEquals(confirmacionBloqueada({ textoCliente: "Confirmo (vend_conf:pc-1)", filas: [r1, r2b], vigente: vig("pc-3") }), null);
  assertEquals(confirmacionBloqueada({ textoCliente: "Confirmo (vend_conf:pc-2)", filas: [r1, r2], vigente: vig("pc-2") }), null);
  assertEquals(confirmacionBloqueada({ textoCliente: "Confirmo (vend_conf:pc-1)", filas: [r2], vigente: vig("pc-2") }), null);
  assertEquals(confirmacionBloqueada({ textoCliente: "si", filas: [r1], vigente: vig("pc-1") }), null);
  assertEquals(confirmacionBloqueada({ textoCliente: "Confirmo (vend_conf:pc-1)", filas: [r1, r2], vigente: { id: "pc-2", estado: "creado" } }), null);
  // Tocó "2 con envío gratis" después del resumen → resumen nuevo.
  assert(confirmacionBloqueada({ textoCliente: "2 con envío gratis (vend_p1:q2:tiras-x)\nsi", filas: [r1], vigente: vig("pc-1") })?.error.startsWith("cantidad_elegida"));
});

Deno.test("acciones hechas: solo herramientas con ok; crear_pedido_cod solo con confirmar=true", () => {
  const h = (nombre: string, input: unknown, ok = true) => ({ nombre, input, resultado: { ok }, error: !ok });
  assertEquals(accionesHechas([h("crear_pedido_cod", { confirmar: false }), h("actualizar_direccion", {}), h("modificar_pedido", {}, false)]), ["actualizar_direccion"]);
  assertEquals(accionesHechas([h("crear_pedido_cod", { confirmar: true })], { pedidoYaCreado: true }), ["crear_pedido_cod:confirmar", "pedido_ya_creado"]);
});
