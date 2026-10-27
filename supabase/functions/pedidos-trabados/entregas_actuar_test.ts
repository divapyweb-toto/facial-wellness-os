import { assert, assertEquals, assertStringIncludes } from "@std/assert";
import {
  avisarParadosDiario, avisarRendicionAtrasada, CANDADO_BASE_PAP, CFG_REPROGRAMAR_APAGADA, claveCandadoActuar, claveEnvioReprogramar,
  configReprogramar, decidirReprogramar, type DepsActuar, diasDesde, type FilaActuar, type FilaRendicion, normEstado,
  procesarEntregasActuar, type ResultadoReprogramar, textoLucero, textoPap, claveNoEntregado,
} from "./entregas_actuar.ts";
import type { OpcionesAviso } from "../_shared/telegram_politica.ts";
import type { PedidoParado } from "../resumen-diario/logica.ts";

// Datos inventados. 21-10-2026 11:00 en Paraguay = 14:00 UTC.
const AHORA = new Date("2026-10-21T14:00:00Z");
const LUCERO: FilaActuar = { ref: "VT-9002", courier: "lucero", estado: "Fallido", motivo: "No paso la ubicación", fechaIngreso: "2026-10-17", tipo: "lucero_fallido" };
const PAP_A: FilaActuar = { ref: "VT-9003", courier: "pap", estado: "No Gestionado", motivo: "Fuera de Cobertura ", fechaIngreso: "2026-10-14", tipo: "pap_ultima_chance" };
const PAP_B: FilaActuar = { ref: "VT-9004", courier: "pap", estado: "Custodio", motivo: "Inubicable", fechaIngreso: "2026-10-13", tipo: "pap_ultima_chance" };
const APROBADA = { plantillaAprobada: true, maxDias: 7 };

/** Dependencias en memoria: candados en un Set (persisten entre "corridas"), Telegram y cola grabados. */
function deps(o: { telegramFalla?: number; cliente?: ResultadoReprogramar } = {}) {
  const candados = new Set<string>(), telegram: string[] = [], cola: string[] = [];
  let fallas = o.telegramFalla ?? 0;
  const d: DepsActuar = {
    tomarCandado: (id) => Promise.resolve(candados.has(id) ? false : (candados.add(id), true)),
    soltarCandado: (id) => Promise.resolve(void candados.delete(id)),
    existeCandado: (id) => Promise.resolve(candados.has(id)),
    avisar: (t) => Promise.resolve(fallas > 0 ? (fallas--, { ok: false, error: "caído" }) : (telegram.push(t), { ok: true })),
    encolarReprogramar: (f) => {
      const cliente = o.cliente ?? "encolado";
      if (cliente === "encolado") cola.push(claveEnvioReprogramar(Number(f.ref.replace("VT-", "")), f.fechaIngreso));
      return Promise.resolve(cliente);
    },
    esperar: () => Promise.resolve(),
  };
  return { d, candados, telegram, cola };
}
const par = (nombre: string, horas: number, ciudad: string, o: Partial<PedidoParado> = {}): PedidoParado =>
  ({ nombre, ciudad, horas, dias: Math.floor(horas / 24), etapa: "sin_despachar", courier: "pap", producto: "Raspador de Lengua", ...o });

Deno.test("helpers: estado normalizado, días en Paraguay, claves de candado y de envío", () => {
  assertEquals(normEstado("No Gestionado"), "no_gestionado");
  assertEquals(normEstado("Fallido "), "fallido");
  assertEquals(diasDesde("2026-10-17", AHORA), 4);
  assertEquals(diasDesde("2026-10-21", new Date("2026-10-22T01:00:00Z")), 0); // 22:00 del 21 en Paraguay
  assertEquals(diasDesde(null, AHORA), null);
  assertEquals(claveCandadoActuar(LUCERO), "auto_actuar_lucero:VT-9002:fallido:2026-10-17");
  assertEquals(claveCandadoActuar(PAP_A), "auto_actuar_pap:VT-9003:no_gestionado");
  assertEquals(claveEnvioReprogramar(123, "2026-10-17"), "courier:123:FALLIDO:2026-10-17");
});

Deno.test("config reprogramar_lucero: sin fila, inválida o con la plantilla sin aprobar = apagado", () => {
  assertEquals(configReprogramar('{"plantilla_aprobada": false}'), { plantillaAprobada: false, maxDias: 7 });
  assertEquals(configReprogramar('{"plantilla_aprobada": true, "max_dias": 3}'), { plantillaAprobada: true, maxDias: 3 });
  assertEquals(configReprogramar({ plantilla_aprobada: true }).plantillaAprobada, true);
  assertEquals(configReprogramar("no es json"), CFG_REPROGRAMAR_APAGADA);
  assertEquals(configReprogramar('{"plantilla_aprobada": "si"}').plantillaAprobada, false);
});

Deno.test("decidirReprogramar: solo Lucero fallido, con plantilla aprobada y evento reciente", () => {
  assertEquals(decidirReprogramar(LUCERO, CFG_REPROGRAMAR_APAGADA, AHORA), "plantilla_sin_aprobar");
  assertEquals(decidirReprogramar(LUCERO, APROBADA, AHORA), "enviar");
  assertEquals(decidirReprogramar({ ...LUCERO, fechaIngreso: "2026-10-10" }, APROBADA, AHORA), "evento_viejo");
  assertEquals(decidirReprogramar(PAP_A, APROBADA, AHORA), "no_corresponde");
});

Deno.test("Lucero fallido: solo Telegram (con número y motivo), una sola vez en dos corridas; NUNCA escribe al cliente desde acá", async () => {
  const { d, telegram, cola } = deps();
  const r1 = await procesarEntregasActuar([LUCERO], AHORA, CFG_REPROGRAMAR_APAGADA, d);
  assertEquals(r1[0].resultado, "avisado");
  assertEquals(telegram.length, 1);
  assertStringIncludes(telegram[0], "VT-9002");
  assertStringIncludes(telegram[0], "entrega fallida (No paso la ubicación)");
  assertStringIncludes(telegram[0], "aviso de reintento habitual");
  assertEquals(cola, []);
  const r2 = await procesarEntregasActuar([LUCERO], new Date(AHORA.getTime() + 600_000), CFG_REPROGRAMAR_APAGADA, d);
  assertEquals(r2[0].resultado, "ya_avisado");
  assertEquals(telegram.length, 1);
});

Deno.test("Lucero fallido con la plantilla aprobada: el Telegram dice que el cliente recibe UN solo mensaje (lo manda la importación); un evento nuevo avisa de nuevo", async () => {
  const { d, telegram, cola } = deps();
  const r = await procesarEntregasActuar([LUCERO], AHORA, APROBADA, d);
  assertEquals(r[0].cliente, "importacion_nuevo");
  assertStringIncludes(telegram[0], "UN solo mensaje");
  assertEquals(cola, []); // acá no se encola nada: así nunca hay dos mensajes por falla
  await procesarEntregasActuar([{ ...LUCERO, fechaIngreso: "2026-10-20" }], AHORA, APROBADA, d);
  assertEquals(telegram.length, 2);
  assertEquals(cola, []);
});

Deno.test("PaP: línea base silenciosa de los viejos en la primera corrida; después, todo evento nuevo avisa el mismo día, una vez", async () => {
  const { d, telegram, candados } = deps();
  const filas = [LUCERO, PAP_A, PAP_B];
  const r1 = await procesarEntregasActuar(filas, AHORA, CFG_REPROGRAMAR_APAGADA, d);
  assertEquals(r1.map((x) => [x.ref, x.resultado]), [["VT-9002", "avisado"], ["VT-9003", "línea base (sin aviso)"], ["VT-9004", "línea base (sin aviso)"]]);
  assertEquals(telegram.length, 1); // solo la de Lucero
  assert(candados.has(CANDADO_BASE_PAP) && candados.has("auto_actuar_pap:VT-9003:no_gestionado"));
  // segunda corrida: nada nuevo
  const r2 = await procesarEntregasActuar(filas, AHORA, CFG_REPROGRAMAR_APAGADA, d);
  assertEquals(r2.map((x) => x.resultado), ["ya_avisado", "ya_avisado", "ya_avisado"]);
  assertEquals(telegram.length, 1);
  // pasa un PaP nuevo (aunque el paquete haya ingresado hace días): ya hay línea base, avisa el mismo día, una vez
  const nuevo: FilaActuar = { ...PAP_A, ref: "VT-9005", fechaIngreso: "2026-10-15", estado: "Custodio" };
  await procesarEntregasActuar([...filas, nuevo], AHORA, CFG_REPROGRAMAR_APAGADA, d);
  await procesarEntregasActuar([...filas, nuevo], AHORA, CFG_REPROGRAMAR_APAGADA, d);
  assertEquals(telegram.length, 2);
  assertStringIncludes(telegram[1], "VT-9005");
  assertStringIncludes(telegram[1], "PaP no reintenta: es la última chance de llamar al cliente");
  // y si el mismo paquete cambia a otro estado de última chance, es un evento nuevo
  await procesarEntregasActuar([{ ...nuevo, estado: "Inubicable" }], AHORA, CFG_REPROGRAMAR_APAGADA, d);
  assertEquals(telegram.length, 3);
});

Deno.test("PaP reciente en la primera corrida (fecha_ingreso de hace ≤ 3 días) sí avisa", async () => {
  const { d, telegram } = deps();
  const r = await procesarEntregasActuar([{ ...PAP_A, fechaIngreso: "2026-10-19" }], AHORA, CFG_REPROGRAMAR_APAGADA, d);
  assertEquals(r[0].resultado, "avisado");
  assertEquals(telegram.length, 1);
});

Deno.test("Telegram caído 3 veces: se suelta el candado y la corrida siguiente (10 min) lo reintenta", async () => {
  const { d, telegram, candados } = deps({ telegramFalla: 3 });
  const r1 = await procesarEntregasActuar([LUCERO], AHORA, CFG_REPROGRAMAR_APAGADA, d);
  assertStringIncludes(r1[0].resultado, "error: Telegram: caído");
  assertEquals(telegram.length, 0);
  assertEquals(candados.has(claveCandadoActuar(LUCERO)), false);
  const r2 = await procesarEntregasActuar([LUCERO], AHORA, CFG_REPROGRAMAR_APAGADA, d);
  assertEquals(r2[0].resultado, "avisado");
  assertEquals(telegram.length, 1);
});

Deno.test("simular: no toma candados, no manda Telegram, no encola nada", async () => {
  const { d, telegram, cola, candados } = deps();
  const r = await procesarEntregasActuar([LUCERO, PAP_A, PAP_B], AHORA, APROBADA, d, true);
  assertEquals(r.map((x) => x.resultado), ["simulado", "línea base (se registra sin avisar)", "línea base (se registra sin avisar)"]);
  assertEquals([telegram.length, cola.length, candados.size], [0, 0, 0]);
});

Deno.test("pedidos parados: VT-1064 y VT-1070 salen pendientes de despacho; VT-1072 (ya salió) no está; un Telegram por día desde las 9:00", async () => {
  // Contenido de la vista pedidos_parados (inventado): el pedido #1072 salió, por eso no figura.
  const ps = [par("#1060", 133.8, "Ciudad A"), par("#1070", 101.4, "Ciudad B", { producto: "Ejercitador de mandibula JawFlex Pro" }), par("#1064", 123.3, "Ciudad C", { producto: "Ejercitador de mandibula JawFlex Pro" })];
  const { d, telegram, candados } = deps();
  const a830 = new Date("2026-10-21T11:30:00Z"); // 08:30 en Paraguay
  assertEquals((await avisarParadosDiario(ps, a830, {}, d)).resultado, "fuera_de_hora");
  const a900 = new Date("2026-10-21T12:00:00Z"); // 09:00 en Paraguay
  assertEquals((await avisarParadosDiario(ps, a900, {}, d)).resultado, "avisado");
  assertEquals(telegram.length, 1);
  assertStringIncludes(telegram[0], "3 pedidos sin despachar hace +24 h");
  assertStringIncludes(telegram[0], "#1064 Ciudad C 5 d · sin despachar");
  assertStringIncludes(telegram[0], "#1070 Ciudad B 4 d · sin despachar");
  assert(!telegram[0].includes("#1072"));
  assert(telegram[0].indexOf("#1060") < telegram[0].indexOf("#1064") && telegram[0].indexOf("#1064") < telegram[0].indexOf("#1070"), "más viejo primero");
  assert(candados.has("auto_parados:2026-10-21"));
  // mismas horas más tarde: una sola vez al día
  assertEquals((await avisarParadosDiario(ps, new Date("2026-10-21T12:10:00Z"), {}, d)).resultado, "ya_avisado");
  assertEquals(telegram.length, 1);
  // al día siguiente vuelve a salir
  assertEquals((await avisarParadosDiario(ps, new Date("2026-10-22T12:00:00Z"), {}, d)).resultado, "avisado");
  assertEquals(telegram.length, 2);
  // pasado el mediodía ya no (lo cubre el resumen de las 21:30)
  assertEquals((await avisarParadosDiario(ps, new Date("2026-10-23T15:30:00Z"), {}, d)).resultado, "fuera_de_hora");
});

Deno.test("pedidos parados: sin parados no hay Telegram ni candado; con falla de Telegram se reintenta", async () => {
  const { d, telegram, candados } = deps();
  const a900 = new Date("2026-10-21T12:00:00Z");
  assertEquals((await avisarParadosDiario([], a900, {}, d)).resultado, "sin_parados");
  assertEquals([telegram.length, candados.size], [0, 0]);
  const f = deps({ telegramFalla: 3 });
  const ps = [par("#1", 30, "X")];
  assertStringIncludes((await avisarParadosDiario(ps, a900, {}, f.d)).resultado, "error");
  assertEquals((await avisarParadosDiario(ps, new Date(a900.getTime() + 600_000), {}, f.d)).resultado, "avisado");
});

Deno.test("rendición atrasada: Telegram con el monto, una vez por entrega", async () => {
  const r: FilaRendicion = { ref: "VT-9010", courier: "lucero", dias: 5, montoNeto: 100000, fechaEntrega: "2026-10-16" };
  const { d, telegram } = deps();
  assertEquals((await avisarRendicionAtrasada([r], d))[0].resultado, "avisado");
  assertEquals((await avisarRendicionAtrasada([r], d))[0].resultado, "ya_avisado");
  assertEquals(telegram.length, 1);
  assertStringIncludes(telegram[0], "Lucero");
  assertStringIncludes(telegram[0], "VT-9010");
  assertStringIncludes(telegram[0], "Gs 100.000");
  // otra entrega, otro aviso; lista vacía = nada
  await avisarRendicionAtrasada([r, { ...r, ref: "VT-9011", courier: "pap", dias: 16, fechaEntrega: "2026-10-05" }], d);
  assertEquals(telegram.length, 2);
  assertEquals(await avisarRendicionAtrasada([], d), []);
});

Deno.test("textos: Lucero y PaP escapan el motivo del courier", () => {
  assertStringIncludes(textoLucero({ ...LUCERO, motivo: "<b>x</b>" }, "encolado"), "&lt;b&gt;x&lt;/b&gt;");
  assertStringIncludes(textoPap({ ...PAP_A, estado: "Custodio", motivo: "" }), "PaP: Custodio. PaP no reintenta");
});

// ── 27-10: tipo y destino de cada aviso (telegram_politica.ts) + un solo aviso por falla de Lucero ──
function depsConOpts(textoCourier?: string | null) {
  const candados = new Set<string>(), llamadas: Array<{ texto: string; opts?: OpcionesAviso }> = [];
  const d: DepsActuar = {
    tomarCandado: (id) => Promise.resolve(candados.has(id) ? false : (candados.add(id), true)),
    soltarCandado: (id) => Promise.resolve(void candados.delete(id)),
    existeCandado: (id) => Promise.resolve(candados.has(id)),
    avisar: (texto, _b, opts) => (llamadas.push({ texto, opts }), Promise.resolve({ ok: true })),
    esperar: () => Promise.resolve(),
    ...(textoCourier !== undefined ? { textoCourierLucero: () => Promise.resolve(textoCourier) } : {}),
  };
  return { d, llamadas };
}

Deno.test("27-10: Lucero fallido = UN aviso para Enrique con el texto para Lucero; PaP última chance = Enrique", async () => {
  const { d, llamadas } = depsConOpts("📦 <b>Para reenviar a Lucero</b> (#9002):\n<pre>Hola…</pre>");
  const papReciente = { ...PAP_B, fechaIngreso: "2026-10-20" }; // reciente: no cae en la línea base
  await procesarEntregasActuar([LUCERO, papReciente], AHORA, CFG_REPROGRAMAR_APAGADA, d);
  await procesarEntregasActuar([LUCERO, papReciente], AHORA, CFG_REPROGRAMAR_APAGADA, d); // segunda corrida: nada nuevo
  const lucero = llamadas.filter((l) => l.opts?.tipo === "no_entregado_reintentar");
  assertEquals(lucero.length, 1);
  assertEquals(lucero[0].opts, { tipo: "no_entregado_reintentar", destino: "enrique", pedido: "#9002", unaVezPorDia: true, clave: "9002" });
  assertStringIncludes(lucero[0].texto, "entrega fallida");
  assertStringIncludes(lucero[0].texto, "Para reenviar a Lucero");
  // misma clave que usa procesar-envios con '#9002'
  assertEquals(claveNoEntregado("#9002"), claveNoEntregado(LUCERO.ref));
  const pap = llamadas.filter((l) => l.opts?.tipo === "pap_ultima_chance");
  assertEquals(pap.length, 1);
  assertEquals(pap[0].opts?.destino, "enrique");
  assertEquals(pap[0].opts?.pedido, "#9004");
});

Deno.test("27-10: sin datos del pedido, el aviso de Lucero sale igual (sin el bloque para el courier)", async () => {
  const { d, llamadas } = depsConOpts(null);
  await procesarEntregasActuar([LUCERO], AHORA, CFG_REPROGRAMAR_APAGADA, d);
  assertEquals(llamadas.length, 1);
  assert(!llamadas[0].texto.includes("Para reenviar"));
  const sinDep = depsConOpts();
  await procesarEntregasActuar([LUCERO], AHORA, CFG_REPROGRAMAR_APAGADA, sinDep.d);
  assertEquals(sinDep.llamadas.length, 1);
});

Deno.test("27-10: parados y rendición → destino enrique con su tipo (van al resumen por la política)", async () => {
  const { d, llamadas } = depsConOpts();
  await avisarParadosDiario([par("#9100", 30, "Luque")], new Date("2026-10-21T12:30:00Z"), {}, d);
  await avisarRendicionAtrasada([{ ref: "VT-9010", courier: "lucero", dias: 9, montoNeto: 100000, fechaEntrega: "2026-10-12" }], d);
  assertEquals(llamadas.map((l) => l.opts), [
    { tipo: "pedidos_sin_despachar_24h", destino: "enrique" },
    { tipo: "rendicion_atrasada", destino: "enrique", pedido: "#9010" },
  ]);
});
