// Tipos compartidos de la ola 1 (WhatsApp post-venta). Fuente: supabase/CONTRATO-OLA1.md

export type EstadoEnvio =
  | "EN_PREPARACION"
  | "DESPACHADO"
  | "INTENTO_FALLIDO"
  | "ENTREGADO"
  | "NO_ENTREGADO_RESCATABLE"
  | "NO_ENTREGADO"
  | "CANCELADO"
  | "RENDIDO";

export type EstadoConfirmacion =
  | "pendiente"
  | "confirmado"
  | "a_corregir"
  | "cancelado_cliente"
  | "retenido"
  | "cancelado_sin_respuesta";

export type FuenteEvento = "whatsapp" | "shopify" | "telegram" | "courier";
export type CategoriaPlantilla = "utilidad" | "marketing";
export type Tienda = "fw" | "voltra";

/** Fechas: Supabase las devuelve como string ISO (timestamptz). */
type Ts = string;
type Json = unknown;

export interface WaCliente {
  id: string;
  wa_user_id: string | null; // BSUID
  telefono: string | null; // E.164 +5959XXXXXXXX
  wa_username: string | null;
  nombre: string | null;
  creado_en: Ts;
  actualizado_en: Ts;
}

export interface WaConsentimiento {
  id: string;
  cliente_id: string;
  tipo: CategoriaPlantilla;
  estado: "si" | "no" | "baja";
  origen: "releasit" | "chat" | "boton" | null;
  creado_en: Ts;
}

export interface WaConversacion {
  id: string;
  cliente_id: string;
  estado: "ia" | "humano" | "cerrada";
  asignado_a: string | null;
  ultima_entrada_en: Ts | null;
  origen_anuncio_id: string | null;
  creado_en: Ts;
}

export type EstadoMensaje = "recibido" | "enviado" | "entregado" | "leido" | "fallido";

export interface WaMensaje {
  id: string;
  conversacion_id: string | null;
  cliente_id: string | null;
  direccion: "in" | "out";
  wa_message_id: string | null;
  tipo: string | null;
  texto: string | null;
  contenido: Json | null;
  estado: EstadoMensaje | null;
  categoria_precio: string | null;
  costo_usd: number | null;
  error: Json | null;
  creado_en: Ts;
}

export interface EventoCrudo {
  id: number;
  fuente: FuenteEvento;
  id_externo: string;
  payload: Json | null;
  recibido_en: Ts;
  procesado_en: Ts | null;
  error: string | null;
}

export interface ShopifyPedido {
  shopify_order_id: number;
  nombre: string | null; // '#1001'
  cliente_id: string | null;
  telefono: string | null;
  total: number | null;
  estado_confirmacion: EstadoConfirmacion;
  estado_envio: EstadoEnvio | null;
  courier: string | null;
  tags: string[];
  es_borrador: boolean;
  raw: Json | null;
  creado_en: Ts;
  actualizado_en: Ts;
}

export interface PedidoEstado {
  id: string;
  shopify_order_id: number;
  estado: string;
  fuente: string | null;
  notificado: boolean;
  creado_en: Ts;
}

export interface EnvioProgramado {
  id: string;
  cliente_id: string | null;
  shopify_order_id: number | null;
  plantilla: string;
  variables: Json | null;
  categoria: CategoriaPlantilla;
  enviar_desde: Ts;
  estado: "pendiente" | "enviado" | "cancelado" | "fallido";
  clave_unica: string | null;
  intentos: number;
  ultimo_error: string | null;
  creado_en: Ts;
}

export interface CourierRevision {
  id: string;
  courier: string | null;
  referencia: string | null;
  fila: Json | null;
  motivo: string | null;
  resuelto: boolean;
  creado_en: Ts;
}

export interface ConfigWa {
  clave: string;
  valor: Json;
  actualizado_en: Ts;
}

/** Valores de config_wa (semillas en supabase/seed_config_wa.sql). */
export interface HorarioMarketingCfg {
  desde: number; // hora local Asunción, inclusiva
  hasta: number; // hora local Asunción, exclusiva
}
export interface PlazosCourierCfg {
  lucero: string;
  pap: string;
}
export interface TarifasUsdCfg {
  utilidad: number;
  marketing: number;
}
export interface ConfirmacionCfg {
  recordatorio_h: number;
  retener_h: number;
  cancelar_h: number;
}
