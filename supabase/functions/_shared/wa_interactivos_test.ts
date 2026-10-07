// Tests de _shared/wa_interactivos.ts. Payloads de ejemplo inventados según la documentación de Meta (repo público).
import { assert, assertEquals, assertThrows } from "jsr:@std/assert@1";
import {
  _configurarInteractivos,
  botonesSiNo,
  carruselOpciones,
  datosFormularioPedido,
  enviarInteractivo,
  ErrorInteractivo,
  flowFormulario,
  parsearContacto,
  parsearFlow,
  parsearUbicacion,
  pedirContacto,
  type Tarjeta,
  ubicacionRequest,
} from "./wa_interactivos.ts";

const tarjeta = (n: number): Tarjeta => ({
  imagenUrl: `https://cdn.ejemplo.test/x${n}.jpg`,
  titulo: `×${n}`,
  cuerpo: `${n} unidades`,
  botonId: `opcion:${n}`,
  botonTexto: `Quiero ×${n}`,
});

Deno.test("ubicacionRequest: formato exacto y límite de 1024", () => {
  assertEquals(ubicacionRequest("Mandanos tu ubicación"), {
    type: "location_request_message",
    body: { text: "Mandanos tu ubicación" },
    action: { name: "send_location" },
  });
  ubicacionRequest("a".repeat(1024));
  assertThrows(() => ubicacionRequest("a".repeat(1025)), ErrorInteractivo, "cuerpo_mayor_a_1024");
  assertThrows(() => ubicacionRequest("  "), ErrorInteractivo, "cuerpo_vacio");
});

Deno.test("flowFormulario: formato exacto, CTA ≤ 30 y sin emoji", () => {
  const i = flowFormulario({ flowId: "1234567890", token: "pedido:conv-1", titulo: "Tus datos", cta: "Completar datos" });
  assertEquals(i, {
    type: "flow",
    header: { type: "text", text: "Tus datos" },
    body: { text: "Tus datos" },
    action: {
      name: "flow",
      parameters: {
        flow_message_version: "3",
        flow_token: "pedido:conv-1",
        flow_id: "1234567890",
        flow_cta: "Completar datos",
        flow_action: "navigate",
        flow_action_payload: { screen: "PEDIDO" },
      },
    },
  });
  const conTexto = flowFormulario({ flowId: "1", token: "t", titulo: "T", cta: "Ok", texto: "Cuerpo", modo: "draft" });
  assertEquals(conTexto.body.text, "Cuerpo");
  assertEquals(conTexto.action.parameters.mode, "draft");
  assertThrows(() => flowFormulario({ flowId: "1", token: "t", titulo: "T", cta: "a".repeat(31) }), ErrorInteractivo, "cta_mayor_a_30");
  assertThrows(() => flowFormulario({ flowId: "1", token: "t", titulo: "T", cta: "Pedir 🚀" }), ErrorInteractivo, "cta_con_emoji");
  assertThrows(() => flowFormulario({ flowId: "1", token: "", titulo: "T", cta: "Ok" }), ErrorInteractivo, "flow_token_vacio");
  assertThrows(() => flowFormulario({ flowId: "1", token: "t", titulo: "a".repeat(61), cta: "Ok" }), ErrorInteractivo, "titulo_mayor_a_60");
});

Deno.test("carruselOpciones: ×1/×2/×3 con formato exacto de Meta", () => {
  const i = carruselOpciones("Elegí tu opción", [tarjeta(1), tarjeta(2), tarjeta(3)]);
  assertEquals(i.type, "carousel");
  assertEquals(i.body, { text: "Elegí tu opción" });
  assertEquals(i.action.cards.length, 3);
  assertEquals(i.action.cards[1], {
    card_index: 1,
    type: "cta_url",
    header: { type: "image", image: { link: "https://cdn.ejemplo.test/x2.jpg" } },
    body: { text: "*×2*\n2 unidades" },
    action: { buttons: [{ type: "quick_reply", quick_reply: { id: "opcion:2", title: "Quiero ×2" } }] },
  });
  assertEquals(carruselOpciones("x", [{ ...tarjeta(1), cuerpo: undefined }, tarjeta(2)]).action.cards[0].body.text, "*×1*");
});

Deno.test("carruselOpciones: 2 a 10 tarjetas y límites", () => {
  assertThrows(() => carruselOpciones("x", [tarjeta(1)]), ErrorInteractivo, "tarjetas_2_a_10");
  carruselOpciones("x", Array.from({ length: 10 }, (_, k) => tarjeta(k + 1)));
  assertThrows(() => carruselOpciones("x", Array.from({ length: 11 }, (_, k) => tarjeta(k + 1))), ErrorInteractivo, "tarjetas_2_a_10");
  assertThrows(() => carruselOpciones("x", [tarjeta(1), { ...tarjeta(2), botonTexto: "a".repeat(21) }]), ErrorInteractivo, "titulo_boton_mayor_a_20");
  assertThrows(() => carruselOpciones("x", [tarjeta(1), { ...tarjeta(2), cuerpo: "a".repeat(160) }]), ErrorInteractivo, "cuerpo_tarjeta_mayor_a_160");
  assertThrows(() => carruselOpciones("x", [tarjeta(1), { ...tarjeta(2), cuerpo: "a\nb\nc" }]), ErrorInteractivo, "mas_de_2_saltos");
  assertThrows(() => carruselOpciones("x", [tarjeta(1), { ...tarjeta(2), imagenUrl: "http://inseguro.test/a.jpg" }]), ErrorInteractivo, "imagen_url_invalida");
  assertThrows(() => carruselOpciones("x", [tarjeta(1), { ...tarjeta(2), botonId: "opcion:1" }]), ErrorInteractivo, "id_boton_repetido");
});

Deno.test("pedirContacto y botonesSiNo: formato exacto", () => {
  assertEquals(pedirContacto("¿Nos pasás tu número?"), {
    type: "request_contact_info",
    body: { text: "¿Nos pasás tu número?" },
    action: { name: "request_contact_info" },
  });
  assertEquals(botonesSiNo("¿Confirmás?", "ok:1", "no:1"), {
    type: "button",
    body: { text: "¿Confirmás?" },
    action: {
      buttons: [
        { type: "reply", reply: { id: "ok:1", title: "Sí" } },
        { type: "reply", reply: { id: "no:1", title: "No" } },
      ],
    },
  });
  assertEquals(botonesSiNo("x", "a", "b", { si: "Dale", no: "Ahora no" }).action.buttons[1].reply.title, "Ahora no");
  assertThrows(() => botonesSiNo("x", "a", "a"), ErrorInteractivo, "ids_iguales");
  assertThrows(() => botonesSiNo("x", "a".repeat(257), "b"), ErrorInteractivo, "id_boton_mayor_a_256");
});

Deno.test("parsearUbicacion: con y sin nombre/dirección, y basura", () => {
  const m = {
    from: "595981000000", id: "wamid.IN1", timestamp: "1759750000", type: "location",
    location: { latitude: -25.2637, longitude: -57.5759, name: "Casa", address: "Calle Falsa 123", url: "https://ejemplo.test" },
  };
  assertEquals(parsearUbicacion(m), {
    latitud: -25.2637, longitud: -57.5759, nombre: "Casa", direccion: "Calle Falsa 123", url: "https://ejemplo.test",
    mapsUrl: "https://www.google.com/maps?q=-25.2637,-57.5759",
  });
  const solo = parsearUbicacion({ type: "location", location: { latitude: -25.5, longitude: -54.6 } });
  assertEquals(solo?.nombre, null);
  assertEquals(solo?.direccion, null);
  assertEquals(parsearUbicacion({ type: "location", location: { latitude: 120, longitude: 0 } }), null);
  assertEquals(parsearUbicacion({ type: "text", text: { body: "hola" } }), null);
  assertEquals(parsearUbicacion(null), null);
});

Deno.test("parsearFlow: nfm_reply con response_json string", () => {
  const m = {
    context: { from: "595981000001", id: "wamid.OUTFLOW" },
    from: "595981000000", id: "wamid.IN2", type: "interactive", timestamp: "1759750000",
    interactive: {
      type: "nfm_reply",
      nfm_reply: {
        name: "flow",
        body: "Sent",
        response_json: JSON.stringify({
          flow_token: "pedido:conv-1", nombre: "Ana Prueba", ciudad: "luque", otra_ciudad: "",
          direccion: "Calle 1 c/ Calle 2", referencia: "", cantidad: "2",
        }),
      },
    },
  };
  const r = parsearFlow(m)!;
  assertEquals(r.flowToken, "pedido:conv-1");
  assertEquals(r.contextoId, "wamid.OUTFLOW");
  assertEquals(r.jsonInvalido, false);
  assert(!("flow_token" in r.datos));
  const d = datosFormularioPedido(r.datos, { luque: "Luque" });
  assertEquals(d, { ok: true, pedido: { nombre: "Ana Prueba", ciudad: "Luque", direccion: "Calle 1 c/ Calle 2", referencia: null, cantidad: 2 } });

  const malo = parsearFlow({ type: "interactive", interactive: { type: "nfm_reply", nfm_reply: { response_json: "{no" } } })!;
  assertEquals(malo.jsonInvalido, true);
  assertEquals(malo.flowToken, null);
  assertEquals(parsearFlow({ type: "interactive", interactive: { type: "button_reply", button_reply: { id: "x" } } }), null);
});

Deno.test("datosFormularioPedido: ciudad Otra y faltantes", () => {
  assertEquals(
    datosFormularioPedido({ nombre: "Ana", ciudad: "otra", otra_ciudad: "Pilar", direccion: "Calle 1", cantidad: "3", referencia: "portón" }),
    { ok: true, pedido: { nombre: "Ana", ciudad: "Pilar", direccion: "Calle 1", referencia: "portón", cantidad: 3 } },
  );
  assertEquals(datosFormularioPedido({ ciudad: "otra", cantidad: "4" }), {
    ok: false,
    faltan: ["otra_ciudad", "nombre", "direccion", "cantidad"],
  });
  const sinMapa = datosFormularioPedido({ nombre: "A", ciudad: "ciudad_del_este", direccion: "x", cantidad: "1" });
  assert(sinMapa.ok && sinMapa.pedido.ciudad === "ciudad del este");
});

Deno.test("parsearContacto: contact_request (BSUID) y contacto compartido (other)", () => {
  const pedido = parsearContacto({
    id: "wamid.IN3", timestamp: "1759750000", type: "contacts", from_user_id: "PY.1234567890",
    contacts: [{ origin: "contact_request", phones: [{ phone: "+595 981 000000", wa_id: "595981000000", type: "CELL" }] }],
  })!;
  assertEquals(pedido.origen, "contact_request");
  assertEquals(pedido.esPedidoDeContacto, true);
  assertEquals(pedido.telefonoE164, "+595981000000");
  assertEquals(pedido.deUsuarioId, "PY.1234567890");
  assertEquals(pedido.vcard, null);

  const otro = parsearContacto({
    from: "595981000000", type: "contacts",
    contacts: [{
      origin: "other", vcard: "BEGIN:VCARD\nEND:VCARD", name: { formatted_name: "Juan Inventado" },
      phones: [{ phone: "0981 000 001", type: "CELL" }],
    }],
  })!;
  assertEquals(otro.esPedidoDeContacto, false);
  assertEquals(otro.nombre, "Juan Inventado");
  assertEquals(otro.telefonoE164, null); // local sin código de país: no se inventa
  assertEquals(parsearContacto({ type: "contacts", contacts: [] }), null);
  assertEquals(parsearContacto({ type: "location" }), null);
});

// ---------- envío ----------

function simular(status = 200, respuesta: unknown = { messages: [{ id: "wamid.OUTI" }] }, palabras: string[] | null = ["garantía", "cura"]) {
  const llamadas: { url: string; body: Record<string, unknown> }[] = [];
  const registros: Record<string, unknown>[] = [];
  _configurarInteractivos({
    token: () => "token-de-prueba",
    phoneNumberId: () => "PHONE_ID",
    palabrasProhibidas: () => Promise.resolve(palabras),
    registrar: (f) => (registros.push(f), Promise.resolve()),
    resolverDestino: () => Promise.resolve({ clienteId: "cli-1", conversacionId: "conv-1" }),
    fetch: (input, init) => {
      llamadas.push({ url: String(input), body: JSON.parse(String(init?.body ?? "{}")) });
      return Promise.resolve(new Response(JSON.stringify(respuesta), { status }));
    },
  });
  return { llamadas, registros };
}

Deno.test("enviarInteractivo: POST correcto, teléfono → to, registro en wa_mensajes", async () => {
  const { llamadas, registros } = simular();
  const r = await enviarInteractivo("+595981000000", ubicacionRequest("Mandanos tu ubicación"));
  assertEquals(r, { ok: true, wa_message_id: "wamid.OUTI" });
  assertEquals(llamadas[0].url, "https://graph.facebook.com/v25.0/PHONE_ID/messages");
  assertEquals(llamadas[0].body.to, "595981000000");
  assertEquals(llamadas[0].body.type, "interactive");
  assertEquals((llamadas[0].body.interactive as { type: string }).type, "location_request_message");
  assertEquals(registros[0].estado, "enviado");
  assertEquals(registros[0].tipo, "interactive");
  assertEquals(registros[0].conversacion_id, "conv-1");
  _configurarInteractivos();
});

Deno.test("enviarInteractivo: BSUID → recipient", async () => {
  const { llamadas } = simular();
  await enviarInteractivo("PY.1234567890", pedirContacto("¿Nos pasás tu número?"), { clienteId: "c", conversacionId: "v" });
  assertEquals(llamadas[0].body.recipient, "PY.1234567890");
  assert(!("to" in llamadas[0].body));
  _configurarInteractivos();
});

Deno.test("enviarInteractivo: palabra prohibida en una tarjeta bloquea y registra fallido", async () => {
  const { llamadas, registros } = simular();
  const r = await enviarInteractivo("+595981000000", carruselOpciones("Elegí", [tarjeta(1), { ...tarjeta(2), cuerpo: "con garantía" }]));
  assertEquals(r, { ok: false, error: "palabra_prohibida:garantía" });
  assertEquals(llamadas.length, 0);
  assertEquals(registros[0].estado, "fallido");
  _configurarInteractivos();
});

Deno.test("enviarInteractivo: sin lista de prohibidas falla cerrado; error de Graph; teléfono local", async () => {
  let s = simular(200, {}, null);
  assertEquals((await enviarInteractivo("+595981000000", ubicacionRequest("x"))).error, "config_palabras_prohibidas_no_disponible");
  assertEquals(s.llamadas.length, 0);
  s = simular(400, { error: { code: 131009, message: "Parameter value is not valid" } });
  const r = await enviarInteractivo("+595981000000", ubicacionRequest("x"));
  assertEquals(r, { ok: false, error: "131009: Parameter value is not valid" });
  assertEquals(s.registros[0].estado, "fallido");
  s = simular();
  assertEquals((await enviarInteractivo("0981000000", ubicacionRequest("x"))).error, "telefono_sin_codigo_pais");
  assertEquals(s.llamadas.length, 0);
  _configurarInteractivos();
});

// ---------- Flow JSON estático (supabase/flows/formulario_pedido.json) contra los límites de la documentación ----------

Deno.test("formulario_pedido.json: versión vigente, pantalla terminal, límites y payload", async () => {
  const ruta = new URL("../../flows/formulario_pedido.json", import.meta.url);
  // deno-lint-ignore no-explicit-any
  const flow: any = JSON.parse(await Deno.readTextFile(ruta));
  assertEquals(flow.version, "7.3");
  assert(!("data_api_version" in flow) && !("routing_model" in flow), "sin endpoint no lleva data_api_version ni routing_model");
  assertEquals(flow.screens.length, 1);
  const p = flow.screens[0];
  assertEquals(p.id, "PEDIDO"); // la que abre flowFormulario por defecto
  assert(/^[A-Z_]+$/.test(p.id) && p.id !== "SUCCESS");
  assertEquals(p.terminal, true);
  assertEquals(p.layout.type, "SingleColumnLayout");
  const form = p.layout.children.find((c: { type: string }) => c.type === "Form");
  const hijos = form.children as Record<string, unknown>[];
  const nombres = new Set<string>();
  for (const c of hijos) {
    if (c.type === "TextInput") {
      assert((c.label as string).length <= 20, `label TextInput ≤ 20: ${c.label}`);
      if (c["helper-text"]) assert((c["helper-text"] as string).length <= 80);
    }
    if (c.type === "Dropdown") {
      assert((c.label as string).length <= 20);
      const ds = c["data-source"] as { id: string; title: string }[];
      assert(ds.length >= 1 && ds.length <= 200);
      for (const o of ds) assert(o.title.length <= 30 && o.id);
      assertEquals(ds.at(-1)?.id, "otra");
    }
    if (c.type === "RadioButtonsGroup") {
      assert((c.label as string).length <= 30);
      assertEquals((c["data-source"] as { id: string }[]).map((o) => o.id), ["1", "2", "3"]);
    }
    if (c.name) nombres.add(c.name as string);
  }
  // deno-lint-ignore no-explicit-any
  const footer = hijos.find((c) => c.type === "Footer") as Record<string, any>;
  assert(footer && (footer.label as string).length <= 35);
  assertEquals(footer["on-click-action"].name, "complete");
  for (const [k, v] of Object.entries(footer["on-click-action"].payload as Record<string, string>)) {
    assertEquals(v, `\${form.${k}}`);
    assert(nombres.has(k), `el payload referencia un campo que existe: ${k}`);
  }
  for (const req of ["nombre", "ciudad", "direccion", "referencia", "cantidad"]) assert(nombres.has(req));
  // Lo que devuelve el payload lo entiende datosFormularioPedido.
  const datos = Object.fromEntries([...nombres].map((n) => [n, n === "cantidad" ? "1" : n === "ciudad" ? "luque" : "x"]));
  assert(datosFormularioPedido(datos).ok);
});
