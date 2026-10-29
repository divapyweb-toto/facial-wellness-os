// Tests de la cadena de entrega del KuDE (entrega_kude.ts). Datos inventados (repo público).
import { assert, assertEquals, assertFalse, assertStringIncludes } from "@std/assert";
import {
  captionDocumentoKude,
  componentesPlantillaFactura,
  type DatosEntregaKude,
  datosEntregaKude,
  type DepsEntregaKude,
  entregarKude,
  leyendaTelegramKude,
  ventanaVigente,
} from "./entrega_kude.ts";
import type { PedidoSifen } from "./desde_pedido.ts";

const BASE: DatosEntregaKude = {
  pdfUrl: "https://ejemplo.supabase.co/storage/v1/object/sign/facturas/x.pdf?token=t",
  numeroCompleto: "001-001-0000007",
  total: 112000,
  nombre: "Ana",
  telefono: "+595981000000",
  email: "ana@ejemplo.com",
  pedido: "#1001",
};

type Opc = {
  aprobada?: boolean | Error;
  ventana?: boolean | Error;
  plantilla?: { ok: boolean; error?: string } | Error;
  documento?: { ok: boolean; error?: string };
  correo?: { ok: boolean; simulado?: boolean; error?: string };
  telegram?: { ok: boolean; error?: string };
};

function deps(o: Opc = {}) {
  const llamadas: string[] = [];
  let motivo = "";
  const val = <T>(v: T | Error): Promise<T> => (v instanceof Error ? Promise.reject(v) : Promise.resolve(v));
  const d: DepsEntregaKude = {
    plantillaAprobada: (n) => (llamadas.push(`aprobada:${n}`), val(o.aprobada ?? true)),
    ventanaAbierta: (t) => (llamadas.push(`ventana:${t}`), val(o.ventana ?? false)),
    enviarPlantillaFactura: () => (llamadas.push("plantilla"), val(o.plantilla ?? { ok: true })),
    enviarDocumentoWa: () => (llamadas.push("documento"), Promise.resolve(o.documento ?? { ok: true })),
    enviarCorreo: () => (llamadas.push("correo"), Promise.resolve(o.correo ?? { ok: true })),
    avisarTelegramConPdf: (_d, m) => (llamadas.push("telegram"), motivo = m, Promise.resolve(o.telegram ?? { ok: true })),
  };
  return { d, llamadas, motivo: () => motivo };
}

Deno.test("canal 1: plantilla aprobada → plantilla, no prueba nada más", async () => {
  const { d, llamadas } = deps({ aprobada: true });
  const r = await entregarKude(BASE, d);
  assertEquals(r.ok, true);
  assertEquals(r.canal, "plantilla");
  assertEquals(llamadas, ["aprobada:voltra_factura", "plantilla"]);
});

Deno.test("usa el nombre de plantilla que le pasan", async () => {
  const { d, llamadas } = deps({ aprobada: true });
  await entregarKude(BASE, d, "otra_factura");
  assertEquals(llamadas[0], "aprobada:otra_factura");
});

Deno.test("canal 2: plantilla no aprobada + ventana abierta → documento WA", async () => {
  const { d, llamadas } = deps({ aprobada: false, ventana: true });
  const r = await entregarKude(BASE, d);
  assertEquals(r.canal, "whatsapp_documento");
  assert(r.ok);
  assertEquals(llamadas, ["aprobada:voltra_factura", "ventana:+595981000000", "documento"]);
  assertStringIncludes(r.intentos.join("|"), "no aprobada");
});

Deno.test("canal 3: sin plantilla, ventana cerrada, con email → correo", async () => {
  const { d, llamadas } = deps({ aprobada: false, ventana: false });
  const r = await entregarKude(BASE, d);
  assertEquals(r.canal, "correo");
  assert(r.ok);
  assertEquals(llamadas, ["aprobada:voltra_factura", "ventana:+595981000000", "correo"]);
  assertStringIncludes(r.intentos.join("|"), "ventana de 24 h cerrada");
});

Deno.test("canal 4: sin nada → telegram_manual cuenta como entregado", async () => {
  const { d, llamadas, motivo } = deps({ aprobada: false, ventana: false });
  const r = await entregarKude({ ...BASE, email: null }, d);
  assertEquals(r, { ok: true, canal: "telegram_manual", intentos: r.intentos });
  assertEquals(llamadas.at(-1), "telegram");
  assertStringIncludes(motivo(), "correo: sin email");
});

Deno.test("sin teléfono: salta WhatsApp sin consultarlo y va al correo", async () => {
  const { d, llamadas } = deps();
  const r = await entregarKude({ ...BASE, telefono: null }, d);
  assertEquals(r.canal, "correo");
  assertEquals(llamadas, ["correo"]);
});

Deno.test("un canal que falla pasa al siguiente: plantilla falla → documento", async () => {
  const { d, llamadas } = deps({ aprobada: true, plantilla: { ok: false, error: "131026: no entregable" }, ventana: true });
  const r = await entregarKude(BASE, d);
  assertEquals(r.canal, "whatsapp_documento");
  assertEquals(llamadas, ["aprobada:voltra_factura", "plantilla", "ventana:+595981000000", "documento"]);
  assertStringIncludes(r.intentos[0], "131026");
});

Deno.test("fallas encadenadas: plantilla tira excepción, documento falla, correo falla → telegram", async () => {
  const { d, llamadas, motivo } = deps({
    aprobada: true,
    plantilla: new Error("se cayó la red"),
    ventana: true,
    documento: { ok: false, error: "131047" },
    correo: { ok: false, error: "resend 422" },
  });
  const r = await entregarKude(BASE, d);
  assertEquals(r.canal, "telegram_manual");
  assertEquals(llamadas, ["aprobada:voltra_factura", "plantilla", "ventana:+595981000000", "documento", "correo", "telegram"]);
  for (const t of ["se cayó la red", "131047", "resend 422"]) assertStringIncludes(motivo(), t);
});

Deno.test("estado de plantilla y ventana con error no frenan la cadena", async () => {
  const { d } = deps({ aprobada: new Error("faltan WA_TOKEN"), ventana: new Error("db caída") });
  const r = await entregarKude(BASE, d);
  assertEquals(r.canal, "correo");
  assertStringIncludes(r.intentos.join("|"), "estado no disponible");
  assertStringIncludes(r.intentos.join("|"), "ventana no disponible");
});

Deno.test("correo simulado (sin RESEND_API_KEY) NO cuenta: sigue a Telegram", async () => {
  const { d, motivo } = deps({ aprobada: false, ventana: false, correo: { ok: true, simulado: true } });
  const r = await entregarKude(BASE, d);
  assertEquals(r.canal, "telegram_manual");
  assertStringIncludes(motivo(), "correo: simulado");
});

Deno.test("si hasta Telegram falla: ok false, canal null (la cola reintenta)", async () => {
  const { d } = deps({ aprobada: false, ventana: false, correo: { ok: false, error: "x" }, telegram: { ok: false, error: "sin chat" } });
  const r = await entregarKude(BASE, d);
  assertFalse(r.ok);
  assertEquals(r.canal, null);
  assertStringIncludes(r.error ?? "", "sin chat");
});

Deno.test("sin KuDE no intenta nada", async () => {
  const { d, llamadas } = deps();
  const r = await entregarKude({ ...BASE, pdfUrl: "" }, d);
  assertEquals(r, { ok: false, canal: null, intentos: [], error: "sin KuDE" });
  assertEquals(llamadas, []);
});

Deno.test("componentes de la plantilla: header DOCUMENT + {{1}} primer nombre + {{2}} número", () => {
  assertEquals(componentesPlantillaFactura({ ...BASE, nombre: "Ana  María\nPérez" }), [
    { type: "header", parameters: [{ type: "document", document: { link: BASE.pdfUrl, filename: "Factura 001-001-0000007.pdf" } }] },
    { type: "body", parameters: [{ type: "text", text: "Ana" }, { type: "text", text: "001-001-0000007" }] },
  ]);
  const sin = componentesPlantillaFactura({ ...BASE, nombre: null }) as Array<{ parameters: Array<{ text?: string }> }>;
  assertEquals(sin[1].parameters[0].text, "qué tal");
});

Deno.test("caption corto del documento", () => {
  assertEquals(captionDocumentoKude(BASE), "Hola, Ana. Te enviamos tu factura electrónica N.º 001-001-0000007. ¡Gracias por tu compra!");
  assertEquals(captionDocumentoKude({ ...BASE, nombre: null }), "Te enviamos tu factura electrónica N.º 001-001-0000007. ¡Gracias por tu compra!");
});

Deno.test("ventanaVigente: < 24 h (con margen de 10 min) abierta; más vieja o null cerrada", () => {
  const ahora = new Date("2026-10-29T20:00:00Z");
  assert(ventanaVigente("2026-10-29T10:00:00Z", ahora));
  assert(ventanaVigente("2026-10-28T20:11:00Z", ahora));
  assertFalse(ventanaVigente("2026-10-28T20:05:00Z", ahora));
  assertFalse(ventanaVigente(null, ahora));
  assertFalse(ventanaVigente("basura", ahora));
});

Deno.test("datosEntregaKude: email de datos fiscales > raw.email > customer.email; total de la factura", () => {
  const ped = {
    shopify_order_id: 1, nombre: "#1001", total: 99000, estado_envio: "ENTREGADO", tags: [], telefono: "+595981000000",
    raw: { email: "raw@ejemplo.com", customer: { email: "cli@ejemplo.com", first_name: "Cli" }, shipping_address: { first_name: "Ana" } },
    datos_fiscales: { ruc: "80000000", dv: "1", razon_social: "X SA", email: "fiscal@ejemplo.com" },
  } as PedidoSifen;
  const d = datosEntregaKude({ numero_completo: "001-001-0000007", total: 112000 }, ped, BASE.pdfUrl);
  assertEquals(d, { ...BASE, email: "fiscal@ejemplo.com" });
  assertEquals(datosEntregaKude({ numero_completo: "n" }, { ...ped, datos_fiscales: null }, "u").email, "raw@ejemplo.com");
  assertEquals(datosEntregaKude({ numero_completo: "n" }, { ...ped, datos_fiscales: null, raw: { customer: { email: "cli@ejemplo.com" } } }, "u").email, "cli@ejemplo.com");
  assertEquals(datosEntregaKude({ numero_completo: "n" }, { ...ped, datos_fiscales: null, raw: { email: "no-es-email" } }, "u").email, null);
  assertEquals(datosEntregaKude({ numero_completo: "n" }, ped, "u").total, 99000);
  assertEquals(datosEntregaKude({ numero_completo: "n" }, null, "u").telefono, null);
});

Deno.test("leyenda de Telegram escapa HTML y lleva motivo", () => {
  const l = leyendaTelegramKude({ ...BASE, nombre: "<Ana>" }, "correo: sin email");
  assertStringIncludes(l, "&lt;Ana&gt;");
  assertStringIncludes(l, "Motivo: correo: sin email");
  assertStringIncludes(l, "pedido #1001");
});
