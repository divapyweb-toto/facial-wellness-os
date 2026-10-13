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
  CFG_AVISO_INTENCION_DEFAULT,
  CFG_SEGUIMIENTO_DEFAULT,
  correrAvisosIntencion,
  correrRecontactosCobro,
  decidirAvisoIntencion,
  decidirRecontactoCobro,
  leerCfgAvisoIntencion,
  tieneSenalCompra,
  correrSeguimientos,
  decidirSeguimiento,
  type DepsSeguimiento,
  franjasHorario,
  leerCfgSeguimiento,
  momentoRecontacto2,
  seguimientosVigentes,
} from "./logica.ts";
import { CFG_TOQUE3_DEFAULT, leerCfgToque3 } from "./toque3.ts";
import { instanteLocal } from "../recompra/calendario.ts";

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

Deno.test("semilla seed_seguimiento.sql = defaults del código (con toque3), arranca activa y no pisa lo existente", async () => {
  const sql = await Deno.readTextFile(new URL("../../seed_seguimiento.sql", import.meta.url));
  const m = /\('vendedor_seguimiento',\s*'([\s\S]*?)'::jsonb\)/.exec(sql);
  assert(m);
  const semilla = JSON.parse(m[1]);
  assertEquals(semilla, { ...CFG, toque3: CFG_TOQUE3_DEFAULT });
  assertEquals(leerCfgSeguimiento(semilla), CFG);
  assertEquals(leerCfgToque3(semilla), CFG_TOQUE3_DEFAULT);
  // El update (bases donde la clave ya existía) suma exactamente lo mismo.
  const u = /set valor = '([\s\S]*?)'::jsonb \|\| valor/.exec(sql);
  assert(u);
  assertEquals(JSON.parse(u[1]), semilla);
  assert(sql.includes("on conflict (clave) do nothing"));
  assert(/'::jsonb \|\| valor\s+where clave = 'vendedor_seguimiento'/.test(sql));
  // 12-10: el toque 3 arranca apagado y con opt-in obligatorio; el cambio de valores para la base viva queda anotado.
  assertEquals([semilla.toque3.activo, semilla.toque3.requiere_consentimiento], [false, true]);
  assert(sql.includes(`valor || '{"horas_1": 1.5, "horario_desde": 12}'::jsonb`));
});

Deno.test("defaults 12-10: recontacto 1 a la 1,5 h, franja 12 a 21, adelanto del 2 desde las 8 h con 0,5 h de margen", () => {
  assertEquals([CFG.horas_1, CFG.horas_2, CFG.horario_desde, CFG.horario_hasta, CFG.ventana_max_h], [1.5, 20, 12, 21, 23.5]);
  assertEquals([CFG.horas_2_min, CFG.margen_2_h, CFG.separacion_min_h], [8, 0.5, 2]);
});

Deno.test("migración 0015: cron cada 10 min con invocar_edge_function y merge atómico del contador", async () => {
  const sql = await Deno.readTextFile(new URL("../../migrations/20261007000015_cron_seguimiento.sql", import.meta.url));
  assert(sql.includes("cron.schedule('wa-seguimiento-chat', '*/10 * * * *', $$select public.invocar_edge_function('seguimiento-chat')$$)"));
  assert(sql.includes("cron.unschedule('wa-seguimiento-chat')"));
  assert(sql.includes("function public.vendedor_marcar_seguimiento(p_conversacion uuid, p_seguimientos int, p_en timestamptz)"));
  assert(sql.includes("coalesce(perfil_vendedor, '{}'::jsonb)"));
});

// ---------- decisión ----------

Deno.test("recontacto 1: bot habló último hace ≥ 1,5 h (12-10) y la entrada fue hace < 23 h", () => {
  assertEquals(motivo(cand()), "seguimiento 1");
  assertEquals(motivo(cand({ ultima_entrada_en: hace(1.6), ultimo_mensaje: { direccion: "out", creado_en: hace(1.5) } })), "seguimiento 1");
  assertEquals(motivo(cand({ ultimo_mensaje: { direccion: "out", creado_en: hace(1.4) } })), "esperando");
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

Deno.test("horario de Asunción [12, 21) (12-10; antes 8): fuera de horario se espera", () => {
  // 10:30 UTC = 7:30 Asunción; 14:59 UTC = 11:59; 00:30 UTC = 21:30 Asunción.
  const temprano = new Date("2026-10-07T10:30:00Z");
  const c = (a: Date) => cand({ ultima_entrada_en: new Date(a.getTime() - 3 * H).toISOString(), ultimo_mensaje: { direccion: "out", creado_en: new Date(a.getTime() - 2.5 * H).toISOString() } });
  assertEquals(motivo(c(temprano), temprano), "fuera_de_horario");
  const ocho = new Date("2026-10-07T11:00:00Z"); // 8:00: antes salía, ahora espera
  assertEquals(motivo(c(ocho), ocho), "fuera_de_horario");
  const casi = new Date("2026-10-07T14:59:00Z"); // 11:59
  assertEquals(motivo(c(casi), casi), "fuera_de_horario");
  const doce = new Date("2026-10-07T15:00:00Z"); // 12:00 en punto
  assertEquals(motivo(c(doce), doce), "seguimiento 1");
  const noche = new Date("2026-10-08T00:30:00Z");
  assertEquals(motivo(c(noche), noche), "fuera_de_horario");
  const nueve = new Date("2026-10-08T00:00:00Z"); // 21:00 en punto: ya no
  assertEquals(motivo(c(nueve), nueve), "fuera_de_horario");
});

Deno.test("recontacto 1 que vence fuera de horario (cliente a las 9:00 → 10:30) espera a las 12:00", () => {
  const entrada = instanteLocal("2026-10-07", 9);
  const c = cand({ ultima_entrada_en: entrada.toISOString(), ultimo_mensaje: { direccion: "out", creado_en: new Date(entrada.getTime() + 60_000).toISOString() } });
  assertEquals(motivo(c, instanteLocal("2026-10-07", 11)), "fuera_de_horario");
  assertEquals(motivo(c, instanteLocal("2026-10-07", 12)), "seguimiento 1");
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

// ---------- recontacto 2: franja 12-21 y adelanto para no perder la ventana (12-10) ----------

const L = (dia: string, h: number, min = 0) => instanteLocal(dia, h).getTime() + min * 60_000;
const D0 = "2026-10-07", D1 = "2026-10-08";
const iso = (ms: number | null) => (ms == null ? null : new Date(ms).toISOString());

Deno.test("franjas: tramos [12, 21) de Asunción recortados al rango", () => {
  const f = (a: number, b: number) => franjasHorario(a, b, CFG).map(([s, e]) => [iso(s), iso(e)]);
  assertEquals(f(L(D0, 3), L(D1, 2, 30)), [[iso(L(D0, 12)), iso(L(D0, 21))]]);
  assertEquals(f(L(D0, 20, 30), L(D1, 12, 25)), [[iso(L(D0, 20, 30)), iso(L(D0, 21))], [iso(L(D1, 12)), iso(L(D1, 12, 25))]]);
  assertEquals(f(L(D0, 21), L(D1, 12)), []);
});

Deno.test("recontacto 2 normal: a las 20 h de la entrada (o a las 12:00 si cae fuera de horario) si queda margen", () => {
  // Escribió 16:00 → 12:00 del día siguiente (20 h).
  assertEquals(iso(momentoRecontacto2(L(D0, 16), L(D0, 17, 30), CFG)), iso(L(D1, 12)));
  // Escribió 22:30 (el 1 esperó a las 12:00) → 18:30 del día siguiente.
  assertEquals(iso(momentoRecontacto2(L(D0, 22, 30), L(D1, 12), CFG)), iso(L(D1, 18, 30)));
  // Escribió 14:00 → las 20 h caen a las 10:00 (fuera de horario): sale a las 12:00 (la ventana cierra 13:30).
  assertEquals(iso(momentoRecontacto2(L(D0, 14), L(D0, 15, 30), CFG)), iso(L(D1, 12)));
});

Deno.test("recontacto 2 adelantado: escribió a las 3:00 (20 h = 23:00, fuera de horario) → 20:30 del mismo día", () => {
  assertEquals(iso(momentoRecontacto2(L(D0, 3), L(D0, 12), CFG)), iso(L(D0, 20, 30)));
  // Escribió 0:45 → las 20 h caen a las 20:45 (quedan 15 min de franja): se adelanta a 20:30.
  assertEquals(iso(momentoRecontacto2(L(D0, 0, 45), L(D0, 12), CFG)), iso(L(D0, 20, 30)));
  // Escribió 12:40 → nunca antes de las 8 h (20:40); ningún tramo llega a 30 min: el más largo (20:40-21:00 > 12:00-12:10).
  assertEquals(iso(momentoRecontacto2(L(D0, 12, 40), L(D0, 14, 10), CFG)), iso(L(D0, 20, 40)));
  // Escribió 12:55 → 20:55-21:00 (5 min) contra 12:00-12:25 del día siguiente (25 min): el más largo.
  assertEquals(iso(momentoRecontacto2(L(D0, 12, 55), L(D0, 14, 25), CFG)), iso(L(D1, 12)));
});

Deno.test("recontacto 2: nunca a menos de 2 h del 1; si no hay ningún momento válido, se saltea", () => {
  // El 1 salió tarde (18:45): el 2 no puede antes de 20:45; queda 20:45-21:00.
  assertEquals(iso(momentoRecontacto2(L(D0, 3), L(D0, 18, 45), CFG)), iso(L(D0, 20, 45)));
  // El 1 salió 19:05: el 2 tendría que ser ≥ 21:05 y la ventana cierra 2:30 → no hay momento.
  assertEquals(momentoRecontacto2(L(D0, 3), L(D0, 19, 5), CFG), null);
  const c = cand({
    perfil: { seguimientos: 1, ultimo_seguimiento_en: new Date(L(D0, 19, 5)).toISOString() },
    ultima_entrada_en: new Date(L(D0, 3)).toISOString(),
    ultimo_mensaje: { direccion: "out", creado_en: new Date(L(D0, 19, 5)).toISOString() },
  });
  assertEquals(motivo(c, new Date(L(D0, 20, 50))), "sin_momento_valido");
});

Deno.test("decisión del 2 adelantado: escribió 3:00 → espera hasta 20:30, sale de 20:30 a 21:00 y después se pierde", () => {
  const c = cand({
    perfil: { seguimientos: 1, ultimo_seguimiento_en: new Date(L(D0, 12)).toISOString() },
    ultima_entrada_en: new Date(L(D0, 3)).toISOString(),
    ultimo_mensaje: { direccion: "out", creado_en: new Date(L(D0, 12)).toISOString() },
  });
  assertEquals(motivo(c, new Date(L(D0, 20, 20))), "esperando");
  assertEquals(motivo(c, new Date(L(D0, 20, 30))), "seguimiento 2");
  assertEquals(motivo(c, new Date(L(D0, 20, 50))), "seguimiento 2");
  assertEquals(motivo(c, new Date(L(D0, 21))), "fuera_de_horario");
  assertEquals(motivo(c, new Date(L(D1, 12))), "ventana_cerrada");
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

// ---------- aviso de intención de compra (08-10) ----------

const MINUTO = 60_000;
const haceMin = (m: number, base = AHORA) => new Date(base.getTime() - m * MINUTO).toISOString();
const CFG_AV = CFG_AVISO_INTENCION_DEFAULT;

function listo(over: Partial<Candidato> = {}): Candidato {
  return cand({
    conversacion_id: "conv-int",
    nombre: "Ana Prueba",
    telefono: "+595981000000",
    ultima_entrada_en: haceMin(40),
    ultimo_mensaje: { direccion: "out", creado_en: haceMin(39) },
    perfil: { producto: "tiras nasales", cantidad: 3 },
    entradas_recientes: [{ texto: "3 unidades", creado_en: haceMin(40) }, { texto: "hola cuanto sale", creado_en: haceMin(50) }],
    ultimo_pedido_en: null,
    ...over,
  });
}
const motivoAv = (c: Candidato, ahora = AHORA) => {
  const d = decidirAvisoIntencion(c, CFG_AV, ahora);
  return d.tipo === "nada" ? d.motivo : "avisar";
};

Deno.test("señal de compra: frases reales del 07-10 sí; preguntas y negativas no", () => {
  for (const t of ["3 unidades", "voy a querer una tira", "te mando todo enseguida", "Dale!", "mandame 2", "te paso los datos",
    "katu", "quiero el de 2", "la de dos", "x2 por favor", "Quiero comprar", "me llevo una caja"]) assert(tieneSenalCompra(t), t);
  for (const t of ["hola", "cuánto sale?", "quiero saber el precio", "no quiero gracias", "todavía no", "", "de donde son"]) {
    assertFalse(tieneSenalCompra(t), t);
  }
});

Deno.test("config del aviso: default 15 min, se lee de vendedor_seguimiento, 0 apaga", () => {
  assertEquals(leerCfgAvisoIntencion(null).aviso_intencion_min, 15);
  assertEquals(leerCfgAvisoIntencion({ aviso_intencion_min: 45, activo: false }).aviso_intencion_min, 45);
  assertEquals(leerCfgAvisoIntencion({ aviso_intencion_min: "x" }).aviso_intencion_min, 15);
  assertEquals(leerCfgAvisoIntencion({ aviso_intencion_min: 0 }).aviso_intencion_min, 0);
  // Las claves nuevas no cambian la config de los recontactos (la semilla sigue igual a los defaults).
  assertEquals(leerCfgSeguimiento({ aviso_intencion_min: 45 }), CFG);
});

Deno.test("decisión del aviso: ≥ 15 min, producto/cantidad + señal, sin pedido posterior, no repite en 24 h", () => {
  assertEquals(motivoAv(listo()), "avisar");
  assertEquals(motivoAv(listo({ ultima_entrada_en: haceMin(14) })), "esperando");
  assertEquals(motivoAv(listo({ ultima_entrada_en: haceMin(24 * 60) })), "ventana_cerrada");
  assertEquals(motivoAv(listo({ estado: "humano" })), "no_esta_en_ia");
  assertEquals(motivoAv(listo({ perfil: { producto: "tiras", rechazo: true } })), "rechazo");
  assertEquals(motivoAv(listo({ ultima_respuesta_derivada: true })), "derivado");
  assertEquals(motivoAv(listo({ perfil: {} })), "sin_producto_ni_cantidad");
  assertEquals(motivoAv(listo({ perfil: { cantidad: 2 } })), "avisar");
  assertEquals(motivoAv(listo({ entradas_recientes: [{ texto: "cuanto sale?", creado_en: haceMin(40) }] })), "sin_senal_de_compra");
  // Habló último el cliente o el bot: da igual (lo que cuenta son los minutos sin mensaje del cliente).
  assertEquals(motivoAv(listo({ ultimo_mensaje: { direccion: "in", creado_en: haceMin(40) } })), "avisar");
  // Pedido después de la señal = ya compró; pedido viejo (de antes) no bloquea.
  assertEquals(motivoAv(listo({ ultimo_pedido_en: haceMin(35) })), "ya_hizo_pedido");
  assertEquals(motivoAv(listo({ ultimo_pedido_en: haceMin(60 * 24 * 3) })), "avisar");
  // Ya avisado hace < 24 h: no; hace más: sí.
  assertEquals(motivoAv(listo({ perfil: { producto: "tiras", cantidad: 3, aviso_intencion_en: haceMin(60 * 5) } })), "ya_avisado");
  assertEquals(motivoAv(listo({ perfil: { producto: "tiras", cantidad: 3, aviso_intencion_en: haceMin(60 * 25) } })), "avisar");
});

function corridaAviso(cands: Candidato[], op: { ahora?: Date; cfg?: unknown; telegramFalla?: boolean } = {}) {
  const avisos: Array<{ texto: string; botones?: unknown }> = [];
  const marcas: Array<[string, string | null]> = [];
  const rangos: Array<[string, string]> = [];
  const ahora = op.ahora ?? AHORA;
  const deps: DepsSeguimiento = {
    config: () => Promise.resolve(op.cfg ?? null),
    topeGastoSuperado: () => Promise.resolve(false),
    candidatos: (d, h) => (rangos.push([d, h]), Promise.resolve(cands)),
    marcar: () => Promise.resolve(),
    turno: () => Promise.resolve({ accion: "respondido", costo_usd: 0 }),
    avisar: (texto, botones) => {
      avisos.push({ texto, botones });
      return Promise.resolve(op.telegramFalla ? { ok: false, error: "x" } : { ok: true });
    },
    marcarAvisoIntencion: (id, en) => (marcas.push([id, en]), Promise.resolve()),
    ahora: () => ahora,
  };
  return { deps, avisos, marcas, rangos };
}

Deno.test("aviso: UN Telegram con el texto pedido, botón wa.me (sin pedido no hay 'Le escribo yo') y marca aviso_intencion_en", async () => {
  const x = corridaAviso([listo(), listo({ conversacion_id: "conv-no", perfil: {} })]);
  const r = await correrAvisosIntencion(x.deps, null);
  assertEquals([r.accion, r.avisados, r.fallas], ["corrido", 1, 0]);
  assertEquals(r.motivos, { sin_producto_ni_cantidad: 1 });
  assertEquals(x.avisos.length, 1);
  assert(x.avisos[0].texto.startsWith("🛒 <b>Ana Prueba</b> quiere comprar (tiras nasales x3) pero no mandó los datos hace 40 min."));
  assert(x.avisos[0].texto.includes("+595981000000"));
  assertEquals(x.avisos[0].botones, [[{ texto: "Escribirle a Ana Prueba", url: "https://wa.me/595981000000" }]]);
  assertEquals(x.marcas, [["conv-int", AHORA.toISOString()]]);
  // Rango: última entrada entre hace 23,5 h y hace 15 min.
  assertEquals(x.rangos[0], [haceMin(23.5 * 60), haceMin(15)]);
});

Deno.test("aviso: de 0 a 7 de Asunción no sale; a las 7 salen juntos en un solo mensaje", async () => {
  const noche = new Date("2026-10-07T08:30:00Z"); // 5:30 Asunción
  const n = corridaAviso([listo()], { ahora: noche });
  assertEquals((await correrAvisosIntencion(n.deps, null)).accion, "de_noche");
  assertEquals(n.avisos.length, 0);
  const siete = new Date("2026-10-07T10:00:00Z"); // 7:00 Asunción
  const c = (id: string, min: number) =>
    listo({ conversacion_id: id, nombre: `Cliente ${id}`, ultima_entrada_en: haceMin(min, siete), entradas_recientes: [{ texto: "dale", creado_en: haceMin(min, siete) }] });
  const s = corridaAviso([c("a", 300), c("b", 120)], { ahora: siete });
  const r = await correrAvisosIntencion(s.deps, null);
  assertEquals(r.avisados, 2);
  assertEquals(s.avisos.length, 1);
  assert(s.avisos[0].texto.includes("Cliente a") && s.avisos[0].texto.includes("Cliente b"));
  assertEquals((s.avisos[0].botones as unknown[]).length, 2);
});

Deno.test("aviso: Telegram falla → se desmarca (sale en la próxima corrida); apagado con 0; escapa HTML; sin teléfono sin botón", async () => {
  const f = corridaAviso([listo({ perfil: { producto: "tiras", cantidad: 1, aviso_intencion_en: haceMin(60 * 30) } })], { telegramFalla: true });
  const r = await correrAvisosIntencion(f.deps, null);
  assertEquals([r.avisados, r.fallas], [0, 1]);
  assertEquals(f.marcas, [["conv-int", AHORA.toISOString()], ["conv-int", haceMin(60 * 30)]]);

  const off = corridaAviso([listo()], { cfg: { aviso_intencion_min: 0 } });
  assertEquals((await correrAvisosIntencion(off.deps, { aviso_intencion_min: 0 })).accion, "inactivo");

  const h = corridaAviso([listo({ nombre: "<b>Juan</b>", telefono: null, perfil: { producto: "a&b" } })]);
  await correrAvisosIntencion(h.deps, null);
  assert(h.avisos[0].texto.includes("&lt;b&gt;Juan&lt;/b&gt;"));
  assert(h.avisos[0].texto.includes("(a&amp;b)"));
  assert(h.avisos[0].texto.includes("bandeja de Voltra OS"));
  assertEquals(h.avisos[0].botones, undefined);
});

Deno.test("correrSeguimientos: el aviso corre aunque los recontactos estén fuera de horario o inactivos, y va en el resumen", async () => {
  const x = corridaAviso([listo()], { cfg: { activo: false } });
  const r = await correrSeguimientos(x.deps);
  assertEquals(r.accion, "inactivo");
  assertEquals(r.avisos_intencion?.avisados, 1);
  // Sin marcarAvisoIntencion (deps viejas) no corre ni aparece.
  const y = corrida([listo()]);
  const ry = await correrSeguimientos(y.deps);
  assertEquals(ry.avisos_intencion, undefined);
});

// ---------- recontacto el día que cobra (08-10) ----------

// AHORA = 12:00 del 07-10 en Asunción.
function cobra(over: Partial<Candidato> = {}): Candidato {
  return cand({
    conversacion_id: "conv-cobro",
    nombre: "Ana Prueba",
    telefono: "+595981000000",
    ultima_entrada_en: hace(5),
    perfil: { producto: "tiras nasales", cantidad: 2, recontactar_el: "2026-10-07" },
    ...over,
  });
}
const motivoCobro = (c: Candidato, ahora = AHORA, cfg = CFG) => {
  const d = decidirRecontactoCobro(c, cfg, ahora);
  return d.tipo === "nada" ? d.motivo : d.tipo;
};

Deno.test("decisión cobro: dentro de la ventana escribe el bot; fuera, aviso a Enrique", () => {
  assertEquals(motivoCobro(cobra()), "turno");
  assertEquals(motivoCobro(cobra({ ultima_entrada_en: hace(23.4) })), "turno");
  assertEquals(motivoCobro(cobra({ ultima_entrada_en: hace(23.5) })), "avisar");
  assertEquals(motivoCobro(cobra({ ultima_entrada_en: hace(24 * 4) })), "avisar");
  assertEquals(motivoCobro(cobra({ ultima_entrada_en: null })), "avisar");
  // Fecha pasada sin recontactar (el cron no corrió): igual sale.
  assertEquals(motivoCobro(cobra({ perfil: { recontactar_el: "2026-10-05" } })), "turno");
});

Deno.test("decisión cobro: exclusiones y fecha (todavía no, ya recontactado, sin fecha)", () => {
  assertEquals(motivoCobro(cobra({ estado: "humano" })), "no_esta_en_ia");
  assertEquals(motivoCobro(cobra({ perfil: { recontactar_el: "2026-10-07", rechazo: true } })), "rechazo");
  assertEquals(motivoCobro(cobra({ baja_marketing: true })), "baja_marketing");
  assertEquals(motivoCobro(cobra({ pedido_reciente: true })), "pedido_reciente");
  assertEquals(motivoCobro(cobra({ perfil: { recontactar_el: "2026-10-08" } })), "todavia_no");
  assertEquals(motivoCobro(cobra({ perfil: { recontactar_el: "2026-10-07", recontacto_cobro_en: hace(1) } })), "ya_recontactado");
  assertEquals(motivoCobro(cobra({ perfil: {} })), "sin_fecha");
});

Deno.test("decisión cobro: fuera de horario de Asunción no hace nada; el día es el de Asunción, no UTC", () => {
  const temprano = new Date("2026-10-07T10:30:00Z"); // 7:30 Asunción
  assertEquals(motivoCobro(cobra({ ultima_entrada_en: new Date(temprano.getTime() - 5 * H).toISOString() }), temprano), "fuera_de_horario");
  // 23:30 UTC del 07 = 20:30 del 07 en Asunción (en UTC ya sería 08 por poco; acá sigue siendo el 07).
  const tarde = new Date("2026-10-07T23:30:00Z");
  assertEquals(motivoCobro(cobra({ perfil: { recontactar_el: "2026-10-08" } }), tarde), "todavia_no");
});

function corridaCobro(cands: Candidato[], op: {
  cfg?: unknown;
  tope?: boolean;
  ahora?: Date;
  turno?: (e: EntradaTurno) => ResultadoTurno | Promise<ResultadoTurno>;
  telegramFalla?: boolean;
} = {}) {
  const marcas: Array<[string, string | null]> = [];
  const entradas: EntradaTurno[] = [];
  const avisos: Array<{ texto: string; botones?: unknown }> = [];
  const hoys: string[] = [];
  const orden: string[] = [];
  const ahora = op.ahora ?? AHORA;
  const deps: DepsSeguimiento = {
    config: () => Promise.resolve(op.cfg ?? null),
    topeGastoSuperado: () => Promise.resolve(!!op.tope),
    candidatos: () => Promise.resolve([]),
    marcar: () => Promise.resolve(),
    turno: async (e) => {
      orden.push(`turno:${e.conversacion_id}`);
      entradas.push(e);
      return await (op.turno?.(e) ?? { accion: "respondido", respuesta: "ok", costo_usd: 0.001 });
    },
    avisar: (texto, botones) => {
      avisos.push({ texto, botones });
      return Promise.resolve(op.telegramFalla ? { ok: false, error: "x" } : { ok: true });
    },
    candidatosCobro: (hoy) => (hoys.push(hoy), Promise.resolve(cands)),
    marcarCobro: (id, en) => (orden.push(`marca:${id}`), marcas.push([id, en]), Promise.resolve()),
    ahora: () => ahora,
  };
  return { deps, marcas, entradas, avisos, hoys, orden };
}

Deno.test("corrida cobro: turno del bot con '[seguimiento cobro]', marca ANTES y pide los de hoy (Asunción)", async () => {
  const x = corridaCobro([cobra(), cobra({ conversacion_id: "conv-no", pedido_reciente: true })]);
  const r = await correrRecontactosCobro(x.deps, null);
  assertEquals([r.accion, r.candidatos, r.enviados, r.avisados, r.fallas], ["corrido", 2, 1, 0, 0]);
  assertEquals(r.motivos, { pedido_reciente: 1 });
  assertEquals(x.hoys, ["2026-10-07"]);
  assertEquals(x.orden, ["marca:conv-cobro", "turno:conv-cobro"]);
  assertEquals(x.entradas[0].texto, "[seguimiento cobro]");
  assertEquals(x.entradas[0].origen, "seguimiento");
  assertEquals(x.entradas[0].wa_message_id, `seguimiento:cobro:conv-cobro:${AHORA.toISOString()}`);
  assertEquals(x.marcas, [["conv-cobro", AHORA.toISOString()]]);
  assertEquals(x.avisos, []);
});

Deno.test("corrida cobro: fuera de la ventana → Telegram con el texto pedido y botón wa.me; sin turno", async () => {
  const x = corridaCobro([cobra({ ultima_entrada_en: hace(30) })]);
  const r = await correrRecontactosCobro(x.deps, null);
  assertEquals([r.enviados, r.avisados, r.fallas], [0, 1, 0]);
  assertEquals(x.entradas, []);
  assertEquals(x.avisos.length, 1);
  assert(x.avisos[0].texto.startsWith(
    "💰 <b>Ana Prueba</b> dijo que hoy cobraba (tiras nasales x2). Ya pasaron más de 24 h desde su último mensaje: escribile vos.",
  ));
  assert(x.avisos[0].texto.includes("https://wa.me/595981000000"));
  assertEquals(x.avisos[0].botones, [[{ texto: "Escribirle a Ana Prueba", url: "https://wa.me/595981000000" }]]);
  assertEquals(x.marcas, [["conv-cobro", AHORA.toISOString()]]);
});

Deno.test("corrida cobro: tope de gasto → ningún turno, se avisa a Enrique (con el motivo del tope)", async () => {
  const x = corridaCobro([cobra(), cobra({ conversacion_id: "conv-vieja", nombre: "Beto", ultima_entrada_en: hace(40) })], { tope: true });
  const r = await correrRecontactosCobro(x.deps, null);
  assertEquals([r.enviados, r.avisados], [0, 2]);
  assertEquals(x.entradas, []);
  assertEquals(x.avisos.length, 1, "los dos en un solo mensaje");
  assert(x.avisos[0].texto.includes("Beto</b> dijo que hoy cobraba"));
  assert(x.avisos[0].texto.includes("gasto de IA del mes llegó al tope"));
  assertEquals((x.avisos[0].botones as unknown[]).length, 2);
});

Deno.test("corrida cobro: más de 10 avisos van en varios mensajes", async () => {
  const cands = Array.from({ length: 12 }, (_, i) => cobra({ conversacion_id: `v${i}`, ultima_entrada_en: hace(48) }));
  const x = corridaCobro(cands);
  const r = await correrRecontactosCobro(x.deps, null);
  assertEquals(r.avisados, 12);
  assertEquals(x.avisos.length, 2);
});

Deno.test("corrida cobro: fuera de horario, inactivo o sin deps no hace nada", async () => {
  const temprano = corridaCobro([cobra()], { ahora: new Date("2026-10-07T10:30:00Z") });
  assertEquals((await correrRecontactosCobro(temprano.deps, null)).accion, "fuera_de_horario");
  assertEquals(temprano.hoys, []);
  const off = corridaCobro([cobra()]);
  assertEquals((await correrRecontactosCobro(off.deps, { activo: false })).accion, "inactivo");
  const viejas = corrida([cobra()]);
  assertEquals((await correrRecontactosCobro(viejas.deps, null)).accion, "inactivo");
  assertEquals((await correrSeguimientos(viejas.deps)).recontactos_cobro, undefined);
});

Deno.test("corrida cobro: omitido sin gasto desmarca; con gasto no; error de envío avisa y queda marcado", async () => {
  const x = corridaCobro([cobra()], { turno: () => ({ accion: "omitido", motivo: "cliente_escribio", costo_usd: 0 }) });
  const r = await correrRecontactosCobro(x.deps, null);
  assertEquals([r.omitidos, r.fallas], [1, 0]);
  assertEquals(x.marcas, [["conv-cobro", AHORA.toISOString()], ["conv-cobro", null]]);
  const y = corridaCobro([cobra()], { turno: () => ({ accion: "omitido", motivo: "cliente_escribio", costo_usd: 0.002 }) });
  await correrRecontactosCobro(y.deps, null);
  assertEquals(y.marcas.length, 1);
  const z = corridaCobro([cobra()], { turno: () => ({ accion: "error_envio", motivo: "131047" }) });
  const rz = await correrRecontactosCobro(z.deps, null);
  assertEquals(rz.fallas, 1);
  assertEquals(z.marcas.length, 1, "no se reintenta cada 10 min");
  assert(z.avisos[0].texto.includes("Recontacto el día que cobra: 1 con problemas"));
});

Deno.test("corrida cobro: Telegram falla → se desmarca (sale en la próxima corrida)", async () => {
  const x = corridaCobro([cobra({ ultima_entrada_en: hace(30) })], { telegramFalla: true });
  const r = await correrRecontactosCobro(x.deps, null);
  assertEquals([r.avisados, r.fallas], [0, 1]);
  assertEquals(x.marcas, [["conv-cobro", AHORA.toISOString()], ["conv-cobro", null]]);
});

Deno.test("correrSeguimientos: el recontacto por cobro va en el resumen y una excepción no frena la corrida", async () => {
  const x = corridaCobro([cobra()]);
  const r = await correrSeguimientos(x.deps);
  assertEquals(r.recontactos_cobro?.enviados, 1);
  const y = corridaCobro([]);
  y.deps.candidatosCobro = () => Promise.reject(new Error("sin red"));
  const ry = await correrSeguimientos(y.deps);
  assertEquals(ry.accion, "corrido");
  assertEquals(ry.recontactos_cobro, { accion: "error" });
  assert(y.avisos.some((a) => a.texto.includes("Recontacto el día que cobra: la corrida falló")));
});

Deno.test("pidió que le escriban otro día (recontactar_el a futuro): los recontactos no salen antes (10-10)", () => {
  const ahora = new Date("2026-10-10T16:00:00Z"); // sábado 13:00 Asunción
  const c = {
    conversacion_id: "c", cliente_id: "x", estado: "ia", ultima_entrada_en: "2026-10-10T12:00:00Z",
    perfil: { recontactar_el: "2026-10-12" }, ultimo_mensaje: { direccion: "out" as const, creado_en: "2026-10-10T12:01:00Z" },
    ultima_respuesta_derivada: false, pedido_reciente: false, baja_marketing: false,
  };
  assertEquals(decidirSeguimiento(c, leerCfgSeguimiento(null), ahora), { tipo: "nada", motivo: "espera_fecha_pedida" });
});

Deno.test("señal de compra: el texto automático del anuncio y las postergaciones NO avisan; cantidades y 'lo quiero' sí (10-10)", () => {
  for (const x of ["¡Hola! Quiero más información", "¡Hola! Me gustaría conseguir más información sobre esto.", "Dale te aviso", "dale gracias",
    "quiero saber más", "después te aviso, quiero 2", "la semana que viene lo quiero"]) assertEquals(tieneSenalCompra(x), false, x);
  for (const x of ["Quiero 2", "3 unidades", "lo quiero", "quiero el raspador", "Dale", "si dale", "mandame uno", "te paso mis datos"]) {
    assertEquals(tieneSenalCompra(x), true, x);
  }
});
