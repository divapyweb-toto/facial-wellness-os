// Tests del rescate de datos (13-10): quién entra, la corrida (marca, turno "[rescate datos]", fallas) y la integración
// con el orquestador del vendedor (modelo y WhatsApp simulados). Datos inventados: repo público.
import { assert, assertEquals, assertFalse } from "@std/assert";
import { type RespuestaClaude, USO_CERO } from "../_shared/claude.ts";
import { _limpiarCacheCatalogo } from "../_shared/vendedor/herramientas.ts";
import { type DepsOrquestador, type EntradaTurno, type FilaTurno, procesarTurno, type ResultadoTurno } from "../_shared/vendedor/orquestador.ts";
import type { PerfilCliente } from "../_shared/vendedor/perfil.ts";
import { CLIENTE, configPrueba, CONV, depsPrueba, TEL } from "../_shared/vendedor/prueba_utiles.ts";
import { type Candidato, CFG_SEGUIMIENTO_DEFAULT, correrSeguimientos, type DepsSeguimiento } from "./logica.ts";
import {
  CFG_RESCATE_DATOS_DEFAULT,
  correrRescateDatos,
  decidirRescateDatos,
  esBotonQuiero,
  leerCfgRescateDatos,
  rescateSalio,
  TEXTO_RESCATE_DATOS,
} from "./rescate_datos.ts";

const MIN = 60_000;
// 15:00 UTC = 12:00 de Asunción (UTC−3).
const AHORA = new Date("2026-10-13T15:00:00Z");
const haceMin = (m: number, base = AHORA) => new Date(base.getTime() - m * MIN).toISOString();
const CFG = CFG_SEGUIMIENTO_DEFAULT;
const RD = CFG_RESCATE_DATOS_DEFAULT;

/** Tocó "Quiero 1" hace 14 min, el bot le pidió los datos, mandó el nombre hace 12 min y se calló. */
function cand(over: Partial<Candidato> = {}): Candidato {
  return {
    conversacion_id: "conv-r",
    cliente_id: "cli-r",
    estado: "ia",
    ultima_entrada_en: haceMin(12),
    perfil: { producto: "tiras nasales", cantidad: 1 },
    ultimo_mensaje: { direccion: "out", creado_en: haceMin(11.5) },
    ultima_respuesta_derivada: false,
    pedido_reciente: false,
    baja_marketing: false,
    nombre: "Ana Prueba",
    telefono: "+595981000000",
    ultimo_quiero_en: haceMin(14),
    ultimo_resumen_en: null,
    rescates_datos: 0,
    ...over,
  };
}

const motivo = (c: Candidato, ahora = AHORA, rd = RD, cfg = CFG) => {
  const d = decidirRescateDatos(c, rd, cfg, ahora);
  return d.tipo === "nada" ? d.motivo : d.tipo;
};

// ---------- config y botones ----------

Deno.test("rescate config: defaults 10 min, máx. 2, prendido; lo raro toma el default; se lee de vendedor_seguimiento", () => {
  assertEquals(RD, { rescate_datos_activo: true, rescate_datos_min: 10, rescate_datos_max: 2 });
  assertEquals(leerCfgRescateDatos(null), RD);
  assertEquals(leerCfgRescateDatos({ rescate_datos_min: -1, rescate_datos_max: "3", rescate_datos_activo: "no" }), RD);
  assertEquals(leerCfgRescateDatos({ rescate_datos_min: 20, rescate_datos_max: 3.7, rescate_datos_activo: false }), {
    rescate_datos_activo: false,
    rescate_datos_min: 20,
    rescate_datos_max: 3,
  });
});

Deno.test("botones 'Quiero …': q1, q2, pack y el viejo pedir; 'Tengo una duda' y otros no", () => {
  for (const id of ["vend_p1:q1:tiras-prueba", "vend_p1:q2:tiras-prueba", "vend_p1:pack:pack-prueba", "vend_p1:pedir:tiras-prueba", " vend_p1:q1:x "]) {
    assert(esBotonQuiero(id), id);
  }
  for (const id of ["vend_p1:duda:tiras-prueba", "vend_p1:cant:tiras-prueba", "mk_baja:0", "conf:si:1001", "", null, undefined, "q1"]) {
    assertFalse(esBotonQuiero(id), String(id));
  }
});

Deno.test("conteo: solo cuentan los rescates que le llegaron al cliente (respondido, terminal, derivado)", () => {
  for (const a of ["seguimiento", "seguimiento:fija", "seguimiento_terminal", "seguimiento_derivado:salud"]) assert(rescateSalio(a), a);
  for (const a of ["seguimiento_omitido:cliente_escribio", "seguimiento_error_envio:131047", "seguimiento_agrupado", "respondido", null]) {
    assertFalse(rescateSalio(a), String(a));
  }
});

// ---------- decisión ----------

Deno.test("rescate: tocó 'Quiero', el bot habló último y el cliente se calló ≥ 10 min → rescate", () => {
  assertEquals(motivo(cand()), "rescate");
  // Tocó y no mandó nada más: la entrada es el propio toque.
  assertEquals(motivo(cand({ ultimo_quiero_en: haceMin(10), ultima_entrada_en: haceMin(10), ultimo_mensaje: { direccion: "out", creado_en: haceMin(9.5) } })), "rescate");
});

Deno.test("rescate: 10 min sin escribir (rescate_datos_min); configurable", () => {
  assertEquals(motivo(cand({ ultima_entrada_en: haceMin(9.9) })), "esperando");
  assertEquals(motivo(cand({ ultima_entrada_en: haceMin(10) })), "rescate");
  assertEquals(motivo(cand({ ultima_entrada_en: haceMin(15) }), AHORA, { ...RD, rescate_datos_min: 20 }), "esperando");
});

Deno.test("rescate: uno por toque (rescate_datos_en después del toque); si vuelve a tocar 'Quiero', puede salir otro", () => {
  assertEquals(motivo(cand({ perfil: { rescate_datos_en: haceMin(2) } })), "ya_rescatado");
  // Rescate viejo (de un toque anterior) y un toque nuevo después.
  assertEquals(motivo(cand({ perfil: { rescate_datos_en: haceMin(120) }, rescates_datos: 1 })), "rescate");
});

Deno.test("rescate: máximo 2 por conversación (rescate_datos_max)", () => {
  assertEquals(motivo(cand({ rescates_datos: 1 })), "rescate");
  assertEquals(motivo(cand({ rescates_datos: 2 })), "tope_rescates");
  assertEquals(motivo(cand({ rescates_datos: 2 }), AHORA, { ...RD, rescate_datos_max: 3 }), "rescate");
});

Deno.test("rescate: nunca si dijo que no, derivado a Enrique o si Enrique le escribió a mano", () => {
  assertEquals(motivo(cand({ perfil: { rechazo: true } })), "rechazo");
  assertEquals(motivo(cand({ ultima_respuesta_derivada: true })), "derivado");
  assertEquals(motivo(cand({ ultimo_mensaje: { direccion: "out", creado_en: haceMin(5), manual: true } })), "enrique_escribio");
});

Deno.test("rescate: nunca con pedido reciente ni con resumen/pedido del chat después del toque", () => {
  assertEquals(motivo(cand({ pedido_reciente: true })), "pedido_reciente");
  assertEquals(motivo(cand({ ultimo_resumen_en: haceMin(13) })), "ya_hay_resumen");
  // Un resumen de antes del toque (pidió de nuevo) no frena.
  assertEquals(motivo(cand({ ultimo_resumen_en: haceMin(60) })), "rescate");
});

Deno.test("rescate: solo si el toque fue hace < 23 h (ventana de 24 h de WhatsApp)", () => {
  const tarde = (h: number) => cand({ ultimo_quiero_en: haceMin(h * 60), ultima_entrada_en: haceMin(h * 60 - 1) });
  assertEquals(motivo(tarde(22.9)), "rescate");
  assertEquals(motivo(tarde(23)), "ventana_cerrada");
  assertEquals(motivo(tarde(30)), "ventana_cerrada");
});

Deno.test("rescate: otras exclusiones (no 'ia', sin toque, cliente habló último, baja, fecha pedida, recontacto después del toque)", () => {
  assertEquals(motivo(cand({ estado: "humano" })), "no_esta_en_ia");
  assertEquals(motivo(cand({ ultimo_quiero_en: null })), "sin_quiero");
  assertEquals(motivo(cand({ ultimo_mensaje: { direccion: "in", creado_en: haceMin(12) } })), "cliente_hablo_ultimo");
  assertEquals(motivo(cand({ ultimo_mensaje: null })), "cliente_hablo_ultimo");
  assertEquals(motivo(cand({ baja_marketing: true })), "baja_marketing");
  assertEquals(motivo(cand({ perfil: { recontactar_el: "2026-10-20" } })), "espera_fecha_pedida");
  assertEquals(motivo(cand({ perfil: { recontactar_el: "2026-10-13" } })), "rescate");
  assertEquals(motivo(cand({ perfil: { seguimientos: 1, ultimo_seguimiento_en: haceMin(5) } })), "recontacto_ya_salio");
  assertEquals(motivo(cand({ perfil: { recontacto_cobro_en: haceMin(5) } })), "recontacto_ya_salio");
  // Un recontacto de antes del toque no frena (y el contador de recontactos no importa).
  assertEquals(motivo(cand({ perfil: { seguimientos: 2, ultimo_seguimiento_en: haceMin(300) } })), "rescate");
});

Deno.test("rescate: sin franja horaria (el cliente tocó hace minutos): a las 3:00 de Asunción también", () => {
  const madrugada = new Date("2026-10-13T06:00:00Z");
  assertEquals(motivo(cand({ ultimo_quiero_en: haceMin(14, madrugada), ultima_entrada_en: haceMin(12, madrugada), ultimo_mensaje: { direccion: "out", creado_en: haceMin(11, madrugada) } }), madrugada), "rescate");
});

// ---------- corrida ----------

function corrida(cands: Candidato[], op: {
  cfg?: unknown;
  tope?: boolean;
  turno?: (e: EntradaTurno) => ResultadoTurno | Promise<ResultadoTurno>;
  marcarFalla?: boolean;
  ahora?: Date;
} = {}) {
  const marcasRescate: Array<[string, string | null]> = [];
  const marcasSeguimiento: unknown[] = [];
  const entradas: EntradaTurno[] = [];
  const avisos: string[] = [];
  const busquedas: Array<[string, string]> = [];
  const orden: string[] = [];
  const ahora = op.ahora ?? AHORA;
  const deps: DepsSeguimiento = {
    config: () => Promise.resolve(op.cfg ?? null),
    topeGastoSuperado: () => Promise.resolve(!!op.tope),
    candidatos: () => Promise.resolve([]),
    marcar: (...a) => (marcasSeguimiento.push(a), Promise.resolve()),
    turno: async (e) => {
      entradas.push(e);
      orden.push(`turno:${e.conversacion_id}`);
      return await (op.turno?.(e) ?? { accion: "respondido", respuesta: "ok", costo_usd: 0.001 });
    },
    avisar: (t) => (avisos.push(t), Promise.resolve()),
    ahora: () => ahora,
    paralelo: 3,
    candidatosRescateDatos: (desde, hasta) => (busquedas.push([desde, hasta]), Promise.resolve(cands)),
    marcarRescateDatos: (id, en) => {
      if (op.marcarFalla) return Promise.reject(new Error("sin red"));
      marcasRescate.push([id, en]);
      orden.push(`marca:${id}`);
      return Promise.resolve();
    },
  };
  return { deps, marcasRescate, marcasSeguimiento, entradas, avisos, busquedas, orden };
}

Deno.test("corrida rescate: marca ANTES del turno, entrada '[rescate datos]' con origen seguimiento; no toca el contador de recontactos", async () => {
  const x = corrida([cand(), cand({ conversacion_id: "conv-no", perfil: { rechazo: true } })]);
  const r = await correrRescateDatos(x.deps, null);
  assertEquals(r.accion, "corrido");
  assertEquals([r.candidatos, r.elegibles, r.enviados, r.omitidos, r.fallas], [2, 1, 1, 0, 0]);
  assertEquals(r.motivos, { rechazo: 1 });
  assertEquals(x.orden, ["marca:conv-r", "turno:conv-r"]);
  assertEquals(x.entradas.length, 1);
  assertEquals(x.entradas[0].texto, TEXTO_RESCATE_DATOS);
  assertEquals(x.entradas[0].texto, "[rescate datos]");
  assertEquals(x.entradas[0].origen, "seguimiento");
  assertEquals(x.entradas[0].wa_message_id, `rescate_datos:conv-r:${AHORA.toISOString()}`);
  assertEquals(x.marcasRescate, [["conv-r", AHORA.toISOString()]]);
  assertEquals(x.marcasSeguimiento, [], "no cuenta para el tope de recontactos");
  assertEquals(x.avisos, []);
  // Busca toques de las últimas 23 h y clientes callados hace ≥ 10 min.
  assertEquals(x.busquedas, [[haceMin(23 * 60), haceMin(10)]]);
});

Deno.test("corrida rescate: apagado (rescate_datos_activo, activo general, máx. 0) o sin deps no busca", async () => {
  for (const cfg of [{ rescate_datos_activo: false }, { activo: false }, { rescate_datos_max: 0 }]) {
    const x = corrida([cand()], { cfg });
    assertEquals((await correrRescateDatos(x.deps, cfg)).accion, "inactivo", JSON.stringify(cfg));
    assertEquals(x.busquedas, []);
    assertEquals(x.entradas, []);
  }
  const y = corrida([cand()]);
  delete y.deps.candidatosRescateDatos;
  assertEquals((await correrRescateDatos(y.deps, null)).accion, "inactivo");
});

Deno.test("corrida rescate: tope de gasto de IA → ningún turno ni marca", async () => {
  const x = corrida([cand()], { tope: true });
  const r = await correrRescateDatos(x.deps, null);
  assertEquals(r.accion, "tope_gasto");
  assertEquals(x.entradas, []);
  assertEquals(x.marcasRescate, []);
  // Sin elegibles ni siquiera mira el gasto.
  const y = corrida([cand({ pedido_reciente: true })], { tope: true });
  assertEquals((await correrRescateDatos(y.deps, null)).accion, "corrido");
});

Deno.test("corrida rescate: omitido sin gasto devuelve la marca anterior; con gasto queda", async () => {
  const previa = haceMin(300);
  const x = corrida([cand({ perfil: { rescate_datos_en: previa } })], { turno: () => ({ accion: "omitido", motivo: "tope_turnos", costo_usd: 0 }) });
  const r = await correrRescateDatos(x.deps, null);
  assertEquals([r.enviados, r.omitidos, r.fallas], [0, 1, 0]);
  assertEquals(x.marcasRescate, [["conv-r", AHORA.toISOString()], ["conv-r", previa]]);
  const y = corrida([cand()], { turno: () => ({ accion: "omitido", motivo: "cliente_escribio", costo_usd: 0 }) });
  await correrRescateDatos(y.deps, null);
  assertEquals(y.marcasRescate, [["conv-r", AHORA.toISOString()], ["conv-r", null]]);
  const z = corrida([cand()], { turno: () => ({ accion: "omitido", motivo: "cliente_escribio", costo_usd: 0.002 }) });
  await correrRescateDatos(z.deps, null);
  assertEquals(z.marcasRescate.length, 1, "se gastó el modelo: no se reintenta en loop");
});

Deno.test("corrida rescate: fallas (envío, IA, excepción) → UN aviso; sin marca no hay turno", async () => {
  const cands = ["a", "b", "c", "d"].map((id) => cand({ conversacion_id: id }));
  const x = corrida(cands, {
    turno: (e) => {
      if (e.conversacion_id === "a") return { accion: "error_envio", motivo: "131047 <ventana>" };
      if (e.conversacion_id === "b") return { accion: "omitido", motivo: "sin_derivar:filtro", costo_usd: 0 };
      if (e.conversacion_id === "c") throw new Error("boom");
      return { accion: "respondido", costo_usd: 0.001 };
    },
  });
  const r = await correrRescateDatos(x.deps, null);
  assertEquals([r.enviados, r.fallas], [1, 3]);
  assertEquals(x.avisos.length, 1);
  assert(x.avisos[0].includes("Rescate de datos: 3 con problemas"));
  assert(x.avisos[0].includes("&lt;ventana&gt;"), "escapa el HTML");
  assertEquals(x.marcasRescate.filter(([id]) => id === "b").length, 1, "la falla de la IA no desmarca");
  const z = corrida([cand()], { marcarFalla: true });
  const rz = await correrRescateDatos(z.deps, null);
  assertEquals(z.entradas, []);
  assertEquals(rz.fallas, 1);
  assertEquals(z.avisos.length, 1);
});

Deno.test("corrida rescate: máximo lote_max por corrida", async () => {
  const x = corrida(Array.from({ length: 25 }, (_, i) => cand({ conversacion_id: `c${i}` })));
  const r = await correrRescateDatos(x.deps, null);
  assertEquals(x.entradas.length, 20);
  assertEquals(r.motivos?.lote_lleno, 5);
});

Deno.test("correrSeguimientos: el rescate corre de madrugada aunque los recontactos estén fuera de horario y va en el resumen", async () => {
  const madrugada = new Date("2026-10-13T06:00:00Z"); // 3:00 de Asunción
  const c = cand({ ultimo_quiero_en: haceMin(14, madrugada), ultima_entrada_en: haceMin(12, madrugada), ultimo_mensaje: { direccion: "out", creado_en: haceMin(11, madrugada) } });
  const x = corrida([c], { ahora: madrugada });
  const r = await correrSeguimientos(x.deps);
  assertEquals(r.accion, "fuera_de_horario");
  assertEquals(r.rescate_datos?.enviados, 1);
  // Sin sus deps no corre ni aparece; una excepción no frena la corrida.
  const y = corrida([c], { ahora: madrugada });
  delete y.deps.marcarRescateDatos;
  assertEquals((await correrSeguimientos(y.deps)).rescate_datos, undefined);
  const z = corrida([], { ahora: madrugada });
  z.deps.candidatosRescateDatos = () => Promise.reject(new Error("sin red"));
  const rz = await correrSeguimientos(z.deps);
  assertEquals(rz.rescate_datos, { accion: "error" });
  assert(z.avisos.some((a) => a.includes("Rescate de datos: la corrida falló")));
});

// ---------- integración con el orquestador (modelo y WhatsApp simulados) ----------

const texto = (t: string): RespuestaClaude => ({
  contenido: [{ type: "text", text: t }],
  stop_reason: "end_turn",
  uso: { ...USO_CERO, entrada: 100, salida: 20 },
  costo_usd: 0.0002,
  simulado: false,
  modelo: "claude-haiku-4-5-20251001",
});

function orquestador(op: { gasto?: number; ultimos?: string[]; perfil?: PerfilCliente } = {}) {
  _limpiarCacheCatalogo();
  const h = depsPrueba();
  const turnos: FilaTurno[] = [];
  const mensajes: unknown[] = [];
  const perfiles: PerfilCliente[] = [];
  const leidos: string[] = [];
  const ultimos = [...(op.ultimos ?? [])];
  let reloj = AHORA.getTime();
  const deps: DepsOrquestador = {
    config: () => Promise.resolve(configPrueba({ vendedor: { modelo: "claude-haiku-4-5-20251001", espera_agrupar_s: 8, whatsapp_enrique: "595990000000" } })),
    conversacion: () =>
      Promise.resolve({
        id: CONV,
        estado: "ia",
        cliente_id: CLIENTE,
        turnos_ia: 2,
        perfil_vendedor: op.perfil ?? { producto: "tiras nasales", cantidad: 1, rescate_datos_en: AHORA.toISOString() },
      }),
    cliente: () => Promise.resolve({ id: CLIENTE, telefono: TEL, wa_user_id: null, nombre: "Ana Prueba" }),
    historial: () =>
      Promise.resolve([
        { direccion: "in", texto: "Quiero 1", tipo: "interactive", contenido: {}, estado: "recibido", wa_message_id: "wamid.IN1" },
        { direccion: "out", texto: "Genial! Pasame tu nombre, tu ubicación y una referencia", tipo: "text", contenido: {}, estado: "leido", wa_message_id: "wamid.OUT1" },
        { direccion: "in", texto: "Ana", tipo: "text", contenido: {}, estado: "recibido", wa_message_id: "wamid.IN2" },
        { direccion: "out", texto: "Gracias Ana! Ahora tu ubicación y una referencia", tipo: "text", contenido: {}, estado: "leido", wa_message_id: "wamid.OUT2" },
      ]),
    ultimoEntranteId: () => Promise.resolve(ultimos.length ? ultimos.shift()! : "wamid.IN2"),
    gastoMesUsd: () => Promise.resolve(op.gasto ?? 0),
    preciosPrevios: () => Promise.resolve([79000]),
    registrarTurno: (f) => (turnos.push(f), Promise.resolve()),
    sumarTurno: () => Promise.resolve(),
    guardarPerfil: (_c, p) => (perfiles.push(p), Promise.resolve()),
    aleatorio: () => 0.5,
    marcarLeidoYEscribiendo: (id) => (leidos.push(id), Promise.resolve()),
    llamarModelo: (p) => (mensajes.push(structuredClone(p.mensajes)), Promise.resolve(texto("Solo me falta tu ubicación y una referencia 🙌"))),
    dormir: (ms) => ((reloj += ms), Promise.resolve()),
    ahora: () => new Date(reloj),
    herramientas: h.deps,
  };
  return { deps, reg: h.reg, turnos, mensajes, perfiles, leidos };
}

Deno.test("integración rescate: sale por el orquestador como seguimiento, el modelo ve '[rescate datos]' al final y no toca el contador", async () => {
  const o = orquestador();
  const x = corrida([cand({ conversacion_id: CONV, cliente_id: CLIENTE })]);
  x.deps.turno = (e) => procesarTurno(e, o.deps);
  const r = await correrRescateDatos(x.deps, null);
  assertEquals(r.enviados, 1);
  assertEquals(o.reg.textos.map((t) => t.texto), ["Solo me falta tu ubicación y una referencia 🙌"]);
  assertEquals(o.leidos, [], "no marca leído ni 'escribiendo' sobre un id falso");
  assertEquals(o.turnos.length, 1);
  assertEquals(o.turnos[0].accion, "seguimiento");
  assert(o.turnos[0].mensaje_entrada_id.startsWith("rescate_datos:"));
  assert(rescateSalio(o.turnos[0].accion), "cuenta para el máximo por conversación");
  const msgs = o.mensajes[0] as Array<{ role: string; content: string }>;
  assertEquals(msgs.at(-1), { role: "user", content: "[rescate datos]" });
  // La marca se conserva y el contador de recontactos no aparece.
  assert(o.perfiles.every((p) => p.rescate_datos_en === AHORA.toISOString() && p.seguimientos === undefined));
  assertEquals(x.avisos, []);
});

Deno.test("integración rescate: si el cliente escribe mientras tanto no sale; con tope de gasto no gasta ni deriva", async () => {
  const o = orquestador({ ultimos: ["wamid.IN2", "wamid.IN3"] });
  const x = corrida([cand({ conversacion_id: CONV, cliente_id: CLIENTE })]);
  x.deps.turno = (e) => procesarTurno(e, o.deps);
  const r = await correrRescateDatos(x.deps, null);
  assertEquals(r.resultados?.[0].motivo, "cliente_escribio");
  assertEquals(o.reg.textos, []);
  assertFalse(rescateSalio(o.turnos[0].accion), "no cuenta para el máximo");

  const g = orquestador({ gasto: 999 });
  const y = corrida([cand({ conversacion_id: CONV, cliente_id: CLIENTE })]);
  y.deps.turno = (e) => procesarTurno(e, g.deps);
  const ry = await correrRescateDatos(y.deps, null);
  assertEquals(ry.resultados?.[0], { conversacion_id: CONV, accion: "omitido", motivo: "tope_gasto" });
  assertEquals(g.reg.textos, []);
  assertEquals(g.reg.humano, []);
  assertEquals(g.turnos, []);
  assertEquals(y.marcasRescate, [[CONV, AHORA.toISOString()], [CONV, null]], "sin gasto: se desmarca");
});
