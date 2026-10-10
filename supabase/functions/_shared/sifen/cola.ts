// _shared/sifen/cola.ts · Dueño: E. Cola de facturación SIFEN — lógica pura (todo el I/O entra por DepsCola).
//
// Qué hace cada corrida (sifen-cola, cron cada 10 min; también la llama post-entrega vía factura/io.ts):
//   1. Pedidos ENTREGADO o RENDIDO (decisión de Enrique 08-10: RENDIDO = entregado) sin factura → una FE por pedido.
//      Nunca: devueltos/NO_ENTREGADO, cancelados, borradores ni pruebas (motivoNoFacturable).
//   2. Facturas pendiente/enviada/error con proximo_intento vencido → reintento con espera creciente
//      (si ya hubo envío, el emisor CONSULTA el CDC antes de reenviar: nunca duplica).
//      Aprobadas sin KuDE o sin WhatsApp → se completan.
//   3. Devoluciones: FE aprobada cuyo pedido pasó a NO_ENTREGADO/CANCELADO:
//        - si el pedido había sido RENDIDO → NO se toca: estado 'revisar' + Telegram (decisión de Enrique 08-10);
//        - si no: dentro del plazo de cancelación (48 h FE) → evento de cancelación (antes se cancelan sus NC);
//          fuera de plazo → nota de crédito (tipo 5) por el total asociada por CDC. Telegram en ambos casos.
//   Un error en un pedido no frena al resto (try/catch por ítem).
//
// Blindaje 10-10 (agente P1):
//   - Corte obligatorio: con activo=true y facturar_desde vacío NO se factura nada nuevo (aviso por Telegram, 1 por hora).
//     Ventana de la cola = desde max(facturar_desde, ahora − dias_atras), solo por entregado_en.
//   - facturarPedido (cola, post-entrega y llamada manual) respeta el corte: entregado_en < facturar_desde → se registra
//     en facturas_retenidas ('anterior_al_corte') y NO se factura. Un pedido retenido sin liberar nunca se factura;
//     al liberarlo (RPC sifen_liberar, con el criterio de la contadora) lo toma la cola por liberadosSinFactura.
//   - Ventas directas (showroom/mayorista): EN ESPERA (decisión de Enrique 10-10). La cola no las toca.
// Idempotencia: índice único parcial (una FE por pedido, una NC por factura) + lease atómico (tomarLease)
//   + número asignado en SQL junto con la fila (sifen_asignar_numero: sin saltos ni duplicados).

import type { DocumentoDE, RespuestaSifen, TipoDE } from "./tipos.ts";
import {
  type BaseDocumento,
  CONFIG_DESDE_PEDIDO_DEFECTO,
  type ConfigDesdePedido,
  documentoDesdePedido,
  esDevuelto,
  esFacturable,
  motivoNoFacturable,
  notaCreditoDesdeFactura,
  type PedidoSifen,
} from "./desde_pedido.ts";
import type { EmisorCola } from "./emisor.ts";

/** Fila de public.facturas_retenidas (migración 20261010000010). */
export interface Retencion {
  motivo: string;
  liberado_en: string | null;
}

export type EstadoFactura = "pendiente" | "enviada" | "aprobada" | "rechazada" | "cancelada" | "revisar" | "error" | "inutilizada";

/** Fila de public.facturas (esquema del contrato; solo las columnas que usa la cola). */
export interface FilaFactura {
  id: string;
  shopify_order_id: number | null;
  tipo_documento: TipoDE;
  establecimiento: string;
  punto: string;
  timbrado: string | null;
  numero: number | null;
  numero_completo: string | null;
  cdc: string | null;
  codigo_seguridad: string | null;
  estado: EstadoFactura;
  ambiente: "test" | "prod";
  emisor: "propio" | "facturasend";
  simulado: boolean;
  receptor_tipo?: string | null;
  ruc?: string | null;
  razon_social?: string | null;
  total?: number | null;
  iva10?: number | null;
  iva5?: number | null;
  base10?: number | null;
  base5?: number | null;
  exento?: number | null;
  xml_firmado?: string | null;
  url_qr?: string | null;
  kude_path?: string | null;
  fecha_emision: string | null; // timestamptz ISO
  enviada_en?: string | null;
  aprobada_en?: string | null;
  cancelada_en?: string | null;
  codigo_respuesta?: string | null;
  motivo_rechazo?: string | null;
  error?: string | null;
  factura_original_id?: string | null;
  intentos: number;
  proximo_intento?: string | null;
  lease_hasta?: string | null;
  kude_enviado_en?: string | null;
}

export interface EventoSifen {
  factura_id: string | null;
  tipo: "cancelacion" | "inutilizacion" | string;
  rango?: { tipo: TipoDE; establecimiento: string; punto: string; desde: number; hasta: number; timbrado?: string } | null;
  motivo: string;
  estado: "pendiente" | "enviado" | "aprobado" | "rechazado";
  respuesta?: unknown;
  codigo?: string | null;
  enviado_en?: string | null;
}

export interface ConfigSifen extends ConfigDesdePedido {
  activo: boolean;
  emisor: "propio" | "facturasend";
  /** Datos del emisor (DatosEmisor). No son secretos; van en config_wa['sifen'].datos_emisor (lo lee sifen-cola/io.ts). */
  datos_emisor?: unknown;
  /**
   * Corte OBLIGATORIO al activar (ISO): solo se factura lo entregado desde esta fecha. Con activo=true y null no se
   * factura nada nuevo. Lo anterior que llegue por post-entrega o llamada manual queda en facturas_retenidas.
   */
  facturar_desde: string | null;
  dias_atras: number;
  lote: number;
  max_intentos: number;
  /** Esperas entre reintentos (minutos), por número de intento. */
  esperas_min: number[];
  lease_min: number;
  enviar_whatsapp: boolean;
  plantilla_factura: string;
  dias_reintento_whatsapp: number;
  /** Aviso si un DE firmado sigue sin respuesta de SIFEN tras N horas (plazo legal 72 h). */
  horas_alerta_pendiente: number;
  /** Rango máximo por evento de inutilización (MT v150: hasta 1000 números). */
  max_rango_inutilizacion: number;
  /** Plazo del evento de cancelación por tipo de DE, en horas. MT v150: FE 48 h; resto 168 h. [VERIFICAR MT §Eventos] */
  horas_cancelacion: Record<string, number>;
  motivo_cancelacion: string;
  /** iMotEmi de la NC por devolución. [VERIFICAR MT v150 tabla iMotEmi] */
  motivo_nota_credito: number;
  /** Inutilización */
  inutilizacion_auto: boolean;
  dia_aviso_inutilizacion: number; // aviso Telegram desde este día del mes
  dia_limite_inutilizacion: number; // plazo: este día del mes siguiente [VERIFICAR MT/DNIT]
  dias_gracia_inutilizacion: number; // un error/rechazo se considera definitivo después de N días
  motivo_inutilizacion: string;
}

export const CONFIG_SIFEN_DEFECTO: ConfigSifen = {
  ...CONFIG_DESDE_PEDIDO_DEFECTO,
  activo: false,
  emisor: "propio",
  facturar_desde: null,
  dias_atras: 2,
  lote: 20,
  max_intentos: 8,
  esperas_min: [5, 10, 20, 40, 60, 120, 240, 480],
  lease_min: 5,
  enviar_whatsapp: true,
  plantilla_factura: "voltra_factura",
  dias_reintento_whatsapp: 3,
  horas_alerta_pendiente: 48,
  max_rango_inutilizacion: 1000,
  horas_cancelacion: { "1": 48, "4": 168, "5": 168, "6": 168, "7": 168 },
  motivo_cancelacion: "Pedido devuelto: el cliente no recibió la mercadería",
  motivo_nota_credito: 2,
  inutilizacion_auto: true,
  dia_aviso_inutilizacion: 10,
  dia_limite_inutilizacion: 15,
  dias_gracia_inutilizacion: 2,
  motivo_inutilizacion: "Numeración no utilizada por error del sistema",
};

export function configSifen(valor: unknown): ConfigSifen {
  const v = valor && typeof valor === "object" ? valor as Partial<ConfigSifen> : {};
  const c = { ...CONFIG_SIFEN_DEFECTO, ...v } as ConfigSifen;
  c.facturar_desde = typeof v.facturar_desde === "string" && !Number.isNaN(new Date(v.facturar_desde).getTime()) ? v.facturar_desde : null;
  c.activo = v.activo === true;
  c.emisor = v.emisor === "facturasend" ? "facturasend" : "propio";
  c.horas_cancelacion = { ...CONFIG_SIFEN_DEFECTO.horas_cancelacion, ...(v.horas_cancelacion ?? {}) };
  return c;
}

export interface DepsCola {
  ahora(): Date;
  aleatorio(): number;
  cfg: ConfigSifen;
  ambiente: "test" | "prod";
  simulado: boolean;
  timbrado: string;
  emisor: EmisorCola;
  fechaSifen(d: Date): string;
  codigoSeguridad(): string;
  /** ENTREGADO/RENDIDO con entregado_en ≥ desde, sin FE del ambiente y SIN retención (liberada o no). */
  pedidosSinFactura(desdeIso: string, limite: number): Promise<PedidoSifen[]>;
  /** Pedidos con retención LIBERADA y sin FE del ambiente (los toma la cola aunque estén fuera de la ventana). */
  liberadosSinFactura(limite: number): Promise<PedidoSifen[]>;
  retencion(orderId: number): Promise<Retencion | null>;
  /** INSERT en facturas_retenidas (si ya existe, no hace nada). */
  retener(orderId: number, motivo: string, nota: string): Promise<void>;
  facturasVencidas(ahoraIso: string, limite: number): Promise<FilaFactura[]>;
  /** FE (tipo 1) aprobadas cuyo pedido figura NO_ENTREGADO/CANCELADO. */
  facturasDevueltas(limite: number): Promise<Array<{ factura: FilaFactura; pedido: PedidoSifen }>>;
  leerPedido(id: number): Promise<PedidoSifen | null>;
  leerFactura(id: string): Promise<FilaFactura | null>;
  facturaDePedido(orderId: number): Promise<FilaFactura | null>;
  notasDeFactura(id: string): Promise<FilaFactura[]>;
  /** INSERT; si choca con el índice único parcial devuelve null (ya existe). */
  crearFactura(f: Partial<FilaFactura>): Promise<FilaFactura | null>;
  /** UPDATE atómico: toma la fila si no tiene lease vigente. */
  tomarLease(id: string, hastaIso: string, ahoraIso: string): Promise<boolean>;
  /** SQL sifen_asignar_numero: si la fila no tiene número, reserva el siguiente y lo graba en la MISMA transacción. */
  asignarNumero(id: string, args: { codigoSeguridad: string; fechaEmision: string }): Promise<{ numero: number; numero_completo: string; codigo_seguridad: string; fecha_emision: string }>;
  actualizar(id: string, cambios: Partial<FilaFactura>): Promise<void>;
  registrarEvento(e: EventoSifen): Promise<void>;
  subirKude(f: FilaFactura, pdf: Uint8Array): Promise<string>;
  enviarKude(f: FilaFactura, pedido: PedidoSifen | null): Promise<{ ok: boolean; error?: string }>;
  avisar(html: string): Promise<unknown>;
  escapar(s: unknown): string;
}

export type AccionCola =
  | "bandera_apagada"
  | "no_facturable"
  | "ya_existe"
  | "en_curso"
  | "revisar"
  | "aprobada"
  | "enviada"
  | "rechazada"
  | "error"
  | "max_intentos"
  | "kude_enviado"
  | "cancelada"
  | "nota_credito"
  | "sin_cambios"
  | "retenido"
  | "sin_corte";

export interface ResultadoItem {
  ref: string; // pedido o factura
  accion: AccionCola;
  detalle?: string;
}

export interface ResumenCola {
  nuevos: ResultadoItem[];
  reintentos: ResultadoItem[];
  devoluciones: ResultadoItem[];
  errores: string[];
  /** true si activo=true pero falta facturar_desde (no se facturó nada nuevo). */
  sin_corte?: boolean;
}

const msj = (e: unknown) => (e instanceof Error ? e.message : String(e));

export function proximoIntento(intentos: number, ahora: Date, esperasMin: number[]): string {
  const m = esperasMin[Math.min(Math.max(intentos - 1, 0), esperasMin.length - 1)] ?? 60;
  return new Date(ahora.getTime() + m * 60_000).toISOString();
}

export const MOTIVO_SIN_CORTE = "falta facturar_desde en config_wa['sifen']: el corte es obligatorio al activar, no se factura nada nuevo";

/** Desde cuándo mira la cola: max(facturar_desde, ahora − dias_atras). null = falta el corte (no se factura nada nuevo). */
export function desdeFacturar(cfg: ConfigSifen, ahora: Date): string | null {
  if (!cfg.facturar_desde) return null;
  const minimo = ahora.getTime() - cfg.dias_atras * 86_400_000;
  const corte = new Date(cfg.facturar_desde).getTime();
  return new Date(Math.max(minimo, corte)).toISOString();
}

/** El pedido se entregó antes del corte (sin fecha de entrega no se puede saber: lo decide quien llama). */
export function anteriorAlCorte(entregadoEn: string, facturarDesde: string): boolean {
  return new Date(entregadoEn).getTime() < new Date(facturarDesde).getTime();
}

// ─── 1. Pedido → factura ─────────────────────────────────────

/**
 * Factura un pedido (idempotente). Lo usan la cola, post-entrega y la llamada manual (sifen-cola con shopify_order_id).
 * `op.entregadoEn`: fecha de entrega que post-entrega acaba de calcular y todavía no guardó (solo si la fila no la tiene).
 */
export async function facturarPedido(pedidoOId: number | PedidoSifen, d: DepsCola, op: { entregadoEn?: string | null } = {}): Promise<ResultadoItem> {
  let ped = typeof pedidoOId === "number" ? await d.leerPedido(pedidoOId) : pedidoOId;
  const ref = `pedido ${typeof pedidoOId === "number" ? pedidoOId : pedidoOId.shopify_order_id}`;
  if (!ped) return { ref, accion: "no_facturable", detalle: "no existe" };
  if (!d.cfg.facturar_desde) return { ref, accion: "sin_corte", detalle: MOTIVO_SIN_CORTE };
  if (!ped.entregado_en && op.entregadoEn) ped = { ...ped, entregado_en: op.entregadoEn };
  if (!esFacturable(ped.estado_envio)) return { ref, accion: "no_facturable", detalle: `estado_envio ${ped.estado_envio}` };
  const no = motivoNoFacturable(ped, d.cfg);
  if (no) return { ref, accion: "no_facturable", detalle: no };

  const previa = await d.facturaDePedido(ped.shopify_order_id);
  if (previa) return { ref, accion: "ya_existe", detalle: previa.estado };

  // Retenido (anterior al corte u otro motivo) y sin liberar: nunca se factura solo.
  const ret = await d.retencion(ped.shopify_order_id);
  if (ret && !ret.liberado_en) return { ref, accion: "retenido", detalle: ret.motivo };
  if (!ret) {
    if (!ped.entregado_en) return { ref, accion: "no_facturable", detalle: "sin fecha de entrega (entregado_en): lo toma la cola cuando se guarde" };
    if (anteriorAlCorte(ped.entregado_en, d.cfg.facturar_desde)) {
      await d.retener(ped.shopify_order_id, "anterior_al_corte", `entregado ${ped.entregado_en} < facturar_desde ${d.cfg.facturar_desde}`);
      return { ref, accion: "retenido", detalle: "anterior_al_corte" };
    }
  }

  // Validación ANTES de reservar número (un número reservado y no usado obliga a inutilizarlo).
  const prueba = documentoDesdePedido(ped, d.cfg, { numero: 1, fechaEmision: d.fechaSifen(d.ahora()), codigoSeguridad: "000000001" });
  const base: Partial<FilaFactura> = {
    shopify_order_id: ped.shopify_order_id,
    tipo_documento: 1,
    establecimiento: d.cfg.establecimiento,
    punto: d.cfg.punto,
    timbrado: d.timbrado,
    ambiente: d.ambiente,
    emisor: d.emisor.nombre,
    simulado: d.simulado,
    intentos: 0,
  };
  if (!prueba.ok) {
    const fila = await d.crearFactura({ ...base, estado: "revisar", error: prueba.motivo });
    if (fila) await d.avisar(`<b>Factura a revisar</b> · pedido ${d.escapar(ped.nombre ?? ped.shopify_order_id)}\n${d.escapar(prueba.motivo)}\nNo se emitió nada.`);
    return { ref, accion: "revisar", detalle: prueba.motivo };
  }
  const fila = await d.crearFactura({
    ...base,
    estado: "pendiente",
    receptor_tipo: prueba.doc.receptor.tipo,
    ruc: prueba.doc.receptor.ruc ? `${prueba.doc.receptor.ruc}-${prueba.doc.receptor.dv}` : null,
    razon_social: prueba.doc.receptor.razonSocial ?? prueba.doc.receptor.nombre ?? null,
    total: prueba.total,
  });
  if (!fila) return { ref, accion: "ya_existe" };
  if (prueba.avisos.length) {
    await d.avisar(`<b>Factura</b> · pedido ${d.escapar(ped.nombre ?? ped.shopify_order_id)}\n${prueba.avisos.map((a) => d.escapar(a)).join("\n")}`);
  }
  return await emitirFila(fila, ped, d);
}

/** Arma el DocumentoDE de una fila (FE desde el pedido; NC desde la FE original). */
async function documentoDeFila(f: FilaFactura, ped: PedidoSifen, base: BaseDocumento, d: DepsCola): Promise<{ ok: true; doc: DocumentoDE } | { ok: false; motivo: string }> {
  if (f.tipo_documento === 1) {
    const r = documentoDesdePedido(ped, d.cfg, base);
    return r.ok ? { ok: true, doc: r.doc } : { ok: false, motivo: r.motivo };
  }
  if (f.tipo_documento === 5) {
    const orig = f.factura_original_id ? await d.leerFactura(f.factura_original_id) : null;
    if (!orig?.cdc || !orig.numero || !orig.codigo_seguridad || !orig.fecha_emision) return { ok: false, motivo: "NC sin factura original aprobada" };
    const fe = documentoDesdePedido(ped, d.cfg, {
      numero: orig.numero,
      fechaEmision: d.fechaSifen(new Date(orig.fecha_emision)),
      codigoSeguridad: orig.codigo_seguridad,
    });
    if (!fe.ok) return { ok: false, motivo: `NC: ${fe.motivo}` };
    return { ok: true, doc: notaCreditoDesdeFactura(fe.doc, orig.cdc, base, d.cfg.motivo_nota_credito) };
  }
  return { ok: false, motivo: `tipo ${f.tipo_documento} no lo emite la cola` };
}

/** Emite (o reintenta) una fila ya creada. Toma el lease, asigna número si falta y guarda TODO antes de soltar. */
export async function emitirFila(f: FilaFactura, ped: PedidoSifen | null, d: DepsCola): Promise<ResultadoItem> {
  const ref = `factura ${f.numero_completo ?? f.id}`;
  const ahora = d.ahora();
  if (!(await d.tomarLease(f.id, new Date(ahora.getTime() + d.cfg.lease_min * 60_000).toISOString(), ahora.toISOString()))) {
    return { ref, accion: "en_curso" };
  }
  const nombre = d.escapar(ped?.nombre ?? f.shopify_order_id ?? f.id);
  try {
    if (!ped) {
      await d.actualizar(f.id, { estado: "error", error: "pedido inexistente", proximo_intento: null });
      return { ref, accion: "error", detalle: "pedido inexistente" };
    }
    // Un FE que todavía no salió y cuyo pedido volvió: no se emite (el número, si tenía, se inutiliza).
    if (f.tipo_documento === 1 && !f.cdc && (esDevuelto(ped.estado_envio) || motivoNoFacturable(ped, d.cfg))) {
      const motivo = `pedido ${esDevuelto(ped.estado_envio) ? "devuelto" : motivoNoFacturable(ped, d.cfg)} antes de emitir`;
      await d.actualizar(f.id, { estado: "error", error: motivo, proximo_intento: null });
      return { ref, accion: "no_facturable", detalle: motivo };
    }

    // Número + código de seguridad + fecha: se fijan UNA vez (mismo CDC en cada reintento).
    let fila = f;
    if (!fila.numero || !fila.codigo_seguridad || !fila.fecha_emision) {
      const n = await d.asignarNumero(f.id, { codigoSeguridad: d.codigoSeguridad(), fechaEmision: ahora.toISOString() });
      fila = { ...fila, ...n };
    }
    const base: BaseDocumento = {
      numero: fila.numero!,
      fechaEmision: d.fechaSifen(new Date(fila.fecha_emision!)),
      codigoSeguridad: fila.codigo_seguridad!,
    };
    const armado = await documentoDeFila(fila, ped, base, d);
    if (!armado.ok) {
      await d.actualizar(f.id, { estado: "revisar", error: armado.motivo, proximo_intento: null });
      await d.avisar(`<b>Factura a revisar</b> · ${nombre}\n${d.escapar(armado.motivo)}`);
      return { ref, accion: "revisar", detalle: armado.motivo };
    }

    const intentos = (fila.intentos ?? 0) + 1;
    const r = await d.emisor.emitir(armado.doc, { cdcPrevio: fila.cdc, xmlFirmadoPrevio: fila.xml_firmado, urlQrPrevio: fila.url_qr });
    const comunes: Partial<FilaFactura> = {
      intentos,
      cdc: r.cdc ?? fila.cdc ?? null,
      numero_completo: r.numeroCompleto ?? fila.numero_completo,
      xml_firmado: r.xmlFirmado ?? fila.xml_firmado ?? null,
      url_qr: r.urlQr ?? fila.url_qr ?? null,
      codigo_respuesta: r.codigo ?? null,
      simulado: r.simulado ?? d.simulado,
      enviada_en: fila.enviada_en ?? ahora.toISOString(),
      ...(r.totales
        ? { total: r.totales.total, iva10: r.totales.iva10, iva5: r.totales.iva5, base10: r.totales.base10, base5: r.totales.base5, exento: r.totales.exento + r.totales.exonerado }
        : {}),
    };

    if (r.estado === "aprobada") {
      const aprob: Partial<FilaFactura> = { ...comunes, estado: "aprobada", aprobada_en: fila.aprobada_en ?? ahora.toISOString(), error: null, motivo_rechazo: null };
      let kudePath = r.kudePath ?? fila.kude_path ?? null;
      if (!kudePath && r.kudePdf) {
        try {
          kudePath = await d.subirKude({ ...fila, ...aprob } as FilaFactura, r.kudePdf);
        } catch (e) {
          aprob.error = `KuDE: ${msj(e)}`;
        }
      } else if (!kudePath) aprob.error = r.mensaje ?? "aprobada sin KuDE";
      aprob.kude_path = kudePath;
      // Queda proximo_intento si falta el KuDE o el WhatsApp.
      const quiereWa = d.cfg.enviar_whatsapp && f.tipo_documento === 1;
      aprob.proximo_intento = !kudePath || (quiereWa && !fila.kude_enviado_en) ? proximoIntento(1, ahora, d.cfg.esperas_min) : null;
      await d.actualizar(f.id, aprob);
      const actual = { ...fila, ...aprob } as FilaFactura;
      if (kudePath && quiereWa && !fila.kude_enviado_en) await enviarKudeWa(actual, ped, d);
      return { ref, accion: "aprobada", detalle: r.simulado ? "SIMULADO" : undefined };
    }
    if (r.estado === "rechazada") {
      await d.actualizar(f.id, { ...comunes, estado: "rechazada", motivo_rechazo: `${r.codigo ?? ""} ${r.mensaje ?? ""}`.trim(), proximo_intento: null });
      await d.avisar(`<b>SIFEN rechazó la factura</b> · ${nombre}\n${d.escapar(r.codigo ?? "")} ${d.escapar(r.mensaje ?? "")}\nCorregir y reintentar, o queda para inutilizar.`);
      return { ref, accion: "rechazada", detalle: r.mensaje };
    }
    // enviada (resultado desconocido) o error → reintento con espera creciente.
    const agotado = intentos >= d.cfg.max_intentos;
    await d.actualizar(f.id, {
      ...comunes,
      estado: r.estado === "enviada" ? "enviada" : "error",
      error: `${r.mensaje ?? r.estado}${(fila.error ?? "").includes(MARCA_48H) ? ` ${MARCA_48H}` : ""}`,
      proximo_intento: agotado ? null : proximoIntento(intentos, ahora, d.cfg.esperas_min),
      // Si nunca llegó a SIFEN, no se marca enviada_en.
      enviada_en: r.estado === "enviada" ? comunes.enviada_en : fila.enviada_en ?? null,
    });
    if (agotado) {
      await d.avisar(
        `<b>Factura sin resolver tras ${intentos} intentos</b> · ${nombre}\n${d.escapar(r.mensaje ?? r.estado)}\n` +
          `El DE firmado tiene plazo de transmisión (72 h [VERIFICAR MT]): revisar hoy.`,
      );
      return { ref, accion: "max_intentos", detalle: r.mensaje };
    }
    return { ref, accion: r.estado === "enviada" ? "enviada" : "error", detalle: r.mensaje };
  } finally {
    await d.actualizar(f.id, { lease_hasta: null }).catch(() => {});
  }
}

async function enviarKudeWa(f: FilaFactura, ped: PedidoSifen | null, d: DepsCola): Promise<ResultadoItem> {
  const ref = `factura ${f.numero_completo ?? f.id}`;
  const ahora = d.ahora();
  const vence = f.aprobada_en && ahora.getTime() - new Date(f.aprobada_en).getTime() > d.cfg.dias_reintento_whatsapp * 86_400_000;
  const r = await d.enviarKude(f, ped).catch((e) => ({ ok: false, error: msj(e) }));
  if (r.ok) {
    await d.actualizar(f.id, { kude_enviado_en: ahora.toISOString(), proximo_intento: null });
    return { ref, accion: "kude_enviado" };
  }
  await d.actualizar(f.id, { proximo_intento: vence ? null : proximoIntento(f.intentos + 1, ahora, d.cfg.esperas_min), error: `WhatsApp: ${r.error ?? "falló"}` });
  return { ref, accion: "error", detalle: `WhatsApp: ${r.error}` };
}

/** Reintento de una fila vencida (pendiente/enviada/error, o aprobada a la que le falta KuDE/WhatsApp). */
export async function reintentarFila(f: FilaFactura, d: DepsCola): Promise<ResultadoItem> {
  const ped = f.shopify_order_id ? await d.leerPedido(f.shopify_order_id) : null;
  if (f.estado === "aprobada") {
    if (!f.kude_path) return await emitirFila(f, ped, d); // con cdcPrevio: consulta, no reenvía
    if (d.cfg.enviar_whatsapp && f.tipo_documento === 1 && !f.kude_enviado_en) return await enviarKudeWa(f, ped, d);
    await d.actualizar(f.id, { proximo_intento: null });
    return { ref: `factura ${f.numero_completo}`, accion: "sin_cambios" };
  }
  if (f.estado === "pendiente" || f.estado === "enviada" || f.estado === "error") {
    if (f.intentos >= d.cfg.max_intentos) {
      await d.actualizar(f.id, { proximo_intento: null });
      return { ref: `factura ${f.numero_completo ?? f.id}`, accion: "max_intentos" };
    }
    await alertaPendienteViejo(f, d);
    return await emitirFila(f, ped, d);
  }
  await d.actualizar(f.id, { proximo_intento: null });
  return { ref: `factura ${f.numero_completo ?? f.id}`, accion: "sin_cambios" };
}

const MARCA_48H = "[alerta 48h]";
/**
 * Un DE firmado se puede transmitir hasta 72 h después de la firma (MT v150 §6.2.1; después 1005 con
 * posible sanción). Si un pendiente/enviada pasa `horas_alerta_pendiente` (48 h) → un solo aviso Telegram.
 */
async function alertaPendienteViejo(f: FilaFactura, d: DepsCola): Promise<void> {
  if (!f.fecha_emision || !f.cdc || (f.error ?? "").includes(MARCA_48H)) return;
  const horas = (d.ahora().getTime() - new Date(f.fecha_emision).getTime()) / 3_600_000;
  if (horas < d.cfg.horas_alerta_pendiente) return;
  await d.avisar(
    `<b>Factura sin confirmar hace ${Math.floor(horas)} h</b> · ${d.escapar(f.numero_completo ?? f.id)}\n` +
      `SIFEN no respondió todavía. Plazo de transmisión: 72 h desde la firma (después sale con observación 1005).`,
  );
  await d.actualizar(f.id, { error: `${f.error ?? ""} ${MARCA_48H}`.trim() });
  f.error = `${f.error ?? ""} ${MARCA_48H}`.trim();
}

// ─── 3. Devoluciones ─────────────────────────────────────────

const aprobado = (r: RespuestaSifen) => r.estado === "aprobado" || r.estado === "aprobado_obs";

export function dentroPlazoCancelacion(f: Pick<FilaFactura, "tipo_documento" | "aprobada_en">, ahora: Date, cfg: ConfigSifen): boolean {
  if (!f.aprobada_en) return false;
  const horas = (ahora.getTime() - new Date(f.aprobada_en).getTime()) / 3_600_000;
  return horas < (cfg.horas_cancelacion[String(f.tipo_documento)] ?? 48);
}

/**
 * Cancela un DE aprobado. Regla del MT: si la FE tiene NC asociadas aprobadas, primero se cancelan las NC.
 * Devuelve ok:false (sin tocar la FE) si alguna NC no se pudo cancelar.
 */
export async function cancelarFactura(f: FilaFactura, motivo: string, d: DepsCola): Promise<{ ok: boolean; detalle: string }> {
  const ahora = d.ahora();
  for (const nc of (await d.notasDeFactura(f.id)).filter((n) => n.estado === "aprobada")) {
    if (!dentroPlazoCancelacion(nc, ahora, d.cfg)) return { ok: false, detalle: `la NC ${nc.numero_completo} está fuera de plazo de cancelación` };
    const rn = await d.emisor.cancelar(nc.cdc!, motivo);
    await d.registrarEvento({ factura_id: nc.id, tipo: "cancelacion", motivo, estado: aprobado(rn) ? "aprobado" : "rechazado", respuesta: rn, codigo: rn.codigo ?? null, enviado_en: ahora.toISOString() });
    if (!aprobado(rn)) return { ok: false, detalle: `no se pudo cancelar la NC ${nc.numero_completo}: ${rn.mensaje ?? rn.estado}` };
    await d.actualizar(nc.id, { estado: "cancelada", cancelada_en: ahora.toISOString() });
  }
  const r = await d.emisor.cancelar(f.cdc!, motivo);
  await d.registrarEvento({ factura_id: f.id, tipo: "cancelacion", motivo, estado: aprobado(r) ? "aprobado" : "rechazado", respuesta: r, codigo: r.codigo ?? null, enviado_en: ahora.toISOString() });
  if (!aprobado(r)) return { ok: false, detalle: `${r.codigo ?? ""} ${r.mensaje ?? r.estado}`.trim() };
  await d.actualizar(f.id, { estado: "cancelada", cancelada_en: ahora.toISOString(), proximo_intento: null });
  return { ok: true, detalle: "cancelada" };
}

export async function procesarDevolucion(f: FilaFactura, ped: PedidoSifen, d: DepsCola): Promise<ResultadoItem> {
  const ref = `factura ${f.numero_completo ?? f.id}`;
  const nombre = d.escapar(ped.nombre ?? ped.shopify_order_id);
  if (f.estado !== "aprobada" || f.tipo_documento !== 1 || !f.cdc) return { ref, accion: "sin_cambios" };
  // Decisión de Enrique 08-10: si ya se había RENDIDO, nada automático.
  if (ped.rendido) {
    await d.actualizar(f.id, { estado: "revisar", error: "pedido RENDIDO y después devuelto: decidir a mano (cancelación o NC)" });
    await d.avisar(`<b>Factura a revisar</b> · pedido ${nombre}\nFiguraba RENDIDO y ahora está ${d.escapar(ped.estado_envio)}. No se canceló ni se hizo NC: decidir a mano.`);
    return { ref, accion: "revisar", detalle: "rendido y devuelto" };
  }
  const notas = await d.notasDeFactura(f.id);
  if (notas.length) return { ref, accion: "sin_cambios", detalle: "ya tiene NC" };

  if (dentroPlazoCancelacion(f, d.ahora(), d.cfg)) {
    const c = await cancelarFactura(f, d.cfg.motivo_cancelacion, d);
    if (c.ok) {
      await d.avisar(`<b>Factura cancelada</b> · pedido ${nombre} (${d.escapar(f.numero_completo)})\nEl pedido volvió dentro de las 48 h.`);
      return { ref, accion: "cancelada" };
    }
    // Si SIFEN no aceptó la cancelación, se sigue con la NC (camino que siempre vale).
    await d.avisar(`<b>No se pudo cancelar</b> · ${d.escapar(f.numero_completo)}: ${d.escapar(c.detalle)}\nSe emite nota de crédito.`);
  }
  // NT-023 (1331): una NC no puede ser innominada, y su receptor debe ser el de la FE (NT-010, 2441).
  if (f.receptor_tipo !== "ruc" && f.receptor_tipo !== "documento") {
    await d.actualizar(f.id, { estado: "revisar", error: "devuelta fuera de las 48 h y la FE es innominada: no se puede NC automática" });
    await d.avisar(
      `<b>Factura a revisar</b> · pedido ${nombre} (${d.escapar(f.numero_completo)})\nEl pedido volvió fuera del plazo de cancelación y la factura es ` +
        `innominada: no se puede hacer NC automática. Nominar la FE con el evento de nominación (NT-014) o consultar a la contadora.`,
    );
    return { ref, accion: "revisar", detalle: "innominada fuera de plazo" };
  }
  const nc = await d.crearFactura({
    shopify_order_id: f.shopify_order_id,
    tipo_documento: 5,
    factura_original_id: f.id,
    establecimiento: f.establecimiento,
    punto: f.punto,
    timbrado: d.timbrado,
    ambiente: d.ambiente,
    emisor: d.emisor.nombre,
    simulado: d.simulado,
    estado: "pendiente",
    receptor_tipo: f.receptor_tipo,
    ruc: f.ruc,
    razon_social: f.razon_social,
    total: f.total,
    intentos: 0,
  });
  if (!nc) return { ref, accion: "sin_cambios", detalle: "NC ya creada" };
  const r = await emitirFila(nc, ped, d);
  await d.avisar(
    `<b>Nota de crédito</b> · pedido ${nombre}\nFactura ${d.escapar(f.numero_completo)} fuera del plazo de cancelación → NC por el total: ${d.escapar(r.accion)}`,
  );
  return { ref, accion: r.accion === "aprobada" ? "nota_credito" : r.accion, detalle: r.detalle };
}

// ─── Corrida completa ────────────────────────────────────────

export async function procesarCola(d: DepsCola): Promise<ResumenCola & { accion?: "bandera_apagada" }> {
  const res: ResumenCola = { nuevos: [], reintentos: [], devoluciones: [], errores: [] };
  if (!d.cfg.activo) return { ...res, accion: "bandera_apagada" };
  const ahora = d.ahora();
  const paso = async <T>(lista: T[], destino: ResultadoItem[], fn: (x: T) => Promise<ResultadoItem>, ref: (x: T) => string) => {
    for (const x of lista) {
      try {
        destino.push(await fn(x));
      } catch (e) {
        res.errores.push(`${ref(x)}: ${msj(e)}`);
      }
    }
  };
  const desde = desdeFacturar(d.cfg, ahora);
  if (!desde) {
    // Corte obligatorio: sin facturar_desde no sale nada nuevo. Reintentos y devoluciones de lo ya emitido siguen.
    res.sin_corte = true;
    if (ahora.getUTCMinutes() < 10) await d.avisar(`<b>Cola SIFEN</b>: ${d.escapar(MOTIVO_SIN_CORTE)}.`).catch(() => {});
  } else {
    try {
      const pedidos = await d.pedidosSinFactura(desde, d.cfg.lote);
      await paso(pedidos, res.nuevos, (p) => facturarPedido(p, d), (p) => `pedido ${p.shopify_order_id}`);
    } catch (e) {
      res.errores.push(`pedidos sin factura: ${msj(e)}`);
    }
    try {
      const liberados = await d.liberadosSinFactura(d.cfg.lote);
      await paso(liberados, res.nuevos, (p) => facturarPedido(p, d), (p) => `pedido ${p.shopify_order_id}`);
    } catch (e) {
      res.errores.push(`liberados: ${msj(e)}`);
    }
  }
  try {
    const vencidas = await d.facturasVencidas(ahora.toISOString(), d.cfg.lote);
    await paso(vencidas, res.reintentos, (f) => reintentarFila(f, d), (f) => `factura ${f.id}`);
  } catch (e) {
    res.errores.push(`reintentos: ${msj(e)}`);
  }
  try {
    const dev = await d.facturasDevueltas(d.cfg.lote);
    await paso(dev, res.devoluciones, (x) => procesarDevolucion(x.factura, x.pedido, d), (x) => `factura ${x.factura.id}`);
  } catch (e) {
    res.errores.push(`devoluciones: ${msj(e)}`);
  }
  if (res.errores.length) await d.avisar(`<b>Cola SIFEN</b>: ${res.errores.length} error(es)\n${res.errores.slice(0, 5).map((x) => d.escapar(x)).join("\n")}`).catch(() => {});
  return res;
}

// ─── Inutilización ───────────────────────────────────────────

export interface NumeroEnBase {
  numero: number;
  estado: EstadoFactura;
  /** fecha_emision ?? creado_en (ISO) */
  fecha: string;
}

export interface RangoInutilizar {
  desde: number;
  hasta: number;
  /** Mes (Asunción) al que pertenecen los números: 'AAAA-MM'. */
  mes: string;
  /** Plazo para mandar el evento: día `dia_limite` del mes siguiente, 'AAAA-MM-DD'. [VERIFICAR MT/DNIT] */
  limite: string;
}

const USADOS: EstadoFactura[] = ["aprobada", "cancelada", "enviada", "pendiente", "revisar", "inutilizada"];

/**
 * Números saltados o rechazados/errores definitivos de una serie (timbrado, est, punto, tipo).
 *  - hueco: número ≤ `ultimo` sin fila (se reservó y nunca se grabó, o se borró);
 *  - definitivo: fila 'rechazada' o 'error' sin reintento, con más de `diasGracia` días.
 * Excluye lo ya cubierto por eventos de inutilización pendientes/enviados/aprobados.
 * `mesDe(fecha)` devuelve 'AAAA-MM' en hora de Asunción.
 */
export function rangosAInutilizar(args: {
  ultimo: number;
  filas: NumeroEnBase[];
  cubiertos: Array<{ desde: number; hasta: number }>;
  ahora: Date;
  diasGracia: number;
  diaLimite: number;
  mesDe: (iso: string) => string;
  /** MT v150: un evento de inutilización cubre hasta 1000 números. */
  maxRango?: number;
}): RangoInutilizar[] {
  const porNumero = new Map<number, NumeroEnBase>();
  for (const f of args.filas) {
    const p = porNumero.get(f.numero);
    if (!p || USADOS.includes(f.estado)) porNumero.set(f.numero, f);
  }
  const cubierto = (n: number) => args.cubiertos.some((c) => n >= c.desde && n <= c.hasta);
  const gracia = args.diasGracia * 86_400_000;
  const candidatos: Array<{ n: number; fecha: string }> = [];
  // Fecha de referencia de un hueco = la del siguiente número con fila (o ahora).
  let siguienteFecha = args.ahora.toISOString();
  const lista: Array<{ n: number; fecha: string }> = [];
  for (let n = args.ultimo; n >= 1; n--) {
    const f = porNumero.get(n);
    if (f) siguienteFecha = f.fecha;
    if (cubierto(n)) continue;
    if (!f) lista.push({ n, fecha: siguienteFecha });
    else if ((f.estado === "rechazada" || f.estado === "error") && args.ahora.getTime() - new Date(f.fecha).getTime() > gracia) {
      lista.push({ n, fecha: f.fecha });
    }
  }
  candidatos.push(...lista.reverse());
  const rangos: RangoInutilizar[] = [];
  for (const c of candidatos) {
    const mes = args.mesDe(c.fecha);
    const ult = rangos[rangos.length - 1];
    if (ult && ult.hasta === c.n - 1 && ult.mes === mes && ult.hasta - ult.desde + 1 < (args.maxRango ?? 1000)) ult.hasta = c.n;
    else {
      const [a, m] = mes.split("-").map(Number);
      const sig = m === 12 ? `${a + 1}-01` : `${a}-${String(m + 1).padStart(2, "0")}`;
      rangos.push({ desde: c.n, hasta: c.n, mes, limite: `${sig}-${String(args.diaLimite).padStart(2, "0")}` });
    }
  }
  return rangos;
}

export interface SerieNumeracion {
  timbrado: string;
  /** clave en sifen_numeracion (en test lleva sufijo, ver io). */
  clave_timbrado: string;
  establecimiento: string;
  punto: string;
  tipo_documento: TipoDE;
  ultimo: number;
}

export interface DepsInutilizacion {
  ahora(): Date;
  cfg: ConfigSifen;
  emisor: EmisorCola;
  /** 'AAAA-MM' y día del mes en Asunción. */
  mesDe(iso: string): string;
  diaDelMes(d: Date): number;
  series(): Promise<SerieNumeracion[]>;
  numerosDeSerie(s: SerieNumeracion): Promise<NumeroEnBase[]>;
  eventosCubiertos(s: SerieNumeracion): Promise<Array<{ desde: number; hasta: number }>>;
  registrarEvento(e: EventoSifen): Promise<void>;
  marcarInutilizadas(s: SerieNumeracion, desde: number, hasta: number): Promise<void>;
  avisar(html: string): Promise<unknown>;
  escapar(s: unknown): string;
}

/**
 * Cron diario. Rangos de meses ANTERIORES al actual: se mandan (si inutilizacion_auto) o quedan como evento
 * 'pendiente'; desde el día `dia_aviso` se avisa por Telegram lo que siga sin aprobar antes del límite.
 * Los del mes en curso esperan al mes siguiente (todavía puede haber reintentos).
 */
export async function procesarInutilizacion(d: DepsInutilizacion): Promise<{ rangos: Array<RangoInutilizar & { serie: string; resultado: string }> }> {
  const ahora = d.ahora();
  const mesActual = d.mesDe(ahora.toISOString());
  const dia = d.diaDelMes(ahora);
  const out: Array<RangoInutilizar & { serie: string; resultado: string }> = [];
  const pendientesAviso: string[] = [];
  for (const s of await d.series()) {
    const rangos = rangosAInutilizar({
      ultimo: s.ultimo,
      filas: await d.numerosDeSerie(s),
      cubiertos: await d.eventosCubiertos(s),
      ahora,
      diasGracia: d.cfg.dias_gracia_inutilizacion,
      diaLimite: d.cfg.dia_limite_inutilizacion,
      mesDe: d.mesDe,
      maxRango: d.cfg.max_rango_inutilizacion,
    });
    const serie = `${s.timbrado} ${s.establecimiento}-${s.punto} tipo ${s.tipo_documento}`;
    for (const r of rangos) {
      if (r.mes >= mesActual) {
        out.push({ ...r, serie, resultado: "espera_fin_de_mes" });
        continue;
      }
      const rango = { tipo: s.tipo_documento, establecimiento: s.establecimiento, punto: s.punto, desde: r.desde, hasta: r.hasta, timbrado: s.timbrado };
      if (!d.cfg.inutilizacion_auto) {
        await d.registrarEvento({ factura_id: null, tipo: "inutilizacion", rango, motivo: d.cfg.motivo_inutilizacion, estado: "pendiente" });
        out.push({ ...r, serie, resultado: "preparado" });
        pendientesAviso.push(`${serie}: ${r.desde}–${r.hasta} (mes ${r.mes}, límite ${r.limite})`);
        continue;
      }
      const resp = await d.emisor.inutilizar({ tipo: s.tipo_documento, establecimiento: s.establecimiento, punto: s.punto, desde: r.desde, hasta: r.hasta, motivo: d.cfg.motivo_inutilizacion });
      const ok = aprobado(resp);
      await d.registrarEvento({
        factura_id: null,
        tipo: "inutilizacion",
        rango,
        motivo: d.cfg.motivo_inutilizacion,
        estado: ok ? "aprobado" : "rechazado",
        respuesta: resp,
        codigo: resp.codigo ?? null,
        enviado_en: ahora.toISOString(),
      });
      if (ok) await d.marcarInutilizadas(s, r.desde, r.hasta);
      else pendientesAviso.push(`${serie}: ${r.desde}–${r.hasta} RECHAZADO (${resp.codigo ?? ""} ${resp.mensaje ?? resp.estado}), límite ${r.limite}`);
      out.push({ ...r, serie, resultado: ok ? "inutilizado" : "rechazado" });
    }
  }
  if (pendientesAviso.length && dia >= d.cfg.dia_aviso_inutilizacion) {
    await d.avisar(
      `<b>SIFEN: numeración para inutilizar</b> (plazo día ${d.cfg.dia_limite_inutilizacion})\n` +
        pendientesAviso.map((x) => d.escapar(x)).join("\n"),
    );
  }
  return { rangos: out };
}
