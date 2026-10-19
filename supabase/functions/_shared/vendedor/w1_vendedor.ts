// _shared/vendedor/w1_vendedor.ts · Paquete 1 (19-10) · piezas puras que usa el orquestador
// - Tope de IA: nivel (normal / modelo barato / tope duro) y alertas de Telegram al 70% y 90% (una vez por mes).
// - Mensajes del cliente que NO van al vendedor (reacciones, botones de permiso de ofertas o de testimonio).
// - "Juntando datos": la espera para agrupar mensajes sube a ~18 s mientras el cliente manda la dirección en partes.
// - Acuse antes del pedido: nuestro último mensaje fue el precio con botones → se reenvían los botones (no es un cierre).
// - Un solo resumen vigente: el Confirmo de un resumen viejo con otro total no crea el pedido.
// - Acciones hechas en el turno (para que el filtro no deje confirmar lo que ninguna herramienta hizo).
// Sin I/O.
import { partesAsuncion } from "../horario.ts";
import type { CfgVendedorExtra } from "./config.ts";
import { extraerMontos } from "./filtro_salida.ts";
import { esOkSuelto, esStickerOEmoji } from "./respuestas_fijas.ts";

/** Lo mínimo de una fila de wa_mensajes que usan estas piezas (FilaHistorial del orquestador lo cumple). */
export type FilaW1 = {
  direccion: "in" | "out";
  texto: string | null;
  tipo: string | null;
  contenido: unknown;
  estado: string | null;
  wa_message_id: string | null;
};

type O = Record<string, unknown>;
const o = (x: unknown): O => (x && typeof x === "object" && !Array.isArray(x) ? x as O : {});
const lista = (x: unknown): unknown[] => (Array.isArray(x) ? x : []);
const normalizar = (s: string) => String(s ?? "").normalize("NFD").replace(/\p{M}/gu, "").toLowerCase().trim();

// ---------- tope de IA ----------

export type NivelTope = "normal" | "barato" | "duro";

/**
 * 19-10: el tope ya no pasa todo a "humano". Hasta `tope_mensual_usd` usa el modelo normal; entre el tope y el
 * tope duro (default tope × 1,3) usa `modelo_tope` (más barato); recién con el tope duro deriva como antes.
 */
export function nivelTope(gasto: number, tope: number, extra: CfgVendedorExtra): NivelTope {
  if (gasto >= extra.tope_duro_usd) return "duro";
  if (gasto >= tope) return "barato";
  return "normal";
}

/** "2026-10" en hora de Asunción (la clave del mes para no repetir alertas). */
export function mesAsuncion(ahora: Date): string {
  const p = partesAsuncion(ahora);
  return `${p.anio}-${String(p.mes).padStart(2, "0")}`;
}

export type AlertaTope = { clave: string; texto: string };

/**
 * Alertas que corresponden con este gasto (todas las cruzadas; el que llama deduplica por mes y clave).
 * Claves: "70", "90" (config alertas_tope_pct), "100" (pasó al modelo barato) y "duro" (todo chat nuevo a Enrique).
 */
export function alertasTope(gasto: number, tope: number, extra: CfgVendedorExtra): AlertaTope[] {
  if (!(tope > 0)) return [];
  const usd = (n: number) => n.toFixed(2);
  const pct = Math.floor((gasto / tope) * 100);
  const pie = `Al 100% pasa a ${extra.modelo_tope}; con USD ${usd(extra.tope_duro_usd)} (tope duro) todo chat nuevo pasa a vos.`;
  const out: AlertaTope[] = [];
  for (const u of [...extra.alertas_tope_pct].sort((a, b) => a - b)) {
    if (u < 100 && pct >= u) {
      out.push({ clave: String(u), texto: `<b>Vendedor IA: ${u}% del tope mensual</b>\nGastado USD ${usd(gasto)} de ${usd(tope)} este mes.\n${pie}` });
    }
  }
  if (gasto >= tope) {
    out.push({
      clave: "100",
      texto: `<b>Vendedor IA: llegó al tope (USD ${usd(tope)})</b>\nGastado USD ${usd(gasto)}. Sigue respondiendo con ${extra.modelo_tope}.\n` +
        `Con USD ${usd(extra.tope_duro_usd)} todo chat nuevo pasa a vos. Para subirlo: config_wa.vendedor.tope_mensual_usd.`,
    });
  }
  if (gasto >= extra.tope_duro_usd) {
    out.push({
      clave: "duro",
      texto: `<b>Vendedor IA: llegó al tope DURO (USD ${usd(extra.tope_duro_usd)})</b>\nGastado USD ${usd(gasto)}. Desde ahora cada chat nuevo se deriva a vos.`,
    });
  }
  return out;
}

// ---------- mensajes que no van al vendedor ----------

/** id del botón que tocó el cliente (interactivo o de plantilla), si lo hay. */
export function idBotonEntrante(f: FilaW1): string | null {
  const c = o(f.contenido);
  const id = o(o(c.interactive).button_reply).id ?? o(c.button).payload;
  return typeof id === "string" ? id : null;
}

/**
 * 19-10 (#1049, informe 02 §3d): mensajes del cliente que resuelve el webhook y nunca llegan al vendedor: reacciones,
 * botones del permiso de ofertas (cons_si / cons_no) o del testimonio (tst_si / tst_no), y los que el webhook marque
 * con contenido.no_vendedor = true (el "sí" de la plantilla de confirmación, BAJA…).
 */
export function esEntranteNoVendedor(f: FilaW1): boolean {
  if (f.direccion !== "in") return false;
  if (f.tipo === "reaction") return true;
  if (o(f.contenido).no_vendedor === true) return true;
  const id = idBotonEntrante(f);
  return !!id && /^(?:cons_si|cons_no|tst_si|tst_no):/.test(id);
}

/**
 * ¿Entre los mensajes posteriores al actual hay alguno que sí va al vendedor? null = no se puede saber (el actual no
 * está en las filas o no hay posteriores): el que llama queda con la regla de siempre (agrupar).
 */
export function hayPosteriorParaVendedor(filas: FilaW1[], idActual: string): boolean | null {
  const i = filas.findIndex((f) => f.wa_message_id === idActual);
  if (i < 0) return null;
  const posteriores = filas.slice(i + 1).filter((f) => f.direccion === "in");
  if (!posteriores.length) return null;
  return posteriores.some((f) => !esEntranteNoVendedor(f));
}

/** Mensajes pendientes del cliente (desde nuestro último mensaje) sin los que no van al vendedor, en orden. */
export function bloqueParaAcuse(filas: FilaW1[], idActual: string, textoActual: string): string[] {
  const out: string[] = [];
  let visto = false;
  for (let i = filas.length - 1; i >= 0; i--) {
    const f = filas[i];
    if (f.direccion === "out") {
      if (f.estado === "fallido") continue;
      break;
    }
    if (f.wa_message_id && f.wa_message_id === idActual) {
      visto = true;
      out.unshift(textoActual);
      continue;
    }
    if (esEntranteNoVendedor(f)) continue;
    const t = (f.texto ?? (typeof o(f.contenido).texto_vendedor === "string" ? o(f.contenido).texto_vendedor as string : "")).trim();
    out.unshift(t || `[${f.tipo ?? "mensaje"}]`);
  }
  if (!visto) out.push(textoActual);
  return out;
}

// ---------- juntando datos (espera variable) ----------

const RE_PIDE_DATOS = /direccion|ubicacion|ciudad|barrio|referencia|tu nombre|nombre y|nombre completo|calle|tus datos|los datos|el pin|nro de casa|numero de casa/;
const RE_DIRECCION = /(?:^|\s)(?:calle|casi|c\/|esq\.?|esquina|barrio|b°|bo\.|nro\.?|n°|km|avda\.?|avenida|av\.|ruta|entre|frente a|al lado|cerca de|edificio|depto|departamento|casa)(?=\s|\d|$)/;
const RE_CONECTOR_FINAL = /(?:\b(?:y|casi|entre|de|del|con|en|a|al|la|el|frente|esquina|calle|nro|numero|barrio|ciudad)|,)$/;

/**
 * 19-10 (informe 02 §3d: 4 resúmenes para una dirección mandada en 4 partes en 70 s): ¿el cliente está mandando
 * datos? Sí si nuestro último mensaje pidió datos (texto o pedido de ubicación / formulario), si tocó "Corregir" en el
 * resumen, si lo que escribe parece una dirección, o si el mensaje parece cortado (corto y termina en "y", "casi", ",").
 */
export function juntandoDatos(filas: FilaW1[], textoActual: string): boolean {
  const t = normalizar(textoActual);
  if (!t || esOkSuelto(textoActual) || esStickerOEmoji(textoActual)) return false;
  if (/\(vend_corr:/.test(textoActual)) return true;
  const nuestro = [...filas].reverse().find((f) => f.direccion === "out" && f.estado !== "fallido");
  if (nuestro) {
    const tipoInt = o(o(nuestro.contenido).interactive).type;
    if (tipoInt === "location_request_message" || tipoInt === "flow") return true;
    // El resumen con Confirmo / Corregir no cuenta como "pedir datos": ahí se espera el sí.
    const esResumen = /vend_conf:/.test(JSON.stringify(o(nuestro.contenido).interactive ?? ""));
    if (!esResumen && RE_PIDE_DATOS.test(normalizar(nuestro.texto ?? ""))) return true;
  }
  if (RE_DIRECCION.test(t)) return true;
  const sinFin = !/[.!?…)\]]$/.test(t) && !/\p{Extended_Pictographic}$/u.test(t);
  return sinFin && t.length <= 40 && RE_CONECTOR_FINAL.test(t);
}

// ---------- acuse antes del pedido ----------

function idsBotones(f: FilaW1): string[] {
  const ids: string[] = [];
  for (const b of lista(o(o(o(f.contenido).interactive).action).buttons)) {
    const id = o(o(b).reply).id;
    if (typeof id === "string") ids.push(id);
  }
  return ids;
}

/** Texto del cuerpo de un interactivo nuestro (o el texto guardado). */
export function cuerpoSaliente(f: FilaW1): string {
  const b = o(o(o(f.contenido).interactive).body).text;
  return typeof b === "string" ? b : (f.texto ?? "");
}

/**
 * 19-10 (paquete 1, punto 7): nuestro mensaje fue una oferta con precio: los botones del primer turno / cierre
 * (vend_p1:… / vend_cant:…) o un texto con un monto en guaraníes. Un "ok" a eso NO es un cierre.
 */
export function esOfertaNuestra(f: FilaW1 | undefined | null): boolean {
  if (!f || f.direccion !== "out") return false;
  if (idsBotones(f).some((id) => /^vend_(?:p1|cant):/.test(id))) return true;
  if (idsBotones(f).some((id) => /^vend_(?:conf|corr|ubi):/.test(id))) return false;
  return extraerMontos(cuerpoSaliente(f)).length > 0;
}

/** Handle del producto de los últimos botones de oferta que mandamos (vend_p1:<op>:<handle> / vend_cant:<handle>:<n>). */
export function handleDeOferta(filas: FilaW1[]): string | null {
  for (let i = filas.length - 1; i >= 0; i--) {
    const f = filas[i];
    if (f.direccion !== "out" || f.estado === "fallido") continue;
    for (const id of idsBotones(f)) {
      const p1 = /^vend_p1:[^:]+:(.+)$/.exec(id);
      if (p1) return p1[1];
      const c = /^vend_cant:([^:]+):\d+$/.exec(id);
      if (c) return c[1];
    }
  }
  return null;
}

/** ¿Nuestro último mensaje ya fue el reenvío de botones por un acuse? (para no mandarlos en cada "ok"). */
export function yaReenvioBotones(f: FilaW1 | undefined | null, variantes: string[]): boolean {
  if (!f || f.direccion !== "out" || !idsBotones(f).some((id) => id.startsWith("vend_p1:"))) return false;
  const c = normalizar(cuerpoSaliente(f));
  return variantes.some((v) => normalizar(v) === c);
}

// ---------- un solo resumen vigente ----------

/** Cuerpo del resumen que mandamos con los botones vend_conf:<id>, si está en el historial. */
export function cuerpoResumen(filas: FilaW1[], pedidoChatId: string): string | null {
  for (let i = filas.length - 1; i >= 0; i--) {
    const f = filas[i];
    if (f.direccion === "out" && idsBotones(f).includes(`vend_conf:${pedidoChatId}`)) return cuerpoSaliente(f);
  }
  return null;
}

/** Huella económica de un resumen: montos y cantidades (x2). La dirección o la nota no cuentan. */
function huellaResumen(cuerpo: string): string {
  const montos = [...new Set(extraerMontos(cuerpo))].sort((a, b) => a - b);
  const cant = [...normalizar(cuerpo).matchAll(/\bx\s?(\d{1,2})\b/g)].map((m) => m[1]).sort();
  return `${montos.join(",")}|${cant.join(",")}`;
}

export type MotivoConfirmacionBloqueada = { error: string };

/**
 * 19-10 (informe 02 §3d, #1056): antes de crear el pedido con confirmar=true.
 * - Si en los mensajes pendientes tocó un botón de cantidad (vend_p1:q… / vend_cant:…), eligió otra cantidad después
 *   del resumen: se arma un resumen nuevo.
 * - Si tocó Confirmo en un resumen anterior (vend_conf:<id viejo>) y el vigente tiene otro total o cantidad, no se crea:
 *   se vuelve a mostrar el vigente. Con el mismo total vale (08-10: la clienta confirmó justo cuando se rehacía con su nota).
 */
export function confirmacionBloqueada(p: {
  textoCliente: string;
  filas: FilaW1[];
  vigente: { id: string; estado: string } | null;
}): MotivoConfirmacionBloqueada | null {
  if (!p.vigente || p.vigente.estado !== "resumen") return null;
  if (/\(vend_(?:p1:(?:q\d|pack)|cant):[^)]*\)/.test(p.textoCliente)) {
    return {
      error: "cantidad_elegida_despues_del_resumen: el cliente tocó un botón de cantidad después del resumen. " +
        "No crees el pedido: armá un resumen nuevo con crear_pedido_cod confirmar=false con esa cantidad.",
    };
  }
  const tocados = [...p.textoCliente.matchAll(/\(vend_conf:([^)\s]+)\)/g)].map((m) => m[1]);
  const tocado = tocados.at(-1);
  if (!tocado || tocado === p.vigente.id) return null;
  const viejo = cuerpoResumen(p.filas, tocado);
  const actual = cuerpoResumen(p.filas, p.vigente.id);
  if (!viejo || !actual || huellaResumen(viejo) === huellaResumen(actual)) return null;
  return {
    error: "boton_de_resumen_viejo: el cliente tocó Confirmo en un resumen anterior que tenía otro total o cantidad. " +
      "No crees el pedido: volvé a mostrar el resumen vigente con crear_pedido_cod confirmar=false (mismos datos) para que confirme ese.",
  };
}

// ---------- acciones hechas en el turno ----------

/**
 * 19-10 (paquete 1, punto 2): lo que las herramientas hicieron de verdad en este turno, para el filtro de salida.
 * crear_pedido_cod solo cuenta como acción con confirmar=true ("crear_pedido_cod:confirmar").
 */
export function accionesHechas(
  herramientas: Array<{ nombre: string; input: unknown; resultado: unknown; error: boolean }>,
  extra: { pedidoYaCreado?: boolean; pedidoConfirmadoSistema?: boolean } = {},
): string[] {
  const out = new Set<string>();
  for (const h of herramientas) {
    if (h.error || o(h.resultado).ok === false) continue;
    if (h.nombre === "crear_pedido_cod") {
      if (o(h.input).confirmar === true) out.add("crear_pedido_cod:confirmar");
      continue;
    }
    out.add(h.nombre);
  }
  if (extra.pedidoYaCreado) out.add("pedido_ya_creado");
  if (extra.pedidoConfirmadoSistema) out.add("pedido_confirmado_sistema");
  return [...out];
}
