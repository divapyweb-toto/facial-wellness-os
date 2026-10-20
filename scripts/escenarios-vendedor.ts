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
export type Paso = string | { texto: string; origen?: "cliente" | "seguimiento"; espera_min?: number };

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
];
