// Tests del toque 3 (12-10): cuándo sale la plantilla de oferta, variables, topes, la corrida y el contrato con la
// plantilla y con wa-webhook. Datos inventados: repo público.
import { assert, assertEquals, assertFalse } from "@std/assert";
import { instanteLocal } from "../recompra/calendario.ts";
import { leerBotonConfirmacion, leerBotonMarketing, leerBotonPostventa, type MensajeMeta, textoParaVendedor } from "../wa-webhook/procesar.ts";
import { type Candidato, CFG_SEGUIMIENTO_DEFAULT, correrSeguimientos, type DepsSeguimiento } from "./logica.ts";
import {
  CANTIDAD_OFERTA,
  CFG_TOQUE3_DEFAULT,
  componentesToque3,
  correrToque3,
  decidirToque3,
  esFallaDePlantilla,
  handleToque3,
  type HistorialMk,
  leerCfgToque3,
  ofertaToque3,
  PAYLOAD_BAJA,
  payloadPedir,
  type PreciosToque3,
  primerNombre,
  productoConArticulo,
  type ResultadoEnvioWa,
  topeToque3,
} from "./toque3.ts";
import { configDesdeValor } from "../recompra/calendario.ts";

const H = 3_600_000;
const CFG = CFG_SEGUIMIENTO_DEFAULT;
const T3 = { ...CFG_TOQUE3_DEFAULT, activo: true };
// 15:00 de Asunción del 12-10.
const AHORA = instanteLocal("2026-10-12", 15);
const hace = (h: number, base = AHORA) => new Date(base.getTime() - h * H).toISOString();
const TIRAS = "tiras-nasales-gudair-30-unidades";
const PACK = "pack-gudair-tiras-nasales-parches-bucales";
const RASPADOR = "raspador-de-lengua-de-acero-inoxidable";

function cand(over: Partial<Candidato> = {}): Candidato {
  return {
    conversacion_id: "conv-1",
    cliente_id: "cli-1",
    estado: "ia",
    ultima_entrada_en: hace(30),
    perfil: { producto: "tiras nasales", seguimientos: 2 },
    ultimo_mensaje: { direccion: "out", creado_en: hace(29) },
    ultima_respuesta_derivada: false,
    pedido_reciente: false,
    baja_marketing: false,
    nombre: "Ana Prueba",
    telefono: "+595981000000",
    origen_anuncio_id: "ad-prueba-1",
    primera_respuesta_en: hace(50),
    plantillas_enviadas: [],
    consentimiento_marketing: "si",
    handle_anuncio: TIRAS,
    ...over,
  };
}

const motivo = (c: Candidato, ahora = AHORA, t3 = T3) => {
  const d = decidirToque3(c, CFG, t3, ahora);
  return d.tipo === "nada" ? d.motivo : "toque3";
};

// ---------- config ----------

Deno.test("toque 3 config: arranca apagado, con opt-in, 48-70 h; lo raro toma el default; nunca pasa de 72 h", () => {
  assertEquals(leerCfgToque3(null), CFG_TOQUE3_DEFAULT);
  assertEquals([CFG_TOQUE3_DEFAULT.activo, CFG_TOQUE3_DEFAULT.requiere_consentimiento], [false, true]);
  assertEquals([CFG_TOQUE3_DEFAULT.desde_h, CFG_TOQUE3_DEFAULT.hasta_h, CFG_TOQUE3_DEFAULT.sin_escribir_h], [48, 70, 24]);
  assertEquals(CFG_TOQUE3_DEFAULT.plantilla, "voltra_mk_seguimiento_oferta");
  assertEquals(leerCfgToque3({ toque3: { activo: true, requiere_consentimiento: false, desde_h: "x", plantilla: "Mal Nombre" } }), {
    ...CFG_TOQUE3_DEFAULT,
    activo: true,
    requiere_consentimiento: false,
  });
  assertEquals(leerCfgToque3({ toque3: { hasta_h: 90, desde_h: 80 } }).hasta_h, 71.5);
  assertEquals(leerCfgToque3({ toque3: { hasta_h: 90, desde_h: 80 } }).desde_h, 71.5);
  assertEquals(leerCfgToque3({ toque3: "si" }), CFG_TOQUE3_DEFAULT);
});

// ---------- decisión ----------

Deno.test("toque 3: entre 48 y 70 h desde la primera respuesta del bot (nunca después de 70 h)", () => {
  assertEquals(motivo(cand()), "toque3");
  assertEquals(motivo(cand({ primera_respuesta_en: hace(47.9) })), "esperando");
  assertEquals(motivo(cand({ primera_respuesta_en: hace(48) })), "toque3");
  assertEquals(motivo(cand({ primera_respuesta_en: hace(69.9) })), "toque3");
  assertEquals(motivo(cand({ primera_respuesta_en: hace(70) })), "fuera_de_las_72h");
  assertEquals(motivo(cand({ primera_respuesta_en: hace(100) })), "fuera_de_las_72h");
  assertEquals(motivo(cand({ primera_respuesta_en: null })), "sin_respuesta_del_bot");
});

Deno.test("toque 3: solo si el cliente no escribe hace ≥ 24 h (los recontactos 1 y 2 ya salieron o se saltearon)", () => {
  assertEquals(motivo(cand({ ultima_entrada_en: hace(23.9), ultimo_mensaje: { direccion: "out", creado_en: hace(23.8) } })), "escribio_hace_poco");
  assertEquals(motivo(cand({ ultima_entrada_en: hace(24), ultimo_mensaje: { direccion: "out", creado_en: hace(23.9) } })), "toque3");
  // Aunque se baje sin_escribir_h, nunca con la ventana de los recontactos 1 y 2 abierta (ventana_max_h 23,5 h).
  assertEquals(motivo(cand({ ultima_entrada_en: hace(20), ultimo_mensaje: { direccion: "out", creado_en: hace(19) } }), AHORA, { ...T3, sin_escribir_h: 6 }), "escribio_hace_poco");
  // Sin recontactos hechos (se saltearon) también sale: lo que manda es que la ventana de 24 h ya cerró.
  assertEquals(motivo(cand({ perfil: { producto: "tiras nasales" } })), "toque3");
  assertEquals(motivo(cand({ ultima_entrada_en: null })), "sin_entrada_del_cliente");
  assertEquals(motivo(cand({ ultimo_mensaje: { direccion: "in", creado_en: hace(30) } })), "cliente_hablo_ultimo");
});

Deno.test("toque 3: franja 12 a 21 de Asunción; si el rango no tiene ningún momento en franja, no sale", () => {
  const en = (t: Date) => cand({ primera_respuesta_en: hace(50, t), ultima_entrada_en: hace(30, t), ultimo_mensaje: { direccion: "out", creado_en: hace(29, t) } });
  for (const [h, m] of [[11, "fuera_de_horario"], [12, "toque3"], [20, "toque3"], [21, "fuera_de_horario"], [3, "fuera_de_horario"]] as const) {
    const t = instanteLocal("2026-10-12", h);
    assertEquals(motivo(en(t), t), m, `${h}:00`);
  }
  // Primera respuesta 22:00 del 10-10 → rango [22:00 del 12, 20:00 del 13): sale recién a las 12:00 del 13.
  const f1 = instanteLocal("2026-10-10", 22);
  const c1 = cand({ primera_respuesta_en: f1.toISOString(), ultima_entrada_en: new Date(f1.getTime() - 60_000).toISOString(), ultimo_mensaje: { direccion: "out", creado_en: f1.toISOString() } });
  const primero = barrido(c1, f1.getTime() + 40 * H, f1.getTime() + 75 * H).find(([, m]) => m === "toque3");
  assertEquals(primero?.[0], instanteLocal("2026-10-13", 12).toISOString());
  // Primera respuesta 1:00 del 10-10 (rango hasta 23:00 del 12) y el cliente escribió 21:30 del 11 (24 h = 21:30 del 12):
  // el rango útil [21:30, 23:00) no tiene franja → nunca sale.
  const f2 = instanteLocal("2026-10-10", 1);
  const e2 = new Date(instanteLocal("2026-10-11", 21).getTime() + 30 * 60_000);
  const c2 = cand({ primera_respuesta_en: f2.toISOString(), ultima_entrada_en: e2.toISOString(), ultimo_mensaje: { direccion: "out", creado_en: new Date(e2.getTime() + 60_000).toISOString() } });
  assertFalse(barrido(c2, f2.getTime() + 40 * H, f2.getTime() + 75 * H).some(([, m]) => m === "toque3"));
});

/** Decisión cada 10 min (como el cron) entre dos instantes. */
function barrido(c: Candidato, desde: number, hasta: number): Array<[string, string]> {
  const out: Array<[string, string]> = [];
  for (let t = desde; t < hasta; t += 10 * 60_000) out.push([new Date(t).toISOString(), motivo(c, new Date(t))]);
  return out;
}

Deno.test("toque 3: solo de anuncio, en 'ia', sin pedido, sin rechazo, sin derivación ni mensaje de Enrique, sin fecha pedida", () => {
  assertEquals(motivo(cand({ origen_anuncio_id: null })), "no_vino_de_anuncio");
  assertEquals(motivo(cand({ origen_anuncio_id: undefined })), "no_vino_de_anuncio");
  assertEquals(motivo(cand({ estado: "humano" })), "no_esta_en_ia");
  assertEquals(motivo(cand({ pedido_reciente: true })), "pedido_reciente");
  assertEquals(motivo(cand({ perfil: { producto: "tiras", rechazo: true } })), "rechazo");
  assertEquals(motivo(cand({ ultima_respuesta_derivada: true })), "derivado");
  assertEquals(motivo(cand({ ultimo_mensaje: { direccion: "out", creado_en: hace(29), manual: true } })), "enrique_escribio");
  assertEquals(motivo(cand({ perfil: { producto: "tiras", recontactar_el: "2026-10-15" } })), "espera_fecha_pedida");
});

Deno.test("toque 3: opt-in (consentimiento 'si' obligatorio por defecto); 'no' y 'baja' nunca", () => {
  assertEquals(motivo(cand({ consentimiento_marketing: null })), "sin_consentimiento");
  assertEquals(motivo(cand({ consentimiento_marketing: undefined })), "sin_consentimiento");
  assertEquals(motivo(cand({ consentimiento_marketing: "no" })), "consentimiento_no");
  assertEquals(motivo(cand({ consentimiento_marketing: "baja" })), "baja_marketing");
  assertEquals(motivo(cand({ baja_marketing: true })), "baja_marketing");
  const sinOptIn = { ...T3, requiere_consentimiento: false };
  assertEquals(motivo(cand({ consentimiento_marketing: null }), AHORA, sinOptIn), "toque3");
  assertEquals(motivo(cand({ consentimiento_marketing: "no" }), AHORA, sinOptIn), "consentimiento_no");
  assertEquals(motivo(cand({ consentimiento_marketing: "baja" }), AHORA, sinOptIn), "baja_marketing");
});

Deno.test("toque 3: nunca dos veces (marca toque3_en o la plantilla ya en wa_mensajes); tras una falla, 24 h sin reintentar", () => {
  assertEquals(motivo(cand({ perfil: { producto: "tiras", toque3_en: hace(1) } })), "ya_enviado");
  assertEquals(motivo(cand({ perfil: { producto: "tiras", toque3_en: hace(24 * 30) } })), "ya_enviado");
  assertEquals(motivo(cand({ plantillas_enviadas: ["voltra_mk_seguimiento_oferta"] })), "ya_enviado");
  assertEquals(motivo(cand({ plantillas_enviadas: ["voltra_confirmacion_pedido_v3"] })), "toque3");
  assertEquals(motivo(cand({ perfil: { producto: "tiras", toque3_fallo_en: hace(23) } })), "fallo_reciente");
  assertEquals(motivo(cand({ perfil: { producto: "tiras", toque3_fallo_en: hace(25) } })), "toque3");
});

// ---------- variables ----------

const PRECIOS: PreciosToque3 = {
  unidad: {
    [TIRAS]: { precio: 79000, disponible: true },
    [PACK]: { precio: 120000, disponible: true },
    [RASPADOR]: { precio: 79000, disponible: false },
  },
  ofertas: { [TIRAS]: { "2": 125000, "3": 155000 } },
  envio: 33000,
};

Deno.test("oferta: total de 2 con envío desde config + Shopify; solo si el envío queda gratis (lo dice el texto)", () => {
  assertEquals(ofertaToque3(TIRAS, PRECIOS), { total: 158000 });
  assertEquals(ofertaToque3(PACK, PRECIOS), { motivo: "sin_oferta_x2" }); // 2 × 120.000 + envío: el envío no sale gratis
  assertEquals(ofertaToque3(RASPADOR, PRECIOS), { motivo: "sin_stock" });
  assertEquals(ofertaToque3("otro-producto", PRECIOS), { motivo: "sin_precio" });
  // Si cambian los precios, cambia el total (nada fijo en el código).
  assertEquals(ofertaToque3(TIRAS, { ...PRECIOS, envio: 30000 }), { total: 155000 });
  assertEquals(CANTIDAD_OFERTA, 2);
});

Deno.test("variables: producto del chat (o del anuncio) con artículo, primer nombre usable o 'de nuevo'", () => {
  assertEquals(handleToque3(cand()), TIRAS);
  assertEquals(handleToque3(cand({ perfil: { producto: "parches bucales" } })), "parches-bucales-gudair-30-unidades");
  assertEquals(handleToque3(cand({ perfil: {}, handle_anuncio: RASPADOR })), RASPADOR);
  assertEquals(handleToque3(cand({ perfil: { producto: "algo raro" }, handle_anuncio: null })), null);
  assertEquals(productoConArticulo(TIRAS), "las tiras nasales");
  assertEquals(productoConArticulo("parches-bucales-gudair-30-unidades"), "los parches bucales");
  assertEquals(productoConArticulo(RASPADOR), "el raspador de lengua");
  assertEquals(productoConArticulo("botella-flexible-gudair-500-ml"), "la botella flexible");
  assertEquals(productoConArticulo("ejercitador-de-mandibula-3-niveles"), "el ejercitador de mandíbula");
  assertEquals(primerNombre("Ana Prueba", "de nuevo"), "Ana");
  assertEquals(primerNombre("~ANA 💕", "de nuevo"), "Ana");
  assertEquals(primerNombre("💕✨", "de nuevo"), "de nuevo");
  assertEquals(primerNombre(null, "de nuevo"), "de nuevo");
  assertEquals(primerNombre(".", "de nuevo"), "de nuevo");
  assertEquals(primerNombre("María José", "de nuevo"), "María");
});

Deno.test("componentes: {{1}} {{2}} {{3}} y payloads vend_p1:pedir:<handle> y mk_baja:0", () => {
  assertEquals(componentesToque3({ nombre: "Ana", producto: "las tiras nasales", total: 158000, handle: TIRAS }), [
    { type: "body", parameters: [{ type: "text", text: "Ana" }, { type: "text", text: "las tiras nasales" }, { type: "text", text: "158.000" }] },
    { type: "button", sub_type: "quick_reply", index: "0", parameters: [{ type: "payload", payload: `vend_p1:pedir:${TIRAS}` }] },
    { type: "button", sub_type: "quick_reply", index: "1", parameters: [{ type: "payload", payload: "mk_baja:0" }] },
  ]);
});

Deno.test("errores: los de la plantilla (132xxx, parámetros, config) pausan; los del cliente no", () => {
  for (const e of ["132001: Template name does not exist in the translation", "132015: Template is paused", "131008: Required parameter is missing", "faltan_WA_TOKEN_o_WA_PHONE_NUMBER_ID"]) {
    assert(esFallaDePlantilla(e), e);
  }
  for (const e of ["131050: user stopped marketing messages", "131026: Message undeliverable", "palabra_prohibida:cura", "red: timeout", "131049: ecosystem"]) {
    assertFalse(esFallaDePlantilla(e), e);
  }
});

// ---------- topes (los de recompra) ----------

const RECOMPRA = configDesdeValor(null); // topes por defecto: 1 por semana, 3 por mes

Deno.test("topes: una plantilla de marketing (voltra_mk_* o esta) en los últimos 7 días frena; las de utilidad no", () => {
  const h = (plantilla: string, dias: number, estado = "leido"): HistorialMk => ({
    mensajes: [{ cliente_id: "cli-1", creado_en: hace(dias * 24), estado, plantilla }],
    enCola: [],
  });
  assertEquals(topeToque3(cand(), { mensajes: [], enCola: [] }, T3, AHORA, RECOMPRA), { ok: true });
  assertEquals(topeToque3(cand(), h("voltra_mk_pack", 3), T3, AHORA, RECOMPRA), { ok: false, motivo: "tope_semana" });
  assertEquals(topeToque3(cand(), h("voltra_mk_seguimiento_oferta", 3), T3, AHORA, RECOMPRA), { ok: false, motivo: "tope_semana" });
  assertEquals(topeToque3(cand(), h("voltra_confirmacion_pedido_v3", 1), T3, AHORA, RECOMPRA), { ok: true });
  // De otro cliente: no cuenta.
  assertEquals(topeToque3(cand({ cliente_id: "cli-2" }), h("voltra_mk_pack", 3), T3, AHORA, RECOMPRA), { ok: true });
  // Marketing en cola (envios_programados pendiente) también frena.
  assertEquals(topeToque3(cand(), { mensajes: [], enCola: [{ cliente_id: "cli-1", enviar_desde: hace(-24) }] }, T3, AHORA, RECOMPRA).ok, false);
  // 3 en el mes (leídos, ninguno en la última semana) → tope del mes.
  const mes: HistorialMk = {
    mensajes: [1, 2, 3].map((d) => ({ cliente_id: "cli-1", creado_en: instanteLocal(`2026-10-0${d}`, 10).toISOString(), estado: "leido", plantilla: "voltra_mk_reposicion" })),
    enCola: [],
  };
  assertEquals(topeToque3(cand(), mes, T3, AHORA, RECOMPRA), { ok: false, motivo: "tope_mes" });
  // Sin opt-in obligatorio, el cliente sin respuesta de consentimiento pasa los topes como 'si'.
  assertEquals(topeToque3(cand({ consentimiento_marketing: null }), { mensajes: [], enCola: [] }, { ...T3, requiere_consentimiento: false }, AHORA, RECOMPRA), { ok: true });
});

// ---------- corrida ----------

function corrida(cands: Candidato[], op: {
  crudo?: unknown;
  ahora?: Date;
  envio?: (to: string, conv: string) => ResultadoEnvioWa;
  historial?: HistorialMk;
  fallas?: string[];
} = {}) {
  const orden: string[] = [];
  const marcas: Array<[string, string | null, string | null]> = [];
  const envios: Array<{ to: string; nombre: string; idioma: string; componentes: unknown[]; op: { clienteId: string; conversacionId: string } }> = [];
  const avisos: string[] = [];
  const bajas: string[] = [];
  const rangos: Array<[string, string]> = [];
  const ahora = op.ahora ?? AHORA;
  const deps: DepsSeguimiento = {
    config: () => Promise.resolve(op.crudo === undefined ? { toque3: { activo: true } } : op.crudo),
    topeGastoSuperado: () => Promise.resolve(false),
    candidatos: () => Promise.resolve([]),
    marcar: () => Promise.resolve(),
    turno: () => Promise.resolve({ accion: "respondido", costo_usd: 0 }),
    avisar: (t) => (avisos.push(t), Promise.resolve({ ok: true })),
    ahora: () => ahora,
    candidatosToque3: (d, h) => (rangos.push([d, h]), Promise.resolve(cands)),
    marcarToque3: (id, m) => (orden.push(`marca:${id}`), marcas.push([id, m.toque3_en, m.toque3_fallo_en]), Promise.resolve()),
    enviarPlantilla: (to, nombre, idioma, componentes, o) => {
      orden.push(`envio:${o.conversacionId}`);
      envios.push({ to, nombre, idioma, componentes, op: o });
      return Promise.resolve(op.envio?.(to, o.conversacionId) ?? { ok: true, wa_message_id: "wamid.PRUEBA" });
    },
    preciosToque3: () => Promise.resolve(PRECIOS),
    historialMarketing: () => Promise.resolve(op.historial ?? { mensajes: [], enCola: [] }),
    configRecompra: () => Promise.resolve(null),
    fallasRecientesToque3: () => Promise.resolve(op.fallas ?? []),
    registrarBaja: (id) => (bajas.push(id), Promise.resolve({ ok: true })),
  };
  return { deps, orden, marcas, envios, avisos, bajas, rangos };
}

const correr = (x: ReturnType<typeof corrida>, crudo: unknown = { toque3: { activo: true } }) => correrToque3(x.deps, crudo, CFG);

Deno.test("corrida toque 3: marca ANTES de mandar, plantilla con variables y payloads, sin avisos", async () => {
  const x = corrida([cand(), cand({ conversacion_id: "conv-2", cliente_id: "cli-2", pedido_reciente: true })]);
  const r = await correr(x);
  assertEquals([r.accion, r.candidatos, r.elegibles, r.enviados, r.fallas], ["corrido", 2, 1, 1, 0]);
  assertEquals(r.motivos, { pedido_reciente: 1 });
  assertEquals(x.orden, ["marca:conv-1", "envio:conv-1"]);
  assertEquals(x.marcas, [["conv-1", AHORA.toISOString(), null]]);
  assertEquals(x.envios.length, 1);
  const e = x.envios[0];
  assertEquals([e.to, e.nombre, e.idioma], ["+595981000000", "voltra_mk_seguimiento_oferta", "es"]);
  assertEquals(e.op, { clienteId: "cli-1", conversacionId: "conv-1" });
  assertEquals(e.componentes, componentesToque3({ nombre: "Ana", producto: "las tiras nasales", total: 158000, handle: TIRAS }));
  assertEquals(x.avisos, []);
  // Rango de búsqueda: creadas en las últimas 70 + 24 h y sin escribir desde hace 24 h.
  assertEquals(x.rangos[0], [hace(94), hace(24)]);
});

Deno.test("corrida toque 3: apagada por defecto (toque3.activo false) o con activo general en false; fuera de horario no busca", async () => {
  const a = corrida([cand()]);
  assertEquals((await correr(a, null)).accion, "inactivo");
  assertEquals((await correr(a, { toque3: { activo: false } })).accion, "inactivo");
  assertEquals((await correrToque3(a.deps, { toque3: { activo: true } }, { ...CFG, activo: false })).accion, "inactivo");
  assertEquals(a.envios, []);
  const b = corrida([cand()], { ahora: instanteLocal("2026-10-12", 9) });
  assertEquals((await correr(b)).accion, "fuera_de_horario");
  assertEquals(b.rangos, []);
});

Deno.test("corrida toque 3: sin producto, sin oferta ×2, topes y sin teléfono no salen; BSUID si no hay teléfono", async () => {
  const x = corrida([
    cand({ conversacion_id: "a", perfil: {}, handle_anuncio: null }),
    cand({ conversacion_id: "b", perfil: { producto: "pack tiras y parches" }, handle_anuncio: PACK }),
    cand({ conversacion_id: "c", cliente_id: "cli-tope" }),
    cand({ conversacion_id: "d", telefono: null, wa_user_id: null }),
    cand({ conversacion_id: "e", telefono: null, wa_user_id: "PY.0000000001" }),
  ], { historial: { mensajes: [{ cliente_id: "cli-tope", creado_en: hace(48), estado: "leido", plantilla: "voltra_mk_pack" }], enCola: [] } });
  const r = await correr(x);
  assertEquals(r.motivos, { sin_producto: 1, sin_oferta_x2: 1, tope_semana: 1, sin_telefono: 1 });
  assertEquals(x.envios.map((e) => [e.op.conversacionId, e.to]), [["e", "PY.0000000001"]]);
});

Deno.test("corrida toque 3: falla de un cliente → marca de falla (24 h sin reintentar), sigue con el resto y UN aviso", async () => {
  const x = corrida([cand({ conversacion_id: "a" }), cand({ conversacion_id: "b" })], {
    envio: (_to, conv) => (conv === "a" ? { ok: false, error: "131026: Message undeliverable <x>" } : { ok: true }),
  });
  const r = await correr(x);
  assertEquals([r.enviados, r.fallas], [1, 1]);
  assertEquals(x.marcas, [["a", AHORA.toISOString(), null], ["a", null, AHORA.toISOString()], ["b", AHORA.toISOString(), null]]);
  assertEquals(x.avisos.length, 1);
  assert(x.avisos[0].includes("Toque 3 (plantilla de oferta): 1 con problemas"));
  assert(x.avisos[0].includes("&lt;x&gt;"), "escapa el HTML");
  assertFalse(x.avisos[0].includes("pausa"));
});

Deno.test("corrida toque 3: 131050 (apagó las ofertas) registra la baja", async () => {
  const x = corrida([cand()], { envio: () => ({ ok: false, error: "131050: User has stopped marketing messages" }) });
  await correr(x);
  assertEquals(x.bajas, ["cli-1"]);
});

Deno.test("corrida toque 3: plantilla no aprobada (132001) → corta la corrida y avisa la pausa; la próxima queda en pausa", async () => {
  const x = corrida([cand({ conversacion_id: "a" }), cand({ conversacion_id: "b" })], {
    envio: () => ({ ok: false, error: "132001: Template name does not exist in the translation" }),
  });
  const r = await correr(x);
  assertEquals(x.envios.length, 1, "no sigue con el resto");
  assertEquals(r.motivos?.pausado_por_plantilla, 1);
  assertEquals(x.avisos.length, 1);
  assert(x.avisos[0].includes("queda en pausa 24 h"));
  const y = corrida([cand()], { fallas: ["131026: undeliverable"] });
  assertEquals((await correr(y)).enviados, 1, "una falla de cliente no pausa");
  const z = corrida([cand()], { fallas: ["132001: Template name does not exist in the translation"] });
  assertEquals((await correr(z)).accion, "pausado");
  assertEquals(z.rangos, [], "en pausa ni busca candidatos");
});

Deno.test("corrida toque 3: máximo lote_max por corrida; marca que falla → no se manda", async () => {
  const x = corrida(Array.from({ length: 3 }, (_, i) => cand({ conversacion_id: `c${i}` })));
  const r = await correr(x, { toque3: { activo: true, lote_max: 2 } });
  assertEquals([r.enviados, r.motivos?.lote_lleno], [2, 1]);
  const y = corrida([cand()]);
  y.deps.marcarToque3 = () => Promise.reject(new Error("sin base"));
  const ry = await correr(y);
  assertEquals([ry.enviados, ry.fallas, y.envios.length], [0, 1, 0]);
});

Deno.test("correrSeguimientos: el toque 3 va en el resumen; sin sus deps no corre; una excepción no frena la corrida", async () => {
  const x = corrida([cand()]);
  const r = await correrSeguimientos(x.deps);
  assertEquals(r.toque3?.enviados, 1);
  const sinDeps = corrida([cand()]);
  delete sinDeps.deps.candidatosToque3;
  assertEquals((await correrSeguimientos(sinDeps.deps)).toque3, undefined);
  const roto = corrida([cand()]);
  roto.deps.candidatosToque3 = () => Promise.reject(new Error("sin red"));
  const rr = await correrSeguimientos(roto.deps);
  assertEquals(rr.toque3, { accion: "error" });
  assert(roto.avisos.some((a) => a.includes("Toque 3 (plantilla de oferta): la corrida falló")));
});

// ---------- contrato con la plantilla y con wa-webhook ----------

Deno.test("plantilla voltra_mk_seguimiento_oferta.json: nombre, MARKETING, 3 variables, 2 botones y los payloads que manda el código", async () => {
  const p = JSON.parse(await Deno.readTextFile(new URL("../../plantillas/voltra_mk_seguimiento_oferta.json", import.meta.url)));
  assertEquals([p.name, p.category, p.language], [CFG_TOQUE3_DEFAULT.plantilla, "MARKETING", "es"]);
  const cuerpo = p.components.find((c: { type: string }) => c.type === "BODY");
  assertEquals([...cuerpo.text.matchAll(/\{\{(\d+)\}\}/g)].map((m: RegExpMatchArray) => m[1]), ["1", "2", "3"]);
  assert(cuerpo.text.includes(`Llevando ${CANTIDAD_OFERTA} el envío te sale gratis`));
  assertFalse(/\d{2,}\.\d{3}/.test(cuerpo.text), "sin precios fijos en el texto");
  assertFalse(/elimina|cura|garant/i.test(cuerpo.text), "sin promesas de salud ni garantías");
  const botones = p.components.find((c: { type: string }) => c.type === "BUTTONS").buttons.map((b: { text: string }) => b.text);
  assertEquals(botones, ["Quiero pedirlo", "No me escribas más"]);
  const comps = componentesToque3({ nombre: "Ana", producto: "las tiras nasales", total: 158000, handle: TIRAS }) as Array<{ type: string }>;
  assertEquals(comps.filter((c) => c.type === "button").length, botones.length);
  assertEquals(p._notas.botones_payload_completo, [payloadPedir("<handle>"), PAYLOAD_BAJA]);
});

Deno.test("wa-webhook: 'No me escribas más' (mk_baja:0) es la baja de recompra; 'Quiero pedirlo' le llega al vendedor como [botón]", () => {
  const boton = (payload: string, text: string) => ({ id: "wamid.PRUEBA", type: "button", button: { payload, text } }) as MensajeMeta;
  assertEquals(leerBotonMarketing(boton(PAYLOAD_BAJA, "No me escribas más")), { accion: "mk_baja", orderId: null });
  const pedir = boton(payloadPedir(TIRAS), "Quiero pedirlo");
  assertEquals([leerBotonConfirmacion(pedir), leerBotonPostventa(pedir), leerBotonMarketing(pedir)], [null, null, null]);
  assertEquals(textoParaVendedor(pedir), `[botón] Quiero pedirlo (vend_p1:pedir:${TIRAS})`);
});

// ---------- 21-10: no interrumpir una compra en curso (regla de Enrique) ----------

Deno.test("toque 3 (21-10): pedido a medio armar (pin, resumen o datos) no sale; frenar_medio_armado false lo apaga", () => {
  assertEquals(motivo(cand({ datos_pedido_parciales: true })), "pedido_a_medio_armar");
  assertEquals(motivo(cand({ datos_pedido_parciales: false })), "toque3");
  const d = decidirToque3(cand({ datos_pedido_parciales: true }), { ...CFG, frenar_medio_armado: false }, T3, AHORA);
  assertEquals(d.tipo, "toque3");
});

Deno.test("toque 3 (21-10): la regla de los minutos también aplica (con 24 h de sin_escribir_h casi nunca corta); 0 la apaga", () => {
  const t = (cfg: typeof CFG) => {
    const d = decidirToque3(cand({ ultima_entrada_en: hace(30) }), cfg, T3, AHORA);
    return d.tipo === "nada" ? d.motivo : d.tipo;
  };
  assertEquals(t(CFG), "toque3");
  assertEquals(t({ ...CFG, min_desde_cliente_min: 31 * 60 }), "cliente_escribio_hace_poco");
  assertEquals(t({ ...CFG, min_desde_cliente_min: 0 }), "toque3");
});
