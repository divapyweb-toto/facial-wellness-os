// _shared/sifen/emisor_facturasend.ts · Dueño: E. Envoltorio del adaptador FacturaSend (_shared/facturacion.ts)
// con la misma interfaz `Emisor` que el sistema propio. Queda como plan B si el propio no se habilita.
// FacturaSend sube el KuDE a Storage él mismo (bucket 'facturas'): se devuelve la ruta en `kudePath`.
// Consultar/cancelar/inutilizar/consultar RUC no están en el adaptador → responden error y la cola avisa
// para hacerlo en el panel de FacturaSend.

import type { DocumentoDE, Emisor, ResultadoEmision, RespuestaSifen } from "./tipos.ts";
import {
  CONFIG_FACTURA_DEFECTO,
  type ConfigFactura,
  type DatosFiscales,
  emitirFactura,
  type ItemFactura,
  type PedidoFactura,
  type ResultadoFactura,
} from "../facturacion.ts";
import type { OpcionesEmision } from "./emisor_propio.ts";

export interface ResultadoEmisionConRuta extends ResultadoEmision {
  /** Ruta del KuDE ya subido a Storage (bucket 'facturas') cuando el emisor lo sube él mismo. */
  kudePath?: string;
}

export interface EmisorFacturaSend extends Emisor {
  nombre: "facturasend";
  emitir(doc: DocumentoDE, op?: OpcionesEmision): Promise<ResultadoEmisionConRuta>;
}

/** "AAAA-MM-DDThh:mm:ss" de Asunción → Date (Paraguay usa UTC-3 fijo desde oct-2024). */
function fechaDesdeSifen(s: string): Date {
  return new Date(`${s}-03:00`);
}

export function pedidoFacturaDesdeDoc(doc: DocumentoDE): { pedido: PedidoFactura; datos: DatosFiscales } {
  const items: ItemFactura[] = doc.items.map((i) => ({
    codigo: i.codigo,
    descripcion: i.descripcion,
    cantidad: i.cantidad,
    precioUnitario: i.precioUnitario - (i.descuentoUnitario ?? 0),
    iva: i.ivaTasa,
  }));
  const total = doc.condicion?.pagos.reduce((s, p) => s + p.monto, 0) ??
    items.reduce((s, i) => s + i.cantidad * i.precioUnitario, 0);
  return {
    pedido: {
      shopify_order_id: doc.shopifyOrderId ?? 0,
      nombre: doc.observacion ?? null,
      numero: doc.numero,
      fecha: fechaDesdeSifen(doc.fechaEmision),
      items,
      total,
      pagadoPorQR: (doc.condicion?.pagos[0]?.tipo ?? 1) !== 1,
      email: doc.receptor.email ?? null,
    },
    datos: doc.receptor.tipo === "ruc" ? { ruc: `${doc.receptor.ruc}-${doc.receptor.dv}`, razonSocial: doc.receptor.razonSocial ?? null } : {},
  };
}

const noDisponible = (que: string): RespuestaSifen => ({
  ok: false,
  estado: "error",
  mensaje: `${que} no está en el adaptador de FacturaSend: hacerlo en su panel`,
});

export function crearEmisorFacturaSend(
  cfg: ConfigFactura = CONFIG_FACTURA_DEFECTO,
  emitir: (p: PedidoFactura, d: DatosFiscales, c: ConfigFactura) => Promise<ResultadoFactura> = emitirFactura,
): EmisorFacturaSend {
  return {
    nombre: "facturasend",
    async emitir(doc, op = {}) {
      // FacturaSend transmite a SIFEN por su cuenta: si ya se le mandó este documento, no se reenvía (duplicaría).
      if (op.cdcPrevio) return { ok: false, estado: "enviada", cdc: op.cdcPrevio, mensaje: "ya enviado a FacturaSend: revisar en su panel" };
      if (doc.tipo !== 1) return { ok: false, estado: "error", mensaje: `FacturaSend: tipo ${doc.tipo} no implementado en el adaptador` };
      const { pedido, datos } = pedidoFacturaDesdeDoc(doc);
      const c: ConfigFactura = { ...cfg, establecimiento: Number(doc.establecimiento), punto: doc.punto };
      const r = await emitir(pedido, datos, c);
      if (!r.ok) return { ok: false, estado: "error", mensaje: r.error, simulado: r.simulado };
      // Aceptado por FacturaSend = aprobado para Voltra (el seguimiento ante SIFEN queda de su lado).
      return {
        ok: true,
        estado: "aprobada",
        cdc: r.cdc,
        numeroCompleto: r.numero_completo,
        kudePath: r.pdf_path,
        mensaje: r.error ?? r.estado_sifen,
        simulado: r.simulado,
      };
    },
    consultar: () => Promise.resolve(noDisponible("La consulta de DE")),
    cancelar: () => Promise.resolve(noDisponible("La cancelación")),
    inutilizar: () => Promise.resolve(noDisponible("La inutilización")),
    consultarRuc: () => Promise.resolve({ ok: false, existe: false, mensaje: "consulta de RUC no disponible con FacturaSend" }),
  };
}
