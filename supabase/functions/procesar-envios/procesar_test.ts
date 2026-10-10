// Tests de la lógica pura de procesar-envios. Correr: cd supabase/functions && deno test procesar-envios/
// No usan red ni base: todo el I/O es falso (Deps). Datos inventados (0981000000, "Ana").
import { assert, assertEquals, assertMatch } from "jsr:@std/assert@1";
import {
  armarParametros,
  cambioPorError,
  type Config,
  CONFIG_DEFECTO,
  configDesdeFilas,
  type Contexto,
  decidir,
  type Deps,
  ESPERAS_MARCAR_MS,
  type Envio,
  formatearGs,
  type Horario,
  PLANTILLAS,
  procesarLote,
  tipoEnvio,
} from "./procesar.ts";

import pConf from "../../plantillas/voltra_confirmacion_pedido.json" with { type: "json" };
import pRec from "../../plantillas/voltra_recordatorio_confirmacion.json" with { type: "json" };
import pDesp from "../../plantillas/voltra_pedido_despachado.json" with { type: "json" };
import pHoy from "../../plantillas/voltra_entrega_hoy.json" with { type: "json" };
import pProx from "../../plantillas/voltra_entrega_proxima.json" with { type: "json" };
import pDir from "../../plantillas/voltra_completar_direccion.json" with { type: "json" };
import pUlt from "../../plantillas/voltra_ultimo_aviso_confirmacion.json" with { type: "json" };
import pBaja from "../../plantillas/voltra_pedido_cancelado_sin_respuesta.json" with { type: "json" };
import pNo from "../../plantillas/voltra_no_entregado.json" with { type: "json" };
import pSeg from "../../plantillas/voltra_seguimiento_entrega.json" with { type: "json" };
import pRecup from "../../plantillas/voltra_recuperar_borrador.json" with { type: "json" };
import pMkRep from "../../plantillas/voltra_mk_reposicion.json" with { type: "json" };
import pMkPack from "../../plantillas/voltra_mk_pack.json" with { type: "json" };
import pMkCru from "../../plantillas/voltra_mk_cruzada.json" with { type: "json" };
import pMkLan from "../../plantillas/voltra_mk_lanzamiento.json" with { type: "json" };

const AHORA = new Date("2026-10-06T15:00:00Z"); // 12:00 en Asunción (UTC-3)
const horario: Horario = {
  // Falso simple: Asunción = UTC-3 (los tests reales de horario están en _shared/horario_test.ts).
  dentro: (d, c) => {
    const h = (d.getUTCHours() + 21) % 24;
    return h >= c.desde && h < c.hasta;
  },
  proxima: (_d, _c) => new Date("2026-10-07T11:00:00Z"),
};

const RAW_REST = {
  line_items: [{ title: "Tiras nasales", quantity: 2 }],
  shipping_address: { first_name: "Ana", address1: "Calle Falsa 123", address2: "casa azul", city: "Ciudad del Este" },
};

const envio = (x: Partial<Envio> = {}): Envio => ({
  id: "e1",
  cliente_id: "c1",
  shopify_order_id: 1001,
  plantilla: "voltra_confirmacion_pedido",
  // Forma exacta de shopify-webhook (armarEnvios); sin productos/dirección para probar el respaldo desde el pedido.
  variables: {
    nombre: "Ana María Pérez",
    total: 129000,
    pedido: "#1001",
    telefono: "+595981000000",
    order_gid: "gid://shopify/Order/1001",
  },
  categoria: "utilidad",
  enviar_desde: AHORA.toISOString(),
  estado: "pendiente",
  clave_unica: "conf:1001",
  intentos: 0,
  ultimo_error: null,
  ...x,
});

const ctx = (x: Partial<Contexto> = {}, estado = "pendiente"): Contexto => ({
  cliente: { telefono: "+595981000000", wa_user_id: null, nombre: "Ana" },
  pedido: {
    shopify_order_id: 1001,
    nombre: "#1001",
    estado_confirmacion: estado,
    tags: [],
    total: 129000,
    raw: RAW_REST,
  },
  consentimientoMarketing: null,
  ultimaEntrada: null,
  conversacionId: "conv1",
  ...x,
});

const cfg = (x: Partial<Config> = {}): Config => ({ ...CONFIG_DEFECTO, ...x });

Deno.test("confirmación: plantilla con parámetros completados desde el pedido y payload dinámico por botón", () => {
  const d = decidir(envio(), ctx(), cfg(), AHORA, horario);
  assert(d.accion === "plantilla");
  assertEquals(d.nombre, "voltra_confirmacion_pedido");
  assertEquals(d.idioma, "es");
  assertEquals(d.to, "+595981000000");
  assertEquals(d.componentes, [
    {
      type: "body",
      parameters: ["Ana", "2 Tiras nasales", "129.000", "Calle Falsa 123 casa azul", "Ciudad del Este"]
        .map((text) => ({ type: "text", text })),
    },
    { type: "button", sub_type: "quick_reply", index: "0", parameters: [{ type: "payload", payload: "conf_si:1001" }] },
    {
      type: "button",
      sub_type: "quick_reply",
      index: "1",
      parameters: [{ type: "payload", payload: "conf_corregir:1001" }],
    },
    {
      type: "button",
      sub_type: "quick_reply",
      index: "2",
      parameters: [{ type: "payload", payload: "conf_cancelar:1001" }],
    },
  ]);
});

Deno.test("usa las variables tal como las guarda shopify-webhook (total_texto manda sobre total)", () => {
  const vars = {
    nombre: "Ana",
    productos: "1 Tiras nasales, 2 Parches",
    total: 158000,
    total_texto: "158.000",
    direccion: "Calle Falsa 123",
    ciudad: "Hernandarias",
    pedido: "#1002",
    telefono: "+595981000000",
    order_gid: "gid://shopify/Order/1002",
  };
  const d = decidir(
    envio({ variables: vars, shopify_order_id: 1002, clave_unica: "conf:1002" }),
    ctx(),
    cfg(),
    AHORA,
    horario,
  );
  assert(d.accion === "plantilla");
  assertEquals(
    (d.componentes[0] as { parameters: { text: string }[] }).parameters.map((p) => p.text),
    ["Ana", "1 Tiras nasales, 2 Parches", "158.000", "Calle Falsa 123", "Hernandarias"],
  );
});

Deno.test("acepta el nombre sin prefijo y variables posicionales", () => {
  const d = decidir(
    envio({ plantilla: "recordatorio_confirmacion", variables: ["Ana", "1 Parches\nbucales"] }),
    ctx(),
    cfg(),
    AHORA,
    horario,
  );
  assert(d.accion === "plantilla");
  assertEquals(d.nombre, "voltra_recordatorio_confirmacion");
  assertEquals((d.componentes[0] as { parameters: { text: string }[] }).parameters.map((p) => p.text), [
    "Ana",
    "1 Parches bucales",
  ]);
});

Deno.test("si falta una variable y el pedido no la tiene, falla sin mandar", () => {
  const d = decidir(
    envio({ plantilla: "voltra_pedido_despachado", variables: { nombre: "Ana" } }),
    ctx(),
    cfg(),
    AHORA,
    horario,
  );
  assertEquals(d, { accion: "fallar", motivo: "falta_variable:courier" });
  assertEquals(decidir(envio({ plantilla: "voltra_inexistente" }), ctx(), cfg(), AHORA, horario).accion, "fallar");
  assertEquals(
    decidir(envio(), ctx({ cliente: { telefono: null, wa_user_id: null, nombre: null } }), cfg(), AHORA, horario),
    {
      accion: "fallar",
      motivo: "cliente_sin_telefono",
    },
  );
});

Deno.test("no manda recordatorio a un pedido ya confirmado ni nada a un pedido cancelado", () => {
  assertEquals(
    decidir(envio({ plantilla: "voltra_recordatorio_confirmacion" }), ctx({}, "confirmado"), cfg(), AHORA, horario)
      .accion,
    "cancelar",
  );
  const desp = envio({
    plantilla: "voltra_pedido_despachado",
    variables: { courier: "Lucero del Este", plazo: "1 a 3 días hábiles" },
  });
  assertEquals(decidir(desp, ctx({}, "cancelado_cliente"), cfg(), AHORA, horario).accion, "cancelar");
  assertEquals(decidir(desp, ctx({}, "confirmado"), cfg(), AHORA, horario).accion, "plantilla");
});

Deno.test("marketing: sin consentimiento cancela; fuera de horario reprograma; en horario manda", () => {
  const m = envio({
    categoria: "marketing",
    plantilla: "voltra_entrega_hoy",
    shopify_order_id: null,
    variables: ["Ana", "129.000"],
  });
  assertMatch((decidir(m, ctx(), cfg(), AHORA, horario) as { motivo: string }).motivo, /sin_consentimiento/);
  assertEquals(decidir(m, ctx({ consentimientoMarketing: "baja" }), cfg(), AHORA, horario).accion, "cancelar");
  const noche = new Date("2026-10-07T02:00:00Z"); // 23:00 en Asunción
  assertEquals(decidir(m, ctx({ consentimientoMarketing: "si" }), cfg(), noche, horario), {
    accion: "reprogramar",
    enviar_desde: new Date("2026-10-07T11:00:00Z"),
    motivo: "fuera_de_horario",
  });
  assertEquals(decidir(m, ctx({ consentimientoMarketing: "si" }), cfg(), AHORA, horario).accion, "plantilla");
});

Deno.test("utilidad sale las 24 h aunque sea de noche", () => {
  const noche = new Date("2026-10-07T05:00:00Z"); // 02:00 en Asunción
  assertEquals(decidir(envio(), ctx(), cfg(), noche, horario).accion, "plantilla");
});

Deno.test("ventana de 24 h abierta: texto libre/botones solo con el flag y texto configurado", () => {
  const abierta = ctx({ ultimaEntrada: new Date(AHORA.getTime() - 3_600_000) });
  const textos = {
    voltra_confirmacion_pedido: "Hola {{1}}, ¿confirmás tu pedido de {{2}} por Gs {{3}}?",
    voltra_entrega_hoy: "Hola {{1}}, hoy llega. Gs {{2}}.",
  };
  assertEquals(decidir(envio(), abierta, cfg(), AHORA, horario).accion, "plantilla"); // flag apagado (default)
  const on = cfg({ usarTextoLibreEnVentana: true, textosLibres: textos });
  const d = decidir(envio(), abierta, on, AHORA, horario);
  assert(d.accion === "botones");
  assertEquals(d.texto, "Hola Ana, ¿confirmás tu pedido de 2 Tiras nasales por Gs 129.000?");
  assertEquals(d.botones.map((b) => b.id), ["conf_si:1001", "conf_corregir:1001", "conf_cancelar:1001"]);
  const cerrada = ctx({ ultimaEntrada: new Date(AHORA.getTime() - 25 * 3_600_000) });
  assertEquals(decidir(envio(), cerrada, on, AHORA, horario).accion, "plantilla");
  // Sin texto configurado para esa plantilla → plantilla
  assertEquals(
    decidir(envio({ plantilla: "voltra_seguimiento_entrega" }), abierta, on, AHORA, horario).accion,
    "plantilla",
  );
  // Marketing nunca va como texto libre
  const mk = envio({ categoria: "marketing", plantilla: "voltra_entrega_hoy", variables: ["Ana", "1"] });
  assertEquals(decidir(mk, { ...abierta, consentimientoMarketing: "si" }, on, AHORA, horario).accion, "plantilla");
});

Deno.test("ret y canc: actúan solo si el pedido sigue sin respuesta", () => {
  const ret = envio({ plantilla: "accion:retener", clave_unica: "ret:1001" });
  const canc = envio({ plantilla: "accion:cancelar", clave_unica: "canc:1001" });
  assertEquals(tipoEnvio(ret), "ret");
  assertEquals(tipoEnvio(canc), "canc");
  assertEquals(tipoEnvio(envio({ plantilla: "ret", clave_unica: null })), "ret");
  assertEquals(decidir(ret, ctx(), cfg(), AHORA, horario), { accion: "retener" });
  assertEquals(decidir(ret, ctx({}, "confirmado"), cfg(), AHORA, horario).accion, "cancelar");
  assertEquals(decidir(canc, ctx({}, "retenido"), cfg(), AHORA, horario), { accion: "cancelar_pedido" });
  assertEquals(decidir(canc, ctx({}, "pendiente"), cfg(), AHORA, horario), { accion: "cancelar_pedido" });
  assertEquals(decidir(canc, ctx({}, "cancelado_cliente"), cfg(), AHORA, horario).accion, "cancelar");
  assertEquals(decidir(canc, ctx({ pedido: null }), cfg(), AHORA, horario).accion, "cancelar");
});

Deno.test("reintentos: 131049 a las 24 h; otros con espera creciente; al tercero, fallido", () => {
  const c = cfg();
  const r1 = cambioPorError(envio(), "131049: limit", AHORA, c);
  assertEquals(r1.estado, "pendiente");
  assertEquals(r1.enviar_desde, new Date(AHORA.getTime() + 24 * 3_600_000).toISOString());
  const g1 = cambioPorError(envio(), "131000: algo", AHORA, c);
  assertEquals([g1.intentos, g1.enviar_desde], [1, new Date(AHORA.getTime() + 5 * 60_000).toISOString()]);
  const g2 = cambioPorError(envio({ intentos: 1 }), "red: timeout", AHORA, c);
  assertEquals([g2.intentos, g2.enviar_desde], [2, new Date(AHORA.getTime() + 30 * 60_000).toISOString()]);
  const g3 = cambioPorError(envio({ intentos: 2 }), "500: x", AHORA, c);
  assertEquals([g3.estado, g3.intentos], ["fallido", 3]);
});

Deno.test("formato de guaraníes y config desde config_wa", () => {
  assertEquals(formatearGs(129000), "129.000");
  assertEquals(formatearGs(1250000), "1.250.000");
  const c = configDesdeFilas([
    { clave: "horario_marketing", valor: { desde: 9, hasta: 20 } },
    { clave: "usar_texto_libre_en_ventana", valor: true },
    { clave: "textos_libres", valor: { entrega_hoy: "Hola {{1}}" } },
    { clave: "procesar_envios", valor: { lote: 20, esperas_min: [1, 2] } },
  ]);
  assertEquals(c.horario, { desde: 9, hasta: 20 });
  assertEquals(c.usarTextoLibreEnVentana, true);
  assertEquals(c.textosLibres, { voltra_entrega_hoy: "Hola {{1}}" });
  assertEquals([c.lote, c.esperasMin, c.maxIntentos], [20, [1, 2], 3]);
  assertEquals(configDesdeFilas([]).usarTextoLibreEnVentana, false);
});

Deno.test("el catálogo coincide con los JSON de supabase/plantillas (botones, payloads, variables)", () => {
  for (const p of [pConf, pRec, pDesp, pHoy, pProx, pDir, pUlt, pBaja, pNo, pSeg, pRecup, pMkRep, pMkPack, pMkCru, pMkLan]) {
    const def = PLANTILLAS[p.name];
    assert(def, p.name);
    const botones = (p.components as { type: string; buttons?: { text: string }[] }[])
      .find((c) => c.type === "BUTTONS")?.buttons ?? [];
    assertEquals(def.botones.map((b) => b.titulo), botones.map((b) => b.text), p.name);
    assertEquals(def.botones.map((b) => b.prefijo), p._notas.botones_payload, p.name);
    assertEquals(def.vars.length, p._notas.variables.length, p.name);
    assertEquals(p.language, "es");
  }
  assertEquals(Object.keys(PLANTILLAS).length, 17); // + v2 y v3 (07-10), entrega_proxima y completar_direccion (09-10)
});

Deno.test("armarParametros: objeto con claves numéricas", () => {
  const r = armarParametros(PLANTILLAS.voltra_entrega_hoy, { "1": "Ana", "2": 99000 }, null, null);
  assertEquals(r, { ok: true, valores: ["Ana", "99.000"] });
});

// ─── Orquestación con dependencias falsas ───

function fakes(
  envios: Envio[],
  contextos: Record<string, Contexto>,
  envioOk: (n: string) => { ok: boolean; error?: string },
) {
  const log = {
    cambios: [] as [string, unknown][],
    enviados: [] as string[],
    avisos: [] as string[],
    retenidos: [] as number[],
    cancelados: [] as number[],
  };
  const d: Deps = {
    ahora: () => AHORA,
    cfg: cfg(),
    horario,
    reclamar: (lote) => Promise.resolve(envios.slice(0, lote)),
    contexto: (e) => Promise.resolve(contextos[e.id]),
    actualizarEnvio: (id, c) => {
      log.cambios.push([id, c]);
      return Promise.resolve();
    },
    enviarPlantilla: (_to, nombre) => {
      log.enviados.push(nombre);
      return Promise.resolve({ ...envioOk(nombre), wa_message_id: "wamid.x" });
    },
    enviarTexto: () => Promise.resolve({ ok: true }),
    enviarBotones: () => Promise.resolve({ ok: true }),
    retenerPedido: (id) => {
      log.retenidos.push(id);
      return Promise.resolve({ ok: true });
    },
    cancelarPedidoSinRespuesta: (id) => {
      log.cancelados.push(id);
      return Promise.resolve({ ok: true });
    },
    avisar: (t) => {
      log.avisos.push(t);
      return Promise.resolve({ ok: true });
    },
    escapar: (s) => String(s ?? "").replace(/</g, "&lt;"),
  };
  return { d, log };
}

Deno.test("procesarLote: manda, retiene, cancela, reintenta y no frena el lote por una excepción", async () => {
  const lista = [
    envio({ id: "a" }),
    envio({ id: "b", plantilla: "accion:retener", clave_unica: "ret:1001" }),
    envio({ id: "c", plantilla: "voltra_recordatorio_confirmacion" }),
    envio({ id: "d", plantilla: "voltra_seguimiento_entrega", intentos: 2 }),
    envio({ id: "e" }),
    envio({ id: "f", plantilla: "voltra_entrega_hoy", variables: ["Ana", "1"] }),
  ];
  const contextos: Record<string, Contexto> = {
    a: ctx(),
    b: ctx(),
    c: ctx({}, "confirmado"),
    d: ctx({}, "confirmado"),
    f: ctx({}, "confirmado"),
  };
  const { d, log } = fakes(
    lista,
    contextos,
    (n) =>
      n === "voltra_seguimiento_entrega"
        ? { ok: false, error: "131026: undeliverable" }
        : n === "voltra_entrega_hoy"
        ? { ok: false, error: "131049: limit" }
        : { ok: true },
  );
  d.contexto = (e) => e.id === "e" ? Promise.reject(new Error("db caída")) : Promise.resolve(contextos[e.id]);

  const r = await procesarLote(d);
  assertEquals(r, {
    tomados: 6,
    enviados: 1,
    reprogramados: 0,
    cancelados: 1,
    reintentos: 2,
    fallidos: 1,
    acciones: 1,
  });
  assertEquals(log.retenidos, [1001]);
  const cambio = Object.fromEntries(log.cambios) as Record<
    string,
    { estado: string; intentos?: number; enviar_desde?: string }
  >;
  assertEquals(cambio.a.estado, "enviado");
  assertEquals(cambio.b.estado, "enviado");
  assertEquals(cambio.c.estado, "cancelado");
  assertEquals([cambio.d.estado, cambio.d.intentos], ["fallido", 3]);
  assertEquals([cambio.e.estado, cambio.e.intentos], ["pendiente", 1]);
  assertEquals(cambio.f.enviar_desde, new Date(AHORA.getTime() + 24 * 3_600_000).toISOString());
  assertEquals(log.avisos.length, 2); // retención + fallido
  assertMatch(log.avisos[0], /retenido/);
  assertMatch(log.avisos[1], /fallido/);
});

Deno.test("procesarLote: si Shopify falla al cancelar, reintenta y no marca enviado", async () => {
  const { d, log } = fakes([envio({ id: "x", plantilla: "accion:cancelar", clave_unica: "canc:1001" })], {
    x: ctx({}, "retenido"),
  }, () => ({ ok: true }));
  d.cancelarPedidoSinRespuesta = () => Promise.resolve({ ok: false, error: "Shopify 503" });
  const r = await procesarLote(d);
  assertEquals([r.acciones, r.reintentos], [0, 1]);
  assertEquals((log.cambios[0][1] as { estado: string }).estado, "pendiente");
  assertEquals(log.avisos.length, 0);
});

Deno.test("avisos de envío importados de noche salen a las 8:00; confirmación sigue 24 h", () => {
  const noche = new Date("2026-10-07T01:00:00Z"); // 22:00 en Asunción
  const madrugada = new Date("2026-10-07T10:30:00Z"); // 07:30
  const dia = new Date("2026-10-07T12:00:00Z"); // 09:00
  const tarde = new Date("2026-10-06T23:30:00Z"); // 20:30
  const despachado = envio({
    plantilla: "voltra_pedido_despachado",
    clave_unica: "courier:1001:DESPACHADO",
    variables: ["Ana", "2 Tiras nasales", "Lucero del Este", "1 a 3 días hábiles", "129.000"],
  });
  const conf = ctx({}, "confirmado");
  let vistos: { desde: number; hasta: number } | null = null;
  const h: Horario = { ...horario, proxima: (_d, c) => ((vistos = c), new Date("2026-10-07T11:00:00Z")) };
  for (const t of [noche, madrugada, tarde]) {
    const d = decidir(despachado, conf, cfg(), t, h);
    assertEquals(d.accion, "reprogramar", t.toISOString());
    if (d.accion === "reprogramar") {
      assertEquals(d.enviar_desde.toISOString(), "2026-10-07T11:00:00.000Z");
      assertEquals(d.motivo, "fuera_de_horario_avisos_envio");
    }
  }
  assertEquals(vistos, { desde: 8, hasta: 20 });
  assertEquals(decidir(despachado, conf, cfg(), dia, h).accion, "plantilla");
  const noEnt = envio({ plantilla: "voltra_no_entregado", clave_unica: "courier:1001:INTENTO_FALLIDO", variables: ["Ana", "2 Tiras nasales"] });
  assertEquals(decidir(noEnt, conf, cfg(), noche, h).accion, "reprogramar");
  const hoy = envio({ plantilla: "voltra_entrega_hoy", clave_unica: "hoy:1001", variables: ["Ana", "129.000"] });
  assertEquals(decidir(hoy, conf, cfg(), noche, h).accion, "reprogramar");
  // Confirmación y recordatorio: 24 h.
  assertEquals(decidir(envio(), ctx(), cfg(), noche, h).accion, "plantilla");
  const rec = envio({ plantilla: "voltra_recordatorio_confirmacion", clave_unica: "rec:1001" });
  assertEquals(decidir(rec, ctx(), cfg(), noche, h).accion, "plantilla");
  // El horario sale de config_wa.horario_avisos_envio.
  const c = configDesdeFilas([{ clave: "horario_avisos_envio", valor: { desde: 7, hasta: 22 } }]);
  assertEquals(c.horarioAvisosEnvio, { desde: 7, hasta: 22 });
  assertEquals(decidir(despachado, conf, c, tarde, h).accion, "plantilla");
  assertEquals(configDesdeFilas([]).horarioAvisosEnvio, { desde: 8, hasta: 20 });
});

// ─── Integración olas 2-4 ───

Deno.test("marketing de recompra: con consentimiento y en horario sale con payload mk_*; sin pedido usa :0", () => {
  const mk = envio({
    plantilla: "voltra_mk_pack",
    categoria: "marketing",
    clave_unica: "mk:1001:M2",
    variables: ["Ana", "tiras nasales", "el pack de 2 bolsas", "125.000"],
  });
  const d = decidir(mk, ctx({ consentimientoMarketing: "si" }, "confirmado"), cfg(), AHORA, horario);
  assert(d.accion === "plantilla");
  const payloads = (d.componentes as { type: string; parameters: { payload?: string }[] }[])
    .filter((c) => c.type === "button").map((c) => c.parameters[0].payload);
  assertEquals(payloads, ["mk_pack:1001", "mk_una:1001", "mk_baja:1001"]);

  const lanz = envio({
    plantilla: "voltra_mk_lanzamiento",
    categoria: "marketing",
    shopify_order_id: null,
    clave_unica: "mk:lanz:c1",
    variables: ["Botella", "99.000", "15 de octubre"],
  });
  const d2 = decidir(lanz, ctx({ consentimientoMarketing: "si", pedido: null }), cfg(), AHORA, horario);
  assert(d2.accion === "plantilla");
  const p2 = (d2.componentes as { type: string; parameters: { payload?: string }[] }[])
    .filter((c) => c.type === "button").map((c) => c.parameters[0].payload);
  assertEquals(p2, ["mk_quiero:0", "mk_baja:0"]);
  // Sin consentimiento no sale.
  assertEquals(decidir(mk, ctx({ consentimientoMarketing: "baja" }), cfg(), AHORA, horario).accion, "cancelar");
});

Deno.test("error 131050: registra la baja con el cliente, cancela el envío y no reintenta", async () => {
  const mk = envio({
    id: "m",
    plantilla: "voltra_mk_reposicion",
    categoria: "marketing",
    clave_unica: "mk:1001:M1",
    variables: ["Ana", "tiras nasales", "otra bolsa", "79.000"],
  });
  const { d, log } = fakes([mk], { m: ctx({ consentimientoMarketing: "si" }, "confirmado") }, () => ({
    ok: false,
    error: "131050: Unable to deliver message. User has opted out of marketing",
  }));
  const bajas: string[] = [];
  d.registrarBaja = (id) => (bajas.push(id), Promise.resolve({ ok: true }));
  const r = await procesarLote(d);
  assertEquals([r.cancelados, r.reintentos, r.fallidos], [1, 0, 0]);
  assertEquals(bajas, ["c1"]);
  const c = log.cambios[0][1] as { estado: string; ultimo_error: string };
  assertEquals(c.estado, "cancelado");
  assertMatch(c.ultimo_error, /^meta_131050/);
  assertEquals(log.avisos.length, 0);
});

Deno.test("seguimiento con factura: solo con ola4.factura activo; si devuelve plantilla, sale esa", async () => {
  const seg = envio({ id: "s", plantilla: "voltra_seguimiento_entrega", clave_unica: "seg:1001" });
  const contextos = { s: ctx({}, "confirmado") };
  const llamadas: unknown[] = [];
  const conFactura = (activo: boolean, devuelve: unknown) => {
    const { d, log } = fakes([seg], contextos, () => ({ ok: true }));
    d.cfg = cfg({ facturaActiva: activo });
    d.seguimientoConFactura = (id, v) => {
      llamadas.push([id, v]);
      return Promise.resolve(devuelve as null);
    };
    return { d, log };
  };
  // Bandera apagada: ni se consulta.
  let x = conFactura(false, { plantilla: "voltra_seguimiento_factura", idioma: "es", componentes: [] });
  await procesarLote(x.d);
  assertEquals([llamadas.length, x.log.enviados], [0, ["voltra_seguimiento_entrega"]]);
  // Activa y con factura: sale la plantilla de factura con nombre y productos del seguimiento.
  x = conFactura(true, { plantilla: "voltra_seguimiento_factura", idioma: "es", componentes: [] });
  await procesarLote(x.d);
  assertEquals(x.log.enviados, ["voltra_seguimiento_factura"]);
  assertEquals(llamadas[0], [1001, { nombre: "Ana", productos: "2 Tiras nasales" }]);
  // Activa sin factura (null): seguimiento normal.
  x = conFactura(true, null);
  await procesarLote(x.d);
  assertEquals(x.log.enviados, ["voltra_seguimiento_entrega"]);
  // config_wa['ola4.factura'] llega a la config.
  assertEquals(configDesdeFilas([{ clave: "ola4.factura", valor: { activo: true } }]).facturaActiva, true);
  assertEquals(configDesdeFilas([]).facturaActiva, false);
});

// ─── 09-10: avisos de entrega con el envío ya terminado y fallas al marcar enviado ───

Deno.test("09-10: 'hoy te llega' / 'ya salió' se cancelan si el pedido ya está ENTREGADO, NO_ENTREGADO, etc.", () => {
  const conEstado = (estado_envio: string | null) => {
    const c = ctx({}, "confirmado");
    return { ...c, pedido: { ...c.pedido!, estado_envio } };
  };
  const hoy = envio({ plantilla: "voltra_entrega_hoy", clave_unica: "courier:1001:ENTREGA_HOY", variables: ["Ana", "129.000"] });
  const prox = envio({ plantilla: "voltra_entrega_proxima", clave_unica: "courier:1001:ENTREGA_HOY", variables: ["Ana", "129.000"] });
  for (const est of ["ENTREGADO", "NO_ENTREGADO", "NO_ENTREGADO_RESCATABLE", "CANCELADO", "RENDIDO"]) {
    for (const e of [hoy, prox]) {
      assertEquals(decidir(e, conEstado(est), cfg(), AHORA, horario), { accion: "cancelar", motivo: `envio_${est}` });
    }
  }
  // En camino o sin estado: sale normal.
  for (const est of [null, "DESPACHADO", "EN_PREPARACION", "INTENTO_FALLIDO"]) {
    assertEquals(decidir(hoy, conEstado(est), cfg(), AHORA, horario).accion, "plantilla", String(est));
  }
  // El "no entregado" y el seguimiento los dispara justamente el estado terminal: no se cancelan.
  const noEnt = envio({ plantilla: "voltra_no_entregado", clave_unica: "x", variables: ["Ana", "2 Tiras nasales"] });
  assertEquals(decidir(noEnt, conEstado("NO_ENTREGADO"), cfg(), AHORA, horario).accion, "plantilla");
  const seg = envio({ plantilla: "voltra_seguimiento_entrega", clave_unica: "y", variables: ["Ana", "2 Tiras nasales"] });
  assertEquals(decidir(seg, conEstado("ENTREGADO"), cfg(), AHORA, horario).accion, "plantilla");
});

Deno.test("09-10: WhatsApp OK y el update falla → reintenta, guarda wa_message_id y no reprograma", async () => {
  // Falla 1 vez y después anda.
  {
    const { d, log } = fakes([envio()], { e1: ctx() }, () => ({ ok: true }));
    let fallas = 1;
    const esperas: number[] = [];
    d.esperar = (ms) => (esperas.push(ms), Promise.resolve());
    d.actualizarEnvio = (id, c) => {
      if (fallas-- > 0) return Promise.reject(new Error("timeout"));
      log.cambios.push([id, c]);
      return Promise.resolve();
    };
    const r = await procesarLote(d);
    assertEquals([r.enviados, r.reintentos, r.fallidos], [1, 0, 0]);
    assertEquals(log.cambios, [["e1", { estado: "enviado", intentos: 1, ultimo_error: null, wa_message_id: "wamid.x" }]]);
    assertEquals(esperas, [ESPERAS_MARCAR_MS[0]]);
    assertEquals(log.avisos.length, 0);
  }
  // Falla siempre: 3 intentos, nunca se pide reprogramar (pendiente), avisa por Telegram.
  {
    const { d, log } = fakes([envio()], { e1: ctx() }, () => ({ ok: true }));
    let llamadas = 0;
    const cambios: unknown[] = [];
    d.esperar = () => Promise.resolve();
    d.actualizarEnvio = (_id, c) => (llamadas++, cambios.push(c), Promise.reject(new Error("base caída")));
    const r = await procesarLote(d);
    assertEquals(llamadas, ESPERAS_MARCAR_MS.length + 1);
    assert(cambios.every((c) => (c as { estado: string }).estado === "enviado"));
    assertEquals([r.enviados, r.reintentos, r.fallidos], [1, 0, 0]);
    assertEquals(log.enviados.length, 1);
    assertMatch(log.avisos[0], /no se pudo marcar/);
  }
});
