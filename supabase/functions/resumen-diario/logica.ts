// resumen-diario · lógica pura (16-10-2026): con los datos ya leídos arma el mensaje de Telegram de las 21:30.
// Solo números: nada de nombres, teléfonos ni direcciones.
import { escaparHtml } from "../_shared/telegram_formato.ts";

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
  /** 20-10: equilibrio de CPA leído de config equilibrio_producto.Varios; sin dato → EQUILIBRIO_CPA. */
  equilibrioCpa?: number | null;
  /** 20-10: equilibrio de JawFlex (config equilibrio_producto.JawFlex): el más bajo, alerta de CPA de 3 días. */
  equilibrioJawFlex?: number | null;
  /** 20-10: PaP en los últimos 60 días (vista tasa_entrega_courier) y si ya se avisó que llegó a 20 resueltos. */
  pap60d?: { resueltos: number; tasa: number | null } | null;
  papAvisoYaDado?: boolean;
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

  // Pedidos confirmados de más de 24 h que todavía no salieron (últimos 14 días).
  const limite = e.ahora.getTime() - 24 * 3_600_000, desde14 = e.ahora.getTime() - 14 * 24 * 3_600_000;
  const sinDespachar = validos.filter((p) => {
    const t = Date.parse(p.creadoEn);
    return t < limite && t > desde14 && p.estadoConfirmacion === "confirmado" && !p.estadoEnvio &&
      !tieneTag(p, "DESPACHADO") && !tieneTag(p, "ENTREGADO") && !tieneTag(p, "RETIRO_EN_CASA");
  }).length;
  if (sinDespachar) alertas.push(`${sinDespachar} pedido${sinDespachar > 1 ? "s" : ""} sin despachar hace +24 h`);
  for (const s of e.stock) {
    const f = familia(s.nombre);
    const tope = f === "Raspador" || f === "Tiras" ? 30 : 20;
    if (s.stock < tope) alertas.push(`${f === "Otros" ? escaparHtml(s.nombre) : f}: ${s.stock} unidades`);
  }
  if (alertas.length) l.push("", `⚠️ Alertas: ${alertas.join(" · ")}`);
  for (const a of avisosInfo) l.push(alertas.length ? `ℹ️ ${a}` : `\nℹ️ ${a}`);
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
