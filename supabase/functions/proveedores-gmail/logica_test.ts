// Pruebas de logica.ts con Gmail, agente y base FALSOS (en memoria). Nunca Google, nunca la base real. Datos DEMO.
import { assert, assertEquals, assertStringIncludes } from "@std/assert";
import { base64url, bytesDeBase64url, type ClienteGmail, type MensajeGmail, type ResultadoEnvio } from "./gmail.ts";
import {
  type AgenteGmail, type CandidatoRef, type ConfigProveedores, type Deps, enHorarioChina, type FilaMensaje, type IoGmail, type MensajeBase,
  type OrdenAviso, type PrimerContacto, procesarCorrida, type ProveedorGmail, type SalidaAgente, salientesSeguidos, tocaRecordatorio,
} from "./logica.ts";
import { redactarPrimerContacto, responderProveedor, textoCompromete } from "../_shared/proveedores/agente.ts";
import { simularRespuesta } from "../_shared/claude.ts";

// 2026-11-24 02:00 UTC = 10:00 China = 23:00 PY (horario de China). 18:00 UTC = 02:00 China (fuera).
const EN_CHINA = new Date("2026-11-24T02:00:00Z");
const FUERA_CHINA = new Date("2026-11-24T18:00:00Z");

const PROV: ProveedorGmail = { id: "prov-1", nombre: "Demo Factory", idioma: "zh", plataforma: "1688", email: "proveedor@example.com", no_contactar: false };
const CAND: CandidatoRef = { id: "cand-1", nombre: "Producto demo" };
const CFG: ConfigProveedores = { activo: true, tope_ia_usd_mes: 10, tope_plantillas_mes: 30, modelo: "claude-haiku-4-5", direccion_deposito: null, firma: "Voltra (Paraguay)" };

type Fila = Omit<FilaMensaje, "estado"> & { id: string; creado_en: string; estado: string };

function mensajeGmail(id: string, threadId: string, from: string, texto: string, extra: Partial<MensajeGmail> = {}): MensajeGmail {
  return {
    id, threadId, labelIds: ["INBOX"], ...extra,
    payload: {
      mimeType: "text/plain",
      headers: [{ name: "From", value: from }, { name: "Subject", value: "Quote" }, { name: "Message-ID", value: `<${id}@example.com>` }, { name: "Content-Type", value: "text/plain; charset=UTF-8" }],
      body: { data: base64url(texto) },
    },
  };
}

interface Escenario {
  cfg?: Partial<ConfigProveedores>;
  bandeja?: MensajeGmail[];
  proveedores?: ProveedorGmail[];
  filas?: Fila[];
  primeros?: PrimerContacto[];
  candidato?: CandidatoRef | null;
  salida?: Partial<SalidaAgente>;
  agenteFalla?: boolean;
  envio?: ResultadoEnvio;
  compromete?: string | null;
  ordenes?: OrdenAviso[];
  ordenFalla?: boolean;
  trackingOrden?: { id: string; estado: string } | null;
}

function armar(e: Escenario = {}) {
  const filas: Fila[] = [...(e.filas ?? [])];
  const enviados: Array<{ raw: string; threadId: string | null | undefined }> = [];
  const avisos: Array<{ texto: string; tipo: string; clave: string }> = [];
  const cotizaciones: unknown[] = [];
  const llamadasAgente: string[] = [];
  const leidos: Array<{ id: string; formato: string }> = [];
  const proveedores = e.proveedores ?? [PROV];
  const bandeja = e.bandeja ?? [];
  const yaAvisado = new Set<string>();
  const pagos: unknown[] = [];
  const trackings: unknown[] = [];
  let n = 0;

  const gmail: ClienteGmail = {
    perfil: () => Promise.resolve("voltra-demo@example.com"),
    listar: () => Promise.resolve(bandeja.map((m) => m.id)),
    leer: (id, formato) => { leidos.push({ id, formato }); return Promise.resolve(structuredClone(bandeja.find((m) => m.id === id)!)); },
    hilo: (id) => Promise.resolve({ id, messages: [mensajeGmail("ultimo", id, "voltra-demo@example.com", "hola")] }),
    enviar: (raw, threadId) => { enviados.push({ raw, threadId }); return Promise.resolve(e.envio ?? { ok: true, id: `gm-${enviados.length}`, threadId: threadId ?? "t-nuevo" }); },
  };
  const salida: SalidaAgente = {
    responder: true, texto: "您好，请报1000个的价格。", idioma: "zh", traduccion_es: "Hola, coticen 1000 unidades.", traduccion_entrante_es: "Precio 1,2 USD",
    frena: false, motivo: null, cotizacion: null, costo_usd: 0.0012, modelo: "claude-haiku-4-5", ...e.salida,
  };
  const agente: AgenteGmail = {
    responder: (en) => { llamadasAgente.push(`responder:${en.texto}`); return e.agenteFalla ? Promise.reject(new Error("API caída")) : Promise.resolve(salida); },
    primerContacto: (en) => { llamadasAgente.push(`primer:${en.pedido}`); return Promise.resolve(salida); },
    compromete: () => e.compromete ?? null,
  };
  const delProv = (pid: string) => filas.filter((f) => f.proveedor_id === pid);
  const io: IoGmail = {
    config: () => Promise.resolve({ ...CFG, ...e.cfg }),
    idsYaGuardados: (ids) => Promise.resolve(new Set(filas.filter((f) => f.id_externo && ids.includes(f.id_externo)).map((f) => f.id_externo!))),
    proveedorPorEmail: (em) => Promise.resolve(proveedores.find((p) => p.email === em) ?? null),
    proveedorDeHilo: (h) => {
      const f = filas.find((x) => x.hilo === h && x.direccion === "out");
      return Promise.resolve(f ? proveedores.find((p) => p.id === f.proveedor_id) ?? null : null);
    },
    proveedorPorId: (id) => Promise.resolve(proveedores.find((p) => p.id === id) ?? null),
    candidatoDeHilo: () => Promise.resolve(e.candidato === undefined ? CAND : e.candidato),
    ultimoCandidatoDe: () => Promise.resolve(null),
    candidatoPorId: (id) => Promise.resolve(id === CAND.id ? CAND : null),
    historialDe: () => Promise.resolve([]),
    mensajesDeHilo: (h) => Promise.resolve(filas.filter((f) => f.hilo === h) as MensajeBase[]),
    mensajesDeProveedor: (pid) => Promise.resolve(delProv(pid) as MensajeBase[]),
    hilosConSalientes: () => Promise.resolve([...new Set(filas.filter((f) => f.direccion === "out" && f.hilo).map((f) => f.hilo!))]),
    primerosContactosPendientes: () => Promise.resolve((e.primeros ?? []).filter((p) => filas.find((f) => f.id === p.id)?.estado === "AUTHORIZED")),
    permisoGeneralId: () => Promise.resolve("pol-general"),
    guardarMensaje: (fila) => {
      if (filas.some((f) => f.idempotencia === fila.idempotencia)) return Promise.resolve(null);
      const id = `fila-${++n}`;
      filas.push({ ...fila, id, creado_en: EN_CHINA.toISOString() });
      return Promise.resolve(id);
    },
    actualizarMensaje: (id, c) => { Object.assign(filas.find((f) => f.id === id)!, c); return Promise.resolve(); },
    tomarParaEnviar: (id) => {
      const f = filas.find((x) => x.id === id)!;
      if (f.estado !== "AUTHORIZED") return Promise.resolve(false);
      if (!f.politica_id || !f.candidato_id) throw new Error("la base frena: saliente sin política o producto");
      f.estado = "SENDING";
      return Promise.resolve(true);
    },
    cargarCotizacion: (c, ref) => { cotizaciones.push({ c, ref }); return Promise.resolve(); },
    avisarAdministracion: (texto, o) => {
      const k = `${o.tipo}|${o.clave}`; // una vez por día por clave (lo hace la io real)
      if (!yaAvisado.has(k)) { yaAvisado.add(k); avisos.push({ texto, ...o }); }
      return Promise.resolve();
    },
    registrarPagoPedido: (r) => { pagos.push(r); return e.ordenFalla ? Promise.reject(new Error("base caída")) : Promise.resolve({ id: "orden-1", estado: "BORRADOR", nueva: true }); },
    cargarTracking: (r) => { trackings.push(r); return Promise.resolve(e.trackingOrden === undefined ? { id: "orden-1", estado: "EN_TRANSITO" } : e.trackingOrden); },
    ordenesParaAvisar: () => Promise.resolve(e.ordenes ?? []),
    tipoCambio: () => Promise.resolve({ usd_pyg: 6400, cny_por_usd: 7.2 }),
  };
  return { filas, enviados, avisos, cotizaciones, llamadasAgente, leidos, pagos, trackings, deps: (ahora = EN_CHINA): Deps => ({ gmail, agente, io, ahora: () => ahora }) };
}

const DEL_PROV = mensajeGmail("m1", "t1", "Demo Factory <Proveedor@Example.com>", "单价1.2美元\n\nOn Mon, Nov 23, 2026 Voltra wrote:\n> price?");
const decRaw = (raw: string) => new TextDecoder().decode(bytesDeBase64url(raw));
/** Cuerpo del correo armado (MIME con el texto en base64). */
const cuerpo = (raw: string) => {
  const mime = decRaw(raw);
  const b64 = mime.slice(mime.search(/\r?\n\r?\n/)).replace(/\s+/g, "");
  return new TextDecoder().decode(Uint8Array.from(atob(b64), (c) => c.charCodeAt(0)));
};

// ─── reglas puras ───
Deno.test("horario de China: 08–20 China = 21–09 Paraguay", () => {
  assert(enHorarioChina(new Date("2026-11-24T00:00:00Z"))); // 21:00 PY = 08:00 China
  assert(enHorarioChina(new Date("2026-11-24T11:59:00Z"))); // 08:59 PY
  assert(!enHorarioChina(new Date("2026-11-24T12:00:00Z"))); // 09:00 PY = 20:00 China
  assert(!enHorarioChina(new Date("2026-11-23T23:59:00Z"))); // 20:59 PY
});

const m = (id: string, direccion: "in" | "out", horas: number, estado = direccion === "in" ? "RECEIVED" : "SENT_CONFIRMED"): MensajeBase =>
  ({ id, direccion, estado, creado_en: new Date(EN_CHINA.getTime() - horas * 3_600_000).toISOString(), candidato_id: "cand-1", proveedor_id: "prov-1", hilo: "t1" });

Deno.test("salientesSeguidos: cuenta solo enviados después del último entrante", () => {
  assertEquals(salientesSeguidos([m("a", "out", 100), m("b", "in", 90), m("c", "out", 80), m("d", "out", 50), m("e", "out", 40, "FAILED")]), 2);
  assertEquals(salientesSeguidos([m("a", "out", 10), m("b", "in", 5)]), 0);
});

Deno.test("tocaRecordatorio: 48 h sin respuesta → uno solo; con 2 salientes seguidos, nada", () => {
  assertEquals(tocaRecordatorio([m("a", "in", 100), m("b", "out", 49)], EN_CHINA)?.id, "b");
  assertEquals(tocaRecordatorio([m("a", "in", 100), m("b", "out", 47)], EN_CHINA), null);
  assertEquals(tocaRecordatorio([m("b", "out", 120), m("c", "out", 60)], EN_CHINA), null); // ya hubo recordatorio
  assertEquals(tocaRecordatorio([m("b", "out", 60), m("c", "in", 50)], EN_CHINA), null); // respondió
});

// ─── corrida ───
Deno.test("interruptor apagado → no lee, no escribe, no manda", async () => {
  const t = armar({ cfg: { activo: false }, bandeja: [DEL_PROV] });
  const r = await procesarCorrida(t.deps(), { simular: false });
  assertEquals(r.activo, false);
  assertEquals(t.leidos.length + t.filas.length + t.enviados.length + t.avisos.length + t.llamadasAgente.length, 0);
});

Deno.test("proveedor por email: guarda el entrante sin citado, responde en el mismo hilo y queda SENT_CONFIRMED con costo", async () => {
  const t = armar({ bandeja: [DEL_PROV] });
  await procesarCorrida(t.deps(), { simular: false });
  const [entrada, salida] = t.filas;
  assertEquals([entrada.direccion, entrada.estado, entrada.autor, entrada.politica_id, entrada.id_externo, entrada.idempotencia], ["in", "RECEIVED", "proveedor", null, "m1", "email:in:m1"]);
  assertEquals(entrada.original, "单价1.2美元");
  assertEquals(entrada.traduccion, "Precio 1,2 USD");
  assertEquals(t.llamadasAgente, ["responder:单价1.2美元"]);
  assertEquals([salida.direccion, salida.estado, salida.autor, salida.politica_id, salida.candidato_id, salida.id_externo, salida.hilo], ["out", "SENT_CONFIRMED", "agente", "pol-general", "cand-1", "gm-1", "t1"]);
  assertEquals(salida.costo_usd, 0.0012);
  assertEquals(salida.idempotencia, "email:out:t1:m1:1");
  assertEquals(t.enviados.length, 1);
  assertEquals(t.enviados[0].threadId, "t1");
  const raw = decRaw(t.enviados[0].raw);
  assertStringIncludes(raw, "To: proveedor@example.com");
  assertStringIncludes(raw, "In-Reply-To: <m1@example.com>");
});

Deno.test("dedupe: la segunda corrida no vuelve a leer ni a responder el mismo mensaje", async () => {
  const t = armar({ bandeja: [DEL_PROV] });
  await procesarCorrida(t.deps(), { simular: false });
  const leidos = t.leidos.length;
  await procesarCorrida(t.deps(), { simular: false });
  assertEquals(t.enviados.length, 1);
  assertEquals(t.llamadasAgente.length, 1);
  assertEquals(t.leidos.length, leidos);
});

Deno.test("proveedor por hilo nuestro (remitente distinto) sí; otros remitentes y los nuestros no se tocan", async () => {
  const previa: Fila = { id: "f0", canal: "email", direccion: "out", estado: "SENT_CONFIRMED", autor: "agente", proveedor_id: "prov-1", candidato_id: "cand-1", politica_id: "pol-general", idempotencia: "x", id_externo: "g0", hilo: "t9", asunto: null, original: "hi", traduccion: null, idioma: "zh", costo_usd: 0, creado_en: EN_CHINA.toISOString() };
  const t = armar({
    filas: [previa],
    bandeja: [
      mensajeGmail("m2", "t9", "Otra persona <colega@example.com>", "We can do blue."),
      mensajeGmail("m3", "t3", "Cliente <cliente@example.com>", "¿Tienen stock?"),
      mensajeGmail("m4", "t4", "Voltra <voltra-demo@example.com>", "nuestro", { labelIds: ["SENT"] }),
    ],
  });
  const r = await procesarCorrida(t.deps(), { simular: false });
  assertEquals(t.llamadasAgente, ["responder:We can do blue."]);
  assertEquals(r.ignorados, 1);
  assert(!t.leidos.some((l) => l.id === "m3" && l.formato === "full")); // el correo del cliente ni se abre entero
  assertEquals(t.filas.filter((f) => f.direccion === "in").map((f) => f.id_externo), ["m2"]);
});

Deno.test("no_contactar → se ignora", async () => {
  const t = armar({ bandeja: [DEL_PROV], proveedores: [{ ...PROV, no_contactar: true }] });
  await procesarCorrida(t.deps(), { simular: false });
  assertEquals(t.filas.length + t.enviados.length, 0);
});

Deno.test("agente frena sin responder → aviso a administración una vez por hilo y día, nada sale, costo en el entrante", async () => {
  const t = armar({
    bandeja: [DEL_PROV, mensajeGmail("m5", "t1", "proveedor@example.com", "Please pay the deposit")],
    salida: { responder: false, texto: null, frena: true, motivo: "pago", costo_usd: 0.002 },
  });
  await procesarCorrida(t.deps(), { simular: false });
  assertEquals(t.enviados.length, 0);
  assertEquals(t.avisos.length, 1);
  assertEquals([t.avisos[0].tipo, t.avisos[0].clave], ["proveedor_frena", "email:t1"]);
  assertEquals(t.filas.map((f) => [f.direccion, f.costo_usd]), [["in", 0.002], ["in", 0.002]]);
});

Deno.test("agente frena con texto neutro ('lo confirma el dueño') → sale el texto neutro y avisa", async () => {
  const t = armar({ bandeja: [DEL_PROV], salida: { frena: true, motivo: "muestra paga", texto: "样品费用需由负责人确认。" } });
  await procesarCorrida(t.deps(), { simular: false });
  assertEquals(t.enviados.length, 1);
  assertEquals(t.avisos.length, 1);
});

Deno.test("doble freno: el texto saliente compromete → no sale nada y avisa", async () => {
  const t = armar({ bandeja: [DEL_PROV], compromete: "compra" });
  await procesarCorrida(t.deps(), { simular: false });
  assertEquals(t.enviados.length, 0);
  assertEquals(t.filas.filter((f) => f.direccion === "out").length, 0);
  assertStringIncludes(t.avisos[0].texto, "compra");
});

Deno.test("tope de IA → aviso proveedor_tope_ia, nada sale", async () => {
  const t = armar({ bandeja: [DEL_PROV], salida: { responder: false, texto: null, frena: true, motivo: "tope_ia", costo_usd: 0 } });
  await procesarCorrida(t.deps(), { simular: false });
  assertEquals(t.enviados.length, 0);
  assertEquals(t.avisos.map((a) => a.tipo), ["proveedor_tope_ia"]);
});

Deno.test("sin producto conocido → la respuesta queda DRAFT (no sale) y avisa", async () => {
  const t = armar({ bandeja: [DEL_PROV], candidato: null });
  await procesarCorrida(t.deps(), { simular: false });
  assertEquals(t.enviados.length, 0);
  assertEquals(t.filas.find((f) => f.direccion === "out")?.estado, "DRAFT");
  assertEquals(t.avisos.length, 1);
});

Deno.test("falla el envío (Google contesta error) → FAILED; corte de red → SEND_UNKNOWN", async () => {
  const t = armar({ bandeja: [DEL_PROV], envio: { ok: false, error: "Gmail send: HTTP 500", seguro: true } });
  await procesarCorrida(t.deps(), { simular: false });
  assertEquals(t.filas.find((f) => f.direccion === "out")?.estado, "FAILED");
  const t2 = armar({ bandeja: [DEL_PROV], envio: { ok: false, error: "reset", seguro: false } });
  await procesarCorrida(t2.deps(), { simular: false });
  assertEquals(t2.filas.find((f) => f.direccion === "out")?.estado, "SEND_UNKNOWN");
});

Deno.test("el agente falla → el entrante queda guardado, no sale nada, avisa", async () => {
  const t = armar({ bandeja: [DEL_PROV], agenteFalla: true });
  await procesarCorrida(t.deps(), { simular: false });
  assertEquals(t.filas.length, 1);
  assertEquals(t.enviados.length, 0);
  assertEquals(t.avisos.length, 1);
});

Deno.test("cotización completa → se carga y va el resumen a administración", async () => {
  const cot = { moneda: "USD", escalones: [{ cantidad: 1000, precio_unit_minor: 120 }], peso_bruto_g: 15, medidas_caja_cm: "40x30x20", unidades_por_caja: 200, plazo_dias: 7, completa: true };
  const t = armar({ bandeja: [DEL_PROV], salida: { cotizacion: cot } });
  await procesarCorrida(t.deps(), { simular: false });
  assertEquals(t.cotizaciones.length, 1);
  assertEquals((t.cotizaciones[0] as { ref: unknown }).ref, { candidatoId: "cand-1", proveedorId: "prov-1", mensajeId: "fila-1", canal: "email" });
  assertEquals(t.avisos[0].tipo, "proveedor_cotizacion");
  assertStringIncludes(t.avisos[0].texto, "1000 u: 1.20 USD");
});

Deno.test("simular: lee pero no escribe, no llama al agente ni manda", async () => {
  const t = armar({ cfg: { activo: false }, bandeja: [DEL_PROV] });
  const r = await procesarCorrida(t.deps(), { simular: true });
  assertEquals(t.filas.length + t.enviados.length + t.llamadasAgente.length + t.avisos.length, 0);
  assertEquals(r.hechos[0].accion, "respondería con el agente");
});

// ─── recordatorio y cadencia ───
const saliente = (id: string, horas: number, hilo = "t7"): Fila => ({
  id, canal: "email", direccion: "out", estado: "SENT_CONFIRMED", autor: "agente", proveedor_id: "prov-1", candidato_id: "cand-1", politica_id: "pol-general",
  idempotencia: `x-${id}`, id_externo: `g-${id}`, hilo, asunto: "Quote", original: "hi", traduccion: null, idioma: "zh", costo_usd: 0,
  creado_en: new Date(EN_CHINA.getTime() - horas * 3_600_000).toISOString(),
});

Deno.test("recordatorio: 48 h sin respuesta → uno solo (texto fijo en chino, sin IA); la corrida siguiente no repite", async () => {
  const t = armar({ filas: [saliente("s1", 50)] });
  await procesarCorrida(t.deps(), { simular: false });
  assertEquals(t.enviados.length, 1);
  assertEquals(t.enviados[0].threadId, "t7");
  assertEquals(t.llamadasAgente.length, 0);
  const rec = t.filas.find((f) => f.idempotencia === "email:out:t7:recordatorio:s1")!;
  assertEquals([rec.estado, rec.costo_usd], ["SENT_CONFIRMED", 0]);
  assertStringIncludes(rec.original!, "您好");
  await procesarCorrida(t.deps(new Date(EN_CHINA.getTime() + 72 * 3_600_000 - 24 * 3_600_000)), { simular: false });
  assertEquals(t.enviados.length, 1);
});

Deno.test("recordatorio: antes de 48 h o fuera del horario de China, nada", async () => {
  const t = armar({ filas: [saliente("s1", 30)] });
  await procesarCorrida(t.deps(), { simular: false });
  const t2 = armar({ filas: [saliente("s1", 50)] });
  await procesarCorrida(t2.deps(FUERA_CHINA), { simular: false });
  assertEquals(t.enviados.length + t2.enviados.length, 0);
});

Deno.test("cadencia: con 3 salientes seguidos sin respuesta no sale ni recordatorio ni primer contacto", async () => {
  const pc: Fila = { ...saliente("pc1", 0), hilo: null, estado: "AUTHORIZED", autor: "agente", id_externo: null, idempotencia: "pc1" };
  const t = armar({
    filas: [saliente("a", 200, "tA"), saliente("b", 150, "tB"), saliente("c", 60, "tC"), pc],
    primeros: [{ id: "pc1", proveedor_id: "prov-1", candidato_id: "cand-1", asunto: "Inquiry", original: "Hello", traduccion: "Hola" }],
  });
  await procesarCorrida(t.deps(), { simular: false });
  assertEquals(t.enviados.length, 0);
  assertEquals(t.filas.find((f) => f.id === "pc1")?.estado, "DRAFT");
  assertStringIncludes(t.avisos[0].texto, "3 mensajes seguidos");
});

// ─── primer contacto ───
const filaPrimer = (original: string | null): Fila => ({
  id: "pc1", canal: "email", direccion: "out", estado: "AUTHORIZED", autor: "agente", proveedor_id: "prov-1", candidato_id: "cand-1", politica_id: "pol-general",
  idempotencia: "email:out:prov-1:primer:1", id_externo: null, hilo: null, asunto: "询价", original, traduccion: "Pedir precio por 1000 y 3000", idioma: null, costo_usd: null,
  creado_en: EN_CHINA.toISOString(),
});
const PRIMER: PrimerContacto = { id: "pc1", proveedor_id: "prov-1", candidato_id: "cand-1", asunto: "询价", original: null, traduccion: "Pedir precio por 1000 y 3000" };

Deno.test("primer contacto: fuera del horario de China espera (queda AUTHORIZED, no sale)", async () => {
  const t = armar({ filas: [filaPrimer(null)], primeros: [PRIMER] });
  await procesarCorrida(t.deps(FUERA_CHINA), { simular: false });
  assertEquals(t.enviados.length, 0);
  assertEquals(t.filas[0].estado, "AUTHORIZED");
  assertEquals(t.llamadasAgente.length, 0);
});

Deno.test("primer contacto en horario de China: el agente redacta, sale sin threadId, guarda hilo, id y costo", async () => {
  const t = armar({ filas: [filaPrimer(null)], primeros: [PRIMER] });
  await procesarCorrida(t.deps(EN_CHINA), { simular: false });
  assertEquals(t.llamadasAgente, ["primer:Pedir precio por 1000 y 3000"]);
  assertEquals(t.enviados.length, 1);
  assertEquals(t.enviados[0].threadId, null);
  const f = t.filas[0];
  assertEquals([f.estado, f.hilo, f.id_externo, f.costo_usd, f.original], ["SENT_CONFIRMED", "t-nuevo", "gm-1", 0.0012, "您好，请报1000个的价格。"]);
  const raw = decRaw(t.enviados[0].raw);
  assertStringIncludes(raw, "To: proveedor@example.com");
  assertStringIncludes(raw, "Subject: =?UTF-8?B?");
  // segunda corrida: ya no está pendiente
  await procesarCorrida(t.deps(EN_CHINA), { simular: false });
  assertEquals(t.enviados.length, 1);
});

Deno.test("primer contacto con texto ya escrito: no llama a la IA", async () => {
  const t = armar({ filas: [filaPrimer("Hello, could you quote 1000 pcs?")], primeros: [{ ...PRIMER, original: "Hello, could you quote 1000 pcs?" }] });
  await procesarCorrida(t.deps(EN_CHINA), { simular: false });
  assertEquals(t.llamadasAgente.length, 0);
  assertEquals(t.filas[0].estado, "SENT_CONFIRMED");
});

Deno.test("primer contacto: proveedor sin correo → DRAFT y aviso; falla de envío → FAILED", async () => {
  const t = armar({ filas: [filaPrimer("Hi")], primeros: [{ ...PRIMER, original: "Hi" }], proveedores: [{ ...PROV, email: null }] });
  await procesarCorrida(t.deps(EN_CHINA), { simular: false });
  assertEquals(t.filas[0].estado, "DRAFT");
  assertEquals(t.avisos.length, 1);
  const t2 = armar({ filas: [filaPrimer("Hi")], primeros: [{ ...PRIMER, original: "Hi" }], envio: { ok: false, error: "HTTP 400", seguro: true } });
  await procesarCorrida(t2.deps(EN_CHINA), { simular: false });
  assertEquals(t2.filas[0].estado, "FAILED");
});

// ─── integración con el agente real (_shared/proveedores/agente.ts) en modo simulado: sin IA, sin red ───

function conAgenteReal(t: ReturnType<typeof armar>, gasto = 0): Deps {
  const d = t.deps();
  const depsAgente = { llamar: (p: Parameters<typeof simularRespuesta>[0]) => Promise.resolve(simularRespuesta(p)), gastoMesUsd: () => Promise.resolve(gasto), config: () => Promise.resolve(CFG) };
  return { ...d, agente: { responder: (e) => responderProveedor(e, depsAgente), primerContacto: (e) => redactarPrimerContacto(e, depsAgente), compromete: (x) => textoCompromete(x) } };
}

Deno.test("agente real: pedido de pago → frena, sale el texto neutro y avisa una vez", async () => {
  const t = armar({ bandeja: [mensajeGmail("m8", "t8", "proveedor@example.com", "Please confirm the order and pay the 30% deposit to our bank account.")] });
  await procesarCorrida(conAgenteReal(t), { simular: false });
  assertEquals(t.avisos.length, 1);
  assertEquals(t.avisos[0].tipo, "proveedor_frena");
  assertEquals(t.enviados.length, 1);
  assertEquals(textoCompromete(t.filas.find((f) => f.direccion === "out")!.original!), null);
});

Deno.test("agente real: tope de IA alcanzado → no sale nada, aviso de tope", async () => {
  const t = armar({ bandeja: [DEL_PROV] });
  await procesarCorrida(conAgenteReal(t, 10), { simular: false });
  assertEquals(t.enviados.length, 0);
  assertEquals(t.avisos.map((a) => a.tipo), ["proveedor_tope_ia"]);
});

// ─── 25-11: proceso de compra (pago por link de Alipay, seguimiento, dirección y post-pago) ───
const DEP = { en: "Demo Warehouse, 1 Demo Road, Shenzhen", zh: "深圳演示路1号", marca_maritimo: "DEMO-MAR", marca_aereo: "DEMO-AIR" };
const PAGO = { link: "https://qr.alipay.com/demo1", dominio: "qr.alipay.com", alipay: true, monto_minor: 72000, moneda: "CNY" as const, cantidad: 100 };

Deno.test("pago por link: orden en BORRADOR + UN aviso a Enrique con ¥/USD/₲ y el link; contesta el neutro", async () => {
  const t = armar({ bandeja: [DEL_PROV], salida: { frena: true, motivo: "pago", responder: true, texto: "谢谢。这部分需要老板确认。", pago: PAGO } });
  const r = await procesarCorrida(t.deps(), { simular: false });
  assertEquals(t.pagos.length, 1);
  assertEquals((t.pagos[0] as { candidatoId: string; mensajeId: string }).candidatoId, "cand-1");
  assertEquals(t.avisos.length, 1); // no se suma el aviso genérico de "frena"
  assertEquals(t.avisos[0].tipo, "proveedor_frena");
  assertStringIncludes(t.avisos[0].texto, "¥720,00");
  assertStringIncludes(t.avisos[0].texto, "≈ USD 100,00");
  assertStringIncludes(t.avisos[0].texto, "≈ ₲640.000");
  assertStringIncludes(t.avisos[0].texto, "<code>https://qr.alipay.com/demo1</code>");
  assertStringIncludes(t.avisos[0].texto, "BORRADOR");
  assertEquals(t.enviados.length, 1); // el neutro sale en el hilo
  assert(r.hechos.some((h) => h.accion === "pedido de pago"));
});

Deno.test("pago por link sin producto: no crea orden pero avisa igual; si la base falla, avisa igual", async () => {
  const t = armar({ bandeja: [DEL_PROV], candidato: null, salida: { frena: true, motivo: "pago", responder: false, texto: null, pago: PAGO } });
  await procesarCorrida(t.deps(), { simular: false });
  assertEquals([t.pagos.length, t.avisos.length], [0, 1]);
  assertStringIncludes(t.avisos[0].texto, "No pude crear la orden");
  const f = armar({ bandeja: [DEL_PROV], ordenFalla: true, salida: { frena: true, motivo: "pago", pago: PAGO } });
  const r = await procesarCorrida(f.deps(), { simular: false });
  assertEquals(f.avisos.length, 1);
  assert(r.hechos.some((h) => h.accion === "orden por pago falló"));
});

Deno.test("seguimiento: se carga en la orden y avisa a administración; sin orden, avisa que falta", async () => {
  const t = armar({ bandeja: [DEL_PROV], salida: { envio: { tracking: "SF1234567890123", empresa: "SF Express" } } });
  await procesarCorrida(t.deps(), { simular: false });
  assertEquals(t.trackings.length, 1);
  assertEquals(t.avisos.map((a) => a.tipo), ["proveedor_cotizacion"]);
  assertStringIncludes(t.avisos[0].texto, "EN_TRANSITO");
  const s = armar({ bandeja: [DEL_PROV], trackingOrden: null, salida: { envio: { tracking: "SF1234567890123", empresa: null } } });
  await procesarCorrida(s.deps(), { simular: false });
  assertStringIncludes(s.avisos[0].texto, "no encontré una orden");
});

const ORDEN = (estado: string, tipo: "direccion" | "postpago", via: "maritimo" | "aereo" = "maritimo"): OrdenAviso =>
  ({ orden: { id: "orden-9", estado, candidato_id: "cand-1", proveedor_id: "prov-1", tracking: null }, tipo, via, hilo: "t9" });

Deno.test("orden confirmada → dirección (marítima) una sola vez; aérea si la orden lo dice; post-pago después de pagar", async () => {
  const t = armar({ cfg: { deposito: DEP }, ordenes: [ORDEN("CONFIRMADA_POR_ENRIQUE", "direccion")] });
  await procesarCorrida(t.deps(FUERA_CHINA), { simular: false }); // cualquier hora
  assertEquals(t.enviados.length, 1);
  const txt = cuerpo(t.enviados[0].raw);
  assert(txt.includes("DEMO-MAR") && !txt.includes("DEMO-AIR"));
  assertEquals(t.enviados[0].threadId, "t9");
  assertEquals(t.filas.at(-1)?.idempotencia, "email:out:orden:orden-9:direccion");
  await procesarCorrida(t.deps(FUERA_CHINA), { simular: false });
  assertEquals(t.enviados.length, 1); // no repite
  const a = armar({ cfg: { deposito: DEP }, ordenes: [ORDEN("PEDIDA", "direccion", "aereo"), ORDEN("PAGADA_POR_ENRIQUE", "postpago")] });
  await procesarCorrida(a.deps(), { simular: false });
  assertEquals(a.enviados.length, 2);
  assert(cuerpo(a.enviados[0].raw).includes("DEMO-AIR"));
  assert(cuerpo(a.enviados[1].raw).includes("物流单号")); // proveedor en chino
});

Deno.test("orden confirmada sin depósito cargado: no manda dirección y avisa; simular no manda nada", async () => {
  const t = armar({ ordenes: [ORDEN("CONFIRMADA_POR_ENRIQUE", "direccion")] });
  await procesarCorrida(t.deps(), { simular: false });
  assertEquals([t.enviados.length, t.avisos.length], [0, 1]);
  const s = armar({ cfg: { deposito: DEP }, ordenes: [ORDEN("CONFIRMADA_POR_ENRIQUE", "direccion")] });
  const r = await procesarCorrida(s.deps(), { simular: true });
  assertEquals(s.enviados.length, 0);
  assert(r.hechos.some((h) => h.accion === "mandaría direccion"));
});
