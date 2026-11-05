// pedidos-trabados · lógica pura (12-10-2026). Decide qué hay que corregir en Shopify para que Voltra OS y Shopify digan
// lo mismo y ningún pedido quede trabado en "no preparado". Los mensajes al cliente NO son de acá (chat de WhatsApp API).
//   1. Confirmado en Voltra OS sin etiqueta CONFIRMADO → agregarla (si no, Despacho lo ve "sin confirmar").
//   2. Cancelado por el cliente (cancelado_cliente) hace más de 2 h y abierto en Shopify → cancelarlo (sin aviso,
//      devolviendo stock). Las 2 h dan margen al "Lo quiero igual". Los "sin respuesta" ya los cancela procesar-envios.
//   3. Sin dirección utilizable → etiqueta FALTAN_DATOS. Dirección utilizable = calle (≥ 6 letras) O pin GPS (Enrique
//      12-10: con pin se entrega igual) + ciudad. Si después se completa, se saca la etiqueta, pero SOLO si la puso el
//      sistema (una puesta a mano no se toca).
//      15-10 (Enrique, #1055): "con el pin basta y sobra" → con pin es utilizable aunque falte la ciudad.
//      28-10 (Enrique): una zona o barrio reconocible + ciudad también ("Área 4", "Km 7", "Zona 2").
//   4. Pedido del bot que llegó a Shopify SIN dirección (Shopify la descarta entera si el apellido va vacío: nombre de
//      una sola palabra, #1055) pero con Ciudad/Calle/Mapa en la nota → se completa la dirección desde la nota.
//   5. Ciudad "Ver mapa" (el bot no pudo leer el mapa, #1056) y hay pin → se busca la ciudad del pin y se carga en
//      Shopify: sin ciudad real, Despacho no encuentra transportadora y no deja pasar el pedido a Ventas.
//   6. Confirmado en una ciudad que ni PaP ni Lucero cubren contra entrega (#1056, Enrique 15-10) → se le ofrece al
//      cliente pagar por adelantado y mandarlo por una transportadora que llegue (una vez, etiqueta SIN_COBERTURA)
//      y se avisa a Enrique por Telegram.
//      20-10: la cobertura sale de la rpc sugerir_courier (tabla tarifas_courier: solo cuenta donde el courier COBRA
//      contra entrega). La lista vieja de transportadoras.js daba a PaP como "con cobranza" en Ayolas, Choré, San José
//      de los Arroyos y San Juan Nepomuceno (se perdió un pedido contra entrega). Si la tabla no reconoce la ciudad
//      (typo, pueblo chico) o la rpc falló, no se decide con ella. io.ts arma el mapa antes de decidir.
//      29-10 (#1150 ciudad "Casa", #1159 "Mbocayaty"): SIN_COBERTURA SOLO con la ciudad reconocida por la tabla y
//      ningún courier que cobre ahí. Ciudad que no está en la tabla (ni la lista vieja la conoce con un courier que
//      cobre) → NUNCA sin cobertura: primero la ciudad del pin (ciudad_desde_pin, una vez) y, si no hay pin o no
//      alcanzó, se le pide al cliente (pedir_ciudad) y queda FALTAN_DATOS. Sin dato de la rpc (falló) → no se decide.
//      02-11 (#1176 Filadelfia): la cobranza sale solo de la tabla; la lista vieja ya no es respaldo. Las ciudades reales
//      sin cobranza están en la tabla con aplica_cobranza=false, así que dan ciudad reconocida y SIN_COBERTURA.
// Cada acción se hace una sola vez por pedido (candado en eventos_crudos): si Enrique la deshace a mano, se respeta.

import { direccionUtilizable as direccionUtilizableRegla, tienePin as tienePinRegla } from "../_shared/sale_hoy.js";

export type Accion = "agregar_confirmado" | "cancelar" | "agregar_faltan_datos" | "quitar_faltan_datos" | "completar_direccion" | "ciudad_desde_pin" | "avisar_sin_cobertura" | "cancelar_sin_cobertura" | "revisar_comprobante_sin_cobertura" | "avisar_jawflex_pap" | "pedir_ciudad" | "corroborar_ciudad_pin" | "cancelar_pago_requerido" | "revisar_comprobante_pago_requerido";

export interface PedidoAbierto {
  shopifyOrderId: number;
  nombre: string;
  estado: string | null; // estado_confirmacion
  tags: string[];
  actualizadoEn: string | null;
  direccion: string; // address1 + address2
  ciudad: string;
  notas: string; // note + note_attributes (para el pin)
  /** 21-10: títulos de los productos del pedido (regla "solo Lucero"). */
  productos?: string[];
}

export const MARGEN_CANCELACION_MS = 2 * 3_600_000;

/** Pin GPS en la dirección o en las notas. 29-10: la regla vive en _shared/sale_hoy.js (la misma que usa Despacho). */
export function tienePin(p: Pick<PedidoAbierto, "direccion" | "notas">): boolean {
  return tienePinRegla(p);
}

/**
 * Pin (15-10: con el pin basta, aunque falte la ciudad), o ciudad + calle (≥ 6 letras), o ciudad + zona/barrio
 * (28-10: "Área 4", "Km 7"). 29-10: la regla vive en _shared/sale_hoy.js (la misma que usa Despacho).
 */
export function direccionUtilizable(p: Pick<PedidoAbierto, "direccion" | "notas" | "ciudad">): boolean {
  return direccionUtilizableRegla(p);
}

export interface DireccionNota {
  firstName: string;
  lastName: string;
  address1: string;
  address2: string | null;
  city: string;
  phone: string | null;
}

/**
 * Dirección armada desde la nota que escribe el vendedor ("Nombre: … / Celular: … / Ciudad: … / Calle: … / Mapa: … /
 * Referencia: …"). null si no hay ciudad, o si no hay ni calle ni mapa. El apellido nunca va vacío (Shopify descarta la
 * dirección entera): si el nombre es de una palabra, va "-".
 */
export function direccionDesdeNota(notas: string): DireccionNota | null {
  const campo = (k: string) => (new RegExp(`^${k}:\\s*(.+)$`, "mi").exec(notas)?.[1] ?? "").trim();
  const ciudad = campo("Ciudad"), calle = campo("Calle"), mapa = campo("Mapa"), ref = campo("Referencia");
  if (!ciudad || ciudad === "-" || (!calle && !mapa)) return null;
  const [nombre, ...resto] = (campo("Nombre") || "Cliente WhatsApp").split(/\s+/);
  return {
    firstName: nombre,
    lastName: resto.join(" ") || "-",
    address1: calle || ref || "Ver mapa",
    address2: [ref, mapa ? `Mapa: ${mapa}` : null].filter(Boolean).join(" · ") || null,
    city: ciudad,
    phone: campo("Celular") || null,
  };
}

/** Coordenadas del pin (dirección o notas). */
export function coordenadasPin(p: Pick<PedidoAbierto, "direccion" | "notas">): { lat: number; lng: number } | null {
  const m = /(-\d{1,2}\.\d{3,})\s*,\s*(-\d{1,2}\.\d{3,})/.exec(`${p.direccion}\n${p.notas}`);
  return m ? { lat: Number(m[1]), lng: Number(m[2]) } : null;
}

/** 20-10: resultado de la rpc sugerir_courier(ciudad) para una ciudad (lo que importa acá). */
export type Cobertura = { sin_cobertura: boolean; ciudad_reconocida: boolean; /** 21-10: cobranza contra entrega por courier (de sugerir_courier) */ lucero?: boolean; pap?: boolean };
/** Ciudad tal cual viene en el pedido (sin espacios de los costados) → cobertura según la rpc. */
export type MapaCobertura = ReadonlyMap<string, Cobertura>;
export const claveCobertura = (ciudad: string) => ciudad.trim();

/**
 * ¿Ningún courier con cobro contra entrega (PaP o Lucero) llega a esa ciudad? 29-10: SOLO si la tabla (rpc
 * sugerir_courier) reconoce la ciudad. Ciudad no reconocida o sin dato de la rpc → false (nunca "sin cobertura").
 */
export function sinCobertura(_ciudad: string, cobertura?: Cobertura | null): boolean {
  return cobertura?.ciudad_reconocida === true && cobertura.sin_cobertura === true;
}

/**
 * 29-10: la ciudad no se sabe cuál es: la tabla no la reconoce ("Casa", "Central", un pueblo que no figura). Sin dato de
 * la rpc → false (no se decide nada hasta tenerlo). 02-11 (#1176): la lista vieja ya no cuenta como cobertura.
 */
export function ciudadDesconocida(_ciudad: string, cobertura?: Cobertura | null): boolean {
  return !!cobertura && !cobertura.ciudad_reconocida;
}

/**
 * 05-11: ¿se corrige la ciudad escrita con la del pin? `canonEscrita` / `canonPin` = nombre de la ciudad según la tabla de
 * tarifas (null si ningún courier la tiene). Manda el pin, salvo que el pin no dé una ciudad conocida y la escrita sí.
 */
export function decidirCiudadPin(d: { escrita: string; pin: string | null; canonEscrita: string | null; canonPin: string | null }):
  { cambiar: false; motivo: string } | { cambiar: true; nueva: string; motivo: string } {
  if (!d.pin) return { cambiar: false, motivo: "el pin no dio ciudad" };
  if (d.canonPin && d.canonEscrita && d.canonPin === d.canonEscrita) return { cambiar: false, motivo: "coincide" };
  if (d.canonPin) return { cambiar: true, nueva: d.canonPin, motivo: d.canonEscrita ? "otra ciudad" : "ciudad escrita no reconocida" };
  if (d.canonEscrita) return { cambiar: false, motivo: "el pin no da una ciudad de la tabla; queda la escrita" };
  return { cambiar: true, nueva: d.pin, motivo: "ninguna reconocida; manda el pin" };
}

/** Nota que queda en el pedido de Shopify al corregir. */
export const notaCiudadPin = (escrita: string, nueva: string) => `Ciudad corregida por pin: ${escrita || "(vacía)"} → ${nueva}`;
export const TAG_CIUDAD_POR_PIN = "CIUDAD_POR_PIN";

/** 02-11 (#1176): la etiqueta y las 48 h solo cuentan si el aviso salió; si no, se reintenta en la próxima corrida. */
export const trasAvisoSinCobertura = (enviado: boolean) => ({ etiquetar: enviado, soltarCandado: !enviado });

export const ciudadPendiente = (ciudad: string) => !ciudad.trim() || /^ver mapa$/i.test(ciudad.trim());

const sinDireccion = (p: Pick<PedidoAbierto, "direccion" | "ciudad">) => !p.direccion.trim() && !p.ciudad.trim();

const tiene = (p: PedidoAbierto, t: string) => p.tags.some((x) => x.toUpperCase() === t);

const ETIQUETAS_SIN_AVISO = ["PAGADO", "RETIRO_EN_CASA", "SIN_COBERTURA", "PAGO_ANTICIPADO_REQUERIDO"];
const cancelado = (p: PedidoAbierto) =>
  p.estado === "cancelado_cliente" || p.estado === "cancelado_sin_respuesta" || tiene(p, "CANCELADO_CLIENTE");

/** 20-10: ¿hay que mirar la cobertura de este pedido? (para que io.ts consulte la rpc solo de esas ciudades) */
export function necesitaCobertura(p: PedidoAbierto): boolean {
  return p.estado === "confirmado" && !cancelado(p) && !ciudadPendiente(p.ciudad) && !ETIQUETAS_SIN_AVISO.some((t) => tiene(p, t));
}

/**
 * 21-10 (Enrique): pedido SIN_COBERTURA al que se le ofreció pagar por adelantado. A las 48 h del aviso sin pago
 * (PAGADO / PAGO_VERIFICADO / PAGADO_QR / PAGO_ANTICIPADO_COMPROBANTE) ni foto o archivo del cliente en el chat → se
 * cancela (etiqueta SIN_COBERTURA_CANCELADO). Si mandó una foto o un archivo, no se cancela: se avisa a Enrique para
 * que revise si es el comprobante.
 */
/** 21-10: productos con la regla "solo sale por Lucero" (hoy JawFlex; mismo criterio que el resto del sistema). */
export const esProductoSoloLucero = (titulo: string) => /jaw|mand[ií]bula|ejercitador/i.test(titulo);

/**
 * 21-10 (Enrique): pedido con un producto "solo Lucero" en una ciudad donde Lucero NO cobra pero PaP SÍ → Despacho lo
 * manda por PaP solo; esto avisa por Telegram (una vez por pedido). Si ninguno cobra, es el flujo de sin cobertura.
 */
export function necesitaAvisoJawflexPap(p: PedidoAbierto, c?: Cobertura | null): boolean {
  return necesitaCobertura(p) && (p.productos ?? []).some(esProductoSoloLucero) && c?.lucero === false && c?.pap === true;
}

export const PLAZO_PAGO_SIN_COBERTURA_MS = 48 * 3_600_000;
export const ETIQUETAS_PAGO = ["PAGADO", "PAGO_VERIFICADO", "PAGADO_QR", "PAGO_ANTICIPADO_COMPROBANTE"];
export type EstadoSinCobertura = { avisoEn: string | null; adjuntoDespues: boolean };
export type MapaSinCobertura = ReadonlyMap<number, EstadoSinCobertura>;

export function accionSinCobertura(p: PedidoAbierto, ahora: Date, s?: EstadoSinCobertura): Accion | null {
  // 05-11: PAGO_ANTICIPADO_REQUERIDO (cliente con devoluciones, se lo pide el bot) sigue el mismo plazo de 48 h.
  const requerido = !tiene(p, "SIN_COBERTURA") && tiene(p, TAG_PAGO_REQUERIDO);
  if (!(tiene(p, "SIN_COBERTURA") || requerido) || tiene(p, "SIN_COBERTURA_CANCELADO") || tiene(p, "PAGO_REQUERIDO_CANCELADO") || tiene(p, "RETIRO_EN_CASA")) return null;
  if (ETIQUETAS_PAGO.some((t) => tiene(p, t)) || !s?.avisoEn) return null;
  const t = Date.parse(s.avisoEn);
  if (!Number.isFinite(t) || ahora.getTime() - t < PLAZO_PAGO_SIN_COBERTURA_MS) return null;
  if (requerido) return s.adjuntoDespues ? "revisar_comprobante_pago_requerido" : "cancelar_pago_requerido";
  return s.adjuntoDespues ? "revisar_comprobante_sin_cobertura" : "cancelar_sin_cobertura";
}

/** 05-11: etiqueta que pone el bot (WhatsApp API) al pedir pago anticipado a un cliente con devoluciones; candado auto_pago_requerido. */
export const TAG_PAGO_REQUERIDO = "PAGO_ANTICIPADO_REQUERIDO";

/**
 * Acciones para un pedido. `puseFaltanDatos` = el sistema puso la etiqueta (candado). `coberturas` = rpc
 * sugerir_courier por ciudad (claveCobertura). `pinIntentado` = ya se buscó una vez la ciudad del pin (candado
 * auto_ciudad_desde_pin): si la ciudad sigue sin reconocerse, se le pide al cliente.
 */
export function accionesPara(p: PedidoAbierto, ahora: Date, puseFaltanDatos: boolean, coberturas?: MapaCobertura, sinCob?: MapaSinCobertura, pinIntentado = false, pinCorroborado = true): Accion[] {
  const a: Accion[] = [];
  if (p.estado === "cancelado_cliente" || (tiene(p, "CANCELADO_CLIENTE") && p.estado !== "confirmado")) {
    const t = p.actualizadoEn ? Date.parse(p.actualizadoEn) : NaN;
    if (Number.isFinite(t) && ahora.getTime() - t >= MARGEN_CANCELACION_MS) a.push("cancelar");
    return a; // cancelado: nada más que hacer
  }
  if (cancelado(p)) return a;
  const sc = accionSinCobertura(p, ahora, sinCob?.get(p.shopifyOrderId));
  if (sc === "cancelar_sin_cobertura" || sc === "cancelar_pago_requerido") return [sc]; // se cancela: nada más que hacer
  if (sc) a.push(sc);
  if (p.estado === "confirmado" && !tiene(p, "CONFIRMADO")) a.push("agregar_confirmado");
  // 15-10: sin dirección en Shopify pero con los datos en la nota (pedido del bot) → se completa, no se marca.
  if (sinDireccion(p) && direccionDesdeNota(p.notas)) {
    a.push("completar_direccion");
    if (tiene(p, "FALTAN_DATOS") && puseFaltanDatos) a.push("quitar_faltan_datos");
    return a;
  }
  if (ciudadPendiente(p.ciudad) && p.direccion.trim() && coordenadasPin(p)) a.push("ciudad_desde_pin");
  // 05-11 (Enrique: "ESO DEBE ESTAR AUTOMATIZADO YA PARA CORROBORAR"): con pin y ciudad escrita, primero se compara la
  // ciudad con la del pin (una vez por pedido). Cobertura, FALTAN_DATOS y avisos esperan a la corrida siguiente, con la
  // ciudad ya corregida: así no sale un aviso de "sin cobertura" por una ciudad mal escrita.
  else if (!pinCorroborado && coordenadasPin(p) && !ciudadPendiente(p.ciudad)) {
    a.push("corroborar_ciudad_pin");
    return a;
  }
  const cob = coberturas?.get(claveCobertura(p.ciudad));
  // 29-10: ciudad que no está en las tablas → nunca SIN_COBERTURA: primero el pin (una vez), si no, preguntarle al cliente.
  const desconocida = necesitaCobertura(p) && ciudadDesconocida(p.ciudad, cob);
  const pedirCiudad = desconocida && (!coordenadasPin(p) || pinIntentado);
  if (desconocida) a.push(pedirCiudad ? "pedir_ciudad" : "ciudad_desde_pin");
  else if (necesitaCobertura(p) && sinCobertura(p.ciudad, cob)) a.push("avisar_sin_cobertura");
  else if (necesitaAvisoJawflexPap(p, cob)) a.push("avisar_jawflex_pap");
  const ok = direccionUtilizable(p) && !pedirCiudad;
  if (!ok && !tiene(p, "FALTAN_DATOS") && !tiene(p, "RETIRO_EN_CASA")) a.push("agregar_faltan_datos");
  if (ok && tiene(p, "FALTAN_DATOS") && puseFaltanDatos) a.push("quitar_faltan_datos");
  return a;
}
