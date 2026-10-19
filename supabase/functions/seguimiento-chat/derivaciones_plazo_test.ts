// Tests de las derivaciones con plazo (19-10): recordatorios a Enrique, plazo de 4 h hábiles (retomar o mensaje fijo),
// mensaje fijo antes de que se cierre la ventana de 24 h e idempotencia. Datos inventados: repo público.
import { assert, assertEquals, assertFalse } from "@std/assert";
import type { EntradaTurno, ResultadoTurno } from "../_shared/vendedor/orquestador.ts";
import { instanteLocal } from "../recompra/calendario.ts";
import {
  type CandidatoDerivacion,
  CFG_DERIVACIONES_DEFAULT,
  correrDerivaciones,
  cuandoEscribe,
  decidirDerivacion,
  type DepsDerivaciones,
  horasHabiles,
  leerCfgDerivaciones,
  leerMarca,
  type MarcaDerivacion,
  momentoVentana,
  resumen3,
  TEXTO_RETOMAR,
  textoCliente,
} from "./derivaciones_plazo.ts";
import { correrSeguimientos, type DepsSeguimiento } from "./logica.ts";

const CFG = CFG_DERIVACIONES_DEFAULT;
const D0 = "2026-10-19", D1 = "2026-10-20";
const L = (dia: string, h: number, min = 0) => new Date(instanteLocal(dia, h).getTime() + min * 60_000);
const iso = (d: Date) => d.toISOString();

function cand(over: Partial<CandidatoDerivacion> & { derivEn?: Date; motivo?: string } = {}): CandidatoDerivacion {
  const { derivEn, motivo, ...resto } = over;
  const en = derivEn ?? L(D0, 10);
  return {
    conversacion_id: "conv-d",
    cliente_id: "cli-d",
    estado: "humano",
    nombre: "Ana Prueba",
    telefono: "+595981000000",
    wa_user_id: null,
    perfil: { producto: "tiras nasales", cantidad: 2 },
    ultima_entrada_en: iso(new Date(en.getTime() - 60_000)),
    derivacion: { turno_id: "turno-1", en: iso(en), motivo: motivo ?? "otro", resumen: "Quiere pasar su pedido web de 1 a 2 unidades." },
    manual_despues: false,
    escribo_despues: false,
    ultima_salida_tras_derivacion: null,
    ...resto,
  };
}

const acciones = (c: CandidatoDerivacion, ahora: Date, cfg = CFG) => {
  const d = decidirDerivacion(c, cfg, ahora);
  return d.acciones.length ? d.acciones.map((a) => (a.tipo === "recordatorio" ? `recordatorio ${a.nivel}` : a.tipo)) : [d.motivo];
};

// ---------- config y horario ----------

Deno.test("config: defaults, valores raros ignorados, la ventana nunca pasa de 24 h", () => {
  assertEquals(leerCfgDerivaciones(null), CFG);
  assertEquals(leerCfgDerivaciones({ derivaciones: { activo: false, plazo_habil_h: 6, habil_desde: "x", texto_plazo: "" } }), { ...CFG, activo: false, plazo_habil_h: 6 });
  const c = leerCfgDerivaciones({ derivaciones: { ventana_max_h: 30, ventana_fija_h: 29 } });
  assertEquals([c.ventana_max_h, c.ventana_fija_h], [23.75, 23.75]);
  assertEquals([CFG.recordatorio_1_h, CFG.recordatorio_2_h, CFG.plazo_habil_h, CFG.habil_desde, CFG.habil_hasta, CFG.ventana_fija_h], [2, 8, 4, 8, 21, 22]);
});

Deno.test("horas hábiles: solo cuenta de 8 a 21 de Asunción", () => {
  assertEquals(horasHabiles(L(D0, 10).getTime(), L(D0, 14).getTime(), CFG), 4);
  assertEquals(horasHabiles(L(D0, 20).getTime(), L(D1, 11).getTime(), CFG), 4);
  assertEquals(horasHabiles(L(D0, 22).getTime(), L(D1, 7).getTime(), CFG), 0);
});

Deno.test("'cuándo te escribe': ahora + 3 h a la hora en punto, tope 21; tarde o de noche, el próximo horario", () => {
  assertEquals(cuandoEscribe(L(D0, 12, 10), CFG), "hoy antes de las 16:00");
  assertEquals(cuandoEscribe(L(D0, 19, 30), CFG), "hoy antes de las 21:00");
  assertEquals(cuandoEscribe(L(D0, 20, 30), CFG), "mañana antes de las 11:00");
  assertEquals(cuandoEscribe(L(D0, 3), CFG), "hoy antes de las 11:00");
  assertEquals(textoCliente(CFG.texto_plazo, "Ana Prueba", "hoy antes de las 16:00"), "Hola Ana, perdón la demora. Enrique ya tiene tu consulta y te escribe hoy antes de las 16:00.");
  assertEquals(textoCliente(CFG.texto_plazo, null, "hoy antes de las 16:00"), "Hola, perdón la demora. Enrique ya tiene tu consulta y te escribe hoy antes de las 16:00.");
});

Deno.test("mensaje de las 22 h: a las 22 h si cae en horario; si no, el último momento hábil antes (≥ 8 h)", () => {
  // Escribió 15:00 → 13:00 del día siguiente (hábil).
  assertEquals(iso(new Date(momentoVentana(L(D0, 15).getTime(), CFG))), iso(L(D1, 13)));
  // Escribió 3:00 → las 22 h caen a la 1:00: se adelanta a 20:30 del mismo día.
  assertEquals(iso(new Date(momentoVentana(L(D0, 3).getTime(), CFG))), iso(L(D0, 20, 30)));
  // Escribió 23:00 → 21:00 del día siguiente (fuera): 20:30.
  assertEquals(iso(new Date(momentoVentana(L(D0, 23).getTime(), CFG))), iso(L(D1, 20, 30)));
});

Deno.test("resumen en 3 líneas: usa quiere/datos/falta de la derivación; si no, resumen + perfil; escapa HTML", () => {
  assertEquals(resumen3(cand()), ["Quiere: Quiere pasar su pedido web de 1 a 2 unidades.", "Datos: tiras nasales · x2", "Falta: tu respuesta"]);
  const c = cand();
  c.derivacion = { ...c.derivacion, quiere: "2 <tiras>", datos: "Nombre y ciudad", falta: "Confirmar el cambio" };
  assertEquals(resumen3(c), ["Quiere: 2 &lt;tiras&gt;", "Datos: Nombre y ciudad", "Falta: Confirmar el cambio"]);
});

// ---------- decisión ----------

Deno.test("recordatorios: a las 2 h y a las 8 h, una vez cada uno; si se juntan, sale uno solo", () => {
  assertEquals(acciones(cand(), L(D0, 11)), ["esperando"]);
  assertEquals(acciones(cand(), L(D0, 12)), ["recordatorio 1"]);
  const marcado1 = cand({ perfil: { derivacion_plazo: { turno_id: "turno-1", aviso_1_en: iso(L(D0, 12)), plazo_en: iso(L(D0, 14)) } } });
  assertEquals(acciones(marcado1, L(D0, 13)), ["esperando"]);
  assertEquals(acciones(marcado1, L(D0, 18)), ["recordatorio 2"]);
  // Derivó 22:30: a las 0:30 es de noche (7 a 23); a las 7:00 ya pasaron 8,5 h → solo el de 8 h.
  const noche = cand({ derivEn: L(D0, 22, 30) });
  assertEquals(acciones(noche, L(D1, 0, 30)), ["esperando"]);
  assertEquals(acciones(noche, L(D1, 7)), ["recordatorio 2"]);
  // La marca de otra derivación no cuenta.
  assertEquals(acciones(cand({ perfil: { derivacion_plazo: { turno_id: "viejo", aviso_1_en: iso(L(D0, 12)) } } }), L(D0, 12)), ["recordatorio 1"]);
  assertEquals(leerMarca({ derivacion_plazo: { turno_id: "viejo", aviso_1_en: "x" } }, "turno-1"), { turno_id: "turno-1" });
});

Deno.test("plazo de 4 h hábiles: venta → retomar; salud/reclamo → mensaje fijo; ventana cerrada → solo aviso", () => {
  const m = { derivacion_plazo: { turno_id: "turno-1", aviso_1_en: iso(L(D0, 12)) } };
  assertEquals(acciones(cand({ perfil: m }), L(D0, 13, 50)), ["esperando"]);
  assertEquals(acciones(cand({ perfil: m }), L(D0, 14)), ["retomar"]);
  for (const motivo of ["sin_avance", "falla_herramienta", "direccion_dudosa", "tope_gasto", "tope_turnos"]) {
    assertEquals(acciones(cand({ perfil: m, motivo }), L(D0, 14)), ["retomar"], motivo);
  }
  for (const motivo of ["salud", "reclamo", "devolucion", "enojo"]) assertEquals(acciones(cand({ perfil: m, motivo }), L(D0, 14)), ["fijo_plazo"], motivo);
  assertEquals(acciones(cand({ perfil: m }), L(D0, 14), { ...CFG, retomar_activo: false }), ["fijo_plazo"]);
  // Derivó 20:00 → 4 h hábiles a las 11:00 del día siguiente (los recordatorios ya salieron).
  const tarde = cand({ derivEn: L(D0, 20), perfil: { derivacion_plazo: { turno_id: "turno-1", aviso_1_en: "a", aviso_2_en: "b" } } });
  assertEquals(acciones(tarde, L(D1, 10, 50)), ["esperando"]);
  assertEquals(acciones(tarde, L(D1, 11)), ["retomar"]);
  // Su último mensaje fue hace ≥ 23,5 h (derivó desde un seguimiento): solo aviso.
  assertEquals(acciones(cand({ perfil: m, ultima_entrada_en: iso(L("2026-10-18", 13)) }), L(D0, 14)), ["plazo_ventana_cerrada"]);
  // Ya cumplido: no se repite.
  assertEquals(acciones(cand({ perfil: { derivacion_plazo: { ...m.derivacion_plazo, plazo_en: "x" } } }), L(D0, 15)), ["esperando"]);
});

Deno.test("atendido (Bandeja, 'Le escribo yo' o marca): ni recordatorios ni plazo; no en 'humano' o vieja: nada", () => {
  assertEquals(acciones(cand({ manual_despues: true, ultima_salida_tras_derivacion: iso(L(D0, 11)) }), L(D0, 14)), ["atendido"]);
  assertEquals(acciones(cand({ escribo_despues: true }), L(D0, 12)), ["atendido"]);
  assertEquals(acciones(cand({ perfil: { derivacion_plazo: { turno_id: "turno-1", atendido_en: "x" } } }), L(D0, 12)), ["atendido"]);
  assertEquals(acciones(cand({ estado: "ia" }), L(D0, 14)), ["no_esta_en_humano"]);
  assertEquals(acciones(cand({ derivEn: L("2026-10-15", 10) }), L(D0, 14)), ["derivacion_vieja"]);
});

Deno.test("nunca 24 h sin mensaje: escribió 3:00, nadie le escribió → mensaje fijo a las 20:30 (una vez por mensaje suyo)", () => {
  const base = { derivEn: L(D0, 3, 1), ultima_entrada_en: iso(L(D0, 3)), escribo_despues: true, motivo: "salud" };
  assertEquals(acciones(cand(base), L(D0, 20)), ["atendido"]);
  assertEquals(acciones(cand(base), L(D0, 20, 30)), ["fijo_ventana"]);
  // Ya salió para ese mensaje: no se repite.
  const marcada = cand({ ...base, perfil: { derivacion_plazo: { turno_id: "turno-1", ventana_entrada: iso(L(D0, 3)) } } });
  assertEquals(acciones(marcada, L(D0, 20, 40)), ["atendido"]);
  // Le salió algo después de su mensaje (Enrique o el fijo de las 4 h): no hace falta.
  assertEquals(acciones(cand({ ...base, ultima_salida_tras_derivacion: iso(L(D0, 9)) }), L(D0, 20, 30)), ["atendido"]);
  // Con la ventana ya cerrada no se manda nada.
  assertEquals(acciones(cand(base), L(D1, 3)), ["atendido"]);
});

// ---------- corrida ----------

function corrida(cands: CandidatoDerivacion[], op: {
  ahora: Date;
  cfg?: unknown;
  turno?: (e: EntradaTurno) => ResultadoTurno;
  telegramFalla?: boolean;
  envioFalla?: boolean;
}) {
  const orden: string[] = [];
  const marcas: Array<[string, MarcaDerivacion]> = [];
  const avisos: Array<{ texto: string; botones?: unknown }> = [];
  const textos: Array<{ to: string; texto: string }> = [];
  const entradas: EntradaTurno[] = [];
  const perfiles = new Map(cands.map((c) => [c.conversacion_id, c.perfil]));
  const deps: DepsDerivaciones & { turno(e: EntradaTurno): Promise<ResultadoTurno>; avisar(t: string, b?: unknown): Promise<unknown>; ahora(): Date } = {
    candidatosDerivacion: () => Promise.resolve(cands.map((c) => ({ ...c, perfil: perfiles.get(c.conversacion_id) }))),
    marcarDerivacion: (id, m) => {
      orden.push(`marca:${m.plazo_accion ?? (m.aviso_2_en ? "aviso2" : m.aviso_1_en ? "aviso1" : m.ventana_entrada ? "ventana" : "-")}`);
      marcas.push([id, m]);
      perfiles.set(id, { ...(perfiles.get(id) as object), derivacion_plazo: m });
      return Promise.resolve();
    },
    cambiarEstado: (_id, e) => (orden.push(`estado:${e}`), Promise.resolve()),
    enviarTextoCliente: (to, texto) => (orden.push("texto"), textos.push({ to, texto }), Promise.resolve(op.envioFalla ? { ok: false, error: "131047" } : { ok: true })),
    turno: (e) => (orden.push("turno"), entradas.push(e), Promise.resolve(op.turno?.(e) ?? { accion: "respondido", costo_usd: 0.001 })),
    avisar: (texto, botones) => (orden.push("telegram"), avisos.push({ texto, botones }), Promise.resolve(op.telegramFalla ? { ok: false } : { ok: true })),
    ahora: () => op.ahora,
  };
  return { deps, orden, marcas, avisos, textos, entradas };
}

Deno.test("corrida: recordatorio con resumen de 3 líneas y wa.me; marca antes; no se repite en la corrida siguiente", async () => {
  const x = corrida([cand()], { ahora: L(D0, 12) });
  const r = await correrDerivaciones(x.deps, null);
  assertEquals([r.recordatorios, r.fallas], [1, 0]);
  assertEquals(x.orden, ["marca:aviso1", "telegram"]);
  const t = x.avisos[0].texto;
  assert(t.startsWith("⏰ <b>Ana Prueba</b> espera tu respuesta hace 2 h (derivado: otro)."), t);
  assert(t.includes("Quiere: Quiere pasar su pedido web") && t.includes("Datos: tiras nasales · x2") && t.includes("Falta: tu respuesta"));
  assert(t.includes("el bot retoma el chat") && t.includes("Devolver a IA"));
  assertEquals(x.avisos[0].botones, [[{ texto: "Escribirle a Ana Prueba", url: "https://wa.me/595981000000" }]]);
  // Segunda corrida (10 min después) con la marca guardada: nada.
  x.deps.ahora = () => L(D0, 12, 10);
  const r2 = await correrDerivaciones(x.deps, null);
  assertEquals(r2.recordatorios, 0);
  assertEquals(x.avisos.length, 1);
});

Deno.test("corrida: Telegram falla en el recordatorio → se desmarca (sale en la próxima) y se avisa el problema", async () => {
  const x = corrida([cand()], { ahora: L(D0, 12), telegramFalla: true });
  const r = await correrDerivaciones(x.deps, null);
  assertEquals([r.recordatorios, r.fallas], [0, 1]);
  assertEquals(x.marcas.at(-1)?.[1], { turno_id: "turno-1" });
});

Deno.test("corrida: retomar → marca, pasa a 'ia', turno '[retomar] …' (origen seguimiento) y avisa a Enrique; una sola vez", async () => {
  const m = { derivacion_plazo: { turno_id: "turno-1", aviso_1_en: iso(L(D0, 12)) } };
  const x = corrida([cand({ perfil: m })], { ahora: L(D0, 14) });
  const r = await correrDerivaciones(x.deps, null);
  assertEquals([r.retomados, r.fijos, r.fallas], [1, 0, 0]);
  assertEquals(x.orden, ["marca:retomar", "estado:ia", "turno", "telegram"]);
  assertEquals(x.entradas[0].texto, TEXTO_RETOMAR);
  assert(TEXTO_RETOMAR.startsWith("[retomar] Enrique no pudo responder todavía"));
  assertEquals(x.entradas[0].origen, "seguimiento");
  assert(x.entradas[0].wa_message_id.startsWith("retomar:conv-d:"));
  assert(x.avisos[0].texto.includes("el bot retomó el chat"));
  assertEquals(x.textos, []);
  await correrDerivaciones(x.deps, null);
  assertEquals(x.entradas.length, 1, "no se repite");
});

Deno.test("corrida: el turno de retomar no sale (tope de gasto) → vuelve a 'humano', mensaje fijo y alerta", async () => {
  const m = { derivacion_plazo: { turno_id: "turno-1", aviso_1_en: iso(L(D0, 12)) } };
  const x = corrida([cand({ perfil: m })], { ahora: L(D0, 14), turno: () => ({ accion: "omitido", motivo: "tope_gasto", costo_usd: 0 }) });
  const r = await correrDerivaciones(x.deps, null);
  assertEquals([r.retomados, r.fijos], [0, 1]);
  assertEquals(x.orden, ["marca:retomar", "estado:ia", "turno", "estado:humano", "marca:retomar_no_salio:omitido:tope_gasto", "texto", "telegram"]);
  assertEquals(x.textos[0], { to: "+595981000000", texto: "Hola Ana, perdón la demora. Enrique ya tiene tu consulta y te escribe hoy antes de las 17:00." });
  assert(x.avisos[0].texto.includes("el bot no pudo retomar") && x.avisos[0].texto.includes("hoy antes de las 17:00"));
  // El cliente escribió justo mientras tanto: queda en 'ia' (su mensaje lo atiende el vendedor), sin fijo.
  const y = corrida([cand({ perfil: m })], { ahora: L(D0, 14), turno: () => ({ accion: "omitido", motivo: "cliente_escribio" }) });
  const ry = await correrDerivaciones(y.deps, null);
  assertEquals([ry.retomados, ry.fijos], [1, 0]);
  assertFalse(y.orden.includes("estado:humano"));
});

Deno.test("corrida: salud a las 4 h hábiles → mensaje fijo (sin turno del bot) y alerta 'Cumplilo'", async () => {
  const m = { derivacion_plazo: { turno_id: "turno-1", aviso_1_en: iso(L(D0, 12)) } };
  const x = corrida([cand({ perfil: m, motivo: "salud" })], { ahora: L(D0, 14) });
  const r = await correrDerivaciones(x.deps, null);
  assertEquals(r.fijos, 1);
  assertEquals(x.orden, ["marca:fijo", "texto", "telegram"]);
  assertEquals(x.entradas, []);
  assert(x.avisos[0].texto.includes("Cumplilo"));
  // Si el envío falla: queda marcado (no se reintenta cada 10 min) y se avisa.
  const y = corrida([cand({ perfil: m, motivo: "reclamo" })], { ahora: L(D0, 14), envioFalla: true });
  const ry = await correrDerivaciones(y.deps, null);
  assertEquals([ry.fijos, ry.fallas], [0, 1]);
  assertEquals(y.marcas.at(-1)?.[1].plazo_accion, "fijo_fallo");
  assert(y.avisos.some((a) => a.texto.includes("No pude mandarle el aviso")));
  await correrDerivaciones(y.deps, null);
  assertEquals(y.textos.length, 1, "no se reintenta");
});

Deno.test("corrida: mensaje de las 22 h una sola vez por mensaje del cliente; inactiva por config", async () => {
  const c = cand({ derivEn: L(D0, 3, 1), ultima_entrada_en: iso(L(D0, 3)), escribo_despues: true, motivo: "salud" });
  const x = corrida([c], { ahora: L(D0, 20, 30) });
  const r = await correrDerivaciones(x.deps, null);
  assertEquals(r.fijos, 1);
  assertEquals(x.textos[0].texto, "Hola Ana, seguimos con tu consulta: Enrique te escribe mañana antes de las 11:00. Cualquier cosa, escribime por acá.");
  await correrDerivaciones(x.deps, null);
  assertEquals(x.textos.length, 1);
  const off = corrida([cand()], { ahora: L(D0, 12) });
  assertEquals((await correrDerivaciones(off.deps, { derivaciones: { activo: false } })).accion, "inactivo");
});

Deno.test("correrSeguimientos: corre las derivaciones si están las deps y una excepción no frena el resto", async () => {
  const x = corrida([cand()], { ahora: L(D0, 12) });
  const deps: DepsSeguimiento = {
    config: () => Promise.resolve(null),
    topeGastoSuperado: () => Promise.resolve(false),
    candidatos: () => Promise.resolve([]),
    marcar: () => Promise.resolve(),
    ...x.deps,
  };
  const r = await correrSeguimientos(deps);
  assertEquals(r.derivaciones?.recordatorios, 1);
  deps.candidatosDerivacion = () => Promise.reject(new Error("sin red"));
  const r2 = await correrSeguimientos(deps);
  assertEquals(r2.derivaciones, { accion: "error" });
  assertEquals(r2.accion, "corrido");
});
