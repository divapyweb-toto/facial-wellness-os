// _shared/vendedor/email_factura.ts · Dueño: E (29-10, pedido de Enrique: "el cliente puede pedir su factura por correo").
// Herramienta guardar_email_factura + la pregunta del mail en guardar_factura (una sola vez por chat).
//   - El cliente pasa su correo o pide la factura por mail → el modelo llama guardar_email_factura. El email se toma
//     del texto del cliente (no de lo que tipeó el modelo, si difieren), se valida (emailValido de _shared/correo.ts)
//     y se guarda en el pedido abierto o el último del cliente (resolverPedido de pedidos_web.ts).
//   - Si ese pedido ya tiene factura aprobada con KuDE, se le manda por correo en el momento (canal correo forzado,
//     mismo armado que la cadena de entrega del agente B). Si no salió (sin RESEND_API_KEY o error), aviso a Enrique.
//   - Si la factura todavía no existe, queda guardado y la cadena de entrega lo usa cuando salga.
// Por qué herramienta y no detección en el orquestador: el pedido correcto (abierto, último, el que nombró, de otro
// número) ya lo resuelve resolverPedido con las mismas reglas que guardar_factura, y el modelo decide si el mail es para
// la factura. La parte frágil (sacar y validar el email) es determinística acá adentro.
// OJO (import circular, igual que pedidos_web.ts): herramientas.ts importa este archivo; acá solo se usa lo importado
// dentro de funciones, y lo que herramientas.ts llama al cargar son declaraciones de función.
import type { Herramienta } from "../claude.ts";
import { emailValido } from "../correo.ts";
import { escaparHtml } from "../telegram_formato.ts";
import type { Ejecutor, ResultadoHerramienta } from "./herramientas.ts";
import { claveAvisoFactura, herramientasPedidosWeb, resolverPedido, TAG_REEMPLAZADO, TIPO_AVISO_FACTURA } from "./pedidos_web.ts";
import type { CtxTurno, DepsHerramientas } from "./tipos.ts";

// ---------- tipos y dependencias ----------

export interface FacturaParaReenvio {
  id: string;
  numero_completo: string;
  total: number | null;
  kude_path: string;
}

export interface DepsEmailFactura {
  /** Guarda el email del pedido (pedido_email_factura; y pedido_datos_fiscales.email si el pedido ya tiene fila). */
  guardar(orderId: number, email: string, meta: { conversacionId: string; clienteId: string | null }): Promise<{ ok: boolean; error?: string }>;
  /** Factura electrónica (tipo 1) APROBADA de producción con KuDE del pedido, o null. */
  facturaAprobada(orderId: number): Promise<FacturaParaReenvio | null>;
  /** Manda el KuDE por correo (URL firmada + correoFactura). `simulado` = sin RESEND_API_KEY: no salió nada. */
  enviarFactura(a: { factura: FacturaParaReenvio; email: string; pedido: string; nombre: string | null }): Promise<{ ok: boolean; simulado?: boolean; error?: string }>;
  /** Email ya guardado desde este chat (o null) y los últimos textos del bot en la conversación. */
  estadoConversacion(conversacionId: string): Promise<{ email: string | null; textosBot: string[] }>;
}

// ---------- utilidades puras ----------

/** Pregunta que el modelo puede hacer UNA vez después de guardar_factura (pedido de Enrique 29-10). */
export const PREGUNTA_EMAIL = "¿Te la mando también por correo? Pasame tu mail";

export const textoEmailGuardado = (email: string) => `Listo, te la mando a ${email} apenas esté.`;
export const textoEmailReenviado = (email: string) => `Te la reenvié a ${email}.`;
/** La factura existe pero el correo no salió solo: la manda Enrique (aviso por Telegram). */
export const textoEmailManual = (email: string) => `Listo, te la mando a ${email} en un rato.`;

/** Todos los emails válidos del texto, en minúscula y sin repetir. Tolera "ana @ gmail.com", "mailto:" y el punto final. */
export function extraerEmails(texto: string | null | undefined): string[] {
  const t = String(texto ?? "").normalize("NFC").replace(/\s*@\s*/g, "@");
  const out: string[] = [];
  for (const m of t.matchAll(/[^\s@<>,;:()[\]"'¿?¡!]+@[^\s@<>,;:()[\]"'¿?¡!]+/g)) {
    const e = m[0].replace(/^[.\-_]+/, "").replace(/[.\-_]+$/, "").toLowerCase();
    if (emailValido(e) && !out.includes(e)) out.push(e);
  }
  return out;
}

/**
 * Email a guardar: el que mandó el modelo si está en el texto del cliente (o el cliente no escribió ninguno en este
 * turno); si el modelo lo copió distinto y el cliente escribió uno solo, manda el del cliente. null = no hay uno claro.
 */
export function elegirEmail(delModelo: unknown, textoCliente: string | null | undefined): string | null {
  const m = extraerEmails(typeof delModelo === "string" ? delModelo : "")[0] ?? null;
  const t = extraerEmails(textoCliente);
  if (m && (t.length === 0 || t.includes(m))) return m;
  return t.length === 1 ? t[0] : null;
}

/** Dominios mal escritos frecuentes → el correcto. Un mail a "gmail.con" se pierde sin aviso. */
const DOMINIOS_TIPEO: Record<string, string> = {
  "gmail.con": "gmail.com", "gmail.co": "gmail.com", "gmail.cm": "gmail.com", "gmail.comm": "gmail.com", "gmial.com": "gmail.com",
  "gmai.com": "gmail.com", "gamil.com": "gmail.com", "gmal.com": "gmail.com", "gnail.com": "gmail.com",
  "hotmail.con": "hotmail.com", "hotmail.co": "hotmail.com", "hotmial.com": "hotmail.com", "hotmai.com": "hotmail.com", "hotmal.com": "hotmail.com",
  "outlook.con": "outlook.com", "outlok.com": "outlook.com", "yahoo.con": "yahoo.com", "yaho.com": "yahoo.com", "icloud.con": "icloud.com",
};

/** Sugerencia si el dominio parece mal tipeado ("ana@gmail.con" → "ana@gmail.com"), si no null. */
export function sugerenciaTipeo(email: string): string | null {
  const [local, dominio] = email.split("@");
  const bueno = DOMINIOS_TIPEO[(dominio ?? "").toLowerCase()];
  return bueno ? `${local}@${bueno}` : null;
}

const sinTildes = (s: string) => s.normalize("NFD").replace(/\p{M}/gu, "").toLowerCase();

/** ¿El bot ya le preguntó por el correo en esta conversación? */
export function yaPreguntoEmail(textosBot: string[]): boolean {
  return textosBot.some((t) => /\bpor (?:correo|e-?mail|mail)\b|\btu (?:correo|e-?mail|mail)\b/.test(sinTildes(t ?? "")));
}

/** Se pregunta solo si el chat no dejó ya un email y el bot no lo preguntó antes. */
export function debePreguntarEmail(est: { email: string | null; textosBot: string[] } | null): boolean {
  return !!est && !est.email && !yaPreguntoEmail(est.textosBot);
}

const error = (mensaje: string, extra: Record<string, unknown> = {}): ResultadoHerramienta => ({
  resultado: { ok: false, error: mensaje, ...extra },
  esError: true,
});

const msg = (e: unknown) => (e instanceof Error ? e.message : String(e));

// ---------- guardar_email_factura ----------

function defGuardarEmailFactura(): Herramienta {
  return {
    name: "guardar_email_factura",
    description:
      "Guarda el correo del cliente para mandarle la factura por mail (te pasa un mail, pide la factura por correo o le falla el WhatsApp). Va en un pedido YA HECHO (el último del cliente o el que encontraste con buscar_pedido). Si la factura ya salió, se la reenvía al correo en el momento; si no, sale ahí cuando esté. Si pide por correo y no pasó el mail, pedíselo. Respondé con texto_respuesta.",
    input_schema: {
      type: "object",
      properties: {
        email: { type: "string", description: "El correo tal cual lo escribió el cliente, ej. \"ana@gmail.com\"." },
        pedido: { type: "string", description: "Número del pedido (\"#1075\"). Si no lo mandás, el último pedido de este chat." },
        confirmado: { type: "boolean", description: "Solo si te avisé que el correo parecía mal escrito y el cliente confirmó que es ese: true." },
      },
      required: ["email"],
    },
  };
}

async function guardarEmailFactura(input: Record<string, unknown>, ctx: CtxTurno, deps: DepsHerramientas): Promise<ResultadoHerramienta> {
  const ef = deps.emailFactura;
  const p = deps.pedidosWeb;
  if (!ef || !p) return error("no_disponible: anotá el correo en tu respuesta y avisá a Enrique con derivar_a_enrique motivo falla_herramienta.");
  const email = elegirEmail(input.email, ctx.textoEntrada);
  if (!email) {
    return error("email_invalido: ese correo no me da (falta la @ o el dominio con punto, ej. ana@gmail.com). Pedíselo de nuevo UNA vez: \"¿Me pasás de nuevo tu correo? Ese no me da\".");
  }
  const sugerido = sugerenciaTipeo(email);
  if (sugerido && input.confirmado !== true) {
    return error(`email_dudoso: preguntale UNA vez "¿Es ${sugerido}?". Si dice que sí, llamá de nuevo con email "${sugerido}"; si insiste con "${email}", con ese y confirmado=true.`);
  }
  const r = await resolverPedido(input.pedido, ctx, deps, p);
  if (!r.ok) return r.r;
  const pedido = r.pedido;
  const reemplazado = pedido.tags.find((t) => t.toUpperCase().startsWith(TAG_REEMPLAZADO));
  if (reemplazado) {
    const nuevo = reemplazado.slice(TAG_REEMPLAZADO.length);
    return error(`ya_reemplazado: ese pedido fue reemplazado por ${nuevo}. Guardá el correo en ese (pedido="${nuevo}").`);
  }
  if (pedido.cancelado) return error("pedido_cancelado: ese pedido está cancelado; el correo va en el pedido vigente.");

  const id = pedido.shopify_order_id;
  const g = await ef.guardar(id, email, { conversacionId: ctx.conversacionId, clienteId: ctx.clienteId ?? null })
    .catch((e) => ({ ok: false, error: msg(e) }));
  await p.vincular(ctx.conversacionId, id, "factura").catch(() => {});
  const clave = claveAvisoFactura(id, `correo ${email}`).replace(/^factura:/, "factura_correo:");
  const avisar = (texto: string) =>
    deps.avisar(texto, undefined, { tipo: TIPO_AVISO_FACTURA, destino: "enrique", pedido: pedido.nombre, unaVezPorDia: true, clave }).catch(() => ({ ok: false }));

  const f = await ef.facturaAprobada(id).catch(() => null);
  if (f) {
    const env = await ef.enviarFactura({ factura: f, email, pedido: pedido.nombre, nombre: pedido.nombre_cliente })
      .catch((e) => ({ ok: false, simulado: false, error: msg(e) }));
    if (env.ok && !env.simulado) {
      return { resultado: { ok: true, guardado: g.ok, reenviada: true, pedido: pedido.nombre, email, texto_respuesta: textoEmailReenviado(email) } };
    }
    const motivo = env.ok ? "falta la cuenta de correo (RESEND_API_KEY)" : (env.error ?? "falló el envío");
    await avisar(
      `🧾 ${escaparHtml(pedido.nombre)} pide su factura ${escaparHtml(f.numero_completo)} por correo a ${escaparHtml(email)}. No salió sola (${escaparHtml(motivo)}): mandásela a mano.`,
    );
    return { resultado: { ok: true, guardado: g.ok, reenviada: false, aviso_enrique: true, pedido: pedido.nombre, email, texto_respuesta: textoEmailManual(email) } };
  }

  if (!g.ok) {
    await avisar(`🧾 ${escaparHtml(pedido.nombre)}: el cliente quiere la factura por correo a ${escaparHtml(email)}, pero no se pudo guardar (${escaparHtml(g.error ?? "error")}). Anotalo para cuando salga.`);
  }
  return { resultado: { ok: true, guardado: g.ok, reenviada: false, pedido: pedido.nombre, email, texto_respuesta: textoEmailGuardado(email) } };
}

// ---------- guardar_factura con la pregunta del mail ----------

/**
 * Envuelve guardar_factura: con la factura recién guardada (no "ya_estaba"), si el chat no dejó un correo y el bot no
 * lo preguntó antes, la nota le indica al modelo hacer la pregunta del mail UNA vez. Si no se puede leer el estado, no
 * pregunta (mejor no preguntar que preguntar dos veces).
 */
export function conPreguntaEmail(base: Ejecutor): Ejecutor {
  return async (input, ctx, deps, extra) => {
    const r = await base(input, ctx, deps, extra);
    const res = r.resultado;
    if (r.esError || res.ok !== true || res.guardado !== true || res.ya_estaba === true || !deps.emailFactura) return r;
    const est = await deps.emailFactura.estadoConversacion(ctx.conversacionId).catch(() => null);
    if (!debePreguntarEmail(est)) return r;
    const nota = `${typeof res.nota === "string" ? `${res.nota} ` : ""}En el mismo mensaje, UNA sola vez, preguntale: "${PREGUNTA_EMAIL}". Si no quiere o no contesta, no insistas.`;
    return { ...r, resultado: { ...res, nota, preguntar_email: true } };
  };
}

// ---------- exportación para herramientas.ts (declaraciones de función: sin problemas de import circular) ----------

export function herramientasEmailFactura(): Array<{ definicion: Herramienta; ejecutor: Ejecutor }> {
  return [{ definicion: defGuardarEmailFactura(), ejecutor: guardarEmailFactura }];
}

/** guardar_email_factura + guardar_factura envuelto (pisa al de pedidos_web.ts en EJECUTORES). */
export function ejecutoresEmailFactura(): Record<string, Ejecutor> {
  const base = herramientasPedidosWeb().find((h) => h.definicion.name === "guardar_factura")?.ejecutor;
  return {
    guardar_email_factura: guardarEmailFactura,
    ...(base ? { guardar_factura: conPreguntaEmail(base) } : {}),
  };
}

export const guardarEmailFacturaHerr: { definicion: Herramienta; ejecutor: Ejecutor } = { definicion: defGuardarEmailFactura(), ejecutor: guardarEmailFactura };
