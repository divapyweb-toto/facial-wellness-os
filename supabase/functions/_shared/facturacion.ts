// _shared/facturacion.ts · Dueño: I1 (ola 4, factura electrónica al entregarse + mejora 7)
// Adaptador de FacturaSend y armado del mensaje de seguimiento con la factura adjunta.
//
// API verificada en la documentación pública de FacturaSend (06-10-2026):
//   - Crear: POST https://api.facturasend.com.py/<tenantId>/lote/create   (1 a 50 DE del mismo tipo por llamada)
//       Authorization: Bearer api_key_<API_KEY> · cuerpo: ARRAY de documentos.
//       Respuesta {success, result:{deList:[{cdc, numero, estado, ...}], loteId}, error?, errores?}.
//       https://facturasend.com.py/documentacion/crear-un-nuevo-documento-electronico/
//   - KuDE (PDF): POST https://api.facturasend.com.py/<tenantId>/de/pdf  {cdcList:[{cdc}], type:"base64"|binario, format:"a4"|"ticket"}
//       https://facturasend.com.py/documentacion/obtener-kude-del-de/
//   - Estructura y ejemplos: tipoDocumento 1, establecimiento, punto, numero (OBLIGATORIO, lo pone quien emite),
//       fecha "AAAA-MM-DDThh:mm:ss", tipoEmision 1, tipoTransaccion 1, tipoImpuesto 1, moneda PYG,
//       cliente {...}, factura {presencia: 2 = operación electrónica}, condicion {tipo 1 contado, entregas[{tipo, monto, moneda}]},
//       items [{codigo, descripcion, unidadMedida, cantidad, precioUnitario, ivaTipo, ivaProporcion, iva}].
//       Innominado: cliente {contribuyente:false, documentoTipo:5, documentoNumero:0, razonSocial:"SIN NOMBRE"}.
//   - Ambiente de pruebas: misma URL; se elige en la consola de FacturaSend (no hay host aparte).
//
// Secretos (nombres): FACTURASEND_API_KEY (contrato) y FACTURASEND_TENANT (nuevo: el tenantId de la cuenta).
// Modo simulado: MODO_SIMULADO=1 o falta cualquiera de los dos → simulador determinista (`simulado: true`).

import { partesAsuncion } from "./horario.ts";

export const FACTURASEND_BASE = "https://api.facturasend.com.py";

export interface ItemFactura {
  codigo?: string;
  descripcion: string;
  cantidad: number;
  precioUnitario: number; // guaraníes, IVA incluido
  iva?: 0 | 5 | 10;
}

export interface PedidoFactura {
  shopify_order_id: number;
  nombre: string | null; // '#1001'
  numero: number; // número correlativo reservado en `facturas` (tomar_factura)
  fecha: Date;
  items: ItemFactura[];
  total: number;
  pagadoPorQR?: boolean;
  email?: string | null;
}

export interface DatosFiscales {
  ruc?: string | null; // "1234567-9"
  razonSocial?: string | null;
}

export interface ConfigFactura {
  establecimiento: number;
  punto: string; // "001"
  presencia: number; // 2 = operación electrónica
  tipo_impuesto: number; // 1 = IVA
  iva: 0 | 5 | 10;
  unidad_medida: number; // 77 = unidad [VERIFICAR con FacturaSend]
  pago_tipo_cod: number; // 1 = efectivo
  pago_tipo_qr: number; // [VERIFICAR] código SIFEN para transferencia/billetera
  descripcion: string;
  formato_kude: string; // "a4" | "ticket"
  dias_url_pdf: number;
}

export const CONFIG_FACTURA_DEFECTO: ConfigFactura = {
  establecimiento: 1,
  punto: "001",
  presencia: 2,
  tipo_impuesto: 1,
  iva: 10,
  unidad_medida: 77,
  pago_tipo_cod: 1,
  pago_tipo_qr: 7,
  descripcion: "Venta Voltra",
  formato_kude: "a4",
  dias_url_pdf: 7,
};

export interface ResultadoFactura {
  ok: boolean;
  cdc?: string;
  numero_completo?: string;
  estado_sifen?: string;
  pdf_url?: string;
  pdf_path?: string;
  simulado: boolean;
  error?: string;
}

export interface EntornoFactura {
  fetch: typeof fetch;
  env: (n: string) => string | undefined;
  /** Sube el PDF (Storage privado 'facturas') y devuelve una URL firmada que Meta pueda descargar. */
  guardarPdf: (bytes: Uint8Array, ruta: string, diasUrl: number) => Promise<{ url: string; path: string } | { error: string }>;
}

async function guardarPdfEnStorage(bytes: Uint8Array, ruta: string, diasUrl: number) {
  const { db } = await import("./db.ts");
  const sb = db();
  const up = await sb.storage.from("facturas").upload(ruta, bytes, { contentType: "application/pdf", upsert: true });
  if (up.error) return { error: `storage: ${up.error.message}` };
  const s = await sb.storage.from("facturas").createSignedUrl(ruta, diasUrl * 86_400);
  if (s.error || !s.data?.signedUrl) return { error: `url firmada: ${s.error?.message ?? "vacía"}` };
  return { url: s.data.signedUrl, path: ruta };
}

const entornoPorDefecto: EntornoFactura = {
  fetch: (...a) => fetch(...a),
  env: (n) => Deno.env.get(n) ?? undefined,
  guardarPdf: guardarPdfEnStorage,
};
let entorno: EntornoFactura = entornoPorDefecto;

/** Solo para tests. */
export function _configurarFactura(parcial?: Partial<EntornoFactura>): void {
  entorno = parcial ? { ...entornoPorDefecto, ...parcial } : entornoPorDefecto;
}

export function modoSimuladoFactura(): { simulado: boolean; motivo?: string } {
  if (entorno.env("MODO_SIMULADO") === "1") return { simulado: true, motivo: "MODO_SIMULADO=1" };
  if (!entorno.env("FACTURASEND_API_KEY")) return { simulado: true, motivo: "falta FACTURASEND_API_KEY" };
  if (!entorno.env("FACTURASEND_TENANT")) return { simulado: true, motivo: "falta FACTURASEND_TENANT" };
  return { simulado: false };
}

// ─── Lógica pura ─────────────────────────────────────────────

/** Dígito verificador del RUC paraguayo (módulo 11, pesos 2..11 desde la derecha). */
export function digitoVerificadorRuc(base: string): number {
  let total = 0, k = 2;
  for (let i = base.length - 1; i >= 0; i--) {
    total += Number(base[i]) * k;
    k = k === 11 ? 2 : k + 1;
  }
  const resto = total % 11;
  return resto > 1 ? 11 - resto : 0;
}

/** "1.234.567-9" / "1234567 9" → "1234567-9" si el dígito verificador cierra; si no, null. */
export function normalizarRuc(x: string | null | undefined): string | null {
  const m = /^\s*([\d.]{3,12})\s*[-\s]\s*(\d)\s*$/.exec(x ?? "");
  if (!m) return null;
  const base = m[1].replace(/\./g, "");
  if (!/^\d{3,9}$/.test(base)) return null;
  return digitoVerificadorRuc(base) === Number(m[2]) ? `${base}-${m[2]}` : null;
}

export function numeroCompleto(cfg: Pick<ConfigFactura, "establecimiento" | "punto">, numero: number): string {
  return `${String(cfg.establecimiento).padStart(3, "0")}-${cfg.punto.padStart(3, "0")}-${String(numero).padStart(7, "0")}`;
}

/** Fecha local de Asunción sin zona, como la pide FacturaSend. */
export function fechaFacturaSend(d: Date): string {
  const p = partesAsuncion(d);
  const z = (n: number) => String(n).padStart(2, "0");
  return `${p.anio}-${z(p.mes)}-${z(p.dia)}T${z(p.hora)}:${z(p.minuto)}:${z(p.segundo)}`;
}

/** Arma el JSON del DE (factura electrónica, tipoDocumento 1) para lote/create. */
export function armarDocumentoFacturaSend(p: PedidoFactura, datos: DatosFiscales, cfg: ConfigFactura): Record<string, unknown> {
  const ruc = normalizarRuc(datos.ruc);
  const cliente: Record<string, unknown> = ruc
    ? {
      contribuyente: true,
      ruc,
      razonSocial: (datos.razonSocial ?? "").trim(),
      tipoOperacion: 1, // B2B
      // Persona física si la base del RUC es corta (cédula); jurídica si empieza con 80 (empresas). [VERIFICAR con el contador]
      tipoContribuyente: ruc.startsWith("80") ? 2 : 1,
      pais: "PRY",
    }
    : { contribuyente: false, tipoOperacion: 2, documentoTipo: 5, documentoNumero: 0, razonSocial: "SIN NOMBRE", pais: "PRY" };
  if (p.email) cliente.email = p.email;
  return {
    tipoDocumento: 1,
    establecimiento: cfg.establecimiento,
    punto: cfg.punto,
    numero: p.numero,
    descripcion: cfg.descripcion,
    observacion: `Pedido ${p.nombre ?? p.shopify_order_id}`,
    fecha: fechaFacturaSend(p.fecha),
    tipoEmision: 1,
    tipoTransaccion: 1,
    tipoImpuesto: cfg.tipo_impuesto,
    moneda: "PYG",
    cliente,
    factura: { presencia: cfg.presencia },
    condicion: {
      tipo: 1,
      entregas: [{ tipo: p.pagadoPorQR ? cfg.pago_tipo_qr : cfg.pago_tipo_cod, monto: String(Math.round(p.total)), moneda: "PYG" }],
    },
    items: p.items.map((it, i) => {
      const iva = it.iva ?? cfg.iva;
      return {
        codigo: it.codigo ?? `V-${i + 1}`,
        descripcion: it.descripcion,
        unidadMedida: cfg.unidad_medida,
        cantidad: it.cantidad,
        precioUnitario: Math.round(it.precioUnitario),
        ivaTipo: iva === 0 ? 3 : 1,
        ivaProporcion: iva === 0 ? 0 : 100,
        iva,
      };
    }),
  };
}

type Obj = Record<string, unknown>;
const obj = (x: unknown): Obj => (x && typeof x === "object" && !Array.isArray(x) ? x as Obj : {});
const str = (x: unknown): string | null => (typeof x === "string" && x.trim() ? x.trim() : null);
const num = (x: unknown): number | null => {
  const n = typeof x === "number" ? x : typeof x === "string" && x.trim() ? Number(x) : NaN;
  return Number.isFinite(n) ? n : null;
};

/** Atributos del pedido (REST: note_attributes [{name,value}] · GraphQL: customAttributes [{key,value}]). */
export function atributosPedido(raw: unknown): Array<{ k: string; v: string }> {
  const r = obj(raw);
  const a = Array.isArray(r.note_attributes) ? r.note_attributes : Array.isArray(r.customAttributes) ? r.customAttributes : [];
  return a.map((x) => ({ k: String(obj(x).name ?? obj(x).key ?? ""), v: String(obj(x).value ?? "") }));
}

/**
 * Datos fiscales que dejó el cliente en el formulario de Releasit.
 * El campo puede traer "1234567-9 Razón Social" o solo el RUC; "no"/vacío = consumidor final.
 * Devuelve `pedido_ruc` true si el cliente escribió algo que parece un pedido de factura con RUC.
 */
export function datosFiscalesDesdePedido(
  raw: unknown,
  claves: string[],
): { datos: DatosFiscales; pidioRuc: boolean; rucValido: boolean; textoCrudo: string | null } {
  const set = new Set(claves.map((c) => c.toLowerCase()));
  const attrs = atributosPedido(raw).filter((a) => set.has(a.k.toLowerCase()) && a.v.trim());
  const texto = attrs.map((a) => a.v.trim()).join(" ").trim();
  if (!texto || /^(no|ninguna|-|sin factura)$/i.test(texto)) {
    return { datos: {}, pidioRuc: false, rucValido: false, textoCrudo: texto || null };
  }
  const m = /([\d.]{3,12}\s*-\s*\d)/.exec(texto);
  const ruc = m ? normalizarRuc(m[1]) : null;
  const razon = m ? texto.replace(m[1], "").replace(/^[\s,;:-]+|[\s,;:-]+$/g, "") : "";
  return { datos: { ruc, razonSocial: razon || null }, pidioRuc: true, rucValido: !!ruc && !!razon, textoCrudo: texto };
}

/** Ítems a facturar desde el raw del pedido (líneas + envío). Precios con IVA incluido. */
export function itemsDesdePedido(raw: unknown): ItemFactura[] {
  const r = obj(raw);
  const out: ItemFactura[] = [];
  const lineas: unknown[] = Array.isArray(r.line_items)
    ? r.line_items
    : Array.isArray(obj(r.lineItems).nodes)
    ? obj(r.lineItems).nodes as unknown[]
    : [];
  for (const l of lineas) {
    const o = obj(l);
    const desc = str(o.title) ?? str(o.name);
    const cant = num(o.quantity) ?? 1;
    const precio = num(o.price) ?? num(obj(obj(o.originalUnitPriceSet).shopMoney).amount);
    const descuento = num(o.total_discount) ?? 0;
    if (!desc || precio === null) continue;
    out.push({ codigo: str(o.sku) ?? undefined, descripcion: desc, cantidad: cant, precioUnitario: precio - descuento / cant });
  }
  const envios: unknown[] = Array.isArray(r.shipping_lines) ? r.shipping_lines : [];
  for (const s of envios) {
    const precio = num(obj(s).price) ?? 0;
    if (precio > 0) out.push({ codigo: "ENVIO", descripcion: str(obj(s).title) ?? "Envío", cantidad: 1, precioUnitario: precio });
  }
  return out;
}

export function totalItems(items: ItemFactura[]): number {
  return Math.round(items.reduce((s, i) => s + i.cantidad * Math.round(i.precioUnitario), 0));
}

// ─── Mejora 7: factura en el mismo mensaje del seguimiento ───

/**
 * Plantilla de utilidad que reemplaza a voltra_seguimiento_entrega cuando hay factura.
 * NO está en supabase/plantillas/ porque un encabezado DOCUMENT exige un `header_handle` de ejemplo
 * que solo se obtiene subiendo un PDF con la Resumable Upload API de Meta (el script actual no lo hace).
 */
export const PLANTILLA_SEGUIMIENTO_FACTURA = {
  name: "voltra_seguimiento_factura",
  language: "es",
  category: "UTILITY",
  components: [
    { type: "HEADER", format: "DOCUMENT", example: { header_handle: ["<handle de un PDF de ejemplo>"] } },
    {
      type: "BODY",
      text: "Hola {{1}}, ¿cómo te fue con tu pedido de Voltra ({{2}})?\nTe dejamos tu factura adjunta. Contanos si llegó todo bien.",
      example: { body_text: [["Ana", "1 Tiras nasales"]] },
    },
    { type: "BUTTONS", buttons: [{ type: "QUICK_REPLY", text: "Todo bien" }, { type: "QUICK_REPLY", text: "Tuve un problema" }] },
  ],
} as const;

export interface DatosSeguimientoFactura {
  orderId: number;
  nombre: string | null;
  productos: string | null;
  pdfUrl: string;
  numeroCompleto: string;
  plantilla?: string;
}

/** Arma el envío (nombre de plantilla + componentes) para `enviarPlantilla` de _shared/wa.ts. */
export function armarSeguimientoConFactura(d: DatosSeguimientoFactura): { plantilla: string; idioma: string; componentes: unknown[] } {
  const limpio = (v: string | null, def: string) => (v ?? "").replace(/[\n\r\t]+/g, " ").replace(/ {2,}/g, " ").trim() || def;
  return {
    plantilla: d.plantilla ?? PLANTILLA_SEGUIMIENTO_FACTURA.name,
    idioma: "es",
    componentes: [
      { type: "header", parameters: [{ type: "document", document: { link: d.pdfUrl, filename: `Factura ${d.numeroCompleto}.pdf` } }] },
      { type: "body", parameters: [{ type: "text", text: limpio(d.nombre, "qué tal") }, { type: "text", text: limpio(d.productos, "tu pedido") }] },
      { type: "button", sub_type: "quick_reply", index: "0", parameters: [{ type: "payload", payload: `seg_bien:${d.orderId}` }] },
      { type: "button", sub_type: "quick_reply", index: "1", parameters: [{ type: "payload", payload: `seg_problema:${d.orderId}` }] },
    ],
  };
}

// ─── I/O: FacturaSend ────────────────────────────────────────

function base64ABytes(b64: string): Uint8Array {
  const bin = atob(b64.replace(/^data:[^,]*,/, "").replace(/\s+/g, ""));
  const out = new Uint8Array(bin.length);
  for (let i = 0; i < bin.length; i++) out[i] = bin.charCodeAt(i);
  return out;
}

const PDF_SIMULADO = new TextEncoder().encode(
  "%PDF-1.4\n1 0 obj<</Type/Catalog>>endobj\n% FACTURA SIMULADA - SIN VALOR FISCAL\n%%EOF\n",
);

/** CDC simulado: 44 dígitos, empieza con 99 para que nunca se confunda con uno real. */
export function cdcSimulado(orderId: number, numero: number): string {
  return ("99" + String(numero).padStart(7, "0") + String(orderId)).padEnd(44, "0").slice(0, 44);
}

/** Descarga el KuDE (PDF) de un CDC ya emitido y lo guarda en Storage. */
export async function descargarKude(
  cdc: string,
  ruta: string,
  cfg: Pick<ConfigFactura, "formato_kude" | "dias_url_pdf">,
): Promise<{ ok: boolean; pdf_url?: string; pdf_path?: string; simulado: boolean; error?: string }> {
  const sim = modoSimuladoFactura();
  let bytes: Uint8Array;
  if (sim.simulado) {
    bytes = PDF_SIMULADO;
  } else {
    try {
      const r = await entorno.fetch(`${FACTURASEND_BASE}/${entorno.env("FACTURASEND_TENANT")}/de/pdf`, {
        method: "POST",
        headers: { "Authorization": `Bearer api_key_${entorno.env("FACTURASEND_API_KEY")}`, "Content-Type": "application/json; charset=utf-8" },
        body: JSON.stringify({ cdcList: [{ cdc }], type: "base64", format: cfg.formato_kude }),
      });
      if (!r.ok) return { ok: false, simulado: false, error: `kude HTTP ${r.status}` };
      const tipo = r.headers.get("content-type") ?? "";
      if (tipo.includes("application/pdf")) bytes = new Uint8Array(await r.arrayBuffer());
      else if (tipo.includes("json")) {
        // [VERIFICAR] la documentación no muestra el nombre del campo con type:"base64".
        const j = obj(await r.json());
        const b64 = str(j.value) ?? str(j.pdf) ?? str(j.base64) ?? str(j.result) ?? str(obj(j.result).pdf);
        if (j.success === false || !b64) return { ok: false, simulado: false, error: `kude: ${str(j.error) ?? "sin base64"}` };
        bytes = base64ABytes(b64);
      } else bytes = base64ABytes((await r.text()).replace(/^"|"$/g, ""));
    } catch (e) {
      return { ok: false, simulado: false, error: `kude red: ${e instanceof Error ? e.message : e}` };
    }
    if (new TextDecoder().decode(bytes.slice(0, 4)) !== "%PDF") return { ok: false, simulado: false, error: "kude: no es un PDF" };
  }
  const g = await entorno.guardarPdf(bytes, ruta, cfg.dias_url_pdf);
  if ("error" in g) return { ok: false, simulado: sim.simulado, error: g.error };
  return { ok: true, pdf_url: g.url, pdf_path: g.path, simulado: sim.simulado };
}

/**
 * Emite la factura en FacturaSend (o en el simulador) y deja el PDF en Storage.
 * Si la factura se crea pero el PDF falla, devuelve ok:true con cdc y `error` del PDF (se reintenta aparte).
 */
export async function emitirFactura(
  pedido: PedidoFactura,
  datosFiscales: DatosFiscales,
  cfg: ConfigFactura = CONFIG_FACTURA_DEFECTO,
): Promise<ResultadoFactura> {
  const numComp = numeroCompleto(cfg, pedido.numero);
  if (!pedido.items.length) return { ok: false, simulado: false, error: "sin_items" };
  const doc = armarDocumentoFacturaSend(pedido, datosFiscales, cfg);
  const sim = modoSimuladoFactura();
  let cdc: string;
  let estado: string;
  if (sim.simulado) {
    console.log(`facturacion: simulador (${sim.motivo}) para pedido ${pedido.shopify_order_id}`);
    cdc = cdcSimulado(pedido.shopify_order_id, pedido.numero);
    estado = "simulado";
  } else {
    try {
      const r = await entorno.fetch(`${FACTURASEND_BASE}/${entorno.env("FACTURASEND_TENANT")}/lote/create`, {
        method: "POST",
        headers: { "Authorization": `Bearer api_key_${entorno.env("FACTURASEND_API_KEY")}`, "Content-Type": "application/json; charset=utf-8" },
        body: JSON.stringify([doc]),
      });
      const j = obj(await r.json().catch(() => ({})));
      const de = obj((obj(j.result).deList as unknown[] | undefined)?.[0]);
      if (!r.ok || j.success !== true || !str(de.cdc)) {
        const errs = Array.isArray(j.errores) ? j.errores.map((e) => typeof e === "string" ? e : JSON.stringify(e)).join("; ") : "";
        return { ok: false, simulado: false, error: `facturasend HTTP ${r.status}: ${str(j.error) ?? ""} ${errs}`.trim() };
      }
      cdc = str(de.cdc)!;
      estado = str(de.estado) ?? "";
    } catch (e) {
      return { ok: false, simulado: false, error: `facturasend red: ${e instanceof Error ? e.message : e}` };
    }
  }
  const pdf = await descargarKude(cdc, `${pedido.shopify_order_id}/${numComp}.pdf`, cfg);
  return {
    ok: true,
    cdc,
    numero_completo: numComp,
    estado_sifen: estado,
    pdf_url: pdf.pdf_url,
    pdf_path: pdf.pdf_path,
    simulado: sim.simulado,
    ...(pdf.ok ? {} : { error: `pdf: ${pdf.error}` }),
  };
}
