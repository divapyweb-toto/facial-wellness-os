// Tests de seguimiento-chat: cuándo toca el recontacto 1, el 2 o nada; la corrida (lote, contador, avisos) y
// la integración con el orquestador del vendedor (modelo y WhatsApp simulados). Datos inventados: repo público.
import { assert, assertEquals, assertFalse } from "@std/assert";
import { type RespuestaClaude, USO_CERO } from "../_shared/claude.ts";
import { _limpiarCacheCatalogo } from "../_shared/vendedor/herramientas.ts";
import { type DepsOrquestador, type EntradaTurno, type FilaTurno, procesarTurno, type ResultadoTurno } from "../_shared/vendedor/orquestador.ts";
import type { PerfilCliente } from "../_shared/vendedor/perfil.ts";
import { CLIENTE, configPrueba, CONV, depsPrueba, TEL } from "../_shared/vendedor/prueba_utiles.ts";
import {
  type Candidato,
  CFG_SEGUIMIENTO_DEFAULT,
  correrSeguimientos,
  decidirSeguimiento,
  type DepsSeguimiento,
  leerCfgSeguimiento,
  seguimientosVigentes,
} from "./logica.ts";

const H = 3_600_000;
// 15:00 UTC = 12:00 de Asunción (UTC−3).
const AHORA = new Date("2026-10-07T15:00:00Z");
const hace = (h: number) => new Date(AHORA.getTime() - h * H).toISOString();
const CFG = CFG_SEGUIMIENTO_DEFAULT;

function cand(over: Partial<Candidato> = {}): Candidato {
  return {
    conversacion_id: "conv-1",
    cliente_id: "cli-1",
    estado: "ia",
    ultima_entrada_en: hace(3),
    perfil: {},
    ultimo_mensaje: { direccion: "out", creado_en: hace(2.9) },
    ultima_respuesta_derivada: false,
    pedido_reciente: false,
    baja_marketing: false,
    ...over,
  };
}

const motivo = (c: Candidato, ahora = AHORA, cfg = CFG) => {
  const d = decidirSeguimiento(c, cfg, ahora);
  return d.tipo === "nada" ? d.motivo : `seguimiento ${d.numero}`;
};

// ---------- config ----------

Deno.test("config: defaults, valores raros ignorados y la ventana nunca pasa de 24 h", () => {
  assertEquals(leerCfgSeguimiento(null), CFG);
  assertEquals(leerCfgSeguimiento({ horas_1: 3, activo: false, max: "x", horario_desde: -1 }), { ...CFG, horas_1: 3, activo: false });
  const c = leerCfgSeguimiento({ ventana_max_h: 30, ventana_1_h: 29 });
  assertEquals(c.ventana_max_h, 23.75);
  assertEquals(c.ventana_1_h, 23.75);
});

Deno.test("semilla seed_seguimiento.sql = defaults del código, arranca activa y no pisa lo existente", async () => {
  const sql = await Deno.readTextFile(new URL("../../seed_seguimiento.sql", import.meta.url));
  const m = /\('vendedor_seguimiento',\s*'([\s\S]*?)'::jsonb\)/.exec(sql);
  assert(m);
  assertEquals(JSON.parse(m[1]), CFG);
  assert(sql.includes("on conflict (clave) do nothing"));
  assert(/'::jsonb \|\| valor\s+where clave = 'vendedor_seguimiento'/.test(sql));
});

Deno.test("migración 0015: cron cada 10 min con invocar_edge_function y merge atómico del contador", async () => {
  const sql = await Deno.readTextFile(new URL("../../migrations/20261007000015_cron_seguimiento.sql", import.meta.url));
  assert(sql.includes("cron.schedule('wa-seguimiento-chat', '*/10 * * * *', $$select public.invocar_edge_function('seguimiento-chat')$$)"));
  assert(sql.includes("cron.unschedule('wa-seguimiento-chat')"));
  assert(sql.includes("function public.vendedor_marcar_seguimiento(p_conversacion uuid, p_seguimientos int, p_en timestamptz)"));
  assert(sql.includes("coalesce(perfil_vendedor, '{}'::jsonb)"));
});

// ---------- decisión ----------

Deno.test("recontacto 1: bot habló último hace ≥ 2 h y la entrada fue hace < 23 h", () => {
  assertEquals(motivo(cand()), "seguimiento 1");
  assertEquals(motivo(cand({ ultimo_mensaje: { direccion: "out", creado_en: hace(1.9) } })), "esperando");
  assertEquals(motivo(cand({ ultima_entrada_en: hace(22.9), ultimo_mensaje: { direccion: "out", creado_en: hace(22.8) } })), "seguimiento 1");
  assertEquals(motivo(cand({ ultima_entrada_en: hace(23.1), ultimo_mensaje: { direccion: "out", creado_en: hace(23) } })), "ventana_1_cerrada");
  assertEquals(motivo(cand({ ultima_entrada_en: hace(23.6) })), "ventana_cerrada");
});

Deno.test("exclusiones: no 'ia', sin entrada, cliente habló último, rechazo, baja, pedido, derivación", () => {
  assertEquals(motivo(cand({ estado: "humano" })), "no_esta_en_ia");
  assertEquals(motivo(cand({ ultima_entrada_en: null })), "sin_entrada_del_cliente");
  assertEquals(motivo(cand({ ultimo_mensaje: { direccion: "in", creado_en: hace(3) } })), "cliente_hablo_ultimo");
  assertEquals(motivo(cand({ ultimo_mensaje: null })), "cliente_hablo_ultimo");
  assertEquals(motivo(cand({ perfil: { rechazo: true } })), "rechazo");
  assertEquals(motivo(cand({ baja_marketing: true })), "baja_marketing");
  assertEquals(motivo(cand({ pedido_reciente: true })), "pedido_reciente");
  assertEquals(motivo(cand({ ultima_respuesta_derivada: true })), "derivado");
});

Deno.test("horario de Asunción [8, 21): fuera de horario se espera", () => {
  // 10:30 UTC = 7:30 Asunción; 00:30 UTC = 21:30 Asunción.
  const temprano = new Date("2026-10-07T10:30:00Z");
  const c = (a: Date) => cand({ ultima_entrada_en: new Date(a.getTime() - 3 * H).toISOString(), ultimo_mensaje: { direccion: "out", creado_en: new Date(a.getTime() - 2.5 * H).toISOString() } });
  assertEquals(motivo(c(temprano), temprano), "fuera_de_horario");
  const noche = new Date("2026-10-08T00:30:00Z");
  assertEquals(motivo(c(noche), noche), "fuera_de_horario");
  const ocho = new Date("2026-10-07T11:00:00Z"); // 8:00 en punto
  assertEquals(motivo(c(ocho), ocho), "seguimiento 1");
  const nueve = new Date("2026-10-08T00:00:00Z"); // 21:00 en punto: ya no
  assertEquals(motivo(c(nueve), nueve), "fuera_de_horario");
});

Deno.test("recontacto 2: ya se hizo el 1, ≥ 20 h desde la entrada, < 23,5 h y ≥ 2 h desde el 1", () => {
  const p1 = { seguimientos: 1, ultimo_seguimiento_en: hace(17) };
  const base = { perfil: p1, ultimo_mensaje: { direccion: "out" as const, creado_en: hace(17) } };
  assertEquals(motivo(cand({ ...base, ultima_entrada_en: hace(20) })), "seguimiento 2");
  assertEquals(motivo(cand({ ...base, ultima_entrada_en: hace(19.9) })), "esperando");
  assertEquals(motivo(cand({ ...base, ultima_entrada_en: hace(23.4) })), "seguimiento 2");
  assertEquals(motivo(cand({ ...base, ultima_entrada_en: hace(23.5) })), "ventana_cerrada");
  // El 1 salió tarde (hace 1 h): el 2 espera la separación mínima.
  assertEquals(
    motivo(cand({ perfil: { seguimientos: 1, ultimo_seguimiento_en: hace(1) }, ultima_entrada_en: hace(21), ultimo_mensaje: { direccion: "out", creado_en: hace(1) } })),
    "esperando",
  );
  assertEquals(
    motivo(cand({ perfil: { seguimientos: 1, ultimo_seguimiento_en: hace(2.5) }, ultima_entrada_en: hace(21), ultimo_mensaje: { direccion: "out", creado_en: hace(2.5) } })),
    "seguimiento 2",
  );
  // El cliente respondió al 1 y volvió a dejar en visto: el 2 igual espera las 20 h desde su última entrada.
  assertEquals(motivo(cand({ perfil: p1, ultima_entrada_en: hace(5), ultimo_mensaje: { direccion: "out", creado_en: hace(4.9) } })), "esperando");
});

Deno.test("contador: máximo 2 por ciclo; no se reinicia cuando el cliente escribe; vuelve a cero a los 7 días", () => {
  const dos = { seguimientos: 2, ultimo_seguimiento_en: hace(30) };
  assertEquals(motivo(cand({ perfil: dos })), "tope_seguimientos");
  assertEquals(seguimientosVigentes(dos, AHORA, CFG), 2);
  const viejo = { seguimientos: 2, ultimo_seguimiento_en: hace(24 * 7 + 1) };
  assertEquals(seguimientosVigentes(viejo, AHORA, CFG), 0);
  assertEquals(motivo(cand({ perfil: viejo })), "seguimiento 1");
  assertEquals(motivo(cand({ perfil: { seguimientos: 1, ultimo_seguimiento_en: hace(24 * 8) } })), "seguimiento 1");
  assertEquals(
    motivo(cand({ perfil: dos, ultima_entrada_en: hace(21), ultimo_mensaje: { direccion: "out", creado_en: hace(20) } }), AHORA, { ...CFG, max: 3 }),
    "seguimiento 3",
  );
});

// ---------- corrida ----------

function corrida(cands: Candidato[], op: {
  cfg?: unknown;
  tope?: boolean;
  turno?: (e: EntradaTurno) => ResultadoTurno | Promise<ResultadoTurno>;
  marcarFalla?: boolean;
} = {}) {
  const marcas: Array<{ id: string; n: number; en: string | null }> = [];
  const entradas: EntradaTurno[] = [];
  const avisos: string[] = [];
  const deps: DepsSeguimiento = {
    config: () => Promise.resolve(op.cfg ?? null),
    topeGastoSuperado: () => Promise.resolve(!!op.tope),
    candidatos: () => Promise.resolve(cands),
    marcar: (id, n, en) => {
      if (op.marcarFalla) return Promise.reject(new Error("sin rpc"));
      marcas.push({ id, n, en });
      return Promise.resolve();
    },
    turno: async (e) => {
      entradas.push(e);
      return await (op.turno?.(e) ?? { accion: "respondido", respuesta: "ok", costo_usd: 0.001 });
    },
    avisar: (t) => (avisos.push(t), Promise.resolve()),
    ahora: () => AHORA,
    paralelo: 3,
  };
  return { deps, marcas, entradas, avisos };
}

Deno.test("corrida: inactiva, fuera de horario o con tope de gasto no hace nada", async () => {
  const a = corrida([cand()], { cfg: { activo: false } });
  assertEquals((await correrSeguimientos(a.deps)).accion, "inactivo");
  const b = corrida([cand()], { tope: true });
  assertEquals((await correrSeguimientos(b.deps)).accion, "tope_gasto");
  assertEquals(b.entradas.length, 0);
  const c = corrida([cand()], { cfg: { horario_desde: 13 } });
  assertEquals((await correrSeguimientos(c.deps)).accion, "fuera_de_horario");
  assertEquals(c.avisos, []);
});

Deno.test("corrida: marca el contador ANTES del turno, entrada '[seguimiento N]' con origen seguimiento, sin avisos", async () => {
  const c2 = cand({
    conversacion_id: "conv-2",
    perfil: { seguimientos: 1, ultimo_seguimiento_en: hace(17) },
    ultima_entrada_en: hace(21),
    ultimo_mensaje: { direccion: "out", creado_en: hace(17) },
  });
  const orden: string[] = [];
  const x = corrida([cand(), c2, cand({ conversacion_id: "conv-3", perfil: { rechazo: true } })], {
    turno: (e) => {
      orden.push(`turno:${e.conversacion_id}`);
      return { accion: "respondido", costo_usd: 0.001 };
    },
  });
  const marcarOriginal = x.deps.marcar;
  x.deps.marcar = (id, n, en) => (orden.push(`marca:${id}`), marcarOriginal(id, n, en));
  const r = await correrSeguimientos(x.deps);
  assertEquals(r.accion, "corrido");
  assertEquals([r.candidatos, r.elegibles, r.enviados, r.fallas], [3, 2, 2, 0]);
  assertEquals(r.motivos, { rechazo: 1 });
  assert(orden.indexOf("marca:conv-1") < orden.indexOf("turno:conv-1"));
  const e1 = x.entradas.find((e) => e.conversacion_id === "conv-1")!;
  assertEquals(e1.texto, "[seguimiento 1]");
  assertEquals(e1.origen, "seguimiento");
  assert(e1.wa_message_id.startsWith("seguimiento:1:conv-1:"));
  assertEquals(x.entradas.find((e) => e.conversacion_id === "conv-2")!.texto, "[seguimiento 2]");
  assertEquals(x.marcas.map((m) => [m.id, m.n, m.en]), [["conv-1", 1, AHORA.toISOString()], ["conv-2", 2, AHORA.toISOString()]]);
  assertEquals(x.avisos, []);
});

Deno.test("corrida: máximo lote_max (20) por corrida", async () => {
  const cands = Array.from({ length: 25 }, (_, i) => cand({ conversacion_id: `c${i}` }));
  const x = corrida(cands);
  const r = await correrSeguimientos(x.deps);
  assertEquals(x.entradas.length, 20);
  assertEquals(r.motivos?.lote_lleno, 5);
  // Las primeras (las más cerca de cerrar la ventana) primero.
  assertEquals(x.entradas.map((e) => e.conversacion_id).sort(), cands.slice(0, 20).map((c) => c.conversacion_id).sort());
});

Deno.test("corrida: omitido sin gasto (cliente escribió, tope) devuelve el contador; con gasto no", async () => {
  const x = corrida([cand({ perfil: { seguimientos: 2, ultimo_seguimiento_en: hace(24 * 8) } })], {
    turno: () => ({ accion: "omitido", motivo: "cliente_escribio", costo_usd: 0 }),
  });
  const r = await correrSeguimientos(x.deps);
  assertEquals(r.omitidos, 1);
  assertEquals(x.marcas.map((m) => [m.n, m.en]), [[1, AHORA.toISOString()], [2, hace(24 * 8)]]);
  assertEquals(x.avisos, []);
  const y = corrida([cand()], { turno: () => ({ accion: "omitido", motivo: "cliente_escribio", costo_usd: 0.002 }) });
  await correrSeguimientos(y.deps);
  assertEquals(y.marcas.length, 1);
});

Deno.test("corrida: fallas (envío, IA, filtro, excepción, marca) → UN solo aviso a Telegram", async () => {
  const cands = ["a", "b", "c", "d"].map((id) => cand({ conversacion_id: id }));
  const x = corrida(cands, {
    turno: (e) => {
      if (e.conversacion_id === "a") return { accion: "error_envio", motivo: "131047 <ventana>" };
      if (e.conversacion_id === "b") return { accion: "omitido", motivo: "sin_derivar:falla_ia", costo_usd: 0 };
      if (e.conversacion_id === "c") throw new Error("boom");
      return { accion: "respondido", costo_usd: 0.001 };
    },
  });
  const r = await correrSeguimientos(x.deps);
  assertEquals([r.enviados, r.fallas], [1, 3]);
  assertEquals(x.avisos.length, 1);
  assert(x.avisos[0].includes("3 con problemas"));
  assert(x.avisos[0].includes("&lt;ventana&gt;"), "escapa el HTML");
  // La falla de la IA no devuelve el contador (no se reintenta cada 10 min).
  assertEquals(x.marcas.filter((m) => m.id === "b").length, 1);

  const z = corrida([cand()], { marcarFalla: true });
  const rz = await correrSeguimientos(z.deps);
  assertEquals(z.entradas.length, 0, "sin marca no se manda");
  assertEquals(rz.fallas, 1);
  assertEquals(z.avisos.length, 1);
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

function orquestador(op: { gasto?: number; ultimos?: string[]; respuesta?: () => RespuestaClaude; perfil?: PerfilCliente } = {}) {
  _limpiarCacheCatalogo();
  const h = depsPrueba();
  const turnos: FilaTurno[] = [];
  const leidos: string[] = [];
  const mensajes: unknown[] = [];
  const perfiles: PerfilCliente[] = [];
  const ultimos = [...(op.ultimos ?? [])];
  let reloj = AHORA.getTime();
  const deps: DepsOrquestador = {
    config: () => Promise.resolve(configPrueba({ vendedor: { modelo: "claude-haiku-4-5-20251001", espera_agrupar_s: 8, whatsapp_enrique: "595990000000" } })),
    conversacion: () => Promise.resolve({ id: CONV, estado: "ia", cliente_id: CLIENTE, turnos_ia: 0, perfil_vendedor: op.perfil ?? { seguimientos: 1, producto: "tiras nasales" } }),
    cliente: () => Promise.resolve({ id: CLIENTE, telefono: TEL, wa_user_id: null, nombre: "Ana Prueba" }),
    historial: () =>
      Promise.resolve([
        { direccion: "in", texto: "cuánto salen las tiras?", tipo: "text", contenido: {}, estado: "recibido", wa_message_id: "wamid.IN1" },
        { direccion: "out", texto: "Salen Gs 79.000 + envío. ¿Te las preparo?", tipo: "text", contenido: {}, estado: "leido", wa_message_id: "wamid.OUT1" },
      ]),
    ultimoEntranteId: () => Promise.resolve(ultimos.length ? ultimos.shift()! : "wamid.IN1"),
    gastoMesUsd: () => Promise.resolve(op.gasto ?? 0),
    preciosPrevios: () => Promise.resolve([79000]),
    registrarTurno: (f) => (turnos.push(f), Promise.resolve()),
    sumarTurno: () => Promise.resolve(),
    guardarPerfil: (_c, p) => (perfiles.push(p), Promise.resolve()),
    aleatorio: () => 0.5,
    marcarLeidoYEscribiendo: (id) => (leidos.push(id), Promise.resolve()),
    llamarModelo: (p) => (mensajes.push(structuredClone(p.mensajes)), Promise.resolve(op.respuesta?.() ?? texto("¿Pudiste ver lo de las tiras? Si querés te las preparo hoy."))),
    dormir: (ms) => ((reloj += ms), Promise.resolve()),
    ahora: () => new Date(reloj),
    herramientas: h.deps,
  };
  return { deps, reg: h.reg, turnos, leidos, mensajes, perfiles };
}

function corridaConOrquestador(o: ReturnType<typeof orquestador>) {
  const x = corrida([cand({ conversacion_id: CONV, cliente_id: CLIENTE })]);
  x.deps.turno = (e) => procesarTurno(e, o.deps);
  return x;
}

Deno.test("integración: el seguimiento sale por el orquestador sin marcar leído ni esperar, y queda como 'seguimiento'", async () => {
  const o = orquestador();
  const x = corridaConOrquestador(o);
  const r = await correrSeguimientos(x.deps);
  assertEquals(r.enviados, 1);
  assertEquals(o.reg.textos.map((t) => t.texto), ["¿Pudiste ver lo de las tiras? Si querés te las preparo hoy."]);
  assertEquals(o.leidos, [], "no marca leído ni 'escribiendo' sobre un id falso");
  assertEquals(o.turnos.length, 1);
  assertEquals(o.turnos[0].accion, "seguimiento");
  assert(o.turnos[0].mensaje_entrada_id.startsWith("seguimiento:1:"));
  assertEquals(o.turnos[0].costo_usd, 0.0002);
  // El modelo ve la conversación y, al final, la nota "[seguimiento 1]".
  const msgs = o.mensajes[0] as Array<{ role: string; content: string }>;
  assertEquals(msgs.at(-1), { role: "user", content: "[seguimiento 1]" });
  assertEquals(msgs.at(-2)?.role, "assistant");
  // El perfil (con el contador) no se pisa.
  assert(o.perfiles.every((p) => p.seguimientos === 1));
  assertEquals(x.avisos, []);
});

Deno.test("integración: si el cliente escribe mientras tanto, el seguimiento no sale y el contador vuelve", async () => {
  const o = orquestador({ ultimos: ["wamid.IN1", "wamid.IN2"] });
  const x = corridaConOrquestador(o);
  const r = await correrSeguimientos(x.deps);
  assertEquals(r.resultados?.[0].motivo, "cliente_escribio");
  assertEquals(o.reg.textos, []);
  assertEquals(o.turnos[0].accion, "seguimiento_omitido:cliente_escribio");
  // Se gastó el modelo: el contador queda (no se reintenta en loop).
  assertEquals(x.marcas.length, 1);
});

Deno.test("integración: tope de gasto → no manda nada, no deriva y no registra", async () => {
  const o = orquestador({ gasto: 999 });
  const x = corridaConOrquestador(o);
  const r = await correrSeguimientos(x.deps);
  assertEquals(r.resultados?.[0], { conversacion_id: CONV, numero: 1, accion: "omitido", motivo: "tope_gasto" });
  assertEquals(o.reg.textos, []);
  assertEquals(o.reg.interactivos, []);
  assertEquals(o.reg.humano, []);
  assertEquals(o.turnos, []);
  assertEquals(x.marcas.length, 2, "sin gasto: el contador se devuelve");
});

Deno.test("integración: la IA falla → no deriva ni le escribe al cliente; un aviso de la corrida", async () => {
  const o = orquestador({ respuesta: () => texto("Tiene garantía de 30 días.") });
  const x = corridaConOrquestador(o);
  const r = await correrSeguimientos(x.deps);
  assertEquals(r.fallas, 1);
  assertEquals(o.reg.textos, []);
  assertEquals(o.reg.humano, []);
  assertFalse(o.turnos[0].derivado);
  assertEquals(o.turnos[0].accion, "seguimiento_omitido:sin_derivar:filtro");
  assertEquals(x.avisos.length, 1);
});
