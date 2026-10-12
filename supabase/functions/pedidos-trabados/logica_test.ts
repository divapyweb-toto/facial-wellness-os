import { assertEquals } from "@std/assert";
import { accionesPara, direccionUtilizable, type PedidoAbierto } from "./logica.ts";

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
