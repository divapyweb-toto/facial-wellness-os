// _shared/vendedor/herramientas.ts · Dueño: G1 (ola 2)
// Herramientas del vendedor con IA: definiciones (JSON Schema para la Messages API) + ejecutores.
// Los ejecutores no tocan red ni base directamente: todo entra por `DepsHerramientas` (io.ts en producción,
// dobles en los tests). Reglas duras que NO dependen del modelo:
//   - Los precios y totales salen del catálogo de Shopify (+ ofertas por cantidad y envío de config_wa); el
//     modelo nunca calcula.
//   - crear_pedido_cod en dos pasos: resumen con botones (confirmar=false) y creación (confirmar=true) solo con
//     un sí claro del cliente en el mensaje actual o el botón Confirmar; se usan los datos del resumen guardado,
//     no lo que el modelo reescriba.
//   - Todo texto que el modelo pone dentro de un interactivo pasa por el mismo filtro que su respuesta.
import { avisoParaCourier, datosCourierDesdeRaw } from "../texto_courier.ts";
import { quitarPromesaRecontacto } from "./filtro_salida.ts";
import { extrasVendedor } from "./config.ts";
import { productoPorPalabras } from "../anuncios.ts";
import { herramientasPedidosWeb } from "./pedidos_web.ts";
import { ejecutoresEmailFactura, herramientasEmailFactura } from "./email_factura.ts";
import { digitoVerificadorRuc, normalizarRuc } from "../facturacion.ts";
import type { Herramienta } from "../claude.ts";
import {
  botonesPermisoOfertas,
  botonesRespuesta,
  TEXTO_PERMISO_OFERTAS,
  botonesSiNo,
  listaVertical,
  flowFormulario,
  pedirContacto,
  ubicacionRequest,
} from "../wa_interactivos.ts";
import { enlaceWaMe, escaparHtml, formatoChatNecesitaEnrique, formatoPedidoNuevo } from "../telegram_formato.ts";
import { botonEnlace } from "./interactivos.ts";
import { NECESIDADES, normalizarPerfil, PERFILES } from "./perfil.ts";
import { pausaBurbujaMs } from "./ritmo.ts";
import { diaEntrega } from "../plazo_zona.ts";
import type { CtxTurno, DatosPedidoChat, DepsHerramientas, LineaPedido, PedidoChat, ProductoShopify } from "./tipos.ts";

// ---------- utilidades puras ----------

export function gs(n: number): string {
  return Math.round(n).toString().replace(/\B(?=(\d{3})+(?!\d))/g, ".");
}

function normalizar(s: string): string {
  return s.normalize("NFD").replace(/\p{M}/gu, "").toLowerCase().replace(/[^a-z0-9ñ\s]/g, " ").replace(/\s+/g, " ").trim();
}

/** "si dale", "ok", "mandame katu"… (misma regla que wa-webhook: todas las palabras en la lista). */
// 08-10: "Dale amigo" y "Ya confirmé amigo" no contaban como sí y se perdió un pedido. Palabras que confirman solas
// y relleno que acompaña sin cambiar el sentido. "no", "después", "pero" no están: siguen sin contar.
const CONFIRMAN = new Set(["confirmo", "confirme", "confirmado", "confirmada", "listo", "perfecto", "joya", "va", "vale", "bueno", "sii", "siii", "sip"]);
const RELLENO = new Set(["amigo", "amiga", "amor", "che", "nomas", "por", "favor", "porfa", "gracias", "ya", "claro", "obvio", "de", "una", "todo", "bien", "esta", "eso", "asi", "el", "pedido", "senor", "senora", "hermano", "bro", "nde", "lo", "que", "si"]);

export function esAceptacion(texto: string, aceptaciones: string[]): boolean {
  const n = normalizar(texto);
  if (!n) return false;
  const frases = new Set(aceptaciones.map(normalizar).filter(Boolean));
  if (frases.has(n)) return true;
  const palabras = new Set([...frases].flatMap((f) => f.split(" ")));
  // "siiii", "sii", "okk", "daleee": letras estiradas cuentan como la palabra.
  const ws = n.split(" ").map((w) => /^si+$/.test(w) ? "si" : /^ok+$/.test(w) ? "ok" : /^dale+$/.test(w) ? "dale" : w);
  if (ws.every((w) => palabras.has(w))) return true;
  return ws.length <= 6 && ws.every((w) => palabras.has(w) || CONFIRMAN.has(w) || RELLENO.has(w))
    && ws.some((w) => palabras.has(w) || CONFIRMAN.has(w));
}

function texto(t: Record<string, string>, clave: string, porDefecto: string, vars: Record<string, string> = {}): string {
  let s = (typeof t[clave] === "string" && t[clave].trim()) ? t[clave] : porDefecto;
  for (const [k, v] of Object.entries(vars)) s = s.replaceAll(`{${k}}`, v);
  return s.replace(/\s+([,.])/g, "$1").replace(/ {2,}/g, " ").trim();
}

export const TEXTOS_DEFAULT: Record<string, string> = {
  resumen: "Te resumo: {lineas}. Envío Gs {envio}. Total Gs {total}, pagás al recibir. Lo entregamos en {direccion}, {ciudad}.",
  resumen_envio_gratis: "Te resumo: {lineas}, envío gratis. Total Gs {total}, pagás al recibir. Lo entregamos en {direccion}, {ciudad}.",
  resumen_retiro: "Te resumo: {lineas}. Sin costo de envío: lo retirás en nuestra oficina en Ciudad del Este (coordinamos día y hora por acá). Total Gs {total}, pagás al retirar.",
  boton_confirmar: "Confirmo",
  boton_corregir: "Corregir",
  pedido_creado: "Listo {nombre}, quedó confirmado tu pedido {pedido} 🙌 Te avisamos por acá cuando salga y pagás al recibir.",
  derivacion: "Te paso con Enrique para que lo vea personalmente. Tocá el botón y le llega tu caso ya escrito.",
  derivacion_sin_boton: "Le paso tu caso a Enrique y te escribe por acá apenas lo vea.",
  // Cuando el texto del modelo ya dice que lo pasa con Enrique, solo se agrega la llamada a la acción.
  derivacion_cta: "Tocá el botón y le llega tu caso ya escrito.",
  derivacion_cta_sin_boton: "Enrique te escribe por acá apenas lo vea.",
  // Derivación por salud: va primero si el texto del modelo no manda ya al médico.
  derivacion_salud: "Eso te conviene consultarlo con tu médico.",
  boton_enrique: "Hablar con Enrique",
  mensaje_a_enrique: "Hola Enrique, soy {nombre}. {resumen}",
  formulario_titulo: "Datos para tu pedido",
  formulario_cta: "Completar datos",
};

// ---------- definiciones ----------

const MOTIVOS = [
  "salud", "reclamo", "devolucion", "enojo", "pide_persona", "mayorista", "direccion_dudosa",
  "audio_confuso", "sin_avance", "falla_herramienta", "otro",
] as const;
export type MotivoDerivacion = typeof MOTIVOS[number] | "falla_ia" | "tope_gasto" | "tope_turnos" | "filtro";

/**
 * Derivación "suave" (motivos de venta): el cliente recibe el botón y Enrique el aviso, pero el chat sigue en
 * 'ia'. El botón lleva al WhatsApp personal de Enrique, así que en el número de la tienda nadie atendería un
 * chat en 'humano': si el cliente vuelve a escribir acá (p. ej. "quiero 1" después de preguntar por 10), el
 * vendedor sigue. Reclamo, salud, devolución, enojo, otro y los motivos del sistema pasan a 'humano'.
 */
export const MOTIVOS_VENTA: ReadonlySet<string> = new Set([
  "mayorista", "pide_persona", "sin_avance", "falla_herramienta", "direccion_dudosa", "audio_confuso",
  // Fallas del propio sistema: si el cliente vuelve a escribir, se reintenta en vez de dejarlo sin respuesta.
  "filtro", "falla_ia",
]);
export const esDerivacionDeVenta = (motivo: string): boolean => MOTIVOS_VENTA.has(motivo);

const MOTIVO_LEGIBLE: Record<string, string> = {
  salud: "Consulta de salud",
  reclamo: "Reclamo (paso 3 o más)",
  devolucion: "Pide devolución",
  enojo: "Cliente enojado",
  pide_persona: "Pide hablar con una persona",
  mayorista: "Compra mayorista",
  direccion_dudosa: "Dirección dudosa",
  audio_confuso: "Audio que no se entiende",
  sin_avance: "3 mensajes sin avance",
  falla_herramienta: "Falló una herramienta",
  otro: "Otro",
  falla_ia: "La IA no respondió (API caída o error)",
  tope_gasto: "Se llegó al tope mensual de gasto de IA",
  tope_turnos: "La conversación pasó el límite de turnos de IA",
  filtro: "La respuesta de la IA no pasó el filtro dos veces",
};

// 07-10: lo que el cliente le manda a Enrique con el botón va en voz del cliente. El resumen interno
// (y los motivos del sistema: tope de turnos, filtro, IA caída) va solo al aviso de Telegram.
const MENSAJE_CLIENTE: Record<string, string> = {
  mayorista: "Quiero consultar precio por cantidad.",
  salud: "Tengo una consulta antes de comprar.",
  reclamo: "Tengo un problema con mi pedido.",
  devolucion: "Tengo un problema con mi pedido.",
  enojo: "Tengo un problema con mi pedido.",
  pide_persona: "Quiero hablar con vos.",
  direccion_dudosa: "Quiero coordinar la dirección de entrega.",
};
const MENSAJE_CLIENTE_DEFAULT = "Quiero hacer una consulta.";

/** 21-10 (Enrique, 19-10): productos que entran en la oferta de 2 distintos. El pack queda afuera (ya es un combo). */
export const HANDLES_2_DISTINTOS = new Set([
  "raspador-de-lengua-de-acero-inoxidable", "tiras-nasales-gudair-30-unidades", "parches-bucales-gudair-30-unidades",
  "ejercitador-de-mandibula-3-niveles", "botella-flexible-gudair-500-ml",
]);
/** Pareja sugerida por línea: sueño (tiras ↔ parches), boca (raspador), gym (ejercitador ↔ botella). */
export const PAREJA_2_DISTINTOS: Record<string, string> = {
  "tiras-nasales-gudair-30-unidades": "parches-bucales-gudair-30-unidades",
  "parches-bucales-gudair-30-unidades": "tiras-nasales-gudair-30-unidades",
  "ejercitador-de-mandibula-3-niveles": "botella-flexible-gudair-500-ml",
  "botella-flexible-gudair-500-ml": "ejercitador-de-mandibula-3-niveles",
  "raspador-de-lengua-de-acero-inoxidable": "tiras-nasales-gudair-30-unidades",
};
/** Texto y total de la oferta de 2 distintos para consultar_catalogo (total = 2 productos de la lista a su precio, envío 0). */
export function oferta2DistintosInfo(items: ItemCatalogo[]) {
  const disp = items.filter((i) => familia2Distintos(i.handle) && i.disponible);
  const precio = disp.length ? Math.min(...disp.map((i) => i.precio)) : 0;
  return {
    productos: disp.map((i) => i.handle),
    total: precio * 2,
    total_texto: gs(precio * 2),
    texto: `Llevando 2 productos distintos te salen ${gs(precio * 2)} los 2, con envío gratis`,
    pareja_sugerida: PAREJA_2_DISTINTOS,
    nota: "Solo 1 de cada uno de 2 productos distintos (el pack no entra). Ofrecelo UNA vez: cuando pide 1 unidad o pregunta por otro producto. Armalo con crear_pedido_cod con los 2 items (cantidad 1 cada uno): el sistema pone el precio y el envío gratis.",
  };
}

/** ¿Es la oferta de 2 distintos? Exactamente 2 productos distintos, 1 de cada, los dos de la lista. */
export function esOferta2Distintos(lineas: Array<{ handle: string; cantidad: number }>, activa: boolean): boolean {
  if (!activa || lineas.length !== 2 || !lineas.every((l) => l.cantidad === 1)) return false;
  const [a, b] = lineas.map((l) => familia2Distintos(l.handle));
  return !!a && !!b && a !== b;
}
/** Producto de la oferta (por familia, no por el handle exacto); null si no entra (pack u otro). */
export function familia2Distintos(handle: string): string | null {
  const h = productoPorPalabras(handle.replace(/-/g, " "));
  return h && HANDLES_2_DISTINTOS.has(h) ? h : null;
}

/** 20-10: address1 de un pedido que salió solo con la ciudad (pedidos-trabados lo toma como dirección NO utilizable). */
export const DIRECCION_PENDIENTE = "Sin calle (ubicación pendiente)";

/** 19-10: el inhalador todavía no está a la venta (falta DINAVISA y precio). */
export const NOTA_INHALADOR =
  "El inhalador todavía no está a la venta: decí \"Llega en unos días, te aviso\" y, si le sirve, ofrecé las tiras o el pack. No des precio ni características del inhalador.";

/**
 * 19-10 (paquete 1): consulta de salud SIN señales de alerta → no se deriva; el bot responde con este texto seguro
 * (el del 19-10, caso rinitis) y sigue vendiendo. Sin "tratamiento", "cura" ni "elimina" (palabras prohibidas).
 */
export const TEXTO_SALUD_SEGURO =
  "No es un remedio: es una ayuda para [beneficio simple del producto]. Si tenés indicaciones de tu médico, seguilas igual.";

/** Señales de alerta: con estas, salud SÍ se deriva (y se recomienda el médico). */
const RE_ALERTA_SALUD = /apnea|deja(?:s|r)? de respirar|pausas? al respirar|ahog|asfixi|embaraz|operaci|cirug|menor de (?:edad|18)|hij[oa] de \d|nene|beb[eé]|ni[nñ]o|dolor|sangr|fiebre|tabique|atm\b|articulaci|bruxismo|brackets|ortodoncia|medicaci|medicament|pastilla|remedio que tomo|presi[oó]n alta|coraz[oó]n/i;

export const HERRAMIENTAS: Herramienta[] = [
  // 19-10 (paquete 1): buscar_pedido, modificar_pedido y guardar_factura (pedidos_web.ts).
  ...herramientasPedidosWeb().map((h) => h.definicion),
  // 29-10: guardar_email_factura (email_factura.ts).
  ...herramientasEmailFactura().map((h) => h.definicion),
  {
    name: "consultar_catalogo",
    description:
      "Precios, ofertas por cantidad, disponibilidad, envío y totales reales desde Shopify. Usala antes de dar cualquier precio. Los totales ya incluyen el envío: no hagas cuentas.",
    input_schema: {
      type: "object",
      properties: { busqueda: { type: "string", description: "Producto que busca el cliente (opcional), por ejemplo 'tiras'." } },
    },
  },
  {
    name: "estado_pedido",
    description: "Estado de los últimos pedidos de este cliente (confirmación y envío según el último reporte del courier).",
    input_schema: { type: "object", properties: {} },
  },
  {
    name: "crear_pedido_cod",
    description:
      "Pedido contra entrega. confirmar=false: valida los datos, calcula el total y le muestra al cliente el resumen con botones Confirmar/Corregir (no escribas nada después). confirmar=true: SOLO después de un sí claro o del botón Confirmar; crea el pedido en Shopify con los datos del último resumen y devuelve el texto para responder.",
    input_schema: {
      type: "object",
      properties: {
        confirmar: { type: "boolean" },
        nombre: { type: "string", description: "Nombre y apellido" },
        ciudad: { type: "string" },
        direccion: { type: "string", description: "Calle, número o barrio" },
        referencia: { type: "string", description: "Referencia para el courier (opcional)" },
        ubicacion: { type: "string", description: "Pin de ubicación si lo mandó, lat,long (opcional)" },
        fecha_entrega: { type: "string", description: "Solo si el cliente pidió un día futuro: \"YYYY-MM-DD\". No puede ser antes del plazo (el sistema lo valida)." },
        franja_entrega: { type: "string", description: "Franja horaria que pidió, corta (\"antes de las 12\", \"de tarde\"). Opcional." },
        calle_de_pin: { type: "boolean", description: "true si la calle y la ciudad salieron del pin y el cliente tocó \"Sí, es ahí\"" },
        color: { type: "string", description: "Solo si el cliente ELIGIÓ un color (ej. ejercitador negro). No lo preguntes vos." },
        ubicacion_pendiente: { type: "boolean", description: "true si solo dio la ciudad y, pedida una vez, no tiene o no mandó la calle o el barrio: el pedido sale igual y antes del despacho se le pide el dato." },
        items: {
          type: "array",
          items: {
            type: "object",
            properties: { handle: { type: "string" }, cantidad: { type: "integer", minimum: 1 } },
            required: ["handle", "cantidad"],
          },
        },
        retiro_oficina: {
          type: "boolean",
          description: "true si retira en nuestra oficina de Ciudad del Este (solo clientes de CDE y alrededores): sin envío y sin dirección.",
        },
        factura: {
          type: "string",
          description: "Solo si el cliente QUIERE factura: RUC con guion y razón social, ej. \"4012344-3 Carlos Benítez\". Si no quiere o no contestó, no lo mandes.",
        },
        factura_sin_validar: {
          type: "boolean",
          description: "Solo si ya le volviste a pedir el RUC una vez y sigue sin dar: true para crear el pedido igual (Enrique lo revisa antes de facturar).",
        },
      },
      required: ["confirmar"],
    },
  },
  {
    name: "derivar_a_enrique",
    description:
      "Pasa el caso a Enrique: el cliente recibe un botón para hablarle con el resumen ya escrito y Enrique recibe el mismo resumen por Telegram. El texto que escribas junto con esta llamada va arriba del botón (en salud: \"Eso te conviene consultarlo con tu médico.\"). En este turno no escribas nada más. Si devuelve sigue_ia=true (motivos de venta: mayorista, pide_persona, sin_avance, falla_herramienta, direccion_dudosa, audio_confuso) y el cliente vuelve a escribir, seguí atendiéndolo normal.",
    input_schema: {
      type: "object",
      properties: {
        motivo: { type: "string", enum: [...MOTIVOS] },
        resumen: { type: "string", description: "Qué pasó, en 1 a 3 oraciones, para que Enrique entienda sin leer el chat." },
        shopify_order_id: { type: "integer", description: "Pedido relacionado, si hay (opcional)." },
        // 19-10 (paquete 1): las 3 líneas del recordatorio a Enrique (seguimiento-chat las lee de este input).
        quiere: { type: "string", description: "Qué quiere el cliente, en pocas palabras (opcional)." },
        datos: { type: "string", description: "Qué datos ya dio: producto, cantidad, ciudad… sin teléfono (opcional)." },
        falta: { type: "string", description: "Qué falta para resolverlo (opcional)." },
      },
      required: ["motivo", "resumen"],
    },
  },
  {
    name: "primer_turno",
    description:
      "PRIMER MENSAJE a quien viene de un anuncio (o la primera vez que se habla de un producto): manda 2 burbujas, tu gancho y el precio total calculado por el sistema con 3 botones (Quiero pedirlo / Tengo una duda / Precios por cantidad). Una sola vez por conversación. Después no escribas nada más.",
    input_schema: {
      type: "object",
      properties: {
        handle: { type: "string" },
        gancho: { type: "string", description: "El gancho del producto (1 línea, el beneficio). Sin precio ni pregunta: eso lo pone el sistema." },
      },
      required: ["handle", "gancho"],
    },
  },
  {
    name: "cierre_botones",
    description:
      "Cierre con los mismos 3 botones del primer turno (Quiero pedirlo / Tengo una duda / Precios por cantidad) debajo de tu texto. Para el [seguimiento 1] después del video, o cuando quieras que elija con un toque. Después no escribas nada más.",
    input_schema: {
      type: "object",
      properties: {
        handle: { type: "string" },
        texto: { type: "string", description: "1 o 2 líneas cortas que cierran (ej. \"Te lo armo y pagás recién cuando lo tenés en la mano\")." },
      },
      required: ["handle", "texto"],
    },
  },
  {
    name: "permiso_ofertas",
    description:
      "Cuando el cliente posterga (\"no por ahora\", \"después\", \"cuando cobre\"): tu respuesta corta va arriba y abajo el sistema le pregunta si quiere que Voltra le avise de ofertas (botones Sí / No). Una sola vez por cliente; nunca en el primer turno ni ante un no rotundo. Después no escribas nada más.",
    input_schema: { type: "object", properties: { texto: { type: "string", description: "Tu respuesta corta a la postergación (ej. \"Dale, tranqui. El lunes te escribo\")." } }, required: ["texto"] },
  },
  {
    name: "confirmar_ubicacion",
    description:
      "Cuando el cliente manda el pin ([ubicación] lat,lng): el sistema busca la calle y la ciudad en el mapa y le pregunta \"¿Es en <calle>, <ciudad>?\" con Sí, es ahí / Corregir. Si devuelve sin_calle, pedile la ciudad y la calle escritas. Después no escribas nada más.",
    input_schema: { type: "object", properties: { ubicacion: { type: "string", description: "\"lat,lng\" del pin" } }, required: ["ubicacion"] },
  },
  {
    name: "avisar_enrique",
    description:
      "Aviso urgente a Enrique por Telegram SIN pasarle el chat (vos seguís atendiendo). Solo cuando el cliente se queja de la demora y amenaza con cancelar si no le llega (motivo demora_cancela). Escribí igual tu respuesta al cliente.",
    input_schema: {
      type: "object",
      properties: {
        motivo: { type: "string", enum: ["demora_cancela"] },
        resumen: { type: "string", description: "1 oración: pedido, qué pide el cliente y para cuándo (\"#1004: si hoy no llega, cancela\")." },
      },
      required: ["motivo", "resumen"],
    },
  },
  {
    name: "programar_entrega",
    description:
      "El cliente pide que su pedido (ya creado) llegue un día futuro y/o en una franja (\"el viernes antes de las 12\"). Guarda la fecha en el pedido: sale en el día, a la transportadora se le pide esa fecha y los avisos la usan. Si la fecha es antes de lo posible, devuelve fecha_minima: ofrecé esa. Nunca anotes el día solo como referencia.",
    input_schema: {
      type: "object",
      properties: {
        fecha: { type: "string", description: "\"YYYY-MM-DD\" (usá la fecha de AHORA para calcularla)" },
        franja: { type: "string", description: "Opcional: \"antes de las 12\", \"de tarde\"" },
      },
      required: ["fecha"],
    },
  },
  {
    name: "enviar_media",
    description: "Manda la foto o el video real de un producto (prueba concreta ante dudas o desconfianza, o el video de uso en un reclamo de uso).",
    input_schema: {
      type: "object",
      properties: {
        handle: { type: "string" },
        tipo: { type: "string", enum: ["foto", "video", "uso"] },
        texto: { type: "string", description: "Pie corto (opcional, 1 línea)." },
      },
      required: ["handle", "tipo"],
    },
  },
  {
    name: "pedir_ubicacion",
    description: "Pide los datos de entrega en UN mensaje (texto = el pedido completo: nombre, ciudad, dirección con referencia, teléfono alternativo) con el botón para mandar el pin de su casa (menos rechazos por dirección mal cargada). Después no escribas nada más.",
    input_schema: { type: "object", properties: { texto: { type: "string" } }, required: ["texto"] },
  },
  {
    name: "enviar_formulario",
    description: "Formulario dentro del chat para nombre, ciudad, dirección, referencia y cantidad en una sola pantalla. Después no escribas nada más.",
    input_schema: { type: "object", properties: { texto: { type: "string" } }, required: ["texto"] },
  },
  {
    name: "enviar_opciones",
    description: "Carrusel con ×1, ×2 y ×3 del producto, con foto, precio y botón para elegir. Usalo una sola vez por conversación. Después no escribas nada más.",
    input_schema: {
      type: "object",
      properties: { handle: { type: "string" }, texto: { type: "string" } },
      required: ["handle", "texto"],
    },
  },
  {
    name: "registrar_perfil",
    description:
      "Anota qué le pasa al cliente, cómo encararlo y qué producto y cantidad eligió, para no volver a preguntarlo en los próximos mensajes. Llamala en la MISMA respuesta en la que le escribís al cliente (no devuelve nada que tengas que esperar). Solo cuando detectás algo nuevo.",
    input_schema: {
      type: "object",
      properties: {
        necesidad: { type: "string", enum: [...NECESIDADES] },
        perfil: { type: "string", enum: [...PERFILES] },
        nota: { type: "string", description: "Dato corto útil para después, sin datos personales sensibles (máx. 120 caracteres)." },
        producto: { type: "string", description: "Producto que eligió o por el que pregunta, como figura en el catálogo (ej. \"tiras nasales\")." },
        cantidad: { type: "integer", minimum: 1, maximum: 10, description: "Cantidad que eligió." },
        recontactar_el: {
          type: "string",
          description: "Fecha YYYY-MM-DD en que el cliente dijo que cobra o que puede comprar (\"cobro el viernes\", \"el 15\"). Ese día le escribimos.",
        },
        rechazo: {
          type: "boolean",
          description: "true solo si el cliente dijo claramente que no quiere comprar (\"no me interesa\", \"no gracias\"). No le vamos a volver a escribir por nuestra cuenta.",
        },
      },
    },
  },
  {
    name: "actualizar_direccion",
    description:
      "Suma al pedido YA CREADO los datos de entrega que el cliente mandó después (número de casa, referencia, calle, ciudad). No hace falta derivar a Enrique por esto. Mandá solo lo que agregó o corrigió. " +
      "Si le pedimos la ciudad o completar la dirección y responde con la ciudad (\"Luque\", \"es en Asunción\"), mandala en ciudad.",
    input_schema: {
      type: "object",
      properties: {
        direccion: { type: "string", description: "Calle, número o barrio (solo si lo corrigió o lo agregó)" },
        ciudad: { type: "string", description: "Ciudad donde se entrega, solo el nombre (\"Luque\"), si la dio o la corrigió" },
        referencia: { type: "string", description: "Referencia para el courier: color de casa, portón, comercio cerca" },
        ubicacion: { type: "string", description: "Pin que mandó el cliente, \"lat,lng\" (de un mensaje [ubicación] o link de Maps)" },
      },
    },
  },
  {
    name: "datos_transferencia",
    description:
      "Le manda al cliente los datos de la cuenta para transferir (cuando pide alias, cuenta o quiere pagar por transferencia). Después escribí UNA línea pidiendo los datos del envío que falten y la foto del comprobante; no repitas el número de cuenta.",
    input_schema: { type: "object", properties: {} },
  },
  {
    name: "pedir_telefono",
    description: "Botón para que el cliente comparta su número con un toque (cuando el chat no tiene teléfono). Necesario antes de crear el pedido. Después no escribas nada más.",
    input_schema: { type: "object", properties: { texto: { type: "string" } }, required: ["texto"] },
  },
];

// ---------- resultado de un ejecutor ----------

export type ResultadoHerramienta = {
  resultado: Record<string, unknown>;
  esError?: boolean;
  /** Ya se le mandó un mensaje al cliente: el turno termina sin otra respuesta. */
  terminal?: boolean;
  derivado?: boolean;
  pedidoCreado?: { shopify_order_id: number; nombre: string };
};

const error = (mensaje: string, extra: Record<string, unknown> = {}): ResultadoHerramienta => ({
  resultado: { ok: false, error: mensaje, ...extra },
  esError: true,
});

// ---------- catálogo (caché de 10 min por worker) ----------

let cacheCatalogo: { estado: string; hasta: number; productos: ProductoShopify[] } | null = null;

/** Solo tests. */
export function _limpiarCacheCatalogo(): void {
  cacheCatalogo = null;
}

export async function catalogo(deps: DepsHerramientas, ctx: CtxTurno): Promise<ProductoShopify[]> {
  const ahora = deps.ahoraMs?.() ?? Date.now();
  const estado = ctx.cfg.vendedor.catalogo_estado || "ACTIVE";
  if (cacheCatalogo && cacheCatalogo.estado === estado && cacheCatalogo.hasta > ahora) return cacheCatalogo.productos;
  const productos = await deps.catalogoShopify(estado);
  cacheCatalogo = { estado, productos, hasta: ahora + (ctx.cfg.vendedor.catalogo_cache_min || 10) * 60_000 };
  return productos;
}

/** `ahorro`: lo que ahorra contra comprar esa cantidad a precio de lista (lo calcula el servidor, no el modelo). */
export type OfertaCatalogo = {
  cantidad: number;
  precio: number;
  precio_texto: string;
  total: number;
  total_texto: string;
  ahorro: number;
  ahorro_texto: string;
  /** Texto listo para el cliente, igual que el anuncio: "125.000 + 33.000 de envío = 158.000" (08-10). */
  frase_precio: string;
};
export type ItemCatalogo = {
  handle: string;
  titulo: string;
  variante_id: string;
  precio: number;
  precio_texto: string;
  disponible: boolean;
  total: number;
  total_texto: string;
  ofertas: OfertaCatalogo[];
  imagen: string | null;
  /** "79.000 + 33.000 de envío = 112.000": el precio del anuncio con el envío aparte (08-10). */
  frase_precio: string;
};

/** 08-10: el anuncio dice "Gs 79.000"; decir "112.000 con envío" parecía otro precio. Siempre precio + envío = total. */
export const frasePrecio = (precio: number, envio: number) => `${gs(precio)} + ${gs(envio)} de envío (${gs(precio + envio)} en total)`;
/**
 * 12-10 (Enrique): siempre el total con envío y lo que gana contra comprar de a 1 (unidad + envío).
 * ×2 → "158.000 en total: es como pagar 2 × 79.000, el envío te sale gratis"; ×3 → "188.000 en total: envío gratis
 * + 49.000 menos". Si la oferta no llega a cubrir el envío, solo el total (no se promete envío gratis).
 */
export function fraseCantidad(cantidad: number, precioUnidad: number, precioOferta: number, envio: number): string {
  const total = precioOferta + envio;
  const menos = cantidad * precioUnidad - total;
  if (menos > 0) return `${gs(total)} en total: envío gratis + ${gs(menos)} menos`;
  if (menos === 0) return `${gs(total)} en total: es como pagar ${cantidad} × ${gs(precioUnidad)}, el envío te sale gratis`;
  return `${gs(total)} en total`;
}
/** 09-10: 2 o más del mismo producto → "envío gratis" (mismo total de siempre: oferta + envío). */
export const frasePrecioOferta = (cantidad: number, precio: number, envio: number, precioUnidad: number) =>
  `${cantidad} por ${fraseCantidad(cantidad, precioUnidad, precio, envio)}`;

/** Precio total de `cantidad` unidades: la oferta por cantidad si existe; si no, lista × cantidad. */
export function precioPorCantidad(precio: number, cantidad: number, ofertas: Record<string, number> | undefined): number {
  const o = ofertas?.[String(cantidad)];
  return typeof o === "number" && o > 0 ? o : precio * cantidad;
}

export function itemsCatalogo(productos: ProductoShopify[], ctx: CtxTurno): ItemCatalogo[] {
  const envio = ctx.cfg.envio.costo_gs;
  return productos.map((p) => {
    const v = p.variantes.find((x) => x.disponible) ?? p.variantes[0];
    if (!v) return null;
    const ofertas = Object.entries(ctx.cfg.ofertas[p.handle] ?? {})
      .map(([c, precio]) => ({ cantidad: Number(c), precio }))
      .filter((o) => Number.isInteger(o.cantidad) && o.cantidad > 1 && o.precio > 0)
      .sort((a, b) => a.cantidad - b.cantidad)
      .map((o) => {
        const ahorro = Math.max(0, v.price * o.cantidad - o.precio);
        return {
          ...o, precio_texto: gs(o.precio), total: o.precio + envio, total_texto: gs(o.precio + envio), ahorro, ahorro_texto: gs(ahorro),
          frase_precio: frasePrecioOferta(o.cantidad, o.precio, envio, v.price),
        };
      });
    return {
      handle: p.handle,
      titulo: p.title,
      variante_id: v.id,
      precio: v.price,
      precio_texto: gs(v.price),
      disponible: p.variantes.some((x) => x.disponible),
      total: v.price + envio,
      total_texto: gs(v.price + envio),
      ofertas,
      imagen: p.imagen,
      frase_precio: frasePrecio(v.price, envio),
    };
  }).filter((x): x is ItemCatalogo => x !== null);
}

function buscar(items: ItemCatalogo[], q: string | undefined): ItemCatalogo[] {
  const n = normalizar(q ?? "");
  if (!n) return items;
  const palabras = n.split(" ").filter((w) => w.length > 2);
  const r = items.filter((i) => {
    const h = normalizar(`${i.titulo} ${i.handle.replace(/-/g, " ")}`);
    return palabras.some((w) => h.includes(w) || h.includes(w.replace(/s$/, "")));
  });
  return r.length ? r : items;
}

// ---------- ejecutores ----------

async function consultarCatalogo(input: Record<string, unknown>, ctx: CtxTurno, deps: DepsHerramientas): Promise<ResultadoHerramienta> {
  let productos: ProductoShopify[];
  try {
    productos = await catalogo(deps, ctx);
  } catch (e) {
    return error(`catalogo_no_disponible: ${e instanceof Error ? e.message : e}. Derivá a Enrique si el cliente necesita el precio.`);
  }
  const busqueda = typeof input.busqueda === "string" ? input.busqueda : undefined;
  // 19-10: el inhalador no se ofrece hasta que Enrique confirme DINAVISA y el precio.
  // 19-10: también si lo nombró el cliente (el modelo suele buscar "nasal" y la nota no llegaba: simulador).
  if (/inhalador/i.test(normalizar(`${busqueda ?? ""} ${ctx.textoEntrada ?? ""}`))) {
    return { resultado: { ok: true, productos: [], nota: NOTA_INHALADOR } };
  }
  const items = buscar(itemsCatalogo(productos, ctx), busqueda);
  return {
    resultado: {
      ok: true,
      moneda: "PYG",
      envio: ctx.cfg.envio.costo_gs,
      envio_texto: gs(ctx.cfg.envio.costo_gs),
      plazo: ctx.cfg.envio.plazo,
      productos: items.map(({ imagen: _i, ...resto }) => resto),
      // 21-10: oferta de 2 distintos (solo si está prendida): montos del catálogo, para que el modelo no escriba números.
      ...(extrasVendedor(ctx.cfg.vendedor).oferta_2_distintos ? { oferta_2_distintos: oferta2DistintosInfo(items) } : {}),
      nota: "Decí el precio SIEMPRE con frase_precio (precio del anuncio + envío aparte = total), nunca solo el total. ahorro = lo que ahorra la oferta contra comprar por unidad. Usá solo estos montos.",
    },
  };
}

async function estadoPedido(_i: Record<string, unknown>, ctx: CtxTurno, deps: DepsHerramientas): Promise<ResultadoHerramienta> {
  const pedidos = await deps.pedidosDeCliente(ctx.clienteId, ctx.telefono);
  if (!pedidos.length) return { resultado: { ok: true, pedidos: [], nota: "No encontré pedidos con este número. Si dice que compró (por la web o con otro número), buscalo con buscar_pedido (número de pedido o nombre); si tampoco aparece, pedile el número de pedido o el teléfono que puso." } };
  return {
    resultado: {
      ok: true,
      plazo: ctx.cfg.envio.plazo,
      pedidos: pedidos.slice(0, 3).map((p) => ({
        pedido: p.nombre ?? p.shopify_order_id,
        shopify_order_id: p.shopify_order_id,
        confirmacion: p.estado_confirmacion,
        envio: p.estado_envio ?? "todavía sin datos del courier",
        courier: p.courier,
        total: p.total,
        fecha: p.creado_en,
        ultimo_estado: p.ultimo_estado ?? null,
      })),
    },
  };
}

/**
 * 10-10: RUC + razón social que manda el cliente → validado con el dígito verificador (módulo 11).
 * Acepta puntos y espacios ("4.012.344-3", "4012344 3"). Sin DV propone el correcto para que el cliente lo confirme.
 */
export type FacturaParseada =
  | { ok: true; ruc: string; razon: string }
  | { ok: false; motivo: "sin_ruc" | "sin_razon" | "sin_dv" | "dv_invalido"; sugerido?: string; razon?: string };
export function parsearFactura(texto: string): FacturaParseada {
  const t = String(texto ?? "").trim();
  const m = /(\d{1,3}(?:[.\s]\d{3})+|\d{3,9})(?:\s*[-–]\s*(\d)(?!\d)|\s(\d)(?=\s|$))?/.exec(t);
  if (!m) return { ok: false, motivo: "sin_ruc" };
  const base = m[1].replace(/[.\s]/g, "");
  const dv = m[2] ?? m[3];
  const razon = t.replace(m[0], " ").replace(/\b(?:r\.?u\.?c\.?|raz[oó]n social|a nombre de|nombre)\s*[:\-]?/giu, " ")
    .replace(/[,;:|]+/g, " ").replace(/\s+/g, " ").trim();
  if (!/^\d{3,9}$/.test(base)) return { ok: false, motivo: "sin_ruc" };
  if (dv === undefined) return { ok: false, motivo: "sin_dv", sugerido: `${base}-${digitoVerificadorRuc(base)}`, razon };
  const ruc = normalizarRuc(`${base}-${dv}`);
  if (!ruc) return { ok: false, motivo: "dv_invalido", razon };
  if (!razon) return { ok: false, motivo: "sin_razon" };
  return { ok: true, ruc, razon };
}

/** 10-10: la referencia nueva se SUMA a la que ya había (antes la pisaba: "Reja negra, pasto en la vereda" → "pasto"). */
export function unirReferencia(actual: string | null | undefined, nueva: string): string {
  const a = String(actual ?? "").trim(), n = nueva.trim();
  if (!a) return n;
  const norm = (x: string) => normalizar(x);
  if (norm(a).includes(norm(n))) return a;
  if (norm(n).includes(norm(a))) return n;
  return `${a}. ${n}`.slice(0, 250);
}

/** "Pin de ubicación", "Ubicación por pin", "ubicación enviada…": dirección sin nada escrito para el courier. */
export function esSoloPin(direccion: string): boolean {
  const n = normalizar(direccion);
  return /^(?:el )?(?:pin|ubicacion)(?: (?:de|por|del|enviada|en|el|mapa|maps|google|ubicacion|pin|link|whatsapp))*$/.test(n);
}

/** 14-10: nombre usable del perfil de WhatsApp (sin emojis ni números; al menos 2 letras). null si no sirve. */
export function nombreDePerfil(n: string | null | undefined): string | null {
  const limpio = String(n ?? "").normalize("NFC").replace(/[^\p{L}\s'.-]/gu, " ").replace(/\s+/g, " ").trim();
  const letras = (limpio.match(/\p{L}/gu) ?? []).length;
  if (letras < 2 || letras < String(n ?? "").replace(/\s/g, "").length * 0.5) return null;
  return limpio.split(" ").slice(0, 3).join(" ");
}

/** Valida los datos y arma las líneas con los precios del catálogo. Puro (salvo el catálogo ya leído). */
export function armarPedido(
  input: Record<string, unknown>,
  items: ItemCatalogo[],
  ctx: CtxTurno,
): { ok: true; datos: DatosPedidoChat } | { ok: false; faltan: string[]; error?: string } {
  const s = (k: string) => (typeof input[k] === "string" ? (input[k] as string).trim() : "");
  const faltan: string[] = [];
  // 14-10 (Enrique): el nombre nunca traba el pedido: si no lo dio, el de su perfil de WhatsApp.
  const nombre = s("nombre") || nombreDePerfil(ctx.nombreCliente) || "Cliente WhatsApp";
  const retiro = input.retiro_oficina === true;
  // 15-10 (Enrique, #1055): "si tenemos nombre, celular y pin de ubicación, ya estamos": con pin no se pide nada más.
  const conPin = /-?\d{1,3}\.\d+\s*,\s*-?\d{1,3}\.\d+/.test(s("ubicacion"));
  if (!retiro && !s("ciudad") && !conPin) faltan.push("ciudad");
  // 20-10 (Enrique): solo la ciudad + ubicacion_pendiente → sale igual (UBICACION_PENDIENTE); el dato se pide antes del despacho.
  // 20-10: si el modelo repite la ciudad como "calle" (simulación: "Luque, Luque"), no hay calle: es ubicación pendiente.
  if (s("direccion") && normalizar(s("direccion")) === normalizar(s("ciudad"))) input = { ...input, direccion: "", ubicacion_pendiente: true };
  const pendiente = input.ubicacion_pendiente === true && !!s("ciudad") && !conPin && !retiro;
  if (retiro || conPin || pendiente) { /* retiro en la oficina de CDE, pin o ubicación pendiente: no se exige calle */ }
  // 14-10 (Enrique): alcanza con ciudad + calle o referencia.
  else if ((!s("direccion") || esSoloPin(s("direccion"))) && !s("referencia")) faltan.push("calle o una referencia");
  if (!ctx.telefono) faltan.push("telefono (usá pedir_telefono)");
  const pedidos = Array.isArray(input.items) ? input.items as Array<Record<string, unknown>> : [];
  if (!pedidos.length) faltan.push("items");
  if (faltan.length) return { ok: false, faltan };

  const lineas: LineaPedido[] = [];
  for (const it of pedidos) {
    const handle = String(it.handle ?? "");
    const cantidad = Number(it.cantidad);
    const prod = items.find((x) => x.handle === handle) ??
      items.find((x) => normalizar(x.titulo).includes(normalizar(handle)) && normalizar(handle).length > 3);
    if (!prod) return { ok: false, faltan: [], error: `producto_desconocido:${handle}. Usá un handle de consultar_catalogo.` };
    if (!prod.disponible) return { ok: false, faltan: [], error: mensajeSinStock(prod, items) };
    if (!Number.isInteger(cantidad) || cantidad < 1 || cantidad > ctx.cfg.vendedor.cantidad_max) {
      return { ok: false, faltan: [], error: `cantidad_invalida:${cantidad} (1 a ${ctx.cfg.vendedor.cantidad_max}; más es mayorista: derivá)` };
    }
    lineas.push({
      handle: prod.handle,
      titulo: prod.titulo,
      variante_id: prod.variante_id,
      cantidad,
      total: precioPorCantidad(prod.precio, cantidad, ctx.cfg.ofertas[prod.handle]),
    });
  }
  // 10-10: la factura se valida acá; si no da, el modelo se la vuelve a pedir al cliente (una vez).
  let factura: { texto: string; ruc: string | null; razon: string | null; invalida: boolean } | null = null;
  if (s("factura")) {
    const f = parsearFactura(s("factura"));
    if (f.ok) factura = { texto: `${f.ruc} ${f.razon}`, ruc: f.ruc, razon: f.razon, invalida: false };
    else if (input.factura_sin_validar === true) factura = { texto: s("factura"), ruc: null, razon: null, invalida: true };
    else if (f.motivo === "sin_dv") {
      return { ok: false, faltan: [], error: `ruc_sin_dv: preguntale "¿Tu RUC es ${f.sugerido}?" y solo si confirma mandá factura "${f.sugerido} ${f.razon || "<razón social>"}".` };
    } else if (f.motivo === "dv_invalido") {
      return { ok: false, faltan: [], error: "ruc_invalido: el número después del guion no da. Pedíselo de nuevo UNA sola vez: \"Ese RUC no me da, ¿me lo pasás de nuevo con el número después del guion?\". Si ya se lo pediste y vuelve a fallar, llamá crear_pedido_cod con la misma factura y factura_sin_validar=true." };
    } else if (f.motivo === "sin_razon") {
      return { ok: false, faltan: ["razón social (a nombre de quién va la factura)"] };
    } else return { ok: false, faltan: ["RUC con guion (ej. 1234567-8)"] };
  }
  // 21-10: 2 distintos → cada uno a su precio de lista (catálogo) y envío 0. Nunca un monto escrito por la IA.
  const oferta2 = !retiro && esOferta2Distintos(lineas, extrasVendedor(ctx.cfg.vendedor).oferta_2_distintos);
  const envio = retiro || oferta2 ? 0 : ctx.cfg.envio.costo_gs;
  const subtotal = lineas.reduce((a, l) => a + l.total, 0);
  return {
    ok: true,
    datos: {
      nombre,
      ciudad: retiro ? "Ciudad del Este" : s("ciudad") || "Ver mapa",
      direccion: retiro ? "Retira en la oficina (CDE)" : (s("direccion") && !esSoloPin(s("direccion")) ? s("direccion") : s("ubicacion") ? "Pin de ubicación" : s("referencia") || (pendiente ? DIRECCION_PENDIENTE : "")),
      ...(pendiente && !(s("direccion") && !esSoloPin(s("direccion"))) && !s("referencia") ? { ubicacionPendiente: true } : {}),
      ...(oferta2 ? { oferta2Distintos: true } : {}),
      ...(s("color") ? { color: s("color").slice(0, 40) } : {}),
      referencia: s("referencia") || null,
      ubicacion: s("ubicacion") || null,
      ...(input.calle_de_pin === true && s("ubicacion") ? { calleDePin: true } : {}),
      ...(/^\d{4}-\d{2}-\d{2}$/.test(s("fecha_entrega")) && !retiro ? { entregaProgramada: { fecha: s("fecha_entrega"), franja: s("franja_entrega") || null } } : {}),
      telefono: ctx.telefono!,
      lineas,
      envio,
      total: subtotal + envio,
      factura: factura?.texto ?? null,
      ...(factura?.ruc ? { facturaRuc: factura.ruc, facturaRazon: factura.razon } : {}),
      ...(factura?.invalida ? { facturaInvalida: true } : {}),
      ...(retiro ? { retiro: true } : {}),
    },
  };
}

/**
 * Líneas de Shopify. PYG no tiene decimales: si la oferta no se divide justo por la cantidad,
 * la diferencia va en una línea aparte de 1 unidad (la suma da exacto el precio de la oferta).
 */
export function lineasShopify(lineas: LineaPedido[]): Array<Record<string, unknown>> {
  const money = (n: number) => ({ shopMoney: { amount: String(n), currencyCode: "PYG" } });
  const out: Array<Record<string, unknown>> = [];
  for (const l of lineas) {
    const unit = Math.floor(l.total / l.cantidad);
    const resto = l.total - unit * l.cantidad;
    if (resto === 0) out.push({ variantId: l.variante_id, quantity: l.cantidad, priceSet: money(unit) });
    else {
      if (l.cantidad > 1) out.push({ variantId: l.variante_id, quantity: l.cantidad - 1, priceSet: money(unit) });
      out.push({ variantId: l.variante_id, quantity: 1, priceSet: money(unit + resto) });
    }
  }
  return out;
}

/** "lat,lng" → link de Google Maps (null si no hay pin válido). */
export function linkMapa(ubicacion: string | null | undefined): string | null {
  const m = /(-?\d{1,3}\.\d+)\s*,\s*(-?\d{1,3}\.\d+)/.exec(String(ubicacion ?? ""));
  return m ? `https://maps.google.com/?q=${m[1]},${m[2]}` : null;
}

/** Input de orderCreate (Admin GraphQL 2026-10): pago pendiente como un pedido contra entrega de Releasit. */
export function inputOrderCreate(d: DatosPedidoChat, ctx: CtxTurno): Record<string, unknown> {
  const [nombre, ...resto] = d.nombre.split(/\s+/);
  const notas = [`Pedido creado por el vendedor con IA (WhatsApp).`];
  // 26-10 (JawFlex): por cantidad, nota para Despacho (27-10: 3 = "1 par suave, 1 par medio y 1 par duro").
  const ptTodos = extrasVendedor(ctx.cfg.vendedor).primer_turno_producto;
  for (const l of d.lineas) {
    const n = ptTodos[l.handle]?.notas_cantidad?.[String(l.cantidad)];
    if (n) notas.push(n);
  }
  // 13-10: datos para el courier en la nota (nombre, celular, ciudad, calle, mapa, referencia).
  const mapa = linkMapa(d.ubicacion);
  if (d.entregaProgramada) notas.push(`ENTREGA PROGRAMADA: ${textoFechaCorta(d.entregaProgramada.fecha)}${d.entregaProgramada.franja ? ` (${d.entregaProgramada.franja})` : ""}. Despachar en el día y pedirle a la transportadora que entregue ese día.`);
  if (!d.retiro) {
    notas.push(`Nombre: ${d.nombre}`, `Celular: ${d.telefono}`, `Ciudad: ${d.ciudad}`, `Calle: ${d.direccion}`);
    if (mapa) notas.push(`Mapa: ${mapa}`);
    if (d.referencia) notas.push(`Referencia: ${d.referencia}`);
    if (d.color) notas.push(`Color: ${d.color}`);
  } else if (d.ubicacion) notas.push(`Ubicación: ${d.ubicacion}`);
  if (d.retiro) notas.push("Retira en la oficina de CDE, sin envío. Coordinar día y hora por WhatsApp.");
  if (d.factura) notas.push(`Factura: ${d.factura}`);
  return {
    order: {
      currency: "PYG",
      // Los precios de Voltra YA incluyen IVA: sin esto Shopify calcula el IVA y lo
      // SUMA encima (pedido #1008: Gs 7.900 de más). Con taxesIncluded el total es
      // exacto: oferta + envío − descuento (OrderCreateOrderInput.taxesIncluded, Admin GraphQL).
      taxesIncluded: true,
      phone: d.telefono,
      financialStatus: "PENDING",
      lineItems: lineasShopify(d.lineas),
      shippingLines: d.retiro ? [] : [{ title: "Envío", priceSet: { shopMoney: { amount: String(d.envio), currencyCode: "PYG" } } }],
      shippingAddress: {
        firstName: nombre,
        // 15-10 (#1055): con el apellido vacío Shopify descarta la dirección ENTERA sin avisar.
        lastName: resto.join(" ") || "-",
        address1: d.direccion,
        // 13-10: Despacho arma la guía, la cabecera y el CSV con address1 + address2: ahí van la referencia y el mapa.
        address2: [d.referencia, mapa ? `Mapa: ${mapa}` : null].filter(Boolean).join(" · ") || null,
        city: d.ciudad,
        countryCode: "PY",
        phone: d.telefono,
      },
      // RETIRO_EN_CASA: no va al courier (Despacho lo excluye) ni recibe avisos de envío.
      // 10-10: el cliente ya confirmó en el resumen del chat → entra CONFIRMADO y no se le manda la plantilla de
      // confirmación (antes tenía que confirmar dos veces). OFERTA_PAGO_ANTICIPADO: si manda comprobante, se detecta igual.
      tags: d.retiro ? ["ORIGEN_WHATSAPP", "CONFIRMADO", "RETIRO_EN_CASA"]
        : ["ORIGEN_WHATSAPP", "CONFIRMADO", "OFERTA_PAGO_ANTICIPADO", ...(d.entregaProgramada ? ["ENTREGA_PROGRAMADA"] : []),
          // 20-10: medir la entrega sin pin contra con pin, y marcar los que salen sin calle.
          ...(d.ubicacion ? [] : ["SIN_PIN"]), ...(d.ubicacionPendiente ? ["UBICACION_PENDIENTE"] : []),
          ...(d.oferta2Distintos ? ["OFERTA_2_DISTINTOS"] : [])],
      note: notas.join("\n"),
      customAttributes: [
        { key: "origen", value: "whatsapp" },
        { key: "conversacion_id", value: ctx.conversacionId },
        // La función de factura lee los atributos del pedido (claves_datos_fiscales), no la nota (07-10).
        ...(d.factura ? [{ key: "factura", value: d.factura }] : []),
        // 10-10: mismos nombres que Releasit; la facturación los lee antes que "factura". Solo con RUC válido.
        ...(d.facturaRuc ? [{ key: "Ruc", value: d.facturaRuc }, { key: "Razon social", value: d.facturaRazon ?? "" }] : []),
        // 13-10: entrega programada: sale en el día como todos y a la transportadora se le pide esa fecha (Telegram al despachar).
        ...(d.entregaProgramada ? [{ key: "entrega_programada", value: d.entregaProgramada.fecha }, ...(d.entregaProgramada.franja ? [{ key: "entrega_franja", value: d.entregaProgramada.franja }] : [])] : []),
      ],
    },
    options: { inventoryBehaviour: "DECREMENT_OBEYING_POLICY", sendReceipt: false, sendFulfillmentReceipt: false },
  };
}

export function textoResumen(d: DatosPedidoChat, ctx: CtxTurno): string {
  // 09-10: un solo producto ×2 o más → se muestra con envío gratis (el total es el mismo: oferta + envío).
  const gratis = !d.retiro && ((d.lineas.length === 1 && d.lineas[0].cantidad >= 2) || d.oferta2Distintos === true);
  const lineas = d.oferta2Distintos
    ? d.lineas.map((l) => `${l.titulo} x1`).join(" + ")
    : gratis
    ? `${d.lineas[0].titulo} x${d.lineas[0].cantidad}`
    : d.lineas.map((l) => `${l.titulo} x${l.cantidad} (Gs ${gs(l.total)})`).join(", ");
  const clave = d.retiro ? "resumen_retiro" : gratis ? "resumen_envio_gratis" : "resumen";
  const lineaFactura = d.facturaRuc ? `\n🧾 Factura a nombre de: ${d.facturaRazon} · RUC ${d.facturaRuc}` : "";
  // 12-10 (fase 3): el día de entrega según la ciudad, en el mismo resumen que se confirma.
  const lineaEntrega = d.retiro || !d.ciudad ? "" : d.entregaProgramada
    ? `\n📦 Te llega: el ${textoFechaCorta(d.entregaProgramada.fecha)}${d.entregaProgramada.franja ? ` (${d.entregaProgramada.franja})` : ""}`
    : `\n📦 Te llega: ${diaEntrega(d.ciudad, ctx.ahora).texto}`;
  // 21-10 (Enrique): con solo el pin, el cliente no ve la etiqueta interna "Pin de ubicación": ve el barrio o la calle
  // si los dio, o "la ubicación que mandaste".
  const soloPin = !!d.direccion && esSoloPin(d.direccion);
  const direccion = soloPin
    ? (d.referencia?.trim() ? `la ubicación que mandaste (${d.referencia.trim()})` : "la ubicación que mandaste")
    : [d.direccion, d.referencia].filter(Boolean).join(", ");
  let cuerpo = texto(ctx.cfg.textos, clave, TEXTOS_DEFAULT[clave], { lineas, envio: gs(d.envio), total: gs(d.total), direccion, ciudad: d.ciudad });
  // 20-10 (Enrique): sin calle, el cliente no ve "Sin calle (ubicación pendiente)": ve la ciudad y que lo llaman.
  if (d.ubicacionPendiente) {
    cuerpo = cuerpo.replace(`Lo entregamos en ${direccion}, ${d.ciudad}.`, `Lo entregamos en ${d.ciudad}; el repartidor te llama para la dirección exacta 🙌`);
  }
  // 21-10: con el pin y sin ciudad del mapa ("Ver mapa"), sin la ciudad.
  if (soloPin && /^ver mapa$/i.test(d.ciudad.trim())) cuerpo = cuerpo.replace(`${direccion}, ${d.ciudad}.`, `${direccion}.`);
  return cuerpo + lineaEntrega + lineaFactura;
}

function opts(ctx: CtxTurno) {
  return { clienteId: ctx.clienteId, conversacionId: ctx.conversacionId };
}

async function crearPedidoCod(input: Record<string, unknown>, ctx: CtxTurno, deps: DepsHerramientas): Promise<ResultadoHerramienta> {
  if (input.confirmar !== true) {
    let productos: ProductoShopify[];
    try {
      productos = await catalogo(deps, ctx);
    } catch (e) {
      return error(`catalogo_no_disponible: ${e instanceof Error ? e.message : e}. Derivá a Enrique.`);
    }
    // 14-10: con el pin, la ciudad y la calle salen del mapa (sin preguntar "¿Es en…?"; el resumen ya se confirma).
    const pin = /(-?\d{1,3}\.\d+)\s*,\s*(-?\d{1,3}\.\d+)/.exec(String(input.ubicacion ?? ""));
    const dirIn = String(input.direccion ?? "").trim();
    if (pin && input.retiro_oficina !== true && deps.direccionDePin && (!String(input.ciudad ?? "").trim() || !dirIn || esSoloPin(dirIn))) {
      const m = await deps.direccionDePin(Number(pin[1]), Number(pin[2])).catch(() => null);
      if (m?.ciudad && !String(input.ciudad ?? "").trim()) input = { ...input, ciudad: m.ciudad };
      if (m?.calle && (!dirIn || esSoloPin(dirIn))) input = { ...input, direccion: m.calle, calle_de_pin: true };
    }
    const a = armarPedido(input, itemsCatalogo(productos, ctx), ctx);
    if (!a.ok) return error(a.error ?? `faltan_datos: ${a.faltan.join(", ")}. Pedí solo el que falta.`, { faltan: a.faltan });
    // 26-10: el plazo del resumen sale del courier que da sugerir_courier para esa ciudad (PaP en el interior: 3 a 7).
    if (!a.datos.retiro && a.datos.ciudad) await deps.consultarCourier?.(a.datos.ciudad).catch(() => {});
    // 13-10: una entrega programada nunca puede ser antes del plazo mínimo de esa ciudad.
    if (a.datos.entregaProgramada) {
      const minima = fechaMinimaPedido(a.datos.ciudad, ctx.ahora);
      if (a.datos.entregaProgramada.fecha < minima) {
        return error(`fecha_antes_de_lo_posible: lo antes posible es el ${textoFechaCorta(minima)} (${minima}). Ofrecé esa fecha.`, { fecha_minima: minima });
      }
    }
    const fila = await deps.guardarPedidoChat({
      conversacion_id: ctx.conversacionId,
      cliente_id: ctx.clienteId,
      estado: "resumen",
      datos: a.datos,
      total: a.datos.total,
      shopify_order_id: null,
    });
    const cuerpo = textoResumen(a.datos, ctx);
    const r = await deps.enviarInteractivo(
      ctx.destino,
      botonesSiNo(cuerpo, `vend_conf:${fila.id}`, `vend_corr:${fila.id}`, {
        si: texto(ctx.cfg.textos, "boton_confirmar", TEXTOS_DEFAULT.boton_confirmar),
        no: texto(ctx.cfg.textos, "boton_corregir", TEXTOS_DEFAULT.boton_corregir),
      }),
      opts(ctx),
    );
    if (!r.ok) return error(`no_se_pudo_mostrar_el_resumen: ${r.error}. Derivá a Enrique.`);
    return {
      resultado: { ok: true, resumen_enviado: true, total: a.datos.total, total_texto: gs(a.datos.total), pedido_chat_id: fila.id },
      terminal: true,
    };
  }

  // confirmar = true
  const previo = await deps.ultimoPedidoChat(ctx.conversacionId);
  if (!previo) return error("no_hay_resumen: primero llamá crear_pedido_cod con confirmar=false.");
  if (previo.estado === "creado" && previo.shopify_order_id) {
    return {
      resultado: { ok: true, ya_creado: true, shopify_order_id: previo.shopify_order_id, texto_respuesta: "Tu pedido ya está cargado; en unos minutos te llega la confirmación." },
    };
  }
  if (previo.estado !== "resumen") return error(`resumen_en_estado_${previo.estado}: armá un resumen nuevo.`);
  const vencido = ctx.ahora.getTime() - new Date(previo.creado_en).getTime() > 24 * 3600_000;
  if (vencido) return error("resumen_vencido: mostrá el resumen de nuevo con confirmar=false.");
  // El sí puede estar en cualquier mensaje del cliente desde el resumen (un turno que falló o quedó agrupado no lo pierde).
  // El Confirmar de un resumen anterior del mismo chat también vale (08-10: la clienta tocó Confirmar justo cuando el
  // bot rehacía el resumen con su nota y tuvo que confirmar 4 veces). Se crea con los datos del último resumen.
  const reBoton = /\(vend_conf:[^)\s]+\)/;
  const ok = (t: string) => reBoton.test(t) || esAceptacion(t, ctx.cfg.aceptaciones);
  let confirmo = ok(ctx.textoEntrada);
  if (!confirmo && deps.entradasDesde) {
    const desdeISO = new Date(new Date(previo.creado_en).getTime() - 10 * 60_000).toISOString();
    const desde = await deps.entradasDesde(ctx.conversacionId, desdeISO).catch(() => [] as string[]);
    // El "Corregir" posterior manda: si después del sí pidió corregir, no se confirma.
    const iCorr = desde.findLastIndex((t) => /\(vend_corr:/.test(t));
    confirmo = desde.slice(iCorr + 1).some(ok);
  }
  if (!confirmo) {
    return error("falta_si_claro: el último mensaje del cliente no es un sí claro ni el botón Confirmar. Preguntá si confirma.");
  }

  const d = previo.datos;
  const r = await deps.crearOrdenShopify(inputOrderCreate(d, ctx));
  if (!r.ok || !r.shopify_order_id) {
    await deps.guardarPedidoChat({ ...previo, estado: "fallido" });
    await deps.avisar(
      `<b>Falló crear un pedido de WhatsApp</b>\nCliente: ${escapar(d.nombre)} · ${escapar(d.telefono)}\nTotal: Gs ${gs(d.total)}\nError: ${escapar(r.error ?? "desconocido")}\nCargalo a mano o escribile.`,
    );
    return error(`shopify_fallo: ${r.error}. Derivá a Enrique con motivo falla_herramienta.`);
  }
  await deps.guardarPedidoChat({ ...previo, estado: "creado", shopify_order_id: r.shopify_order_id });
  const avisos: string[] = [];
  if (r.nodo) {
    try {
      await deps.registrarComoReleasit(r.nodo);
    } catch (e) {
      avisos.push(`No se programó la confirmación: ${e instanceof Error ? e.message : e}`);
    }
  } else avisos.push("Shopify no devolvió el pedido completo: la confirmación la programa el webhook o la conciliación.");
  if (d.factura) {
    // 10-10: el RUC ya viene validado (facturaRuc); si el cliente insistió con uno que no da, va a revisar.
    const ruc = d.facturaRuc ?? (d.facturaInvalida ? null : normalizarRuc((/([\d.]{3,12}\s*-\s*\d)/.exec(d.factura) ?? [])[1]));
    avisos.push(ruc
      ? `🧾 Pide factura electrónica: ${d.factura}. Se factura recién cuando esté cobrado (pagado completo por adelantado o, si paga al recibir, entregado), nunca antes. Si la automática está apagada, emitila a mano en ese momento.`
      : `🧾 Pide factura pero el RUC no es válido ("${d.factura}"). Pedile el dato correcto antes de facturar.`);
  }
  if (d.retiro) avisos.push("🏠 Retira en la oficina de CDE: escribile para coordinar día y hora. No va al courier.");
  if (typeof r.total === "number" && Math.round(r.total) !== Math.round(d.total)) {
    avisos.push(`Ojo: Shopify calculó Gs ${gs(r.total)} y el chat le dijo Gs ${gs(d.total)}.`);
  }
  const aviso = formatoPedidoNuevo({
    shopify_order_id: r.shopify_order_id,
    nombre_pedido: r.nombre ?? null,
    total: d.total,
    productos: d.lineas.map((l) => `${l.titulo} x${l.cantidad}`),
    ciudad: d.retiro ? "CDE (retira en la oficina)" : d.ciudad,
    origen: "whatsapp (vendedor IA)",
    cliente: { nombre: d.nombre, telefono: d.telefono, wa_user_id: ctx.waUserId },
  });
  // 14-10 (Enrique: "siempre avisame por Telegram"): el resultado queda en vendedor_turnos y, si falla, un reintento.
  const textoAviso = [aviso.texto, ...avisos.map((a) => `• ${escapar(a)}`)].join("\n");
  let rTg = await deps.avisar(textoAviso, aviso.botones).catch((e) => ({ ok: false, error: e instanceof Error ? e.message : String(e) }));
  if (!rTg.ok) rTg = await deps.avisar(textoAviso, aviso.botones).catch((e) => ({ ok: false, error: e instanceof Error ? e.message : String(e) }));
  if (!rTg.ok) console.error(`vendedor: no salió el Telegram de pedido nuevo ${r.nombre}: ${rTg.error ?? "sin detalle"}`);
  const primer = d.nombre.split(/\s+/)[0] ?? "";
  return {
    resultado: {
      ok: true,
      shopify_order_id: r.shopify_order_id,
      pedido: r.nombre,
      total: d.total,
      aviso_telegram: rTg.ok,
      ...(rTg.ok ? {} : { aviso_telegram_error: String(rTg.error ?? "").slice(0, 160) }),
      texto_respuesta: texto(ctx.cfg.textos, "pedido_creado", TEXTOS_DEFAULT.pedido_creado, { nombre: primer, pedido: r.nombre ?? "" }),
    },
    pedidoCreado: { shopify_order_id: r.shopify_order_id, nombre: r.nombre ?? String(r.shopify_order_id) },
  };
}

function escapar(s: unknown): string {
  return String(s ?? "").replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;");
}

/** ¿El texto ya manda al médico? (médico/médica, con o sin tilde). */
export function mencionaMedico(t: string | null | undefined): boolean {
  return /\bmedic[oa]s?\b/.test(normalizar(t ?? ""));
}

/**
 * Texto que ve el cliente al derivar (cuerpo del botón o mensaje suelto), en este orden:
 * 1) si el motivo es salud y el texto del modelo no nombra al médico, `derivacion_salud`;
 * 2) el texto del modelo que acompañó la herramienta (ya pasó el filtro de salida; si no pasó, llega null);
 * 3) la llamada a la acción: `derivacion` / `derivacion_sin_boton`, o la versión corta (`derivacion_cta*`)
 *    si el texto del modelo ya dice que lo pasa con Enrique, para no repetirlo.
 */
export function textoClienteDerivacion(p: { motivo: string; textoModelo?: string | null; conBoton: boolean; textos: Record<string, string> }): string {
  const modelo = (p.textoModelo ?? "").trim();
  const partes: string[] = [];
  if (p.motivo === "salud" && !mencionaMedico(modelo)) partes.push(texto(p.textos, "derivacion_salud", TEXTOS_DEFAULT.derivacion_salud));
  if (modelo) partes.push(modelo);
  const yaLoPasa = /\benrique\b|\bte paso\b|\bte (comunico|derivo)\b/.test(normalizar(modelo));
  const clave = p.conBoton ? (yaLoPasa ? "derivacion_cta" : "derivacion") : (yaLoPasa ? "derivacion_cta_sin_boton" : "derivacion_sin_boton");
  partes.push(texto(p.textos, clave, TEXTOS_DEFAULT[clave]));
  return partes.join("\n");
}

/**
 * Deriva a Enrique. Lo usa la herramienta y también el orquestador (API caída, topes, filtro).
 * `texto_previo`: lo que el modelo escribió junto con la llamada, YA revisado por el filtro de salida
 * (el orquestador lo pasa en null si el filtro lo rechazó).
 */
export async function derivarAEnrique(
  input: { motivo: string; resumen: string; shopify_order_id?: number | null; texto_previo?: string | null },
  ctx: CtxTurno,
  deps: DepsHerramientas,
): Promise<ResultadoHerramienta> {
  // 10-10: el modelo derivó con resumen "x" justo después del video de entrada y el cliente quedó colgado.
  // Sin un motivo real escrito (las fallas del sistema las deriva el orquestador, no pasan por acá con "otro"), no se deriva.
  if (input.motivo === "otro" && String(input.resumen ?? "").trim().length < 25) {
    return error("derivacion_sin_motivo: no derives sin un motivo real y un resumen claro. Seguí vos: precio con frase_precio y una pregunta corta.");
  }
  // 19-10 (paquete 1): la factura la guarda el bot (guardar_factura), no se deriva (#1075).
  if (/\bfactura|\bruc\b|raz[oó]n social/i.test(String(input.resumen ?? "")) && ["otro", "pide_persona", "falla_herramienta"].includes(input.motivo)) {
    return error("factura_sin_derivar: no derives por la factura. Si el pedido ya existe, guardá el RUC y la razón social con guardar_factura; si todavía no hay pedido, van en el campo factura de crear_pedido_cod.");
  }
  // 19-10: salud sin señales de alerta → texto seguro y se sigue vendiendo (la derivación de rinitis tardó 21 h).
  if (input.motivo === "salud" && !RE_ALERTA_SALUD.test(`${input.resumen ?? ""} ${ctx.textoEntrada ?? ""}`)) {
    return error(`salud_sin_alerta: no derives. Respondé con este texto, adaptado al producto: "${TEXTO_SALUD_SEGURO}" y seguí con la venta (precio con frase_precio y una pregunta corta). Derivá solo si hay señales de alerta (apnea, ahogos, embarazo, menores, dolor, cirugía, ATM o bruxismo).`);
  }
  const sigueIa = esDerivacionDeVenta(input.motivo);
  if (!sigueIa) await deps.pasarAHumano(ctx.conversacionId);
  let orderId: number | null = Number.isFinite(Number(input.shopify_order_id)) && input.shopify_order_id ? Number(input.shopify_order_id) : null;
  let nombrePedido: string | null = null;
  try {
    const pedidos = await deps.pedidosDeCliente(ctx.clienteId, ctx.telefono);
    const p = orderId ? pedidos.find((x) => x.shopify_order_id === orderId) : pedidos[0];
    if (p) {
      orderId = p.shopify_order_id;
      nombrePedido = p.nombre;
    }
  } catch { /* sin pedido: el aviso sale igual */ }

  const nombre = ctx.nombreCliente?.split(/\s+/)[0] ?? "";
  const resumen = (input.resumen || MOTIVO_LEGIBLE[input.motivo] || "Necesito ayuda").trim();
  const t = ctx.cfg.textos;
  const numero = ctx.cfg.vendedor.whatsapp_enrique;
  const mensajeEnrique = texto(t, "mensaje_a_enrique", TEXTOS_DEFAULT.mensaje_a_enrique, {
    nombre: nombre || "cliente de Voltra",
    resumen: `${MENSAJE_CLIENTE[input.motivo] ?? MENSAJE_CLIENTE_DEFAULT}${nombrePedido ? ` (pedido ${nombrePedido})` : ""}`,
  });
  const url = numero ? enlaceWaMe(numero, mensajeEnrique) : null;
  const textoCliente = textoClienteDerivacion({ motivo: input.motivo, textoModelo: input.texto_previo, conBoton: !!url, textos: t });
  const rCliente = url
    ? await deps.enviarInteractivo(ctx.destino, botonEnlace(textoCliente, texto(t, "boton_enrique", TEXTOS_DEFAULT.boton_enrique), url), opts(ctx))
    : await deps.enviarTexto(ctx.destino, textoCliente, opts(ctx));

  const aviso = formatoChatNecesitaEnrique({
    motivo: MOTIVO_LEGIBLE[input.motivo] ?? input.motivo,
    resumen,
    shopify_order_id: orderId,
    nombre_pedido: nombrePedido,
    cliente: { nombre: ctx.nombreCliente, telefono: ctx.telefono, wa_user_id: ctx.waUserId },
    ofrecerReponer: input.motivo === "reclamo",
  });
  const extra: string[] = [
    sigueIa ? "El vendedor sigue atendiendo si el cliente vuelve a escribir." : "El chat pasó a humano: el vendedor IA ya no responde.",
  ];
  if (!rCliente.ok) extra.push(`No pude avisarle al cliente: ${rCliente.error}`);
  if (!numero) extra.push("Falta config_wa.vendedor.whatsapp_enrique: el cliente no recibió el botón para escribirte.");
  const rTg = await deps.avisar([aviso.texto, ...extra.map((e) => `• ${escapar(e)}`)].join("\n"), aviso.botones);
  return {
    resultado: {
      ok: true,
      derivado: true,
      sigue_ia: sigueIa,
      aviso_cliente: rCliente.ok,
      aviso_telegram: rTg.ok,
      texto_cliente: textoCliente,
      nota: sigueIa
        ? "Ya le mandé el botón. Si el cliente sigue escribiendo, seguí atendiéndolo normal (por ejemplo, si al final quiere 1 a 3 unidades, vendéselas)."
        : "No escribas nada más.",
    },
    // Termina solo este turno (el botón ya salió); en 'ia' el próximo mensaje del cliente se atiende normal.
    terminal: true,
    derivado: true,
  };
}

/** 19-10 (paquete 1): cuántas horas después del ahora cae el inicio (00:00 PY) de una fecha YYYY-MM-DD. */
export function horasHastaFecha(fecha: string, ahora: Date): number | null {
  if (!/^\d{4}-\d{2}-\d{2}$/.test(fecha)) return null;
  const t = Date.parse(`${fecha}T00:00:00-03:00`);
  return Number.isFinite(t) ? (t - ahora.getTime()) / 3_600_000 : null;
}

/**
 * registrar_perfil: el orquestador guarda el perfil; acá se valida. 19-10 (paquete 1, informe 01 §6): de 10
 * "te escribo el lunes", 6 caían fuera de las 24 h y ninguno salió. Si la fecha de recontacto cae fuera de la
 * ventana y el cliente no dio permiso de avisos, el bot no lo promete: ese día le avisa a Enrique seguimiento-chat.
 */
async function registrarPerfil(i: Record<string, unknown>, ctx: CtxTurno, deps: DepsHerramientas): Promise<ResultadoHerramienta> {
  const perfil = normalizarPerfil(i, "modelo");
  const fecha = typeof perfil.recontactar_el === "string" ? perfil.recontactar_el : null;
  const horas = fecha ? horasHastaFecha(fecha, ctx.ahora) : null;
  if (horas === null || horas < 20) return { resultado: { ok: true, perfil } };
  const permiso = await deps.consentimiento?.(ctx.clienteId).catch(() => null) ?? null;
  if (permiso === "si") return { resultado: { ok: true, perfil, nota: "Tiene permiso de avisos: ese día le escribimos con una plantilla." } };
  return {
    resultado: {
      ok: true,
      perfil,
      nota: "Esa fecha cae fuera de las 24 h y no tiene permiso de avisos: NO prometas \"te escribo el …\" (WhatsApp no lo deja). " +
        "Decile \"cuando estés listo escribime por acá y lo armamos\" o ofrecé dejarlo programado para ese día con programar_entrega. Ese día le avisamos a Enrique.",
    },
  };
}

function textoRevisado(input: Record<string, unknown>, ctx: CtxTurno): { ok: true; texto: string } | { ok: false; r: ResultadoHerramienta } {
  const t = typeof input.texto === "string" ? input.texto.trim() : "";
  if (!t) return { ok: false, r: error("falta_texto") };
  const rev = ctx.revisar(t);
  if (!rev.ok) return { ok: false, r: error(`texto_bloqueado: ${rev.motivos.join(", ")}. Reescribilo.`) };
  return { ok: true, texto: t };
}

async function enviarInteractivoRevisado(
  input: Record<string, unknown>,
  ctx: CtxTurno,
  deps: DepsHerramientas,
  construir: (t: string) => Record<string, unknown>,
  ok: Record<string, unknown> = {},
): Promise<ResultadoHerramienta> {
  const t = textoRevisado(input, ctx);
  if (!t.ok) return t.r;
  let interactivo: Record<string, unknown>;
  try {
    interactivo = construir(t.texto);
  } catch (e) {
    return error(`interactivo_invalido: ${e instanceof Error ? e.message : e}`);
  }
  const r = await deps.enviarInteractivo(ctx.destino, interactivo, opts(ctx));
  if (!r.ok) return error(`envio_fallido: ${r.error}`);
  return { resultado: { ok: true, enviado: true, ...ok, nota: "Ya se le mandó al cliente. No escribas nada más." }, terminal: true };
}

async function enviarMediaHerr(input: Record<string, unknown>, ctx: CtxTurno, deps: DepsHerramientas): Promise<ResultadoHerramienta> {
  const handle = String(input.handle ?? "");
  const tipo = String(input.tipo ?? "foto");
  let caption: string | null = null;
  if (typeof input.texto === "string" && input.texto.trim()) {
    const t = textoRevisado(input, ctx);
    if (!t.ok) return t.r;
    caption = t.texto;
  }
  const media = ctx.cfg.media[handle] ?? {};
  let link: string | null = tipo === "foto" ? (media.foto ?? null) : (media[tipo] ?? null);
  if (!link && tipo === "foto") {
    try {
      link = (await catalogo(deps, ctx)).find((p) => p.handle === handle)?.imagen ?? null;
    } catch { /* sin catálogo */ }
  }
  if (!link) return error(`no_hay_${tipo}_cargado_para:${handle}. Seguí sin el archivo o ofrecé otra prueba.`);
  const r = await deps.enviarMedia(ctx.destino, tipo === "foto" ? "image" : "video", link, caption, opts(ctx));
  if (!r.ok) return error(`envio_fallido: ${r.error}`);
  return { resultado: { ok: true, enviado: true, nota: "Se mandó el archivo. Si hace falta, escribí una línea corta con una pregunta." } };
}

/**
 * 29-10: nombre de la ciudad según la tabla de tarifas, de las respuestas de la rpc tarifa_courier (una por courier).
 * Solo cuenta una fila real (estimado=false con ciudad): el estimado de PaP por zona no reconoce nada. null = ninguna.
 */
export function ciudadDeTarifas(respuestas: unknown[]): string | null {
  for (const r of respuestas) {
    const o = (r ?? null) as { ciudad?: unknown; estimado?: unknown } | null;
    if (o && o.estimado !== true && typeof o.ciudad === "string" && o.ciudad.trim()) return o.ciudad.trim();
  }
  return null;
}

async function actualizarDireccion(input: Record<string, unknown>, ctx: CtxTurno, deps: DepsHerramientas): Promise<ResultadoHerramienta> {
  const t = (k: string) => (typeof input[k] === "string" ? (input[k] as string).trim().slice(0, 200) : "");
  const direccion = t("direccion");
  // 29-10: la ciudad que respondió el cliente (pedir_ciudad de pedidos-trabados o completar dirección).
  const ciudadEscrita = t("ciudad").replace(/[\s.,;:!?]+$/, "").slice(0, 80);
  // 12-10: el pin va como "lat,lng" en la referencia (pedidos-trabados lo reconoce como dirección utilizable).
  const pin = /(-\d{1,2}\.\d{3,})\s*,\s*(-\d{1,2}\.\d{3,})/.exec(t("ubicacion"));
  const referencia = [t("referencia"), pin ? `Pin: ${pin[1]},${pin[2]} https://maps.google.com/?q=${pin[1]},${pin[2]}` : ""].filter(Boolean).join(". ");
  if (!direccion && !referencia && !ciudadEscrita) return error("sin_datos: mandá la dirección, la ciudad, la referencia o el pin nuevo.");
  const chat = await deps.ultimoPedidoChat(ctx.conversacionId);
  // Pedido del bot ya creado o, si no, el pedido de la tienda abierto (Releasit) del cliente.
  // 13-10: un pedido en reintento de entrega manda (el cliente coordina día y horario), aunque tenga más de 72 h.
  const tienda = deps.pedidoTiendaAbierto ? await deps.pedidoTiendaAbierto(ctx.clienteId).catch(() => null) : null;
  const previo: { shopify_order_id: number; creado_en: string; en_reintento?: boolean } | null = tienda?.en_reintento ? tienda
    : chat?.estado === "creado" && chat.shopify_order_id ? { shopify_order_id: chat.shopify_order_id, creado_en: chat.creado_en } : tienda;
  if (!previo) {
    return error("no_hay_pedido_creado: si todavía no confirmó, armá el resumen con crear_pedido_cod con estos datos.");
  }
  if (!previo.en_reintento && ctx.ahora.getTime() - new Date(previo.creado_en).getTime() > 72 * 3600_000) return error("pedido_viejo: derivá a Enrique.");
  if (!deps.actualizarDireccionOrden) return error("no_disponible: derivá a Enrique con motivo direccion_dudosa.");
  // 29-10: la ciudad se normaliza con la tabla de tarifas ("luque" → "Luque", "es en Asunción" → "Asunción"). Si no la
  // reconoce (o no se pudo consultar), se guarda tal como la escribió: no frena; pedidos-trabados decide en su corrida.
  let ciudad = "";
  let ciudadReconocida: boolean | null = null;
  if (ciudadEscrita) {
    const rc = deps.reconocerCiudad ? await deps.reconocerCiudad(ciudadEscrita).catch(() => null) : null;
    ciudadReconocida = rc ? rc.reconocida && !!rc.ciudad : null;
    ciudad = ciudadReconocida && rc?.ciudad ? rc.ciudad : ciudadEscrita;
  }
  const d = { ...(direccion ? { direccion } : {}), ...(referencia ? { referencia } : {}), ...(ciudad ? { ciudad, ciudadReconocida } : {}) };
  const r = await deps.actualizarDireccionOrden(previo.shopify_order_id, d);
  if (!r.ok) return error(`no_se_pudo_actualizar: ${r.error}. Derivá a Enrique con motivo direccion_dudosa.`);
  const quien = escaparHtml(ctx.nombreCliente ?? ctx.telefono ?? "Cliente");
  const partes = [direccion, ciudad ? (ciudadReconocida === false ? `${ciudad} (ciudad no reconocida)` : ciudad) : "", referencia].filter(Boolean);
  // 10-10: si el pedido ya salió, va el texto listo para reenviar al courier con el cambio (13-10: un solo Telegram).
  const pc = deps.pedidoParaCourier ? await deps.pedidoParaCourier(previo.shopify_order_id).catch(() => null) : null;
  if (!pc?.despachado) {
    await deps.avisar(`📍 <b>${quien}</b> completó la dirección del pedido (Shopify ${previo.shopify_order_id}): ${escaparHtml(partes.join(" · "))}`)
      .catch(() => {});
  }
  if (pc?.despachado) {
    const base = datosCourierDesdeRaw(pc.nombre, pc.raw, pc.telefono ?? ctx.telefono);
    const datos = { ...base, ...(direccion ? { direccion } : {}), ...(ciudad ? { ciudad } : {}), ...(referencia ? { referencia: unirReferencia(base.referencia, referencia) } : {}) };
    await deps.avisar(avisoParaCourier(datos, `Cambio que pidió el cliente: ${partes.join(" · ")}`, pc.courier)).catch(() => {});
  }
  if (ciudad && ciudadReconocida === false) {
    return {
      resultado: {
        ok: true, actualizado: true, ciudad, ciudad_reconocida: false,
        nota: "Quedó guardada tal como la escribió, pero esa ciudad no figura entre las que cubren los couriers. Confirmale corto que lo anotaste " +
          "y pedile UNA vez el pin 📍 de su casa o el nombre de la ciudad más cercana (si ya se lo pediste o no lo tiene, no insistas).",
      },
    };
  }
  return { resultado: { ok: true, actualizado: true, ...(ciudad ? { ciudad, ciudad_reconocida: ciudadReconocida } : {}), nota: "Listo, quedó en el pedido. Confirmale corto que lo anotaste." } };
}

async function datosTransferencia(_input: Record<string, unknown>, ctx: CtxTurno, deps: DepsHerramientas): Promise<ResultadoHerramienta> {
  const datos = ctx.cfg.transferencia;
  if (!datos) return error("sin_datos_de_cuenta: decile que puede pagar al recibir y seguí con el pedido.");
  const r = await deps.enviarTexto(ctx.destino, `💳 Datos para transferir:\n${datos}`, opts(ctx));
  if (!r.ok) return error(`envio_fallido: ${r.error}`);
  return {
    resultado: {
      ok: true,
      enviado: true,
      nota: "Ya se le mandaron los datos de la cuenta. Pedile en una línea los datos del envío que falten y que mande la foto del comprobante por acá.",
    },
  };
}

async function enviarOpciones(input: Record<string, unknown>, ctx: CtxTurno, deps: DepsHerramientas): Promise<ResultadoHerramienta> {
  let items: ItemCatalogo[];
  try {
    items = itemsCatalogo(await catalogo(deps, ctx), ctx);
  } catch (e) {
    return error(`catalogo_no_disponible: ${e instanceof Error ? e.message : e}`);
  }
  const prod = items.find((x) => x.handle === input.handle);
  if (!prod) return error(`producto_desconocido:${input.handle}`);
  if (!prod.imagen?.startsWith("https://")) return error("producto_sin_foto: ofrecé las cantidades por texto.");
  if (!prod.ofertas.length) return error("sin_ofertas_por_cantidad: ofrecé solo ×1.");
  const envio = ctx.cfg.envio.costo_gs;
  const opciones = [
    { cantidad: 1, precio: prod.precio },
    ...prod.ofertas.map((o) => ({ cantidad: o.cantidad, precio: o.precio })),
  ].slice(0, 3);
  const nombre = (n: number) => n === 1 ? "1 unidad" : `${n} unidades`;
  const lineas = opciones.map((o) => {
    return o.cantidad === 1
      ? `*${nombre(o.cantidad)}* · ${frasePrecio(o.precio, envio)}`
      : `*${nombre(o.cantidad)}* · ${fraseCantidad(o.cantidad, prod.precio, o.precio, envio)}`;
  });
  const botones = opciones.map((o) => ({ id: `vend_cant:${prod.handle}:${o.cantidad}`, titulo: nombre(o.cantidad) }));
  return await enviarInteractivoRevisado(input, ctx, deps, (t) =>
    listaVertical(`${t}\n\n${lineas.join("\n")}\nPagás al recibir.`, prod.imagen!, botones));
}

/**
 * 13-10 (segunda tanda): botones del primer turno con la cantidad ya elegida. El id lleva el producto:
 * `vend_p1:<q1|q2|pack|duda>:<handle>`. "Precios por cantidad" se sacó (se leía como mayorista). Los ids viejos
 * (pedir / cant) siguen llegando de chats anteriores: el prompt los sigue entendiendo.
 */
export const VARIANTE_PRIMER_TURNO = "botones_v2";
export const esPack = (handle: string) => /(^|-)pack(-|$)/.test(handle);

/** Botones según el producto: pack → Quiero el pack / Tengo una duda; con oferta ×2 → Quiero 1 / Quiero 2 · sin envío / Tengo una duda. */
/** 26-10: ajuste del primer mensaje de ese producto (config_wa.vendedor.primer_turno_producto). */
export const primerTurnoDe = (ctx: CtxTurno, handle: string) => extrasVendedor(ctx.cfg.vendedor).primer_turno_producto[handle] ?? {};

/**
 * 26-10 (JawFlex): línea después del precio de 1 con los totales del catálogo ("También tenés los 3 niveles (suave,
 * medio y duro) por ₲188.000 con envío gratis"). Sin la oferta que nombra, no sale (nunca un monto inventado).
 */
export function lineaPrecioProducto(prod: ItemCatalogo, plantilla: string | undefined): string {
  if (!plantilla) return "";
  let falta = false;
  const t = plantilla.replace(/\{total_(\d)\}/g, (_, c) => {
    const o = prod.ofertas.find((x) => x.cantidad === Number(c));
    if (!o) falta = true;
    return o ? `₲${gs(o.total)}` : "";
  });
  return falta ? "" : t;
}

/**
 * 27-10 (Enrique, JawFlex = 1 PAR): el precio entero del primer mensaje desde config (primer_turno_producto.cuerpo_precio).
 * {precio}, {envio}, {total_1}, {total_2}, {total_3} = montos del catálogo. "" si no hay plantilla o falta una oferta.
 */
export function cuerpoPrecioProducto(prod: ItemCatalogo, plantilla: string | undefined): string {
  if (!plantilla) return "";
  let falta = false;
  const t = plantilla
    .replace(/\{precio\}/g, gs(prod.precio)).replace(/\{envio\}/g, gs(ctxEnvio(prod))).replace(/\{total_1\}/g, gs(prod.total))
    .replace(/\{total_(\d)\}/g, (_, c) => {
      const o = prod.ofertas.find((x) => x.cantidad === Number(c));
      if (!o) falta = true;
      return o ? gs(o.total) : "";
    });
  return falta ? "" : t;
}

export function botonesPrimerTurno(prod: ItemCatalogo, sinOferta2 = false, titulos: { q1?: string; q2?: string } = {}): { id: string; titulo: string }[] {
  const b = (clave: string, titulo: string) => ({ id: `vend_p1:${clave}:${prod.handle}`, titulo });
  const q1 = titulos.q1 ?? "Quiero 1", q2 = titulos.q2 ?? "2 con envío gratis";
  if (esPack(prod.handle)) return [b("pack", "Quiero el pack"), b("duda", "Tengo una duda")];
  // 26-10: JawFlex (el 2 solo si lo pide) y Botella ("¿para qué quiero 2?"): sin el botón de 2.
  if (sinOferta2) return [b("q1", q1), b("duda", "Tengo una duda")];
  const x2 = prod.ofertas.find((o) => o.cantidad === 2);
  // 13-10 (Enrique): "envío gratis" vende más que "sin envío", y la mejor opción va primero.
  return x2 && x2.total <= 2 * prod.precio ? [b("q2", q2), b("q1", q1), b("duda", "Tengo una duda")] : [b("q1", q1), b("duda", "Tengo una duda")];
}

/** Segunda burbuja: todos los totales con envío incluido (13-10, Enrique). Los montos salen del catálogo, nunca del modelo. */
export function cuerpoPrimerTurno(prod: ItemCatalogo, sinOferta2 = false): string {
  // 14-10 (Enrique): el precio igual al anuncio. 4 de 5 clientes del 13-10 preguntaron "¿no es 79 mil?" y se fueron.
  // Nunca "1 por 112.000" ni "todo con envío incluido"; el 3 solo si pregunta por más cantidad.
  const base = `Sale ${frasePrecio(prod.precio, ctxEnvio(prod))}, pagás al recibir.`;
  if (esPack(prod.handle) || sinOferta2) return base;
  const x2 = prod.ofertas.find((o) => o.cantidad === 2);
  if (!x2 || x2.total > 2 * prod.precio) return base;
  return `${base} Llevando 2 el envío te sale gratis: ${gs(x2.total)} por los 2.`;
}

/** Envío del ítem (total − precio): el catálogo ya lo trae calculado con la config. */
const ctxEnvio = (prod: ItemCatalogo) => prod.total - prod.precio;

/** Frases que el vendedor usa después del toque (montos permitidos por el filtro porque quedan en el resultado). */
export function frasesCantidad(prod: ItemCatalogo, sinOferta2 = false): Record<string, string> {
  const x2 = prod.ofertas.find((o) => o.cantidad === 2);
  const x3 = prod.ofertas.find((o) => o.cantidad === 3);
  const f: Record<string, string> = {};
  // 26-10: el 2 solo si lo pide (los precios por cantidad siguen en `ofertas` para cuando pregunte).
  if (sinOferta2) return f;
  if (x2 && x2.total <= 2 * prod.precio) f.pasar_a_2 = `Ojo: llevando 2 el envío te sale GRATIS (${gs(x2.total)} los 2)`;
  const menos3 = x3 ? 3 * prod.precio - x3.total : 0;
  if (x2 && x3 && x3.total > x2.total) {
    f.subir_a_3 = `Y por ${gs(x3.total - x2.total)} más te llevás 3: envío gratis${menos3 > 0 ? ` + ${gs(menos3)} menos` : ""} (${gs(x3.total)} en total)`;
  }
  return f;
}

/**
 * 12-10 (plan de conversión, fase 1): gancho en texto + total cerrado con 3 botones. El precio lo arma el sistema
 * (no pasa por el modelo); los datos se piden recién después de "Quiero pedirlo" (regla del prompt).
 */
async function primerTurno(input: Record<string, unknown>, ctx: CtxTurno, deps: DepsHerramientas): Promise<ResultadoHerramienta> {
  let items: ItemCatalogo[];
  try {
    items = itemsCatalogo(await catalogo(deps, ctx), ctx);
  } catch (e) {
    return error(`catalogo_no_disponible: ${e instanceof Error ? e.message : e}. Respondé con frase_precio en texto.`);
  }
  const prod = items.find((x) => x.handle === input.handle);
  if (!prod) return error(`producto_desconocido:${input.handle}. Usá consultar_catalogo y el handle exacto.`);
  // 26-10: primer mensaje por producto (JawFlex: qué es + para qué sirve fijo, foto, precio de 1; Botella: sin el 2).
  const pt = primerTurnoDe(ctx, prod.handle);
  const g = pt.texto ? { ok: true as const, texto: pt.texto } : textoRevisado({ texto: input.gancho }, ctx);
  if (!g.ok) return g.r;
  const linea = lineaPrecioProducto(prod, pt.linea_precio);
  // 27-10 (JawFlex = 1 PAR): con cuerpo_precio, el precio entero sale de config (montos del catálogo).
  const cuerpo = cuerpoPrecioProducto(prod, pt.cuerpo_precio) || (cuerpoPrimerTurno(prod, pt.sin_oferta_2) + (linea ? `\n${linea}` : ""));
  let interactivo: Record<string, unknown>;
  try {
    interactivo = botonesRespuesta(cuerpo, botonesPrimerTurno(prod, pt.sin_oferta_2, pt.botones));
  } catch (e) {
    return error(`interactivo_invalido: ${e instanceof Error ? e.message : e}. Respondé con frase_precio en texto.`);
  }
  const r1 = await deps.enviarTexto(ctx.destino, g.texto, opts(ctx));
  if (!r1.ok) return error(`envio_fallido: ${r1.error}. Respondé con el gancho y frase_precio en texto.`);
  const link = pt.media ? ctx.cfg.media[prod.handle]?.[pt.media] : undefined;
  if (link) {
    const esImagen = /\.(jpe?g|png|webp)(\?|$)/i.test(link); // 26-10: el tipo sale del archivo ("demo" = video)
    const m = await deps.enviarMedia(ctx.destino, esImagen ? "image" : "video", link, null, opts(ctx));
    if (!m.ok) console.warn(`primer_turno: no salió la ${pt.media} de ${prod.handle}: ${m.error}`); // el precio sale igual
  }
  // Pausa de "escribiendo…" proporcional a la segunda burbuja, como entre burbujas de texto (fase 4).
  if (ctx.pausa && ctx.cfg.ritmo) await ctx.pausa(pausaBurbujaMs(cuerpo, ctx.cfg.ritmo, Math.random()));
  const r2 = await deps.enviarInteractivo(ctx.destino, interactivo, opts(ctx));
  if (!r2.ok) {
    return error(`botones_fallidos: ${r2.error}. El gancho YA salió: mandá solo "${cuerpo}" y una pregunta corta, sin repetir el gancho.`);
  }
  return {
    resultado: {
      ok: true,
      enviado: true,
      variante: VARIANTE_PRIMER_TURNO,
      // Quedan en vendedor_turnos: el filtro de los turnos siguientes permite estos montos (×2 / ×3 al pedir los datos).
      frase_precio: prod.frase_precio,
      ofertas: prod.ofertas.map((o) => o.frase_precio),
      ...frasesCantidad(prod, pt.sin_oferta_2),
      ...(pt.sin_oferta_2 ? { nota_cantidad: "De este producto ofrecé 1. El precio de 2 decilo solo si el cliente pide más de uno." } : {}),
      nota: "Ya se le mandaron el gancho y los precios con botones. No escribas nada más.",
    },
    terminal: true,
  };
}

/** 12-10 (fase 2): tu texto + los 3 botones del primer turno (seguimiento 1 después del video de uso). */
async function cierreBotones(input: Record<string, unknown>, ctx: CtxTurno, deps: DepsHerramientas): Promise<ResultadoHerramienta> {
  let items: ItemCatalogo[];
  try {
    items = itemsCatalogo(await catalogo(deps, ctx), ctx);
  } catch (e) {
    return error(`catalogo_no_disponible: ${e instanceof Error ? e.message : e}. Cerrá en texto con una pregunta.`);
  }
  const prod = items.find((x) => x.handle === input.handle);
  if (!prod) return error(`producto_desconocido:${input.handle}. Usá consultar_catalogo y el handle exacto.`);
  const pt = primerTurnoDe(ctx, prod.handle);
  const sin2 = pt.sin_oferta_2;
  return await enviarInteractivoRevisado(input, ctx, deps, (t) =>
    botonesRespuesta(t, botonesPrimerTurno(prod, sin2, pt.botones)),
    { ofertas: prod.ofertas.map((o) => o.frase_precio), ...frasesCantidad(prod, sin2) });
}

/** 12-10: permiso para ofertas (opt-in de Meta) al final, cuando el cliente posterga. Una vez por cliente. */
async function permisoOfertas(input: Record<string, unknown>, ctx: CtxTurno, deps: DepsHerramientas): Promise<ResultadoHerramienta> {
  const ya = deps.consentimiento ? await deps.consentimiento(ctx.clienteId).catch(() => "error" as const) : null;
  if (ya !== null) return { resultado: { ok: true, ya_respondio: true, nota: "Ya respondió el permiso de ofertas (o no se pudo leer): respondé normal, sin preguntarlo." } };
  // 19-10: "el viernes te escribo" no se promete (fuera de 24 h no se puede): se saca esa frase y sigue el permiso.
  const t0 = typeof input.texto === "string" ? quitarPromesaRecontacto(input.texto) : input.texto;
  return await enviarInteractivoRevisado({ ...input, texto: t0 }, ctx, deps, (t) => botonesPermisoOfertas(ctx.clienteId, `${t}\n\n${TEXTO_PERMISO_OFERTAS}`));
}

/** 13-10: pin → calle y ciudad (OpenStreetMap) y confirmación en una línea con "Sí, es ahí" / "Corregir". */
async function confirmarUbicacion(input: Record<string, unknown>, ctx: CtxTurno, deps: DepsHerramientas): Promise<ResultadoHerramienta> {
  const m = /(-?\d{1,3}\.\d+)\s*,\s*(-?\d{1,3}\.\d+)/.exec(String(input.ubicacion ?? ""));
  if (!m) return error("ubicacion_invalida: pasá \"lat,lng\" del mensaje [ubicación].");
  const dir = deps.direccionDePin ? await deps.direccionDePin(Number(m[1]), Number(m[2])).catch(() => null) : null;
  if (!dir?.calle || !dir.ciudad) {
    return { resultado: { ok: true, sin_calle: true, ciudad: dir?.ciudad ?? null, motivo: dir?.motivo ?? (dir ? "sin_calle_en_el_mapa" : "sin_respuesta"), nota: "No salió la calle del mapa, pero con el pin alcanza: no pidas ciudad ni calle; armá el resumen con crear_pedido_cod pasando la ubicacion." } };
  }
  const texto = `¿Es en ${dir.calle}, ${dir.ciudad}?`;
  const r = await deps.enviarInteractivo(ctx.destino, botonesSiNo(texto, "vend_ubi:si", "vend_ubi:no", { si: "Sí, es ahí", no: "Corregir" }), opts(ctx));
  if (!r.ok) return error(`envio_fallido: ${r.error}. Preguntale en texto si es en ${dir.calle}, ${dir.ciudad}.`);
  return { resultado: { ok: true, enviado: true, calle: dir.calle, ciudad: dir.ciudad, ubicacion: `${m[1]},${m[2]}`, nota: "Ya se le preguntó. No escribas nada más." }, terminal: true };
}

/** 13-10 (#1004): cliente que cancela si no le llega → Enrique se entera al instante; el chat sigue con el bot. */
async function avisarEnrique(input: Record<string, unknown>, ctx: CtxTurno, deps: DepsHerramientas): Promise<ResultadoHerramienta> {
  const resumen = String(input.resumen ?? "").trim().slice(0, 300);
  if (input.motivo !== "demora_cancela" || resumen.length < 10) return error("aviso_invalido: motivo demora_cancela y un resumen de 1 oración.");
  const link = enlaceWaMe(ctx.telefono, null);
  const texto = `⚠️ <b>Cliente por cancelar por demora</b>\n${escaparHtml(ctx.nombreCliente ?? "Cliente")}: ${escaparHtml(resumen)}\nDestrabalo con el courier; el bot sigue en el chat.`;
  const r = await deps.avisar(texto, link ? [[{ texto: "Escribirle", url: link }]] : undefined);
  return { resultado: { ok: r.ok, nota: "Enrique ya está avisado. Respondele al cliente sin prometer otro día ni ofrecer cancelar." } };
}

/** "2026-10-16" → "viernes 16/10". */
export function textoFechaCorta(fecha: string): string {
  const [y, m, d] = fecha.split("-").map(Number);
  const dia = ["domingo", "lunes", "martes", "miércoles", "jueves", "viernes", "sábado"][new Date(Date.UTC(y, m - 1, d)).getUTCDay()];
  return `${dia} ${String(d).padStart(2, "0")}/${String(m).padStart(2, "0")}`;
}

/** Primer día posible de entrega ("YYYY-MM-DD") para la ciudad (plazo por courier + corte 15:00 + días hábiles). */
export function fechaMinimaPedido(ciudad: string, ahora: Date, courier?: string | null): string {
  return diaEntrega(ciudad, ahora, courier).desde;
}

/** 13-10 (#1041): el cliente pide un día futuro → se programa en el pedido; antes del plazo, no. */
async function programarEntrega(input: Record<string, unknown>, ctx: CtxTurno, deps: DepsHerramientas): Promise<ResultadoHerramienta> {
  const fecha = String(input.fecha ?? "").trim();
  const franja = typeof input.franja === "string" && input.franja.trim() ? input.franja.trim().slice(0, 40) : null;
  if (!/^\d{4}-\d{2}-\d{2}$/.test(fecha) || !Number.isFinite(Date.parse(fecha))) return error("fecha_invalida: \"YYYY-MM-DD\".");
  const chat = await deps.ultimoPedidoChat(ctx.conversacionId);
  const tienda = deps.pedidoTiendaAbierto ? await deps.pedidoTiendaAbierto(ctx.clienteId).catch(() => null) : null;
  const orderId = chat?.estado === "creado" && chat.shopify_order_id ? chat.shopify_order_id : tienda?.shopify_order_id ?? null;
  if (!orderId) return error("no_hay_pedido_creado: si todavía no confirmó, pasá fecha_entrega en crear_pedido_cod.");
  const pc = deps.pedidoParaCourier ? await deps.pedidoParaCourier(orderId).catch(() => null) : null;
  const dir = (pc?.raw?.shipping_address ?? {}) as Record<string, unknown>;
  const ciudad = String(dir.city ?? chat?.datos?.ciudad ?? "");
  if (ciudad) await deps.consultarCourier?.(ciudad).catch(() => {}); // 26-10: courier de sugerir_courier
  const minima = fechaMinimaPedido(ciudad, ctx.ahora, pc?.courier ?? null);
  if (fecha < minima) {
    return { resultado: { ok: false, antes_de_lo_posible: true, fecha_minima: minima, texto_minima: textoFechaCorta(minima), nota: "Esa fecha es antes de lo posible: ofrecele la fecha mínima, sin prometer antes." } };
  }
  const limite = new Date(ctx.ahora.getTime() + 30 * 86_400_000).toISOString().slice(0, 10);
  if (fecha > limite) return error("fecha_muy_lejana: más de 30 días; pedile una fecha más cercana.");
  if (!deps.programarEntregaOrden) return error("no_disponible: anotalo en la referencia y avisá a Enrique con avisar_enrique.");
  const r = await deps.programarEntregaOrden(orderId, fecha, franja);
  if (!r.ok) return error(`no_se_pudo_programar: ${r.error}`);
  // Si ya salió, shopify-webhook (orders/updated) le manda a Enrique UNA vez el texto para el courier con la fecha.
  return { resultado: { ok: true, programado: true, fecha, texto_fecha: textoFechaCorta(fecha), franja, nota: "Listo: confirmale corto el día (y la franja) y que pagás al recibir." } };
}

/** Datos del turno que no vienen en el input de la herramienta (los pone el orquestador). */
export type ExtraEjecucion = {
  /** Texto que el modelo escribió junto con la llamada, ya revisado por el filtro (null si lo rechazó). */
  textoModelo?: string | null;
};

export type Ejecutor = (input: Record<string, unknown>, ctx: CtxTurno, deps: DepsHerramientas, extra?: ExtraEjecucion) => Promise<ResultadoHerramienta>;

export const EJECUTORES: Record<string, Ejecutor> = {
  ...Object.fromEntries(herramientasPedidosWeb().map((h) => [h.definicion.name, h.ejecutor])),
  // 29-10: guardar_email_factura + guardar_factura con la pregunta del mail (una sola vez). Va después: pisa guardar_factura.
  ...ejecutoresEmailFactura(),
  consultar_catalogo: consultarCatalogo,
  estado_pedido: estadoPedido,
  crear_pedido_cod: crearPedidoCod,
  derivar_a_enrique: (i, c, d, x) =>
    derivarAEnrique({
      motivo: String(i.motivo ?? "otro"),
      resumen: String(i.resumen ?? ""),
      shopify_order_id: i.shopify_order_id as number | undefined,
      texto_previo: x?.textoModelo ?? null,
    }, c, d),
  enviar_media: enviarMediaHerr,
  // El orquestador guarda el perfil en la conversación (wa_conversaciones.perfil_vendedor); acá solo se valida.
  registrar_perfil: registrarPerfil,
  pedir_ubicacion: (i, c, d) => enviarInteractivoRevisado(i, c, d, (t) => ubicacionRequest(t)),
  enviar_formulario: (i, c, d) => {
    const flowId = c.cfg.vendedor.flow_id;
    if (!flowId) return Promise.resolve(error("formulario_no_configurado: pedí los datos por texto, de a uno."));
    return enviarInteractivoRevisado(i, c, d, (t) =>
      flowFormulario({
        flowId,
        token: `pedido:${c.conversacionId}`,
        titulo: texto(c.cfg.textos, "formulario_titulo", TEXTOS_DEFAULT.formulario_titulo),
        cta: texto(c.cfg.textos, "formulario_cta", TEXTOS_DEFAULT.formulario_cta),
        texto: t,
        pantalla: c.cfg.vendedor.flow_pantalla ?? undefined,
      }));
  },
  enviar_opciones: enviarOpciones,
  primer_turno: primerTurno,
  cierre_botones: cierreBotones,
  permiso_ofertas: permisoOfertas,
  confirmar_ubicacion: confirmarUbicacion,
  avisar_enrique: avisarEnrique,
  programar_entrega: programarEntrega,
  datos_transferencia: datosTransferencia,
  actualizar_direccion: actualizarDireccion,
  pedir_telefono: (i, c, d) => {
    if (c.telefono) return Promise.resolve({ resultado: { ok: true, ya_tiene_telefono: true, nota: "El cliente ya tiene teléfono; seguí." } });
    return enviarInteractivoRevisado(i, c, d, (t) => pedirContacto(t));
  },
};

/** Ejecuta una herramienta; nunca lanza (un error vuelve al modelo como tool_result con is_error). */
export async function ejecutarHerramienta(
  nombre: string,
  input: Record<string, unknown>,
  ctx: CtxTurno,
  deps: DepsHerramientas,
  extra?: ExtraEjecucion,
): Promise<ResultadoHerramienta> {
  const ej = EJECUTORES[nombre];
  if (!ej) return error(`herramienta_desconocida:${nombre}`);
  try {
    return await ej(input ?? {}, ctx, deps, extra);
  } catch (e) {
    return error(`falla_interna: ${e instanceof Error ? e.message : String(e)}. Derivá a Enrique con motivo falla_herramienta.`);
  }
}

export type { PedidoChat };

// 18-10 (Enrique: stock real): si un producto está agotado, no se ofrece ni se confirma; se ofrece otro DISPONIBLE de la
// misma línea (sueño/respiración, cuidado diario, entrenamiento) y, si no hay, cualquiera disponible.
export function lineaProducto(titulo: string): string {
  const t = titulo.toLowerCase();
  if (/tira|nasal|parche|bucal|pack|gudair/.test(t)) return "sueño";
  if (/raspador|lengua|botella/.test(t)) return "cuidado";
  if (/jaw|mand[ií]bula|ejercitador/.test(t)) return "entrenamiento";
  return "otros";
}
export function mensajeSinStock(prod: { handle: string; titulo: string }, items: Array<{ handle: string; titulo: string; disponible: boolean }>): string {
  const disp = items.filter((x) => x.disponible && x.handle !== prod.handle);
  const misma = disp.filter((x) => lineaProducto(x.titulo) === lineaProducto(prod.titulo));
  const alts = (misma.length ? misma : disp).slice(0, 3);
  return `sin_stock:${prod.handle}. Está agotado: no lo ofrezcas ni lo confirmes. ` + (alts.length
    ? `Ofrecé en su lugar: ${alts.map((a) => `${a.titulo} (${a.handle})`).join(", ")}.`
    : "No hay otro disponible: decí que se repone pronto, sin inventar fecha, y avisá a Enrique.");
}
