import { assert, assertEquals, assertFalse } from "jsr:@std/assert@1";
import {
  inputOrderCreate,
  _limpiarCacheCatalogo,
  derivarAEnrique,
  ejecutarHerramienta,
  HERRAMIENTAS,
  lineasShopify,
  mencionaMedico,
  precioPorCantidad,
  textoClienteDerivacion,
} from "./herramientas.ts";
import { configPrueba, ctxPrueba, depsPrueba } from "./prueba_utiles.ts";

Deno.test("definiciones: las 9 herramientas del contrato + registrar_perfil, con JSON Schema", () => {
  assertEquals(HERRAMIENTAS.map((h) => h.name).sort(), [
    "consultar_catalogo", "crear_pedido_cod", "derivar_a_enrique", "enviar_formulario", "enviar_media",
    "enviar_opciones", "estado_pedido", "pedir_telefono", "pedir_ubicacion", "registrar_perfil",
  ]);
  for (const h of HERRAMIENTAS) assertEquals(h.input_schema.type, "object");
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
  assertEquals(i.action.buttons.map((b) => b.reply.title), ["Confirmar", "Corregir"]);
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
  assertEquals(orden.order.tags, ["ORIGEN_WHATSAPP"]);
  assertEquals((orden.order.shippingAddress as Record<string, unknown>).firstName, "Ana"); // usa el resumen, no lo que reescribe el modelo
  assertEquals(orden.options.inventoryBehaviour, "DECREMENT_OBEYING_POLICY");
  assertEquals(orden.options.sendReceipt, false);
  assertEquals(reg.releasit.length, 1);
  assertEquals(reg.pedidosChat[0].estado, "creado");
  const aviso = reg.avisos[0];
  assert(aviso.texto.includes("Pedido nuevo #1050"));
  assertEquals((aviso.botones as Array<Array<{ callback?: string }>>)[0][0].callback, "cancelar:5550001");
  assert(String(r.resultado.texto_respuesta).includes("Listo Ana, ya cargamos tu pedido #1050"));

  // Repetir no duplica.
  const otra = await ejecutarHerramienta("crear_pedido_cod", { confirmar: true }, ctxPrueba({ textoEntrada: "si" }), deps);
  assertEquals(otra.resultado.ya_creado, true);
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
    const r = await derivarAEnrique({ motivo, resumen: "Le llegó la caja abierta." }, ctxPrueba(), deps);
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
  assert(lista.body.text.includes("*2 unidades* · Gs 158.000 (ahorrás Gs 33.000)"), lista.body.text);
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
