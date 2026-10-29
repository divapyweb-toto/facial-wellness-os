// _shared/telegram_tipos.ts · 27-10. Registro de TODOS los tipos de aviso con su título y a dónde van.
// Fuente: ~/Negocios/reportes/avisos-telegram-2026-10-27.md (clasificación ENRIQUE / ADMIN / CLIENTE / BORRAR).
// La política de config.telegram_politica se arma de acá (politicaInicial) y la prueba telegram_tipos_test.ts
// verifica que cada `tipo:` usado en el código esté registrado y que ningún aviso de Enrique quede fuera.

export type RutaRegistrada = "inmediato" | "resumen" | "admin" | "descartar";

export interface TipoAviso { titulo: string; ruta: RutaRegistrada; inventario: string }

export const TIPOS_AVISO: Record<string, TipoAviso> = {
  // Propios de este cambio
  lista_despacho: { titulo: "Lista de despacho", ruta: "inmediato", inventario: "#1/#2 (reemplazo)" },
  lista_despacho_error: { titulo: "Lista de despacho: falló", ruta: "inmediato", inventario: "nuevo" },
  resumen_avisos: { titulo: "Resumen de avisos", ruta: "inmediato", inventario: "nuevo" },

  // ENRIQUE inmediato: courier, despacho, retiro, pagos
  cancelado_en_courier: { titulo: "Cancelado pero ya en el courier", ruta: "inmediato", inventario: "#48 (mismo tipo/clave que wa-webhook)" },
  reemplazo_en_courier: { titulo: "Pedido reemplazado ya en el courier", ruta: "inmediato", inventario: "#15" },
  no_entregado_reintentar: { titulo: "No entregado: texto para el courier", ruta: "inmediato", inventario: "#37+#41+#42 (uno solo)" },
  pap_ultima_chance: { titulo: "PaP custodio/inubicable", ruta: "inmediato", inventario: "#43 (hasta que el bot le escriba al cliente)" },
  sin_cobertura_revisar_comprobante: { titulo: "Sin cobertura: revisar comprobante", ruta: "inmediato", inventario: "#52" },
  sin_cobertura_escribile: { titulo: "Sin cobertura: no se le pudo escribir", ruta: "inmediato", inventario: "#49-51 (sin vía al cliente)" },
  saldo_pendiente_entregado: { titulo: "Entregado con saldo pendiente", ruta: "inmediato", inventario: "#57 (hasta que el bot cobre)" },
  preparado_no_despachable: { titulo: "Preparado pero no se puede despachar", ruta: "inmediato", inventario: "#18" },
  preparado_no_despachable_sin_revertir: { titulo: "Preparado no despachable (sin revertir)", ruta: "inmediato", inventario: "#18" },
  entrega_programada_courier: { titulo: "Entrega programada: texto para el courier", ruta: "inmediato", inventario: "#19" },

  pago_qr_recibido: { titulo: "Pago QR recibido: texto para el courier", ruta: "inmediato", inventario: "#59" },
  pago_qr_monto_distinto: { titulo: "Pago QR con monto distinto", ruta: "inmediato", inventario: "#59 (plata: decide Enrique)" },
  pago_courier_no_cobrar: { titulo: "Pagado: texto para el courier", ruta: "inmediato", inventario: "#56" },
  whatsapp_canal_sordo: { titulo: "WhatsApp caído / calidad del número", ruta: "inmediato", inventario: "#67 (máx. 1 cada 6 h)" },
  mejora_mensual_propuesta: { titulo: "Mejora mensual: propuesta", ruta: "inmediato", inventario: "#80 (se aprueba solo con los botones)" },

  // ENRIQUE en el resumen de 09:00 y 15:00
  plazo_pap: { titulo: "Plazo PaP vencido", ruta: "resumen", inventario: "#44" },
  despachados_mas_5_dias: { titulo: "Despachados hace +5 días", ruta: "resumen", inventario: "#47" },
  pedidos_sin_despachar_24h: { titulo: "Sin despachar +24 h", ruta: "resumen", inventario: "#45" },
  rendicion_atrasada: { titulo: "Rendición atrasada", ruta: "resumen", inventario: "#46" },

  // ADMIN (cola avisos_admin, sin Telegram)
  sin_cobertura_cancelar_fallo: { titulo: "Sin cobertura: no se pudo cancelar", ruta: "admin", inventario: "#49-51 falla" },
  plantilla_reprogramar_activa: { titulo: "Plantilla reprogramar aprobada", ruta: "admin", inventario: "#54" },
  plantilla_reprogramar_rechazada: { titulo: "Plantilla reprogramar rechazada", ruta: "admin", inventario: "#54" },
  envio_fallido: { titulo: "Envío de WhatsApp fallido", ruta: "admin", inventario: "#24/#70" },
  envio_no_marcado: { titulo: "Envío no marcado", ruta: "admin", inventario: "#70" },
  aviso_baja_no_programado: { titulo: "Aviso de baja no programado", ruta: "admin", inventario: "#70" },
  oferta_prioridad_sin_tag: { titulo: "Oferta prioridad sin etiqueta", ruta: "admin", inventario: "#70" },
  post_entrega_fallo: { titulo: "Post-entrega falló", ruta: "admin", inventario: "#73" },
  lucero_seguimiento_consultas: { titulo: "Seguimiento Lucero: consultas fallidas", ruta: "admin", inventario: "#76" },
  lucero_seguimiento_corrida: { titulo: "Seguimiento Lucero: corrida falló", ruta: "admin", inventario: "#76" },
  pap_sync_login_frenado: { titulo: "PaP sync: login frenado", ruta: "admin", inventario: "#77" },
  pap_sync_errores_seguidos: { titulo: "PaP sync: errores seguidos", ruta: "admin", inventario: "#77" },
  pap_sync_faltan_columnas: { titulo: "PaP sync: faltan columnas", ruta: "admin", inventario: "#77" },
  pap_sync_cambio_formato: { titulo: "PaP sync: cambió el formato", ruta: "admin", inventario: "#77" },
  sifen_revisar_validacion: { titulo: "SIFEN: factura a revisar", ruta: "admin", inventario: "#60-64" },
  sifen_observaciones: { titulo: "SIFEN: observaciones", ruta: "admin", inventario: "#60-64" },
  sifen_revisar_armado: { titulo: "SIFEN: armado a revisar", ruta: "admin", inventario: "#60-64" },
  sifen_rechazada: { titulo: "SIFEN rechazó la factura", ruta: "admin", inventario: "#60-64" },
  sifen_max_intentos: { titulo: "SIFEN: máximo de intentos", ruta: "admin", inventario: "#60-64" },
  sifen_pendiente_48h: { titulo: "SIFEN: pendiente 48 h", ruta: "admin", inventario: "#60-64" },
  sifen_revisar_rendido_devuelto: { titulo: "SIFEN: rendido que volvió", ruta: "admin", inventario: "#60-64" },
  sifen_factura_cancelada: { titulo: "SIFEN: factura cancelada", ruta: "admin", inventario: "#60-64" },
  sifen_reembolso: { titulo: "SIFEN: reembolsar pedido pagado y anulado", ruta: "inmediato", inventario: "29-10 factura al cobrar" },
  factura_guardada_vendedor: { titulo: "Datos de factura guardados por el vendedor", ruta: "inmediato", inventario: "29-10 aviso duplicado #1164" },
  pago_ambiguo: { titulo: "Transferencia con varios pedidos posibles", ruta: "inmediato", inventario: "29-10 ranking de pagos" },
  sifen_cancelacion_fallida: { titulo: "SIFEN: no se pudo cancelar", ruta: "admin", inventario: "#60-64" },
  sifen_revisar_innominada: { titulo: "SIFEN: innominada a revisar", ruta: "admin", inventario: "#60-64" },
  sifen_nota_credito: { titulo: "SIFEN: nota de crédito", ruta: "admin", inventario: "#60-64" },
  sifen_sin_corte: { titulo: "Cola SIFEN sin corte", ruta: "admin", inventario: "#60-64" },
  sifen_cola_errores: { titulo: "Cola SIFEN: errores", ruta: "admin", inventario: "#60-64" },
  sifen_inutilizacion_pendiente: { titulo: "SIFEN: inutilización pendiente (plazo legal)", ruta: "admin", inventario: "#60-64" },
  factura_revisar: { titulo: "Factura a revisar (legado)", ruta: "admin", inventario: "#60-64" },
  factura_max_intentos: { titulo: "Factura: máximo de intentos (legado)", ruta: "admin", inventario: "#60-64" },
  pago_qr_sin_cobro: { titulo: "Pago QR sin cobro conocido", ruta: "admin", inventario: "#59 falla" },
  pago_qr_registro_fallido: { titulo: "Pago QR: falló el registro", ruta: "admin", inventario: "#59 falla" },
  auditoria_vendedor_parte: { titulo: "Auditoría diaria del vendedor", ruta: "admin", inventario: "#66" },
  auditoria_vendedor_fallo: { titulo: "Auditoría diaria: falló", ruta: "admin", inventario: "#66" },
  salud_canal_chequeo_fallo: { titulo: "Salud del canal: chequeo falló", ruta: "admin", inventario: "#67 falla" },
  stock_bajo: { titulo: "Stock bajo", ruta: "admin", inventario: "#75" },
  resumen_diario: { titulo: "Resumen del día", ruta: "admin", inventario: "#65" },
  resumen_diario_prueba: { titulo: "Resumen del día (prueba)", ruta: "admin", inventario: "#65" },
  creativos_libro_descuadre: { titulo: "Libro de creativos descuadrado", ruta: "admin", inventario: "#79" },
  mejora_mensual_descartada: { titulo: "Mejora mensual: descartada", ruta: "admin", inventario: "#80" },
  mejora_mensual_sin_datos: { titulo: "Mejora mensual: pocos datos", ruta: "admin", inventario: "#80" },
  mejora_mensual_error: { titulo: "Mejora mensual: error", ruta: "admin", inventario: "#80" },
  sync_gastos_fallo: { titulo: "Sync de gastos falló", ruta: "admin", inventario: "#78" },
  sync_meta_ads_cuenta_frenada: { titulo: "Sync Meta Ads: cuenta frenada", ruta: "admin", inventario: "#78" },
  sync_meta_ads_fallo: { titulo: "Sync Meta Ads falló", ruta: "admin", inventario: "#78" },
  recuperacion_frenada_calidad: { titulo: "Recuperación frenada por calidad", ruta: "admin", inventario: "#77" },
  pago_verificado_auto: { titulo: "Pago verificado solo (Gmail ueno)", ruta: "admin", inventario: "nuevo 27-10" },

  // BORRAR (no sale ni se guarda; vuelven con "todos")
  sin_cobertura_avisado: { titulo: "Sin cobertura: cliente avisado", ruta: "descartar", inventario: "#49-51 BORRAR" },
  sin_cobertura_cancelado: { titulo: "Sin cobertura: cancelado", ruta: "descartar", inventario: "#49-51 BORRAR" },
  jawflex_por_pap: { titulo: "JawFlex va por PaP", ruta: "descartar", inventario: "#53 BORRAR" },
  pedido_sin_confirmar: { titulo: "Pedido sin confirmar", ruta: "descartar", inventario: "#9 BORRAR" },
  pedido_retenido_sin_confirmar: { titulo: "Retenido sin confirmar", ruta: "descartar", inventario: "#10 BORRAR" },
  pedido_cancelado_sin_confirmar: { titulo: "Cancelado por no confirmar", ruta: "descartar", inventario: "#11 BORRAR" },
};

export const TITULOS_AVISO: Record<string, string> = Object.fromEntries(Object.entries(TIPOS_AVISO).map(([k, v]) => [k, v.titulo]));

/** Política para config.telegram_politica: inmediato → enrique, resumen → resumen, descartar → descartar (admin = default del código). */
export function politicaInicial(): { enrique: string[]; resumen: string[]; descartar: string[] } {
  const de = (r: RutaRegistrada) => Object.entries(TIPOS_AVISO).filter(([, v]) => v.ruta === r).map(([k]) => k).sort();
  return { enrique: de("inmediato"), resumen: de("resumen"), descartar: de("descartar") };
}
