// _shared/sifen/entrega_kude.ts · entrega del KuDE al cliente con cadena de respaldo (29-10-2026) · dueño: subagente B.
// Lógica pura: el I/O real está en entrega_kude_io.ts. Orden (contrato §4):
//   1. Plantilla de WhatsApp (voltra_factura) si Meta la tiene APROBADA.
//   2. Documento de WhatsApp como mensaje libre, si la ventana de 24 h está abierta.
//   3. Correo, si hay email (respaldo permanente, no depende del estado de la plantilla).
//   4. Telegram a Enrique con el PDF para que lo mande a mano: cuenta como entregado (canal telegram_manual).
// Si un canal falla, pasa al siguiente. Nunca tira excepción.

import type { PedidoSifen } from "./desde_pedido.ts";

export type CanalKude = "plantilla" | "whatsapp_documento" | "correo" | "telegram_manual";

export interface DatosEntregaKude {
  pdfUrl: string;
  numeroCompleto: string;
  total: number | null;
  nombre: string | null;
  telefono: string | null;
  email: string | null;
  pedido: string | null;
}

export interface DepsEntregaKude {
  plantillaAprobada(nombre: string): Promise<boolean>;
  ventanaAbierta(telefono: string): Promise<boolean>; // último mensaje del cliente hace < 24 h
  enviarPlantillaFactura(d: DatosEntregaKude): Promise<{ ok: boolean; error?: string }>;
  enviarDocumentoWa(d: DatosEntregaKude): Promise<{ ok: boolean; error?: string }>;
  enviarCorreo(d: DatosEntregaKude): Promise<{ ok: boolean; simulado?: boolean; error?: string }>;
  avisarTelegramConPdf(d: DatosEntregaKude, motivo: string): Promise<{ ok: boolean; error?: string }>;
}

export type ResultadoEntregaKude = { ok: boolean; canal: CanalKude | null; intentos: string[]; error?: string };

export const PLANTILLA_FACTURA = "voltra_factura";
/** Margen sobre las 24 h de Meta: un documento que sale justo al cierre de la ventana lo rechaza (131047). */
export const VENTANA_MS = 24 * 3_600_000 - 10 * 60_000;

const msg = (e: unknown) => (e instanceof Error ? e.message : String(e));

async function seguro<T>(f: () => Promise<T>, siFalla: (e: string) => T): Promise<T> {
  try {
    return await f();
  } catch (e) {
    return siFalla(msg(e));
  }
}

export async function entregarKude(d: DatosEntregaKude, deps: DepsEntregaKude, plantilla = PLANTILLA_FACTURA): Promise<ResultadoEntregaKude> {
  const intentos: string[] = [];
  if (!d?.pdfUrl || !d.numeroCompleto) return { ok: false, canal: null, intentos, error: "sin KuDE" };

  if (d.telefono) {
    // 1. Plantilla aprobada.
    const aprobada = await seguro(() => deps.plantillaAprobada(plantilla), (e) => (intentos.push(`plantilla: estado no disponible (${e})`), false));
    if (aprobada) {
      const r = await seguro(() => deps.enviarPlantillaFactura(d), (e) => ({ ok: false, error: e }));
      if (r.ok) return { ok: true, canal: "plantilla", intentos: [...intentos, "plantilla: ok"] };
      intentos.push(`plantilla: ${r.error ?? "falló"}`);
    } else if (!intentos.length) {
      intentos.push(`plantilla: ${plantilla} no aprobada`);
    }
    // 2. Documento libre con la ventana de 24 h abierta.
    const abierta = await seguro(() => deps.ventanaAbierta(d.telefono!), (e) => (intentos.push(`whatsapp_documento: ventana no disponible (${e})`), false));
    if (abierta) {
      const r = await seguro(() => deps.enviarDocumentoWa(d), (e) => ({ ok: false, error: e }));
      if (r.ok) return { ok: true, canal: "whatsapp_documento", intentos: [...intentos, "whatsapp_documento: ok"] };
      intentos.push(`whatsapp_documento: ${r.error ?? "falló"}`);
    } else if (!intentos.some((i) => i.startsWith("whatsapp_documento"))) {
      intentos.push("whatsapp_documento: ventana de 24 h cerrada");
    }
  } else {
    intentos.push("whatsapp: el pedido no tiene teléfono");
  }

  // 3. Correo. Simulado (sin RESEND_API_KEY) NO cuenta como entregado: el cliente no recibió nada.
  if (d.email) {
    const r = await seguro(() => deps.enviarCorreo(d), (e) => ({ ok: false, error: e } as { ok: boolean; simulado?: boolean; error?: string }));
    if (r.ok && !r.simulado) return { ok: true, canal: "correo", intentos: [...intentos, "correo: ok"] };
    intentos.push(r.ok ? "correo: simulado (falta RESEND_API_KEY)" : `correo: ${r.error ?? "falló"}`);
  } else {
    intentos.push("correo: sin email");
  }

  // 4. Enrique por Telegram con el PDF.
  const r = await seguro(() => deps.avisarTelegramConPdf(d, intentos.join(" · ")), (e) => ({ ok: false, error: e }));
  if (r.ok) return { ok: true, canal: "telegram_manual", intentos: [...intentos, "telegram_manual: ok"] };
  intentos.push(`telegram_manual: ${r.error ?? "falló"}`);
  return { ok: false, canal: null, intentos, error: `ningún canal entregó el KuDE (${intentos.join(" · ")})` };
}

// ---------- armado de datos y contenidos (puros) ----------

const str = (x: unknown) => (typeof x === "string" && x.trim() ? x.trim() : null);
const obj = (x: unknown) => (x && typeof x === "object" ? x as Record<string, unknown> : {});

/** Primer nombre del cliente desde el pedido de Shopify (mismo criterio que sifen-cola/io.ts). */
export function nombreDePedido(p: PedidoSifen | null): string | null {
  const r = obj(p?.raw);
  return str(obj(r.shipping_address).first_name) ?? str(obj(r.customer).first_name) ?? str(obj(r.shipping_address).name) ?? null;
}

/** Email: datos fiscales (P2) → raw.email → raw.customer.email. Solo si tiene forma de email. */
export function emailDePedido(p: PedidoSifen | null): string | null {
  const r = obj(p?.raw);
  for (const e of [p?.datos_fiscales?.email, r.email, obj(r.customer).email]) {
    const s = str(e);
    if (s && /^[^\s@<>,;]+@[^\s@<>,;]+\.[a-z]{2,}$/i.test(s)) return s;
  }
  return null;
}

/** Arma los datos de entrega desde la factura y el pedido. `pdfUrl`: URL firmada del KuDE (urlKude). */
export function datosEntregaKude(
  f: { numero_completo: string | null; total?: number | null },
  ped: PedidoSifen | null,
  pdfUrl: string,
): DatosEntregaKude {
  return {
    pdfUrl,
    numeroCompleto: f.numero_completo ?? "",
    total: f.total ?? ped?.total ?? null,
    nombre: nombreDePedido(ped),
    telefono: str(ped?.telefono) ?? null,
    email: emailDePedido(ped),
    pedido: ped?.nombre ?? null,
  };
}

/** Nombre limpio de una línea (sin saltos ni espacios dobles); primer nombre para WhatsApp. */
export function primerNombre(n: string | null): string | null {
  return (n ?? "").replace(/[\n\r\t]+/g, " ").replace(/ {2,}/g, " ").trim().split(" ")[0] || null;
}

export function nombreArchivoKude(numeroCompleto: string): string {
  return `Factura ${numeroCompleto}.pdf`;
}

/** Componentes de la plantilla voltra_factura (header DOCUMENT + {{1}} nombre + {{2}} número). Igual a sifen-cola/io.ts. */
export function componentesPlantillaFactura(d: Pick<DatosEntregaKude, "pdfUrl" | "numeroCompleto" | "nombre">): unknown[] {
  return [
    { type: "header", parameters: [{ type: "document", document: { link: d.pdfUrl, filename: nombreArchivoKude(d.numeroCompleto) } }] },
    { type: "body", parameters: [{ type: "text", text: primerNombre(d.nombre) ?? "qué tal" }, { type: "text", text: d.numeroCompleto }] },
  ];
}

/** Caption corto del documento libre de WhatsApp. */
export function captionDocumentoKude(d: Pick<DatosEntregaKude, "numeroCompleto" | "nombre">): string {
  const n = primerNombre(d.nombre);
  return `${n ? `Hola, ${n}. ` : ""}Te enviamos tu factura electrónica N.º ${d.numeroCompleto}. ¡Gracias por tu compra!`;
}

/** ¿El último mensaje entrante (ISO) está dentro de la ventana de 24 h (con margen)? */
export function ventanaVigente(ultimaEntradaIso: string | null | undefined, ahora: Date): boolean {
  const t = ultimaEntradaIso ? Date.parse(ultimaEntradaIso) : NaN;
  return Number.isFinite(t) && ahora.getTime() - t < VENTANA_MS;
}

const esc = (s: unknown) => String(s ?? "").replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;");

/** Leyenda HTML del aviso a Enrique (va como caption del PDF; Telegram la recorta a 1024). */
export function leyendaTelegramKude(d: DatosEntregaKude, motivo: string): string {
  return [
    `<b>Factura ${esc(d.numeroCompleto)}</b>${d.pedido ? ` · pedido ${esc(d.pedido)}` : ""}`,
    "No hubo canal automático para mandarla al cliente. Reenviala a mano:",
    `Cliente: ${esc(d.nombre ?? "sin nombre")} · ${esc(d.telefono ?? "sin teléfono")}${d.email ? ` · ${esc(d.email)}` : ""}`,
    `Motivo: ${esc(motivo)}`,
  ].join("\n");
}
