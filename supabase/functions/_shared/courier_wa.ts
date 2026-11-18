// 18-11 · enviarACourier: el ÚNICO camino para que el sistema le escriba a una transportadora por WhatsApp (número de
// Voltra). CONTRATO para pedidos-trabados (FUNCIONES) y el agente de transportadoras:
//   enviarACourier({ courier: "lucero" | "pap", ref: "VT-1234", texto, clave }) → { ok, enviados, fallas, repetido? }
//   · destinos: los números de config_wa.transportadoras (activo) de esa empresa con avisos != false. Nunca otro número.
//   · ventana de 24 h abierta (la transportadora escribió hace < 24 h) → texto libre (gratis); cerrada → plantilla de
//     utilidad voltra_aviso_transportadora ({{1}} nombre, {{2}} ref, {{3}} texto en una línea), solo si está APROBADA.
//   · clave (opcional): candado en eventos_crudos transp_envio:<clave>; con la misma clave nunca sale dos veces.
//   · tope: tope_envios_dia mensajes automáticos por número y por día de Paraguay.
//   · ok = salió a al menos un número. Si ok es false, quien llama sigue con su Telegram de siempre (red de seguridad).
import { db } from "./db.ts";
import { inicioDiaPY } from "./telegram_politica.ts";
import { courierDe, leerCfgTransportadoras, type Transportadora } from "./transportadoras_wa.ts";
import { unaLinea } from "./transportadoras_agente.ts";
import { enviarPlantilla, enviarTexto, type ResultadoEnvio } from "./wa.ts";
import { estadoPlantilla } from "./plantilla_meta.ts";

export const PLANTILLA_TRANSPORTADORA = "voltra_aviso_transportadora";
export const PREFIJO_ENVIO = "transp_envio:";

export type PedidoEnvioCourier = {
  courier: "lucero" | "pap";
  ref: string;
  texto: string;
  clave?: string | null;
  /** Horas hábiles (7-22, Asunción) sin "leído" ni respuesta antes del Telegram de respaldo a Enrique. Default 4; pagados 3. */
  plazoLecturaH?: number;
};
/**
 * ok = salió a al menos un número. repetido = esa clave YA SALIÓ BIEN antes (el candado se cierra solo después de un envío
 * exitoso; si el envío falla no queda candado y quien llama sigue con su Telegram).
 */
export type ResultadoCourier = { ok: boolean; enviados: string[]; fallas: string[]; repetido?: boolean; wamids?: string[] };
export type IdsChat = { clienteId: string; conversacionId: string };

export type DepsCourierWa = {
  ahora(): Date;
  config(): Promise<unknown>;
  ultimoEntranteEn(telefono: string): Promise<string | null>;
  enviadosHoy(telefono: string, desdeISO: string): Promise<number>;
  /** ¿Ya le salió algún mensaje nuestro (cualquier origen) a este número? Si no, el texto libre lleva la presentación. */
  yaLeEscribimos(telefono: string): Promise<boolean>;
  yaEnviado(clave: string): Promise<boolean>;
  marcarEnviado(clave: string, payload: unknown): Promise<void>;
  chatDe(t: Transportadora): Promise<IdsChat>;
  plantillaAprobada(): Promise<boolean>;
  enviarTexto(to: string, texto: string, ids: IdsChat): Promise<ResultadoEnvio>;
  enviarPlantilla(to: string, variables: string[], ids: IdsChat): Promise<ResultadoEnvio>;
};

export const PRESENTACION_COURIER = "Hola, te escribe Voltra (antes Facial Wellness, es la misma empresa).";
/** Largo máximo de {{3}}: el cuerpo de la plantilla tiene ~200 caracteres fijos y Meta corta en 1024. */
export const MAX_VARIABLE = 650;

/** Texto → partes de una línea para la plantilla, cortadas en saltos de línea (o en palabras si una línea es larga). */
export function partesPlantilla(texto: string, max = MAX_VARIABLE): string[] {
  const lineas = String(texto ?? "").split(/\n+/).map((l) => unaLinea(l, 10_000)).filter(Boolean);
  const partes: string[] = [];
  let actual = "";
  const empujar = (x: string) => {
    if (!actual) actual = x;
    else if (actual.length + 3 + x.length <= max) actual = `${actual} · ${x}`;
    else { partes.push(actual); actual = x; }
  };
  for (const l of lineas) {
    if (l.length <= max) { empujar(l); continue; }
    let resto = l;
    while (resto.length > max) {
      const corte = resto.lastIndexOf(" ", max - 1) > max / 2 ? resto.lastIndexOf(" ", max - 1) : max - 1;
      empujar(resto.slice(0, corte).trim());
      resto = resto.slice(corte).trim();
    }
    if (resto) empujar(resto);
  }
  if (actual) partes.push(actual);
  return partes.length > 1 ? partes.map((x, k) => `(${k + 1}/${partes.length}) ${x}`) : partes;
}

export async function enviarACourier(p: PedidoEnvioCourier, deps: DepsCourierWa = depsCourierWaReales): Promise<ResultadoCourier> {
  const cfg = leerCfgTransportadoras(await deps.config());
  if (!cfg.activo) return { ok: false, enviados: [], fallas: ["modo_transportadora_apagado"] };
  if (!p.texto?.trim()) return { ok: false, enviados: [], fallas: ["texto_vacio"] };
  const clave = p.clave ? `${PREFIJO_ENVIO}${p.clave}` : null;
  if (clave && await deps.yaEnviado(clave)) return { ok: true, enviados: [], fallas: [], repetido: true };
  const destinos = cfg.numeros.filter((n) => n.avisos && courierDe(n) === p.courier);
  if (!destinos.length) return { ok: false, enviados: [], fallas: [`sin_numero_de_${p.courier}`] };
  const ahora = deps.ahora();
  const desde = inicioDiaPY(ahora);
  const enviados: string[] = [], fallas: string[] = [], wamids: string[] = [];
  for (const d of destinos) {
    try {
      if (await deps.enviadosHoy(d.telefono, desde) >= cfg.tope_envios_dia) { fallas.push(`${d.nombre}: tope_diario`); continue; }
      const ultimo = await deps.ultimoEntranteEn(d.telefono);
      const ventana = !!ultimo && ahora.getTime() - Date.parse(ultimo) < 24 * 3_600_000 - 5 * 60_000; // 5 min de margen
      const ids = await deps.chatDe(d);
      const resultados: ResultadoEnvio[] = [];
      if (ventana) {
        const texto = (await deps.yaLeEscribimos(d.telefono)) ? p.texto.trim() : `${PRESENTACION_COURIER}\n${p.texto.trim()}`;
        resultados.push(await deps.enviarTexto(d.telefono, texto, ids));
      } else if (await deps.plantillaAprobada()) {
        for (const parte of partesPlantilla(p.texto)) {
          const r = await deps.enviarPlantilla(d.telefono, [d.nombre.split(" ")[0], p.ref, parte], ids);
          resultados.push(r);
          if (!r.ok) break;
        }
      } else { fallas.push(`${d.nombre}: ventana_cerrada_y_plantilla_sin_aprobar`); continue; }
      const malo = resultados.find((r) => !r.ok);
      if (malo) fallas.push(`${d.nombre}: ${malo.error ?? "error"}`);
      else enviados.push(d.telefono);
      for (const r of resultados) if (r.ok && r.wa_message_id) wamids.push(r.wa_message_id);
    } catch (e) {
      fallas.push(`${d.nombre}: ${e instanceof Error ? e.message : String(e)}`);
    }
  }
  if (enviados.length && clave) {
    await deps.marcarEnviado(clave, {
      ref: p.ref, courier: p.courier, enviados, wamids, enviado_en: ahora.toISOString(), plazo_h: p.plazoLecturaH ?? 4, texto: p.texto.slice(0, 1500),
    }).catch(() => {});
  }
  return { ok: enviados.length > 0, enviados, fallas, wamids };
}

let aprobadaCache: { valor: boolean; hasta: number } | null = null;

export const depsCourierWaReales: DepsCourierWa = {
  ahora: () => new Date(),
  config: async () => (await db().from("config_wa").select("valor").eq("clave", "transportadoras").maybeSingle()).data?.valor ?? null,
  async ultimoEntranteEn(telefono) {
    const { data: c } = await db().from("wa_clientes").select("id").eq("telefono", telefono).maybeSingle();
    if (!c) return null;
    const { data } = await db().from("wa_mensajes").select("creado_en").eq("cliente_id", c.id).eq("direccion", "in")
      .order("creado_en", { ascending: false }).limit(1).maybeSingle();
    return (data?.creado_en as string | undefined) ?? null;
  },
  async enviadosHoy(telefono, desdeISO) {
    const { data: c } = await db().from("wa_clientes").select("id").eq("telefono", telefono).maybeSingle();
    if (!c) return 0;
    const { count } = await db().from("wa_mensajes").select("id", { count: "exact", head: true }).eq("cliente_id", c.id)
      .eq("direccion", "out").eq("contenido->>origen", "transportadora").gte("creado_en", desdeISO);
    return count ?? 0;
  },
  async yaLeEscribimos(telefono) {
    const { data: c } = await db().from("wa_clientes").select("id").eq("telefono", telefono).maybeSingle();
    if (!c) return false;
    const { data } = await db().from("wa_mensajes").select("id").eq("cliente_id", c.id).eq("direccion", "out").neq("estado", "fallido").limit(1);
    return !!data?.length;
  },
  async yaEnviado(clave) {
    const { data } = await db().from("eventos_crudos").select("id").eq("id_externo", clave).limit(1);
    return !!data?.length;
  },
  async marcarEnviado(clave, payload) {
    await db().from("eventos_crudos").insert({ fuente: "whatsapp", id_externo: clave, payload, procesado_en: new Date().toISOString() });
  },
  chatDe: (t) => chatDeTransportadora(t),
  async plantillaAprobada() {
    if (aprobadaCache && aprobadaCache.hasta > Date.now()) return aprobadaCache.valor;
    const e = await estadoPlantilla(PLANTILLA_TRANSPORTADORA).catch(() => ({ estado: null }));
    aprobadaCache = { valor: e.estado === "APPROVED", hasta: Date.now() + 10 * 60_000 };
    return aprobadaCache.valor;
  },
  enviarTexto: (to, texto, ids) => enviarTexto(to, texto, { ...ids, origen: "transportadora" }),
  enviarPlantilla: (to, vars, ids) =>
    enviarPlantilla(to, PLANTILLA_TRANSPORTADORA, "es", [{ type: "body", parameters: vars.map((text) => ({ type: "text", text })) }],
      { ...ids, origen: "transportadora" }),
};

/** Cliente y conversación (humano/transportadora, sin marketing) para registrar el saliente; los crea si nunca escribieron. */
export async function chatDeTransportadora(t: Transportadora): Promise<IdsChat> {
  const sb = db();
  let { data: c } = await sb.from("wa_clientes").select("id").eq("telefono", t.telefono).maybeSingle();
  if (!c) {
    const r = await sb.from("wa_clientes").insert({ telefono: t.telefono, nombre: `${t.nombre} (${t.empresa})` }).select("id").single();
    if (r.error) throw new Error(`crear cliente transportadora: ${r.error.message}`);
    c = r.data;
  }
  let { data: conv } = await sb.from("wa_conversaciones").select("id,estado,asignado_a").eq("cliente_id", c!.id).neq("estado", "cerrada")
    .order("creado_en", { ascending: false }).limit(1).maybeSingle();
  if (!conv) {
    const r = await sb.from("wa_conversaciones").insert({ cliente_id: c!.id, estado: "humano", asignado_a: "transportadora" }).select("id,estado,asignado_a").single();
    if (r.error) throw new Error(`crear conversación transportadora: ${r.error.message}`);
    conv = r.data;
  } else if (conv.estado !== "humano" || conv.asignado_a !== "transportadora") {
    await sb.from("wa_conversaciones").update({ estado: "humano", asignado_a: "transportadora" }).eq("id", conv.id);
  }
  const { data: cons } = await sb.from("wa_consentimientos").select("estado").eq("cliente_id", c!.id).eq("tipo", "marketing")
    .order("creado_en", { ascending: false }).limit(1).maybeSingle();
  if (cons?.estado !== "no" && cons?.estado !== "baja") {
    await sb.from("wa_consentimientos").insert({ cliente_id: c!.id, tipo: "marketing", estado: "no", origen: "chat" });
  }
  return { clienteId: c!.id as string, conversacionId: conv!.id as string };
}
