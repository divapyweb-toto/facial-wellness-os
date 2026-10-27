// Datos inventados (repo público). Sin red ni base.
import { assert, assertEquals, assertStringIncludes } from "jsr:@std/assert@1";
import { productoPorPalabras } from "../_shared/anuncios.ts";
import { decidirRuta } from "../_shared/telegram_politica.ts";
import {
  armarMensaje,
  avisoRecuperacionFrenada,
  type Borrador,
  BOTON_RECUPERAR,
  configRecuperacion,
  type ConfigRecuperacion,
  type DepsRecuperar,
  evidenciaConsentimiento,
  frasePrecioRecuperar,
  handleDeBorrador,
  inicioDiaPY,
  type Mensaje,
  type PreciosRecuperar,
  recuperarBorradores,
  TAG_BORRADOR_RELEASIT,
} from "./logica.ts";

// 2026-10-06 15:00 UTC = 12:00 en Asunción (dentro de horario).
const AHORA = new Date("2026-10-06T15:00:00Z");
const RASPADOR = "raspador-de-lengua-de-acero-inoxidable";
const PACK = "pack-gudair-tiras-nasales-parches-bucales";

/** Borrador creado hace `minDesdeCreado` minutos (abandonado 15 min antes de eso). */
function borrador(minDesdeCreado = 10, over: Partial<Borrador> = {}, attrs: Array<{ name: string; value: string }> = []): Borrador {
  const creado = new Date(AHORA.getTime() - minDesdeCreado * 60_000).toISOString();
  return {
    shopify_order_id: 7001,
    nombre: "#D1",
    cliente_id: "cli-1",
    telefono: "+595981000000",
    tags: [TAG_BORRADOR_RELEASIT],
    creado_en: creado,
    raw: {
      created_at: creado,
      note_attributes: attrs,
      line_items: [{ title: "Raspador de Lengua de Acero Inoxidable", quantity: 1 }],
      shipping_address: { name: "ana prueba" },
    },
    ...over,
  };
}

const PRECIOS: PreciosRecuperar = {
  unidad: { [RASPADOR]: { precio: 79000, disponible: true }, [PACK]: { precio: 150000, disponible: true } },
  ofertas: { [RASPADOR]: { "2": 125000, "3": 155000 } },
  envio: 33000,
};

const CFG = (over: Partial<ConfigRecuperacion> = {}) =>
  configRecuperacion({ activo: true, requiere_consentimiento: false, ...over });

type Estado = {
  enviados: Array<{ tel: string; m: Mensaje; destino: unknown }>;
  cerrados: Array<{ id: number; estado: string; conv?: string | null }>;
  alertas: Array<string | null>;
  reclamados: Set<number>;
  consultasCalidad: number;
};

function deps(
  lista: Borrador[],
  o: {
    cfg?: ConfigRecuperacion;
    ahora?: Date;
    calidad?: string | null;
    intentados?: number;
    pedido?: boolean;
    chat?: boolean;
    contactado?: boolean;
    baja?: boolean;
    enviarOk?: boolean;
  } = {},
): { d: DepsRecuperar; e: Estado } {
  const e: Estado = { enviados: [], cerrados: [], alertas: [], reclamados: new Set(), consultasCalidad: 0 };
  const d: DepsRecuperar = {
    ahora: () => o.ahora ?? AHORA,
    config: () => Promise.resolve(o.cfg ?? CFG()),
    borradores: () => Promise.resolve(lista),
    intentadosDesde: () => Promise.resolve(o.intentados ?? 0),
    consentimiento: () => Promise.resolve(o.baja ? { utilidad: null, marketing: "baja" } : { utilidad: null, marketing: null }),
    pedidoDesde: () => Promise.resolve(o.pedido ?? false),
    chatAbierto: () => Promise.resolve(o.chat ?? false),
    contactadoReciente: () => Promise.resolve(o.contactado ?? false),
    precios: () => Promise.resolve(PRECIOS),
    productoPorPalabras,
    nombreProducto: (h) => (h === RASPADOR ? "raspador de lengua" : h),
    calidadNumero: () => { e.consultasCalidad++; return Promise.resolve(o.calidad === undefined ? "GREEN" : o.calidad); },
    alertarCalidad: (c) => { e.alertas.push(c); return Promise.resolve(); },
    reclamar: (b) => {
      if (e.reclamados.has(b.shopify_order_id)) return Promise.resolve(false);
      e.reclamados.add(b.shopify_order_id);
      return Promise.resolve(true);
    },
    prepararConversacion: (b) => Promise.resolve({ clienteId: b.cliente_id, conversacionId: "conv-1" }),
    enviar: (tel, _p, m, destino) => {
      e.enviados.push({ tel, m, destino });
      return Promise.resolve(o.enviarOk === false ? { ok: false, error: "x" } : { ok: true, wa_message_id: "wamid.X" });
    },
    cerrar: (b, estado, x) => { e.cerrados.push({ id: b.shopify_order_id, estado, conv: x.conversacion_id }); return Promise.resolve(); },
  };
  return { d, e };
}

// ─── Config ───────────────────────────────────────────────────

Deno.test("config: sin valor queda apagada y exige consentimiento (lo estricto)", () => {
  const c = configRecuperacion(undefined);
  assertEquals(c.activo, false);
  assertEquals(c.requiere_consentimiento, true);
  assertEquals([c.min_minutos, c.max_minutos, c.limite, c.demora_releasit_min], [15, 60, 30, 15]);
  assertEquals(c.plantilla, "voltra_mk_recuperar_pedido");
});

Deno.test("config: solo true enciende y solo false saca el consentimiento", () => {
  assertEquals(configRecuperacion({ activo: "true" }).activo, false);
  assertEquals(configRecuperacion({ requiere_consentimiento: "no" }).requiere_consentimiento, true);
  assertEquals(configRecuperacion({ requiere_consentimiento: false }).requiere_consentimiento, false);
});

// ─── Texto ────────────────────────────────────────────────────

Deno.test("precio: 79.000 + envío / 2 por 158.000 con envío gratis", () => {
  assertEquals(frasePrecioRecuperar(RASPADOR, PRECIOS), "79.000 + envío / 2 por 158.000 con envío gratis");
});

Deno.test("precio: sin oferta ×2 (pack) → solo precio + envío; sin stock o sin precio → null", () => {
  assertEquals(frasePrecioRecuperar(PACK, PRECIOS), "150.000 + envío");
  assertEquals(frasePrecioRecuperar(RASPADOR, { ...PRECIOS, unidad: { [RASPADOR]: { precio: 79000, disponible: false } } }), null);
  assertEquals(frasePrecioRecuperar("otro", PRECIOS), null);
});

Deno.test("precio: si el ×2 no cubre el envío, no promete envío gratis", () => {
  const p = { ...PRECIOS, ofertas: { [RASPADOR]: { "2": 140000 } } };
  assertEquals(frasePrecioRecuperar(RASPADOR, p), "79.000 + envío");
});

Deno.test("producto: se reconoce por el título de la línea", () => {
  assertEquals(handleDeBorrador(borrador().raw, productoPorPalabras), RASPADOR);
  assertEquals(handleDeBorrador({ line_items: [{ title: "Algo raro" }] }, productoPorPalabras), null);
});

Deno.test("mensaje: nombre, producto, precio, botón con payload del vendedor y texto legible para el historial", () => {
  const m = armarMensaje(borrador(), RASPADOR, "raspador de lengua", "79.000 + envío / 2 por 158.000 con envío gratis", "voltra_mk_recuperar_pedido");
  const body = (m.componentes[0] as { parameters: Array<{ text: string }> }).parameters.map((p) => p.text);
  assertEquals(body, ["Ana", "raspador de lengua", "79.000 + envío / 2 por 158.000 con envío gratis"]);
  const boton = m.componentes[1] as { sub_type: string; parameters: Array<{ payload: string }> };
  assertEquals(boton.sub_type, "quick_reply");
  assertEquals(boton.parameters[0].payload, `vend_p1:pedir:${RASPADOR}`);
  assertStringIncludes(m.texto, "[plantilla voltra_mk_recuperar_pedido] Hola Ana 👋 Quedó sin terminar tu pedido de raspador de lengua.");
  assertStringIncludes(m.texto, `[${BOTON_RECUPERAR}]`);
  assertEquals(m.componentes.length, 2); // un solo botón: sin "No me interesa" (decisión de Enrique)
});

Deno.test("mensaje: sin nombre usable → 'qué tal'", () => {
  const b = borrador(10, { raw: { line_items: [{ title: "Raspador" }], shipping_address: { name: "." } } });
  const m = armarMensaje(b, RASPADOR, "x", "y", "p");
  assertEquals((m.componentes[0] as { parameters: Array<{ text: string }> }).parameters[0].text, "qué tal");
});

Deno.test("plantilla: el texto del JSON coincide con cuerpoPlantilla y el botón entra en 25 caracteres", async () => {
  const j = JSON.parse(await Deno.readTextFile(new URL("../../plantillas/voltra_mk_recuperar_pedido.json", import.meta.url)));
  const body = j.components.find((c: { type: string }) => c.type === "BODY").text;
  const m = armarMensaje(borrador(), RASPADOR, "{{2}}", "{{3}}", "p");
  assertEquals(m.texto, `[plantilla p] ${body.replace("{{1}}", "Ana")}\n[${BOTON_RECUPERAR}]`);
  const botones = j.components.find((c: { type: string }) => c.type === "BUTTONS").buttons;
  assertEquals(botones.map((b: { text: string }) => b.text), [BOTON_RECUPERAR]);
  assert(BOTON_RECUPERAR.length <= 25);
  assertEquals(j.category, "MARKETING");
});

// ─── Ventana 15–60 min ───────────────────────────────────────

Deno.test("ventana: creado hace 10 min (abandonado hace 25) → se manda", async () => {
  const { d, e } = deps([borrador(10)]);
  const r = await recuperarBorradores(d);
  assertEquals(r.enviados, 1);
  assertEquals(e.enviados[0].tel, "+595981000000");
  assertEquals(e.cerrados, [{ id: 7001, estado: "enviado", conv: "conv-1" }]);
});

Deno.test("ventana: recién creado (abandonado hace 15) se manda; abandonado hace 61 min no", async () => {
  assertEquals((await recuperarBorradores(deps([borrador(0)]).d)).enviados, 1);
  const r = await recuperarBorradores(deps([borrador(46)]).d);
  assertEquals(r.enviados, 0);
  assertEquals(r.omitidos.muy_viejo, 1);
});

Deno.test("ventana: si Releasit no tiene demora, a los 10 min es muy reciente", async () => {
  const r = await recuperarBorradores(deps([borrador(10)], { cfg: CFG({ demora_releasit_min: 0 }) }).d);
  assertEquals(r.omitidos.muy_reciente, 1);
});

// ─── Exclusiones ──────────────────────────────────────────────

for (const [nombre, o, motivo] of [
  ["ya tiene pedido", { pedido: true }, "pedido_previo"],
  ["chat abierto", { chat: true }, "chat_abierto"],
  ["pidió la baja", { baja: true }, "baja"],
  ["ya se le mandó otra", { contactado: true }, "contactado_reciente"],
] as const) {
  Deno.test(`no se manda: ${nombre}`, async () => {
    const { d, e } = deps([borrador()], o);
    const r = await recuperarBorradores(d);
    assertEquals(r.enviados, 0);
    assertEquals(r.omitidos[motivo], 1);
    assertEquals(e.enviados.length, 0);
    assertEquals(e.consultasCalidad, 0);
  });
}

Deno.test("no se manda: sin teléfono, producto desconocido o completado", async () => {
  const sinTel = borrador(10, { telefono: null });
  const raro = borrador(10, { shopify_order_id: 2, raw: { line_items: [{ title: "Cosa" }] } });
  const completo = borrador(10, { shopify_order_id: 3, raw: { completed_at: "2026-10-06T14:58:00Z", line_items: [{ title: "Raspador" }] } });
  const r = await recuperarBorradores(deps([sinTel, raro, completo]).d);
  assertEquals(r.enviados, 0);
  assertEquals(r.omitidos, { sin_telefono: 1, sin_producto: 1, completado: 1 });
});

Deno.test("consentimiento: si la config lo exige y no hay, no se manda", async () => {
  const r = await recuperarBorradores(deps([borrador()], { cfg: CFG({ requiere_consentimiento: true }) }).d);
  assertEquals(r.omitidos.sin_consentimiento, 1);
  const ok = await recuperarBorradores(
    deps([borrador(10, {}, [{ name: "acepto_whatsapp", value: "sí" }])], { cfg: CFG({ requiere_consentimiento: true, claves_consentimiento: ["acepto_whatsapp"] }) }).d,
  );
  assertEquals(ok.enviados, 1);
});

Deno.test("evidencia: valores negativos no cuentan", () => {
  assertEquals(evidenciaConsentimiento({ note_attributes: [{ name: "WA", value: "no" }] }, ["wa"]), null);
  assertEquals(evidenciaConsentimiento({ note_attributes: [{ name: "WA", value: "on" }] }, ["wa"]), "WA");
});

// ─── Freno de calidad y tope ─────────────────────────────────

for (const calidad of ["YELLOW", "RED", "UNKNOWN", null]) {
  Deno.test(`freno: calidad ${calidad} → no se manda nada y se avisa a Enrique`, async () => {
    const { d, e } = deps([borrador(), borrador(5, { shopify_order_id: 7002 })], { calidad });
    const r = await recuperarBorradores(d);
    assertEquals(r.accion, "calidad_no_verde");
    assertEquals(r.enviados, 0);
    assertEquals(e.enviados.length, 0);
    assertEquals(e.reclamados.size, 0); // no gasta el único intento del borrador
    assertEquals(e.alertas, [calidad]);
  });
}

Deno.test("freno: la calidad se lee antes de CADA envío", async () => {
  const lista = [1, 2, 3].map((i) => borrador(5, { shopify_order_id: i, cliente_id: `c${i}` }));
  const { d, e } = deps(lista);
  const r = await recuperarBorradores(d);
  assertEquals(r.enviados, 3);
  assertEquals(e.consultasCalidad, 3);
});

Deno.test("tope: 30 por día, contando los ya intentados hoy", async () => {
  const lista = [1, 2, 3, 4, 5].map((i) => borrador(5, { shopify_order_id: i }));
  const r = await recuperarBorradores(deps(lista, { intentados: 27 }).d);
  assertEquals(r.enviados, 3);
  assertEquals(r.accion, "tope_diario");
  const lleno = await recuperarBorradores(deps(lista, { intentados: 30 }).d);
  assertEquals([lleno.accion, lleno.revisados], ["tope_diario", 0]);
});

Deno.test("tope: un envío fallido también cuenta (no se reintenta)", async () => {
  const { d, e } = deps([borrador()], { enviarOk: false });
  const r = await recuperarBorradores(d);
  assertEquals([r.enviados, r.fallidos], [0, 1]);
  assertEquals(e.cerrados[0].estado, "fallido");
});

Deno.test("idempotencia: un borrador ya reclamado no se manda dos veces", async () => {
  const { d, e } = deps([borrador(), borrador()]);
  const r = await recuperarBorradores(d);
  assertEquals(r.enviados, 1);
  assertEquals(r.omitidos.ya_reclamado, 1);
  assertEquals(e.enviados.length, 1);
});

Deno.test("inicio del día en Paraguay", () => {
  assertEquals(inicioDiaPY(new Date("2026-10-06T02:00:00Z")).toISOString(), "2026-10-05T03:00:00.000Z");
  assertEquals(inicioDiaPY(new Date("2026-10-06T15:00:00Z")).toISOString(), "2026-10-06T03:00:00.000Z");
});

// ─── Bandera y horario ───────────────────────────────────────

Deno.test("bandera apagada o fuera de horario: no consulta nada", async () => {
  const off = await recuperarBorradores(deps([borrador()], { cfg: configRecuperacion({ activo: false }) }).d);
  assertEquals(off.accion, "bandera_apagada");
  const noche = await recuperarBorradores(deps([borrador()], { ahora: new Date("2026-10-07T02:00:00Z") }).d); // 23:00 PY
  assertEquals(noche.accion, "fuera_de_horario");
});

Deno.test("27-10: recuperación frenada por calidad → administración, 1 por día por calidad leída", () => {
  assertEquals(avisoRecuperacionFrenada("YELLOW"), { tipo: "recuperacion_frenada_calidad", destino: "admin", unaVezPorDia: true, clave: "YELLOW" });
  assertEquals(avisoRecuperacionFrenada(null).clave, "sin_lectura");
  assertEquals(decidirRuta(null, avisoRecuperacionFrenada(null)), "admin");
});
