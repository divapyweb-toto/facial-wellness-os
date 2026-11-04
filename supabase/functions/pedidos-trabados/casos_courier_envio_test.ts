// 04-11: casos para el courier: horario, urgentes, agrupado, candados, simular y casos del sistema (datos inventados).
import { assert, assertEquals, assertStringIncludes } from "@std/assert";
import type { CasoCourier } from "../_shared/casos_courier.ts";
import {
  baseDeCaso, casosNoEncontrada, claveCandadoCasos, type DatosPedidoCaso, decidirSeguimiento, type DepsCasos, type DepsSistema, enviarCasos,
  franjaActual, nuevosPlazoLucero, umbralLucero, nuevosPlazoPap, partesEnvio, pideReenvio, planificarEnvios, procesarCasosSistema,
} from "./casos_courier_envio.ts";

// Paraguay = UTC−3: "2026-11-04T08:31" PY = 11:31Z. 04-11-2026 es miércoles.
const py = (f: string) => new Date(`${f}:00-03:00`);
let n = 0;
const C = (o: Partial<CasoCourier> = {}): CasoCourier => ({
  id: `c${++n}`, creado_en: py("2026-11-03T10:00").toISOString(), shopify_order_id: 9000 + n, ref: `VT-90${String(n).padStart(2, "0")}`,
  courier: "lucero", origen: "bot", tipo: "reclamo", pide: "Esperó el martes y no le llegó", horario: null, referencia: null, recibe: null,
  urgente: false, estado: "pendiente", enviado_en: null, lote: null, cliente_id: null, conversacion_id: null, ...o,
});
const D = (o: Partial<DatosPedidoCaso> = {}): DatosPedidoCaso => ({
  nombre: "Ana Prueba", ciudad: "Luque", fechaIngreso: "2026-10-30", guiaPap: null, estadoCourier: "Aceptado", categoria: "en_proceso", noEncontrada: false, ...o,
});

function deps(fallas = 0) {
  const candados = new Set<string>(), telegram: Array<{ texto: string; tipo?: string }> = [], marcados: Array<{ id: string; lote: string }> = [];
  let f = fallas;
  const d: DepsCasos = {
    tomarCandado: (id) => Promise.resolve(candados.has(id) ? false : (candados.add(id), true)),
    soltarCandado: (id) => Promise.resolve(void candados.delete(id)),
    existeCandado: (id) => Promise.resolve(candados.has(id)),
    avisar: (texto, _b, opts) => {
      if (f > 0) { f--; return Promise.resolve({ ok: false, error: "caído" }); }
      telegram.push({ texto, tipo: opts?.tipo });
      return Promise.resolve({ ok: true });
    },
    esperar: () => Promise.resolve(),
    marcarEnviados: (cs, lote) => Promise.resolve(void cs.forEach((c) => marcados.push({ id: c.id, lote: lote(c) }))),
  };
  return { d, candados, telegram, marcados };
}

/** Una corrida: planifica con los pendientes que quedan y manda. */
async function corrida(pend: CasoCourier[], ahora: Date, x: ReturnType<typeof deps>, simular = false) {
  const vivos = pend.filter((c) => !x.marcados.some((m) => m.id === c.id));
  const datos = new Map(pend.map((c) => [c.ref, D()]));
  return await enviarCasos(planificarEnvios(vivos, ahora), datos, [], ahora, x.d, simular);
}

Deno.test("horario: 07:00 nada; 08:31 lun–sáb am; 13:00 sigue am; 14:05 pm; domingo nada", () => {
  assertEquals(franjaActual(py("2026-11-04T07:00")), null);
  assertEquals(franjaActual(py("2026-11-04T08:31"))?.franja, "am");
  assertEquals(franjaActual(py("2026-11-04T08:31"))?.corte, py("2026-11-04T08:30").toISOString());
  assertEquals(franjaActual(py("2026-11-04T13:00"))?.franja, "am");
  assertEquals(franjaActual(py("2026-11-04T14:05"))?.franja, "pm");
  assertEquals(franjaActual(py("2026-11-08T09:00")), null); // domingo
  assertEquals(franjaActual(py("2026-11-07T09:00"))?.franja, "am"); // sábado
  assertEquals(franjaActual(py("2026-11-07T23:59"))?.dia, "2026-11-07"); // 02:59Z del domingo sigue siendo sábado en PY
});

Deno.test("una corrida por franja: 08:31 sale una vez, 13:00 nada nuevo, 14:05 la tarde", async () => {
  const x = deps(), a = C(), b = C({ creado_en: py("2026-11-04T10:00").toISOString() });
  assertEquals(await corrida([a, b], py("2026-11-04T07:00"), x), []);
  const am = await corrida([a, b], py("2026-11-04T08:31"), x);
  assertEquals(am.map((h) => [h.lote, h.resultado, h.casos]), [["2026-11-04:am:lucero", "enviado", [a.ref]]]); // b llegó después de las 08:30
  assertEquals((await corrida([a, b], py("2026-11-04T08:41"), x)).length, 0);
  assertEquals((await corrida([a, b], py("2026-11-04T13:00"), x)).length, 0);
  const pm = await corrida([a, b], py("2026-11-04T14:05"), x);
  assertEquals(pm.map((h) => [h.lote, h.resultado, h.casos]), [["2026-11-04:pm:lucero", "enviado", [b.ref]]]);
  assertEquals(x.telegram.length, 2);
  assert(x.candados.has(claveCandadoCasos("2026-11-04", "am", "lucero")));
});

Deno.test("domingo nada; sábado sí", async () => {
  const x = deps();
  assertEquals(await corrida([C()], py("2026-11-08T10:00"), x), []);
  assertEquals((await corrida([C()], py("2026-11-07T10:00"), x)).map((h) => h.lote), ["2026-11-07:am:lucero"]);
});

Deno.test("urgente: de noche espera a las 07:00; el domingo sale de día, solo y con su propio lote", async () => {
  const x = deps(), u = C({ urgente: true, creado_en: py("2026-11-07T21:00").toISOString() }), normal = C();
  const noche = await corrida([u, normal], py("2026-11-07T21:05"), x); // sábado 21:05: sale la tanda pm, el urgente no
  assertEquals(noche.map((e) => e.lote), ["2026-11-07:pm:lucero"]);
  assertEquals(await corrida([u], py("2026-11-08T06:55"), x), []);
  const h = await corrida([u, C()], py("2026-11-08T07:00"), x); // domingo: el normal no sale
  assertEquals(h.map((e) => [e.lote, e.casos]), [[`urgente:${u.id}`, [u.ref]]]);
  const t = x.telegram.at(-1)!;
  assertEquals(t.tipo, "casos_courier_urgente");
  assertStringIncludes(t.texto, "🚨");
  assertStringIncludes(t.texto, "URGENTE: lo necesita hoy.");
  assertEquals(x.marcados.at(-1)?.lote, `urgente:${u.id}|estado:aceptado`);
});

Deno.test("agrupa por courier y ordena del más viejo al más nuevo", () => {
  const nuevo = C({ creado_en: py("2026-11-03T15:00").toISOString() }), viejo = C({ creado_en: py("2026-11-02T09:00").toISOString() });
  const pap = C({ courier: "pap" });
  const plan = planificarEnvios([nuevo, pap, viejo], py("2026-11-04T08:35"));
  assertEquals(plan.map((e) => [e.courier, e.casos.map((c) => c.id)]), [["lucero", [viejo.id, nuevo.id]], ["pap", [pap.id]]]);
});

Deno.test("se marca enviado solo si salió; si Telegram falla se suelta el candado y la próxima reintenta", async () => {
  const x = deps(3), a = C();
  const h1 = await corrida([a], py("2026-11-04T08:31"), x);
  assert(h1[0].resultado.startsWith("error: Telegram"));
  assertEquals(x.marcados, []);
  assertEquals(x.candados.size, 0);
  const h2 = await corrida([a], py("2026-11-04T08:41"), x);
  assertEquals(h2[0].resultado, "enviado");
  assertEquals(x.marcados.map((m) => m.id), [a.id]);
});

Deno.test("simular: no manda, no toma candados, no marca, pero muestra el texto", async () => {
  const x = deps();
  const h = await corrida([C()], py("2026-11-04T08:31"), x, true);
  assertEquals(h[0].resultado, "simulado");
  assertStringIncludes(h[0].textos![0], "Para Lucero");
  assertEquals([x.telegram.length, x.candados.size, x.marcados.length], [0, 0, 0]);
});

Deno.test("PaP: rendiciones en el Telegram; sin casos solo en la franja am", async () => {
  const rend = [{ ref: "VT-9500", monto: 172500, fechaEntrega: "2026-10-20" }];
  assertEquals(planificarEnvios([], py("2026-11-04T14:05"), true), []);
  const plan = planificarEnvios([], py("2026-11-04T08:35"), true);
  assertEquals(plan.map((e) => e.lote), ["2026-11-04:am:pap"]);
  const x = deps();
  await enviarCasos(plan, new Map(), rend, py("2026-11-04T08:35"), x.d);
  assertStringIncludes(x.telegram[0].texto, "Quedan sin rendir VT-9500 (Gs. 172.500)");
  assert(x.telegram[0].texto.startsWith("💰 <b>Para Punto a Punto</b> · rendiciones pendientes. Copiá y pegá en su WhatsApp:"));
  assert(!x.telegram[0].texto.includes("0 casos"));
  assert(!/cuenta|banco/i.test(x.telegram[0].texto));
});

Deno.test("muchos casos: se parte en varios Telegram que entran en el límite y cubren todo", () => {
  const casos = Array.from({ length: 60 }, () => C({ pide: "El cliente dice que nadie lo llamó y que necesita que lo contacten antes de las 18 hs" }));
  const plan = planificarEnvios(casos, py("2026-11-04T08:35"));
  const partes = partesEnvio(plan[0], casos.map((c) => ({ guia: `L-${c.ref}`, ref: c.ref, nombre: "Ana Prueba", ciudad: "Luque", fechaIngreso: null, pide: c.pide, esperaDesde: null })), []);
  assert(partes.length > 1);
  assert(partes.every((p) => p.texto.length <= 4096));
  assertEquals(partes.flatMap((p) => p.casos.map((c) => c.id)), casos.map((c) => c.id));
});

Deno.test("sistema: plazo PaP (> 5 hábiles), Lucero ≥ 4 días y no encontradas", () => {
  const ahora = py("2026-11-04T08:00");
  assertEquals(nuevosPlazoPap([
    { ref: "VT-9101", ciudad: "Luque", estado: "En Oficina", fechaVenta: "2026-10-26" },
    { ref: "VT-9102", ciudad: "Luque", estado: "En Oficina", fechaVenta: "2026-11-02" },
    { ref: "VT-9103", ciudad: "Luque", estado: "Entregado", fechaVenta: "2026-10-01" },
  ], ahora), [{ ref: "VT-9101", courier: "pap", tipo: "plazo", pide: 'Figura "En Oficina" hace 7 días hábiles' }]);
  const L = (ref: string, estado: string, fechaIngreso: string, noEncontrada = false) => ({ ref, estado, categoria: "en_proceso", fechaIngreso, noEncontrada });
  assertEquals(nuevosPlazoLucero([
    L("VT-9201", "Aceptado", "2026-10-31"), L("VT-9202", "Aceptado", "2026-11-01"), L("VT-9203", "Fallido", "2026-10-20"),
    L("VT-9204", "Cargado", "2026-10-20", true), L("VT-9205", "Devuelto", "2026-10-20"),
  ], ahora).map((c) => [c.ref, c.pide]), [["VT-9201", 'Figura "Aceptado" hace 4 días']]);
  // 04-11: umbral por ciudad = max(4, dias_max + 1) de la tarifa de Lucero; sin dato, 4.
  const dm = new Map([["salto del guaira", 9], ["luque", 2]]);
  assertEquals([umbralLucero("Salto del Guairá", dm), umbralLucero(" LUQUE ", dm), umbralLucero("Pilar", dm), umbralLucero(null, dm)], [10, 4, 4, 4]);
  assertEquals(nuevosPlazoLucero([{ ...L("VT-9206", "Aceptado", "2026-10-26"), ciudad: "Salto del Guairá" }, { ...L("VT-9207", "Aceptado", "2026-10-25"), ciudad: "Salto del Guairá" }], ahora, dm)
    .map((c) => c.ref), ["VT-9207"]); // 9 días no llega a 10; 10 sí
  assertEquals(casosNoEncontrada(["VT-9204", "VT-9204"]), [{ ref: "VT-9204", courier: "lucero", tipo: "no_encontrada", pide: "" }]);
});

function depsSis() {
  const insertados: string[] = [], cambios: Array<[string, unknown]> = [];
  const d: DepsSistema = {
    insertarCaso: (c) => Promise.resolve(void insertados.push(`${c.ref}:${c.tipo}:${c.pide}`)).then(() => "insertado" as const),
    actualizarCaso: (id, x) => Promise.resolve(void cambios.push([id, x])),
  };
  return { d, insertados, cambios };
}

Deno.test("sistema: un caso por pedido y tipo, una sola vez", async () => {
  const ahora = py("2026-11-04T08:00"), x = depsSis();
  const nuevo = { ref: "VT-9301", courier: "pap" as const, tipo: "plazo" as const, pide: 'Figura "En Oficina" hace 7 días hábiles' };
  await procesarCasosSistema([nuevo], [], new Map(), ahora, x.d);
  assertEquals(x.insertados.length, 1);
  // La corrida siguiente ya lo encuentra (pendiente o enviado): no se repite.
  const ya = C({ ref: "VT-9301", courier: "pap", origen: "sistema", tipo: "plazo" });
  await procesarCasosSistema([nuevo], [ya], new Map([["VT-9301", D({ estadoCourier: "En Oficina" })]]), ahora, x.d);
  await procesarCasosSistema([nuevo], [{ ...ya, estado: "enviado", enviado_en: ahora.toISOString(), lote: "2026-11-04:am:pap|estado:en_oficina" }],
    new Map([["VT-9301", D({ estadoCourier: "En Oficina" })]]), ahora, x.d);
  assertEquals(x.insertados.length, 1);
  // Simular no escribe.
  const s = depsSis();
  const h = await procesarCasosSistema([{ ...nuevo, ref: "VT-9302" }], [], new Map(), ahora, s.d, true);
  assertEquals([h[0].resultado, s.insertados.length], ["simulado: nuevo", 0]);
});

Deno.test("los ya avisados a mano el 04-11 no salen antes de 2 días hábiles aunque falte la siembra", async () => {
  const x = depsSis(), n0 = { ref: "VT-1172", courier: "lucero" as const, tipo: "plazo" as const, pide: "x" };
  await procesarCasosSistema([n0], [], new Map(), py("2026-11-05T09:00"), x.d);
  assertEquals(x.insertados, []);
  await procesarCasosSistema([n0], [], new Map(), py("2026-11-06T09:00"), x.d);
  assertEquals(x.insertados.length, 1);
});

Deno.test("reenvío: 2 días hábiles sin novedad; novedad reinicia; entregado o guía que reaparece → cerrado", () => {
  const enviado = C({ origen: "sistema", tipo: "plazo", estado: "enviado", enviado_en: py("2026-11-04T08:31").toISOString(), lote: "2026-11-04:am:lucero|estado:aceptado" });
  const igual = D({ estadoCourier: "Aceptado" });
  assertEquals(decidirSeguimiento(enviado, igual, py("2026-11-05T09:00")).accion, "nada");
  assertEquals(decidirSeguimiento(enviado, igual, py("2026-11-06T09:00")).accion, "reenviar"); // jue + vie
  assertEquals(decidirSeguimiento(enviado, igual, py("2026-11-07T09:00")).accion, "reenviar");
  const nov = decidirSeguimiento(enviado, D({ estadoCourier: "En reparto" }), py("2026-11-05T09:00"));
  assertEquals(nov, { accion: "novedad", lote: "2026-11-04:am:lucero|estado:aceptado|novedad:2026-11-05:en_reparto" });
  const conNov = { ...enviado, lote: nov.accion === "novedad" ? nov.lote : "" };
  assertEquals(baseDeCaso(conNov), { dia: "2026-11-05", estado: "en_reparto" });
  assertEquals(decidirSeguimiento(conNov, D({ estadoCourier: "En reparto" }), py("2026-11-06T09:00")).accion, "nada");
  assertEquals(decidirSeguimiento(conNov, D({ estadoCourier: "En reparto" }), py("2026-11-09T09:00")).accion, "reenviar");
  assertEquals(decidirSeguimiento(enviado, D({ categoria: "entregado", estadoCourier: "Entregado" }), py("2026-11-09T09:00")).accion, "cerrar");
  const ne = C({ origen: "sistema", tipo: "no_encontrada", estado: "pendiente", pide: "" });
  assertEquals(decidirSeguimiento(ne, D({ noEncontrada: false }), py("2026-11-05T09:00")).accion, "cerrar");
  assertEquals(decidirSeguimiento(ne, D({ noEncontrada: true }), py("2026-11-05T09:00")).accion, "nada");
  assertEquals(pideReenvio(enviado, igual), 'Ya lo consulté el 04/11 y sigue "Aceptado"');
});

Deno.test("reenvío desde la siembra: inserta un caso nuevo con el mismo tipo", async () => {
  const x = depsSis();
  const sembrado = C({ ref: "VT-1109", origen: "sistema", tipo: "no_encontrada", estado: "enviado", enviado_en: "2026-11-04T12:00:00-03:00", lote: "manual:2026-11-04|estado:no_encontrado" });
  const h = await procesarCasosSistema(casosNoEncontrada(["VT-1109"]), [sembrado], new Map([["VT-1109", D({ noEncontrada: true })]]), py("2026-11-06T09:00"), x.d);
  assertEquals(h.map((e) => e.resultado), ["reenviado"]);
  assertEquals(x.insertados, ["VT-1109:no_encontrada:Ya lo consulté el 04/11 y sigue sin aparecer"]);
});
