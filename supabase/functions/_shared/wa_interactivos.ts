// Mensajes interactivos de WhatsApp para cerrar la venta dentro del chat · dueño: G2 (ola 2).
// Graph v25.0. Formatos verificados en la documentación de Meta (06-10-2026):
//   - location_request_message (cuerpo ≤ 1024, action.name "send_location")
//   - flow (flow_message_version "3", flow_action "navigate", CTA ≤ 30 sin emoji)
//   - carousel (2 a 10 tarjetas, cabecera imagen/video, cuerpo de tarjeta ≤ 160 y ≤ 2 saltos,
//     mismo tipo y cantidad de botones en todas; la tarjeta NO tiene campo título)
//   - request_contact_info (botón fijo de WhatsApp; requiere ventana de 24 h abierta)
//   - button (botones de respuesta: 1 a 3, título ≤ 20, id ≤ 256)
// Los constructores son puros: devuelven el objeto `interactive` y lanzan ErrorInteractivo si
// algo viola un límite. `enviarInteractivo` lo manda con las mismas reglas que _shared/wa.ts.

import { contienePalabraProhibida } from "./filtro.ts";
import { db } from "./db.ts";
import { destinatario, GRAPH_URL, type OpcionesEnvio, type ResultadoEnvio } from "./wa.ts";

export class ErrorInteractivo extends Error {
  constructor(public codigo: string) {
    super(codigo);
    this.name = "ErrorInteractivo";
  }
}

// deno-lint-ignore no-explicit-any
export type Interactivo = Record<string, any>;

export type Tarjeta = {
  imagenUrl: string;
  titulo: string;
  cuerpo?: string;
  botonId: string;
  botonTexto: string;
};

const LIMITE_CUERPO = 1024;
const LIMITE_TITULO_BOTON = 20;
const LIMITE_ID_BOTON = 256;
const LIMITE_CUERPO_TARJETA = 160;
const LIMITE_CTA_FLOW = 30;
const LIMITE_CABECERA = 60;
const EMOJI = /\p{Extended_Pictographic}/u;

function exigirTexto(texto: string, limite: number, codigo: string): string {
  if (typeof texto !== "string" || !texto.trim()) throw new ErrorInteractivo(`${codigo}_vacio`);
  if (texto.length > limite) throw new ErrorInteractivo(`${codigo}_mayor_a_${limite}`);
  return texto;
}

function exigirBoton(id: string, titulo: string): void {
  exigirTexto(id, LIMITE_ID_BOTON, "id_boton");
  exigirTexto(titulo, LIMITE_TITULO_BOTON, "titulo_boton");
}

// ---------- constructores ----------

/** Pide al cliente el pin de su ubicación con un toque. */
export function ubicacionRequest(texto: string): Interactivo {
  exigirTexto(texto, LIMITE_CUERPO, "cuerpo");
  return { type: "location_request_message", body: { text: texto }, action: { name: "send_location" } };
}

/**
 * Abre el formulario de pedido (WhatsApp Flow publicado, sin endpoint).
 * `token` vuelve en el nfm_reply (response_json.flow_token): usar algo como `pedido:<conversacion_id>`.
 */
export function flowFormulario(o: {
  flowId: string;
  token: string;
  titulo: string;
  cta: string;
  texto?: string;
  pantalla?: string;
  modo?: "draft" | "published";
}): Interactivo {
  exigirTexto(o.flowId, 64, "flow_id");
  exigirTexto(o.token, 256, "flow_token");
  exigirTexto(o.titulo, LIMITE_CABECERA, "titulo");
  exigirTexto(o.cta, LIMITE_CTA_FLOW, "cta");
  if (EMOJI.test(o.cta)) throw new ErrorInteractivo("cta_con_emoji");
  const cuerpo = exigirTexto(o.texto ?? o.titulo, LIMITE_CUERPO, "cuerpo");
  const parameters: Record<string, unknown> = {
    flow_message_version: "3",
    flow_token: o.token,
    flow_id: o.flowId,
    flow_cta: o.cta,
    flow_action: "navigate",
    flow_action_payload: { screen: o.pantalla ?? "PEDIDO" },
  };
  if (o.modo) parameters.mode = o.modo;
  return {
    type: "flow",
    header: { type: "text", text: o.titulo },
    body: { text: cuerpo },
    action: { name: "flow", parameters },
  };
}

/**
 * Carrusel ×1/×2/×3: 2 a 10 tarjetas, cada una con imagen y UN botón de respuesta rápida.
 * Meta no tiene título de tarjeta: va en negrita en la primera línea del cuerpo (total ≤ 160, ≤ 2 saltos).
 */
export function carruselOpciones(texto: string, tarjetas: Tarjeta[]): Interactivo {
  exigirTexto(texto, LIMITE_CUERPO, "cuerpo");
  if (!Array.isArray(tarjetas) || tarjetas.length < 2 || tarjetas.length > 10) {
    throw new ErrorInteractivo("tarjetas_2_a_10");
  }
  const ids = new Set<string>();
  const cards = tarjetas.map((t, i) => {
    if (typeof t.imagenUrl !== "string" || !/^https:\/\/\S+$/.test(t.imagenUrl)) {
      throw new ErrorInteractivo(`imagen_url_invalida:${i}`);
    }
    exigirTexto(t.titulo, LIMITE_CUERPO_TARJETA, "titulo_tarjeta");
    exigirBoton(t.botonId, t.botonTexto);
    if (ids.has(t.botonId)) throw new ErrorInteractivo(`id_boton_repetido:${t.botonId}`);
    ids.add(t.botonId);
    const cuerpo = t.cuerpo?.trim() ? `*${t.titulo}*\n${t.cuerpo.trim()}` : `*${t.titulo}*`;
    if (cuerpo.length > LIMITE_CUERPO_TARJETA) throw new ErrorInteractivo(`cuerpo_tarjeta_mayor_a_160:${i}`);
    if ((cuerpo.match(/\n/g) ?? []).length > 2) throw new ErrorInteractivo(`cuerpo_tarjeta_mas_de_2_saltos:${i}`);
    return {
      card_index: i,
      // La documentación de Meta usa "cta_url" como tipo de tarjeta también con botones quick_reply.
      type: "cta_url",
      header: { type: "image", image: { link: t.imagenUrl } },
      body: { text: cuerpo },
      action: { buttons: [{ type: "quick_reply", quick_reply: { id: t.botonId, title: t.botonTexto } }] },
    };
  });
  return { type: "carousel", body: { text: texto }, action: { cards } };
}

/** Botón nativo "compartir mi número" (para clientes que llegaron con nombre de usuario, sin teléfono). */
/**
 * Opciones en vertical (07-10): foto arriba, el detalle en el texto y hasta 3 botones apilados.
 * Reemplaza al carrusel, que en el celular cortaba las tarjetas y obligaba a deslizar.
 */
export function listaVertical(texto: string, imagenUrl: string, opciones: { id: string; titulo: string }[]): Interactivo {
  exigirTexto(texto, LIMITE_CUERPO, "cuerpo");
  if (!/^https:\/\/\S+$/.test(imagenUrl)) throw new ErrorInteractivo("imagen_url_invalida");
  if (!Array.isArray(opciones) || opciones.length < 1 || opciones.length > 3) throw new ErrorInteractivo("opciones_1_a_3");
  const ids = new Set<string>();
  for (const o of opciones) {
    exigirBoton(o.id, o.titulo);
    if (ids.has(o.id)) throw new ErrorInteractivo(`id_boton_repetido:${o.id}`);
    ids.add(o.id);
  }
  return {
    type: "button",
    header: { type: "image", image: { link: imagenUrl } },
    body: { text: texto },
    action: { buttons: opciones.map((o) => ({ type: "reply", reply: { id: o.id, title: o.titulo } })) },
  };
}

export function pedirContacto(texto: string): Interactivo {
  exigirTexto(texto, LIMITE_CUERPO, "cuerpo");
  return { type: "request_contact_info", body: { text: texto }, action: { name: "request_contact_info" } };
}

/** Dos botones de respuesta (por defecto "Sí" / "No"). */
export function botonesSiNo(
  texto: string,
  idSi: string,
  idNo: string,
  titulos: { si?: string; no?: string } = {},
): Interactivo {
  exigirTexto(texto, LIMITE_CUERPO, "cuerpo");
  const si = titulos.si ?? "Sí";
  const no = titulos.no ?? "No";
  exigirBoton(idSi, si);
  exigirBoton(idNo, no);
  if (idSi === idNo) throw new ErrorInteractivo("ids_iguales");
  return {
    type: "button",
    body: { text: texto },
    action: {
      buttons: [
        { type: "reply", reply: { id: idSi, title: si } },
        { type: "reply", reply: { id: idNo, title: no } },
      ],
    },
  };
}

/** Textos que ve el cliente (para el filtro de palabras prohibidas y la bandeja). */
export function textosVisibles(i: Interactivo): string[] {
  const out: string[] = [];
  const push = (x: unknown) => typeof x === "string" && x && out.push(x);
  push(i?.header?.text);
  push(i?.body?.text);
  push(i?.footer?.text);
  push(i?.action?.parameters?.flow_cta);
  for (const b of i?.action?.buttons ?? []) push(b?.reply?.title ?? b?.quick_reply?.title);
  for (const c of i?.action?.cards ?? []) {
    push(c?.body?.text);
    push(c?.action?.parameters?.display_text);
    for (const b of c?.action?.buttons ?? []) push(b?.quick_reply?.title);
  }
  return out;
}

// ---------- parsers (reciben un elemento de value.messages[] del webhook) ----------

// deno-lint-ignore no-explicit-any
type MensajeEntrante = Record<string, any> | null | undefined;

export type Ubicacion = {
  latitud: number;
  longitud: number;
  nombre: string | null;
  direccion: string | null;
  url: string | null;
  mapsUrl: string;
};

export function parsearUbicacion(m: MensajeEntrante): Ubicacion | null {
  if (!m || m.type !== "location" || !m.location) return null;
  const lat = Number(m.location.latitude);
  const lon = Number(m.location.longitude);
  if (!Number.isFinite(lat) || !Number.isFinite(lon) || Math.abs(lat) > 90 || Math.abs(lon) > 180) return null;
  const s = (x: unknown) => (typeof x === "string" && x.trim() ? x.trim() : null);
  return {
    latitud: lat,
    longitud: lon,
    nombre: s(m.location.name),
    direccion: s(m.location.address),
    url: s(m.location.url),
    mapsUrl: `https://www.google.com/maps?q=${lat},${lon}`,
  };
}

export type RespuestaFlow = {
  flowToken: string | null;
  datos: Record<string, unknown>;
  cuerpo: string | null;
  nombre: string | null;
  contextoId: string | null;
  jsonInvalido: boolean;
};

/** nfm_reply: `response_json` llega como string JSON con flow_token + el payload del `complete`. */
export function parsearFlow(m: MensajeEntrante): RespuestaFlow | null {
  if (!m || m.type !== "interactive" || m.interactive?.type !== "nfm_reply") return null;
  const r = m.interactive.nfm_reply ?? {};
  let datos: Record<string, unknown> = {};
  let jsonInvalido = false;
  try {
    const crudo = typeof r.response_json === "string" ? JSON.parse(r.response_json) : r.response_json;
    if (crudo && typeof crudo === "object" && !Array.isArray(crudo)) datos = { ...crudo };
    else jsonInvalido = true;
  } catch {
    jsonInvalido = true;
  }
  const flowToken = typeof datos.flow_token === "string" ? datos.flow_token : null;
  delete datos.flow_token;
  return {
    flowToken,
    datos,
    cuerpo: typeof r.body === "string" ? r.body : null,
    nombre: typeof r.name === "string" ? r.name : null,
    contextoId: m.context?.id ?? null,
    jsonInvalido,
  };
}

export type DatosPedidoFlow = {
  nombre: string;
  ciudad: string;
  direccion: string;
  referencia: string | null;
  cantidad: 1 | 2 | 3;
};

/**
 * Normaliza los datos de supabase/flows/formulario_pedido.json. Si elige "Otra" ciudad, usa `otra_ciudad`.
 * Devuelve {faltan[]} si algo obligatorio no vino.
 */
export function datosFormularioPedido(
  datos: Record<string, unknown>,
  titulosCiudad: Record<string, string> = {},
): { ok: true; pedido: DatosPedidoFlow } | { ok: false; faltan: string[] } {
  const s = (k: string) => (typeof datos[k] === "string" ? (datos[k] as string).trim() : "");
  const faltan: string[] = [];
  const nombre = s("nombre");
  const direccion = s("direccion");
  const idCiudad = s("ciudad");
  let ciudad = idCiudad === "otra" ? s("otra_ciudad") : (titulosCiudad[idCiudad] ?? idCiudad);
  if (idCiudad === "otra" && !ciudad) faltan.push("otra_ciudad");
  ciudad = ciudad.replace(/_/g, " ");
  const cantidad = Number(s("cantidad") || datos.cantidad);
  if (!nombre) faltan.push("nombre");
  if (!idCiudad) faltan.push("ciudad");
  if (!direccion) faltan.push("direccion");
  if (![1, 2, 3].includes(cantidad)) faltan.push("cantidad");
  if (faltan.length) return { ok: false, faltan };
  return {
    ok: true,
    pedido: { nombre, ciudad, direccion, referencia: s("referencia") || null, cantidad: cantidad as 1 | 2 | 3 },
  };
}

export type ContactoCompartido = {
  origen: "contact_request" | "other" | null;
  esPedidoDeContacto: boolean;
  telefonoE164: string | null;
  telefonos: { telefono: string | null; waId: string | null; tipo: string | null }[];
  nombre: string | null;
  deUsuarioId: string | null;
  vcard: string | null;
};

/**
 * Mensaje `contacts`: si `origin` = "contact_request" es el propio cliente que tocó REQUEST_CONTACT_INFO.
 * Con `origin` = "other" compartió una tarjeta cualquiera (puede ser de otra persona): no asumir que es su número.
 */
export function parsearContacto(m: MensajeEntrante): ContactoCompartido | null {
  if (!m || m.type !== "contacts" || !Array.isArray(m.contacts) || !m.contacts.length) return null;
  const c = m.contacts[0] ?? {};
  const telefonos = (Array.isArray(c.phones) ? c.phones : []).map((p: Record<string, unknown>) => ({
    telefono: typeof p?.phone === "string" ? p.phone : null,
    waId: typeof p?.wa_id === "string" ? p.wa_id : null,
    tipo: typeof p?.type === "string" ? p.type : null,
  }));
  let telefonoE164: string | null = null;
  for (const t of telefonos) {
    const d = (t.waId ?? t.telefono ?? "").replace(/\D/g, "");
    if (d.length >= 8 && d.length <= 15 && !d.startsWith("0")) {
      telefonoE164 = `+${d}`;
      break;
    }
  }
  const origen = c.origin === "contact_request" || c.origin === "other" ? c.origin : null;
  return {
    origen,
    esPedidoDeContacto: origen === "contact_request",
    telefonoE164,
    telefonos,
    nombre: typeof c.name?.formatted_name === "string" ? c.name.formatted_name : null,
    deUsuarioId: typeof m.from_user_id === "string" ? m.from_user_id : null,
    vcard: typeof c.vcard === "string" ? c.vcard : null,
  };
}

// ---------- envío genérico de `interactive` ----------
// _shared/wa.ts (ola 1) no exporta un envío genérico ni su entorno; esto replica sus convenciones:
// destinatario() (teléfono → to, BSUID → recipient), filtro de palabras prohibidas que falla cerrado,
// POST a /{phone_id}/messages y registro en wa_mensajes (también los bloqueados o fallidos).

export type EntornoInteractivos = {
  fetch: typeof fetch;
  token: () => string | undefined;
  phoneNumberId: () => string | undefined;
  palabrasProhibidas: () => Promise<string[] | null>;
  registrar: (fila: Record<string, unknown>) => Promise<void>;
  resolverDestino: (to: string) => Promise<{ clienteId: string | null; conversacionId: string | null }>;
};

let cachePalabras: { lista: string[]; hasta: number } | null = null;

const entornoPorDefecto: EntornoInteractivos = {
  fetch: (...a) => fetch(...a),
  token: () => Deno.env.get("WA_TOKEN"),
  phoneNumberId: () => Deno.env.get("WA_PHONE_NUMBER_ID"),
  palabrasProhibidas: async () => {
    if (cachePalabras && cachePalabras.hasta > Date.now()) return cachePalabras.lista;
    const { data, error } = await db().from("config_wa").select("valor").eq("clave", "palabras_prohibidas")
      .maybeSingle();
    if (error) return null;
    const v = data?.valor;
    const lista = Array.isArray(v) ? v : Array.isArray(v?.lista) ? v.lista : null;
    if (!lista) return null;
    const limpia = lista.filter((x: unknown) => typeof x === "string") as string[];
    cachePalabras = { lista: limpia, hasta: Date.now() + 5 * 60_000 };
    return limpia;
  },
  registrar: async (fila) => {
    const { error } = await db().from("wa_mensajes").insert(fila);
    if (error) console.error("wa_mensajes insert (out interactivo):", error.message);
  },
  resolverDestino: async (to) => {
    const d = destinatario(to);
    let clienteId: string | null = null;
    if ("to" in d) {
      const { data } = await db().from("wa_clientes").select("id").eq("telefono", `+${d.to}`).maybeSingle();
      clienteId = data?.id ?? null;
    } else if ("recipient" in d) {
      const { data } = await db().from("wa_clientes").select("id").eq("wa_user_id", d.recipient).maybeSingle();
      clienteId = data?.id ?? null;
    }
    if (!clienteId) return { clienteId: null, conversacionId: null };
    const { data: conv } = await db().from("wa_conversaciones").select("id").eq("cliente_id", clienteId)
      .neq("estado", "cerrada").order("creado_en", { ascending: false }).limit(1).maybeSingle();
    return { clienteId, conversacionId: conv?.id ?? null };
  },
};

let entorno: EntornoInteractivos = entornoPorDefecto;

/** Solo para tests: reemplaza dependencias. Sin argumentos vuelve al real. */
export function _configurarInteractivos(parcial?: Partial<EntornoInteractivos>): void {
  entorno = parcial ? { ...entornoPorDefecto, ...parcial } : entornoPorDefecto;
  cachePalabras = null;
}

/** Manda un objeto `interactive` (de los constructores de arriba o de wa.ts) y lo registra. */
export async function enviarInteractivo(
  to: string,
  interactive: Interactivo,
  ctx?: OpcionesEnvio,
): Promise<ResultadoEnvio> {
  const dest = destinatario(to);
  const payload = { messaging_product: "whatsapp", recipient_type: "individual", ...dest, type: "interactive", interactive };
  const textos = textosVisibles(interactive);
  const visible = `[${interactive?.type ?? "interactive"}] ${textos.join(" | ")}`.trim();

  let bloqueo: string | null = "error" in dest ? dest.error : null;
  if (!bloqueo && (!interactive || typeof interactive.type !== "string")) bloqueo = "interactive_invalido";
  if (!bloqueo) {
    const lista = await entorno.palabrasProhibidas();
    if (!lista) bloqueo = "config_palabras_prohibidas_no_disponible";
    else {
      for (const t of textos) {
        const p = contienePalabraProhibida(t, lista);
        if (p) {
          bloqueo = `palabra_prohibida:${p}`;
          break;
        }
      }
    }
  }

  let resultado: ResultadoEnvio;
  let errorDetalle: unknown = null;
  if (bloqueo) {
    resultado = { ok: false, error: bloqueo };
    errorDetalle = { motivo: bloqueo };
  } else {
    const token = entorno.token();
    const phoneId = entorno.phoneNumberId();
    if (!token || !phoneId) {
      resultado = { ok: false, error: "faltan_WA_TOKEN_o_WA_PHONE_NUMBER_ID" };
      errorDetalle = { motivo: resultado.error };
    } else {
      try {
        const r = await entorno.fetch(`${GRAPH_URL}/${phoneId}/messages`, {
          method: "POST",
          headers: { "Authorization": `Bearer ${token}`, "Content-Type": "application/json" },
          body: JSON.stringify(payload),
        });
        const j = await r.json().catch(() => ({}));
        if (!r.ok || j?.error) {
          const e = j?.error ?? {};
          resultado = { ok: false, error: `${e.code ?? r.status}: ${e.message ?? "error_graph"}` };
          errorDetalle = { motivo: resultado.error, respuesta: j };
        } else {
          resultado = { ok: true, wa_message_id: j?.messages?.[0]?.id };
        }
      } catch (e) {
        resultado = { ok: false, error: `red: ${e instanceof Error ? e.message : String(e)}` };
        errorDetalle = { motivo: resultado.error };
      }
    }
  }

  try {
    let clienteId = ctx?.clienteId ?? null;
    let conversacionId = ctx?.conversacionId ?? null;
    if (!clienteId || !conversacionId) {
      const r = await entorno.resolverDestino(to);
      clienteId = clienteId ?? r.clienteId;
      conversacionId = conversacionId ?? r.conversacionId;
    }
    await entorno.registrar({
      conversacion_id: conversacionId,
      cliente_id: clienteId,
      direccion: "out",
      wa_message_id: resultado.wa_message_id ?? null,
      tipo: "interactive",
      texto: visible,
      contenido: payload,
      estado: resultado.ok ? "enviado" : "fallido",
      error: errorDetalle,
    });
  } catch (e) {
    console.error("registro de interactivo saliente falló:", e);
  }
  return resultado;
}
