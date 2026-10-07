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
