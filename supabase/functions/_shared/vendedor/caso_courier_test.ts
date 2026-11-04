// 04-11 (Enrique: "cuando son casos de reclamo de envio o coordinar, el bot puede coordinar y/o tomar reclamo y luego por
// telegram ya se me manda mensaje para lucero y/o pap"). Los 4 casos reales del 02/03-11, con nombres y teléfonos inventados.
import { assert, assertEquals, assertFalse } from "jsr:@std/assert@1";
import { ejecutarHerramienta, fusionarCasoCourier, HERRAMIENTAS } from "./herramientas.ts";
import { ctxPrueba, depsPrueba } from "./prueba_utiles.ts";
import type { DepsHerramientas, NuevoCasoCourier, PedidoCliente } from "./tipos.ts";

const pedido = (n: number, estado_envio: string | null, extra: Partial<PedidoCliente> = {}): PedidoCliente => ({
  shopify_order_id: 7000000 + n, nombre: `#${n}`, estado_confirmacion: "confirmado", estado_envio, courier: null, total: 112000,
  creado_en: "2026-10-30T12:00:00Z", ...extra,
});

/** Dobles: pedidos del cliente, courier por pedido (ventas.transportadora) y casos_courier en memoria con la misma fusión. */
function armar(pedidos: PedidoCliente[], courier: Record<number, string | null>, raw: Record<number, Record<string, unknown>> = {}) {
  const casos: Array<NuevoCasoCourier & { id: string }> = [];
  const over: Partial<DepsHerramientas> = {
    pedidoParaCourier: (id) => {
      const p = pedidos.find((x) => x.shopify_order_id === id);
      return Promise.resolve(p ? { nombre: p.nombre ?? "", telefono: null, raw: raw[id] ?? {}, courier: courier[id] ?? null, despachado: true } : null);
    },
    guardarCasoCourier: (c) => {
      const i = casos.findIndex((x) => x.shopify_order_id === c.shopify_order_id);
      if (i >= 0) {
        casos[i] = { ...fusionarCasoCourier(casos[i], c), id: casos[i].id };
        return Promise.resolve({ id: casos[i].id, nuevo: false });
      }
      casos.push({ ...c, id: `caso-${casos.length + 1}` });
      return Promise.resolve({ id: `caso-${casos.length}`, nuevo: true });
    },
  };
  const { deps, reg } = depsPrueba(over, pedidos);
  return { deps, reg, casos };
}

const ctx = (textoEntrada: string) => ctxPrueba({ textoEntrada, nombreCliente: "Rosa Benítez", ahora: new Date("2026-11-03T15:00:00Z") });

Deno.test("caso_courier: está en la lista con tipo y pide obligatorios; derivar_a_enrique tiene no_es_entrega", () => {
  const h = HERRAMIENTAS.find((x) => x.name === "caso_courier")!;
  assertEquals((h.input_schema as { required: string[] }).required, ["tipo", "pide"]);
  assert(/EN VEZ de derivar_a_enrique/.test(h.description));
  assert(/Nunca prometas una hora exacta/.test(h.description));
  const d = HERRAMIENTAS.find((x) => x.name === "derivar_a_enrique")!;
  assertEquals((d.input_schema as { properties: Record<string, { type: string }> }).properties.no_es_entrega.type, "boolean");
});

Deno.test("(a) \"Jamás me llegó… el delivery no contesta\": caso reclamo de Lucero y respuesta fija del sistema", async () => {
  const { deps, reg, casos } = armar([pedido(1172, "DESPACHADO")], { 7001172: "lucero" });
  const r = await ejecutarHerramienta("caso_courier", {
    tipo: "reclamo", pide: "Esperó el martes 03/11 y no le llegó; llama al repartidor y no contesta",
  }, ctx("Jamás me llegó mi pedido… me trato de comunicar con el delivery y no contesta"), deps);
  assertEquals(r.resultado.ok, true);
  assert(r.terminal, "la respuesta ya salió: el turno termina");
  assertFalse(r.derivado);
  assertEquals(r.resultado.texto_respuesta, "Listo, se lo paso a Lucero para que te contacten 🙌");
  assertEquals(reg.textos.map((t) => t.texto), ["Listo, se lo paso a Lucero para que te contacten 🙌"]);
  assertEquals(reg.interactivos.length, 0, "sin botón de Enrique");
  assertEquals(reg.humano, [], "el chat sigue con el bot");
  assertEquals(casos.length, 1);
  assertEquals(casos[0].ref, "VT-1172");
  assertEquals(casos[0].courier, "lucero");
  assertEquals(casos[0].tipo, "reclamo");
  assertEquals(casos[0].urgente, false);
  assertEquals(casos[0].conversacion_id, "11111111-1111-4111-8111-111111111111");
  assertEquals(casos[0].cliente_id, "22222222-2222-4222-8222-222222222222");
});

Deno.test("(b) \"a las 16:00 tengo que salir y después de las 19:00 estaré\": coordinar con horario, Punto a Punto", async () => {
  const { deps, reg, casos } = armar([pedido(1180, "INTENTO_FALLIDO")], { 7001180: "pap" });
  const r = await ejecutarHerramienta("caso_courier", {
    tipo: "coordinar", pide: "Nunca le escribieron; pide que lo contacten antes de ir", horario: "antes de las 16:00 o después de las 19:00",
  }, ctx("nunca me escribieron y yo a las 16:00 tengo que salir y recién después de las 19:00 estaré en casa"), deps);
  assertEquals(r.resultado.ok, true);
  assertEquals(reg.textos[0].texto, "Listo, se lo paso a Punto a Punto para que te contacten 🙌");
  assertEquals(casos[0].tipo, "coordinar");
  assertEquals(casos[0].horario, "antes de las 16:00 o después de las 19:00");
  assertEquals(casos[0].courier, "pap");
});

Deno.test("(c) \"Pyr parabrisas se llama el local, sobre calle la paz\": coordinar con referencia y quién recibe", async () => {
  const { deps, casos } = armar([pedido(1185, "DESPACHADO")], { 7001185: "Lucero" });
  const r = await ejecutarHerramienta("caso_courier", {
    tipo: "coordinar", pide: "Entregar en su local", referencia: "Local Taller Ejemplo, sobre calle Inventada", recibe: "el encargado del local",
  }, ctx("Pyr parabrisas se llama el local, sobre calle la paz"), deps);
  assertEquals(r.resultado.ok, true);
  assertEquals(r.resultado.courier, "lucero", "transportadora con mayúscula también cuenta");
  assertEquals(casos[0].referencia, "Local Taller Ejemplo, sobre calle Inventada");
  assertEquals(casos[0].recibe, "el encargado del local");
});

Deno.test("(d) \"Mejor al medio día… de 12 a 15 estaré\": coordinar horario; urgente con hoy=true dice \"hoy\"", async () => {
  const { deps, reg, casos } = armar([pedido(1190, "EN_PREPARACION")], { 7001190: "lucero" });
  const r = await ejecutarHerramienta("caso_courier", {
    tipo: "coordinar", pide: "Pide entrega al mediodía", horario: "de 12:00 a 15:00", hoy: true,
  }, ctx("Mejor si pueden pasar al medio dia… De 12 00 hrs a 15 00 hrs estaré"), deps);
  assertEquals(r.resultado.ok, true);
  assertEquals(reg.textos[0].texto, "Listo, se lo paso a Lucero para que te contacten hoy 🙌");
  assertEquals(casos[0].horario, "de 12:00 a 15:00");
  assertEquals(casos[0].urgente, true);
});

Deno.test("caso_courier dos veces en el mismo pedido: un solo caso, se suma lo nuevo y no se borra lo viejo", async () => {
  const { deps, casos } = armar([pedido(1172, "DESPACHADO")], { 7001172: "lucero" });
  await ejecutarHerramienta("caso_courier", { tipo: "reclamo", pide: "No le llegó y el repartidor no contesta", hoy: true }, ctx("jamás me llegó"), deps);
  const r = await ejecutarHerramienta("caso_courier", {
    tipo: "coordinar", pide: "Pide entrega al mediodía", horario: "de 12 a 15", referencia: "",
  }, ctx("de 12 a 15 estoy"), deps);
  assertEquals(r.resultado.caso_nuevo, false);
  assertEquals(casos.length, 1);
  assertEquals(casos[0].tipo, "reclamo", "reclamo pesa más que coordinar");
  assertEquals(casos[0].pide, "No le llegó y el repartidor no contesta. Pide entrega al mediodía");
  assertEquals(casos[0].horario, "de 12 a 15");
  assertEquals(casos[0].urgente, true, "una vez urgente, queda urgente");
  // El mismo pide otra vez no se repite.
  await ejecutarHerramienta("caso_courier", { tipo: "coordinar", pide: "pide entrega al mediodía" }, ctx("al mediodía"), deps);
  assertEquals(casos[0].pide, "No le llegó y el repartidor no contesta. Pide entrega al mediodía");
});

Deno.test("fusionarCasoCourier: lo vacío no pisa, lo nuevo con dato sí; sin previo devuelve el nuevo", () => {
  const nuevo: NuevoCasoCourier = {
    shopify_order_id: 1, ref: "VT-1", courier: "pap", tipo: "coordinar", pide: "Otra referencia", horario: null,
    referencia: "Casa verde", recibe: null, urgente: false, cliente_id: null, conversacion_id: null,
  };
  assertEquals(fusionarCasoCourier(null, nuevo), nuevo);
  const f = fusionarCasoCourier({ tipo: "coordinar", pide: "Pide de tarde", horario: "de tarde", referencia: "Portón negro", recibe: "su mamá", urgente: false }, nuevo);
  assertEquals([f.horario, f.referencia, f.recibe, f.pide], ["de tarde", "Casa verde", "su mamá", "Pide de tarde. Otra referencia"]);
});

Deno.test("caso_courier sin datos de cuenta: los números largos del pide se quitan", async () => {
  const { deps, casos } = armar([pedido(1172, "DESPACHADO")], { 7001172: "lucero" });
  await ejecutarHerramienta("caso_courier", { tipo: "reclamo", pide: "Ya pagó a la cuenta 1234567890 y no le llegó" }, ctx("no me llegó"), deps);
  assertEquals(casos[0].pide, "Ya pagó a la cuenta [dato quitado] y no le llegó");
});

Deno.test("caso_courier sin pedido despachado (pendiente o entregado): error no_despachado y no guarda nada", async () => {
  for (const estado of [null, "ENTREGADO", "NO_ENTREGADO"]) {
    const { deps, reg, casos } = armar([pedido(1200, estado)], { 7001200: "lucero" });
    const r = await ejecutarHerramienta("caso_courier", { tipo: "reclamo", pide: "No le llegó" }, ctx("no me llegó"), deps);
    assert(r.esError, String(estado));
    assert(String(r.resultado.error).startsWith("no_despachado:"), String(r.resultado.error));
    assertEquals(casos.length, 0);
    assertEquals(reg.textos.length, 0);
  }
  // Despachado pero cancelado en Shopify: tampoco.
  const c = armar([pedido(1201, "DESPACHADO")], { 7001201: "lucero" }, { 7001201: { cancelled_at: "2026-11-01T10:00:00-03:00" } });
  const r = await ejecutarHerramienta("caso_courier", { tipo: "reclamo", pide: "No le llegó" }, ctx("no me llegó"), c.deps);
  assert(String(r.resultado.error).startsWith("no_despachado:"));
});

Deno.test("caso_courier con courier desconocido (otra o sin venta): error para derivar con motivo reclamo", async () => {
  for (const courier of [null, "otra"]) {
    const { deps, casos } = armar([pedido(1210, "DESPACHADO")], { 7001210: courier });
    const r = await ejecutarHerramienta("caso_courier", { tipo: "reclamo", pide: "No le llegó" }, ctx("no me llegó"), deps);
    assert(String(r.resultado.error).startsWith("courier_desconocido:"), String(r.resultado.error));
    assert(String(r.resultado.error).includes("motivo reclamo"));
    assertEquals(casos.length, 0);
  }
});

Deno.test("caso_courier: con número de pedido elige ese, no el más nuevo", async () => {
  const { deps, casos } = armar([pedido(1220, "DESPACHADO"), pedido(1215, "INTENTO_FALLIDO")], { 7001220: "lucero", 7001215: "pap" });
  const r = await ejecutarHerramienta("caso_courier", { tipo: "coordinar", pide: "Pide de tarde", pedido: "#1215" }, ctx("el 1215"), deps);
  assertEquals(r.resultado.pedido, "#1215");
  assertEquals([casos[0].ref, casos[0].courier], ["VT-1215", "pap"]);
});

Deno.test("caso_courier: si la base falla, error para derivar por falla_herramienta (no frenado por el guardia)", async () => {
  const { deps } = armar([pedido(1172, "DESPACHADO")], { 7001172: "lucero" });
  deps.guardarCasoCourier = () => Promise.reject(new Error("sin red"));
  const r = await ejecutarHerramienta("caso_courier", { tipo: "reclamo", pide: "No le llegó" }, ctx("no me llegó"), deps);
  assert(String(r.resultado.error).includes("falla_herramienta"));
});

Deno.test("derivar_a_enrique con pedido despachado: reclamo/otro/sin_avance van a caso_courier; devolución y no_es_entrega pasan", async () => {
  const resumen = "La clienta dice que nunca le llegó y el repartidor no contesta.";
  for (const motivo of ["reclamo", "otro", "sin_avance"]) {
    const { deps, reg } = armar([pedido(1172, "DESPACHADO")], { 7001172: "lucero" });
    const r = await ejecutarHerramienta("derivar_a_enrique", { motivo, resumen }, ctx("jamás me llegó"), deps);
    assert(r.esError, motivo);
    assert(String(r.resultado.error).startsWith("es_caso_courier: el pedido #1172 ya está con Lucero."), String(r.resultado.error));
    assertEquals([reg.interactivos.length, reg.avisos.length, reg.humano.length], [0, 0, 0], "no salió botón ni aviso");
  }
  for (const [motivo, extra] of [["devolucion", {}], ["enojo", {}], ["salud", {}], ["reclamo", { no_es_entrega: true }]] as const) {
    const { deps, reg } = armar([pedido(1172, "DESPACHADO")], { 7001172: "lucero" });
    const r = await ejecutarHerramienta("derivar_a_enrique", { motivo, resumen: "Le llegó la caja rota, quiere la plata. Tiene apnea.", ...extra }, ctx("llegó roto"), deps);
    assert(r.derivado, motivo);
    assertEquals((reg.interactivos[0].interactive as { type: string }).type, "cta_url");
  }
});

Deno.test("derivar_a_enrique: después de guardar el caso en el mismo turno, no lo frena el guardia", async () => {
  const { deps } = armar([pedido(1172, "DESPACHADO")], { 7001172: "lucero" });
  const c = ctx("no me llegó y quiero hablar con alguien");
  await ejecutarHerramienta("caso_courier", { tipo: "reclamo", pide: "No le llegó" }, c, deps);
  const r = await ejecutarHerramienta("derivar_a_enrique", { motivo: "reclamo", resumen: "Además pide hablar con alguien por el pedido." }, c, deps);
  assert(r.derivado);
});

Deno.test("derivar_a_enrique sin pedido despachado, o con courier desconocido: igual que siempre", async () => {
  for (const [pedidos, courier] of [[[], {}], [[pedido(1300, null)], { 7001300: "lucero" }], [[pedido(1301, "DESPACHADO")], { 7001301: "otra" }]] as const) {
    const { deps, reg } = armar([...pedidos], { ...courier });
    const r = await ejecutarHerramienta("derivar_a_enrique", { motivo: "reclamo", resumen: "Le llegó la caja abierta, mandó foto." }, ctx("llegó abierto"), deps);
    assert(r.derivado);
    assertEquals(reg.humano.length, 1);
  }
});
