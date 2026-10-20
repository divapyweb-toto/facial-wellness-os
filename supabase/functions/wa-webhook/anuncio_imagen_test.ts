// 08-10: marca del anuncio (qué producto vio el cliente) y fotos al vendedor. Datos inventados (repo público).
import { assert, assertEquals } from "jsr:@std/assert@1";
import { type Conversacion, type Deps, type EntradaVendedor, type MensajeMeta, procesarMensaje } from "./procesar.ts";

const TEL = "595981000000";
const contacto = { profile: { name: "Ana Prueba" }, wa_id: TEL, user_id: "PY.1234567890123" };
const AD = "120251028181900429";
const MARCA_TIRAS = "[vino del anuncio de tiras nasales, handle tiras-nasales-gudair-30-unidades]";

function mock(op: {
  conv?: Partial<Conversacion>;
  mapeo?: unknown;
  perfil?: { producto?: unknown } | null | Error;
  sinPerfil?: boolean;
  copia?: { ok: boolean; mime?: string; error?: string } | Error;
  sinCopia?: boolean;
  pedidos?: unknown[];
} = {}) {
  const st = {
    pasados: [] as EntradaVendedor[],
    contenidos: new Map<string, Record<string, unknown>>(),
    origenes: [] as (string | null)[],
    copias: [] as string[],
    perfiles: 0,
    enviados: [] as string[],
  };
  const deps: Deps = {
    ahora: () => new Date("2026-10-08T15:00:00Z"),
    config: (clave) => Promise.resolve(clave === "anuncios_producto" ? op.mapeo ?? { [AD]: "tiras-nasales-gudair-30-unidades" } : null),
    guardarEventoCrudo: () => Promise.resolve(true),
    marcarEventoProcesado: () => Promise.resolve(),
    upsertCliente: () => Promise.resolve({ id: "cli-1", nombre: "Ana Prueba" }),
    conversacionActiva: (_c, origen) => (st.origenes.push(origen), Promise.resolve({ id: "conv-1", estado: "ia", ...op.conv })),
    actualizarConversacion: () => Promise.resolve(),
    insertarMensajeEntrante: () => Promise.resolve(true),
    completarContenidoMensaje: (id, extra) => (st.contenidos.set(id, { ...(st.contenidos.get(id) ?? {}), ...extra }), Promise.resolve()),
    estadoMensaje: () => Promise.resolve(undefined),
    actualizarMensaje: () => Promise.resolve(),
    copiarAudio: (_m, ruta) => Promise.resolve({ ok: true, ruta, mime: "audio/ogg" }),
    buscarPedido: () => Promise.resolve(null),
    pedidosPorEstado: (_c, _t, estado) => Promise.resolve((op.pedidos ?? []).filter((p) => (p as { estado_confirmacion: string }).estado_confirmacion === estado) as never),
    actualizarPedido: () => Promise.resolve(),
    cancelarEnviosPendientes: () => Promise.resolve(0),
    agregarTags: () => Promise.resolve({ ok: true }),
    quitarTags: () => Promise.resolve({ ok: true }),
    avisar: () => Promise.resolve({ ok: true }),
    enviarTexto: (_to, t) => (st.enviados.push(t), Promise.resolve({ ok: true })),
    enviarBotones: () => Promise.resolve({ ok: true }),
    consentimientoMarketing: () => Promise.resolve(null),
    registrarConsentimiento: () => Promise.resolve(),
    marcarLeidoYEscribiendo: () => Promise.resolve(),
    normalizarTelefono: (x) => `+${x.replace(/\D/g, "")}`,
    pasarAlVendedor: (d) => (st.pasados.push(d), Promise.resolve()),
    transcribirAudio: () => Promise.resolve({ ok: true, texto: "cuánto sale", confianza: 0.9 }),
  };
  if (!op.sinPerfil) {
    deps.perfilConversacion = () => {
      st.perfiles++;
      return op.perfil instanceof Error ? Promise.reject(op.perfil) : Promise.resolve(op.perfil ?? null);
    };
  }
  if (!op.sinCopia) {
    deps.copiarMediaChat = (_id, ruta) => {
      st.copias.push(ruta);
      const c = op.copia ?? { ok: true };
      return c instanceof Error ? Promise.reject(c) : Promise.resolve({ ...c, ruta: c.ok ? ruta : undefined });
    };
  }
  return { deps, st };
}

const base = { from: TEL, id: "wamid.IN1", timestamp: "1791400000" };
const hola = (extra: Partial<MensajeMeta> = {}): MensajeMeta => ({ ...base, type: "text", text: { body: "¡Hola! Quiero más información" }, ...extra });

// ---------- tarea 1: anuncio ----------

Deno.test("anuncio: primer mensaje con referral del mapeo → marca + texto, guardada en contenido; origen a la conversación", async () => {
  const a = mock();
  await procesarMensaje(hola({ referral: { source_id: AD, source_type: "ad", headline: "Respirá mejor", ctwa_clid: "x" } }), contacto, a.deps);
  assertEquals(a.st.origenes, [AD]);
  assertEquals(a.st.pasados[0].texto, `${MARCA_TIRAS}\n¡Hola! Quiero más información`);
  assertEquals(a.st.contenidos.get("wamid.IN1")?.marca_anuncio, MARCA_TIRAS);
  assertEquals(a.st.contenidos.get("wamid.IN1")?.producto_anuncio_fuente, "mapeo");
  assertEquals(a.st.perfiles, 0, "con referral no hace falta mirar el perfil");
});

Deno.test("anuncio: id fuera del mapeo → palabras del headline/body; sin pistas → texto tal cual", async () => {
  const a = mock({ mapeo: {} });
  await procesarMensaje(hola({ referral: { source_id: "999", headline: "Dormí con la boca cerrada", body: "Parches bucales Gudair" } }), contacto, a.deps);
  // 21-10: debajo de la marca va lo que decía el anuncio (el gancho retoma esa promesa).
  assertEquals(a.st.pasados[0].texto, "[vino del anuncio de parches bucales, handle parches-bucales-gudair-30-unidades]\n[el anuncio decía: \"Parches bucales Gudair\"]\n¡Hola! Quiero más información");
  const b = mock({ mapeo: {} });
  await procesarMensaje(hola({ referral: { source_id: "999", headline: "Oferta" } }), contacto, b.deps);
  assertEquals(b.st.pasados[0].texto, "¡Hola! Quiero más información");
  assertEquals(b.st.contenidos.get("wamid.IN1")?.marca_anuncio, undefined);
});

Deno.test("anuncio: mensajes siguientes sin referral → marca solo mientras el perfil no tenga producto", async () => {
  const conv = { origen_anuncio_id: AD };
  const sinProducto = mock({ conv, perfil: { necesidad: "ronca" } as { producto?: unknown } });
  await procesarMensaje(hola({ text: { body: "cuánto sale?" } }), contacto, sinProducto.deps);
  assertEquals(sinProducto.st.pasados[0].texto, `${MARCA_TIRAS}\ncuánto sale?`);
  const conProducto = mock({ conv, perfil: { producto: "tiras nasales" } });
  await procesarMensaje(hola({ text: { body: "cuánto sale?" } }), contacto, conProducto.deps);
  assertEquals(conProducto.st.pasados[0].texto, "cuánto sale?");
  // Si no se puede leer el perfil (o no hay dependencia), no se arriesga a repetir: sin marca.
  const falla = mock({ conv, perfil: new Error("sin columna") });
  await procesarMensaje(hola({ text: { body: "cuánto sale?" } }), contacto, falla.deps);
  assertEquals(falla.st.pasados[0].texto, "cuánto sale?");
  const sinDep = mock({ conv, sinPerfil: true });
  await procesarMensaje(hola({ text: { body: "cuánto sale?" } }), contacto, sinDep.deps);
  assertEquals(sinDep.st.pasados[0].texto, "cuánto sale?");
});

Deno.test("anuncio: conversación que no vino de un anuncio no consulta nada", async () => {
  const a = mock();
  await procesarMensaje(hola(), contacto, a.deps);
  assertEquals(a.st.pasados[0].texto, "¡Hola! Quiero más información");
  assertEquals(a.st.perfiles, 0);
});

Deno.test("anuncio: el primer mensaje en audio también lleva la marca", async () => {
  const a = mock();
  await procesarMensaje({ ...base, type: "audio", audio: { id: "M1" }, referral: { source_id: AD } }, contacto, a.deps);
  assertEquals(a.st.pasados[0].texto, `${MARCA_TIRAS}\n[audio] cuánto sale`);
  assertEquals(a.st.contenidos.get("wamid.IN1")?.texto_vendedor, `${MARCA_TIRAS}\n[audio] cuánto sale`);
});

// ---------- tarea 2: imágenes ----------

Deno.test("imagen: foto copiada a Storage → pasa ruta y mime al vendedor (con caption)", async () => {
  const a = mock({ copia: { ok: true, mime: "image/jpeg" } });
  await procesarMensaje({ ...base, type: "image", image: { id: "IMG1", mime_type: "image/jpeg", caption: "¿tienen este?" } }, contacto, a.deps);
  assertEquals(a.st.copias, ["media/cli-1/wamid.IN1.jpg"]);
  assertEquals(a.st.pasados, [{
    conversacion_id: "conv-1",
    cliente_id: "cli-1",
    wa_message_id: "wamid.IN1",
    texto: "[imagen] ¿tienen este?",
    imagen: { ruta: "media/cli-1/wamid.IN1.jpg", mime: "image/jpeg" },
  }]);
});

Deno.test("imagen: documento imagen/* también; PDF y sticker no llevan imagen", async () => {
  const d = mock({ copia: { ok: true, mime: "image/png" } });
  await procesarMensaje({ ...base, type: "document", document: { id: "D1", mime_type: "image/png", filename: "foto.png" } }, contacto, d.deps);
  assertEquals(d.st.pasados[0].imagen, { ruta: "media/cli-1/wamid.IN1.png", mime: "image/png" });
  const pdf = mock({ copia: { ok: true, mime: "application/pdf" } });
  await procesarMensaje({ ...base, type: "document", document: { id: "D2", mime_type: "application/pdf" } }, contacto, pdf.deps);
  assertEquals(pdf.st.pasados[0].imagen, undefined);
  assertEquals(pdf.st.pasados[0].texto, "[documento]");
  const st = mock({ copia: { ok: true, mime: "image/webp" } });
  await procesarMensaje({ ...base, type: "sticker", sticker: { id: "S1", mime_type: "image/webp" } }, contacto, st.deps);
  assertEquals(st.st.pasados[0].imagen, undefined);
  assertEquals(st.st.pasados[0].texto, "[sticker]");
});

Deno.test("imagen: si la copia falla (o no hay copiador, o el formato no se ve) → \"[imagen] (no se pudo ver)\" sin imagen", async () => {
  for (const op of [{ copia: { ok: false, error: "meta 404" } }, { copia: new Error("timeout") }, { sinCopia: true }, { copia: { ok: true, mime: "image/heic" } }]) {
    const a = mock(op);
    await procesarMensaje({ ...base, type: "image", image: { id: "IMG1", caption: "mirá" } }, contacto, a.deps);
    assertEquals(a.st.pasados[0].texto, "[imagen] (no se pudo ver) mirá", JSON.stringify(op));
    assertEquals(a.st.pasados[0].imagen, undefined);
  }
});

Deno.test("imagen: el comprobante de pago anticipado se sigue interceptando (no va al vendedor)", async () => {
  const pedido = {
    shopify_order_id: 5550001,
    nombre: "#1050",
    cliente_id: "cli-1",
    estado_confirmacion: "confirmado",
    tags: ["CONFIRMADO", "OFERTA_PAGO_ANTICIPADO"],
    creado_en: "2026-10-08T12:00:00Z",
    total: 112000,
  };
  const a = mock({ copia: { ok: true, mime: "image/jpeg" }, pedidos: [pedido] });
  await procesarMensaje({ ...base, type: "image", image: { id: "IMG1", mime_type: "image/jpeg" } }, contacto, a.deps);
  assertEquals(a.st.pasados.length, 0);
  assertEquals(a.st.contenidos.get("wamid.IN1")?.comprobante_pago_anticipado, "5550001");
  assert(a.st.enviados.length === 1);
});
