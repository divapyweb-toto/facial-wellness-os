// _shared/vendedor/tipos.ts · Dueño: G1 (ola 2)
// Tipos compartidos del vendedor con IA (configuración, contexto del turno y filas de datos).
import type { BotonTelegram } from "../telegram_formato.ts";
import type { OpcionesEnvio, ResultadoEnvio } from "../wa.ts";
import type { EntradaGlosario, FichaCfg } from "./prompt.ts";
import type { CfgRitmo } from "./ritmo.ts";
import type { CfgRespuestasFijas } from "./respuestas_fijas.ts";

/** config_wa.vendedor (semilla en supabase/seed_vendedor.sql). Si falta una clave se usa el default del código. */
export type CfgVendedor = {
  modelo: string;
  modelo_alternativo?: string;
  max_tokens: number;
  max_iteraciones: number;
  max_turnos_conversacion: number;
  tope_mensual_usd: number;
  /** Mensajes del historial que viajan al modelo (los más nuevos). El perfil del cliente va aparte, resumido. */
  historial_mensajes: number;
  /**
   * Segundos de silencio que se esperan antes de responder para juntar mensajes seguidos del cliente: cada
   * mensaje nuevo reinicia la espera y responde solo el turno del último, con todo junto. La demora de
   * "leer + escribir" está en config_wa.vendedor_ritmo.
   */
  espera_agrupar_s: number;
  cache_ttl: "5m" | "1h";
  /** Solo modelos que lo aceptan (no Haiku 4.5). */
  esfuerzo?: "low" | "medium" | "high" | null;
  fallback_servidor?: boolean;
  /** Número del WhatsApp manual de Enrique (dígitos con 595). NO va en el repo: se carga con SQL. */
  whatsapp_enrique?: string | null;
  catalogo_cache_min: number;
  catalogo_estado: string;
  cantidad_max: number;
  flow_id?: string | null;
  flow_pantalla?: string | null;
  max_caracteres?: number;
  /**
   * Horas sin señales de Enrique (bandeja, "Le escribo yo", derivación dura) tras las cuales un chat en 'humano'
   * vuelve a la IA cuando el cliente escribe (wa-webhook/procesar.ts → debeRetomarHumano). 0 = nunca.
   */
  retomar_humano_h?: number;
};

export const CFG_VENDEDOR_DEFAULT: CfgVendedor = {
  modelo: "claude-haiku-4-5-20251001",
  modelo_alternativo: "claude-sonnet-5-5",
  max_tokens: 600,
  max_iteraciones: 6,
  max_turnos_conversacion: 20,
  tope_mensual_usd: 45,
  historial_mensajes: 12,
  espera_agrupar_s: 8,
  cache_ttl: "1h",
  esfuerzo: "low",
  fallback_servidor: true,
  whatsapp_enrique: null,
  catalogo_cache_min: 10,
  catalogo_estado: "ACTIVE",
  cantidad_max: 3,
  flow_id: null,
  flow_pantalla: "PEDIDO",
  max_caracteres: 500,
  retomar_humano_h: 3,
};

export type EnvioVendedor = { costo_gs: number; plazo: string; texto?: string };

/** Precios por cantidad que no están en Shopify (ofertas de Releasit): {handle: {"2": 125000, "3": 155000}}. */
export type OfertasCantidad = Record<string, Record<string, number>>;

/** Fotos y videos por producto (config_wa.vendedor_media): {handle: {video?: url, uso?: url, foto?: url}}. */
export type MediaProductos = Record<string, Record<string, string>>;

/** config_wa.vendedor_estilo: frases que suenan a bot o que mienten (las usa el filtro de salida). */
export type CfgEstilo = { muletillas: string[]; urgencia: string[]; niega_ia: string[] };

export type ConfigTurno = {
  vendedor: CfgVendedor;
  envio: EnvioVendedor;
  glosario: EntradaGlosario[];
  fichas: Record<string, FichaCfg>;
  /** 21-10: dirección, días y horario del retiro en CDE + a quién escribir antes (config_wa.vendedor_retiro, texto). */
  retiro?: string | null;
  afirmaciones: string[];
  aceptaciones: string[];
  prohibidas: string[];
  promesasSalud: string[];
  ofertas: OfertasCantidad;
  media: MediaProductos;
  textos: Record<string, string>;
  plantillaPrompt: string | null;
  ritmo: CfgRitmo;
  respuestasFijas: CfgRespuestasFijas;
  estilo: CfgEstilo;
  /** Datos de la cuenta para transferir (config_wa.pago_anticipado.banco), ya armados en líneas. null = no hay. */
  transferencia?: string | null;
};

/** Datos del turno que conocen las herramientas. */
export type CtxTurno = {
  conversacionId: string;
  clienteId: string;
  /** Teléfono (+595…) o BSUID: a dónde se responde. */
  destino: string;
  telefono: string | null;
  waUserId: string | null;
  nombreCliente: string | null;
  /** Texto del mensaje del cliente que disparó este turno (ya transcripto si era audio). */
  textoEntrada: string;
  mensajeEntradaId: string;
  ahora: Date;
  cfg: ConfigTurno;
  /** Revisa un texto que el modelo quiere mandar dentro de un interactivo (mismo filtro que la respuesta). */
  revisar: (texto: string) => { ok: boolean; motivos: string[] };
  /** 12-10: pausa con "escribiendo…" entre dos burbujas que manda una herramienta (ausente en pruebas = sin pausa). */
  pausa?: (ms: number) => Promise<void>;
};

export type ProductoShopify = {
  id: string;
  handle: string;
  title: string;
  status?: string;
  imagen: string | null;
  variantes: { id: string; title: string; price: number; disponible: boolean }[];
};

export type PedidoCliente = {
  shopify_order_id: number;
  nombre: string | null;
  estado_confirmacion: string;
  estado_envio: string | null;
  courier: string | null;
  total: number | null;
  creado_en: string | null;
  ultimo_estado?: { estado: string; creado_en: string } | null;
};

export type PedidoChat = {
  id: string;
  conversacion_id: string;
  cliente_id: string;
  estado: "resumen" | "creado" | "fallido" | "cancelado";
  datos: DatosPedidoChat;
  total: number;
  shopify_order_id: number | null;
  creado_en: string;
};

export type LineaPedido = {
  handle: string;
  titulo: string;
  variante_id: string;
  cantidad: number;
  /** Total de la línea (precio de lista × cantidad, o el precio de la oferta por cantidad). */
  total: number;
};

export type DatosPedidoChat = {
  nombre: string;
  ciudad: string;
  direccion: string;
  referencia: string | null;
  ubicacion: string | null;
  /** 13-10: la calle y la ciudad salieron del pin y el cliente las confirmó (para medir). */
  calleDePin?: boolean;
  /** 20-10: salió solo con la ciudad (etiqueta UBICACION_PENDIENTE; el dato se pide antes del despacho). */
  ubicacionPendiente?: boolean;
  /** 21-10: 2 productos distintos, 1 de cada, a precio de lista y envío 0 (etiqueta OFERTA_2_DISTINTOS). */
  oferta2Distintos?: boolean;
  /** 21-10: color que eligió el cliente (va a la nota del pedido). */
  color?: string;
  /** 13-10: entrega programada que pidió el cliente ("YYYY-MM-DD", Asunción) y franja opcional ("antes de las 12"). */
  entregaProgramada?: { fecha: string; franja: string | null };
  telefono: string;
  lineas: LineaPedido[];
  envio: number;
  total: number;
  factura?: string | null;
  /** 10-10: factura validada ("4012344-3") y razón social; facturaInvalida = el cliente insistió con un RUC que no da. */
  facturaRuc?: string | null;
  facturaRazon?: string | null;
  facturaInvalida?: boolean;
  /** 09-10: retira en la oficina de CDE (sin envío; no va al courier). */
  retiro?: boolean;
};

export type ResultadoOrden = {
  ok: boolean;
  shopify_order_id?: number;
  gid?: string;
  nombre?: string;
  total?: number | null;
  nodo?: Record<string, unknown>;
  error?: string;
};

export type DepsHerramientas = {
  /** 19-10 (paquete 1): buscar, modificar pedidos y guardar factura (pedidos_web.ts). */
  pedidosWeb?: import("./pedidos_web.ts").DepsPedidosWeb;
  catalogoShopify(estado: string): Promise<ProductoShopify[]>;
  pedidosDeCliente(clienteId: string, telefono: string | null): Promise<PedidoCliente[]>;
  guardarPedidoChat(fila: Omit<PedidoChat, "id" | "creado_en"> & { id?: string }): Promise<PedidoChat>;
  ultimoPedidoChat(conversacionId: string): Promise<PedidoChat | null>;
  /** Textos del cliente (texto_vendedor o texto) en la conversación desde `desdeISO`, del más viejo al más nuevo (08-10). */
  entradasDesde?(conversacionId: string, desdeISO: string): Promise<string[]>;
  /** Cambia la dirección de envío de un pedido ya creado en Shopify (solo los campos que vienen). 08-10. */
  actualizarDireccionOrden?(orderId: number, d: { direccion?: string; referencia?: string }): Promise<{ ok: boolean; error?: string }>;
  /** Último pedido de la tienda del cliente sin despachar ni cancelar (≤ 72 h), aunque no lo haya creado el bot. 09-10. */
  pedidoTiendaAbierto?(clienteId: string): Promise<{ shopify_order_id: number; creado_en: string; en_reintento?: boolean } | null>;
  /** Pedido guardado + courier asignado (para el texto que se reenvía al courier). 10-10. */
  /** 13-10: guarda la entrega programada en Shopify (tag ENTREGA_PROGRAMADA + atributos entrega_programada / entrega_franja). */
  programarEntregaOrden?(orderId: number, fecha: string, franja: string | null): Promise<{ ok: boolean; error?: string }>;
  pedidoParaCourier?(orderId: number): Promise<{ nombre: string; telefono: string | null; raw: Record<string, unknown> | null; courier: string | null; despachado: boolean } | null>;
  crearOrdenShopify(input: Record<string, unknown>): Promise<ResultadoOrden>;
  /** Mismo camino que un pedido de Releasit: upsert en shopify_pedidos + confirmación programada. */
  registrarComoReleasit(nodo: Record<string, unknown>): Promise<void>;
  pasarAHumano(conversacionId: string): Promise<void>;
  avisar(textoHtml: string, botones?: BotonTelegram[][]): Promise<{ ok: boolean; error?: string }>;
  enviarTexto(to: string, texto: string, opts: OpcionesEnvio): Promise<ResultadoEnvio>;
  enviarInteractivo(to: string, interactive: Record<string, unknown>, opts: OpcionesEnvio): Promise<ResultadoEnvio>;
  /** 12-10: último consentimiento de marketing del cliente (null = nunca respondió). Ausente en pruebas viejas. */
  consentimiento?(clienteId: string): Promise<"si" | "no" | "baja" | "preguntado" | null>;
  /** 12-10: estado de la oferta de pago con prioridad del pedido (envios_programados prio:<id>), null si no hay. */
  estadoOfertaPrioridad?(shopifyOrderId: number): Promise<string | null>;
  /** 13-10: calle y ciudad del pin (OpenStreetMap, solo lat/lng; con caché). null si no se pudo. */
  direccionDePin?(lat: number, lng: number): Promise<{ calle: string | null; ciudad: string | null; motivo?: string } | null>;
  enviarMedia(to: string, tipo: "image" | "video", link: string, caption: string | null, opts: OpcionesEnvio): Promise<ResultadoEnvio>;
  normalizarTelefono(x: string): string | null;
  /** Reloj en ms para la caché del catálogo (tests). */
  ahoraMs?: () => number;
};
