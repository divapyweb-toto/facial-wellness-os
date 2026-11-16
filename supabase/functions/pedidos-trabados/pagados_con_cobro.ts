// pedidos-trabados · pagados por adelantado con guía a cobrar (Enrique 16-11-2026, paquete a). Lógica pura; la lectura
// está en pagados_con_cobro_io.ts. Regla: pedido pagado por adelantado = el courier cobra ₲0. Si el cliente pagó DESPUÉS
// de bajar la planilla, la guía salió con monto (8 casos, ₲1.176.000 al 16-11). Dos casos, un Telegram por pedido y caso
// (candado auto_pagado_cobro:<caso>:<ref> en eventos_crudos, mismo avisarUnaVez de entregas_actuar.ts):
//   · en_camino: todavía no entregado y la guía tiene monto → "pedile a <courier> que la guía pase a ₲0" + texto listo.
//   · cobrado: ya entregado con monto/cobrado > 0 → "posible doble cobro, confirmar con <courier>".
// Primera corrida (sin candado base): los entregados hace más de `diasResumen` días van en UN solo resumen.
// Interruptor: config.alerta_pagados_cobro (sin fila = prendido; "apagado" o {"activo": false} lo apaga).
import { escaparHtml, formatearGuaranies } from "../_shared/telegram_formato.ts";
import { avisarUnaVez, type DepsActuar, diasDesde, pedidoDeRef } from "./entregas_actuar.ts";

/** Señal de pago con el criterio de Despacho (pedidosVoltra.js esPagoAnticipado + prioridad.js pagadoPorTags + CREDITO). */
export type SenalPago = "pagado" | "credito" | "parcial";
export type CasoPagadoCobro = "en_camino" | "cobrado";

export interface FilaPagadoCobro {
  ref: string; courier: string; categoria: string; importe: number; cobrado: number;
  guia: string | null; ciudad: string | null; fechaEntrega: string | null;
  senal: SenalPago | null; saldo: number | null;
}
export interface HechoPagadoCobro { ref: string; caso: CasoPagadoCobro; monto: number; resultado: string }
export interface CfgPagadoCobro { activo: boolean; desde: string; diasResumen: number }
export type DepsPagadoCobro = DepsActuar & {
  /** ¿Ya salió el texto "entregar SIN COBRAR" al verificar el pago (telegram_enviados, pago_courier_no_cobrar)? */
  yaAvisadoAlVerificar?(pedido: string): Promise<boolean>;
};

export const CLAVE_CFG_PAGADOS_COBRO = "alerta_pagados_cobro";
export const CANDADO_BASE_PAGADO_COBRO = "auto_pagado_cobro_base";
export const claveCandadoPagadoCobro = (caso: CasoPagadoCobro, ref: string) => `auto_pagado_cobro:${caso}:${ref}`;
const CFG_DEFECTO: CfgPagadoCobro = { activo: true, desde: "2026-10-07", diasResumen: 14 };

/** config.valor (texto) → interruptor. Sin fila o ilegible = prendido (decisión de Enrique 16-11). */
export function configPagadoCobro(valor: unknown): CfgPagadoCobro {
  if (valor == null) return { ...CFG_DEFECTO };
  const s = String(valor).trim();
  if (/^(apagado|false|off|no)$/i.test(s)) return { ...CFG_DEFECTO, activo: false };
  try {
    const j = JSON.parse(s) as Record<string, unknown>;
    if (!j || typeof j !== "object") return { ...CFG_DEFECTO };
    return {
      activo: j.activo !== false,
      desde: typeof j.desde === "string" && /^\d{4}-\d{2}-\d{2}$/.test(j.desde) ? j.desde : CFG_DEFECTO.desde,
      diasResumen: Number.isFinite(Number(j.dias_resumen)) && Number(j.dias_resumen) > 0 ? Number(j.dias_resumen) : CFG_DEFECTO.diasResumen,
    };
  } catch {
    return { ...CFG_DEFECTO };
  }
}

const mayus = (tags: unknown) => (Array.isArray(tags) ? tags : String(tags ?? "").split(",")).map((t) => String(t).trim().toUpperCase()).filter(Boolean);

/** 'paid' suelto NO es prepago (en contra entrega Shopify lo pone al entregar). */
export function senalPago(p: { tags: unknown; financiero?: string | null; pagoAnticipado?: boolean | null }): SenalPago | null {
  const t = mayus(p.tags);
  const pagado = t.includes("PAGO_VERIFICADO") || t.includes("PAGADO") || t.includes("PAGADO_QR") || !!p.pagoAnticipado ||
    (t.includes("PAGO_ANTICIPADO_COMPROBANTE") && String(p.financiero ?? "").toLowerCase() === "paid");
  if (t.includes("SALDO_PENDIENTE") || t.includes("PAGO_PARCIAL")) return "parcial";
  if (pagado) return "pagado";
  if (t.includes("CREDITO")) return "credito";
  return null;
}

/** Entregado: lo que figura cobrado (si no hay, el monto de la guía). En camino: el monto de la guía. */
const montoDe = (f: FilaPagadoCobro) => (f.categoria === "entregado" ? (f.cobrado || f.importe || 0) : (f.importe || f.cobrado || 0));

/** ¿Qué caso es? null = nada que avisar (sin señal, ₲0, devuelto o no despachado). */
export function casoPagadoCobro(f: FilaPagadoCobro): CasoPagadoCobro | null {
  if (!f.senal) return null;
  const monto = montoDe(f);
  if (monto <= 0) return null;
  // Pago parcial: el saldo conocido se puede cobrar; solo se avisa si la guía supera el saldo.
  if (f.senal === "parcial" && f.saldo != null && monto <= f.saldo) return null;
  if (f.categoria === "entregado") return "cobrado";
  if (f.categoria === "en_proceso") return "en_camino";
  return null;
}

// ── cruce de tablas (puro, lo usa el I/O) ──
export interface EntregaCruda {
  nro_guia_pap: string | null; guia_transportadora: string | null; transportadora: string | null; categoria: string | null;
  importe: number | null; cobrado: number | null; fecha_entrega: string | null; ciudad: string | null;
  n_referencia: string | null; venta_id: string | null; created_at: string | null; tienda: string | null;
}
export interface VentaCruda { id: string; n_referencia: string | null; pago_anticipado: boolean | null; deleted_at: string | null }
export interface PedidoCrudo { nombre: string; tags: unknown; financiero: string | null }

/** entregas → venta (venta_id, si no n_referencia) → pedido de Shopify (#n). Solo Voltra y creadas desde `desde`. */
export function armarFilas(entregas: EntregaCruda[], ventas: VentaCruda[], pedidos: PedidoCrudo[], desde: string): FilaPagadoCobro[] {
  const porId = new Map(ventas.map((v) => [v.id, v]));
  const porRef = new Map(ventas.filter((v) => v.n_referencia && !v.deleted_at).map((v) => [v.n_referencia!, v]));
  const pedidoDe = new Map(pedidos.map((p) => [p.nombre, p]));
  const filas: FilaPagadoCobro[] = [];
  for (const e of entregas) {
    if (e.tienda !== "voltra" || String(e.created_at ?? "").slice(0, 10) < desde) continue;
    const v = (e.venta_id ? porId.get(e.venta_id) : undefined) ?? (e.n_referencia ? porRef.get(e.n_referencia) : undefined);
    if (v?.deleted_at) continue; // venta anulada
    const ref = v?.n_referencia ?? e.n_referencia;
    if (!ref) continue;
    const p = pedidoDe.get(pedidoDeRef(ref));
    const tags = p?.tags ?? [];
    const saldoTag = mayus(tags).map((t) => /^SALDO_(\d+)$/.exec(t)).find(Boolean);
    const guiaPropia = String(e.nro_guia_pap ?? "").trim();
    filas.push({
      ref, courier: String(e.transportadora ?? ""), categoria: String(e.categoria ?? ""),
      importe: Number(e.importe) || 0, cobrado: Number(e.cobrado) || 0,
      guia: String(e.guia_transportadora ?? "").trim() || (guiaPropia && !/^L-VT-/i.test(guiaPropia) ? guiaPropia : null),
      ciudad: e.ciudad ?? null, fechaEntrega: e.fecha_entrega ?? null,
      senal: senalPago({ tags, financiero: p?.financiero ?? null, pagoAnticipado: v?.pago_anticipado ?? null }),
      saldo: saldoTag ? Number(saldoTag[1]) : null,
    });
  }
  return filas;
}

// ── textos (sin nombre, teléfono ni dirección del cliente) ──
const nombreCourier = (c: string) => (c === "pap" ? "Punto a Punto" : c === "lucero" ? "Lucero" : c || "el courier");
const fechaLinda = (f: string | null) => (f && /^\d{4}-\d{2}-\d{2}/.test(f) ? `${f.slice(8, 10)}/${f.slice(5, 7)}/${f.slice(0, 4)}` : "fecha sin cargar");
const gs = (n: number) => `Gs ${Math.round(n).toLocaleString("es-PY").replace(/,/g, ".")}`;
const queEs = (f: FilaPagadoCobro) => (f.senal === "credito" ? "a crédito" : f.senal === "parcial" ? "con pago parcial" : "pagado");

export function textoEnCamino(f: FilaPagadoCobro): string {
  const n = escaparHtml(pedidoDeRef(f.ref)), c = nombreCourier(f.courier), monto = montoDe(f);
  const guia = f.guia ? `la guía ${escaparHtml(f.guia)}` : "la guía (sin número cargado)";
  const guiaCorta = f.guia ? ` (guía ${escaparHtml(f.guia)})` : "";
  const destino = f.ciudad?.trim() ? `, destino ${escaparHtml(f.ciudad.trim())},` : "";
  const parcial = f.senal === "parcial"
    ? ` Ojo: pago parcial${f.saldo != null ? `; el saldo es ${formatearGuaranies(f.saldo)}` : ""}: confirmá con ${c} cuánto tiene que cobrar.` : "";
  const pedidoCourier = f.senal === "parcial"
    ? `Hola, el pedido ${n}${guiaCorta}${destino} ya está pagado en parte por transferencia: NO cobrar ${gs(monto)}. Les confirmo el monto a cobrar. Gracias.`
    : f.senal === "credito"
    ? `Hola, el pedido ${n}${guiaCorta}${destino} es a crédito: entregar SIN COBRAR (Gs 0). Por favor pasen el monto a cobrar de la guía a 0. Gracias.`
    : `Hola, el pedido ${n}${guiaCorta}${destino} ya está pagado por transferencia: entregar SIN COBRAR (Gs 0). Por favor pasen el monto a cobrar de la guía a 0. Gracias.`;
  return `💸 ${n} ${queEs(f)}: pedile a ${c} que ${guia} pase a ₲0 (hoy figura a cobrar ${formatearGuaranies(monto)}).${parcial} ` +
    `Reenviale esto a ${c}:\n\n${pedidoCourier}`;
}

export function textoCobrado(f: FilaPagadoCobro): string {
  const n = escaparHtml(pedidoDeRef(f.ref)), c = nombreCourier(f.courier), monto = montoDe(f), fecha = fechaLinda(f.fechaEntrega);
  const guiaCorta = f.guia ? ` (guía ${escaparHtml(f.guia)})` : "";
  const parcial = f.senal === "parcial" && f.saldo != null ? ` Pago parcial: el saldo era ${formatearGuaranies(f.saldo)}.` : "";
  return `⚠️ ${n} ${queEs(f)} y figura cobrado ${formatearGuaranies(monto)} (${c}${guiaCorta}, entregado el ${fecha}): ` +
    `posible doble cobro, confirmar con ${c}.${parcial} Si lo cobró: que lo descuente en la rendición o devolvele la transferencia al cliente. ` +
    `Reenviale esto a ${c}:\n\nHola, consulto por el pedido ${n}${guiaCorta}, entregado el ${fecha}. El cliente ya había pagado por transferencia ` +
    `antes de la entrega. ¿Cobraron ${gs(monto)} al entregar? Si lo cobraron, por favor descuéntenlo en la próxima rendición. Gracias.`;
}

export function textoResumenInicial(fs: FilaPagadoCobro[]): string {
  const total = fs.reduce((a, f) => a + montoDe(f), 0);
  const lineas = [...fs].sort((a, b) => String(a.fechaEntrega ?? "").localeCompare(String(b.fechaEntrega ?? ""))).map((f) =>
    `• ${escaparHtml(pedidoDeRef(f.ref))} · ${nombreCourier(f.courier)}${f.guia ? ` · guía ${escaparHtml(f.guia)}` : ""} · entregado ${fechaLinda(f.fechaEntrega)} · ${formatearGuaranies(montoDe(f))}`
  );
  return `🧾 Pagados por adelantado que figuran cobrados por el courier (entregados hace más de 14 días): ${fs.length} pedidos, ` +
    `${formatearGuaranies(total)} en total. Posible doble cobro: confirmalos con cada courier en la rendición (si cobraron, que lo descuenten ` +
    `o devolvé la transferencia).\n\n${lineas.join("\n")}`;
}

/** Corre los dos casos. `simular`: no toca candados ni Telegram (solo dice qué saldría). */
export async function procesarPagadosConCobro(
  filas: FilaPagadoCobro[], ahora: Date, cfg: CfgPagadoCobro, d: DepsPagadoCobro, simular = false,
): Promise<HechoPagadoCobro[]> {
  if (!cfg.activo) return [];
  const casos = filas.flatMap((f) => {
    const caso = casoPagadoCobro(f);
    return caso ? [{ f, caso }] : [];
  });
  if (!casos.length) return [];
  const opts = (ref: string) => ({ tipo: "pagado_con_cobro", destino: "enrique", pedido: pedidoDeRef(ref) }) as const;

  // Primera corrida: los entregados viejos van en UN resumen (sin repetir los que ya tienen candado).
  const primeraVez = !(await d.existeCandado(CANDADO_BASE_PAGADO_COBRO));
  const viejos = new Set<string>();
  let resultadoResumen = "";
  if (primeraVez) {
    for (const { f, caso } of casos) {
      const dias = diasDesde(f.fechaEntrega, ahora);
      if (caso === "cobrado" && dias != null && dias > cfg.diasResumen && !(await d.existeCandado(claveCandadoPagadoCobro(caso, f.ref)))) viejos.add(f.ref);
    }
    const fs = casos.filter((c) => viejos.has(c.f.ref)).map((c) => c.f);
    if (simular) resultadoResumen = "resumen_inicial (simulado)";
    else if (fs.length) {
      let ultimo = "";
      for (let i = 0; i < 3 && !resultadoResumen; i++) {
        const r = await d.avisar(textoResumenInicial(fs), undefined, { tipo: "pagado_con_cobro", destino: "enrique", clave: "resumen_inicial" });
        if (r.ok) resultadoResumen = "resumen_inicial";
        else { ultimo = r.error ?? "Telegram falló"; if (i < 2) await d.esperar(1500); }
      }
      if (!resultadoResumen) resultadoResumen = `error: Telegram: ${ultimo}`;
      else for (const f of fs) await d.tomarCandado(claveCandadoPagadoCobro("cobrado", f.ref), { ref: f.ref, caso: "cobrado", resumen: true });
    }
    if (!simular && !resultadoResumen.startsWith("error")) await d.tomarCandado(CANDADO_BASE_PAGADO_COBRO, { corrida: ahora.toISOString(), en_resumen: [...viejos] });
  }

  const hechos: HechoPagadoCobro[] = [];
  for (const { f, caso } of casos) {
    const monto = montoDe(f);
    if (viejos.has(f.ref) && caso === "cobrado") { hechos.push({ ref: f.ref, caso, monto, resultado: resultadoResumen }); continue; }
    const id = claveCandadoPagadoCobro(caso, f.ref);
    // En camino y ya salió "entregar SIN COBRAR" al verificar el pago: no se repite (queda el candado).
    if (caso === "en_camino" && d.yaAvisadoAlVerificar && !(await d.existeCandado(id)) && (await d.yaAvisadoAlVerificar(pedidoDeRef(f.ref)))) {
      if (!simular) await d.tomarCandado(id, { ref: f.ref, caso, ya_avisado: "pago_courier_no_cobrar" });
      hechos.push({ ref: f.ref, caso, monto, resultado: "ya_avisado_al_verificar" });
      continue;
    }
    const texto = caso === "cobrado" ? textoCobrado(f) : textoEnCamino(f);
    hechos.push({ ref: f.ref, caso, monto, resultado: await avisarUnaVez(d, id, { ref: f.ref, caso, monto }, texto, simular, opts(f.ref)) });
  }
  return hechos;
}
