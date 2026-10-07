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
  telefono: string;
  lineas: LineaPedido[];
  envio: number;
  total: number;
  factura?: string | null;
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
  catalogoShopify(estado: string): Promise<ProductoShopify[]>;
  pedidosDeCliente(clienteId: string, telefono: string | null): Promise<PedidoCliente[]>;
  guardarPedidoChat(fila: Omit<PedidoChat, "id" | "creado_en"> & { id?: string }): Promise<PedidoChat>;
  ultimoPedidoChat(conversacionId: string): Promise<PedidoChat | null>;
  crearOrdenShopify(input: Record<string, unknown>): Promise<ResultadoOrden>;
  /** Mismo camino que un pedido de Releasit: upsert en shopify_pedidos + confirmación programada. */
  registrarComoReleasit(nodo: Record<string, unknown>): Promise<void>;
  pasarAHumano(conversacionId: string): Promise<void>;
  avisar(textoHtml: string, botones?: BotonTelegram[][]): Promise<{ ok: boolean; error?: string }>;
  enviarTexto(to: string, texto: string, opts: OpcionesEnvio): Promise<ResultadoEnvio>;
  enviarInteractivo(to: string, interactive: Record<string, unknown>, opts: OpcionesEnvio): Promise<ResultadoEnvio>;
  enviarMedia(to: string, tipo: "image" | "video", link: string, caption: string | null, opts: OpcionesEnvio): Promise<ResultadoEnvio>;
  normalizarTelefono(x: string): string | null;
  /** Reloj en ms para la caché del catálogo (tests). */
  ahoraMs?: () => number;
};
