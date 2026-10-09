// alerta-despachos · lógica pura. Todo el I/O entra por `DepsAlerta` (io.ts).
//
// Una vez por día (cron 8:00 Asunción, migración 20261009000001_origen_anuncio.sql) avisa por Telegram
// si hay pedidos de Voltra DESPACHADOS hace más de `dias` (5) días que todavía no tienen estado final.
//   Despachado = Shopify fulfilled (fecha del primer fulfillment) o pedido_estados DESPACHADO / EN_PREPARACION
//                (se toma la fecha más temprana de las que haya).
//   Estado final = ENTREGADO, NO_ENTREGADO, RENDIDO o CANCELADO (cancelado no es "perdido": no se avisa).
// El aviso no se repite el mismo día local (config_wa clave 'alerta_despachos_ultimo').

import { partesAsuncion } from "../_shared/horario.ts";

export const DIAS_DEFECTO = 5;
export const ESTADOS_DESPACHO = ["DESPACHADO", "EN_PREPARACION"];
export const ESTADOS_FINALES = ["ENTREGADO", "NO_ENTREGADO", "RENDIDO", "CANCELADO"];
const MAX_REFS = 30;
const DIA_MS = 86_400_000;

export interface PedidoDespacho {
  shopify_order_id: number;
  nombre: string | null; // '#1003'
  /** Fecha del primer fulfillment de Shopify (null si no está fulfilled). */
  fulfilled_en: string | null;
  /** Estados de pedido_estados con su fecha. */
  estados: Array<{ estado: string; creado_en: string }>;
}

export interface Atrasado {
  shopify_order_id: number;
  referencia: string; // 'VT-1003'
  despachado_en: string;
  dias: number;
}

export interface DepsAlerta {
  ahora(): Date;
  /** Pedidos reales (no borrador, no cancelados en la confirmación) de los últimos ~60 días. */
  pedidos(): Promise<PedidoDespacho[]>;
  /** 'YYYY-MM-DD' (día local) del último aviso enviado, o null. */
  ultimoAviso(): Promise<string | null>;
  guardarAviso(diaISO: string): Promise<void>;
  avisar(texto: string): Promise<{ ok: boolean; error?: string }>;
}

export interface ResultadoAlerta {
  accion: "ya_avisado_hoy" | "sin_atrasados" | "avisado";
  atrasados: number;
  referencias: string[];
}

/** '#1003' / '1003' / 'VT-1003' → 'VT-1003'. Sin número → null. */
export function referenciaVT(nombre: string | null | undefined): string | null {
  const m = String(nombre ?? "").match(/(\d+)\s*$/);
  return m ? `VT-${parseInt(m[1], 10)}` : null;
}

const ms = (s: string | null | undefined): number => {
  const t = s ? new Date(s).getTime() : NaN;
  return Number.isFinite(t) ? t : NaN;
};

/** Fecha de despacho = la más temprana entre el fulfillment de Shopify y los estados de despacho. */
export function fechaDespacho(p: PedidoDespacho): number | null {
  const cands = [ms(p.fulfilled_en)];
  for (const e of p.estados) if (ESTADOS_DESPACHO.includes(e.estado)) cands.push(ms(e.creado_en));
  const v = cands.filter((x) => Number.isFinite(x));
  return v.length ? Math.min(...v) : null;
}

export function atrasados(pedidos: PedidoDespacho[], ahora: Date, dias = DIAS_DEFECTO): Atrasado[] {
  const out: Atrasado[] = [];
  for (const p of pedidos) {
    if (p.estados.some((e) => ESTADOS_FINALES.includes(e.estado))) continue;
    const d = fechaDespacho(p);
    if (d === null) continue;
    const transcurrido = ahora.getTime() - d;
    if (transcurrido <= dias * DIA_MS) continue;
    const ref = referenciaVT(p.nombre) ?? `pedido ${p.shopify_order_id}`;
    out.push({
      shopify_order_id: p.shopify_order_id,
      referencia: ref,
      despachado_en: new Date(d).toISOString(),
      dias: Math.floor(transcurrido / DIA_MS),
    });
  }
  // Los más viejos primero.
  return out.sort((a, b) => b.dias - a.dias || a.referencia.localeCompare(b.referencia));
}

export function textoAviso(lista: Atrasado[], dias = DIAS_DEFECTO): string {
  const n = lista.length;
  const cab = n === 1
    ? `<b>1 pedido despachado hace más de ${dias} días sin entrega</b>`
    : `<b>${n} pedidos despachados hace más de ${dias} días sin entrega</b>`;
  const refs = lista.slice(0, MAX_REFS).map((a) => `${a.referencia} (${a.dias} d)`).join(", ");
  const resto = n > MAX_REFS ? ` y ${n - MAX_REFS} más` : "";
  return `${cab}\n${refs}${resto}\nRevisá con el courier o importá su reporte.`;
}

export async function ejecutarAlerta(deps: DepsAlerta, dias = DIAS_DEFECTO): Promise<ResultadoAlerta> {
  const ahora = deps.ahora();
  const hoy = partesAsuncion(ahora).diaISO;
  if ((await deps.ultimoAviso()) === hoy) return { accion: "ya_avisado_hoy", atrasados: 0, referencias: [] };

  const lista = atrasados(await deps.pedidos(), ahora, dias);
  if (!lista.length) return { accion: "sin_atrasados", atrasados: 0, referencias: [] };

  const r = await deps.avisar(textoAviso(lista, dias));
  if (!r.ok) throw new Error(`Telegram: ${r.error ?? "sin detalle"}`); // no se guarda → el próximo intento reavisa
  await deps.guardarAviso(hoy);
  return { accion: "avisado", atrasados: lista.length, referencias: lista.map((a) => a.referencia) };
}
