import { assert, assertEquals, assertFalse } from "jsr:@std/assert@1";
import { type Bloque, ErrorClaude, type PedidoClaude, type RespuestaClaude, simularRespuesta, USO_CERO } from "../claude.ts";
import { _limpiarCacheCatalogo } from "./herramientas.ts";
import { armarHistorial, demoraSegundos, type DepsOrquestador, type FilaHistorial, type FilaTurno, procesarTurno } from "./orquestador.ts";
import { CLIENTE, configPrueba, CONV, depsPrueba, TEL } from "./prueba_utiles.ts";
import type { ConfigTurno } from "./tipos.ts";

type Guion = (p: PedidoClaude, n: number) => RespuestaClaude | Promise<RespuestaClaude>;

const texto = (t: string): RespuestaClaude => ({
  contenido: [{ type: "text", text: t }],
  stop_reason: "end_turn",
  uso: { ...USO_CERO, entrada: 100, salida: 20 },
  costo_usd: 0.0002,
  simulado: false,
  modelo: "claude-haiku-4-5-20251001",
});
const herramienta = (name: string, input: Record<string, unknown> = {}): RespuestaClaude => ({
  contenido: [{ type: "tool_use", id: `tu_${name}`, name, input }],
  stop_reason: "tool_use",
  uso: { ...USO_CERO, entrada: 100, salida: 10 },
  costo_usd: 0.0001,
  simulado: false,
  modelo: "claude-haiku-4-5-20251001",
});

function escenario(guion: Guion, op: {
  cfg?: ConfigTurno;
  estado?: string;
  turnos?: number;
  gasto?: number;
  ultimo?: string;
  historial?: FilaHistorial[];
  telefono?: string | null;
} = {}) {
  _limpiarCacheCatalogo();
  const h = depsPrueba();
  const pedidos: PedidoClaude[] = [];
  const turnos: FilaTurno[] = [];
  const sumas: number[] = [];
  const esperas: number[] = [];
  const leidos: string[] = [];
  let reloj = new Date("2026-10-06T15:00:00Z").getTime();
  const deps: DepsOrquestador = {
    config: () => Promise.resolve(op.cfg ?? configPrueba()),
    conversacion: () => Promise.resolve({ id: CONV, estado: op.estado ?? "ia", cliente_id: CLIENTE, turnos_ia: op.turnos ?? 0 }),
    cliente: () => Promise.resolve({ id: CLIENTE, telefono: op.telefono === undefined ? TEL : op.telefono, wa_user_id: "PY.1234567890", nombre: "Ana Prueba" }),
    historial: () => Promise.resolve(op.historial ?? [{ direccion: "in", texto: "hola", tipo: "text", contenido: {}, estado: "recibido", wa_message_id: "wamid.IN1" }]),
    ultimoEntranteId: () => Promise.resolve(op.ultimo ?? "wamid.IN1"),
    gastoMesUsd: () => Promise.resolve(op.gasto ?? 0),
    preciosPrevios: () => Promise.resolve([]),
    registrarTurno: (f) => (turnos.push(f), Promise.resolve()),
    sumarTurno: (_c, costo) => (sumas.push(costo), Promise.resolve()),
    marcarLeidoYEscribiendo: (id) => (leidos.push(id), Promise.resolve()),
    llamarModelo: async (p) => {
      pedidos.push(structuredClone(p));
      return await guion(p, pedidos.length);
    },
    dormir: (ms) => {
      esperas.push(ms);
      reloj += ms;
      return Promise.resolve();
    },
    ahora: () => new Date(reloj),
    herramientas: h.deps,
  };
  return { deps, reg: h.reg, pedidos, turnos, sumas, esperas, leidos };
}

const ENTRADA = { conversacion_id: CONV, wa_message_id: "wamid.IN1", texto: "hola" };

Deno.test("turno: respuesta directa → marca leído, espera 2-6 s, responde y registra costo", async () => {
  const e = escenario(() => texto("¡Hola! Contame qué estás buscando y te paso precio y envío."));
  const r = await procesarTurno(ENTRADA, e.deps);
  assertEquals(r.accion, "respondido");
  assertEquals(e.reg.textos, [{ to: TEL, texto: "¡Hola! Contame qué estás buscando y te paso precio y envío." }]);
  assert(e.leidos.includes("wamid.IN1"));
  assert(e.esperas.length === 1 && e.esperas[0] >= 2000 && e.esperas[0] <= 6000, String(e.esperas));
  assertEquals(e.turnos.length, 1);
  assertEquals(e.turnos[0].accion, "respondido");
  assertEquals(e.sumas, [0.0002]);
  // Caché: system en dos bloques (estable + variable) y herramientas.
  const p = e.pedidos[0];
  assert(Array.isArray(p.system) && p.system.length === 2);
  assert((p.system[0] as { text: string }).text.includes("Sos el vendedor de Voltra"));
  assert((p.system[1] as { text: string }).text.includes("AHORA: martes 6/10/2026, 12:00"));
  assertEquals(p.cache, true);
  assertEquals(p.ttlCache, "1h");
});

Deno.test("turno: usa consultar_catalogo y responde con el total; el tool_result vuelve al modelo", async () => {
  const e = escenario((_p, n) =>
    n === 1 ? herramienta("consultar_catalogo", { busqueda: "tiras" }) : texto("Las tiras salen Gs 79.000 + envío Gs 33.000 = Gs 112.000, pagás al recibir. ¿Te las preparo?")
  );
  const r = await procesarTurno({ ...ENTRADA, texto: "cuánto salen las tiras?" }, e.deps);
  assertEquals(r.accion, "respondido");
  assertEquals(e.pedidos.length, 2);
  const ultimo = e.pedidos[1].mensajes.at(-1)!;
  assertEquals(ultimo.role, "user");
  const tr = (ultimo.content as Bloque[])[0] as { type: string; content: string };
  assertEquals(tr.type, "tool_result");
  assert(tr.content.includes("112.000"));
  assertEquals(e.turnos[0].herramientas[0].nombre, "consultar_catalogo");
  assertEquals(e.sumas, [0.0003]);
});

Deno.test("turno: palabra prohibida → regenera una vez con el motivo y manda la segunda", async () => {
  const e = escenario((_p, n) =>
    n === 1 ? texto("Tiene garantía de 30 días.") : texto("Cualquier problema lo vemos por acá caso por caso. ¿Te ayudo con el pedido?")
  );
  const r = await procesarTurno({ ...ENTRADA, texto: "tiene garantía?" }, e.deps);
  assertEquals(r.accion, "respondido");
  assertEquals(e.reg.textos[0].texto, "Cualquier problema lo vemos por acá caso por caso. ¿Te ayudo con el pedido?");
  assert(e.turnos[0].regenerado);
  const control = e.pedidos[1].mensajes.at(-1)!.content as string;
  assert(control.includes("palabra_prohibida:garantía"));
  assertEquals(e.turnos[0].filtro.intentos.map((i) => i.ok), [false, true]);
});

Deno.test("turno: precio inventado dos veces → no se manda y deriva a Enrique", async () => {
  const e = escenario(() => texto("Te lo dejo en Gs 70.000, ¿dale?"));
  const r = await procesarTurno({ ...ENTRADA, texto: "me hacés precio?" }, e.deps);
  assertEquals(r.accion, "derivado");
  assertEquals(r.motivo, "filtro");
  assertFalse(e.reg.textos.some((t) => t.texto.includes("70.000")));
  assertEquals(e.reg.humano, [CONV]);
  assertEquals(e.reg.interactivos[0].interactive.type, "cta_url");
  assert(e.reg.avisos[0].texto.includes("no pasó el filtro"));
  assert(e.turnos[0].derivado);
});

Deno.test("turno: consulta de salud con el simulador determinista → deriva por herramienta", async () => {
  const e = escenario((p) => simularRespuesta(p));
  const r = await procesarTurno({ ...ENTRADA, texto: "tengo apnea, esto me sirve?" }, e.deps);
  assertEquals(r.accion, "derivado");
  assertEquals(e.reg.humano, [CONV]);
  assert(e.reg.avisos[0].texto.includes("Consulta de salud"));
  assertEquals(e.reg.textos.length, 0); // no hay respuesta extra después de derivar
  assert(e.turnos[0].simulado);
});

Deno.test("turno: tope de turnos → deriva sin llamar al modelo", async () => {
  const e = escenario(() => texto("no debería"), { turnos: 20 });
  const r = await procesarTurno(ENTRADA, e.deps);
  assertEquals(r, { accion: "derivado", motivo: "tope_turnos", costo_usd: 0 });
  assertEquals(e.pedidos.length, 0);
  assert(e.reg.avisos[0].texto.includes("límite de turnos"));
});

Deno.test("turno: tope mensual de gasto → deriva sin llamar al modelo", async () => {
  const e = escenario(() => texto("no debería"), { gasto: 45.01 });
  const r = await procesarTurno(ENTRADA, e.deps);
  assertEquals(r.motivo, "tope_gasto");
  assertEquals(e.pedidos.length, 0);
});

Deno.test("turno: API caída → deriva a Enrique", async () => {
  const e = escenario(() => {
    throw new ErrorClaude("HTTP 529 overloaded_error: x", 529, true);
  });
  const r = await procesarTurno(ENTRADA, e.deps);
  assertEquals(r.accion, "derivado");
  assertEquals(r.motivo, "falla_ia");
  assertEquals(e.reg.humano, [CONV]);
  assert(e.reg.avisos[0].texto.includes("La IA no respondió"));
});

Deno.test("turno: negativa del modelo (refusal) → deriva", async () => {
  const e = escenario(() => ({ ...texto(""), contenido: [], stop_reason: "refusal" }));
  assertEquals((await procesarTurno(ENTRADA, e.deps)).motivo, "falla_ia");
});

Deno.test("turno: bucle de herramientas sin fin → corta en max_iteraciones y deriva", async () => {
  const e = escenario(() => herramienta("estado_pedido"));
  const r = await procesarTurno(ENTRADA, e.deps);
  assertEquals(r.motivo, "falla_ia");
  assertEquals(e.pedidos.length, 6);
});

Deno.test("turno: herramienta terminal (resumen del pedido) termina sin texto extra", async () => {
  const e = escenario(() =>
    herramienta("crear_pedido_cod", { confirmar: false, nombre: "Ana Prueba", ciudad: "CDE", direccion: "Calle 1", items: [{ handle: "tiras-prueba", cantidad: 1 }] })
  );
  const r = await procesarTurno(ENTRADA, e.deps);
  assertEquals(r.accion, "terminal");
  assertEquals(e.pedidos.length, 1);
  assertEquals(e.reg.interactivos.length, 1);
  assertEquals(e.reg.textos.length, 0);
});

Deno.test("turno: conversación en humano → no hace nada; mensaje más nuevo → agrupa", async () => {
  const h = escenario(() => texto("x"), { estado: "humano" });
  assertEquals((await procesarTurno(ENTRADA, h.deps)).accion, "omitido");
  assertEquals(h.pedidos.length, 0);
  const cfg = configPrueba({ vendedor: { espera_agrupar_s: 3, whatsapp_enrique: null } });
  const g = escenario(() => texto("x"), { cfg, ultimo: "wamid.IN2" });
  assertEquals((await procesarTurno(ENTRADA, g.deps)).accion, "agrupado");
  assertEquals(g.esperas, [3000]);
  assertEquals(g.pedidos.length, 0);
});

Deno.test("historial: empieza con user, une roles seguidos, saca fallidos y termina con el mensaje actual", () => {
  const filas: FilaHistorial[] = [
    { direccion: "out", texto: "[plantilla voltra_confirmacion_pedido] Ana", tipo: "template", contenido: {}, estado: "entregado", wa_message_id: "o1" },
    { direccion: "in", texto: null, tipo: "audio", contenido: { texto_vendedor: "[audio] quiero otro" }, estado: "recibido", wa_message_id: "i1" },
    { direccion: "out", texto: "mensaje que falló", tipo: "text", contenido: {}, estado: "fallido", wa_message_id: "o2" },
    { direccion: "in", texto: null, tipo: "location", contenido: {}, estado: "recibido", wa_message_id: "wamid.IN1" },
  ];
  const m = armarHistorial(filas, { conversacion_id: CONV, wa_message_id: "wamid.IN1", texto: "[ubicación] -25.5,-54.6" });
  assertEquals(m.map((x) => x.role), ["user", "assistant", "user"]);
  assertEquals(m[2].content, "[audio] quiero otro\n[ubicación] -25.5,-54.6");
  assertFalse(JSON.stringify(m).includes("falló"));
});

Deno.test("demora proporcional al largo, entre 2 y 6 s", () => {
  assertEquals(demoraSegundos("ok", 2, 6), 2);
  assertEquals(demoraSegundos("x".repeat(150), 2, 6), 4);
  assertEquals(demoraSegundos("x".repeat(900), 2, 6), 6);
});

// ---------- derivación: texto del modelo + frase del médico ----------

const FRASE_MEDICO = "Eso te conviene consultarlo con tu médico.";
const textoYHerramienta = (t: string, name: string, input: Record<string, unknown>): RespuestaClaude => ({
  ...herramienta(name, input),
  contenido: [{ type: "text", text: t }, { type: "tool_use", id: `tu_${name}`, name, input }],
});
const cuerpo = (i: Record<string, unknown>) => (i.body as { text: string }).text;

Deno.test("derivación por salud sin texto del modelo → frase del médico antes del botón", async () => {
  const e = escenario(() => herramienta("derivar_a_enrique", { motivo: "salud", resumen: "Tiene apnea y consulta por las tiras" }));
  const r = await procesarTurno({ ...ENTRADA, texto: "tengo apnea, me sirve?" }, e.deps);
  assertEquals(r.accion, "derivado");
  assertEquals(e.reg.textos.length, 0);
  assertEquals(e.reg.interactivos.length, 1);
  assertEquals(e.reg.interactivos[0].interactive.type, "cta_url");
  assertEquals(
    cuerpo(e.reg.interactivos[0].interactive),
    `${FRASE_MEDICO}\nTe paso con Enrique para que lo vea personalmente. Tocá el botón y le llega tu caso ya escrito.`,
  );
  assertEquals(e.turnos[0].respuesta, cuerpo(e.reg.interactivos[0].interactive));
  assertEquals(e.turnos[0].filtro.texto_derivacion, undefined);
});

Deno.test("derivación por salud con texto del modelo que ya nombra al médico → no se repite y no se duplica 'te paso'", async () => {
  const t = "Eso te conviene consultarlo con tu médico, Ana. Te paso con Enrique para que lo vean juntos.";
  const e = escenario(() => textoYHerramienta(t, "derivar_a_enrique", { motivo: "salud", resumen: "Embarazada consulta por tiras" }));
  const r = await procesarTurno({ ...ENTRADA, texto: "estoy embarazada, puedo usarlas?" }, e.deps);
  assertEquals(r.accion, "derivado");
  assertEquals(e.pedidos.length, 1); // sin regenerar
  const b = cuerpo(e.reg.interactivos[0].interactive);
  assertEquals(b, `${t}\nTocá el botón y le llega tu caso ya escrito.`);
  assertEquals(b.match(/médico/g)?.length, 1);
  assertEquals(e.turnos[0].filtro.texto_derivacion?.ok, true);
  assertEquals(e.turnos[0].filtro.intentos, []);
  assertEquals(e.reg.textos.length, 0);
});

Deno.test("derivación por salud con texto del modelo sin la frase → frase del médico, después el texto, después el botón", async () => {
  const e = escenario(() => textoYHerramienta("Gracias por contarme, Ana.", "derivar_a_enrique", { motivo: "salud", resumen: "Toma pastillas para la presión" }));
  await procesarTurno({ ...ENTRADA, texto: "tomo pastillas para la presión" }, e.deps);
  const b = cuerpo(e.reg.interactivos[0].interactive);
  assertEquals(b, `${FRASE_MEDICO}\nGracias por contarme, Ana.\nTe paso con Enrique para que lo vea personalmente. Tocá el botón y le llega tu caso ya escrito.`);
  assert(b.indexOf("médico") < b.indexOf("Enrique"));
});

Deno.test("derivación que no es de salud → sin frase del médico (con y sin texto del modelo)", async () => {
  const sin = escenario(() => herramienta("derivar_a_enrique", { motivo: "pide_persona", resumen: "Quiere hablar con una persona" }));
  await procesarTurno({ ...ENTRADA, texto: "quiero hablar con alguien" }, sin.deps);
  assertEquals(cuerpo(sin.reg.interactivos[0].interactive), "Te paso con Enrique para que lo vea personalmente. Tocá el botón y le llega tu caso ya escrito.");
  const con = escenario(() => textoYHerramienta("Dale, te paso con Enrique.", "derivar_a_enrique", { motivo: "mayorista", resumen: "Quiere 50 cajas" }));
  await procesarTurno({ ...ENTRADA, texto: "quiero 50 cajas" }, con.deps);
  const b = cuerpo(con.reg.interactivos[0].interactive);
  assertEquals(b, "Dale, te paso con Enrique.\nTocá el botón y le llega tu caso ya escrito.");
  assertFalse(b.includes("médico"));
});

Deno.test("derivación por salud con texto que el filtro rechaza → ese texto no se manda, la frase y el botón sí", async () => {
  const e = escenario(() =>
    textoYHerramienta("Tiene garantía y te lo dejo en Gs 70.000.", "derivar_a_enrique", { motivo: "salud", resumen: "Consulta por apnea" })
  );
  const r = await procesarTurno({ ...ENTRADA, texto: "tengo apnea" }, e.deps);
  assertEquals(r.accion, "derivado");
  assertEquals(e.pedidos.length, 1); // no regenera: la derivación sale igual
  const b = cuerpo(e.reg.interactivos[0].interactive);
  assertFalse(b.includes("garantía"));
  assertFalse(b.includes("70.000"));
  assertEquals(b, `${FRASE_MEDICO}\nTe paso con Enrique para que lo vea personalmente. Tocá el botón y le llega tu caso ya escrito.`);
  const rev = e.turnos[0].filtro.texto_derivacion!;
  assertFalse(rev.ok);
  assert(rev.motivos.some((m) => m.startsWith("palabra_prohibida")));
  assert(rev.motivos.some((m) => m.startsWith("precio_no_catalogo")));
  assertFalse(e.turnos[0].regenerado);
});

Deno.test("derivación por salud sin número de Enrique → mensaje de texto con la frase del médico primero", async () => {
  const cfg = configPrueba({ vendedor: { espera_agrupar_s: 0, whatsapp_enrique: null } });
  const e = escenario(() => herramienta("derivar_a_enrique", { motivo: "salud", resumen: "Consulta por apnea" }), { cfg });
  await procesarTurno({ ...ENTRADA, texto: "tengo apnea" }, e.deps);
  assertEquals(e.reg.interactivos.length, 0);
  assertEquals(e.reg.textos, [{ to: TEL, texto: `${FRASE_MEDICO}\nLe paso tu caso a Enrique y te escribe por acá apenas lo vea.` }]);
});

Deno.test("derivación por salud: la frase del médico se puede cambiar desde config_wa.vendedor_textos", async () => {
  const cfg = configPrueba({ vendedor_textos: { derivacion_salud: "Esto lo tiene que ver tu médico." } });
  const e = escenario(() => herramienta("derivar_a_enrique", { motivo: "salud", resumen: "Consulta por apnea" }), { cfg });
  await procesarTurno({ ...ENTRADA, texto: "tengo apnea" }, e.deps);
  assert(cuerpo(e.reg.interactivos[0].interactive).startsWith("Esto lo tiene que ver tu médico.\n"));
});

Deno.test("derivación por salud con el simulador determinista → el cliente ve la frase del médico", async () => {
  const e = escenario((p) => simularRespuesta(p));
  await procesarTurno({ ...ENTRADA, texto: "tengo apnea, esto me sirve?" }, e.deps);
  assert(cuerpo(e.reg.interactivos[0].interactive).startsWith(FRASE_MEDICO));
});
