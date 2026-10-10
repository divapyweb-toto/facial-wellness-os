// pedido-mayorista · validación del cuerpo en el servidor (pura).
// Mismas reglas que src/lib/mayorista.js (la pantalla); paridad_test.ts compara las dos con los mismos casos.
// RUC: 3 a 8 dígitos + DV por módulo 11 = _shared/sifen/cdc.ts dvModulo11 (se usa esa misma función).
import { dvModulo11 } from "../_shared/sifen/cdc.ts";

export const COBROS = ["transferencia_anticipada", "contra_entrega"] as const;
export type Cobro = typeof COBROS[number];
export const PLAZO_MAX_DIAS = 365;

export interface ItemMayorista {
  variant_id: string;
  titulo: string;
  cantidad: number;
  precio_unitario: number; // Gs, IVA incluido
}

export interface PedidoMayorista {
  clave_idempotencia: string;
  cliente: { nombre: string; telefono: string; direccion: string; referencia: string | null; ciudad: string };
  fiscal: { ruc: string; dv: string; razon_social: string; email: string | null };
  items: ItemMayorista[];
  envio: number;
  cobro: Cobro;
  comprobante_ref: string | null;
  condicion: "contado" | "credito";
  plazo_dias: number | null;
  anterior_al_corte: boolean;
  fecha_entrega: string | null; // YYYY-MM-DD (solo anterior al corte)
  nota: string | null;
}

export type ResultadoValidacion =
  | { ok: true; pedido: PedidoMayorista; total: number }
  | { ok: false; errores: Record<string, string> };

type Dict = Record<string, unknown>;
const obj = (v: unknown): Dict => (v && typeof v === "object" && !Array.isArray(v) ? v as Dict : {});
const txt = (v: unknown, max = 500): string => (typeof v === "string" ? v.trim().replace(/\s+/g, " ").slice(0, max) : "");
const entero = (v: unknown): number => (typeof v === "number" && Number.isInteger(v) ? v : NaN);
const EMAIL = /^[^\s@]+@[^\s@]+\.[^\s@]{2,}$/;
const CLAVE = /^[A-Za-z0-9-]{8,64}$/;
const VARIANTE = /^gid:\/\/shopify\/ProductVariant\/\d+$/;

/** true si ruc (3-8 dígitos, sin 0 adelante) y dv (1 dígito) cierran por módulo 11. */
export function rucValido(ruc: string, dv: string): boolean {
  return /^[1-9]\d{2,7}$/.test(ruc) && /^\d$/.test(dv) && dvModulo11(ruc) === Number(dv);
}

function fechaValida(f: string): boolean {
  if (!/^\d{4}-\d{2}-\d{2}$/.test(f)) return false;
  const d = new Date(`${f}T12:00:00-03:00`);
  return Number.isFinite(d.getTime()) && d.toISOString().slice(0, 10) === f;
}

/** Mediodía de Paraguay del día de la entrega (fecha real para pedido_estados y entregado_en). */
export const instanteEntrega = (fecha: string) => `${fecha}T12:00:00-03:00`;

/**
 * Valida el cuerpo de la acción 'crear'. ctx.hoy = 'YYYY-MM-DD' de Asunción; ctx.facturarDesde = config_wa.sifen.facturar_desde.
 */
export function validarPedido(cuerpo: unknown, ctx: { hoy: string; facturarDesde?: string | null }): ResultadoValidacion {
  const b = obj(cuerpo);
  const e: Record<string, string> = {};

  const clave = txt(b.clave_idempotencia, 64);
  if (!CLAVE.test(clave)) e.clave_idempotencia = "Falta la clave de idempotencia (recargá la pantalla)";

  const c = obj(b.cliente);
  const cliente = {
    nombre: txt(c.nombre, 120),
    telefono: txt(c.telefono, 40),
    direccion: txt(c.direccion, 255),
    referencia: txt(c.referencia, 255) || null,
    ciudad: txt(c.ciudad, 120),
  };
  if (cliente.nombre.length < 2) e.nombre = "Falta el nombre del cliente";
  const dig = cliente.telefono.replace(/\D/g, "");
  if (dig.length < 9 || dig.length > 13) e.telefono = "Teléfono inválido";
  if (cliente.direccion.length < 3) e.direccion = "Falta la dirección";
  if (cliente.ciudad.length < 2) e.ciudad = "Falta la ciudad";

  const f = obj(b.fiscal);
  const fiscal = {
    ruc: txt(f.ruc, 20).replace(/\./g, ""),
    dv: txt(f.dv, 2),
    razon_social: txt(f.razon_social, 255),
    email: txt(f.email, 255) || null,
  };
  if (!rucValido(fiscal.ruc, fiscal.dv)) e.ruc = "RUC o dígito verificador inválido (módulo 11)";
  if (fiscal.razon_social.length < 2) e.razon_social = "Falta la razón social";
  if (fiscal.email && !EMAIL.test(fiscal.email)) e.email = "Email inválido";

  const itemsCrudos = Array.isArray(b.items) ? b.items : [];
  if (!itemsCrudos.length) e.items = "Agregá al menos un producto";
  if (itemsCrudos.length > 50) e.items = "Máximo 50 líneas por pedido";
  const items: ItemMayorista[] = itemsCrudos.slice(0, 50).map((x) => {
    const it = obj(x);
    return {
      variant_id: txt(it.variant_id, 80),
      titulo: txt(it.titulo, 255),
      cantidad: entero(it.cantidad),
      precio_unitario: entero(it.precio_unitario),
    };
  });
  items.forEach((it, i) => {
    if (!VARIANTE.test(it.variant_id)) e.items = `Producto ${i + 1}: variante inválida`;
    else if (!(it.cantidad > 0) || it.cantidad > 10000) e.items = `Producto ${i + 1}: cantidad inválida`;
    else if (!(it.precio_unitario > 0)) e.items = `Producto ${i + 1}: precio inválido`;
  });

  const envio = b.envio == null ? 0 : entero(b.envio);
  if (!(envio >= 0)) e.envio = "Envío inválido";

  const cobro = String(b.cobro ?? "") as Cobro;
  if (!(COBROS as readonly string[]).includes(cobro)) e.cobro = "Cobro inválido";

  const condicion = b.condicion === "credito" ? "credito" : b.condicion === "contado" || b.condicion == null ? "contado" : null;
  let plazo: number | null = null;
  if (!condicion) e.condicion = "Condición inválida";
  else if (condicion === "credito") {
    plazo = entero(b.plazo_dias);
    if (!(plazo >= 1 && plazo <= PLAZO_MAX_DIAS)) e.plazo_dias = `Plazo de crédito inválido (1 a ${PLAZO_MAX_DIAS} días)`;
    if (cobro === "transferencia_anticipada") e.condicion = "Si pagó por adelantado es contado, no crédito";
  }

  const anterior = b.anterior_al_corte === true;
  const comprobante = txt(b.comprobante_ref, 120) || null;
  if (cobro === "transferencia_anticipada" && !anterior && (!comprobante || comprobante.length < 3)) {
    e.comprobante_ref = "Falta la referencia del comprobante";
  }

  let fecha: string | null = null;
  if (anterior) {
    fecha = txt(b.fecha_entrega, 10);
    if (!fechaValida(fecha)) e.fecha_entrega = "Fecha de entrega inválida";
    else if (fecha > ctx.hoy) e.fecha_entrega = "La fecha de entrega no puede ser futura";
    else if (ctx.facturarDesde && new Date(instanteEntrega(fecha)).getTime() >= new Date(ctx.facturarDesde).getTime()) {
      e.fecha_entrega = "La fecha es posterior al corte de facturación: cargalo como pedido normal";
    }
  }

  if (Object.keys(e).length) return { ok: false, errores: e };
  const total = items.reduce((s, it) => s + it.cantidad * it.precio_unitario, 0) + envio;
  return {
    ok: true,
    total,
    pedido: {
      clave_idempotencia: clave,
      cliente,
      fiscal,
      items,
      envio,
      cobro,
      comprobante_ref: comprobante,
      condicion: condicion!,
      plazo_dias: condicion === "credito" ? plazo : null,
      anterior_al_corte: anterior,
      fecha_entrega: anterior ? fecha : null,
      nota: typeof b.nota === "string" && b.nota.trim() ? b.nota.trim().slice(0, 1000) : null,
    },
  };
}
