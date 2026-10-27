// resumen-diario · lógica pura (16-10-2026): con los datos ya leídos arma el mensaje de Telegram de las 21:30.
// Solo números: nada de nombres, teléfonos ni direcciones.
import { escaparHtml } from "../_shared/telegram_formato.ts";
import type { OpcionesAviso } from "../_shared/telegram_politica.ts";

export const EQUILIBRIO_CPA = 41_000;
// 16-10: meta de Enrique (línea 🎯 arriba de todo).
export const META_PEDIDOS = 15, META_ENTREGA = 0.85, META_CPA = 35_000;
export const META_BOT_V33 = 100;
export const DESDE_BOT_V33 = "2026-10-13T20:40:00Z";
export const CONJUNTO_PRUEBA = "120251142117330429";
const PRODUCTOS = ["Raspador", "Tiras", "Pack", "JawFlex", "Parches", "Botella"] as const;

export interface Pedido {
  nombre: string;
  creadoEn: string; // ISO
  total: number;
  tags: string[];
  canceladoEn: string | null;
  esBorrador: boolean;
  nota: string;
  lineas: Array<{ titulo: string; cantidad: number }>;
  estadoConfirmacion: string | null;
  estadoEnvio: string | null;
  clienteId: string | null;
  /** 21-10: ciudad de envío (para la lista de pedidos sin despachar). */
  ciudad?: string;
}

/** Fecha AAAA-MM-DD en hora de Paraguay (UTC−3 fijo desde octubre de 2024). */
export function diaParaguay(iso: string | Date): string {
  const t = (iso instanceof Date ? iso : new Date(iso)).getTime() - 3 * 3_600_000;
  return new Date(t).toISOString().slice(0, 10);
}
export function sumarDias(dia: string, n: number): string {
  const d = new Date(`${dia}T12:00:00Z`);
  d.setUTCDate(d.getUTCDate() + n);
  return d.toISOString().slice(0, 10);
}

const tieneTag = (p: Pedido, t: string) => p.tags.some((x) => x.toUpperCase() === t);
export const esValido = (p: Pedido) =>
  !p.esBorrador && !p.canceladoEn && !/PRUEBA/i.test(p.nombre) && !/PRUEBA/i.test(p.nota) && !p.tags.some((t) => /PRUEBA/i.test(t));
export const canal = (p: Pedido): "wa" | "web" => (tieneTag(p, "ORIGEN_WHATSAPP") ? "wa" : "web");

export function familia(titulo: string): string {
  const t = titulo.toLowerCase();
  if (/kit ?deporte/.test(t) || (/botella/.test(t) && /tira|nasal/.test(t))) return "Kit Deporte"; // 26-10: antes que tiras
  if (/pack|gudair/.test(t)) return "Pack";
  if (/raspador|lengua/.test(t)) return "Raspador";
  if (/tira|nasal/.test(t)) return "Tiras";
  if (/parche|bucal/.test(t)) return "Parches";
  if (/jaw|mand[ií]bula|ejercitador/.test(t)) return "JawFlex";
  if (/botella/.test(t)) return "Botella";
  if (/bebird|o[ií]do/.test(t)) return "Bebird";
  return "Otros";
}

export interface CampanaMeta { nombre: string; gasto: number; presupuesto: number | null }
export interface DatosMeta {
  hoy: CampanaMeta[];
  ayer: CampanaMeta[];
  gasto7d: number;
  /** 20-10: gasto de los últimos 3 días (hoy incluido) por familia de producto, según el nombre del anuncio. */
  gasto3dPorProducto?: Record<string, number>;
  /** 20-10: parte de ese gasto que viene de anuncios que hoy NO están activos (pausados/archivados). */
  gasto3dPausadoPorProducto?: Record<string, number>;
  prueba: { gasto: number; mejor: { nombre: string; ctr: number | null; inicios: number; compras: number } | null } | null;
}
export interface Entrada {
  hoy: string; // AAAA-MM-DD Paraguay
  ahora: Date;
  pedidos: Pedido[]; // al menos los últimos 14 días
  meta: DatosMeta | null; // null = Meta no respondió
  chatsAnuncioHoy: Array<{ clienteId: string | null }>;
  chatsBotV33: number;
  botV33YaAvisado: string | null; // día en que se mostró "100/100 listo", o null
  stock: Array<{ nombre: string; stock: number }>;
  /** Pedidos resueltos en los últimos 7 días (null = no se pudo leer). */
  entrega7d: { entregados: number; rechazados: number } | null;
  /** 19-10: anuncios en estado 'cansado' del libro de creativos (solo aviso: no se pausa nada). */
  cansados?: Array<{ anuncio: string; canal: string; caidaPct: number | null }>;
  /** 19-10: Lucero en gestión +3 días (reprogramar) y PaP en custodia. Solo referencias, sin datos de clientes. */
  luceroGestion?: Array<{ ref: string; estado: string; dias: number }>;
  papCustodia?: Array<{ ref: string; desde: string }>;
  prueba?: boolean;
  /** 21-10: courier sugerido por ciudad (rpc sugerir_courier; null = sin cobertura / no reconocida). Clave: ciudad tal cual. */
  courierPorCiudad?: Record<string, { sugerido: string | null; lucero: boolean; pap: boolean }>;
  /** 20-10: equilibrio de CPA leído de config equilibrio_producto.Varios; sin dato → EQUILIBRIO_CPA. */
  equilibrioCpa?: number | null;
  /** 20-10: equilibrio de JawFlex (config equilibrio_producto.JawFlex): el más bajo, alerta de CPA de 3 días. */
  equilibrioJawFlex?: number | null;
  /** 20-10: PaP en los últimos 60 días (vista tasa_entrega_courier) y si ya se avisó que llegó a 20 resueltos. */
  pap60d?: { resueltos: number; tasa: number | null } | null;
  papAvisoYaDado?: boolean;
  /** 21-10: vista pedidos_parados (confirmados de +24 h que no salieron). null = no se pudo leer; undefined = no se pidió. */
  pedidosParados?: PedidoParado[] | null;
  /** 21-10: vista rendicion_atrasada (entregados sin rendir pasado el umbral del courier). */
  rendicionAtrasada?: RendicionAtrasada[] | null;
}

/** 21-10: fila de la vista pedidos_parados. etapa: sin_cargar (no está en Ventas) | sin_despachar. */
export interface PedidoParado {
  nombre: string; ciudad: string | null; horas: number; dias: number; etapa: string; courier: string | null; producto: string | null;
}
/** 21-10: fila de la vista rendicion_atrasada (monto neto = cobrado − flete). */
export interface RendicionAtrasada { ref: string; courier: string; dias: number; montoNeto: number }
type InfoCourier = { sugerido: string | null; lucero: boolean; pap: boolean };

const NOMBRE_CUR = (c: string | null | undefined) => (c === "pap" ? "PaP" : c === "lucero" ? "Lucero" : null);

/**
 * 21-10: lista "#1064 Ciudad 5 d · sin despachar → PaP" del más viejo al más nuevo, máximo `max` + "y N más".
 * Courier: el ya asignado en Ventas; si no hay, el sugerido por ciudad. JawFlex solo sale por Lucero (si Lucero no llega
 * pero PaP cobra, Despacho lo manda por PaP solo) y lleva su marca.
 */
export function listaParados(ps: PedidoParado[], courierPorCiudad?: Record<string, InfoCourier>, max = 10): { n: number; lista: string } {
  const orden = [...ps].sort((a, b) => b.horas - a.horas);
  const item = (p: PedidoParado) => {
    const ciudad = p.ciudad?.trim() ? escaparHtml(p.ciudad.trim()) : "ciudad ?";
    const info = p.ciudad ? courierPorCiudad?.[p.ciudad] : undefined;
    const asignado = NOMBRE_CUR(p.courier);
    let destino = "";
    if (info && familia(p.producto ?? "") === "JawFlex") {
      destino = info.lucero ? " → Lucero" : info.pap ? " → PaP (JawFlex: Lucero no llega)" : " → sin courier: decidir a mano";
    } else if (asignado) {
      destino = ` → ${asignado}`;
    } else if (info) {
      destino = info.sugerido ? ` → ${NOMBRE_CUR(info.sugerido) ?? "Lucero"}` : " → sin courier";
    }
    const tiempo = p.dias >= 1 ? `${p.dias} d` : `${Math.floor(p.horas)} h`;
    const etapa = p.etapa === "sin_cargar" ? "sin cargar en Ventas" : "sin despachar";
    return `${escaparHtml(p.nombre)} ${ciudad} ${tiempo} · ${etapa}${destino}`;
  };
  const mas = orden.length > max ? ` · y ${orden.length - max} más` : "";
  return { n: orden.length, lista: orden.slice(0, max).map(item).join(" · ") + mas };
}

/** 21-10: "💰 Rendición atrasada: Lucero VT-1080 5 días Gs 100.000 · … · total Gs …". null si no hay. */
export function lineaRendicion(rs: RendicionAtrasada[] | null | undefined, max = 8): string | null {
  if (!rs?.length) return null;
  const orden = [...rs].sort((a, b) => b.dias - a.dias);
  const total = orden.reduce((s, r) => s + (Number(r.montoNeto) || 0), 0);
  const items = orden.slice(0, max).map((r) => `${NOMBRE_CUR(r.courier) ?? escaparHtml(r.courier)} ${escaparHtml(r.ref)} ${r.dias} días ${gs(r.montoNeto)}`);
  return `💰 Rendición atrasada: ${items.join(" · ")}${orden.length > max ? ` · y ${orden.length - max} más` : ""} · total ${gs(total)}`;
}

/** 21-10: "Sin cobertura: N pedidos esta semana (desde el lunes) · pagaron X · cancelados Y"; null si no hubo. */
export function lineaSinCobertura(pedidos: Pedido[], hoy: string): string | null {
  const dow = new Date(`${hoy}T12:00:00Z`).getUTCDay();
  const lunes = sumarDias(hoy, -((dow + 6) % 7));
  const t = (p: Pedido) => p.tags.map((x) => x.toUpperCase());
  const sc = pedidos.filter((p) => {
    const d = diaParaguay(p.creadoEn);
    return d >= lunes && d <= hoy && !p.esBorrador && !/prueba/i.test(p.nombre) &&
      t(p).some((x) => x === "SIN_COBERTURA" || x === "SIN_COBERTURA_CANCELADO");
  });
  if (!sc.length) return null;
  const pagaron = sc.filter((p) => t(p).some((x) => ["PAGADO", "PAGO_VERIFICADO", "PAGADO_QR"].includes(x))).length;
  const cancelados = sc.filter((p) => t(p).includes("SIN_COBERTURA_CANCELADO")).length;
  return `📍 Sin cobertura: ${sc.length} pedido${sc.length > 1 ? "s" : ""} esta semana · pagaron ${pagaron} · cancelados ${cancelados}`;
}

/** 20-10: con 20 resueltos de PaP en 60 días se revisa si la sugerencia de courier pasa a asignar sola. */
export const PAP_RESUELTOS_REVISAR = 20;

const gs = (n: number) => `Gs ${Math.round(n).toLocaleString("es-PY")}`;
const DIAS = ["dom", "lun", "mar", "mié", "jue", "vie", "sáb"];
const esWa = (c: CampanaMeta) => /WHATSAPP/i.test(c.nombre);

/** 20-10: "Sin pin (14 días): N pedidos · E entregados · P con ubicación pendiente | Con pin: …". null si no hay pedidos del bot. */
export function lineaSinPin(validos: Pedido[], hoy: string): string | null {
  const desde = sumarDias(hoy, -13);
  const wa = validos.filter((p) => canal(p) === "wa" && diaParaguay(p.creadoEn) >= desde && diaParaguay(p.creadoEn) <= hoy);
  const entregado = (p: Pedido) => tieneTag(p, "ENTREGADO") || /ENTREGADO/i.test(p.estadoEnvio ?? "");
  const sin = wa.filter((p) => tieneTag(p, "SIN_PIN")), con = wa.filter((p) => !tieneTag(p, "SIN_PIN") && !tieneTag(p, "RETIRO_EN_CASA"));
  if (!sin.length) return null;
  const pend = sin.filter((p) => tieneTag(p, "UBICACION_PENDIENTE")).length;
  return `📍 Sin pin (14 días): ${sin.length} pedidos · ${sin.filter(entregado).length} entregados` +
    `${pend ? ` · ${pend} con ubicación pendiente` : ""} | Con pin: ${con.length} · ${con.filter(entregado).length} entregados`;
}

export function armarResumen(e: Entrada): { texto: string; botV33Listo: boolean; papAviso: boolean } {
  const validos = e.pedidos.filter(esValido);
  const hoy = validos.filter((p) => diaParaguay(p.creadoEn) === e.hoy);
  const web = hoy.filter((p) => canal(p) === "web").length, wa = hoy.length - web;
  const porProd: Record<string, number> = {};
  let unidades = 0;
  for (const p of hoy) {
    // Un pedido cuenta para cada producto que trae (por eso la suma puede pasar el total de pedidos).
    const fams = new Set(p.lineas.map((l) => familia(l.titulo)));
    for (const f of fams) porProd[f] = (porProd[f] ?? 0) + 1;
    unidades += p.lineas.reduce((s, l) => s + (l.cantidad || 0), 0);
  }
  const facturado = hoy.reduce((s, p) => s + (p.total || 0), 0);
  const termo = hoy.length >= 5 ? "✅" : hoy.length >= 3 ? "⚠️" : "🔴";
  const fecha = new Date(`${e.hoy}T12:00:00Z`);
  const l: string[] = [];
  if (e.prueba) l.push("🧪 <b>PRUEBA</b> (no es el envío real de las 21:30)");
  l.push(`📊 <b>Voltra · resumen del ${DIAS[fecha.getUTCDay()]} ${e.hoy.slice(8, 10)}-${e.hoy.slice(5, 7)}</b>`, "");
  // Línea de meta: siempre arriba. Sin rechazos registrados no se inventa un 100%.
  const en = e.entrega7d;
  const txtEntrega = !en ? "entrega: sin dato" : en.rechazados === 0
    ? "entrega: sin datos de rechazos"
    : `entrega 14 días: ${Math.round((en.entregados / (en.entregados + en.rechazados)) * 100)}%${en.entregados / (en.entregados + en.rechazados) >= META_ENTREGA ? " ✅" : ""}`;
  const gastoHoy = e.meta ? e.meta.hoy.reduce((s, c) => s + c.gasto, 0) : null;
  const cpaHoy = gastoHoy != null && hoy.length ? gastoHoy / hoy.length : null;
  const txtCpa = cpaHoy == null ? "CPA —" : `CPA ${Math.round(cpaHoy).toLocaleString("es-PY")}${cpaHoy <= META_CPA ? " ✅" : ""}`;
  l.push(`🎯 Meta: ${META_PEDIDOS} pedidos/día · ${Math.round(META_ENTREGA * 100)}% entrega · CPA ≤ ${META_CPA.toLocaleString("es-PY")} → hoy: <b>${hoy.length}</b> · ${txtEntrega} · ${txtCpa}`);
  l.push(`Pedidos válidos hoy: <b>${hoy.length}</b> (web ${web} · WhatsApp ${wa}) · piso 5-6/día ${termo}`);
  const extras = Object.keys(porProd).filter((k) => !(PRODUCTOS as readonly string[]).includes(k));
  l.push(`Por producto: ${[...PRODUCTOS, ...extras].map((k) => `${k} ${porProd[k] ?? 0}`).join(" · ")}`);
  l.push(`Unidades: ${unidades} · Facturado: ${gs(facturado)}`, "");

  const alertas: string[] = [];
  const avisosInfo: string[] = [];
  if (!e.meta) {
    l.push("Meta hoy: Meta no respondió (sin gasto ni CPA)");
  } else {
    const gw = e.meta.hoy.filter((c) => !esWa(c)).reduce((s, c) => s + c.gasto, 0);
    const gwa = e.meta.hoy.filter(esWa).reduce((s, c) => s + c.gasto, 0);
    const cpa = (g: number, n: number) => (n ? gs(g / n) : "—");
    l.push(`Meta hoy: ${gs(gw + gwa)} (web ${gs(gw).replace("Gs ", "")} · WhatsApp ${gs(gwa).replace("Gs ", "")})`);
    l.push(`CPA hoy: ${cpa(gw + gwa, hoy.length)} (web ${cpa(gw, web).replace("Gs ", "")} · WA ${cpa(gwa, wa).replace("Gs ", "")})`);
    const desde7 = sumarDias(e.hoy, -6);
    const ped7 = validos.filter((p) => { const d = diaParaguay(p.creadoEn); return d >= desde7 && d <= e.hoy; }).length;
    const cpa7 = ped7 ? e.meta.gasto7d / ped7 : null;
    const eq = e.equilibrioCpa ?? EQUILIBRIO_CPA;
    l.push(`CPA últimos 7 días: ${cpa7 == null ? "—" : gs(cpa7)} · equilibrio ~${eq.toLocaleString("es-PY")} ${cpa7 != null && cpa7 <= eq ? "✅" : "⚠️"}`);
    if (cpa7 != null && cpa7 > eq) alertas.push(`CPA 7 días ${gs(cpa7)} (arriba del equilibrio)`);
    // 20-10 (Enrique): JawFlex tiene el equilibrio más bajo → alerta si su CPA de 3 días lo supera.
    const eqJaw = e.equilibrioJawFlex ?? null, gastoJaw = e.meta.gasto3dPorProducto?.JawFlex ?? 0;
    if (eqJaw && gastoJaw > 0) {
      const desde3 = sumarDias(e.hoy, -2);
      const pedJaw = validos.filter((p) => {
        const d = diaParaguay(p.creadoEn);
        return d >= desde3 && d <= e.hoy && p.lineas.some((x) => familia(x.titulo) === "JawFlex");
      }).length;
      const cpaJaw = pedJaw ? gastoJaw / pedJaw : null;
      if (cpaJaw == null ? gastoJaw > eqJaw : cpaJaw > eqJaw) {
        const pausado = e.meta.gasto3dPausadoPorProducto?.JawFlex;
        const sufijo = pausado != null && pausado > 0 ? ` · ${gs(pausado)} de anuncios ya pausados` : "";
        const txt = `CPA 3 días JawFlex ${cpaJaw == null ? `sin pedidos (gastó ${gs(gastoJaw)})` : gs(cpaJaw)} > ${eqJaw.toLocaleString("es-PY")}${sufijo}`;
        // Si los anuncios activos solos no pasan el equilibrio, es un aviso (ℹ️), no una alerta (⚠️).
        const activo = pausado != null ? gastoJaw - pausado : null;
        const activosPasan = activo == null ? true : (pedJaw ? activo / pedJaw > eqJaw : activo > eqJaw);
        if (activosPasan) alertas.push(txt); else avisosInfo.push(txt);
    }
    }
    // Web con poco gasto (regla de "rotura" si es el 2.º día seguido).
    const pctWeb = (cs: CampanaMeta[]) => {
      const w = cs.filter((c) => !esWa(c) && c.presupuesto);
      const pres = w.reduce((s, c) => s + (c.presupuesto ?? 0), 0);
      return pres ? w.reduce((s, c) => s + c.gasto, 0) / pres : null;
    };
    const ph = pctWeb(e.meta.hoy), pa = pctWeb(e.meta.ayer);
    if (ph != null && ph < 0.5) {
      alertas.push(`Web gastó ${Math.round(ph * 100)}% del presupuesto${pa != null && pa < 0.5 ? " (2.º día bajo 50%: regla de rotura)" : ""}`);
    }
  }
  l.push("");

  const nChats = e.chatsAnuncioHoy.length;
  const clientesWaHoy = new Set(hoy.filter((p) => canal(p) === "wa").map((p) => p.clienteId).filter(Boolean));
  const conPedido = e.chatsAnuncioHoy.filter((c) => c.clienteId && clientesWaHoy.has(c.clienteId)).length;
  l.push(`WhatsApp: ${nChats} chats de anuncios · ${nChats ? Math.round((conPedido / nChats) * 100) : 0}% terminó en pedido`);
  // 20-10 (Enrique): el pin dejó de ser obligatorio. Se mide la entrega de los pedidos del bot sin pin contra con pin.
  const pin = lineaSinPin(validos, e.hoy);
  if (pin) l.push(pin);
  let botV33Listo = false;
  if (e.chatsBotV33 < META_BOT_V33) {
    l.push(`Bot v33: ${e.chatsBotV33}/${META_BOT_V33} chats${META_BOT_V33 - e.chatsBotV33 <= 10 ? " (falta poco para las mejoras)" : ""}`);
  } else if (!e.botV33YaAvisado || e.botV33YaAvisado === e.hoy) {
    l.push(`Bot v33: ${META_BOT_V33}/${META_BOT_V33} ✅ listo para mejoras`);
    botV33Listo = true;
  }

  const pr = e.meta?.prueba;
  if (pr && pr.gasto > 0) {
    l.push("", `Prueba de productos: ${gs(pr.gasto)} hoy`);
    if (pr.mejor) {
      l.push(`Mejor anuncio: ${escaparHtml(pr.mejor.nombre)} · CTR ${pr.mejor.ctr == null ? "—" : pr.mejor.ctr.toFixed(1).replace(".", ",") + "%"} · ${pr.mejor.inicios} inicios de pago · ${pr.mejor.compras} compras`);
    }
  }

  // 21-10: pedidos confirmados de más de 24 h que todavía no salieron. Fuente única: vista pedidos_parados
  // (excluye retiro en casa, cancelados y sin cobertura esperando pago). null = no se pudo leer la vista.
  if (e.pedidosParados === null) {
    avisosInfo.push("No pude leer los pedidos parados (vista pedidos_parados): revisá Despacho");
  } else if (e.pedidosParados?.length) {
    const { n, lista } = listaParados(e.pedidosParados, e.courierPorCiudad);
    alertas.push(`${n} pedido${n > 1 ? "s" : ""} sin despachar hace +24 h: ${lista}`);
  }
  for (const s of e.stock) {
    const f = familia(s.nombre);
    const tope = f === "Raspador" || f === "Tiras" ? 30 : 20;
    if (s.stock < tope) alertas.push(`${f === "Otros" ? escaparHtml(s.nombre) : f}: ${s.stock} unidades`);
  }
  if (alertas.length) l.push("", `⚠️ Alertas: ${alertas.join(" · ")}`);
  for (const a of avisosInfo) l.push(alertas.length ? `ℹ️ ${a}` : `\nℹ️ ${a}`);
  const sinCob = lineaSinCobertura(e.pedidos, e.hoy);
  if (sinCob) l.push(sinCob);
  const rend = lineaRendicion(e.rendicionAtrasada);
  if (rend) l.push(rend);
  // 20-10: una sola vez, cuando PaP junta 20 pedidos resueltos en 60 días.
  const papAviso = !e.papAvisoYaDado && !!e.pap60d && e.pap60d.resueltos >= PAP_RESUELTOS_REVISAR;
  if (papAviso) {
    l.push(`🚚 PaP ya tiene ${e.pap60d!.resueltos} pedidos resueltos en 60 días (entrega ${e.pap60d!.tasa ?? "—"}%): revisar si la sugerencia de courier pasa a asignar sola`);
  }
  const lg = e.luceroGestion ?? [];
  if (lg.length) {
    l.push(`📦 Lucero en gestión +3 días (reprogramar): ${lg.slice(0, 8).map((x) => `${x.ref} ${escaparHtml(x.estado)} ${x.dias}d`).join(" · ")}${lg.length > 8 ? ` · y ${lg.length - 8} más` : ""}`);
  }
  // 19-10: la custodia de PaP es inrescatable (Enrique): se mide como PERDIDO, sin alerta de acción.
  for (const c of e.cansados ?? []) {
    const medida = c.canal === "whatsapp" ? "pedidos/chat" : "formularios/clic";
    l.push(`⚠️ Se está cansando: ${escaparHtml(c.anuncio)} (${medida} ${c.caidaPct ?? "−50"}% contra sus primeros días)`);
  }
  return { texto: l.join("\n"), botV33Listo, papAviso };
}

/**
 * 27-10 (#65 del inventario): el resumen del día va a administración (cola avisos_admin → parte diario), no a Telegram.
 * La prueba va igual que el real (mismo destino, tipo aparte) para no mandarle a Enrique algo que en producción no recibe.
 */
export function avisoResumenDiario(dia: string, prueba: boolean): OpcionesAviso {
  return prueba
    ? { tipo: "resumen_diario_prueba", destino: "admin", clave: null }
    : { tipo: "resumen_diario", destino: "admin", unaVezPorDia: true, clave: dia };
}
