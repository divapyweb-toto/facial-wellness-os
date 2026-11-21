// 21-11 · Pruebas de io.ts con una base falsa (sin red, sin escribir en la base real). Datos DEMO.
import { assert, assertEquals, assertRejects } from "@std/assert";
import {
  _configurarIo,
  actualizarMensaje,
  avisarAdministracion,
  candidatoDeHilo,
  cargarCotizacion,
  configProveedores,
  gastoMesUsd,
  guardarMensaje,
  historialDe,
  inicioMesPY,
  permisoGeneralId,
  proveedorPorEmail,
  proveedorPorWhatsapp,
  ultimoCandidatoDe,
} from "./io.ts";
import type { Cotizacion } from "./agente.ts";

type Op = [string, ...unknown[]];
type Res = { data: unknown; error: { message: string; code?: string } | null };

/** Base falsa: cada consulta guarda sus pasos y le pide el resultado a `responder`. */
function baseFalsa(responder: (tabla: string, ops: Op[]) => Res) {
  const consultas: Array<{ tabla: string; ops: Op[] }> = [];
  const cliente = {
    from(tabla: string) {
      const ops: Op[] = [];
      consultas.push({ tabla, ops });
      const fin = () => Promise.resolve(responder(tabla, ops));
      const q: Record<string, unknown> = {};
      for (const m of ["select", "eq", "is", "in", "gte", "lt", "not", "order", "limit", "range", "insert", "update"]) {
        q[m] = (...a: unknown[]) => {
          ops.push([m, ...a]);
          return q;
        };
      }
      q.maybeSingle = () => (ops.push(["maybeSingle"]), fin());
      q.single = () => (ops.push(["single"]), fin());
      q.then = (ok: (r: Res) => unknown, mal: (e: unknown) => unknown) => fin().then(ok, mal);
      return q;
    },
  };
  _configurarIo({ cliente: () => cliente as never });
  return consultas;
}

const tiene = (ops: Op[], ...op: unknown[]) => ops.some((o) => JSON.stringify(o) === JSON.stringify(op));

Deno.test("configProveedores: lee config.proveedores; si la base falla → apagado", async () => {
  const c = baseFalsa(() => ({ data: { valor: '{"activo": true, "tope_ia_usd_mes": 10}' }, error: null }));
  assertEquals((await configProveedores()).activo, true);
  assert(tiene(c[0].ops, "eq", "clave", "proveedores"));
  baseFalsa(() => ({ data: null, error: { message: "caída" } }));
  assertEquals((await configProveedores()).activo, false);
  _configurarIo();
});

Deno.test("inicioMesPY: mes de Paraguay (UTC−3)", () => {
  assertEquals(inicioMesPY(new Date("2026-11-21T15:00:00Z")), "2026-11-01T03:00:00.000Z");
  assertEquals(inicioMesPY(new Date("2026-12-01T02:00:00Z")), "2026-11-01T03:00:00.000Z"); // 23:00 del 30-11 en PY
  assertEquals(inicioMesPY(new Date("2026-12-01T03:00:00Z")), "2026-12-01T03:00:00.000Z");
});

Deno.test("gastoMesUsd: suma costo_usd del mes PY; si falla la base, error", async () => {
  const c = baseFalsa(() => ({ data: [{ costo_usd: "0.5" }, { costo_usd: 1.25 }, { costo_usd: null }], error: null }));
  assertEquals(await gastoMesUsd(new Date("2026-11-21T15:00:00Z")), 1.75);
  assert(tiene(c[0].ops, "gte", "creado_en", "2026-11-01T03:00:00.000Z"));
  baseFalsa(() => ({ data: null, error: { message: "caída" } }));
  await assertRejects(() => gastoMesUsd());
  _configurarIo();
});

Deno.test("proveedorPorEmail / proveedorPorWhatsapp: normalizan y excluyen no_contactar", async () => {
  const fila = { id: "p1", razon_social_declarada: "Proveedor Demo", idioma: "en", plataforma: "alibaba", email: "ventas@demo.test", whatsapp: "8613800000000", canal_preferido: "email", no_contactar: false };
  const c = baseFalsa(() => ({ data: [fila], error: null }));
  const p = await proveedorPorEmail("  Ventas@Demo.TEST ");
  assertEquals(p, { id: "p1", nombre: "Proveedor Demo", idioma: "en", plataforma: "alibaba", email: "ventas@demo.test", whatsapp: "8613800000000", canal_preferido: "email", no_contactar: false });
  assert(tiene(c[0].ops, "eq", "email", "ventas@demo.test"));
  assert(tiene(c[0].ops, "eq", "no_contactar", false));
  await proveedorPorWhatsapp("+86 138-0000-0000");
  assert(tiene(c[1].ops, "eq", "whatsapp", "8613800000000"));
  assertEquals(await proveedorPorEmail("no-es-correo"), null);
  assertEquals(await proveedorPorWhatsapp("12"), null);
  assertEquals(c.length, 2); // las inválidas no consultan
  baseFalsa(() => ({ data: [], error: null }));
  assertEquals(await proveedorPorEmail("otro@demo.test"), null);
  _configurarIo();
});

Deno.test("historialDe: viejo → nuevo, solo lo recibido o enviado, sin el mensaje actual", async () => {
  const c = baseFalsa(() => ({
    data: [
      { id: "m3", direccion: "in", original: "third", traduccion: "tercero", creado_en: "2026-11-21T03:00:00Z", estado: "RECEIVED" },
      { id: "m2", direccion: "out", original: "second", traduccion: "segundo", creado_en: "2026-11-20T03:00:00Z", estado: "SENT_CONFIRMED" },
      { id: "m1", direccion: "in", original: "first", traduccion: null, creado_en: "2026-11-19T03:00:00Z", estado: "RECEIVED" },
    ],
    error: null,
  }));
  const h = await historialDe("p1", 20, { excluirId: "m3" });
  assertEquals(h, [
    { direccion: "in", texto: "first", traduccion: null, creado_en: "2026-11-19T03:00:00Z" },
    { direccion: "out", texto: "second", traduccion: "segundo", creado_en: "2026-11-20T03:00:00Z" },
  ]);
  assert(tiene(c[0].ops, "eq", "proveedor_id", "p1"));
  assert(tiene(c[0].ops, "in", "estado", ["RECEIVED", "SENT_CONFIRMED"]));
  _configurarIo();
});

Deno.test("guardarMensaje: devuelve id; idempotencia repetida → null; otro error → excepción", async () => {
  const fila = { canal: "email" as const, direccion: "in" as const, estado: "RECEIVED", autor: "proveedor" as const, politica_id: null, proveedor_id: "p1", idempotencia: "email:in:demo1", id_externo: "demo1", original: "hi" };
  let c = baseFalsa(() => ({ data: { id: "m9" }, error: null }));
  assertEquals(await guardarMensaje(fila), "m9");
  assert(tiene(c[0].ops, "insert", fila));
  c = baseFalsa(() => ({ data: null, error: { message: "duplicate key", code: "23505" } }));
  assertEquals(await guardarMensaje(fila), null);
  baseFalsa(() => ({ data: null, error: { message: "check violation", code: "23514" } }));
  await assertRejects(() => guardarMensaje(fila));
  assertEquals(c.length, 1);
  _configurarIo();
});

Deno.test("actualizarMensaje y permisoGeneralId", async () => {
  const c = baseFalsa((tabla) => ({ data: tabla === "pi_politicas" ? [{ id: "pol-gen" }] : null, error: null }));
  await actualizarMensaje("m9", { estado: "SENT_CONFIRMED", id_externo: "x1" });
  assert(tiene(c[0].ops, "update", { estado: "SENT_CONFIRMED", id_externo: "x1" }));
  assert(tiene(c[0].ops, "eq", "id", "m9"));
  assertEquals(await permisoGeneralId(), "pol-gen");
  assert(tiene(c[1].ops, "is", "candidato_id", null));
  baseFalsa(() => ({ data: null, error: { message: "caída" } }));
  await assertRejects(() => actualizarMensaje("m9", { estado: "FAILED" }));
  _configurarIo();
});

Deno.test("candidatoDeHilo / ultimoCandidatoDe: producto del último mensaje con candidato, con su ficha", async () => {
  const c = baseFalsa((tabla) => {
    if (tabla === "pi_mensajes") return { data: [{ candidato_id: "cand1" }], error: null };
    if (tabla === "pi_candidatos") return { data: { id: "cand1", nombre: "Producto demo" }, error: null };
    return { data: [{ spec: { color: "negro" } }], error: null };
  });
  assertEquals(await candidatoDeHilo("hilo-demo"), { id: "cand1", nombre: "Producto demo", ficha: { color: "negro" } });
  assert(tiene(c[0].ops, "eq", "hilo", "hilo-demo"));
  await ultimoCandidatoDe("p1");
  assert(tiene(c[3].ops, "eq", "proveedor_id", "p1"));
  baseFalsa(() => ({ data: [], error: null }));
  assertEquals(await candidatoDeHilo("nada"), null);
  _configurarIo();
});

const COT: Cotizacion = {
  moneda: "USD",
  escalones: [{ cantidad: 500, precio_unit_minor: 120 }],
  moq: 500,
  peso_bruto_g: 120,
  medidas_caja_cm: "40x30x20",
  unidades_por_caja: 100,
  plazo_dias: 7,
  costo_muestra_minor: null,
  incoterm: "FOB",
  completa: true,
};

Deno.test("cargarCotizacion: firme si completa, escaparate si no; deja el mensaje de origen en una evidencia", async () => {
  const c = baseFalsa((tabla) => ({ data: { id: tabla === "pi_evidencias" ? "ev1" : "cot1" }, error: null }));
  const id = await cargarCotizacion(COT, { candidatoId: "cand1", proveedorId: "p1", mensajeId: "m9", canal: "email" });
  assertEquals(id, "cot1");
  const ev = c[0].ops.find((o) => o[0] === "insert")![1] as Record<string, unknown>;
  assertEquals([c[0].tabla, ev.tipo, ev.candidato_id, ev.captura_ref, ev.cargado_por], ["pi_evidencias", "supplier_claim", "cand1", "pi_mensajes:m9", "agente"]);
  const fila = c[1].ops.find((o) => o[0] === "insert")![1] as Record<string, unknown>;
  assertEquals([fila.tipo, fila.moneda, fila.candidato_id, fila.proveedor_id, fila.evidencia_id, fila.peso_bruto_g], ["firme", "USD", "cand1", "p1", "ev1", 120]);
  await cargarCotizacion({ ...COT, completa: false, moneda: "EUR" }, { candidatoId: "cand1", proveedorId: "p1", mensajeId: null, canal: "whatsapp" });
  const fila2 = c[2].ops.find((o) => o[0] === "insert")![1] as Record<string, unknown>;
  assertEquals([c[2].tabla, fila2.tipo, fila2.moneda], ["pi_cotizaciones", "escaparate", null]);
  // Sin producto no se carga (la tabla lo exige).
  assertEquals(await cargarCotizacion(COT, { candidatoId: null, proveedorId: "p1", mensajeId: "m9", canal: "email" }), null);
  assertEquals(c.length, 3);
  _configurarIo();
});

Deno.test("avisarAdministracion: una vez por día por clave, con el destino de cada tipo", async () => {
  const llamadas: unknown[][] = [];
  _configurarIo({ avisar: (...a: unknown[]) => (llamadas.push(a), Promise.resolve({ ok: true })) });
  await avisarAdministracion("Proveedor pide pago", { tipo: "proveedor_frena", clave: "email:hilo1" });
  await avisarAdministracion("Cotización completa", { tipo: "proveedor_cotizacion", clave: "cot1" });
  await avisarAdministracion("Tope", { tipo: "proveedor_tope_ia", clave: "2026-11" });
  assertEquals(llamadas.map((a) => a[2]), [
    { tipo: "proveedor_frena", destino: "enrique", clave: "email:hilo1", unaVezPorDia: true },
    { tipo: "proveedor_cotizacion", destino: "admin", clave: "cot1", unaVezPorDia: true },
    { tipo: "proveedor_tope_ia", destino: "enrique", clave: "2026-11", unaVezPorDia: true },
  ]);
  _configurarIo();
});

Deno.test("los 3 tipos de aviso de proveedores están registrados", async () => {
  const { TIPOS_AVISO } = await import("../telegram_tipos.ts");
  for (const t of ["proveedor_frena", "proveedor_cotizacion", "proveedor_tope_ia"]) assert(TIPOS_AVISO[t], t);
});
