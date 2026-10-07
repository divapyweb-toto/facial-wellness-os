// Tests de la auditoría diaria con dependencias falsas (sin base, sin Telegram, sin Claude).
import { assert, assertEquals, assertRejects, assertStringIncludes } from "@std/assert";
import { type DepsAuditoria, ejecutarAuditoria, type EstadoLoteAud } from "./auditoria.ts";
import {
  armarAviso,
  CFG_POR_DEFECTO,
  combinar,
  type ConvInfo,
  customId,
  enlaceBandeja,
  evaluarConversacion,
  interpretarVeredicto,
  type MensajeAud,
  pedidosParaLote,
  rangoDeFecha,
  rangoDiaAnterior,
} from "./logica.ts";
import { _configurarClaude, llamarClaudeLote } from "../_shared/claude.ts";

const AHORA = new Date("2026-10-07T10:30:00Z"); // 7:30 en Asunción (UTC-3)

Deno.test("rango del día anterior en hora de Asunción", () => {
  const r = rangoDiaAnterior(AHORA);
  assertEquals(r.fecha, "2026-10-06");
  assertEquals(r.desde.toISOString(), "2026-10-06T03:00:00.000Z");
  assertEquals(r.hasta.toISOString(), "2026-10-07T03:00:00.000Z");
  // a las 00:30 locales del 1/11 el día anterior es el 31/10
  assertEquals(rangoDiaAnterior(new Date("2026-11-01T03:30:00Z")).fecha, "2026-10-31");
  assertEquals(rangoDeFecha("2026-10-01").hasta.toISOString(), "2026-10-02T03:00:00.000Z");
});

// ------------------------------------------------------------------ datos falsos

let n = 0;
const msg = (conv: string, direccion: "in" | "out", texto: string, hora = "12:00"): MensajeAud => ({
  id: `m${++n}`,
  conversacion_id: conv,
  cliente_id: `cli-${conv}`,
  direccion,
  tipo: "text",
  texto,
  creado_en: `2026-10-06T${hora}:00.000Z`,
});
const conv = (id: string, nombre: string, estado = "ia"): ConvInfo => ({
  id,
  estado,
  cliente_id: `cli-${id}`,
  nombre,
  telefono: "+595981000000",
  wa_username: null,
});

const MENSAJES: MensajeAud[] = [
  // conv-ok: venta limpia con pedido creado
  msg("conv-ok", "in", "hola cuanto salen las tiras?", "12:00"),
  msg("conv-ok", "out", "Las tiras salen Gs 79.000 + envío Gs 33.000 = Gs 112.000, pagás al recibir.\n¿Te las preparo?", "12:01"),
  msg("conv-ok", "in", "dale", "12:02"),
  // conv-mala: palabra prohibida y precio inventado
  msg("conv-mala", "in", "tiene garantia? cuanto sale", "13:00"),
  msg("conv-mala", "out", "Sí, tiene garantía de 30 días y te lo dejo en Gs 60.000.", "13:01"),
  // conv-enojo: cliente que insulta
  msg("conv-enojo", "in", "son unos chantas, no me llegó nada", "14:00"),
  msg("conv-enojo", "out", "Perdón por la demora, te paso con una persona del equipo.", "14:01"),
  // conv-perdida: quiso comprar y no hubo pedido
  msg("conv-perdida", "in", "quiero comprar 2 parches", "15:00"),
  msg("conv-perdida", "out", "Hola, ¿en qué te ayudo?", "15:01"),
];

const TURNOS = [
  { conversacion_id: "conv-ok", herramientas: [{ nombre: "consultar_catalogo", resultado: { productos: [{ precio: 79000, total: 112000 }], envio: 33000 } }, { nombre: "crear_pedido_cod", input: { confirmar: true } }], derivado: false },
  { conversacion_id: "conv-enojo", herramientas: [{ nombre: "derivar_a_enrique", input: {} }], derivado: true },
];

interface Falsas extends DepsAuditoria {
  avisos: string[];
  guardado: Map<string, unknown>;
  lotesCreados: number;
  consultas: number;
}

function falsas(opc: {
  mensajes?: MensajeAud[];
  estado?: unknown;
  lote?: (pedidos: { custom_id: string }[]) => EstadoLoteAud | Promise<EstadoLoteAud>;
  consultar?: (id: string) => EstadoLoteAud;
  avisarOk?: boolean;
  ahora?: Date;
} = {}): Falsas {
  const guardado = new Map<string, unknown>();
  if (opc.estado) guardado.set("auditoria_estado", opc.estado);
  const f: Falsas = {
    avisos: [],
    guardado,
    lotesCreados: 0,
    consultas: 0,
    ahora: () => opc.ahora ?? AHORA,
    config: (clave) => {
      if (clave === "auditoria") return Promise.resolve({ url_bandeja: "https://ejemplo.test/#/bandeja", envio: 33000 });
      if (clave === "palabras_prohibidas") return Promise.resolve(["garantía", "devolución", "reembolso", "sin riesgo", "cura", "curar", "tratamiento", "oxígeno"]);
      return Promise.resolve(guardado.get(clave) ?? null);
    },
    guardarConfig: (clave, valor) => {
      guardado.set(clave, valor);
      return Promise.resolve();
    },
    mensajesEntre: () => Promise.resolve(opc.mensajes ?? MENSAJES),
    conversaciones: (ids) =>
      Promise.resolve(
        ids.map((id) =>
          conv(id, { "conv-ok": "Rosa Ok", "conv-mala": "Marta Mala", "conv-enojo": "Néstor Enojo", "conv-perdida": "Pablo Perdida" }[id] ?? id, id === "conv-enojo" ? "humano" : "ia")
        ),
      ),
    turnosVendedor: () => Promise.resolve(TURNOS),
    pedidosDeClientes: () => Promise.resolve([{ cliente_id: "cli-conv-ok", total: 112000, creado_en: "2026-10-06T12:03:00.000Z" }]),
    crearLote: (pedidos) => {
      f.lotesCreados++;
      return Promise.resolve(opc.lote ? opc.lote(pedidos) : { id: "lote-1", estado: "ended", simulado: false, resultados: [] });
    },
    consultarLote: (id) => {
      f.consultas++;
      return Promise.resolve(opc.consultar ? opc.consultar(id) : { id, estado: "ended", simulado: false, resultados: [] });
    },
    avisar: (texto) => {
      f.avisos.push(texto);
      return Promise.resolve(opc.avisarOk === false ? { ok: false, error: "sin red" } : { ok: true });
    },
    log: () => {},
  };
  return f;
}

const veredicto = (id: string, v: Record<string, unknown>) => ({ custom_id: customId(id), tipo: "succeeded", texto: JSON.stringify(v), costo_usd: 0.001 });

// ------------------------------------------------------------------ flujo

Deno.test("avisa SOLO las conversaciones raras, con enlace a la bandeja", async () => {
  const f = falsas({
    lote: () => ({
      id: "lote-1",
      estado: "ended",
      simulado: false,
      resultados: [
        veredicto("conv-ok", { enojado: false, venta_perdida: false, problema: null, resumen: "Compró tiras" }),
        veredicto("conv-perdida", { enojado: false, venta_perdida: true, problema: null, resumen: "Quiso 2 parches y el vendedor no dio precio" }),
      ],
    }),
  });
  const r = await ejecutarAuditoria(f);
  assertEquals(r.accion, "avisado");
  assertEquals(r.revisadas, 4);
  assertEquals(r.raras, 3);
  assertEquals(f.avisos.length, 1);
  const a = f.avisos[0];
  assertStringIncludes(a, "Marta Mala");
  assertStringIncludes(a, "Palabra prohibida: garantía");
  assertStringIncludes(a, "Precio dudoso: Gs 60.000");
  assertStringIncludes(a, "Néstor Enojo");
  assertStringIncludes(a, "Cliente enojado");
  assertStringIncludes(a, "Pablo Perdida");
  assertStringIncludes(a, "Venta perdida");
  assertStringIncludes(a, 'href="https://ejemplo.test/#/bandeja?c=conv-mala"');
  assert(!a.includes("Rosa Ok"), "la conversación limpia no va en el aviso");
  assertEquals((f.guardado.get("auditoria_estado") as { estado: string }).estado, "enviado");
  assertEquals(r.costo_usd, 0.002);
});

Deno.test("si el día ya se informó no hace nada", async () => {
  const f = falsas({ estado: { fecha: "2026-10-06", estado: "enviado", revisadas: 4, raras: 1 } });
  const r = await ejecutarAuditoria(f);
  assertEquals(r.accion, "ya_informado");
  assertEquals(f.avisos.length, 0);
  assertEquals(f.lotesCreados, 0);
  // con reenviar sí
  const r2 = await ejecutarAuditoria(f, { reenviar: true });
  assertEquals(r2.accion, "avisado");
});

Deno.test("día sin nada raro: no manda nada a Telegram", async () => {
  const f = falsas({ mensajes: MENSAJES.filter((m) => m.conversacion_id === "conv-ok") });
  const r = await ejecutarAuditoria(f);
  assertEquals(r.accion, "sin_novedades");
  assertEquals(f.avisos.length, 0);
  assertEquals((f.guardado.get("auditoria_estado") as { estado: string }).estado, "enviado");
});

Deno.test("día sin conversaciones", async () => {
  const f = falsas({ mensajes: [] });
  assertEquals((await ejecutarAuditoria(f)).accion, "sin_conversaciones");
  assertEquals(f.lotesCreados, 0);
});

Deno.test("lote de Haiku pendiente: guarda y lo levanta el próximo cron", async () => {
  const f = falsas({ lote: () => ({ id: "lote-9", estado: "in_progress", simulado: false }) });
  const r = await ejecutarAuditoria(f);
  assertEquals(r.accion, "esperando_lote");
  assertEquals(f.avisos.length, 0);
  const est = f.guardado.get("auditoria_estado") as { estado: string; lote_id: string };
  assertEquals([est.estado, est.lote_id], ["pendiente", "lote-9"]);

  // 20 minutos después el lote terminó
  const f2 = falsas({
    estado: est,
    ahora: new Date(AHORA.getTime() + 20 * 60_000),
    consultar: (id) => ({ id, estado: "ended", simulado: false, resultados: [] }),
  });
  const r2 = await ejecutarAuditoria(f2);
  assertEquals(f2.consultas, 1);
  assertEquals(f2.lotesCreados, 0, "no crea otro lote");
  assertEquals(r2.accion, "avisado");
});

Deno.test("lote que no termina en 3 h: avisa solo con las reglas y lo dice", async () => {
  const f = falsas({
    estado: { fecha: "2026-10-06", estado: "pendiente", lote_id: "lote-9", iniciado_en: AHORA.toISOString() },
    ahora: new Date(AHORA.getTime() + 3.5 * 3_600_000),
    consultar: (id) => ({ id, estado: "in_progress", simulado: false }),
  });
  const r = await ejecutarAuditoria(f);
  assertEquals(r.accion, "avisado");
  assertStringIncludes(f.avisos[0], "no terminó");
  assertStringIncludes(f.avisos[0], "Marta Mala");
});

Deno.test("si el lote falla, igual avisa lo de las reglas (venta perdida por heurística)", async () => {
  const f = falsas({
    lote: () => {
      throw new Error("HTTP 529 overloaded");
    },
  });
  const r = await ejecutarAuditoria(f);
  assertEquals(r.accion, "avisado");
  assertStringIncludes(f.avisos[0], "falló");
  assertStringIncludes(f.avisos[0], "Pablo Perdida"); // quiso comprar, sin pedido, sin derivar
});

Deno.test("si Telegram falla no se marca como informado (reintenta)", async () => {
  const f = falsas({ avisarOk: false });
  await assertRejects(() => ejecutarAuditoria(f), Error, "Telegram");
  assertEquals(f.guardado.get("auditoria_estado"), undefined);
});

// ------------------------------------------------------------------ piezas puras

Deno.test("evaluarConversacion: montos de las herramientas y pedido creado", () => {
  const ev = evaluarConversacion(
    conv("c", "X"),
    [msg("c", "in", "precio?"), msg("c", "out", "Sale Gs 99.000 con envío incluido")],
    [{ conversacion_id: "c", herramientas: [{ nombre: "consultar_catalogo", resultado: { productos: [{ precio_texto: "99.000" }] } }], derivado: false }],
    [],
    CFG_POR_DEFECTO,
  );
  assertEquals(ev.senales, []);
  assertEquals(ev.hubo_pedido, false);
});

Deno.test("veredicto de Haiku: JSON con texto alrededor, o ilegible", () => {
  assertEquals(interpretarVeredicto('Claro: {"enojado": true, "venta_perdida": false, "problema": "", "resumen": "x"}')?.enojado, true);
  assertEquals(interpretarVeredicto("¡Hola! Contame qué buscás"), null);
  assertEquals(interpretarVeredicto(null), null);
});

Deno.test("combinar: venta perdida no se marca si hubo pedido", () => {
  const ev = evaluarConversacion(conv("c", "X"), [msg("c", "in", "quiero comprar")], [], [{ cliente_id: "cli-c", total: 112000, creado_en: "2026-10-06T13:00:00.000Z" }], CFG_POR_DEFECTO);
  assertEquals(combinar(ev, { enojado: false, venta_perdida: true, problema: null, resumen: null }).senales, []);
});

Deno.test("aviso: escapa HTML y sin url de bandeja muestra el id", () => {
  const ev = combinar(evaluarConversacion({ ...conv("c<1>", "<b>Ana</b>") }, [msg("c<1>", "out", "tiene garantía")], [], [], CFG_POR_DEFECTO), null);
  const a = armarAviso("2026-10-06", 1, [ev], CFG_POR_DEFECTO);
  assertStringIncludes(a, "&lt;b&gt;Ana&lt;/b&gt;");
  assertStringIncludes(a, "conversación c&lt;1&gt;");
  assertStringIncludes(a, "06/10/2026");
  assertEquals(enlaceBandeja(null, "x"), null);
  assertEquals(enlaceBandeja("https://a.test/#/bandeja?x=1", "c 1"), "https://a.test/#/bandeja?x=1&c=c%201");
});

Deno.test("integración con llamarClaudeLote de G1 en modo simulado (sin red)", async () => {
  _configurarClaude({ modoSimulado: () => true, apiKey: () => undefined });
  try {
    const evs = [evaluarConversacion(conv("abc-123", "X"), [msg("abc-123", "in", "hola")], [], [], CFG_POR_DEFECTO)];
    const pedidos = pedidosParaLote(evs, "claude-haiku-4-5");
    assertEquals(pedidos[0].custom_id, "c_abc-123");
    const lote = await llamarClaudeLote(pedidos);
    assertEquals(lote.estado, "ended");
    assert(lote.simulado);
    assertEquals(lote.resultados?.[0].custom_id, "c_abc-123");
  } finally {
    _configurarClaude();
  }
});
