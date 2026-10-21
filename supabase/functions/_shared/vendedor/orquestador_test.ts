import { assert, assertEquals, assertFalse } from "jsr:@std/assert@1";
import { type Bloque, ErrorClaude, type PedidoClaude, type RespuestaClaude, simularRespuesta, USO_CERO } from "../claude.ts";
import { _limpiarCacheCatalogo } from "./herramientas.ts";
import { armarHistorial, bloquePendiente, type DepsOrquestador, type FilaHistorial, type FilaTurno, procesarTurno } from "./orquestador.ts";
import type { PerfilCliente } from "./perfil.ts";
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
  perfil?: PerfilCliente;
  /** Ids del último entrante en cada consulta (para simular un mensaje que llega mientras "escribe"). */
  ultimos?: string[];
  azar?: number;
} = {}) {
  _limpiarCacheCatalogo();
  const h = depsPrueba();
  const pedidos: PedidoClaude[] = [];
  const turnos: FilaTurno[] = [];
  const sumas: number[] = [];
  const esperas: number[] = [];
  const leidos: string[] = [];
  const perfiles: PerfilCliente[] = [];
  const ultimos = [...(op.ultimos ?? [])];
  let reloj = new Date("2026-10-06T15:00:00Z").getTime();
  const deps: DepsOrquestador = {
    config: () => Promise.resolve(op.cfg ?? configPrueba()),
    conversacion: () =>
      Promise.resolve({ id: CONV, estado: op.estado ?? "ia", cliente_id: CLIENTE, turnos_ia: op.turnos ?? 0, perfil_vendedor: perfiles.at(-1) ?? op.perfil ?? {} }),
    cliente: () => Promise.resolve({ id: CLIENTE, telefono: op.telefono === undefined ? TEL : op.telefono, wa_user_id: "PY.1234567890", nombre: "Ana Prueba" }),
    historial: () => Promise.resolve(op.historial ?? [{ direccion: "in", texto: "hola", tipo: "text", contenido: {}, estado: "recibido", wa_message_id: "wamid.IN1" }]),
    ultimoEntranteId: () => Promise.resolve(ultimos.length ? ultimos.shift()! : op.ultimo ?? "wamid.IN1"),
    gastoMesUsd: () => Promise.resolve(op.gasto ?? 0),
    preciosPrevios: () => Promise.resolve([]),
    registrarTurno: (f) => (turnos.push(f), Promise.resolve()),
    sumarTurno: (_c, costo) => (sumas.push(costo), Promise.resolve()),
    guardarPerfil: (_c, p) => (perfiles.push(p), Promise.resolve()),
    ...(op.azar !== undefined ? { aleatorio: () => op.azar! } : {}),
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
  return { deps, reg: h.reg, pedidos, turnos, sumas, esperas, leidos, perfiles };
}

const ENTRADA = { conversacion_id: CONV, wa_message_id: "wamid.IN1", texto: "hola" };

Deno.test("turno: respuesta directa → marca leído, espera 4-25 s (leer + escribir), responde y registra costo", async () => {
  const e = escenario(() => texto("¡Hola! Contame qué estás buscando y te paso precio y envío."));
  const r = await procesarTurno(ENTRADA, e.deps);
  assertEquals(r.accion, "respondido");
  assertEquals(e.reg.textos, [{ to: TEL, texto: "¡Hola! Contame qué estás buscando y te paso precio y envío." }]);
  assert(e.leidos.includes("wamid.IN1"));
  assert(e.esperas.length === 1 && e.esperas[0] >= 4000 && e.esperas[0] <= 25000, String(e.esperas));
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
  assertEquals(e.reg.humano, []); // falla del sistema: el chat sigue en 'ia' y se reintenta si el cliente vuelve a escribir
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

Deno.test("turno: tope DURO de gasto (19-10: tope × 1,3) → deriva sin llamar al modelo", async () => {
  const e = escenario(() => texto("no debería"), { gasto: 58.5 }); // tope 45 × 1,3
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
  assertEquals(e.reg.humano, []); // API caída: no se calla el chat, el próximo mensaje se reintenta
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

Deno.test("bloque pendiente: los mensajes del cliente desde nuestra última respuesta, con el actual transcripto", () => {
  const filas: FilaHistorial[] = [
    { direccion: "in", texto: "hola", tipo: "text", contenido: {}, estado: "recibido", wa_message_id: "i0" },
    { direccion: "out", texto: "Hola, ¿para dormir o para el aliento?", tipo: "text", contenido: {}, estado: "entregado", wa_message_id: "o1" },
    { direccion: "in", texto: "para dormir", tipo: "text", contenido: {}, estado: "recibido", wa_message_id: "i1" },
    { direccion: "out", texto: "falló", tipo: "text", contenido: {}, estado: "fallido", wa_message_id: "o2" },
    { direccion: "in", texto: null, tipo: "audio", contenido: {}, estado: "recibido", wa_message_id: "wamid.IN1" },
  ];
  assertEquals(bloquePendiente(filas, { conversacion_id: CONV, wa_message_id: "wamid.IN1", texto: "[audio] mi marido ronca" }), [
    "para dormir",
    "[audio] mi marido ronca",
  ]);
  assertEquals(bloquePendiente([], ENTRADA), ["hola"]);
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

Deno.test("derivación por mayorista: el turno termina con el botón, el chat sigue en 'ia' y el próximo mensaje se atiende", async () => {
  const e = escenario((_p, n) =>
    n === 1
      ? textoYHerramienta("Para 10 o más te paso con Enrique.", "derivar_a_enrique", { motivo: "mayorista", resumen: "Pregunta precio por 10" })
      : texto("Dale, te armo 1. ¿A qué ciudad te lo mando?")
  );
  // La conversación refleja lo que haya hecho pasarAHumano.
  e.deps.conversacion = (id) =>
    Promise.resolve({ id, estado: e.reg.humano.length ? "humano" : "ia", cliente_id: CLIENTE, turnos_ia: 0, perfil_vendedor: {} });
  const r1 = await procesarTurno({ ...ENTRADA, texto: "si quiero 10?" }, e.deps);
  assertEquals(r1.accion, "derivado");
  assertEquals(e.reg.humano, []);
  assertEquals(e.reg.textos.length, 0, "en el turno de la derivación no hay texto extra");
  assertEquals((e.turnos[0].herramientas[0].resultado as { sigue_ia: boolean }).sigue_ia, true);
  const r2 = await procesarTurno({ ...ENTRADA, texto: "Quiero 1" }, e.deps);
  assertEquals(r2.accion, "respondido");
  assertEquals(e.reg.textos.map((t) => t.texto), ["Dale, te armo 1. ¿A qué ciudad te lo mando?"]);
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

// ---------- respuestas fijas (sin modelo) ----------

const fila = (direccion: "in" | "out", texto: string, id: string): FilaHistorial => ({
  direccion, texto, tipo: "text", contenido: {}, estado: direccion === "in" ? "recibido" : "entregado", wa_message_id: id,
});
const pedidoChat = (estado: "resumen" | "creado") => ({
  id: "pc-1", conversacion_id: CONV, cliente_id: CLIENTE, estado, datos: {} as never, total: 112000, shopify_order_id: null, creado_en: "2026-10-06T14:00:00Z",
});

Deno.test("fija: sticker suelto al empezar → texto fijo de config, sin llamar al modelo ni contar turno", async () => {
  const e = escenario(() => texto("no debería"), { historial: [fila("in", "[sticker]", "wamid.IN1")], azar: 0 });
  const r = await procesarTurno({ ...ENTRADA, texto: "[sticker]" }, e.deps);
  assertEquals(r.accion, "respondido");
  assertEquals(e.pedidos.length, 0);
  assertEquals(e.reg.textos.map((t) => t.texto), ["Jaja buenísimo. ¿Lo buscás para dormir mejor o para el aliento?"]);
  assertEquals(e.sumas, []); // no gasta el tope de turnos
  assertEquals(e.turnos[0].modelo, "fija");
  assertEquals(e.turnos[0].accion, "respondido:fija:sticker_inicio");
  assertEquals(e.turnos[0].costo_usd, 0);
  assert(e.esperas[0] >= 4000, "también espera como una persona");
});

Deno.test("fija: 'gracias' con el pedido creado → 'de nada' fijo; un segundo 'gracias' no se contesta igual", async () => {
  const hist = [fila("out", "Listo Ana, ya cargamos tu pedido #1050.", "o1"), fila("in", "gracias!!", "wamid.IN1")];
  const e = escenario(() => texto("no debería"), { historial: hist, azar: 0 });
  e.reg.pedidosChat.push(pedidoChat("creado"));
  await procesarTurno({ ...ENTRADA, texto: "gracias!!" }, e.deps);
  assertEquals(e.pedidos.length, 0);
  assertEquals(e.reg.textos.map((t) => t.texto), ["De nada. Cualquier cosa me escribís por acá."]);

  const hist2 = [fila("out", "De nada. Cualquier cosa me escribís por acá.", "o2"), fila("in", "gracias", "wamid.IN1")];
  const e2 = escenario(() => texto("no debería"), { historial: hist2 });
  e2.reg.pedidosChat.push(pedidoChat("creado"));
  const r2 = await procesarTurno({ ...ENTRADA, texto: "gracias" }, e2.deps);
  assertEquals(r2.accion, "omitido");
  assertEquals(e2.reg.textos.length, 0);
  assertEquals(e2.pedidos.length, 0);
});

Deno.test("fija: 'ok' con un resumen esperando el sí → lo resuelve el modelo (puede ser la confirmación)", async () => {
  const e = escenario(() => texto("Perfecto, lo confirmo ahora."), { historial: [fila("in", "ok", "wamid.IN1")] });
  e.reg.pedidosChat.push(pedidoChat("resumen"));
  await procesarTurno({ ...ENTRADA, texto: "ok" }, e.deps);
  assertEquals(e.pedidos.length, 1);
});

// ---------- perfil del cliente ----------

Deno.test("perfil: registrar_perfil junto con el texto → una sola llamada, se responde y se guarda el perfil", async () => {
  const e = escenario(() => ({
    ...texto(""),
    contenido: [
      { type: "text", text: "Para la boca seca van los parches. ¿Te paso precio y envío?" },
      { type: "tool_use", id: "tu_p", name: "registrar_perfil", input: { necesidad: "boca_seca", perfil: "curioso" } },
    ],
    stop_reason: "tool_use",
  }));
  const r = await procesarTurno({ ...ENTRADA, texto: "me despierto con la boca seca" }, e.deps);
  assertEquals(r.accion, "respondido");
  assertEquals(e.pedidos.length, 1);
  assertEquals(e.reg.textos.map((t) => t.texto).join("\n"), "Para la boca seca van los parches. ¿Te paso precio y envío?");
  assertEquals(e.perfiles.at(-1), { necesidad: "boca_seca", perfil: "curioso" });
  assertEquals(e.turnos[0].herramientas[0].nombre, "registrar_perfil");
});

Deno.test("perfil: el ya detectado va en el contexto (no se re-pregunta) y no se cachea con el prompt", async () => {
  const e = escenario(() => texto("Te mando el video real de cómo se pone."), { perfil: { necesidad: "ronca", perfil: "desconfiado", ofrecido_x2: true } });
  await procesarTurno({ ...ENTRADA, texto: "y funciona de verdad?" }, e.deps);
  const sys = e.pedidos[0].system as { text: string }[];
  assert(sys[1].text.includes("PERFIL YA DETECTADO"));
  assert(sys[1].text.includes("desconfiado: prueba concreta"));
  assert(sys[1].text.includes("YA OFRECISTE EL ×2"));
  assertFalse(sys[0].text.includes("desconfiado: prueba concreta")); // el bloque cacheado es igual para todos
});

Deno.test("perfil: ofrecer el ×2 queda marcado; una respuesta neutra no toca el perfil", async () => {
  const e = escenario(() => texto("Con 2 bolsas te ahorrás un envío. ¿Te armo el de 2?"));
  await procesarTurno({ ...ENTRADA, texto: "y si llevo más?" }, e.deps);
  assertEquals(e.perfiles.at(-1)?.ofrecido_x2, true);
  const n = escenario(() => texto("Te llega en 2 a 5 días hábiles. ¿Es para vos?"));
  await procesarTurno({ ...ENTRADA, texto: "cuánto tarda?" }, n.deps);
  assertEquals(n.perfiles, []);
});

Deno.test("cierre: si ya preguntó '¿qué te frena?', repetirlo se bloquea y regenera", async () => {
  const e = escenario((_p, n) => (n === 1 ? texto("Dale. ¿Qué te frena?") : texto("Dale, sin apuro. Cualquier cosa me escribís por acá.")), {
    perfil: { pregunto_freno: true },
  });
  await procesarTurno({ ...ENTRADA, texto: "lo voy a pensar" }, e.deps);
  assertEquals(e.reg.textos.map((t) => t.texto).join(" "), "Dale, sin apuro. Cualquier cosa me escribís por acá.");
  assert((e.pedidos[1].mensajes.at(-1)!.content as string).includes("insiste_que_te_frena"));
});

// ---------- que no suene a bot ----------

Deno.test("estilo: muletilla de bot → regenera una vez con el motivo", async () => {
  const e = escenario((_p, n) => (n === 1 ? texto("¡Claro! ¡Te ayudo con eso!") : texto("Te paso precio y envío ahora. ¿Es para vos?")));
  await procesarTurno({ ...ENTRADA, texto: "me pasás info?" }, e.deps);
  assertEquals(e.reg.textos.map((t) => t.texto), ["Te paso precio y envío ahora. ¿Es para vos?"]);
  const control = e.pedidos[1].mensajes.at(-1)!.content as string;
  assert(control.includes("muletilla_bot:¡claro"), control);
  assert(control.includes("exclamaciones_de_bot"), control);
  assert(e.turnos[0].regenerado);
});

Deno.test("honestidad: '¿sos un bot?' exige decir 'asistente virtual'; negar serlo nunca sale", async () => {
  const ok = "Soy el asistente virtual de Voltra. Si preferís, te paso con Enrique, ¿querés?";
  const e = escenario((_p, n) => (n === 1 ? texto("Soy Ana, del equipo de Voltra. ¿Qué buscás?") : texto(ok)), {
    historial: [fila("in", "sos un bot?", "wamid.IN1")],
  });
  await procesarTurno({ ...ENTRADA, texto: "sos un bot?" }, e.deps);
  assertEquals(e.reg.textos.map((t) => t.texto).join("\n"), ok);
  const control = e.pedidos[1].mensajes.at(-1)!.content as string;
  assert(control.includes("honestidad:falta_asistente_virtual"));
  assert(control.includes("asistente virtual de Voltra (sin decir que sos una persona)"));

  const miente = escenario(() => texto("No soy un bot, soy Ana."), { historial: [fila("in", "sos una persona real?", "wamid.IN1")] });
  const r = await procesarTurno({ ...ENTRADA, texto: "sos una persona real?" }, miente.deps);
  assertEquals(r.motivo, "filtro");
  assertFalse(miente.reg.textos.some((t) => t.texto.includes("No soy un bot")));
  assert(miente.turnos[0].filtro.intentos[0].motivos.some((m) => m.startsWith("niega_ser_asistente")));
});

Deno.test("estilo: sin que pregunte, no se anuncia como asistente virtual", async () => {
  const e = escenario((_p, n) => (n === 1 ? texto("Soy el asistente virtual de Voltra, ¿qué buscás?") : texto("Contame, ¿es para dormir o para el aliento?")));
  await procesarTurno({ ...ENTRADA, texto: "hola" }, e.deps);
  assert(e.turnos[0].filtro.intentos[0].motivos.some((m) => m.startsWith("se_anuncia_como_ia")));
  assertEquals(e.reg.textos.map((t) => t.texto), ["Contame, ¿es para dormir o para el aliento?"]);
});

// ---------- ritmo humano ----------

Deno.test("ritmo: respuesta larga → 2 burbujas (la pregunta sola), con 'escribiendo…' y pausa entre ambas", async () => {
  const t = "Las tiras abren la nariz para que entre más aire al dormir y se ponen en segundos.\n¿Es para vos o para regalar?";
  const e = escenario(() => texto(t), { azar: 0.5 });
  await procesarTurno({ ...ENTRADA, texto: "para qué sirven las tiras?" }, e.deps);
  assertEquals(e.reg.textos.map((x) => x.texto), [
    "Las tiras abren la nariz para que entre más aire al dormir y se ponen en segundos.",
    "¿Es para vos o para regalar?",
  ]);
  assertEquals(e.esperas.length, 2);
  assert(e.esperas[0] >= 4000 && e.esperas[0] <= 25000, String(e.esperas));
  assert(e.esperas[1] >= 1500 && e.esperas[1] <= 7000, String(e.esperas));
  assertEquals(e.turnos[0].respuesta, t);
  assert(e.leidos.length >= 3, "marca leído y 'escribiendo…' antes de cada burbuja");
});

Deno.test("ritmo: 3 líneas cortas del modelo → 2 burbujas (la tercera va con la segunda), con su pausa y 'escribiendo…'", async () => {
  const t = "Dale Ana.\nLas tiras abren la nariz.\n¿Es para vos?";
  const e = escenario(() => texto(t), { azar: 0.5 });
  await procesarTurno({ ...ENTRADA, texto: "para qué sirven?" }, e.deps);
  assertEquals(e.reg.textos.map((x) => x.texto), ["Dale Ana.", "Las tiras abren la nariz.\n¿Es para vos?"]);
  assertEquals(e.esperas.length, 2, "demora inicial + una pausa antes de cada burbuja extra");
  for (const p of e.esperas.slice(1)) assert(p >= 1500 && p <= 7000, String(e.esperas));
  assertEquals(e.turnos[0].respuesta, t);
});

Deno.test("ritmo: espera 8 s de silencio; si el cliente escribe mientras 'escribe', no manda y responde el turno nuevo", async () => {
  const cfg = configPrueba({ vendedor: { espera_agrupar_s: 8, whatsapp_enrique: null } });
  const e = escenario(() => texto("Te llega en 2 a 5 días hábiles. ¿Es para vos?"), { cfg, ultimos: ["wamid.IN1", "wamid.IN2"] });
  const r = await procesarTurno({ ...ENTRADA, texto: "cuánto tarda?" }, e.deps);
  assertEquals(r.accion, "agrupado");
  assertEquals(e.esperas[0], 8000);
  assertEquals(e.reg.textos.length, 0);
  assertEquals(e.turnos[0].accion, "agrupado:llego_otro_mensaje");
});

Deno.test("ritmo: de noche (Asunción) tarda más que de día con el mismo mensaje", async () => {
  const msg = "Te llega en 2 a 5 días hábiles. ¿Es para vos?";
  const dia = escenario(() => texto(msg), { azar: 0.5 });
  await procesarTurno({ ...ENTRADA, texto: "cuánto tarda?" }, dia.deps);
  const noche = escenario(() => texto(msg), { azar: 0.5 });
  const ahoraNoche = new Date("2026-10-07T05:30:00Z").getTime(); // 02:30 en Asunción
  let reloj = ahoraNoche;
  noche.deps.ahora = () => new Date(reloj);
  noche.deps.dormir = (ms) => (noche.esperas.push(ms), reloj += ms, Promise.resolve());
  await procesarTurno({ ...ENTRADA, texto: "cuánto tarda?" }, noche.deps);
  assert(noche.esperas[0] > dia.esperas[0], `${noche.esperas[0]} vs ${dia.esperas[0]}`);
  assertEquals(noche.reg.textos.length, 1, "de noche responde igual");
});

Deno.test("rechazo: 'no me interesa' del cliente queda marcado en el perfil (seguimiento-chat no le vuelve a escribir)", async () => {
  const e = escenario(() => texto("Dale, cualquier cosa me escribís por acá."));
  const r = await procesarTurno({ ...ENTRADA, texto: "no me interesa, gracias" }, e.deps);
  assertEquals(r.accion, "respondido");
  assertEquals(e.perfiles.at(-1)?.rechazo, true);
});

Deno.test("rechazo: registrar_perfil con rechazo:true lo marca; seguimientos del modelo se ignoran", async () => {
  const e = escenario(() => ({
    contenido: [
      { type: "text", text: "Entiendo, cualquier cosa me escribís por acá." },
      { type: "tool_use", id: "tu_rp", name: "registrar_perfil", input: { rechazo: true, seguimientos: 0 } },
    ],
    stop_reason: "tool_use",
    uso: { ...USO_CERO, entrada: 100, salida: 20 },
    costo_usd: 0.0002,
    simulado: false,
    modelo: "claude-haiku-4-5-20251001",
  }), { perfil: { seguimientos: 1, ultimo_seguimiento_en: "2026-10-06T12:00:00.000Z" } });
  await procesarTurno({ ...ENTRADA, texto: "mmm lo voy a pensar" }, e.deps);
  const p = e.perfiles.at(-1)!;
  assertEquals([p.rechazo, p.seguimientos, p.ultimo_seguimiento_en], [true, 1, "2026-10-06T12:00:00.000Z"]);
});

Deno.test("seguimiento: no marca leído, no espera para agrupar ni usa respuestas fijas; registra 'seguimiento'", async () => {
  const e = escenario(() => texto("¿Pudiste ver lo de las tiras? Te las puedo preparar hoy."), {
    cfg: configPrueba({ vendedor: { modelo: "claude-haiku-4-5-20251001", espera_agrupar_s: 8, whatsapp_enrique: "595990000000" } }),
    historial: [
      { direccion: "in", texto: "precio?", tipo: "text", contenido: {}, estado: "recibido", wa_message_id: "wamid.IN1" },
      { direccion: "out", texto: "Salen Gs 79.000. ¿Te las preparo?", tipo: "text", contenido: {}, estado: "leido", wa_message_id: "wamid.OUT1" },
    ],
  });
  const r = await procesarTurno({ conversacion_id: CONV, wa_message_id: "seguimiento:1:x", texto: "[seguimiento 1]", origen: "seguimiento" }, e.deps);
  assertEquals(r.accion, "respondido");
  assertEquals(e.leidos, []);
  assertFalse(e.esperas.includes(8000), "no espera los 8 s de agrupar");
  assertEquals(e.turnos[0].accion, "seguimiento");
  assertEquals(e.pedidos[0].mensajes.at(-1), { role: "user", content: "[seguimiento 1]" });
});

Deno.test("seguimiento: tope de turnos o de gasto → omitido sin derivar ni registrar", async () => {
  const s = { conversacion_id: CONV, wa_message_id: "seguimiento:2:x", texto: "[seguimiento 2]", origen: "seguimiento" as const };
  const a = escenario(() => texto("x"), { turnos: 99 });
  assertEquals(await procesarTurno(s, a.deps), { accion: "omitido", motivo: "tope_turnos", costo_usd: 0 });
  const b = escenario(() => texto("x"), { gasto: 999 });
  assertEquals(await procesarTurno(s, b.deps), { accion: "omitido", motivo: "tope_gasto", costo_usd: 0 });
  for (const e of [a, b]) {
    assertEquals(e.turnos, []);
    assertEquals(e.reg.textos, []);
    assertEquals(e.reg.interactivos, []);
    assertEquals(e.reg.humano, []);
    assertEquals(e.pedidos, []);
  }
});

Deno.test("seguimiento: error de envío no avisa por turno (avisa la corrida)", async () => {
  const e = escenario(() => texto("¿Te las preparo hoy?"));
  e.deps.herramientas = { ...e.deps.herramientas, enviarTexto: () => Promise.resolve({ ok: false, error: "131047" }) };
  const r = await procesarTurno({ conversacion_id: CONV, wa_message_id: "seguimiento:1:x", texto: "[seguimiento 1]", origen: "seguimiento" }, e.deps);
  assertEquals(r.accion, "error_envio");
  assertEquals(e.reg.avisos, []);
  assertEquals(e.turnos[0].accion, "seguimiento_error_envio:131047");
});

Deno.test("armarHistorial: nunca termina en un mensaje del asistente (Sonnet 5.5 no admite prefill)", () => {
  const filas = [
    { direccion: "in", wa_message_id: "w1", texto: "quiero las tiras", contenido: null, estado: "recibido", tipo: "text" },
    { direccion: "out", wa_message_id: "w2", texto: "Gracias por tu pedido #1003", contenido: null, estado: "enviado", tipo: "template" },
  ] as never;
  const h = armarHistorial(filas, { conversacion_id: "c", cliente_id: "k", wa_message_id: "w1", texto: "quiero las tiras" } as never);
  assertEquals(h[h.length - 1].role, "user");
  assert(String(h[h.length - 1].content).includes("CONTROL INTERNO"));
});

// ---------- 08-10: fotos del cliente y marca del anuncio ----------

const JPG = new Uint8Array([0xff, 0xd8, 0xff, 0xe0, 1, 2, 3]);
const filaFoto = (id: string, ruta: string, caption?: string): FilaHistorial => ({
  direccion: "in",
  texto: null,
  tipo: "image",
  contenido: { type: "image", image: { id: "M", mime_type: "image/jpeg", ...(caption ? { caption } : {}) }, storage_path: ruta, mime: "image/jpeg" },
  estado: "recibido",
  wa_message_id: id,
});

Deno.test("turno: la foto del mensaje actual va como bloque de imagen base64 antes del texto", async () => {
  const historial = [filaFoto("wamid.IN1", "media/cli/wamid.IN1.jpg", "¿tienen este?")];
  const e = escenario(() => texto("Sí, ese es el raspador de lengua. ¿Te paso el precio con envío?"), { historial });
  const bajadas: string[] = [];
  e.deps.descargarImagen = (ruta) => (bajadas.push(ruta), Promise.resolve({ ok: true, bytes: JPG, mime: "image/jpeg" }));
  const r = await procesarTurno({ ...ENTRADA, texto: "[imagen] ¿tienen este?", imagen: { ruta: "media/cli/wamid.IN1.jpg", mime: "image/jpeg" } }, e.deps);
  assertEquals(r.accion, "respondido");
  assertEquals(bajadas, ["media/cli/wamid.IN1.jpg"]);
  const ultimo = e.pedidos[0].mensajes.at(-1)!;
  assertEquals(ultimo.role, "user");
  const c = ultimo.content as Bloque[];
  assertEquals(c[0], { type: "image", source: { type: "base64", media_type: "image/jpeg", data: btoa(String.fromCharCode(...JPG)) } });
  assertEquals(c[1], { type: "text", text: "[imagen] ¿tienen este?" });
});

Deno.test("turno: si la foto no se puede bajar, el texto dice \"(no se pudo ver)\" y no va imagen", async () => {
  const historial = [filaFoto("wamid.IN1", "media/cli/wamid.IN1.jpg")];
  const e = escenario(() => texto("No la pude abrir, ¿me la reenviás?"), { historial });
  e.deps.descargarImagen = () => Promise.resolve({ ok: false, error: "404" });
  await procesarTurno({ ...ENTRADA, texto: "[imagen]", imagen: { ruta: "media/cli/wamid.IN1.jpg", mime: "image/jpeg" } }, e.deps);
  assertEquals(e.pedidos[0].mensajes.at(-1)!.content, "[imagen] (no se pudo ver)");
  // Sin dependencia de descarga: igual.
  const s = escenario(() => texto("No la pude abrir, ¿me la reenviás?"), { historial });
  await procesarTurno({ ...ENTRADA, texto: "[imagen]", imagen: { ruta: "media/cli/wamid.IN1.jpg", mime: "image/jpeg" } }, s.deps);
  assertEquals(s.pedidos[0].mensajes.at(-1)!.content, "[imagen] (no se pudo ver)");
});

Deno.test("turno: fotos agrupadas sin responder sí van; las del historial viejo quedan como [imagen]", async () => {
  const historial: FilaHistorial[] = [
    filaFoto("wamid.VIEJA", "media/cli/vieja.jpg"),
    { direccion: "out", texto: "¡Lindo! ¿Te paso precio?", tipo: "text", contenido: {}, estado: "enviado", wa_message_id: "wamid.OUT1" },
    filaFoto("wamid.FOTO", "media/cli/foto.jpg"),
    { direccion: "in", texto: "tienen esto?", tipo: "text", contenido: {}, estado: "recibido", wa_message_id: "wamid.IN1" },
  ];
  const e = escenario(() => texto("Sí, lo tenemos. Sale Gs 79.000 + envío. ¿Te lo preparo?"), { historial });
  const bajadas: string[] = [];
  e.deps.descargarImagen = (ruta) => (bajadas.push(ruta), Promise.resolve({ ok: true, bytes: JPG, mime: "image/jpeg" }));
  await procesarTurno({ ...ENTRADA, texto: "tienen esto?" }, e.deps);
  assertEquals(bajadas, ["media/cli/foto.jpg"]);
  const msgs = e.pedidos[0].mensajes;
  assertEquals(msgs[0], { role: "user", content: "[image]" });
  const c = msgs.at(-1)!.content as Bloque[];
  assertEquals(c.length, 2);
  assertEquals(c[0].type, "image");
  assertEquals(c[1], { type: "text", text: "[image]\ntienen esto?" });
});

Deno.test("turno: un seguimiento no baja fotos", async () => {
  const historial = [filaFoto("wamid.IN1", "media/cli/wamid.IN1.jpg")];
  const e = escenario(() => texto("¿Pudiste ver lo de las tiras? Te las preparo cuando quieras."), { historial, ultimo: "wamid.IN1" });
  let bajadas = 0;
  e.deps.descargarImagen = () => (bajadas++, Promise.resolve({ ok: true, bytes: JPG, mime: "image/jpeg" }));
  await procesarTurno({ conversacion_id: CONV, wa_message_id: "seguimiento:1", texto: "[seguimiento 1]", origen: "seguimiento" }, e.deps);
  assertEquals(bajadas, 0);
});

const MARCA = "[vino del anuncio de tiras nasales, handle tiras-nasales-gudair-30-unidades]";

Deno.test("turno: marca del anuncio → producto en el perfil y en el contexto del system", async () => {
  const historial: FilaHistorial[] = [
    { direccion: "in", texto: "¡Hola! Quiero más información", tipo: "text", contenido: { marca_anuncio: MARCA }, estado: "recibido", wa_message_id: "wamid.IN1" },
  ];
  const e = escenario(() => texto("Las tiras nasales salen Gs 79.000 + envío. ¿Te las preparo?"), { historial });
  await procesarTurno({ ...ENTRADA, texto: `${MARCA}\n¡Hola! Quiero más información` }, e.deps);
  assertEquals(e.perfiles.at(-1)?.producto, "tiras nasales");
  const sys = e.pedidos[0].system as { text: string }[];
  assert(sys[1].text.includes("PRODUCTO ELEGIDO: tiras nasales"), sys[1].text);
  assertEquals(e.pedidos[0].mensajes.at(-1)!.content, `${MARCA}\n¡Hola! Quiero más información`);
});

Deno.test("turno: la marca guardada en un mensaje agrupado se conserva y no se repite", async () => {
  const historial: FilaHistorial[] = [
    { direccion: "in", texto: "¡Hola! Quiero más información", tipo: "text", contenido: { marca_anuncio: MARCA }, estado: "recibido", wa_message_id: "wamid.A" },
    { direccion: "in", texto: "cuánto sale?", tipo: "text", contenido: { marca_anuncio: MARCA }, estado: "recibido", wa_message_id: "wamid.IN1" },
  ];
  const e = escenario(() => texto("Las tiras nasales salen Gs 79.000 + envío. ¿Te las preparo?"), { historial, perfil: { producto: "parches bucales" } });
  await procesarTurno({ ...ENTRADA, texto: `${MARCA}\ncuánto sale?` }, e.deps);
  assertEquals(e.pedidos[0].mensajes.at(-1)!.content, `${MARCA}\n¡Hola! Quiero más información\ncuánto sale?`);
  // Un producto ya elegido en el perfil no se pisa con el del anuncio.
  assertFalse(e.perfiles.some((p) => p.producto === "tiras nasales"));
});

Deno.test("armarHistorial: marca de mensajes viejos adelante, una sola vez en toda la conversación", () => {
  const filas: FilaHistorial[] = [
    { direccion: "in", texto: "hola", tipo: "text", contenido: { marca_anuncio: MARCA }, estado: "recibido", wa_message_id: "w1" },
    { direccion: "out", texto: "Las tiras salen Gs 79.000.", tipo: "text", contenido: {}, estado: "enviado", wa_message_id: "o1" },
    { direccion: "in", texto: "y el envío?", tipo: "text", contenido: { marca_anuncio: MARCA }, estado: "recibido", wa_message_id: "w2" },
  ];
  const m = armarHistorial(filas, { conversacion_id: CONV, wa_message_id: "w3", texto: "dale" });
  assertEquals(m.map((x) => x.content), [`${MARCA}\nhola`, "Las tiras salen Gs 79.000.", "y el envío?\ndale"]);
  assertEquals(bloquePendiente(filas, { conversacion_id: CONV, wa_message_id: "w2", texto: "y el envío?" }), ["y el envío?"]);
});

Deno.test("armarHistorial: lo que Enrique escribió a mano queda marcado como suyo para que el bot no lo contradiga", () => {
  const filas = [
    { direccion: "in", wa_message_id: "w1", texto: "cuánto tarda?", contenido: null, estado: "recibido", tipo: "text" },
    { direccion: "out", wa_message_id: "w2", texto: "si sos de cde hoy mismo te llega", contenido: { origen: "manual" }, estado: "leido", tipo: "text" },
    { direccion: "in", wa_message_id: "w3", texto: "dale", contenido: null, estado: "recibido", tipo: "text" },
  ] as never;
  const h = armarHistorial(filas, { conversacion_id: "c", cliente_id: "k", wa_message_id: "w3", texto: "dale" } as never);
  assert(String(h[1].content).startsWith("(Esto lo escribió Enrique"), String(h[1].content));
});

Deno.test("filtro: el total del pedido de la tienda que trae la marca del sistema se puede decir (09-10)", async () => {
  const t = "Tu pedido sale 112.000 en total y pagás al recibir.\n¿Me confirmás con un sí?";
  const e = escenario(() => texto(t));
  await procesarTurno({ ...ENTRADA, texto: "[pedido #1010 de la tienda, PENDIENTE DE CONFIRMAR: 1 Raspador, total Gs 112000, dirección \"x\", ciudad Asunción.]\nhola" }, e.deps);
  assertEquals(e.reg.textos.length, 2, JSON.stringify(e.turnos.map((x) => x.filtro)));
});

Deno.test("acuse con el pedido creado (10-10): 'dale gracias' / 👍 no se contestan", async () => {
  for (const t of ["Dale sin problema", "👍👍👍", "ok"]) {
    const hist = [fila("out", "Te llega en 3 a 5 días y pagás cuando lo tenés en la mano.", "o1"), fila("in", t, "wamid.IN1")];
    const e = escenario(() => texto("no debería"), { historial: hist });
    e.reg.pedidosChat.push(pedidoChat("creado"));
    const r = await procesarTurno({ ...ENTRADA, texto: t }, e.deps);
    assertEquals(r.accion, "omitido", t);
    assertEquals(e.reg.textos.length, 0, t);
  }
});

Deno.test("12-10: pedido creado en el turno → después de la respuesta, el permiso para ofertas (solo si nunca respondió)", async () => {
  for (const [consent, espera] of [[null, 1], ["si", 0]] as const) {
    const e = escenario((_p, n) =>
      n === 1
        ? herramienta("crear_pedido_cod", { confirmar: false, nombre: "Ana Prueba", ciudad: "CDE", direccion: "Calle 1", items: [{ handle: "tiras-prueba", cantidad: 1 }] })
        : n === 2
        ? herramienta("crear_pedido_cod", { confirmar: true })
        : texto("Listo Ana, quedó confirmado tu pedido 🙌")
    );
    e.deps.herramientas = { ...e.deps.herramientas, consentimiento: () => Promise.resolve(consent) };
    await procesarTurno(ENTRADA, e.deps); // resumen
    await procesarTurno({ ...ENTRADA, texto: "si dale" }, e.deps); // confirma
    const permisos = e.reg.interactivos.filter((i) => JSON.stringify(i.interactive).includes("cons_si:"));
    assertEquals(permisos.length, espera, `consentimiento ${consent}`);
    if (espera) assert(JSON.stringify(permisos[0].interactive).includes("Voltra te avise"));
  }
});

Deno.test("12-10: el permiso espera a que salga la oferta de pago con prioridad (orden: confirmación → oferta → permiso)", async () => {
  const e = escenario((_p, n) =>
    n === 1
      ? herramienta("crear_pedido_cod", { confirmar: false, nombre: "Ana Prueba", ciudad: "CDE", direccion: "Calle 1", items: [{ handle: "tiras-prueba", cantidad: 1 }] })
      : n === 2
      ? herramienta("crear_pedido_cod", { confirmar: true })
      : texto("Listo Ana, quedó confirmado tu pedido 🙌")
  );
  const estados = ["pendiente", "pendiente", "enviado"];
  const consultas: number[] = [];
  e.deps.herramientas = {
    ...e.deps.herramientas,
    consentimiento: () => Promise.resolve(null),
    estadoOfertaPrioridad: (id) => (consultas.push(id), Promise.resolve(estados.shift() ?? "enviado")),
  };
  await procesarTurno(ENTRADA, e.deps);
  const antes = e.esperas.length;
  await procesarTurno({ ...ENTRADA, texto: "si dale" }, e.deps);
  assertEquals(consultas.length, 3);
  assert(e.esperas.slice(antes).filter((ms) => ms === 2000).length >= 2);
  assertEquals(e.reg.interactivos.filter((i) => JSON.stringify(i.interactive).includes("cons_si:")).length, 1);
});

// ---------- 19-10 (paquete 1, W1) ----------

const filaBotones = (id: string, cuerpoTxt: string, botones: Array<[string, string]>): FilaHistorial => ({
  direccion: "out",
  texto: `[button] ${cuerpoTxt} | ${botones.map((b) => b[1]).join(" | ")}`,
  tipo: "interactive",
  contenido: {
    messaging_product: "whatsapp",
    type: "interactive",
    interactive: { type: "button", body: { text: cuerpoTxt }, action: { buttons: botones.map(([bid, title]) => ({ type: "reply", reply: { id: bid, title } })) } },
  },
  estado: "entregado",
  wa_message_id: id,
});
const BOTONES_P1: Array<[string, string]> = [["vend_p1:q2:tiras-prueba", "2 con envío gratis"], ["vend_p1:q1:tiras-prueba", "Quiero 1"], ["vend_p1:duda:tiras-prueba", "Tengo una duda"]];

Deno.test("19-10 tope: pasado el tope usa el modelo barato (no deriva); el seguimiento no sale", async () => {
  const cfg = configPrueba({ vendedor: { modelo: "claude-sonnet-5-5", espera_agrupar_s: 0, whatsapp_enrique: "595990000000" } });
  const e = escenario(() => texto("Te llega en 2 a 5 días hábiles. ¿Es para vos?"), { cfg, gasto: 50 });
  const r = await procesarTurno({ ...ENTRADA, texto: "cuánto tarda?" }, e.deps);
  assertEquals(r.accion, "respondido");
  assertEquals(e.pedidos[0].modelo, "claude-haiku-4-5-20251001");
  assertEquals(e.reg.humano, []);
  const s = escenario(() => texto("x"), { cfg, gasto: 50 });
  const rs = await procesarTurno({ conversacion_id: CONV, wa_message_id: "seguimiento:1:x", texto: "[seguimiento 1]", origen: "seguimiento" }, s.deps);
  assertEquals(rs, { accion: "omitido", motivo: "tope_gasto", costo_usd: 0 });
  // Debajo del tope, el modelo normal.
  const n = escenario(() => texto("Te llega en 2 a 5 días hábiles. ¿Es para vos?"), { cfg, gasto: 10 });
  await procesarTurno({ ...ENTRADA, texto: "cuánto tarda?" }, n.deps);
  assertEquals(n.pedidos[0].modelo, "claude-sonnet-5-5");
});

Deno.test("19-10 tope: modelo_tope y tope_duro_usd configurables", async () => {
  const cfg = configPrueba({ vendedor: { espera_agrupar_s: 0, tope_mensual_usd: 90, tope_duro_usd: 100, modelo_tope: "modelo-barato-x" } });
  const a = escenario(() => texto("Te llega en 2 a 5 días hábiles. ¿Es para vos?"), { cfg, gasto: 95 });
  await procesarTurno({ ...ENTRADA, texto: "cuánto tarda?" }, a.deps);
  assertEquals(a.pedidos[0].modelo, "modelo-barato-x");
  const b = escenario(() => texto("x"), { cfg, gasto: 100 });
  assertEquals((await procesarTurno(ENTRADA, b.deps)).motivo, "tope_gasto");
});

Deno.test("19-10 tope: alerta por Telegram al 70% y 90%, una sola vez por mes cada una", async () => {
  const marcadas = new Set<string>();
  const marcar = (mes: string, clave: string) => {
    const k = `${mes}:${clave}`;
    const nueva = !marcadas.has(k);
    marcadas.add(k);
    return Promise.resolve(nueva);
  };
  const a = escenario(() => texto("Te llega en 2 a 5 días hábiles. ¿Es para vos?"), { gasto: 33 }); // 73% de 45
  a.deps.marcarAlertaTope = marcar;
  await procesarTurno({ ...ENTRADA, texto: "cuánto tarda?" }, a.deps);
  assertEquals(a.reg.avisos.length, 1);
  assert(a.reg.avisos[0].texto.includes("70% del tope"));
  const b = escenario(() => texto("Te llega en 2 a 5 días hábiles. ¿Es para vos?"), { gasto: 41 }); // 91%
  b.deps.marcarAlertaTope = marcar;
  await procesarTurno({ ...ENTRADA, texto: "cuánto tarda?" }, b.deps);
  assertEquals(b.reg.avisos.map((x) => x.texto.includes("90% del tope")), [true]);
  assertEquals([...marcadas].sort(), ["2026-10:70", "2026-10:90"]);
  // Sin la persistencia (io.ts viejo) no se manda nada (para no avisar en cada mensaje).
  const c = escenario(() => texto("Te llega en 2 a 5 días hábiles. ¿Es para vos?"), { gasto: 41 });
  await procesarTurno({ ...ENTRADA, texto: "cuánto tarda?" }, c.deps);
  assertEquals(c.reg.avisos, []);
});

Deno.test("19-10 filtro: confirmar un cambio sin herramienta → regenera con la instrucción exacta", async () => {
  const e = escenario((_p, n) =>
    n === 1 ? texto("Listo, ya lo cambié a 2 unidades.") : texto("Eso no lo puedo cambiar desde acá. Te paso con Enrique para hacerlo. ¿Te parece?")
  );
  const r = await procesarTurno({ ...ENTRADA, texto: "cambiámelo a 2" }, e.deps);
  assertEquals(r.accion, "respondido");
  assert(e.turnos[0].regenerado);
  const control = e.pedidos[1].mensajes.at(-1)!.content as string;
  assert(control.includes("accion_inventada:cambio:"), control);
  assert(control.includes("No confirmes cambios que no hiciste con una herramienta: decí en la primera línea que eso no lo podés hacer desde acá y ofrecé la alternativa real."));
});

Deno.test("19-10 acuse antes del pedido: 'ok' al precio con botones → se reenvían los 3 botones sin modelo", async () => {
  for (const t of ["Ok", "👌", "Genial", "dale", "listo"]) {
    const hist = [fila("out", "Las tiras te ayudan a respirar mejor de noche.", "o1"), filaBotones("o2", "Sale 79.000 + envío, pagás al recibir.", BOTONES_P1), fila("in", t, "wamid.IN1")];
    const e = escenario(() => texto("no debería"), { historial: hist, azar: 0 });
    const r = await procesarTurno({ ...ENTRADA, texto: t }, e.deps);
    assertEquals(r.accion, "respondido", t);
    assertEquals(e.pedidos.length, 0, t);
    assertEquals(e.reg.interactivos.length, 1, t);
    const i = e.reg.interactivos[0].interactive as { body: { text: string }; action: { buttons: Array<{ reply: { id: string } }> } };
    assertEquals(i.body.text, "Buenísimo. ¿Cuál te preparo?");
    assert(i.action.buttons.every((b) => b.reply.id.endsWith(":tiras-prueba")));
    assertEquals(e.turnos[0].accion, "respondido:fija:acuse_precio");
    assertEquals(e.sumas, []);
  }
});

Deno.test("19-10 acuse antes del pedido: un segundo 'ok' después de los botones reenviados no se contesta", async () => {
  const hist = [filaBotones("o2", "Buenísimo. ¿Cuál te preparo?", BOTONES_P1), fila("in", "ok", "wamid.IN1")];
  const e = escenario(() => texto("no debería"), { historial: hist });
  const r = await procesarTurno({ ...ENTRADA, texto: "ok" }, e.deps);
  assertEquals(r.accion, "omitido");
  assertEquals(r.motivo, "acuse_tras_botones_repetido");
  assertEquals(e.reg.interactivos.length + e.reg.textos.length + e.pedidos.length, 0);
});

Deno.test("19-10 acuse antes del pedido: precio en texto (sin botones) → lo ve el modelo con la nota de que no es un cierre", async () => {
  const hist = [fila("out", "Salen Gs 79.000 y pagás al recibir.", "o1"), fila("in", "ok", "wamid.IN1")];
  const e = escenario(() => texto("Buenísimo. ¿Te preparo 1 o 2?"), { historial: hist });
  const r = await procesarTurno({ ...ENTRADA, texto: "ok" }, e.deps);
  assertEquals(r.accion, "respondido");
  assertEquals(e.pedidos.length, 1);
  assert((e.pedidos[0].mensajes.at(-1)!.content as string).includes("no es un cierre"));
});

Deno.test("19-10 acuse después del pedido junto con el botón del permiso de ofertas (#1049) → no se contesta", async () => {
  const botonPermiso: FilaHistorial = {
    direccion: "in", texto: "Sí, avisame", tipo: "interactive",
    contenido: { type: "interactive", interactive: { type: "button_reply", button_reply: { id: `cons_si:${CLIENTE}`, title: "Sí, avisame" } } },
    estado: "recibido", wa_message_id: "wamid.P1",
  };
  const hist = [fila("out", "Listo Ana, ya cargamos tu pedido #1050. Te llega el jueves.", "o1"), botonPermiso, fila("in", "ok", "wamid.IN1")];
  const e = escenario(() => texto("no debería"), { historial: hist });
  e.reg.pedidosChat.push(pedidoChat("creado"));
  const r = await procesarTurno({ ...ENTRADA, texto: "ok" }, e.deps);
  assertEquals(r.accion, "omitido");
  assertEquals(e.reg.textos.length + e.pedidos.length, 0);
});

Deno.test("19-10 seguimiento: derivar_a_enrique se ignora (no pasa a humano ni manda el botón); sale el recontacto", async () => {
  const e = escenario((_p, n) =>
    n === 1 ? herramienta("derivar_a_enrique", { motivo: "otro", resumen: "no contesta" }) : texto("¿Pudiste ver lo de las tiras? Te las preparo hoy si querés.")
  );
  const r = await procesarTurno({ conversacion_id: CONV, wa_message_id: "seguimiento:2:x", texto: "[seguimiento 2]", origen: "seguimiento" }, e.deps);
  assertEquals(r.accion, "respondido");
  assertEquals(e.reg.humano, []);
  assertEquals(e.reg.interactivos, []);
  assertEquals(e.reg.avisos, []);
  assertEquals(e.reg.textos.length, 1);
  const tr = (e.pedidos[1].mensajes.at(-1)!.content as Bloque[])[0] as { content: string; is_error?: boolean };
  assert(tr.content.includes("no_disponible_en_seguimiento") && tr.is_error);
  assertFalse(e.turnos[0].derivado);
});

Deno.test("19-10 un solo resumen vigente: Confirmo de un resumen viejo con otro total no crea el pedido", async () => {
  const hist = [
    filaBotones("o1", "Tiras x1 (Gs 79.000) + envío Gs 33.000 = Gs 112.000", [["vend_conf:pc-1", "Confirmo"], ["vend_corr:pc-1", "Corregir"]]),
    filaBotones("o2", "Tiras x2 · envío gratis · total Gs 125.000", [["vend_conf:pc-2", "Confirmo"], ["vend_corr:pc-2", "Corregir"]]),
    fila("in", "Confirmo (vend_conf:pc-1)", "wamid.IN1"),
  ];
  const e = escenario((_p, n) => n === 1 ? herramienta("crear_pedido_cod", { confirmar: true }) : texto("Te muestro el resumen de nuevo. ¿Confirmás ese?"), { historial: hist });
  e.reg.pedidosChat.push({ ...pedidoChat("resumen"), id: "pc-2", total: 125000 });
  await procesarTurno({ ...ENTRADA, texto: "Confirmo (vend_conf:pc-1)" }, e.deps);
  assertEquals(e.reg.ordenes, []);
  const tr = (e.pedidos[1].mensajes.at(-1)!.content as Bloque[])[0] as { content: string };
  assert(tr.content.includes("boton_de_resumen_viejo"), tr.content);
});

Deno.test("19-10 espera variable: mandando la dirección en partes espera 18 s en total; una reacción no deja el turno sin respuesta", async () => {
  const cfg = configPrueba({ vendedor: { espera_agrupar_s: 8, whatsapp_enrique: null } });
  const hist = [fila("out", "Pasame tu dirección y la ciudad.", "o1"), fila("in", "Calle Palma 123 casi", "wamid.IN1")];
  const e = escenario(() => texto("¿Casi qué calle?"), { cfg, historial: hist });
  await procesarTurno({ ...ENTRADA, texto: "Calle Palma 123 casi" }, e.deps);
  assertEquals(e.esperas.slice(0, 2), [8000, 10000]);
  // Charla normal: solo los 8 s.
  const n = escenario(() => texto("Te llega en 2 a 5 días hábiles. ¿Es para vos?"), { cfg });
  await procesarTurno({ ...ENTRADA, texto: "cuánto tarda?" }, n.deps);
  assertFalse(n.esperas.includes(10000));
  // Una reacción del cliente mientras "escribe" no cuenta como mensaje nuevo para el vendedor.
  const reaccion: FilaHistorial = { direccion: "in", texto: null, tipo: "reaction", contenido: { type: "reaction" }, estado: "recibido", wa_message_id: "wamid.R1" };
  const r = escenario(() => texto("Te llega en 2 a 5 días hábiles. ¿Es para vos?"), {
    cfg, historial: [fila("in", "cuánto tarda?", "wamid.IN1"), reaccion], ultimos: ["wamid.IN1", "wamid.R1", "wamid.R1"],
  });
  const rr = await procesarTurno({ ...ENTRADA, texto: "cuánto tarda?" }, r.deps);
  assertEquals(rr.accion, "respondido");
  assertEquals(r.reg.textos.length, 1);
});

// ---------- 21-10 (v38): "Quiero" escrito = botón "Quiero 1" ----------

Deno.test("21-10 'Quiero' escrito al abrir el chat (caso 1877): nota con datos + precio en una línea y primer_turno bloqueado", async () => {
  const marca = "[vino del anuncio de tiras nasales, handle tiras-prueba]";
  const historial: FilaHistorial[] = [
    { direccion: "in", texto: `${marca}\n¡Hola! Quiero más información`, tipo: "text", contenido: {}, estado: "recibido", wa_message_id: "wamid.A" },
    { direccion: "in", texto: `${marca}\nQuiero`, tipo: "text", contenido: {}, estado: "recibido", wa_message_id: "wamid.B" },
  ];
  const e = escenario((_p, n) => n === 1
    ? herramienta("primer_turno", { handle: "tiras-prueba", gancho: "x" })
    : texto("Genial! Pasame tu nombre, tu ciudad y la calle o barrio 🙌 El repartidor te llama antes de ir."), { historial, ultimo: "wamid.B" });
  const r = await procesarTurno({ conversacion_id: CONV, wa_message_id: "wamid.B", texto: `${marca}\nQuiero` }, e.deps);
  assertEquals(r.accion, "respondido");
  const ultimo = e.pedidos[0].mensajes.at(-1)!;
  assert(String(ultimo.content).includes("El cliente ESCRIBIÓ que lo quiere"), String(ultimo.content));
  assert(String(ultimo.content).includes("pagás al recibir"), String(ultimo.content));
  const pt = e.turnos[0].herramientas.find((h) => h.nombre === "primer_turno");
  assert(pt?.error && JSON.stringify(pt.resultado).includes("el_cliente_ya_dijo_que_lo_quiere"), JSON.stringify(e.turnos[0].herramientas));
  assert(e.turnos[0].herramientas.some((h) => h.nombre === "intencion_escrita(sistema)"));
  assertEquals(e.reg.interactivos.length, 0);
});

Deno.test("21-10 intención escrita: no aplica a una pregunta, con el switch apagado ni si ya pedimos los datos", async () => {
  const preg = escenario(() => texto("Sale 79.000."), { historial: [{ direccion: "in", texto: "quiero saber el precio", tipo: "text", contenido: {}, estado: "recibido", wa_message_id: "wamid.IN1" }] });
  await procesarTurno({ ...ENTRADA, texto: "quiero saber el precio" }, preg.deps);
  assertFalse(String(preg.pedidos[0].mensajes.at(-1)!.content).includes("ESCRIBIÓ que lo quiere"));
  const base = configPrueba();
  const apagado = escenario(() => texto("ok"), { cfg: { ...base, vendedor: { ...base.vendedor, intencion_escrita: false } as never }, historial: [{ direccion: "in", texto: "quiero", tipo: "text", contenido: {}, estado: "recibido", wa_message_id: "wamid.IN1" }] });
  await procesarTurno({ ...ENTRADA, texto: "quiero" }, apagado.deps);
  assertFalse(String(apagado.pedidos[0].mensajes.at(-1)!.content).includes("ESCRIBIÓ que lo quiere"));
  const yaPidio = escenario(() => texto("Dale"), { historial: [
    { direccion: "out", texto: "Genial! Pasame tu nombre, tu ciudad y la calle o barrio 🙌", tipo: "text", contenido: {}, estado: "entregado", wa_message_id: "wamid.O1" },
    { direccion: "in", texto: "quiero", tipo: "text", contenido: {}, estado: "recibido", wa_message_id: "wamid.IN1" },
  ] });
  await procesarTurno({ ...ENTRADA, texto: "quiero" }, yaPidio.deps);
  assertFalse(String(yaPidio.pedidos[0].mensajes.at(-1)!.content).includes("ESCRIBIÓ que lo quiere"));
  // Pidió los datos en la primera burbuja y ofreció 2 en la segunda: "Mándame 2" no repite el pedido de datos.
  const dosBurbujas = escenario(() => texto("Dale, 2"), { historial: [
    { direccion: "in", texto: "[botón] Quiero 1 (vend_p1:q1:tiras-prueba)", tipo: "interactive", contenido: {}, estado: "recibido", wa_message_id: "wamid.I0" },
    { direccion: "out", texto: "Genial! Pasame tu nombre, tu ciudad y la calle o barrio 🙌", tipo: "text", contenido: {}, estado: "entregado", wa_message_id: "wamid.O1" },
    { direccion: "out", texto: "Si preferís 2 te sale 158.000 y el envío es gratis.", tipo: "text", contenido: {}, estado: "entregado", wa_message_id: "wamid.O2" },
    { direccion: "in", texto: "Mándame 2", tipo: "text", contenido: {}, estado: "recibido", wa_message_id: "wamid.IN1" },
  ] });
  await procesarTurno({ ...ENTRADA, texto: "Mándame 2" }, dosBurbujas.deps);
  assertFalse(String(dosBurbujas.pedidos[0].mensajes.at(-1)!.content).includes("ESCRIBIÓ que lo quiere"));
});
