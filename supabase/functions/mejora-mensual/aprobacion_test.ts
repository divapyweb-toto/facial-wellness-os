// Pruebas de la máquina de estados del ciclo mensual y de los botones mej_* (datos inventados,
// dependencias falsas en memoria: nada de red ni base).
import { assert, assertEquals, assertStringIncludes } from "jsr:@std/assert@1";
import {
  type CambioMin,
  type Ciclo,
  CONFIG_POR_DEFECTO,
  type ConfigMejora,
  decidirMejora,
  type DepsCiclo,
  type DepsDecision,
  dentroVentanaArranque,
  ejecutarCiclo,
  type EstadoVersion,
  leerConfig,
  maximoPorTope,
  mesAnterior,
  muestraPareja,
  parsearCallbackMejora,
  type PruebaResultado,
} from "./aprobacion.ts";
import { type Dependencias, procesarUpdate, type TgUpdate } from "../telegram-webhook/procesar.ts";

const AHORA = new Date("2026-11-01T12:00:00Z"); // 1-nov 09:00 Asunción → analiza octubre

type Conv = { id: string; texto: string };
type Version = { id: string; numero: number; estado: EstadoVersion; prompt: string; ciclo_id?: string | null };

function convs(n: number): Conv[] {
  return Array.from({ length: n }, (_, i) => ({ id: `conv-${i + 1}`, texto: "[NOMBRE_1] pregunta por el precio" }));
}

const PRUEBA_OK: PruebaResultado = { aprobada: true, casos: 50, prohibidas: 0, precios_fuera: 0, tono_prom: 4.6, detalle: "50/50" };

interface Opciones {
  total?: number;
  loteTerminaEn?: number; // en qué consulta termina el lote (0 = al crearlo)
  prueba?: PruebaResultado;
  cambios?: CambioMin[];
  cfg?: Partial<ConfigMejora>;
  falla?: "sintetizar";
}

function mundo(o: Opciones = {}) {
  let reloj = AHORA.getTime();
  let tick = 0;
  const ciclos = new Map<string, Ciclo>();
  const versiones: Version[] = [{ id: "00000000-0000-4000-8000-000000000001", numero: 1, estado: "activa", prompt: "semilla" }];
  const cambiosGuardados: (CambioMin & { ciclo_id: string; aplicado: boolean })[] = [];
  const clasif = new Map<string, unknown>();
  const avisos: { html: string; botones?: unknown }[] = [];
  const llamadas: string[] = [];
  let consultas = 0;
  const idsVistos: number[] = [];
  const loteFin = o.loteTerminaEn ?? 1;
  const cfg: ConfigMejora = { ...CONFIG_POR_DEFECTO, ...(o.cfg ?? {}) };
  const cambios: CambioMin[] = o.cambios ?? [
    { tipo: "ejemplo", riesgo: "bajo", antes: null, despues: "ejemplo nuevo", motivo: "la respuesta corta cerró más entregados" },
    { tipo: "orden_objeciones", riesgo: "bajo", antes: ["precio"], despues: ["envio", "precio"], motivo: "el envío frena más que el precio" },
    { tipo: "precio", riesgo: "requiere_decision", antes: 129000, despues: 119000, motivo: "muchos abandonan en el precio" },
  ];

  const deps: DepsCiclo<Conv, Version> = {
    ahora: () => new Date(reloj),
    config: () => Promise.resolve(cfg),
    obtenerCiclo: (mes) => Promise.resolve(structuredClone([...ciclos.values()].find((c) => c.mes === mes) ?? null)),
    crearCiclo: (mes) => {
      const id = `c0000000-0000-4000-8000-${String(ciclos.size + 1).padStart(12, "0")}`;
      const c: Ciclo = {
        id, mes, estado: "recolectando", n_conversaciones: null, lote_id: null, costo_usd: 0, resumen: null, hallazgos: null,
        propuesta_version_id: null, prueba: null, telegram_message_id: null, error: null, actualizado_en: `t${tick++}`,
      };
      ciclos.set(id, c);
      return Promise.resolve(structuredClone(c));
    },
    actualizarCiclo: (id, cambiosC, visto) => {
      const c = ciclos.get(id)!;
      if (c.actualizado_en !== visto) return Promise.resolve(null);
      Object.assign(c, cambiosC, { actualizado_en: `t${tick++}` });
      return Promise.resolve(structuredClone(c));
    },
    recolectar: (_mes) => {
      llamadas.push("recolectar");
      return Promise.resolve({ conversaciones: convs(o.total ?? 250), total: o.total ?? 250 });
    },
    crearLote: (cs) => {
      llamadas.push(`lote:${cs.length}`);
      return Promise.resolve({ id: "msgbatch_prueba", estado: loteFin === 0 ? "ended" : "in_progress", n: cs.length, ids: cs.map((c) => c.id) });
    },
    consultarLote: (id, ciclo) => {
      consultas++;
      idsVistos.push(ciclo.resumen?.muestra_ids?.length ?? 0);
      llamadas.push("consultar");
      return Promise.resolve({ id, estado: consultas >= loteFin ? "ended" : "in_progress" });
    },
    leerResultados: () =>
      Promise.resolve({
        clasificaciones: convs(o.total ?? 250).map((c) => ({ conversacion_id: c.id, etiquetas: { etapa: "cierre" } })),
        costo_usd: 0.4,
        invalidas: 1,
      }),
    guardarClasificaciones: (cid, filas) => {
      for (const f of filas) clasif.set(`${cid}:${f.conversacion_id}`, f.etiquetas); // upsert
      return Promise.resolve();
    },
    agregados: () => Promise.resolve({ n: clasif.size }),
    sintetizar: () => {
      llamadas.push("sintetizar");
      if (o.falla === "sintetizar") return Promise.reject(new Error("Claude 529 overloaded"));
      return Promise.resolve({
        hallazgos: { aprendizajes: ["El envío gratis cierra más que el descuento", "Responder en 2 líneas sube entregados", "Los reclamos se resuelven en el paso 2", "cuarta"] },
        costo_usd: 0.3,
      });
    },
    aprendizajes: (h) => (h as { aprendizajes: string[] }).aprendizajes,
    versionActiva: () => Promise.resolve(structuredClone(versiones.find((v) => v.estado === "activa") ?? null)),
    proponer: (_h, activa) => {
      llamadas.push(`proponer:${activa?.numero}`);
      return Promise.resolve({ version: { id: "", numero: 0, estado: "propuesta", prompt: "nuevo" } as Version, cambios });
    },
    guardarPropuesta: (cicloId, v, cs) => {
      let ya = versiones.find((x) => x.ciclo_id === cicloId && x.estado === "propuesta");
      if (!ya) {
        ya = { ...v, id: `00000000-0000-4000-8000-00000000000${versiones.length + 1}`, numero: versiones.length + 1, estado: "propuesta", ciclo_id: cicloId };
        versiones.push(ya);
        for (const c of cs) cambiosGuardados.push({ ...c, ciclo_id: cicloId, aplicado: false });
      }
      return Promise.resolve({ id: ya.id, numero: ya.numero, estado: ya.estado });
    },
    guardarPropuestaSoloCambios: (cicloId, cs) => {
      for (const c of cs) cambiosGuardados.push({ ...c, ciclo_id: cicloId, aplicado: false });
      return Promise.resolve();
    },
    obtenerVersion: (id) => Promise.resolve(structuredClone(versiones.find((v) => v.id === id) ?? null)),
    probar: () => {
      llamadas.push("probar");
      return Promise.resolve({ ...(o.prueba ?? PRUEBA_OK), costo_usd: 0.1 });
    },
    marcarVersion: (id, estado) => {
      versiones.find((v) => v.id === id)!.estado = estado;
      return Promise.resolve();
    },
    avisar: (html, botones) => {
      avisos.push({ html, botones });
      return Promise.resolve({ ok: true, message_id: 900 + avisos.length });
    },
  };

  // Dependencias de las decisiones (mismo "mundo").
  const candados = new Set<string>();
  const enviados: string[] = [];
  const decision: DepsDecision = {
    ahora: () => new Date(reloj),
    obtenerCiclo: (id) => Promise.resolve(structuredClone(ciclos.get(id) ?? null)),
    versionPorId: (id) => Promise.resolve(structuredClone(versiones.find((v) => v.id === id) ?? null)),
    versionPorNumero: (n) => Promise.resolve(structuredClone(versiones.find((v) => v.numero === n) ?? null)),
    versionActiva: () => Promise.resolve(structuredClone(versiones.find((v) => v.estado === "activa") ?? null)),
    activarVersion: (id, permitidos) => {
      // Igual que la función SQL mejora_activar_version.
      const v = versiones.find((x) => x.id === id);
      if (!v) return Promise.resolve({ ok: false, error: "la versión no existe" });
      if (v.estado === "activa") return Promise.resolve({ ok: true, ya_activa: true, anterior: null });
      if (!permitidos.includes(v.estado)) return Promise.resolve({ ok: false, error: `la versión ${v.numero} está ${v.estado}` });
      const ant = versiones.find((x) => x.estado === "activa");
      if (ant) ant.estado = "archivada";
      v.estado = "activa";
      return Promise.resolve({ ok: true, ya_activa: false, anterior: ant?.numero ?? null });
    },
    marcarVersion: deps.marcarVersion,
    marcarCambiosAplicados: (cid) => {
      for (const c of cambiosGuardados) if (c.ciclo_id === cid && c.riesgo === "bajo") c.aplicado = true;
      return Promise.resolve();
    },
    actualizarEstadoCiclo: (id, estado) => {
      ciclos.get(id)!.estado = estado;
      return Promise.resolve();
    },
    listarCambios: (cid) => Promise.resolve(cambiosGuardados.filter((c) => c.ciclo_id === cid)),
    reclamar: (clave) => {
      if (candados.has(clave)) return Promise.resolve(false);
      candados.add(clave);
      return Promise.resolve(true);
    },
    liberar: (clave) => {
      candados.delete(clave);
      return Promise.resolve();
    },
    enviarMensaje: (html) => {
      enviados.push(html);
      return Promise.resolve({ ok: true, message_id: 1 });
    },
  };

  return {
    deps, decision, ciclos, versiones, cambiosGuardados, avisos, llamadas, enviados, candados, idsVistos,
    avanzar: (min: number) => (reloj += min * 60_000),
    ciclo: () => [...ciclos.values()][0],
  };
}

const activas = (vs: Version[]) => vs.filter((v) => v.estado === "activa");

Deno.test("utilidades: mes anterior, ventana, config, muestra, tope", () => {
  assertEquals(mesAnterior(AHORA), "2026-10-01");
  assertEquals(mesAnterior(new Date("2027-01-01T12:00:00Z")), "2026-12-01");
  // 1-nov 00:30 UTC = 31-oct 21:30 en Asunción: todavía no arranca.
  assert(!dentroVentanaArranque(new Date("2026-11-01T00:30:00Z")));
  assert(!dentroVentanaArranque(new Date("2026-11-01T11:59:00Z")));
  assert(dentroVentanaArranque(AHORA));
  assert(dentroVentanaArranque(new Date("2026-11-03T20:00:00Z")));
  assert(!dentroVentanaArranque(new Date("2026-11-04T12:00:00Z")));
  assertEquals(leerConfig({ tope_usd: 5, min_conversaciones: "x" }).tope_usd, 5);
  assertEquals(leerConfig({ tope_usd: 5, min_conversaciones: "x" }).min_conversaciones, 100);
  assertEquals(leerConfig(null), CONFIG_POR_DEFECTO);
  assertEquals(muestraPareja([1, 2, 3, 4, 5, 6], 3), [1, 3, 5]);
  assertEquals(maximoPorTope({ ...CONFIG_POR_DEFECTO, tope_usd: 3, reserva_usd: 1 }, 0.01), 200);
  assertEquals(parsearCallbackMejora("mej_volver:3"), { accion: "mej_volver", numero: 3 });
  assertEquals(parsearCallbackMejora("mej_aplicar:no-es-uuid"), null);
  assertEquals(parsearCallbackMejora("mej_volver:0"), null);
});

Deno.test("ciclo completo: lote en espera, se reanuda, propone, prueba y pide aprobación (una sola vez)", async () => {
  const m = mundo({ loteTerminaEn: 2 });
  const r1 = await ejecutarCiclo(m.deps);
  assertEquals(r1.tipo, "esperando_lote");
  assertEquals(m.ciclo().estado, "clasificando");
  assertEquals(m.ciclo().n_conversaciones, 250);

  m.avanzar(30);
  assertEquals((await ejecutarCiclo(m.deps)).tipo, "esperando_lote"); // primera consulta: sigue en curso
  m.avanzar(30);
  const r3 = await ejecutarCiclo(m.deps);
  assertEquals(r3.tipo, "terminado");
  const c = m.ciclo();
  assertEquals(c.estado, "esperando_aprobacion");
  assertEquals(c.costo_usd, 0.8); // 0,4 clasificación + 0,3 síntesis + 0,1 prueba
  assertEquals(c.telegram_message_id, 901);
  assertEquals(m.versiones.find((v) => v.id === c.propuesta_version_id)?.estado, "propuesta");
  assertEquals(m.llamadas.filter((x) => x.startsWith("lote:")), ["lote:250"]);
  assertEquals(m.llamadas.filter((x) => x === "sintetizar").length, 1);
  // Las corridas siguientes consultan el lote con los ids de la muestra (para detectar faltantes).
  assertEquals(m.idsVistos, [250, 250]);
  assertEquals(c.resumen?.muestra_ids?.length, 250);

  // Mensaje corto: 3 aprendizajes, riesgo, prueba, costo y los 3 botones.
  assertEquals(m.avisos.length, 1);
  const html = m.avisos[0].html;
  assertStringIncludes(html, "octubre 2026");
  assertStringIncludes(html, "El envío gratis cierra más que el descuento");
  assert(!html.includes("cuarta"));
  assertStringIncludes(html, "2 cambios de riesgo bajo");
  assertStringIncludes(html, "1 cambio requiere tu decisión");
  assertStringIncludes(html, "pasó · 50 casos · 0 palabras prohibidas · 0 precios fuera de catálogo · tono 4,6");
  assertStringIncludes(html, "USD 0,80 (tope USD 3,00)");
  const botones = (m.avisos[0].botones as { texto: string; callback: string }[][]).flat();
  assertEquals(botones.map((b) => b.texto), ["Aplicar", "Descartar", "Ver detalle"]);
  assertEquals(botones[0].callback, `mej_aplicar:${c.id}`);

  // Corridas siguientes del cron: no hacen nada (ni otro lote ni otro mensaje).
  m.avanzar(30);
  assertEquals((await ejecutarCiclo(m.deps)).tipo, "ya_terminado");
  assertEquals(m.avisos.length, 1);
});

Deno.test("mes con 40 conversaciones ⇒ sin_datos_suficientes, reporte corto y sin propuesta", async () => {
  const m = mundo({ total: 40 });
  const r = await ejecutarCiclo(m.deps);
  assertEquals(r.tipo, "terminado");
  assertEquals(m.ciclo().estado, "sin_datos_suficientes");
  assertEquals(m.ciclo().n_conversaciones, 40);
  assertEquals(m.avisos.length, 1);
  assertStringIncludes(m.avisos[0].html, "Hubo 40 conversaciones; hacen falta 100");
  assertStringIncludes(m.avisos[0].html, "No se propone ningún cambio");
  assert(!m.llamadas.some((x) => x.startsWith("lote") || x === "sintetizar" || x.startsWith("proponer")));
  assertEquals(m.versiones.length, 1);
  assertEquals((await ejecutarCiclo(m.deps)).tipo, "ya_terminado");
  assertEquals(m.avisos.length, 1);
});

Deno.test("tope de costo: recorta la muestra y lo informa", async () => {
  // 1.000 conversaciones; tope 1 − reserva 0,5 = 0,5 / 0,002 = 250 entran.
  const m = mundo({ total: 1000, loteTerminaEn: 0, cfg: { tope_usd: 1, reserva_usd: 0.5 } });
  await ejecutarCiclo(m.deps);
  assertEquals(m.llamadas.filter((x) => x.startsWith("lote:")), ["lote:250"]);
  assertEquals(m.ciclo().resumen?.recortado, true);
  assertStringIncludes(m.avisos[0].html, "muestra de 250 de 1.000 conversaciones");
});

Deno.test("la prueba falla ⇒ propuesta descartada, sin botón Aplicar", async () => {
  const m = mundo({ loteTerminaEn: 0, prueba: { ...PRUEBA_OK, aprobada: false, prohibidas: 1 } });
  await ejecutarCiclo(m.deps);
  assertEquals(m.ciclo().estado, "descartado");
  assertEquals(m.versiones[1].estado, "descartada");
  assertEquals(activas(m.versiones).map((v) => v.numero), [1]);
  assertStringIncludes(m.avisos[0].html, "no pasó la prueba (1 palabra(s) prohibida(s))");
  const textos = (m.avisos[0].botones as { texto: string }[][]).flat().map((b) => b.texto);
  assert(!textos.includes("Aplicar"));
});

Deno.test("solo cambios requiere_decision ⇒ no hay versión para aplicar", async () => {
  const m = mundo({ loteTerminaEn: 0, cambios: [{ tipo: "precio", riesgo: "requiere_decision", despues: 119000, motivo: "x" }] });
  await ejecutarCiclo(m.deps);
  assertEquals(m.ciclo().estado, "descartado");
  assertEquals(m.versiones.length, 1);
  assertEquals(m.cambiosGuardados.length, 1);
  assertStringIncludes(m.avisos[0].html, "Nada para aplicar automáticamente");
});

Deno.test("error transitorio: avisa una sola vez y el cron lo retoma desde el mismo paso", async () => {
  const m = mundo({ loteTerminaEn: 0, falla: "sintetizar" });
  const r1 = await ejecutarCiclo(m.deps);
  assertEquals(r1.tipo, "fallo");
  assertEquals(m.ciclo().estado, "sintetizando");
  assertEquals(m.avisos.length, 1);
  assertStringIncludes(m.avisos[0].html, "falló la mejora mensual");
  await ejecutarCiclo(m.deps);
  await ejecutarCiclo(m.deps);
  assertEquals(m.avisos.length, 1); // no se repite
  assertEquals(m.ciclo().resumen?.errores, 3);
  assertEquals(m.llamadas.filter((x) => x.startsWith("lote:")).length, 1); // no rehace la clasificación
});

Deno.test("fuera de fecha no arranca un ciclo nuevo", async () => {
  const m = mundo();
  m.avanzar(60 * 24 * 5); // 6 de noviembre
  assertEquals((await ejecutarCiclo(m.deps)).tipo, "fuera_de_fecha");
  assertEquals(m.ciclos.size, 0);
});

async function cicloListo() {
  const m = mundo({ loteTerminaEn: 0 });
  await ejecutarCiclo(m.deps);
  assertEquals(m.ciclo().estado, "esperando_aprobacion");
  return m;
}

Deno.test("aplicar dos veces ⇒ una sola activa, cambios bajos aplicados, requiere_decision no", async () => {
  const m = await cicloListo();
  const id = m.ciclo().id;
  const r1 = await decidirMejora(`mej_aplicar:${id}`, "Mejora mensual", m.decision);
  assertEquals(r1.tipo, "hecho");
  const r2 = await decidirMejora(`mej_aplicar:${id}`, "Mejora mensual", m.decision);
  assertEquals(r2.tipo, "ya_hecho");
  assertEquals(activas(m.versiones).map((v) => v.numero), [2]);
  assertEquals(m.versiones[0].estado, "archivada");
  assertEquals(m.ciclo().estado, "aplicado");
  assertEquals(m.cambiosGuardados.filter((c) => c.aplicado).map((c) => c.tipo), ["ejemplo", "orden_objeciones"]);
  assertEquals(m.cambiosGuardados.find((c) => c.riesgo === "requiere_decision")?.aplicado, false);
  // Confirmación con el botón para volver.
  assertStringIncludes(r1.edicion!.html, "aplicada la versión 2");
  assertStringIncludes(r1.edicion!.html, "NO se aplicaron");
  assertEquals(r1.edicion!.botones, [[{ texto: "Volver a la versión 1", callback: "mej_volver:1" }]]);
  // Descartar después de aplicar no hace nada.
  assertEquals((await decidirMejora(`mej_descartar:${id}`, "x", m.decision)).tipo, "ya_hecho");
  assertEquals(activas(m.versiones).map((v) => v.numero), [2]);
});

Deno.test("dos toques simultáneos de Aplicar ⇒ una sola activa", async () => {
  const m = await cicloListo();
  const id = m.ciclo().id;
  const rs = await Promise.all([
    decidirMejora(`mej_aplicar:${id}`, "x", m.decision),
    decidirMejora(`mej_aplicar:${id}`, "x", m.decision),
  ]);
  assertEquals(rs.map((r) => r.tipo).sort(), ["hecho", "ya_hecho"]);
  assertEquals(activas(m.versiones).length, 1);
});

Deno.test("volver a la versión anterior y otra vez a la nueva", async () => {
  const m = await cicloListo();
  await decidirMejora(`mej_aplicar:${m.ciclo().id}`, "x", m.decision);
  const r = await decidirMejora("mej_volver:1", "Aplicada", m.decision);
  assertEquals(r.tipo, "hecho");
  assertEquals(activas(m.versiones).map((v) => v.numero), [1]);
  assertEquals(m.versiones[1].estado, "archivada");
  assertEquals(r.edicion!.botones, [[{ texto: "Volver a la versión 2", callback: "mej_volver:2" }]]);
  assertEquals((await decidirMejora("mej_volver:1", "x", m.decision)).tipo, "ya_hecho");
  assertEquals((await decidirMejora("mej_volver:2", "x", m.decision)).tipo, "hecho");
  assertEquals(activas(m.versiones).map((v) => v.numero), [2]);
  assertEquals((await decidirMejora("mej_volver:9", "x", m.decision)).tipo, "error");
});

Deno.test("descartar: la propuesta queda descartada y la activa no cambia", async () => {
  const m = await cicloListo();
  const id = m.ciclo().id;
  const r = await decidirMejora(`mej_descartar:${id}`, "x", m.decision);
  assertEquals(r.tipo, "hecho");
  assertEquals(m.ciclo().estado, "descartado");
  assertEquals(m.versiones[1].estado, "descartada");
  assertEquals(activas(m.versiones).map((v) => v.numero), [1]);
  assertEquals((await decidirMejora(`mej_aplicar:${id}`, "x", m.decision)).tipo, "ya_hecho");
  assertEquals(activas(m.versiones).map((v) => v.numero), [1]);
  // Una versión descartada no se puede "volver" a activar.
  assertEquals((await decidirMejora("mej_volver:2", "x", m.decision)).tipo, "error");
});

Deno.test("ver detalle: lista los requiere_decision como no aplicables", async () => {
  const m = await cicloListo();
  const r = await decidirMejora(`mej_detalle:${m.ciclo().id}`, "x", m.decision);
  assertEquals(r.tipo, "hecho");
  assertEquals(m.enviados.length, 1);
  assertStringIncludes(m.enviados[0], "Requieren tu decisión (1) · NO se aplican con el botón");
  assertStringIncludes(m.enviados[0], "precio");
  assertEquals(activas(m.versiones).map((v) => v.numero), [1]); // ver no cambia nada
});

// ─── Integración con telegram-webhook/procesar.ts ─────────────────────────────
function updateMej(data: string, updateId: number): TgUpdate {
  return {
    update_id: updateId,
    callback_query: {
      id: `cq${updateId}`,
      from: { id: 111 },
      data,
      message: { message_id: 5, date: 1700000000, chat: { id: 111 }, text: "Mejora mensual del vendedor" },
    },
  };
}

Deno.test("telegram-webhook enruta mej_* con idempotencia por update_id", async () => {
  const m = await cicloListo();
  const eventos = new Set<string>();
  const ediciones: unknown[] = [];
  const respuestas: string[] = [];
  const no = () => Promise.reject(new Error("no se usa"));
  const deps: Dependencias = {
    chatIdPermitido: "111",
    ahora: () => AHORA,
    guardarEventoCrudo: (id) => Promise.resolve(eventos.has(id) ? false : (eventos.add(id), true)),
    marcarEventoProcesado: () => Promise.resolve(),
    reclamarAccion: no,
    liberarAccion: no,
    obtenerPedido: no,
    cancelarEnShopify: no,
    marcarPedidoCancelado: no,
    cancelarEnviosPendientes: no,
    pasarAHumano: no,
    textoCliente: no,
    enviarTextoCliente: no,
    responderCallback: (_id, t) => (respuestas.push(t), Promise.resolve()),
    editarMensaje: (_c, _m, html, botones) => (ediciones.push({ html, botones }), Promise.resolve()),
    mejora: m.decision,
  };
  const r1 = await procesarUpdate(updateMej(`mej_aplicar:${m.ciclo().id}`, 1), deps);
  assertEquals(r1, { tipo: "mejora", data: `mej_aplicar:${m.ciclo().id}`, resultado: "hecho" });
  assertEquals((await procesarUpdate(updateMej(`mej_aplicar:${m.ciclo().id}`, 1), deps)).tipo, "repetido");
  assertEquals((await procesarUpdate(updateMej(`mej_aplicar:${m.ciclo().id}`, 2), deps)).tipo, "mejora");
  assertEquals(activas(m.versiones).length, 1);
  assertEquals(ediciones.length, 1);
  assertEquals(respuestas, ["Listo: versión 2 activa.", "Esta propuesta ya estaba aplicada."]);
  // Sin deps.mejora, un mej_* es un botón desconocido (comportamiento previo).
  const sin = { ...deps, mejora: undefined };
  const r = await procesarUpdate(updateMej("mej_volver:1", 3), sin);
  assertEquals(r.tipo, "ignorado");
});
