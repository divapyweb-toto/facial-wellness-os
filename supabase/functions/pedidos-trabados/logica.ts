// pedidos-trabados · lógica pura (12-10-2026). Decide qué hay que corregir en Shopify para que Voltra OS y Shopify digan
// lo mismo y ningún pedido quede trabado en "no preparado". Los mensajes al cliente NO son de acá (chat de WhatsApp API).
//   1. Confirmado en Voltra OS sin etiqueta CONFIRMADO → agregarla (si no, Despacho lo ve "sin confirmar").
//   2. Cancelado por el cliente (cancelado_cliente) hace más de 2 h y abierto en Shopify → cancelarlo (sin aviso,
//      devolviendo stock). Las 2 h dan margen al "Lo quiero igual". Los "sin respuesta" ya los cancela procesar-envios.
//   3. Sin dirección utilizable → etiqueta FALTAN_DATOS. Dirección utilizable = calle (≥ 6 letras) O pin GPS (Enrique
//      12-10: con pin se entrega igual) + ciudad. Si después se completa, se saca la etiqueta, pero SOLO si la puso el
//      sistema (una puesta a mano no se toca).
//      15-10 (Enrique, #1055): "con el pin basta y sobra" → con pin es utilizable aunque falte la ciudad.
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
//      (typo, pueblo chico) o la rpc falló, se usa la lista vieja como respaldo. io.ts arma el mapa antes de decidir.
// Cada acción se hace una sola vez por pedido (candado en eventos_crudos): si Enrique la deshace a mano, se respeta.

import { transportadorasDisponibles } from "../_shared/transportadoras.js";

export type Accion = "agregar_confirmado" | "cancelar" | "agregar_faltan_datos" | "quitar_faltan_datos" | "completar_direccion" | "ciudad_desde_pin" | "avisar_sin_cobertura";

export interface PedidoAbierto {
  shopifyOrderId: number;
  nombre: string;
  estado: string | null; // estado_confirmacion
  tags: string[];
  actualizadoEn: string | null;
  direccion: string; // address1 + address2
  ciudad: string;
  notas: string; // note + note_attributes (para el pin)
}

export const MARGEN_CANCELACION_MS = 2 * 3_600_000;
const PIN = /-\d{1,2}\.\d{3,}\s*,\s*-\d{1,2}\.\d{3,}/;

export function tienePin(p: Pick<PedidoAbierto, "direccion" | "notas">): boolean {
  return PIN.test(p.direccion) || PIN.test(p.notas);
}

export function direccionUtilizable(p: Pick<PedidoAbierto, "direccion" | "notas" | "ciudad">): boolean {
  if (tienePin(p)) return true; // 15-10: con el pin se entrega igual, aunque falte la ciudad
  if (!p.ciudad.trim() || p.ciudad.trim() === "-") return false;
  const calle = p.direccion.replace(/pin de ubicaci[oó]n:?/gi, "").replace(/sin calle \(ubicaci[oó]n pendiente\)/gi, "").replace(PIN, "").replace(/https?:\/\/\S+/g, "").replace(/[^A-Za-zÁÉÍÓÚÑáéíóúñ]/g, "");
  return calle.length >= 6;
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
export type Cobertura = { sin_cobertura: boolean; ciudad_reconocida: boolean };
/** Ciudad tal cual viene en el pedido (sin espacios de los costados) → cobertura según la rpc. */
export type MapaCobertura = ReadonlyMap<string, Cobertura>;
export const claveCobertura = (ciudad: string) => ciudad.trim();

/** Respaldo: la lista de transportadoras.js (ruteo del front). */
export const sinCoberturaLista = (ciudad: string) => !transportadorasDisponibles(ciudad).some((t: string) => t === "pap" || t === "lucero");

/**
 * ¿Ninguna transportadora con cobro contra entrega (PaP o Lucero) llega a esa ciudad? 20-10: con la ciudad reconocida
 * por la rpc sugerir_courier, manda su sin_cobertura; si no (typo o sin dato), la lista vieja.
 */
export function sinCobertura(ciudad: string, cobertura?: Cobertura | null): boolean {
  if (cobertura?.ciudad_reconocida) return cobertura.sin_cobertura;
  return sinCoberturaLista(ciudad);
}

export const ciudadPendiente = (ciudad: string) => !ciudad.trim() || /^ver mapa$/i.test(ciudad.trim());

const sinDireccion = (p: Pick<PedidoAbierto, "direccion" | "ciudad">) => !p.direccion.trim() && !p.ciudad.trim();

const tiene = (p: PedidoAbierto, t: string) => p.tags.some((x) => x.toUpperCase() === t);

const ETIQUETAS_SIN_AVISO = ["PAGADO", "RETIRO_EN_CASA", "SIN_COBERTURA"];
const cancelado = (p: PedidoAbierto) =>
  p.estado === "cancelado_cliente" || p.estado === "cancelado_sin_respuesta" || tiene(p, "CANCELADO_CLIENTE");

/** 20-10: ¿hay que mirar la cobertura de este pedido? (para que io.ts consulte la rpc solo de esas ciudades) */
export function necesitaCobertura(p: PedidoAbierto): boolean {
  return p.estado === "confirmado" && !cancelado(p) && !ciudadPendiente(p.ciudad) && !ETIQUETAS_SIN_AVISO.some((t) => tiene(p, t));
}

/**
 * Acciones para un pedido. `puseFaltanDatos` = el sistema puso la etiqueta (candado). `coberturas` = rpc
 * sugerir_courier por ciudad (claveCobertura); sin dato para la ciudad → lista vieja.
 */
export function accionesPara(p: PedidoAbierto, ahora: Date, puseFaltanDatos: boolean, coberturas?: MapaCobertura): Accion[] {
  const a: Accion[] = [];
  if (p.estado === "cancelado_cliente" || (tiene(p, "CANCELADO_CLIENTE") && p.estado !== "confirmado")) {
    const t = p.actualizadoEn ? Date.parse(p.actualizadoEn) : NaN;
    if (Number.isFinite(t) && ahora.getTime() - t >= MARGEN_CANCELACION_MS) a.push("cancelar");
    return a; // cancelado: nada más que hacer
  }
  if (cancelado(p)) return a;
  if (p.estado === "confirmado" && !tiene(p, "CONFIRMADO")) a.push("agregar_confirmado");
  // 15-10: sin dirección en Shopify pero con los datos en la nota (pedido del bot) → se completa, no se marca.
  if (sinDireccion(p) && direccionDesdeNota(p.notas)) {
    a.push("completar_direccion");
    if (tiene(p, "FALTAN_DATOS") && puseFaltanDatos) a.push("quitar_faltan_datos");
    return a;
  }
  if (ciudadPendiente(p.ciudad) && p.direccion.trim() && coordenadasPin(p)) a.push("ciudad_desde_pin");
  if (necesitaCobertura(p) && sinCobertura(p.ciudad, coberturas?.get(claveCobertura(p.ciudad)))) a.push("avisar_sin_cobertura");
  const ok = direccionUtilizable(p);
  if (!ok && !tiene(p, "FALTAN_DATOS") && !tiene(p, "RETIRO_EN_CASA")) a.push("agregar_faltan_datos");
  if (ok && tiene(p, "FALTAN_DATOS") && puseFaltanDatos) a.push("quitar_faltan_datos");
  return a;
}
