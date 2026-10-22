// scripts/escenarios-vendedor.ts · Escenarios del simulador del vendedor (scripts/simular-vendedor.ts).
// Casos reales parafraseados con datos INVENTADOS (el repo es público): nombres de prueba y teléfonos +595981000xxx.
//
// Cómo agregar un escenario: sumá un objeto a ESCENARIOS. Cada paso es lo que manda el cliente:
//   "texto libre"                 mensaje de texto
//   "boton:<título>"              toca el último botón con ese título (el simulador arma "[botón] <título> (<id>)")
//   "ubicacion:-25.5,-54.6"       pin de WhatsApp (mismo texto que arma wa-webhook)
//   "marca:<texto>|<mensaje>"     antepone una marca a mano (además de las que pone el webhook solo)
//   { texto: "[seguimiento 1]", origen: "seguimiento", espera_min: 180 }   seguimiento automático (3 h después)
// Las marcas del webhook se ponen solas como en producción: la del anuncio (campo `anuncio`) y la del pedido abierto
// o PISTA_PEDIDO_OTRO_NUMERO (conPedidoAbierto de wa-webhook/procesar.ts, con los `pedidos` del escenario).
//
// Chequeos (`checks`): `paso` = índice del paso (0 = primero; negativo cuenta desde el final; omitido = toda la charla).
//   { tipo: "responde" }                          hubo al menos una burbuja o interactivo (no silencio)
//   { tipo: "herramienta", nombre, negar?, con_errores? }   el modelo (o el sistema: "cierre_botones(sistema)") usó esa
//                                                 herramienta con éxito (con_errores: también si la herramienta la rechazó)
//   { tipo: "texto", regex, negar? }              alguna burbuja de texto / cuerpo de interactivo coincide
//   { tipo: "boton", regex, negar? }              algún botón enviado (id o título) coincide
//   { tipo: "escritura", regex, negar? }          lo que SE HABRÍA escrito en Shopify/DB (JSON) coincide
//   { tipo: "derivado", negar? }                  pasó el chat a Enrique
//   { tipo: "montos_catalogo" }                   todo monto en guaraníes que dijo el bot sale del catálogo/config
//   { tipo: "fn", fn: (r) => true | "motivo del FAIL" }   chequeo a medida (ver ResultadoSim en simular-vendedor.ts)

import { validarRuc } from "../supabase/functions/_shared/sifen/cdc.ts";

/** espera_min: minutos simulados desde el paso anterior (default 0,5). Ej. un seguimiento 3 h después: 180. */
/**
 * 21-10: `agrupar: true` = el mensaje llega pegado al siguiente (se guarda sin turno; el turno del siguiente ve los dos,
 * como el vendedor real con espera_agrupar_s). `decidir: true` (solo seguimientos) = antes del turno pasa por la decisión
 * real de seguimiento-chat (horas, 120 min, pedido a medio armar); si no corresponde, no sale nada.
 */
export type Paso = string | { texto: string; origen?: "cliente" | "seguimiento"; espera_min?: number; agrupar?: boolean; decidir?: boolean };

export type PedidoEscenario = {
  numero: number; // 1072 → "#1072"
  /** null = pedido hecho con otro teléfono / sin cliente vinculado. "cliente" = el cliente del escenario. */
  cliente: "cliente" | null;
  telefono?: string; // por defecto el del cliente si cliente="cliente"
  nombre_cliente: string;
  hace_min: number; // creado hace N minutos
  estado_confirmacion: "pendiente" | "confirmado";
  app: "Releasit COD Form" | "Voltra OS" | "Online Store";
  despachado?: boolean;
  cancelado?: boolean;
  lineas: Array<{ handle: string; cantidad: number; total: number }>;
  envio: number;
  ciudad?: string;
  direccion?: string;
  atributos?: Array<{ key: string; value: string }>;
};

export type Check = {
  tipo: "responde" | "herramienta" | "texto" | "boton" | "escritura" | "derivado" | "montos_catalogo" | "fn";
  nombre?: string;
  regex?: RegExp;
  negar?: boolean;
  /** tipo "herramienta": contar también las llamadas que la herramienta rechazó (error). */
  con_errores?: boolean;
  paso?: number;
  desc?: string;
  // deno-lint-ignore no-explicit-any
  fn?: (r: any) => true | string;
  /** Solo se reporta (no cuenta como FAIL duro). */
  suave?: boolean;
};

export type Escenario = {
  nombre: string;
  descripcion: string;
  cliente?: { nombre?: string; telefono?: string };
  /** Handle del producto del anuncio (click-to-WhatsApp): el webhook pone "[vino del anuncio de …, handle …]". */
  anuncio?: string;
  /** 21-10: texto del anuncio (referral.body) tal como lo manda Meta. */
  anuncio_texto?: string;
  /** Pedidos en la tienda (Shopify + shopify_pedidos), en memoria. */
  pedidos?: PedidoEscenario[];
  /** Pedido del bot ya creado en este chat (wa_pedidos_chat estado "creado"), por número de `pedidos`. */
  pedido_chat_creado?: number;
  consentimiento?: "si" | "no" | "baja" | "preguntado" | null;
  gasto_mes_usd?: number;
  /** ISO; por defecto ahora. */
  ahora?: string;
  /** Pisa campos de la config real (merge de un nivel por clave: { ofertas: {...} }, { vendedor: { modelo } }). */
  config?: Record<string, unknown>;
  /** 21-10: lo que devuelve el mapa para un pin (por defecto calle y ciudad inventadas). calle null = el mapa no la da. */
  mapa?: { calle: string | null; ciudad: string | null };
  pasos: Paso[];
  checks: Check[];
};

// ---------- datos inventados ----------

const RASPADOR = "raspador-de-lengua-de-acero-inoxidable";
const TIRAS = "tiras-nasales-gudair-30-unidades";
const EJERCITADOR = "ejercitador-de-mandibula-3-niveles";

/** RUC inventado con dígito verificador válido (lo calcula el mismo validador de SIFEN). */
function rucValido(base: string): string {
  for (let dv = 0; dv <= 9; dv++) if (validarRuc(base, dv)) return `${base}-${dv}`;
  throw new Error(`sin DV válido para ${base}`);
}
export const RUC_PRUEBA = rucValido("1234567");

const SIN_ACCION_INVENTADA = /(qued[oó]|ya (est[aá]|te lo)|listo|hecho|actualic|cambi[eé]|modifiqu[eé]).{0,40}(cambiad|modificad|actualizad|2 unidades|dos unidades|x ?2|158)/i;

export const ESCENARIOS: Escenario[] = [
  {
    nombre: "ok_al_precio",
    descripcion: "Anuncio del raspador; al precio con botones el cliente dice solo 'Ok': hay que reenviar los botones (no callarse).",
    cliente: { nombre: "Laura Prueba", telefono: "+595981000101" },
    anuncio: RASPADOR,
    pasos: ["Hola, quiero el raspador", "Ok"],
    checks: [
      { paso: 0, tipo: "responde" },
      { paso: 0, tipo: "boton", regex: /vend_p1:/, desc: "primer turno con botones de compra" },
      { paso: 1, tipo: "responde", desc: "no silencio al 'Ok'" },
      { paso: 1, tipo: "boton", regex: /vend_p1:/, desc: "reenvía los botones de compra" },
      { paso: 1, tipo: "fn", desc: "3 botones (o los que da el producto) re-enviados", fn: (r) => {
        const b = r.pasos[1].botones as Array<{ id: string }>;
        return b.filter((x) => x.id.startsWith("vend_p1:")).length >= 2 || `solo ${b.length} botones`;
      } },
      { tipo: "montos_catalogo" },
    ],
  },
  {
    nombre: "cuanto_2_pedido_web",
    descripcion: "#1072 parafraseado: pedido de Releasit pendiente de 1 ejercitador; pregunta '2 x cuánto?' y dice 'Si'. Debe mostrar el resumen de modificar_pedido con Confirmo y recién con Confirmo reemplazar el pedido (158.000).",
    cliente: { nombre: "Ana Prueba", telefono: "+595981000102" },
    pedidos: [{
      numero: 1072, cliente: "cliente", nombre_cliente: "Ana Prueba", hace_min: 25, estado_confirmacion: "pendiente",
      app: "Releasit COD Form", lineas: [{ handle: EJERCITADOR, cantidad: 1, total: 79000 }], envio: 33000,
      ciudad: "Ciudad del Este", direccion: "Calle Falsa 123",
    }],
    pasos: ["2 x cuánto?", "Si", "boton:Confirmo"],
    checks: [
      { paso: 0, tipo: "responde" },
      { paso: 0, tipo: "texto", regex: SIN_ACCION_INVENTADA, negar: true, desc: "no dice que ya lo cambió" },
      { paso: 1, tipo: "texto", regex: SIN_ACCION_INVENTADA, negar: true, desc: "no dice que ya lo cambió" },
      { tipo: "fn", desc: "resumen de modificar_pedido con Confirmo (vend_mod:) antes del toque", fn: (r) => {
        const ok = r.pasos.slice(0, 2).some((p: { botones: Array<{ id: string }> }) => p.botones.some((b) => b.id.startsWith("vend_mod:")));
        return ok || "nunca se mandó el resumen con vend_mod:";
      } },
      { paso: 2, tipo: "herramienta", nombre: "modificar_pedido", desc: "modificar_pedido en el Confirmo" },
      { paso: 2, tipo: "escritura", regex: /crearDesdeBorrador/, desc: "pedido nuevo desde borrador" },
      { paso: 2, tipo: "escritura", regex: /cancelarOrden/, desc: "cancela el original" },
      { paso: 2, tipo: "escritura", regex: /REEMPLAZA_A_#1072/, desc: "tag REEMPLAZA_A_#1072 en el nuevo" },
      { paso: 2, tipo: "escritura", regex: /REEMPLAZADO_POR_#/, desc: "tag REEMPLAZADO_POR_ en el viejo" },
      { tipo: "fn", desc: "total del cambio = oferta x2 + envío (158.000)", fn: (r) => {
        const esperado = r.precio(EJERCITADOR, 2) + r.envio;
        const mod = r.modificaciones.at(-1);
        if (!mod) return "sin modificación guardada";
        return mod.datos.total === esperado && esperado === 158000 ? true : `total ${mod.datos.total}, esperado ${esperado} (catálogo) / 158000`;
      } },
      { tipo: "derivado", negar: true },
    ],
  },
  {
    nombre: "pedido_web_otro_numero",
    descripcion: "#1067 parafraseado: 'Acabo de hacer un pedido en Voltra' desde un número sin pedidos; hay un pedido web reciente con otro teléfono. Debe usar buscar_pedido y preguntar si es el suyo (o pedir número/teléfono).",
    cliente: { nombre: "Rosa", telefono: "+595981000103" },
    pedidos: [{
      numero: 1067, cliente: null, telefono: "+595981000777", nombre_cliente: "Rosa Prueba Gómez", hace_min: 12,
      estado_confirmacion: "pendiente", app: "Releasit COD Form", lineas: [{ handle: EJERCITADOR, cantidad: 1, total: 79000 }],
      envio: 33000, ciudad: "Hernandarias", direccion: "Barrio Inventado casa 4",
    }],
    pasos: ["Acabo de hacer un pedido en Voltra"],
    checks: [
      { paso: 0, tipo: "fn", desc: "el webhook puso PISTA_PEDIDO_OTRO_NUMERO", fn: (r) => r.pasos[0].alVendedor.includes("posible pedido web con otro número") || "sin PISTA" },
      { paso: 0, tipo: "herramienta", nombre: "buscar_pedido" },
      { paso: 0, tipo: "texto", regex: /#?1067|n[uú]mero de pedido|tel[eé]fono/i, desc: "pregunta '¿es el #1067…?' o pide número/teléfono" },
      { paso: 0, tipo: "texto", regex: /0981000777|981000777/, negar: true, desc: "no revela el teléfono" },
      { tipo: "derivado", negar: true },
    ],
  },
  {
    nombre: "rinitis",
    descripcion: "Anuncio de tiras; pregunta si sirve para la rinitis: sin derivar, texto seguro (sin tratamiento/cura/elimina) y sigue vendiendo.",
    cliente: { nombre: "Marta Prueba", telefono: "+595981000104" },
    anuncio: TIRAS,
    pasos: ["Hola, info", "¿Sirve para la rinitis?"],
    checks: [
      { paso: 0, tipo: "responde" },
      { paso: 1, tipo: "responde" },
      { paso: 1, tipo: "derivado", negar: true, desc: "no deriva" },
      { paso: 1, tipo: "herramienta", nombre: "derivar_a_enrique", negar: true, desc: "no deriva con la herramienta" },
      { paso: 1, tipo: "herramienta", nombre: "derivar_a_enrique", negar: true, con_errores: true, suave: true, desc: "ni siquiera intenta derivar (el freno salud_sin_alerta no hace falta)" },
      { paso: 1, tipo: "texto", regex: /tratamiento|\bcura|elimina/i, negar: true, desc: "sin tratamiento/cura/elimina" },
      { paso: 1, tipo: "fn", desc: "sigue vendiendo (pregunta o botones)", fn: (r) => {
        const p = r.pasos[1];
        return p.botones.length > 0 || p.textos.some((t: string) => t.includes("?")) || "ni pregunta ni botones";
      } },
      { tipo: "montos_catalogo" },
    ],
  },
  {
    nombre: "factura_pedido_existente",
    descripcion: "Cliente con un pedido del bot ya creado pide factura con RUC válido: guardar_factura, sin derivar.",
    cliente: { nombre: "Pedro Prueba", telefono: "+595981000105" },
    pedidos: [{
      numero: 1080, cliente: "cliente", nombre_cliente: "Pedro Prueba", hace_min: 90, estado_confirmacion: "confirmado",
      app: "Voltra OS", lineas: [{ handle: TIRAS, cantidad: 1, total: 79000 }], envio: 33000, ciudad: "Asunción", direccion: "Avda. Inventada 456",
    }],
    pedido_chat_creado: 1080,
    pasos: [`Quiero factura, Pedro Prueba ${RUC_PRUEBA}`],
    checks: [
      { paso: 0, tipo: "herramienta", nombre: "guardar_factura" },
      { paso: 0, tipo: "escritura", regex: new RegExp(`actualizarAtributos.*${RUC_PRUEBA}`), desc: "RUC en los atributos del pedido" },
      { tipo: "derivado", negar: true },
      { paso: 0, tipo: "responde" },
    ],
  },
  {
    nombre: "no_estoy_en_casa",
    descripcion: "Anuncio del raspador; toca 'Quiero 1' y después dice que no está en casa y pasa los datos mañana (línea base, sin chequeo estricto).",
    cliente: { nombre: "Carlos Prueba", telefono: "+595981000106" },
    anuncio: RASPADOR,
    pasos: ["Hola", "boton:Quiero 1", "No estoy en casa ahora, mañana te paso", { texto: "[seguimiento 1]", origen: "seguimiento", espera_min: 20 * 60 }],
    checks: [
      { paso: 2, tipo: "responde", suave: true },
      { paso: 3, tipo: "responde", suave: true, desc: "el seguimiento sale" },
      { paso: 2, tipo: "derivado", negar: true, suave: true },
      { tipo: "montos_catalogo", suave: true },
    ],
  },
  {
    nombre: "cuanto_2_simple",
    descripcion: "Anuncio de tiras; '¿Cuánto sale 2?' → 158.000 con envío gratis (números del catálogo).",
    cliente: { nombre: "Sofía Prueba", telefono: "+595981000107" },
    anuncio: TIRAS,
    pasos: ["Hola", "¿Cuánto sale 2?"],
    checks: [
      { paso: 1, tipo: "responde" },
      { paso: 1, tipo: "fn", desc: "dice el total x2 del catálogo (158.000)", fn: (r) => {
        const esperado = r.precio(TIRAS, 2) + r.envio;
        const txt = r.textoPaso(1);
        const fmt = esperado.toLocaleString("de-DE");
        return (txt.includes(fmt) || txt.includes(String(esperado))) && esperado === 158000 ? true : `esperado ${fmt} (catálogo) / 158.000; dijo: ${txt.slice(0, 160)}`;
      } },
      { paso: 1, tipo: "texto", regex: /env[ií]o (te sale )?gratis|sin (costo de )?env[ií]o|gratis/i, desc: "menciona envío gratis" },
      { tipo: "montos_catalogo" },
    ],
  },
  {
    nombre: "inhalador",
    descripcion: "Pregunta por inhalador nasal (todavía no se vende): 'llega en unos días, te aviso', sin inventar precio.",
    cliente: { nombre: "Diego Prueba", telefono: "+595981000108" },
    pasos: ["¿Tienen inhalador nasal?"],
    checks: [
      { paso: 0, tipo: "responde" },
      { paso: 0, tipo: "texto", regex: /llega|unos d[ií]as|pronto|todav[ií]a no|a[uú]n no/i, desc: "dice que llega / todavía no" },
      { paso: 0, tipo: "texto", regex: /avis/i, desc: "ofrece avisar" },
      { paso: 0, tipo: "fn", desc: "no inventa precio del inhalador", fn: (r) => {
        const txt = r.textoPaso(0);
        return !/inhalador[^.\n]{0,60}\d{2,3}\.\d{3}/i.test(txt) || `precio cerca de 'inhalador': ${txt.slice(0, 160)}`;
      } },
      { tipo: "montos_catalogo" },
      { tipo: "derivado", negar: true },
    ],
  },
  // ─── 20-10 · Ubicación sin pin (encargo prompts/whatsapp-ubicacion-sin-pin-20-10.md) ───
  {
    nombre: "sinpin_quiero1_ciudad_calle",
    descripcion: "Tiras: 'Quiero 1' → el bot pide nombre + ciudad + calle o barrio (sin 'pin', en texto) → los manda → resumen → Confirmo → pedido con SIN_PIN.",
    cliente: { nombre: "Ana Prueba", telefono: "+595981000201" },
    anuncio: TIRAS,
    pasos: ["Hola", "boton:Quiero 1", "Ana Prueba, Luque, barrio San Antonio, calle Las Palmas", "boton:Confirmo"],
    checks: [
      { paso: 1, tipo: "texto", regex: /ciudad/i, desc: "pide la ciudad" },
      { paso: 1, tipo: "texto", regex: /\bpin\b/i, negar: true, desc: "no dice 'pin' en el primer pedido" },
      { paso: 1, tipo: "herramienta", nombre: "pedir_ubicacion", negar: true, desc: "no manda el botón de ubicación como primer paso" },
      { paso: 2, tipo: "herramienta", nombre: "crear_pedido_cod", desc: "arma el resumen con ciudad + calle" },
      { paso: 3, tipo: "escritura", regex: /SIN_PIN/, desc: "el pedido sale con la etiqueta SIN_PIN", suave: true },
      { tipo: "derivado", negar: true },
    ],
  },
  {
    nombre: "sinpin_manana_te_paso",
    descripcion: "Raspador: 'Quiero 1' → 'no estoy en casa, mañana te paso' → el bot NO posterga: pide ciudad y calle → los manda → resumen.",
    cliente: { nombre: "Pedro Prueba", telefono: "+595981000202" },
    anuncio: RASPADOR,
    pasos: ["Hola", "boton:Quiero 1", "No estoy en casa ahora, mañana te paso mi ubicación", "Pedro Prueba, Capiatá, Mcal López casi Ruta 1"],
    checks: [
      { paso: 2, tipo: "texto", regex: /(no hace falta|ciudad|barrio|calle)/i, desc: "no posterga: pide ciudad y calle" },
      { paso: 2, tipo: "texto", regex: /te escribo/i, negar: true, desc: "no promete escribirle otro día" },
      { paso: 3, tipo: "herramienta", nombre: "crear_pedido_cod", desc: "arma el pedido en la misma charla" },
      { tipo: "derivado", negar: true },
    ],
  },
  {
    nombre: "sinpin_solo_ciudad",
    descripcion: "Tiras: 'Quiero 1' → manda solo la ciudad → el bot pide UNA vez la calle o barrio → 'no sé' → resumen con ubicación pendiente.",
    cliente: { nombre: "María Prueba", telefono: "+595981000203" },
    anuncio: TIRAS,
    pasos: ["Hola", "boton:Quiero 1", "María Prueba, de Luque", "No sé bien la calle, el repartidor que me llame", "boton:Confirmo"],
    checks: [
      { paso: 2, tipo: "texto", regex: /(calle|barrio)/i, desc: "pide la calle o el barrio una vez" },
      { paso: 3, tipo: "herramienta", nombre: "crear_pedido_cod", desc: "arma el resumen igual" },
      { paso: 3, tipo: "texto", regex: /(ubicaci[oó]n pendiente|Luque)/i, desc: "resumen con la ciudad (ubicación pendiente)" },
      { paso: 4, tipo: "escritura", regex: /UBICACION_PENDIENTE/, desc: "el pedido sale con UBICACION_PENDIENTE", suave: true },
      { tipo: "derivado", negar: true },
    ],
  },
  // ─── 21-10 · Oferta 2 productos distintos (interruptor prendido solo en la simulación) ───
  {
    nombre: "dos_distintos_deboh",
    descripcion: "Caso Deboh: pregunta por el ejercitador y el parche y '¿y si quiero 1 de cada?' → 158.000 con envío gratis → arma el pedido con OFERTA_2_DISTINTOS.",
    cliente: { nombre: "Debora Prueba", telefono: "+595981000301" },
    anuncio: EJERCITADOR,
    config: { vendedor: { oferta_2_distintos: true } },
    pasos: ["Hola", "¿Cuánto sale el ejercitador? ¿Y el parche de boca?", "¿Y si quiero 1 de cada? ¿Igual me sale gratis el envío?", "Sí, dale. Debora Prueba, Ciudad del Este, barrio Boquerón, calle Itá", "boton:Confirmo"],
    checks: [
      { paso: 2, tipo: "texto", regex: /158\.000/, desc: "dice 158.000 por los 2 distintos" },
      { paso: 2, tipo: "texto", regex: /191\.000|se paga aparte/i, negar: true, desc: "no cobra el envío aparte" },
      { paso: 3, tipo: "herramienta", nombre: "crear_pedido_cod", desc: "arma el resumen con los 2" },
      { paso: 4, tipo: "escritura", regex: /OFERTA_2_DISTINTOS/, desc: "el pedido sale con OFERTA_2_DISTINTOS" },
      { tipo: "montos_catalogo" },
      { tipo: "derivado", negar: true },
    ],
  },
  {
    nombre: "dos_distintos_ofrece_pareja",
    descripcion: "Tiras: 'Quiero 1' → al pedir los datos ofrece UNA vez sumar el parche (pareja de sueño) por 158.000 con envío gratis.",
    cliente: { nombre: "Laura Prueba", telefono: "+595981000302" },
    anuncio: TIRAS,
    config: { vendedor: { oferta_2_distintos: true } },
    pasos: ["Hola", "boton:Quiero 1", "Laura Prueba, Luque, barrio San Antonio"],
    checks: [
      { paso: 1, tipo: "texto", regex: /(parche|158\.000)/i, desc: "ofrece sumar otro producto o el ×2", suave: true },
      { paso: 2, tipo: "herramienta", nombre: "crear_pedido_cod" },
      { tipo: "montos_catalogo" },
    ],
  },
  {
    nombre: "dos_distintos_apagada",
    descripcion: "Con la oferta APAGADA (como hoy): '1 de cada' → envío aparte (sin inventar el 158.000 para 2 distintos).",
    cliente: { nombre: "Rita Prueba", telefono: "+595981000303" },
    anuncio: EJERCITADOR,
    config: { vendedor: { oferta_2_distintos: false } },
    pasos: ["Hola", "¿Y si quiero 1 ejercitador y 1 parche? ¿Me sale gratis el envío?"],
    checks: [
      { paso: 1, tipo: "responde" },
      { tipo: "montos_catalogo" },
      { tipo: "derivado", negar: true },
    ],
  },
  // ─── 21-10 · v37: gancho según el anuncio, retiro y colores ───
  {
    nombre: "v37_gancho_anuncio_jawflex",
    descripcion: "Anuncio del ejercitador ('lo masticás como un chicle, 15 minutos al día. 3 niveles') → el primer mensaje retoma esa promesa.",
    cliente: { nombre: "Marcos Prueba", telefono: "+595981000401" },
    anuncio: EJERCITADOR,
    anuncio_texto: "Entrená tu mandíbula: lo masticás como un chicle, 15 minutos al día. 3 niveles. Escribinos por WhatsApp y te lo mandamos: 79.000",
    pasos: ["¡Hola! Quiero más información"],
    checks: [
      { paso: 0, tipo: "texto", regex: /(chicle|mastic|15 minutos)/i, desc: "el gancho retoma lo que decía el anuncio" },
      { paso: 0, tipo: "herramienta", nombre: "primer_turno" },
      { tipo: "texto", regex: /%/, negar: true, desc: "sin porcentajes" },
    ],
  },
  {
    nombre: "v37_retiro_cde",
    descripcion: "Pack: '¿dónde están? quiero pasar a buscar' → dirección, horario y pregunta qué día y hora; arma el pedido con retiro.",
    cliente: { nombre: "Gustavo Prueba", telefono: "+595981000402" },
    anuncio: "pack-gudair-tiras-nasales-parches-bucales",
    ahora: "2026-10-21T13:00:00Z",
    config: { retiro: "Área 1, Avenida Los Lapachos, Ciudad del Este · lunes a viernes de 8:00 a 16:00 (sábados y domingos no hay retiro) · antes de pasar, que le escriba a Enrique al 0990 000 000" },
    pasos: ["Hola", "¿Dónde están ubicados? Soy de CDE y quiero pasar a buscar", "Mañana a las 10, me llamo Gustavo Prueba"],
    checks: [
      { paso: 1, tipo: "texto", regex: /Lapachos/i, desc: "da la dirección" },
      { paso: 1, tipo: "texto", regex: /(8:00|8 a 16|16:00)/i, desc: "da el horario" },
      { paso: 2, tipo: "herramienta", nombre: "crear_pedido_cod", desc: "arma el pedido para retirar", suave: true },
      { tipo: "derivado", negar: true },
    ],
  },
  {
    nombre: "v37_colores_jawflex",
    descripcion: "Ejercitador: 'Quiero 1' → no pregunta el color → '¿en qué colores viene?' → blanco, gris o negro → elige negro → va en el pedido.",
    cliente: { nombre: "Lucas Prueba", telefono: "+595981000403" },
    anuncio: EJERCITADOR,
    pasos: ["Hola", "boton:Quiero 1", "¿En qué colores viene?", "Negro. Lucas Prueba, Luque, barrio Itapuamí", "boton:Confirmo"],
    checks: [
      { paso: 1, tipo: "texto", regex: /color/i, negar: true, desc: "no pregunta el color al pedir los datos" },
      { paso: 2, tipo: "texto", regex: /blanco.*gris.*negro|gris.*negro/i, desc: "responde blanco, gris o negro" },
      { paso: 4, tipo: "escritura", regex: /Color: negro/i, desc: "el color va en la nota del pedido", suave: true },
      { tipo: "derivado", negar: true },
    ],
  },
  // ─── 21-10 · v38: "Quiero" escrito, seguimiento que no interrumpe una compra, resumen con pin ───
  {
    nombre: "v38_quiero_escrito_al_abrir",
    descripcion: "Caso real 21-10 ('1877'): abre el chat del anuncio del raspador y escribe 'Quiero' al segundo → el bot pide nombre, ciudad y calle o barrio con el precio en una línea (sin gancho ni botones de bienvenida).",
    cliente: { nombre: "Laura Prueba", telefono: "+595981000501" },
    anuncio: RASPADOR,
    pasos: [{ texto: "¡Hola! Quiero más información", agrupar: true }, "Quiero"],
    checks: [
      { paso: 1, tipo: "herramienta", nombre: "primer_turno", negar: true, desc: "no manda el primer turno (gancho + botones)" },
      { paso: 1, tipo: "texto", regex: /nombre/i, desc: "pide el nombre" },
      { paso: 1, tipo: "texto", regex: /ciudad/i, desc: "pide la ciudad" },
      { paso: 1, tipo: "texto", regex: /(calle|barrio)/i, desc: "pide calle o barrio" },
      { paso: 1, tipo: "texto", regex: /79\.000/, desc: "el precio en una línea" },
      { paso: 1, tipo: "texto", regex: /\bpin\b/i, negar: true, desc: "no dice 'pin'" },
      { tipo: "montos_catalogo" },
      { tipo: "derivado", negar: true },
    ],
  },
  {
    nombre: "v38_compra_en_curso_sin_seguimiento",
    descripcion: "Caso real 21-10 ('9168'): pide 2 tiras, manda nombre y pin, pregunta por otra cosa, resumen con 'la ubicación que mandaste'; quiere hoy, viaja mañana; a los 93 min el seguimiento NO sale (compra a medio armar); vuelve y dice que alguien recibe → resumen → Confirmo → pedido.",
    cliente: { nombre: "Ricardo Prueba", telefono: "+595981000502" },
    anuncio: TIRAS,
    ahora: "2026-10-21T14:22:00Z",
    mapa: { calle: null, ciudad: "Asunción" },
    pasos: [
      "¡Hola! Quiero más información",
      "boton:Quiero 1",
      "Mándame 2",
      "Ricardo Prueba",
      "ubicacion:-25.2900,-57.6000",
      "No disponen riñonera para correr?",
      "Quiero que me llegue hoy",
      "Mañana voy a viajar",
      { texto: "[seguimiento 1]", origen: "seguimiento", espera_min: 93, decidir: true },
      { texto: "Sí, mi señora lo recibe mañana en casa", espera_min: 60 },
      "boton:Confirmo",
    ],
    checks: [
      { tipo: "texto", regex: /pin de ubicaci/i, negar: true, desc: "el cliente nunca ve 'Pin de ubicación'" },
      { tipo: "texto", regex: /ubicaci[oó]n que mandaste/i, desc: "el resumen dice 'la ubicación que mandaste'" },
      { paso: 8, tipo: "fn", fn: (r) => r.pasos[8].salidas.length === 0 && /seguimiento-chat:/.test(String(r.pasos[8].resultado.motivo)) ? true : `salió algo: ${JSON.stringify(r.pasos[8].resultado)}`, desc: "a los 93 min no sale ningún seguimiento ni video" },
      { paso: -1, tipo: "herramienta", nombre: "crear_pedido_cod", desc: "con el Confirmo crea el pedido" },
      { paso: -1, tipo: "escritura", regex: /158000|158\.000/, desc: "2 tiras a 158.000", suave: true },
      { tipo: "montos_catalogo" },
      { tipo: "derivado", negar: true },
    ],
  },
  {
    nombre: "v38_silencio_sin_datos_si_recibe_seguimiento",
    descripcion: "Control: ve el precio y se calla 3 h sin dar datos → el seguimiento 1 SÍ sale (el freno es solo para compras en curso).",
    cliente: { nombre: "Sofía Prueba", telefono: "+595981000503" },
    anuncio: RASPADOR,
    ahora: "2026-10-21T15:30:00Z",
    pasos: ["¡Hola! Quiero más información", { texto: "[seguimiento 1]", origen: "seguimiento", espera_min: 180, decidir: true }],
    checks: [
      { paso: 1, tipo: "responde", desc: "el seguimiento sale" },
      { tipo: "derivado", negar: true },
    ],
  },
  {
    nombre: "v38_datos_a_medias_3h_contexto",
    descripcion: "Pide 2 tiras, manda solo el nombre y se calla. A las 3 h: UN mensaje con contexto (nombra lo que tiene y lo que falta), solo texto, sin video ni botones. 5 h después sigue callado: nada más.",
    cliente: { nombre: "Marta Prueba", telefono: "+595981000504" },
    anuncio: TIRAS,
    ahora: "2026-10-21T15:00:00Z",
    pasos: [
      "¡Hola! Quiero más información",
      "boton:2 con envío gratis",
      "Marta Prueba",
      { texto: "[seguimiento 1]", origen: "seguimiento", espera_min: 185, decidir: true },
      { texto: "[seguimiento 2]", origen: "seguimiento", espera_min: 300, decidir: true },
    ],
    checks: [
      { paso: 3, tipo: "responde", desc: "a las 3 h sale el mensaje con contexto" },
      { paso: 3, tipo: "fn", fn: (r) => r.pasos[3].alVendedor === "[seguimiento con datos]" || `entrada: ${r.pasos[3].alVendedor}`, desc: "es el recontacto con contexto" },
      { paso: 3, tipo: "fn", fn: (r) => r.pasos[3].salidas.length === 1 && r.pasos[3].salidas[0].tipo === "texto" || `salidas: ${JSON.stringify(r.pasos[3].salidas.map((x: { tipo: string }) => x.tipo))}`, desc: "UN solo mensaje de texto (sin video, foto ni botones)" },
      { paso: 3, tipo: "texto", regex: /(ciudad|calle|barrio)/i, desc: "nombra lo que falta" },
      { paso: 3, tipo: "texto", regex: /(tiras|2)/i, desc: "nombra lo que ya tiene (las 2 tiras)", suave: true },
      { paso: 4, tipo: "fn", fn: (r) => r.pasos[4].salidas.length === 0 || "salió un segundo recontacto", desc: "después, nada más" },
      { tipo: "montos_catalogo" },
      { tipo: "derivado", negar: true },
    ],
  },
  {
    nombre: "boton_2_envio_gratis",
    descripcion: "Toca '2 con envío gratis' en el primer turno → pide los datos (y a lo sumo la línea de 3) con montos del catálogo, sin derivar.",
    cliente: { nombre: "Nora Prueba", telefono: "+595981000505" },
    anuncio: TIRAS,
    ahora: "2026-10-21T15:00:00Z",
    pasos: ["¡Hola! Quiero más información", "boton:2 con envío gratis"],
    checks: [
      { paso: 1, tipo: "texto", regex: /(ciudad|nombre)/i, desc: "pide los datos" },
      { tipo: "montos_catalogo" },
      { tipo: "derivado", negar: true },
    ],
  },
  {
    nombre: "reactivar_cancelado",
    descripcion: "Canceló el pedido del formulario; le escribimos para reactivarlo; contesta 'Sí, dale' → resumen con los mismos datos (sin volver a pedirlos) → Confirmo → pedido nuevo.",
    cliente: { nombre: "Juan Prueba", telefono: "+595981000506" },
    pasos: [
      "marca:[plantilla voltra_confirmacion_pedido_v4] #1099 | Juan | 2 Raspador de Lengua: aliento más limpio | 158.000 | Calle Inventada 281 casi San José | Concepcion | en 2 a 5 días hábiles\n[el cliente tocó Cancelar pedido y Cancelar igual: el pedido #1099 quedó CANCELADO]\n[nosotros le escribimos: «Buen día Juan 🙌 Vimos que cancelaste los 2 raspadores. ¿Fue por algo que podamos resolver? Si querés lo reactivamos tal cual: 158.000 con envío gratis a Concepción y pagás recién cuando lo tenés en la mano.»]|Sí, dale",
      "boton:Confirmo",
    ],
    checks: [
      { paso: 0, tipo: "herramienta", nombre: "crear_pedido_cod", desc: "arma el resumen con los datos que ya tiene" },
      { paso: 0, tipo: "texto", regex: /Pasame tu nombre/i, negar: true, desc: "no vuelve a pedir los datos" },
      { paso: -1, tipo: "escritura", regex: /158000|158\.000/, desc: "158.000", suave: true },
      { tipo: "montos_catalogo" },
      { tipo: "derivado", negar: true },
    ],
  },
];
