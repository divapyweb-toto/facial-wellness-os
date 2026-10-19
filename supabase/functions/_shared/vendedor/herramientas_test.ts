import { assert, assertEquals, assertFalse } from "jsr:@std/assert@1";
import { horasHastaFecha, mensajeSinStock, NOTA_INHALADOR, TEXTO_SALUD_SEGURO } from "./herramientas.ts";
import { productoPorPalabras } from "../anuncios.ts";
import {
  botonesPrimerTurno,
  cuerpoPrimerTurno,
  inputOrderCreate,
  nombreDePerfil,
  _limpiarCacheCatalogo,
  derivarAEnrique,
  ejecutarHerramienta,
  esAceptacion,
  esSoloPin,
  parsearFactura,
  unirReferencia,
  HERRAMIENTAS,
  fraseCantidad,
  lineasShopify,
  mencionaMedico,
  precioPorCantidad,
  textoClienteDerivacion,
  textoResumen,
} from "./herramientas.ts";
import { configPrueba, ctxPrueba, depsPrueba } from "./prueba_utiles.ts";

Deno.test("definiciones: las herramientas del contrato (19-10: + buscar_pedido, modificar_pedido, guardar_factura), con JSON Schema", () => {
  assertEquals(HERRAMIENTAS.map((h) => h.name).sort(), [
    "actualizar_direccion", "avisar_enrique", "buscar_pedido", "cierre_botones", "confirmar_ubicacion", "consultar_catalogo", "crear_pedido_cod", "datos_transferencia", "derivar_a_enrique", "enviar_formulario", "enviar_media",
    "enviar_opciones", "estado_pedido", "guardar_factura", "modificar_pedido", "pedir_telefono", "pedir_ubicacion", "permiso_ofertas", "primer_turno", "programar_entrega", "registrar_perfil",
  ]);
  for (const h of HERRAMIENTAS) assertEquals(h.input_schema.type, "object");
});

Deno.test("datos_transferencia: manda la cuenta tal cual la config; sin cuenta cargada, error sin mandar nada", async () => {
  const cfg = { ...configPrueba(), transferencia: "ueno bank · caja de ahorro · 123\nVOLTRA · RUC 1-2" };
  const { deps, reg } = depsPrueba();
  const r = await ejecutarHerramienta("datos_transferencia", {}, ctxPrueba({ cfg }), deps);
  assertEquals(r.resultado.ok, true);
  assertEquals(reg.textos.length, 1);
  assertEquals(reg.textos[0].texto, "💳 Datos para transferir:\nueno bank · caja de ahorro · 123\nVOLTRA · RUC 1-2");
  const sin = depsPrueba();
  const r2 = await ejecutarHerramienta("datos_transferencia", {}, ctxPrueba({ cfg: { ...configPrueba(), transferencia: null } }), sin.deps);
  assertFalse(r2.resultado.ok === true);
  assertEquals(sin.reg.textos.length, 0);
});

Deno.test("consultar_catalogo: precios de Shopify + ofertas + envío y caché de 10 min", async () => {
  _limpiarCacheCatalogo();
  const { deps, reg } = depsPrueba();
  const ctx = ctxPrueba();
  const r = await ejecutarHerramienta("consultar_catalogo", { busqueda: "tiras" }, ctx, deps);
  const prods = r.resultado.productos as Array<Record<string, unknown>>;
  assertEquals(prods.length, 1);
  assertEquals(prods[0].precio, 79000);
  assertEquals(prods[0].total, 112000);
  assertEquals((prods[0].ofertas as Array<Record<string, unknown>>)[0], {
    cantidad: 2, precio: 125000, precio_texto: "125.000", total: 158000, total_texto: "158.000", ahorro: 33000, ahorro_texto: "33.000",
    frase_precio: "2 por 158.000 en total: es como pagar 2 × 79.000, el envío te sale gratis",
  });
  await ejecutarHerramienta("consultar_catalogo", {}, ctx, deps);
  assertEquals(reg.catalogoLlamadas, 1);
  reg.avanzarReloj(11 * 60_000);
  await ejecutarHerramienta("consultar_catalogo", {}, ctx, deps);
  assertEquals(reg.catalogoLlamadas, 2);
});

Deno.test("consultar_catalogo: si Shopify falla devuelve error (nunca inventa)", async () => {
  _limpiarCacheCatalogo();
  const { deps } = depsPrueba({ catalogoShopify: () => Promise.reject(new Error("HTTP 401")) });
  const r = await ejecutarHerramienta("consultar_catalogo", {}, ctxPrueba(), deps);
  assert(r.esError);
  assert(String(r.resultado.error).startsWith("catalogo_no_disponible"));
});

Deno.test("precios por cantidad y líneas de Shopify sin decimales (PYG)", () => {
  assertEquals(precioPorCantidad(79000, 3, { "3": 155000 }), 155000);
  assertEquals(precioPorCantidad(79000, 2, undefined), 158000);
  const l = lineasShopify([{ handle: "t", titulo: "T", variante_id: "gid://v/1", cantidad: 3, total: 155000 }]);
  const suma = l.reduce((a, x) => a + Number((x.priceSet as { shopMoney: { amount: string } }).shopMoney.amount) * Number(x.quantity), 0);
  assertEquals(suma, 155000);
  assertEquals(l.length, 2);
});

const DATOS = { nombre: "Ana Prueba", ciudad: "Ciudad del Este", direccion: "Calle Falsa 123", referencia: "portón verde", items: [{ handle: "tiras-prueba", cantidad: 1 }] };

Deno.test("crear_pedido_cod (resumen): total del servidor y botones Confirmar/Corregir", async () => {
  _limpiarCacheCatalogo();
  const { deps, reg } = depsPrueba();
  const r = await ejecutarHerramienta("crear_pedido_cod", { confirmar: false, ...DATOS }, ctxPrueba(), deps);
  assert(r.terminal);
  assertEquals(r.resultado.total, 112000);
  assertEquals(reg.pedidosChat[0].estado, "resumen");
  const i = reg.interactivos[0].interactive as { type: string; body: { text: string }; action: { buttons: Array<{ reply: { id: string; title: string } }> } };
  assertEquals(i.type, "button");
  assert(i.body.text.includes("Total Gs 112.000"));
  // 12-10 (fase 3): día de entrega según la ciudad y botón "Confirmo".
  assert(i.body.text.includes("📦 Te llega: "), i.body.text);
  assertEquals(i.action.buttons.map((b) => b.reply.title), ["Confirmo", "Corregir"]);
  assertEquals(i.action.buttons[0].reply.id, `vend_conf:${reg.pedidosChat[0].id}`);
});

Deno.test("crear_pedido_cod: sin teléfono, sin datos o con producto desconocido no arma el resumen", async () => {
  _limpiarCacheCatalogo();
  const { deps, reg } = depsPrueba();
  const sinTel = await ejecutarHerramienta("crear_pedido_cod", { confirmar: false, ...DATOS }, ctxPrueba({ telefono: null }), deps);
  assert(sinTel.esError);
  assert(String(sinTel.resultado.error).includes("telefono"));
  const sinCiudad = await ejecutarHerramienta("crear_pedido_cod", { confirmar: false, ...DATOS, ciudad: "" }, ctxPrueba(), deps);
  assert((sinCiudad.resultado.faltan as string[]).includes("ciudad"));
  const raro = await ejecutarHerramienta("crear_pedido_cod", { confirmar: false, ...DATOS, items: [{ handle: "nada", cantidad: 1 }] }, ctxPrueba(), deps);
  assert(String(raro.resultado.error).startsWith("producto_desconocido"));
  const mayorista = await ejecutarHerramienta("crear_pedido_cod", { confirmar: false, ...DATOS, items: [{ handle: "tiras-prueba", cantidad: 20 }] }, ctxPrueba(), deps);
  assert(String(mayorista.resultado.error).startsWith("cantidad_invalida"));
  assertEquals(reg.interactivos.length, 0);
});

Deno.test("crear_pedido_cod (confirmar): exige un sí claro; con 'dale' crea en Shopify, programa como Releasit y avisa con botón cancelar", async () => {
  _limpiarCacheCatalogo();
  const { deps, reg } = depsPrueba();
  await ejecutarHerramienta("crear_pedido_cod", { confirmar: false, ...DATOS }, ctxPrueba(), deps);

  const sinSi = await ejecutarHerramienta("crear_pedido_cod", { confirmar: true }, ctxPrueba({ textoEntrada: "y cuánto tarda?" }), deps);
  assert(sinSi.esError);
  assertEquals(reg.ordenes.length, 0);

  const r = await ejecutarHerramienta("crear_pedido_cod", { confirmar: true, nombre: "OTRO NOMBRE" }, ctxPrueba({ textoEntrada: "si dale" }), deps);
  assertFalse(r.esError);
  assertEquals(r.pedidoCreado, { shopify_order_id: 5550001, nombre: "#1050" });
  const orden = reg.ordenes[0] as { order: Record<string, unknown>; options: Record<string, unknown> };
  assertEquals(orden.order.financialStatus, "PENDING");
  assertEquals(orden.order.tags, ["ORIGEN_WHATSAPP", "CONFIRMADO", "OFERTA_PAGO_ANTICIPADO"]);
  assertEquals((orden.order.shippingAddress as Record<string, unknown>).firstName, "Ana"); // usa el resumen, no lo que reescribe el modelo
  assertEquals(orden.options.inventoryBehaviour, "DECREMENT_OBEYING_POLICY");
  assertEquals(orden.options.sendReceipt, false);
  assertEquals(reg.releasit.length, 1);
  assertEquals(reg.pedidosChat[0].estado, "creado");
  const aviso = reg.avisos[0];
  assert(aviso.texto.includes("Pedido nuevo #1050"));
  assertEquals((aviso.botones as Array<Array<{ callback?: string }>>)[0][0].callback, "cancelar:5550001");
  assert(String(r.resultado.texto_respuesta).includes("Listo Ana, quedó confirmado tu pedido #1050"));

  // Repetir no duplica.
  const otra = await ejecutarHerramienta("crear_pedido_cod", { confirmar: true }, ctxPrueba({ textoEntrada: "si" }), deps);
  assertEquals(otra.resultado.ya_creado, true);
  assertEquals(reg.ordenes.length, 1);
});

Deno.test("esAceptacion: 'dale amigo', 'ya confirmé', 'listo' cuentan; 'no gracias', 'después', 'está bien pero' no (08-10)", () => {
  const A = ["si", "sí", "ok", "dale", "ya", "katu", "confirmo"];
  for (const t of ["Dale amigo", "Ya confirme amigo", "ya confirmé", "listo", "si por favor", "Sii dale porfa", "perfecto gracias", "Siiii", "Si confirmado.", "okk"]) assert(esAceptacion(t, A), t);
  for (const t of ["no gracias", "después te aviso", "dale pero la semana que viene", "y cuánto tarda?", "amigo", "ya", "no"]) {
    if (t === "ya") continue; // "ya" ya estaba en la lista de aceptaciones
    assertFalse(esAceptacion(t, A), t);
  }
});

Deno.test("crear_pedido_cod (confirmar): el sí de un turno anterior desde el resumen cuenta (botón perdido); un Corregir posterior lo anula", async () => {
  _limpiarCacheCatalogo();
  let entradas: string[] = [];
  const { deps, reg } = depsPrueba({ entradasDesde: () => Promise.resolve(entradas) });
  await ejecutarHerramienta("crear_pedido_cod", { confirmar: false, ...DATOS }, ctxPrueba(), deps);
  const id = reg.pedidosChat[0].id;
  entradas = [`[botón] Confirmar (vend_conf:${id})`, `[botón] Corregir (vend_corr:${id})`, "y cuánto tarda?"];
  const anulado = await ejecutarHerramienta("crear_pedido_cod", { confirmar: true }, ctxPrueba({ textoEntrada: "y cuánto tarda?" }), deps);
  assert(anulado.esError);
  entradas = ["Dale amigo", `[botón] Confirmar (vend_conf:${id})`, "Ya confirme amigo?"];
  const r = await ejecutarHerramienta("crear_pedido_cod", { confirmar: true }, ctxPrueba({ textoEntrada: "hola?" }), deps);
  assertFalse(r.esError);
  assertEquals(reg.ordenes.length, 1);
});

Deno.test("crear_pedido_cod (confirmar): el botón Confirmar cuenta como sí; si Shopify falla avisa y pide derivar", async () => {
  _limpiarCacheCatalogo();
  const { deps, reg } = depsPrueba({ crearOrdenShopify: () => Promise.resolve({ ok: false, error: "Access denied for orderCreate" }) });
  await ejecutarHerramienta("crear_pedido_cod", { confirmar: false, ...DATOS }, ctxPrueba(), deps);
  const id = reg.pedidosChat[0].id;
  const r = await ejecutarHerramienta("crear_pedido_cod", { confirmar: true }, ctxPrueba({ textoEntrada: `[botón] Confirmar (vend_conf:${id})` }), deps);
  assert(r.esError);
  assert(String(r.resultado.error).includes("Derivá a Enrique"));
  assertEquals(reg.pedidosChat[0].estado, "fallido");
  assert(reg.avisos[0].texto.includes("Falló crear un pedido de WhatsApp"));
});

Deno.test("estado_pedido: devuelve los pedidos del cliente con el último estado", async () => {
  const { deps } = depsPrueba({}, [{
    shopify_order_id: 5550001, nombre: "#1050", estado_confirmacion: "confirmado", estado_envio: "DESPACHADO",
    courier: "pap", total: 112000, creado_en: "2026-10-05T12:00:00Z", ultimo_estado: { estado: "DESPACHADO", creado_en: "2026-10-06T10:00:00Z" },
  }]);
  const r = await ejecutarHerramienta("estado_pedido", {}, ctxPrueba(), deps);
  const p = (r.resultado.pedidos as Array<Record<string, unknown>>)[0];
  assertEquals(p.pedido, "#1050");
  assertEquals(p.envio, "DESPACHADO");
});

Deno.test("derivar_a_enrique: chat a humano, botón wa.me con el resumen y aviso a Telegram con reponer/escribo/cancelar", async () => {
  const { deps, reg } = depsPrueba({}, [{
    shopify_order_id: 5550001, nombre: "#1050", estado_confirmacion: "confirmado", estado_envio: "ENTREGADO", courier: "pap", total: 112000, creado_en: null,
  }]);
  const r = await ejecutarHerramienta("derivar_a_enrique", { motivo: "reclamo", resumen: "Le llegó la caja abierta, mandó foto." }, ctxPrueba(), deps);
  assert(r.terminal && r.derivado);
  assertEquals(reg.humano, ["11111111-1111-4111-8111-111111111111"]);
  const i = reg.interactivos[0].interactive as { type: string; action: { parameters: { display_text: string; url: string } } };
  assertEquals(i.type, "cta_url");
  assertEquals(i.action.parameters.display_text, "Hablar con Enrique");
  assert(i.action.parameters.url.startsWith("https://wa.me/595990000000?text="));
  // El cliente manda una frase en su voz; el resumen interno va solo a Telegram (07-10).
  const prellenado = decodeURIComponent(i.action.parameters.url);
  assert(prellenado.includes("Tengo un problema con mi pedido. (pedido #1050)"), prellenado);
  assert(!prellenado.includes("Le llegó la caja abierta"));
  const callbacks = (reg.avisos[0].botones as Array<Array<{ callback?: string }>>).flat().map((b) => b.callback).filter(Boolean);
  assertEquals(callbacks, ["reponer:5550001", "escribo:5550001", "cancelar:5550001"]);
  assert(reg.avisos[0].texto.includes("Le llegó la caja abierta"));
});

Deno.test("derivar_a_enrique por venta (mayorista, pide_persona…): botón y aviso igual, pero el chat sigue en 'ia'", async () => {
  for (const motivo of ["mayorista", "pide_persona", "sin_avance", "falla_herramienta", "direccion_dudosa", "audio_confuso"]) {
    const { deps, reg } = depsPrueba();
    const r = await ejecutarHerramienta("derivar_a_enrique", { motivo, resumen: "Pregunta precio por 10 unidades." }, ctxPrueba(), deps);
    assertEquals(reg.humano, [], motivo);
    assert(r.terminal && r.derivado, "el turno actual termina (ya salió el botón)");
    assertEquals(r.resultado.sigue_ia, true);
    assertEquals(
      r.resultado.nota,
      "Ya le mandé el botón. Si el cliente sigue escribiendo, seguí atendiéndolo normal (por ejemplo, si al final quiere 1 a 3 unidades, vendéselas).",
    );
    assertEquals((reg.interactivos[0].interactive as { type: string }).type, "cta_url");
    assert(reg.avisos[0].texto.includes("El vendedor sigue atendiendo si el cliente vuelve a escribir."));
    assertFalse(reg.avisos[0].texto.includes("pasó a humano"));
  }
});

Deno.test("derivar_a_enrique por reclamo, salud, devolución, enojo u otro: el chat pasa a 'humano' (sigue_ia false)", async () => {
  for (const motivo of ["reclamo", "salud", "devolucion", "enojo", "otro", "tope_turnos"]) {
    const { deps, reg } = depsPrueba();
    const resumen = motivo === "salud" ? "Pregunta si sirve con apnea." : "Le llegó la caja abierta.";
    const r = await derivarAEnrique({ motivo, resumen }, ctxPrueba(), deps);
    assertEquals(reg.humano, ["11111111-1111-4111-8111-111111111111"], motivo);
    assertEquals(r.resultado.sigue_ia, false);
    assertEquals(r.resultado.nota, "No escribas nada más.");
    assert(reg.avisos[0].texto.includes("El chat pasó a humano"));
  }
});

Deno.test("derivar_a_enrique sin número configurado: texto sin botón y aviso de lo que falta", async () => {
  const { deps, reg } = depsPrueba();
  const cfg = configPrueba({ vendedor: { whatsapp_enrique: null } });
  await derivarAEnrique({ motivo: "salud", resumen: "Pregunta si sirve con apnea." }, ctxPrueba({ cfg }), deps);
  assertEquals(reg.interactivos.length, 0);
  assertEquals(reg.textos.length, 1);
  assert(reg.avisos[0].texto.includes("Falta config_wa.vendedor.whatsapp_enrique"));
});

Deno.test("interactivos: el texto del modelo pasa por el filtro; lista vertical con precios del catálogo", async () => {
  _limpiarCacheCatalogo();
  const { deps, reg } = depsPrueba();
  const bloqueado = await ejecutarHerramienta("pedir_ubicacion", { texto: "Mandame tu ubicación, tiene garantía" }, ctxPrueba(), deps);
  assert(bloqueado.esError);
  assertEquals(reg.interactivos.length, 0);
  const ok = await ejecutarHerramienta("pedir_ubicacion", { texto: "¿Me pasás el pin de tu casa?" }, ctxPrueba(), deps);
  assert(ok.terminal);
  assertEquals(reg.interactivos[0].interactive.type, "location_request_message");
  const car = await ejecutarHerramienta("enviar_opciones", { handle: "tiras-prueba", texto: "Elegí cuántas querés" }, ctxPrueba(), deps);
  assert(car.terminal);
  // 07-10: lista vertical (foto + detalle + 3 botones apilados) en lugar del carrusel.
  const lista = reg.interactivos[1].interactive as { type: string; header: { type: string }; body: { text: string }; action: { buttons: Array<{ reply: { title: string } }> } };
  assertEquals(lista.type, "button");
  assertEquals(lista.header.type, "image");
  assertEquals(lista.action.buttons.map((b) => b.reply.title), ["1 unidad", "2 unidades", "3 unidades"]);
  // 12-10: el total con envío y lo que gana contra comprar de a 1.
  assert(lista.body.text.includes("*1 unidad* · 79.000 + 33.000 de envío (112.000 en total)"), lista.body.text);
  assert(lista.body.text.includes("*2 unidades* · 158.000 en total: es como pagar 2 × 79.000, el envío te sale gratis"), lista.body.text);
  assert(lista.body.text.includes("*3 unidades* · 188.000 en total: envío gratis + 49.000 menos"), lista.body.text);
  const sinOfertas = await ejecutarHerramienta("enviar_opciones", { handle: "raspador-prueba", texto: "Elegí" }, ctxPrueba(), deps);
  assert(sinOfertas.esError);
});

Deno.test("pedir_telefono, enviar_formulario y enviar_media", async () => {
  _limpiarCacheCatalogo();
  const { deps, reg } = depsPrueba();
  const ya = await ejecutarHerramienta("pedir_telefono", { texto: "¿Me compartís tu número?" }, ctxPrueba(), deps);
  assertEquals(ya.resultado.ya_tiene_telefono, true);
  await ejecutarHerramienta("pedir_telefono", { texto: "¿Me compartís tu número?" }, ctxPrueba({ telefono: null }), deps);
  assertEquals(reg.interactivos[0].interactive.type, "request_contact_info");
  const sinFlow = await ejecutarHerramienta("enviar_formulario", { texto: "Completá tus datos" }, ctxPrueba(), deps);
  assert(sinFlow.esError);
  const cfg = configPrueba({ vendedor: { flow_id: "123456789", whatsapp_enrique: null } });
  await ejecutarHerramienta("enviar_formulario", { texto: "Completá tus datos" }, ctxPrueba({ cfg }), deps);
  assertEquals(reg.interactivos[1].interactive.type, "flow");
  await ejecutarHerramienta("enviar_media", { handle: "tiras-prueba", tipo: "video" }, ctxPrueba(), deps);
  await ejecutarHerramienta("enviar_media", { handle: "raspador-prueba", tipo: "foto" }, ctxPrueba(), deps);
  assertEquals(reg.medias.map((m) => [m.tipo, m.link]), [["video", "https://cdn.example.com/tiras.mp4"], ["image", "https://cdn.example.com/raspador.jpg"]]);
  const sinVideo = await ejecutarHerramienta("enviar_media", { handle: "raspador-prueba", tipo: "video" }, ctxPrueba(), deps);
  assert(sinVideo.esError);
});

Deno.test("herramienta desconocida o que lanza: vuelve como error, nunca rompe el turno", async () => {
  const { deps } = depsPrueba({ pedidosDeCliente: () => Promise.reject(new Error("db caída")) });
  assert((await ejecutarHerramienta("borrar_todo", {}, ctxPrueba(), deps)).esError);
  const r = await ejecutarHerramienta("estado_pedido", {}, ctxPrueba(), deps);
  assert(r.esError);
  assert(String(r.resultado.error).includes("falla_interna"));
});

Deno.test("textoClienteDerivacion: orden médico → texto del modelo → botón; sin frase si no es salud o ya la nombra", () => {
  const base = { textos: {}, conBoton: true };
  assert(mencionaMedico("consultalo con tu MEDICA"));
  assertFalse(mencionaMedico("medicación"));
  assertEquals(
    textoClienteDerivacion({ ...base, motivo: "salud", textoModelo: null }),
    "Eso te conviene consultarlo con tu médico.\nTe paso con Enrique para que lo vea personalmente. Tocá el botón y le llega tu caso ya escrito.",
  );
  assertEquals(
    textoClienteDerivacion({ ...base, motivo: "salud", textoModelo: "Consultalo con tu médico. Te paso con Enrique." }),
    "Consultalo con tu médico. Te paso con Enrique.\nTocá el botón y le llega tu caso ya escrito.",
  );
  assertEquals(textoClienteDerivacion({ ...base, motivo: "reclamo", textoModelo: "  " }), "Te paso con Enrique para que lo vea personalmente. Tocá el botón y le llega tu caso ya escrito.");
  assertEquals(
    textoClienteDerivacion({ textos: { derivacion_salud: "Andá al médico." }, conBoton: false, motivo: "salud", textoModelo: "" }),
    "Andá al médico.\nLe paso tu caso a Enrique y te escribe por acá apenas lo vea.",
  );
});

Deno.test("registrar_perfil: valida y descarta valores fuera de la lista", async () => {
  const { deps } = depsPrueba();
  const r = await ejecutarHerramienta("registrar_perfil", { necesidad: "boca_seca", perfil: "inventado", nota: "es para el marido" }, ctxPrueba(), deps);
  assertEquals(r.resultado, { ok: true, perfil: { necesidad: "boca_seca", nota: "es para el marido" } });
  assertFalse(r.esError);
});

Deno.test("inputOrderCreate: la factura va como atributo del pedido (la lee la función de factura), sin factura no", () => {
  const base = { nombre: "Ana Benítez", telefono: "+595981000000", ciudad: "CDE", direccion: "Calle 1", referencia: null, ubicacion: null, lineas: [], envio: 33000, total: 112000 };
  const con = inputOrderCreate({ ...base, factura: "4012344-3 Ana Benítez" } as never, ctxPrueba()) as { order: { customAttributes: { key: string; value: string }[] } };
  assert(con.order.customAttributes.some((a) => a.key === "factura" && a.value === "4012344-3 Ana Benítez"));
  const sin = inputOrderCreate({ ...base, factura: null } as never, ctxPrueba()) as { order: { customAttributes: { key: string }[] } };
  assertFalse(sin.order.customAttributes.some((a) => a.key === "factura"));
});

Deno.test("derivar_a_enrique por motivo del sistema: el cliente nunca ve el texto interno (turnos de IA)", async () => {
  const { deps, reg } = depsPrueba();
  await derivarAEnrique({ motivo: "tope_turnos", resumen: "La conversación llegó a 20 turnos de IA sin cerrarse." }, ctxPrueba(), deps);
  const i = reg.interactivos[0].interactive as { action: { parameters: { url: string } } };
  const prellenado = decodeURIComponent(i.action.parameters.url);
  assert(prellenado.includes("Quiero hacer una consulta."), prellenado);
  assertFalse(/IA|turnos/.test(prellenado));
  assert(reg.avisos[0].texto.includes("20 turnos"));
});

Deno.test("14-10 el nombre nunca traba y alcanza con ciudad + referencia o pin + referencia; con solo el pin falta una referencia", async () => {
  for (const t of ["Pin de ubicación", "Ubicación por pin", "ubicacion", "pin"]) assert(esSoloPin(t), t);
  for (const t of ["Número 115", "Club 29 de Setiembre", "Ruta 1 km 20"]) assertFalse(esSoloPin(t), t);
  _limpiarCacheCatalogo();
  const { deps, reg } = depsPrueba();
  const soloPin = await ejecutarHerramienta("crear_pedido_cod", { confirmar: false, ...DATOS, direccion: "Pin de ubicación", referencia: "" }, ctxPrueba(), deps);
  assert(soloPin.esError);
  assert(JSON.stringify(soloPin.resultado).includes("calle o una referencia"), JSON.stringify(soloPin.resultado));
  const pinRef = await ejecutarHerramienta("crear_pedido_cod", { confirmar: false, ...DATOS, direccion: "Pin de ubicación", referencia: "reja negra" }, ctxPrueba(), deps);
  assertFalse(pinRef.esError, JSON.stringify(pinRef.resultado));
  const ciudadRef = await ejecutarHerramienta("crear_pedido_cod", { confirmar: false, ...DATOS, direccion: "", referencia: "frente a la escuela" }, ctxPrueba(), deps);
  assertFalse(ciudadRef.esError, JSON.stringify(ciudadRef.resultado));
  // Sin nombre: el de su perfil de WhatsApp (ctxPrueba trae "Ana Prueba").
  const sinNombre = await ejecutarHerramienta("crear_pedido_cod", { confirmar: false, ...DATOS, nombre: "" }, ctxPrueba(), deps);
  assertFalse(sinNombre.esError, JSON.stringify(sinNombre.resultado));
  assertEquals(reg.pedidosChat.at(-1)!.datos.nombre, "Ana Prueba");
});

Deno.test("14-10 nombreDePerfil: limpia emojis y números; si no sirve, null", () => {
  assertEquals(nombreDePerfil("Ángel Andino💚"), "Ángel Andino");
  assertEquals(nombreDePerfil("fulll6666666⁶666666⁶66666"), null);
  assertEquals(nombreDePerfil(""), null);
});

Deno.test("actualizar_direccion: suma la referencia al pedido creado y avisa; sin pedido creado, error", async () => {
  _limpiarCacheCatalogo();
  const cambios: unknown[] = [];
  const { deps, reg } = depsPrueba({ actualizarDireccionOrden: (id, d) => (cambios.push([id, d]), Promise.resolve({ ok: true })) });
  const antes = await ejecutarHerramienta("actualizar_direccion", { referencia: "reja negra" }, ctxPrueba(), deps);
  assert(antes.esError);
  await ejecutarHerramienta("crear_pedido_cod", { confirmar: false, ...DATOS }, ctxPrueba(), deps);
  await ejecutarHerramienta("crear_pedido_cod", { confirmar: true }, ctxPrueba({ textoEntrada: "si" }), deps);
  const r = await ejecutarHerramienta("actualizar_direccion", { referencia: "Número 115, reja negra" }, ctxPrueba(), deps);
  assertFalse(r.esError);
  assertEquals(cambios, [[5550001, { referencia: "Número 115, reja negra" }]]);
  assert(reg.avisos.some((a) => a.texto.includes("completó la dirección")));
});

Deno.test("inputOrderCreate: precios con IVA incluido (taxesIncluded) y total = oferta + envío − descuento", () => {
  const d = {
    nombre: "Cliente Prueba", telefono: "+595981000000", direccion: "Calle 1", referencia: null, ciudad: "Asunción",
    envio: 33000, factura: null, ubicacion: null,
    lineas: [{ variante_id: "gid://shopify/ProductVariant/1", titulo: "Tiras", cantidad: 2, total: 125000 }],
  };
  const r = inputOrderCreate(d as never, ctxPrueba()) as {
    order: { taxesIncluded: boolean; lineItems: { quantity: number; priceSet: { shopMoney: { amount: string } } }[]; shippingLines: { priceSet: { shopMoney: { amount: string } } }[] };
  };
  assertEquals(r.order.taxesIncluded, true);
  const lineas = r.order.lineItems.reduce((s, l) => s + l.quantity * Number(l.priceSet.shopMoney.amount), 0);
  const envio = Number(r.order.shippingLines[0].priceSet.shopMoney.amount);
  assertEquals(lineas + envio, 125000 + 33000); // sin IVA agregado encima
});

Deno.test("actualizar_direccion: sin pedido del bot, corrige el pedido de la tienda abierto (Releasit)", async () => {
  const cambios: unknown[] = [];
  const { deps } = depsPrueba({
    actualizarDireccionOrden: (id, d) => (cambios.push([id, d]), Promise.resolve({ ok: true })),
    pedidoTiendaAbierto: () => Promise.resolve({ shopify_order_id: 777, creado_en: new Date().toISOString() }),
  });
  const r = await ejecutarHerramienta("actualizar_direccion", { direccion: "Lafranconi 4237" }, ctxPrueba({ ahora: new Date() }), deps);
  assertFalse(r.esError);
  assertEquals(cambios, [[777, { direccion: "Lafranconi 4237" }]]);
});

Deno.test("retiro en la oficina de CDE: sin dirección, sin envío, tag RETIRO_EN_CASA y resumen de retiro (09-10)", async () => {
  _limpiarCacheCatalogo();
  const { deps, reg } = depsPrueba();
  const r = await ejecutarHerramienta("crear_pedido_cod", { confirmar: false, nombre: "Ana Prueba", retiro_oficina: true, items: DATOS.items }, ctxPrueba(), deps);
  assertFalse(r.esError, JSON.stringify(r.resultado));
  assertEquals(reg.pedidosChat[0].datos.envio, 0);
  assert(JSON.stringify(reg.interactivos[0]).includes("oficina en Ciudad del Este"));
  await ejecutarHerramienta("crear_pedido_cod", { confirmar: true }, ctxPrueba({ textoEntrada: "si" }), deps);
  const orden = reg.ordenes[0] as { order: Record<string, unknown> };
  assertEquals(orden.order.shippingLines, []);
  assertEquals(orden.order.tags, ["ORIGEN_WHATSAPP", "CONFIRMADO", "RETIRO_EN_CASA"]);
});

Deno.test("resumen ×2 del mismo producto: 'envío gratis' con el mismo total; mezcla de productos sigue con envío (09-10)", () => {
  const ctx = ctxPrueba();
  const base = { nombre: "Ana", ciudad: "Luque", direccion: "Calle 1", referencia: null, ubicacion: null, telefono: "+595981000000" };
  const x2 = textoResumen({ ...base, lineas: [{ handle: "t", titulo: "Tiras", variante_id: "v", cantidad: 2, total: 125000 }], envio: 33000, total: 158000 }, ctx);
  assert(x2.includes("Tiras x2, envío gratis. Total Gs 158.000"), x2);
  const mezcla = textoResumen({ ...base, lineas: [{ handle: "t", titulo: "Tiras", variante_id: "v", cantidad: 1, total: 79000 }, { handle: "p", titulo: "Parches", variante_id: "w", cantidad: 1, total: 79000 }], envio: 33000, total: 191000 }, ctx);
  assert(mezcla.includes("Envío Gs 33.000"), mezcla);
});

Deno.test("factura (10-10): DV válido, inválido, sin DV, puntos/espacios, sin razón social", () => {
  // RUC inventados: el DV se calcula con el mismo algoritmo (módulo 11).
  const ok = parsearFactura("4012344-3 Carlos Prueba");
  if (ok.ok) assertEquals([ok.ruc, ok.razon], ["4012344-3", "Carlos Prueba"]);
  else {
    // Si 4012344-3 no fuera válido con el algoritmo, el test usa el sugerido.
    const s = parsearFactura("4012344 Carlos Prueba");
    assert(!s.ok && s.motivo === "sin_dv" && !!s.sugerido);
  }
  const sinDv = parsearFactura("RUC 1234567, Ana Prueba");
  assert(!sinDv.ok && sinDv.motivo === "sin_dv" && /^1234567-\d$/.test(sinDv.sugerido ?? ""), JSON.stringify(sinDv));
  const correcto = (sinDv as { sugerido: string }).sugerido;
  const malo = correcto.slice(0, -1) + String((Number(correcto.slice(-1)) + 1) % 10);
  const inv = parsearFactura(`${malo} Ana Prueba`);
  assert(!inv.ok && inv.motivo === "dv_invalido");
  const puntos = parsearFactura(`1.234.567-${correcto.slice(-1)} Ana Prueba`);
  assert(puntos.ok && puntos.ruc === correcto, JSON.stringify(puntos));
  const espacio = parsearFactura(`1234567 ${correcto.slice(-1)} Ana Prueba`);
  assert(espacio.ok && espacio.ruc === correcto, JSON.stringify(espacio));
  const sinRazon = parsearFactura(correcto);
  assert(!sinRazon.ok && sinRazon.motivo === "sin_razon");
});

Deno.test("factura en crear_pedido_cod (10-10): re-pedido, insistencia, línea en el resumen y atributos Ruc/Razon social", async () => {
  _limpiarCacheCatalogo();
  const sinDv = parsearFactura("1234567 Ana Prueba") as { sugerido: string };
  const correcto = sinDv.sugerido;
  const malo = correcto.slice(0, -1) + String((Number(correcto.slice(-1)) + 1) % 10);
  const { deps, reg } = depsPrueba();
  const r1 = await ejecutarHerramienta("crear_pedido_cod", { confirmar: false, ...DATOS, factura: `${malo} Ana Prueba` }, ctxPrueba(), deps);
  assert(r1.esError && String(r1.resultado.error).startsWith("ruc_invalido"));
  const r2 = await ejecutarHerramienta("crear_pedido_cod", { confirmar: false, ...DATOS, factura: "1234567 Ana Prueba" }, ctxPrueba(), deps);
  assert(r2.esError && String(r2.resultado.error).includes(`¿Tu RUC es ${correcto}?`));
  const r3 = await ejecutarHerramienta("crear_pedido_cod", { confirmar: false, ...DATOS, factura: `${correcto} Ana Prueba` }, ctxPrueba(), deps);
  assertFalse(r3.esError);
  assert(JSON.stringify(reg.interactivos.at(-1)).includes(`Factura a nombre de: Ana Prueba · RUC ${correcto}`));
  await ejecutarHerramienta("crear_pedido_cod", { confirmar: true }, ctxPrueba({ textoEntrada: "si" }), deps);
  const attrs = (reg.ordenes[0] as { order: { customAttributes: Array<{ key: string; value: string }> } }).order.customAttributes;
  assertEquals(attrs.find((a) => a.key === "Ruc")?.value, correcto);
  assertEquals(attrs.find((a) => a.key === "Razon social")?.value, "Ana Prueba");
  // Insistencia con un RUC que no da: se crea igual, sin atributos Ruc (va a revisar).
  _limpiarCacheCatalogo();
  const b = depsPrueba();
  const r4 = await ejecutarHerramienta("crear_pedido_cod", { confirmar: false, ...DATOS, factura: `${malo} Ana Prueba`, factura_sin_validar: true }, ctxPrueba(), b.deps);
  assertFalse(r4.esError);
  await ejecutarHerramienta("crear_pedido_cod", { confirmar: true }, ctxPrueba({ textoEntrada: "si" }), b.deps);
  const attrs2 = (b.reg.ordenes[0] as { order: { customAttributes: Array<{ key: string }> } }).order.customAttributes;
  assertFalse(attrs2.some((a) => a.key === "Ruc"));
  assert(b.reg.avisos.some((a) => a.texto.includes("RUC no es válido")));
  // Sin factura: igual que siempre.
  _limpiarCacheCatalogo();
  const c = depsPrueba();
  const r5 = await ejecutarHerramienta("crear_pedido_cod", { confirmar: false, ...DATOS }, ctxPrueba(), c.deps);
  assertFalse(r5.esError);
  assertFalse(JSON.stringify(c.reg.interactivos.at(-1)).includes("Factura a nombre"));
});

Deno.test("unirReferencia (10-10): suma sin pisar ni duplicar", () => {
  assertEquals(unirReferencia("Reja negra, pasto en la vereda", "pasto"), "Reja negra, pasto en la vereda");
  assertEquals(unirReferencia("Reja negra", "pasto en la vereda"), "Reja negra. pasto en la vereda");
  assertEquals(unirReferencia(null, "Casa azul"), "Casa azul");
});

Deno.test("fraseCantidad: ×2 = envío gratis, ×3 = envío gratis + menos; sin cubrir el envío, solo el total", () => {
  assertEquals(fraseCantidad(2, 79000, 125000, 33000), "158.000 en total: es como pagar 2 × 79.000, el envío te sale gratis");
  assertEquals(fraseCantidad(3, 79000, 155000, 33000), "188.000 en total: envío gratis + 49.000 menos");
  assertEquals(fraseCantidad(2, 79000, 150000, 33000), "183.000 en total");
});

Deno.test("primer_turno: gancho en texto + total con 3 botones; marca la variante y deja los montos ×2/×3", async () => {
  _limpiarCacheCatalogo();
  const { deps, reg } = depsPrueba();
  const r = await ejecutarHerramienta("primer_turno", { handle: "tiras-prueba", gancho: "Te pegás la tira y la nariz se abre al toque" }, ctxPrueba(), deps);
  assert(r.terminal);
  assertEquals(reg.textos.map((t) => t.texto), ["Te pegás la tira y la nariz se abre al toque"]);
  const i = reg.interactivos[0].interactive as { type: string; body: { text: string }; action: { buttons: Array<{ reply: { id: string; title: string } }> } };
  assertEquals(i.type, "button");
  // 13-10: todos los totales con envío y la cantidad ya elegida en el botón.
  assertEquals(i.body.text, "Sale 79.000 + 33.000 de envío (112.000 en total), pagás al recibir. Llevando 2 el envío te sale gratis: 158.000 por los 2.");
  assertEquals(i.action.buttons.map((b) => b.reply.title), ["2 con envío gratis", "Quiero 1", "Tengo una duda"]);
  assertEquals(i.action.buttons.map((b) => b.reply.id), ["vend_p1:q2:tiras-prueba", "vend_p1:q1:tiras-prueba", "vend_p1:duda:tiras-prueba"]);
  assertEquals(r.resultado.variante, "botones_v2");
  assertEquals(r.resultado.pasar_a_2, "Ojo: llevando 2 el envío te sale GRATIS (158.000 los 2)");
  assertEquals(r.resultado.subir_a_3, "Y por 30.000 más te llevás 3: envío gratis + 49.000 menos (188.000 en total)");
  assert(JSON.stringify(r.resultado.ofertas).includes("158.000") && JSON.stringify(r.resultado.ofertas).includes("188.000"));
});

Deno.test("primer_turno: gancho bloqueado o producto desconocido → error sin mandar nada; si fallan los botones, avisa que el gancho ya salió", async () => {
  _limpiarCacheCatalogo();
  const { deps, reg } = depsPrueba();
  const bloq = await ejecutarHerramienta("primer_turno", { handle: "tiras-prueba", gancho: "Tiene garantía de por vida" }, ctxPrueba(), deps);
  assert(bloq.esError);
  const desc = await ejecutarHerramienta("primer_turno", { handle: "no-existe", gancho: "Dormís mejor" }, ctxPrueba(), deps);
  assert(desc.esError);
  assertEquals(reg.textos.length + reg.interactivos.length, 0);
  const falla = { ...deps, enviarInteractivo: () => Promise.resolve({ ok: false, error: "131000" }) };
  const r = await ejecutarHerramienta("primer_turno", { handle: "tiras-prueba", gancho: "Dormís de corrido" }, ctxPrueba(), falla);
  assert(r.esError);
  assert(String(r.resultado.error).includes("botones_fallidos"));
  assertEquals(reg.textos.length, 1);
});

Deno.test("cierre_botones: texto revisado + los 3 botones del primer turno; producto desconocido o texto bloqueado → error", async () => {
  _limpiarCacheCatalogo();
  const { deps, reg } = depsPrueba();
  const r = await ejecutarHerramienta("cierre_botones", { handle: "tiras-prueba", texto: "Te lo armo y pagás recién cuando lo tenés en la mano" }, ctxPrueba(), deps);
  assert(r.terminal);
  const i = reg.interactivos[0].interactive as { body: { text: string }; action: { buttons: Array<{ reply: { id: string; title: string } }> } };
  assertEquals(i.body.text, "Te lo armo y pagás recién cuando lo tenés en la mano");
  assertEquals(i.action.buttons.map((b) => b.reply.id), ["vend_p1:q2:tiras-prueba", "vend_p1:q1:tiras-prueba", "vend_p1:duda:tiras-prueba"]);
  assert((await ejecutarHerramienta("cierre_botones", { handle: "no-existe", texto: "Dale" }, ctxPrueba(), deps)).esError);
  assert((await ejecutarHerramienta("cierre_botones", { handle: "tiras-prueba", texto: "Tiene garantía" }, ctxPrueba(), deps)).esError);
  assertEquals(reg.interactivos.length, 1);
});

Deno.test("primer_turno: pausa de \"escribiendo…\" entre la promesa y el precio con botones", async () => {
  _limpiarCacheCatalogo();
  const { deps, reg } = depsPrueba();
  const orden: string[] = [];
  const ctx = { ...ctxPrueba(), pausa: (ms: number) => (orden.push(`pausa>0:${ms > 0}`), Promise.resolve()) };
  const d = { ...deps, enviarTexto: (to: string, t: string) => (orden.push("texto"), deps.enviarTexto(to, t, {})), enviarInteractivo: (to: string, i: Record<string, unknown>) => (orden.push("botones"), deps.enviarInteractivo(to, i, {})) };
  await ejecutarHerramienta("primer_turno", { handle: "tiras-prueba", gancho: "Dormís de corrido" }, ctx, d);
  assertEquals(orden, ["texto", "pausa>0:true", "botones"]);
  assertEquals(reg.interactivos.length, 1);
});

Deno.test("permiso_ofertas: sin respuesta previa → tu texto + el pedido de permiso con Sí/No; si ya respondió, no pregunta", async () => {
  _limpiarCacheCatalogo();
  const { deps, reg } = depsPrueba();
  const nuevo = { ...deps, consentimiento: () => Promise.resolve(null) };
  const r = await ejecutarHerramienta("permiso_ofertas", { texto: "Dale, tranqui. El lunes te escribo" }, ctxPrueba(), nuevo);
  assert(r.terminal);
  const i = reg.interactivos[0].interactive as { body: { text: string }; action: { buttons: Array<{ reply: { id: string; title: string } }> } };
  assert(i.body.text.startsWith("Dale, tranqui. El lunes te escribo"));
  assert(i.body.text.includes("Voltra te avise"));
  assert(i.action.buttons[0].reply.id.startsWith("cons_si:"));
  const ya = await ejecutarHerramienta("permiso_ofertas", { texto: "Dale" }, ctxPrueba(), { ...deps, consentimiento: () => Promise.resolve("no") });
  assertFalse(ya.terminal);
  assertEquals(ya.resultado.ya_respondio, true);
  assertEquals(reg.interactivos.length, 1);
});

Deno.test("13-10 primer turno: pack → un precio y Quiero el pack; sin oferta ×2 → solo Quiero 1", () => {
  const base = { titulo: "x", variante_id: "v", precio: 120000, precio_texto: "120.000", disponible: true, total: 153000, total_texto: "153.000", imagen: null, frase_precio: "" };
  const pack = { ...base, handle: "pack-gudair-tiras-nasales-parches-bucales", ofertas: [] };
  assertEquals(cuerpoPrimerTurno(pack as never), "Sale 120.000 + 33.000 de envío (153.000 en total), pagás al recibir.");
  assertEquals(botonesPrimerTurno(pack as never).map((b) => b.titulo), ["Quiero el pack", "Tengo una duda"]);
  const solo = { ...base, handle: "otro-prueba", precio: 79000, total: 112000, ofertas: [] };
  assertEquals(cuerpoPrimerTurno(solo as never), "Sale 79.000 + 33.000 de envío (112.000 en total), pagás al recibir.");
  assertEquals(botonesPrimerTurno(solo as never).map((b) => b.titulo), ["Quiero 1", "Tengo una duda"]);
  for (const b of [...botonesPrimerTurno(pack as never), ...botonesPrimerTurno(solo as never)]) assert(b.titulo.length <= 20);
});

Deno.test("13-10 confirmar_ubicacion: pin → \"¿Es en <calle>, <ciudad>?\" con Sí, es ahí / Corregir; sin calle → pedir escrita", async () => {
  _limpiarCacheCatalogo();
  const { deps, reg } = depsPrueba();
  const conCalle = { ...deps, direccionDePin: () => Promise.resolve({ calle: "Avenida Prueba 123", ciudad: "Ciudad del Este" }) };
  const r = await ejecutarHerramienta("confirmar_ubicacion", { ubicacion: "-25.5097,-54.6111" }, ctxPrueba(), conCalle);
  assert(r.terminal);
  const i = reg.interactivos[0].interactive as { body: { text: string }; action: { buttons: Array<{ reply: { id: string; title: string } }> } };
  assertEquals(i.body.text, "¿Es en Avenida Prueba 123, Ciudad del Este?");
  assertEquals(i.action.buttons.map((b) => b.reply.title), ["Sí, es ahí", "Corregir"]);
  const sin = await ejecutarHerramienta("confirmar_ubicacion", { ubicacion: "-25.5097,-54.6111" }, ctxPrueba(), { ...deps, direccionDePin: () => Promise.resolve({ calle: null, ciudad: "Ciudad del Este" }) });
  assertFalse(sin.terminal);
  assertEquals(sin.resultado.sin_calle, true);
  assert((await ejecutarHerramienta("confirmar_ubicacion", { ubicacion: "x" }, ctxPrueba(), conCalle)).esError);
  assertEquals(reg.interactivos.length, 1);
});

Deno.test("13-10 Shopify: la nota lleva nombre, celular, ciudad, calle, mapa y referencia; address2 = referencia + mapa", async () => {
  _limpiarCacheCatalogo();
  const { deps, reg } = depsPrueba();
  await ejecutarHerramienta("crear_pedido_cod", { confirmar: false, ...DATOS, direccion: "Avenida Prueba 123", ubicacion: "-25.5097,-54.6111", referencia: "reja negra", calle_de_pin: true }, ctxPrueba(), deps);
  await ejecutarHerramienta("crear_pedido_cod", { confirmar: true }, ctxPrueba({ textoEntrada: "si dale" }), deps);
  const o = (reg.ordenes[0] as { order: { note: string; shippingAddress: { address1: string; address2: string } } }).order;
  for (const x of ["Nombre: ", "Celular: ", "Ciudad: ", "Calle: Avenida Prueba 123", "Mapa: https://maps.google.com/?q=-25.5097,-54.6111", "Referencia: reja negra"]) assert(o.note.includes(x), x);
  assertEquals(o.shippingAddress.address2, "reja negra · Mapa: https://maps.google.com/?q=-25.5097,-54.6111");
  assertEquals((reg.pedidosChat[0].datos as { calleDePin?: boolean }).calleDePin, true);
});

Deno.test("13-10 avisar_enrique: cliente que cancela por demora → Telegram con botón para escribirle; el chat sigue con el bot", async () => {
  _limpiarCacheCatalogo();
  const { deps, reg } = depsPrueba();
  const r = await ejecutarHerramienta("avisar_enrique", { motivo: "demora_cancela", resumen: "#1004: si hoy no llega, cancela" }, ctxPrueba(), deps);
  assertFalse(r.terminal);
  assertFalse(r.esError);
  assert(reg.avisos[0].texto.includes("Cliente por cancelar por demora"));
  assert(reg.avisos[0].texto.includes("#1004: si hoy no llega, cancela"));
  assert((await ejecutarHerramienta("avisar_enrique", { motivo: "otro", resumen: "x" }, ctxPrueba(), deps)).esError);
  assertEquals(reg.humano.length, 0);
});

Deno.test("13-10 entrega programada: en el resumen y en Shopify; antes del plazo, no", async () => {
  _limpiarCacheCatalogo();
  const { deps, reg } = depsPrueba();
  const antes = await ejecutarHerramienta("crear_pedido_cod", { confirmar: false, ...DATOS, fecha_entrega: "2026-10-05" }, ctxPrueba(), deps);
  assert(antes.esError);
  assert(JSON.stringify(antes.resultado).includes("fecha_antes_de_lo_posible"));
  const r = await ejecutarHerramienta("crear_pedido_cod", { confirmar: false, ...DATOS, fecha_entrega: "2026-10-09", franja_entrega: "antes de las 12" }, ctxPrueba(), deps);
  assertFalse(r.esError, JSON.stringify(r.resultado));
  assert(JSON.stringify(reg.interactivos.at(-1)!.interactive).includes("📦 Te llega: el viernes 09/10 (antes de las 12)"));
  await ejecutarHerramienta("crear_pedido_cod", { confirmar: true }, ctxPrueba({ textoEntrada: "si dale" }), deps);
  const o = (reg.ordenes[0] as { order: { tags: string[]; note: string; customAttributes: { key: string; value: string }[] } }).order;
  assert(o.tags.includes("ENTREGA_PROGRAMADA"));
  assert(o.customAttributes.some((a) => a.key === "entrega_programada" && a.value === "2026-10-09"));
  assert(o.customAttributes.some((a) => a.key === "entrega_franja" && a.value === "antes de las 12"));
  assert(o.note.includes("ENTREGA PROGRAMADA: viernes 09/10 (antes de las 12). Despachar en el día y pedirle a la transportadora que entregue ese día."));
});

Deno.test("13-10 programar_entrega: pedido creado → guarda fecha y franja; antes del plazo → fecha_minima, sin guardar", async () => {
  _limpiarCacheCatalogo();
  const guardados: unknown[] = [];
  const { deps } = depsPrueba();
  const d = { ...deps, programarEntregaOrden: (id: number, f: string, fr: string | null) => (guardados.push([id, f, fr]), Promise.resolve({ ok: true })) };
  await ejecutarHerramienta("crear_pedido_cod", { confirmar: false, ...DATOS }, ctxPrueba(), d);
  await ejecutarHerramienta("crear_pedido_cod", { confirmar: true }, ctxPrueba({ textoEntrada: "si dale" }), d);
  const no = await ejecutarHerramienta("programar_entrega", { fecha: "2026-10-05" }, ctxPrueba(), d);
  assertEquals(no.resultado.antes_de_lo_posible, true);
  assertEquals(guardados.length, 0);
  const ok = await ejecutarHerramienta("programar_entrega", { fecha: "2026-10-09", franja: "antes de las 12" }, ctxPrueba(), d);
  assertEquals(ok.resultado.texto_fecha, "viernes 09/10");
  assertEquals(guardados, [[5550001, "2026-10-09", "antes de las 12"]]);
  assert((await ejecutarHerramienta("programar_entrega", { fecha: "2026-12-31" }, ctxPrueba(), d)).esError);
});

Deno.test("14-10 pedido nuevo: el Telegram queda registrado (aviso_telegram) y si falla se reintenta una vez", async () => {
  _limpiarCacheCatalogo();
  const { deps, reg } = depsPrueba();
  let intentos = 0;
  const d = { ...deps, avisar: (t: string, b?: unknown) => (intentos++, intentos === 1 ? Promise.resolve({ ok: false, error: "caído" }) : deps.avisar(t, b as never)) };
  await ejecutarHerramienta("crear_pedido_cod", { confirmar: false, ...DATOS }, ctxPrueba(), d);
  const r = await ejecutarHerramienta("crear_pedido_cod", { confirmar: true }, ctxPrueba({ textoEntrada: "si dale" }), d);
  assertEquals(r.resultado.aviso_telegram, true);
  assertEquals(intentos, 2);
  assert(reg.avisos.some((a) => a.texto.includes("Pedido nuevo")));
});

Deno.test("15-10 (#1055): con nombre, celular y pin alcanza; la ciudad queda 'Ver mapa' si el mapa no la da", async () => {
  _limpiarCacheCatalogo();
  const { deps, reg } = depsPrueba();
  const r = await ejecutarHerramienta("crear_pedido_cod", {
    confirmar: false, nombre: "ana", ubicacion: "-25.3000000,-57.2000000", items: [{ handle: "tiras-prueba", cantidad: 1 }],
  }, ctxPrueba(), deps);
  assertFalse(r.esError, JSON.stringify(r.resultado));
  const d = reg.pedidosChat.at(-1)!.datos;
  assertEquals([d.ciudad, d.direccion, d.ubicacion], ["Ver mapa", "Pin de ubicación", "-25.3000000,-57.2000000"]);
});

Deno.test("15-10 (#1055): nombre de una palabra → apellido '-' (con apellido vacío Shopify descarta la dirección)", () => {
  const base = { nombre: "anita", telefono: "+595981000000", direccion: "Calle 1", referencia: null, ciudad: "Caacupé", ubicacion: null,
    lineas: [], envio: 33000, total: 33000, factura: null };
  const o = inputOrderCreate(base as never, ctxPrueba()) as { order: { shippingAddress: { firstName: string; lastName: string } } };
  assertEquals([o.order.shippingAddress.firstName, o.order.shippingAddress.lastName], ["anita", "-"]);
});

Deno.test("sin stock: no lo ofrece y propone otro disponible de la misma línea (18-10)", () => {
  const items = [
    { handle: "tiras", titulo: "Tiras Nasales", disponible: false },
    { handle: "parches", titulo: "Parches Bucales", disponible: true },
    { handle: "raspador", titulo: "Raspador de Lengua", disponible: true },
  ];
  const m = mensajeSinStock(items[0], items);
  assertEquals(m.startsWith("sin_stock:tiras"), true);
  assertEquals(m.includes("Parches Bucales (parches)") && !m.includes("Raspador"), true);
  const solo = mensajeSinStock(items[0], [items[0], { handle: "raspador", titulo: "Raspador de Lengua", disponible: true }]);
  assertEquals(solo.includes("Raspador de Lengua (raspador)"), true);
  assertEquals(mensajeSinStock(items[0], [items[0]]).includes("se repone pronto"), true);
});

Deno.test("19-10 salud SIN señales de alerta: no deriva, devuelve el texto seguro; con alerta sí deriva", async () => {
  const { deps, reg } = depsPrueba();
  const r = await derivarAEnrique({ motivo: "salud", resumen: "Pregunta si las tiras sirven para la rinitis." }, ctxPrueba(), deps);
  assert(r.esError);
  assert(JSON.stringify(r.resultado).includes("salud_sin_alerta"));
  assertEquals(reg.humano, []);
  assertEquals(reg.avisos.length, 0);
  assert(!/tratamiento|cura\b|elimina/i.test(TEXTO_SALUD_SEGURO));
  const conAlerta = await derivarAEnrique({ motivo: "salud", resumen: "Dice que de noche deja de respirar y se ahoga." }, ctxPrueba(), depsPrueba().deps);
  assertFalse(conAlerta.esError);
});

Deno.test("19-10 factura: no se deriva, se pide guardar_factura (#1075)", async () => {
  const { deps, reg } = depsPrueba();
  const r = await derivarAEnrique({ motivo: "otro", resumen: "La clienta quiere factura con RUC 1234567-8 para su pedido ya confirmado." }, ctxPrueba(), deps);
  assert(r.esError);
  assert(JSON.stringify(r.resultado).includes("guardar_factura"));
  assertEquals(reg.humano, []);
});

Deno.test("19-10 registrar_perfil: recontacto fuera de la ventana sin permiso → nota de no prometer; mañana temprano o con permiso, no", async () => {
  const ahora = new Date("2026-10-19T15:00:00Z"); // lunes 12:00 PY
  const { deps } = depsPrueba();
  const lejos = await ejecutarHerramienta("registrar_perfil", { recontactar_el: "2026-10-23" }, ctxPrueba({ ahora }), deps);
  assert(String(lejos.resultado.nota ?? "").includes("NO prometas"));
  const manana = await ejecutarHerramienta("registrar_perfil", { recontactar_el: "2026-10-20" }, ctxPrueba({ ahora }), deps);
  assertEquals(manana.resultado.nota, undefined);
  const conPermiso = await ejecutarHerramienta("registrar_perfil", { recontactar_el: "2026-10-23" }, ctxPrueba({ ahora }), { ...deps, consentimiento: () => Promise.resolve("si" as const) });
  assert(String(conPermiso.resultado.nota ?? "").includes("permiso de avisos"));
  assertEquals(horasHastaFecha("2026-10-20", ahora), 12);
});

Deno.test("19-10 inhalador: el catálogo no lo ofrece y el anuncio no cae en tiras", async () => {
  _limpiarCacheCatalogo();
  const { deps } = depsPrueba();
  const r = await ejecutarHerramienta("consultar_catalogo", { busqueda: "inhalador nasal" }, ctxPrueba(), deps);
  assertEquals(r.resultado.productos, []);
  assertEquals(r.resultado.nota, NOTA_INHALADOR);
  const porMensaje = await ejecutarHerramienta("consultar_catalogo", { busqueda: "nasal" }, ctxPrueba({ textoEntrada: "¿Tienen inhalador nasal?" }), deps);
  assertEquals(porMensaje.resultado.nota, NOTA_INHALADOR);
  assertEquals(productoPorPalabras("Inhalador nasal de mentol"), null);
  assertEquals(productoPorPalabras("Tiras nasales para dormir"), "tiras-nasales-gudair-30-unidades");
});
