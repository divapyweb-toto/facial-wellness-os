import { assertEquals } from "@std/assert";
import { accionesPara, ciudadDesconocida, ciudadPendiente, type Cobertura, sinCobertura, coordenadasPin, direccionDesdeNota, direccionUtilizable, necesitaCobertura, type PedidoAbierto } from "./logica.ts";

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
  // 29-10: sin dato de la tabla (la rpc falló) ya no se decide con la lista vieja: nunca "sin cobertura" a ciegas.
  assertEquals([sinCobertura("General Isidoro Resquín"), sinCobertura("Luque"), sinCobertura("Choré")], [false, false, false]);
  const p = base({ direccion: "Pin de ubicación, Mapa: https://maps.google.com/?q=-24.1000000,-56.5000000", ciudad: "Pueblo Reconocido" });
  const m = new Map([["Pueblo Reconocido", { sin_cobertura: true, ciudad_reconocida: true }]]);
  assertEquals(accionesPara(p, AHORA, false, m), ["avisar_sin_cobertura"]);
  assertEquals(accionesPara(p, AHORA, false), []); // sin dato: se espera la próxima corrida
  for (const t of ["PAGADO", "SIN_COBERTURA", "RETIRO_EN_CASA"]) assertEquals(accionesPara({ ...p, tags: ["CONFIRMADO", t] }, AHORA, false, m), [], t);
  assertEquals(accionesPara({ ...p, estado: "pendiente", tags: [] }, AHORA, false, m), []);
  assertEquals(accionesPara(base(), AHORA, false), []); // Asunción: cubierta
});

Deno.test("20-10 'Sin calle (ubicación pendiente)' no es una dirección utilizable → FALTAN_DATOS (se pide antes del despacho)", () => {
  assertEquals(direccionUtilizable(base({ direccion: "Sin calle (ubicación pendiente)", ciudad: "Luque" })), false);
  assertEquals(accionesPara(base({ direccion: "Sin calle (ubicación pendiente)", ciudad: "Luque" }), AHORA, false), ["agregar_faltan_datos"]);
});

// 20-10: la cobertura sale de la rpc sugerir_courier (tabla tarifas_courier); la lista vieja queda de respaldo.
const SIN: Cobertura = { sin_cobertura: true, ciudad_reconocida: true };
const CON: Cobertura = { sin_cobertura: false, ciudad_reconocida: true };
const DESCONOCIDA: Cobertura = { sin_cobertura: true, ciudad_reconocida: false };

Deno.test("20-10/29-10: SIN_COBERTURA solo con la ciudad reconocida por la tabla; no reconocida o sin dato → nunca", () => {
  // San Juan Nepomuceno: la lista vieja daba PaP con cobranza (se perdió un pedido); la tabla dice que PaP no cobra ahí.
  assertEquals(sinCobertura("San Juan Nepomuceno"), false);
  assertEquals(sinCobertura("San Juan Nepomuceno", SIN), true);
  for (const c of ["Ayolas", "Choré", "San José de los Arroyos"]) assertEquals(sinCobertura(c, SIN), true, c);
  assertEquals(sinCobertura("General Isidoro Resquín", CON), false); // la tabla manda aunque la lista diga otra cosa
  assertEquals(sinCobertura("Luque", { sin_cobertura: true, ciudad_reconocida: false }), false);
  assertEquals(sinCobertura("Pueblo Inventado", DESCONOCIDA), false); // 29-10: no reconocida → nunca sin cobertura
  assertEquals(sinCobertura("General Isidoro Resquín", null), false); // 29-10: sin dato → no se decide
  // ¿Ciudad desconocida? Solo si la tabla no la reconoce Y la lista vieja (con tolerancia a typos) tampoco.
  assertEquals(ciudadDesconocida("Casa", DESCONOCIDA), true);
  assertEquals(ciudadDesconocida("Mbocayaty", DESCONOCIDA), false); // la lista vieja la empareja con Mbocajaty (Lucero)
  assertEquals(ciudadDesconocida("Casa", null), false); // sin dato de la rpc
  assertEquals(ciudadDesconocida("Casa", CON), false);
});

Deno.test("20-10: accionesPara usa el mapa ciudad → cobertura (clave = ciudad sin espacios de los costados)", () => {
  const p = base({ ciudad: "San Juan Nepomuceno ", direccion: "Calle Principal 123" });
  assertEquals(accionesPara(p, AHORA, false), []); // sin mapa: como antes (lista vieja)
  assertEquals(accionesPara(p, AHORA, false, new Map([["San Juan Nepomuceno", SIN]])), ["avisar_sin_cobertura"]);
  assertEquals(accionesPara(p, AHORA, false, new Map([["San Juan Nepomuceno", CON]])), []);
  assertEquals(accionesPara(p, AHORA, false, new Map([["San Juan Nepomuceno", DESCONOCIDA]])), []); // no reconocida, la lista vieja la conoce: nada
  // Ya avisado, pagado, retiro, no confirmado o cancelado: nada, y tampoco hace falta preguntar la cobertura.
  for (const t of ["PAGADO", "SIN_COBERTURA", "RETIRO_EN_CASA", "CANCELADO_CLIENTE"]) {
    const q = { ...p, tags: ["CONFIRMADO", t] };
    assertEquals(accionesPara(q, AHORA, false, new Map([["San Juan Nepomuceno", SIN]])), [], t);
    assertEquals(necesitaCobertura(q), false, t);
  }
  assertEquals(necesitaCobertura({ ...p, estado: "pendiente", tags: [] }), false);
  assertEquals(necesitaCobertura({ ...p, ciudad: "Ver mapa" }), false);
  assertEquals(necesitaCobertura(p), true);
  // Con la ciudad cubierta según la tabla, el resto de las acciones sigue igual.
  assertEquals(accionesPara(base({ tags: ["ORIGEN_WHATSAPP"], ciudad: "Luque" }), AHORA, false, new Map([["Luque", CON]])), ["agregar_confirmado"]);
});

Deno.test("21-10: sin cobertura → a las 48 h del aviso sin pago se cancela; con foto/archivo se pide revisar", () => {
  const AH = new Date("2026-10-21T15:00:00Z");
  const base = { shopifyOrderId: 7, nombre: "#7", estado: "confirmado", actualizadoEn: null, direccion: "Calle Larga 123", ciudad: "Pueblo X", notas: "" };
  const p = (tags: string[]) => ({ ...base, tags: ["CONFIRMADO", "SIN_COBERTURA", ...tags] });
  const m = (avisoEn: string | null, adjuntoDespues = false) => new Map([[7, { avisoEn, adjuntoDespues }]]);
  assertEquals(accionesPara(p([]), AH, false, undefined, m("2026-10-19T14:00:00Z")), ["cancelar_sin_cobertura"]); // 49 h
  assertEquals(accionesPara(p([]), AH, false, undefined, m("2026-10-19T16:00:00Z")).includes("cancelar_sin_cobertura"), false); // 47 h
  assertEquals(accionesPara(p([]), AH, false, undefined, m("2026-10-19T14:00:00Z", true)).includes("revisar_comprobante_sin_cobertura"), true);
  for (const t of ["PAGADO", "PAGO_VERIFICADO", "PAGO_ANTICIPADO_COMPROBANTE", "SIN_COBERTURA_CANCELADO", "RETIRO_EN_CASA"]) {
    const r = accionesPara(p([t]), AH, false, undefined, m("2026-10-15T14:00:00Z"));
    assertEquals(r.includes("cancelar_sin_cobertura") || r.includes("revisar_comprobante_sin_cobertura"), false, t);
  }
  assertEquals(accionesPara(p([]), AH, false, undefined, m(null)).includes("cancelar_sin_cobertura"), false); // sin registro del aviso
  assertEquals(accionesPara(p([]), AH, false).includes("cancelar_sin_cobertura"), false); // sin datos
});

Deno.test("21-10: JawFlex donde Lucero no cobra pero PaP sí → aviso (una vez); otros casos no", () => {
  const AH = new Date("2026-10-21T15:00:00Z");
  const ped = (productos: string[], tags: string[] = []) => ({ shopifyOrderId: 9, nombre: "#9", estado: "confirmado", tags: ["CONFIRMADO", ...tags], actualizadoEn: null, direccion: "Calle Larga 123", ciudad: "Pueblo X", notas: "", productos });
  const cob = (lucero: boolean, pap: boolean) => new Map([["Pueblo X", { sin_cobertura: !lucero && !pap, ciudad_reconocida: true, lucero, pap }]]);
  assertEquals(accionesPara(ped(["Ejercitador de mandibula JawFlex Pro"]), AH, false, cob(false, true)).includes("avisar_jawflex_pap"), true);
  assertEquals(accionesPara(ped(["Ejercitador de mandibula JawFlex Pro"]), AH, false, cob(true, true)).includes("avisar_jawflex_pap"), false); // Lucero llega: como hoy
  assertEquals(accionesPara(ped(["Tiras nasales"]), AH, false, cob(false, true)).includes("avisar_jawflex_pap"), false); // otro producto
  const ninguno = accionesPara(ped(["JawFlex Pro"]), AH, false, cob(false, false));
  assertEquals(ninguno.includes("avisar_sin_cobertura") && !ninguno.includes("avisar_jawflex_pap"), true); // flujo de sin cobertura
  assertEquals(accionesPara(ped(["JawFlex Pro"], ["PAGADO"]), AH, false, cob(false, true)).includes("avisar_jawflex_pap"), false);
});

Deno.test("28-10: zona o barrio + ciudad es dirección (Enrique: 'area 4 sirve ya como direccion'); sin ciudad no", () => {
  for (const d of ["Área 1", "Area 4", "Zona 2", "Km 7", "Barrio San Miguel", "Ruta 2", "B° Obrero", "Compañía Itá"]) {
    assertEquals(direccionUtilizable(base({ direccion: d, ciudad: "Ciudad del Este" })), true, d);
  }
  assertEquals(direccionUtilizable(base({ direccion: "Área 1", ciudad: "" })), false);
  assertEquals(direccionUtilizable(base({ direccion: "Seivo", ciudad: "Nueva esperanza" })), false); // 5 letras, sin número ni zona
  assertEquals(direccionUtilizable(base({ direccion: "", ciudad: "Luque" })), false);
});

// 29-10 (#1150 ciudad "Casa" con una calle de Asunción centro; #1159 "Mbocayaty"). Datos inventados.
Deno.test("29-10: ciudad 'Casa' sin pin → pedir la ciudad + FALTAN_DATOS, nunca SIN_COBERTURA", () => {
  const p = base({ nombre: "#9150", direccion: "Calle Inventada 1234 c/ Otra", ciudad: "Casa" });
  const m = new Map([["Casa", DESCONOCIDA]]);
  const a = accionesPara(p, AHORA, false, m);
  assertEquals(a, ["pedir_ciudad", "agregar_faltan_datos"]);
  assertEquals(a.includes("avisar_sin_cobertura"), false);
  // Ya tiene FALTAN_DATOS (la puso el sistema): no se saca mientras la ciudad siga sin reconocerse.
  assertEquals(accionesPara({ ...p, tags: ["CONFIRMADO", "FALTAN_DATOS"] }, AHORA, true, m), ["pedir_ciudad"]);
  // El cliente contestó y la ciudad ya es reconocida con courier → se saca FALTAN_DATOS, nada de sin cobertura.
  const ok = { ...p, ciudad: "Asunción", tags: ["CONFIRMADO", "FALTAN_DATOS"] };
  assertEquals(accionesPara(ok, AHORA, true, new Map([["Asunción", CON]])), ["quitar_faltan_datos"]);
});

Deno.test("29-10: ciudad 'Casa' con pin → la ciudad sale del pin (una vez); si no alcanzó, se le pide al cliente", () => {
  const p = base({ nombre: "#9151", direccion: "Calle Inventada 1234, Mapa: https://maps.google.com/?q=-25.2800000,-57.6300000", ciudad: "Casa" });
  const m = new Map([["Casa", DESCONOCIDA]]);
  assertEquals(accionesPara(p, AHORA, false, m), ["ciudad_desde_pin"]); // con pin la dirección sirve: sin FALTAN_DATOS todavía
  assertEquals(accionesPara(p, AHORA, false, m, undefined, true), ["pedir_ciudad", "agregar_faltan_datos"]);
});

Deno.test("29-10: ciudad reconocida sin courier con cobranza → SIN_COBERTURA como hoy; 'Mbocayaty' no", () => {
  const p = base({ nombre: "#9152", direccion: "Calle Inventada 1234", ciudad: "Pueblo Reconocido" });
  assertEquals(accionesPara(p, AHORA, false, new Map([["Pueblo Reconocido", SIN]])), ["avisar_sin_cobertura"]);
  // Mbocayaty: con la migración la tabla la reconoce (Lucero cobra); sin la migración, la lista vieja la empareja. Nunca sin cobertura.
  const mb = base({ nombre: "#9159", direccion: "Calle Inventada 1234", ciudad: "Mbocayaty" });
  assertEquals(accionesPara(mb, AHORA, false, new Map([["Mbocayaty", { sin_cobertura: false, ciudad_reconocida: true, lucero: true, pap: false }]])), []);
  assertEquals(accionesPara(mb, AHORA, false, new Map([["Mbocayaty", DESCONOCIDA]])), []);
});
