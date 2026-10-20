import { assertEquals } from "@std/assert";
import { accionesPara, ciudadPendiente, sinCobertura, coordenadasPin, direccionDesdeNota, direccionUtilizable, type PedidoAbierto } from "./logica.ts";

const AHORA = new Date("2026-10-12T18:00:00Z");
const base = (o: Partial<PedidoAbierto> = {}): PedidoAbierto => ({
  shopifyOrderId: 1, nombre: "#1", estado: "confirmado", tags: ["CONFIRMADO"], actualizadoEn: "2026-10-12T10:00:00Z",
  direccion: "Mcal. López 1234", ciudad: "Asunción", notas: "", ...o,
});

Deno.test("dirección: calle o pin GPS + ciudad (casos reales del 12-10, datos inventados)", () => {
  assertEquals(direccionUtilizable(base({ direccion: "Pin de ubicación", notas: "Ubicación: -25.3526067,-57.6199833" })), true); // tipo #1005
  assertEquals(direccionUtilizable(base({ direccion: "Seivo", ciudad: "Nueva esperanza" })), false); // 5 letras, sin pin
  assertEquals(direccionUtilizable(base({ direccion: "Mariscal López, zona norte" })), true);
  assertEquals(direccionUtilizable(base({ direccion: "Pin de ubicación" })), false);
  assertEquals(direccionUtilizable(base({ ciudad: "-" })), false);
});

// Nota tipo #1055 (datos inventados): el vendedor dejó todo en la nota y Shopify descartó la dirección.
const NOTA_BOT = "Pedido creado por el vendedor con IA (WhatsApp).\nNombre: ana\nCelular: +595981000000\nCiudad: Caacupé\n" +
  "Calle: Calle Falsa\nMapa: https://maps.google.com/?q=-25.3000000,-57.2000000\nReferencia: Frente a la plaza";

Deno.test("15-10: con pin basta, aunque falte la ciudad", () => {
  assertEquals(direccionUtilizable(base({ direccion: "", ciudad: "", notas: "Mapa: https://maps.google.com/?q=-25.3000000,-57.2000000" })), true);
  assertEquals(direccionUtilizable(base({ direccion: "Seivo", ciudad: "" })), false);
});

Deno.test("15-10: dirección desde la nota del vendedor; apellido nunca vacío", () => {
  assertEquals(direccionDesdeNota(NOTA_BOT), {
    firstName: "ana", lastName: "-", address1: "Calle Falsa",
    address2: "Frente a la plaza · Mapa: https://maps.google.com/?q=-25.3000000,-57.2000000", city: "Caacupé", phone: "+595981000000",
  });
  assertEquals(direccionDesdeNota("Nombre: Ana Pérez Gómez\nCiudad: Luque\nMapa: https://maps.google.com/?q=-25.1,-57.4")?.lastName, "Pérez Gómez");
  assertEquals(direccionDesdeNota("Nombre: Ana\nCiudad: Luque\nMapa: x")?.address1, "Ver mapa");
  assertEquals(direccionDesdeNota("Nombre: Ana\nCalle: Mcal López"), null); // sin ciudad
  assertEquals(direccionDesdeNota("Nombre: Ana\nCiudad: Luque"), null); // sin calle ni mapa
});

Deno.test("15-10: pedido sin dirección en Shopify y con nota → completar (y sacar FALTAN_DATOS si lo puso el sistema)", () => {
  const p = base({ direccion: "", ciudad: "", notas: NOTA_BOT });
  assertEquals(accionesPara(p, AHORA, false), ["completar_direccion"]);
  assertEquals(accionesPara({ ...p, tags: ["CONFIRMADO", "FALTAN_DATOS"] }, AHORA, true), ["completar_direccion", "quitar_faltan_datos"]);
  assertEquals(accionesPara(base({ direccion: "", ciudad: "", notas: "" }), AHORA, false), ["agregar_faltan_datos"]);
});

Deno.test("confirmado sin etiqueta → agregar CONFIRMADO; con etiqueta → nada", () => {
  assertEquals(accionesPara(base({ tags: ["ORIGEN_WHATSAPP"] }), AHORA, false), ["agregar_confirmado"]);
  assertEquals(accionesPara(base(), AHORA, false), []);
  assertEquals(accionesPara(base({ estado: "pendiente", tags: [] }), AHORA, false), []);
});

Deno.test("cancelado por el cliente: se cancela en Shopify recién pasadas 2 h", () => {
  assertEquals(accionesPara(base({ estado: "cancelado_cliente", tags: ["CANCELADO_CLIENTE"], actualizadoEn: "2026-10-12T17:00:00Z" }), AHORA, false), []);
  assertEquals(accionesPara(base({ estado: "cancelado_cliente", tags: ["CANCELADO_CLIENTE"], actualizadoEn: "2026-10-12T15:00:00Z" }), AHORA, false), ["cancelar"]);
  // Reactivó ("Lo quiero igual") → confirmado: no se cancela aunque quede la etiqueta vieja.
  assertEquals(accionesPara(base({ estado: "confirmado", tags: ["CANCELADO_CLIENTE", "CONFIRMADO"] }), AHORA, false), []);
  // Sin respuesta: lo cancela procesar-envios, acá nada.
  assertEquals(accionesPara(base({ estado: "cancelado_sin_respuesta", tags: [] }), AHORA, false), []);
});

Deno.test("faltan datos: se pone si no hay calle ni pin; se saca solo si la puso el sistema", () => {
  const mala = base({ direccion: "Seivo" });
  assertEquals(accionesPara(mala, AHORA, false), ["agregar_faltan_datos"]);
  assertEquals(accionesPara({ ...mala, tags: ["CONFIRMADO", "FALTAN_DATOS"] }, AHORA, true), []);
  assertEquals(accionesPara(base({ tags: ["CONFIRMADO", "FALTAN_DATOS"] }), AHORA, true), ["quitar_faltan_datos"]);
  assertEquals(accionesPara(base({ tags: ["CONFIRMADO", "FALTAN_DATOS"] }), AHORA, false), []); // puesta a mano: no se toca
  assertEquals(accionesPara(base({ direccion: "Retira", tags: ["CONFIRMADO", "RETIRO_EN_CASA"] }), AHORA, false), []);
});

Deno.test("15-10 (#1056): ciudad 'Ver mapa' con pin → buscar la ciudad del pin; con ciudad real, nada", () => {
  const p = base({ direccion: "Pin de ubicación, Mapa: https://maps.google.com/?q=-24.1000000,-56.5000000", ciudad: "Ver mapa" });
  assertEquals(accionesPara(p, AHORA, false), ["ciudad_desde_pin"]);
  assertEquals(coordenadasPin(p), { lat: -24.1, lng: -56.5 });
  assertEquals(accionesPara({ ...p, ciudad: "Luque" }, AHORA, false), []);
  assertEquals([ciudadPendiente("ver mapa"), ciudadPendiente(""), ciudadPendiente("Luque")], [true, true, false]);
});

Deno.test("15-10 (#1056): ciudad sin cobertura contra entrega → avisar una vez; con cobertura, pagado o ya avisado, nada", () => {
  assertEquals([sinCobertura("General Isidoro Resquín"), sinCobertura("Luque"), sinCobertura("Choré")], [true, false, false]);
  const p = base({ direccion: "Pin de ubicación, Mapa: https://maps.google.com/?q=-24.1000000,-56.5000000", ciudad: "General Isidoro Resquín" });
  assertEquals(accionesPara(p, AHORA, false), ["avisar_sin_cobertura"]);
  for (const t of ["PAGADO", "SIN_COBERTURA", "RETIRO_EN_CASA"]) assertEquals(accionesPara({ ...p, tags: ["CONFIRMADO", t] }, AHORA, false), [], t);
  assertEquals(accionesPara({ ...p, estado: "pendiente", tags: [] }, AHORA, false), []);
  assertEquals(accionesPara(base(), AHORA, false), []); // Asunción: cubierta
});

Deno.test("20-10 'Sin calle (ubicación pendiente)' no es una dirección utilizable → FALTAN_DATOS (se pide antes del despacho)", () => {
  assertEquals(direccionUtilizable(base({ direccion: "Sin calle (ubicación pendiente)", ciudad: "Luque" })), false);
  assertEquals(accionesPara(base({ direccion: "Sin calle (ubicación pendiente)", ciudad: "Luque" }), AHORA, false), ["agregar_faltan_datos"]);
});
