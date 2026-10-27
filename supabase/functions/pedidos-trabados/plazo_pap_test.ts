import { assert, assertEquals, assertStringIncludes } from "@std/assert";
import type { DepsActuar } from "./entregas_actuar.ts";
import { claveCandadoPlazoPap, diasHabilesDesde, estadoPlazoPap, type FilaPlazoPap, procesarPlazoPap, textoPlazoPap } from "./plazo_pap.ts";

// Lunes 26-10-2026, 10:00 en Paraguay.
const AHORA = new Date("2026-10-26T13:00:00Z");
const F = (o: Partial<FilaPlazoPap> = {}): FilaPlazoPap =>
  ({ ref: "VT-9100", ciudad: "Luque", estado: "En Oficina", fechaVenta: "2026-10-16", guia: null, ...o });

function deps(telegramFalla = 0) {
  const candados = new Set<string>(), telegram: string[] = [];
  let fallas = telegramFalla;
  const d: DepsActuar = {
    tomarCandado: (id) => Promise.resolve(candados.has(id) ? false : (candados.add(id), true)),
    soltarCandado: (id) => Promise.resolve(void candados.delete(id)),
    existeCandado: (id) => Promise.resolve(candados.has(id)),
    avisar: (t) => Promise.resolve(fallas > 0 ? (fallas--, { ok: false, error: "caído" }) : (telegram.push(t), { ok: true })),
    esperar: () => Promise.resolve(),
  };
  return { d, candados, telegram };
}

Deno.test("días hábiles: salta sábado y domingo, en hora de Paraguay", () => {
  assertEquals(new Date("2026-10-16T12:00:00Z").getUTCDay(), 5); // 16-10-2026 es viernes (calculado)
  assertEquals(diasHabilesDesde("2026-10-16", AHORA), 6); // 19..23 + 26
  assertEquals(diasHabilesDesde("2026-10-17", AHORA), 6); // venta sábado: igual que viernes
  assertEquals(diasHabilesDesde("2026-10-19", AHORA), 5);
  assertEquals(diasHabilesDesde("2026-10-23", new Date("2026-10-25T15:00:00Z")), 0); // viernes → domingo: 0
  assertEquals(diasHabilesDesde("2026-10-26", AHORA), 0);
  assertEquals(diasHabilesDesde("2026-10-16", new Date("2026-10-26T02:00:00Z")), 5); // 23:00 del domingo 25 en Paraguay
  assertEquals(diasHabilesDesde(null, AHORA), null);
  assertEquals(diasHabilesDesde("basura", AHORA), null);
});

Deno.test("estados: En Oficina, Asignado a ruta y Borrador sin importar mayúsculas ni tildes", () => {
  for (const e of ["En Oficina", "EN OFICINA", " en  oficina ", "Asignado a ruta", "ASIGNADO A RUTA", "Borrador", "Bórrador", "En Oficína"]) {
    assert(estadoPlazoPap(e), e);
  }
  for (const e of ["Entregado", "Custodio", "No Gestionado", "", null, "Asignado a ruta 2"]) assert(!estadoPlazoPap(e), String(e));
});

Deno.test("umbral: 5 días hábiles no avisa, 6 sí; estado ajeno no avisa", async () => {
  const { d, telegram } = deps();
  const h = await procesarPlazoPap([
    F({ ref: "VT-9101", fechaVenta: "2026-10-19" }), // 5
    F({ ref: "VT-9102", fechaVenta: "2026-10-16" }), // 6
    F({ ref: "VT-9103", fechaVenta: "2026-10-01", estado: "Entregado" }),
  ], AHORA, d);
  assertEquals(h, [{ ref: "VT-9102", estado: "En Oficina", dias: 6, resultado: "avisado" }]);
  assertEquals(telegram.length, 1);
});

Deno.test("texto: ref, ciudad, estado, fecha de venta y días; sin nombre ni teléfono", () => {
  const t = textoPlazoPap(F({ ref: "VT-1234", ciudad: "Ciudad del Este", estado: "Asignado a ruta", guia: "G-77" }), 6);
  assertEquals(t,
    '⏳ <b>VT-1234</b> · PaP: 6 días hábiles en "Asignado a ruta". Reenviale esto a PaP:\n\n' +
      'Hola, consulto por el pedido VT-1234 (guía G-77), destino Ciudad del Este. Figura "Asignado a ruta" y la venta es del 16/10/2026 ' +
      "(6 días hábiles). ¿Me confirman cuándo sale a reparto? Gracias.");
  assert(!/\d{6,}/.test(t.replace("VT-1234", "")), "sin números largos (teléfono)");
  assertStringIncludes(textoPlazoPap(F({ ciudad: null }), 6), "ciudad sin cargar");
  // la fila no tiene campos de cliente: el tipo no los admite
  assertEquals(Object.keys(F()).sort(), ["ciudad", "estado", "fechaVenta", "guia", "ref"]);
});

Deno.test("candado: una sola vez por pedido aunque cambie de estado; si Telegram falla se reintenta", async () => {
  const { d, candados, telegram } = deps();
  await procesarPlazoPap([F()], AHORA, d);
  const h2 = await procesarPlazoPap([F({ estado: "Asignado a ruta" })], new Date("2026-10-27T13:00:00Z"), d);
  assertEquals(h2[0].resultado, "ya_avisado");
  assertEquals(telegram.length, 1);
  assert(candados.has(claveCandadoPlazoPap("VT-9100")));
  assertEquals((await procesarPlazoPap([F({ ref: "VT-9200" })], AHORA, d, true))[0].resultado, "simulado");
  assert(!candados.has(claveCandadoPlazoPap("VT-9200")), "simular no toma candado");

  const f = deps(3);
  assertEquals((await procesarPlazoPap([F()], AHORA, f.d))[0].resultado, "error: Telegram: caído");
  assertEquals(f.candados.size, 0); // soltado: el cron reintenta
  assertEquals((await procesarPlazoPap([F()], AHORA, f.d))[0].resultado, "avisado");
});

Deno.test("26-10: Borrador avisa con más de 2 días hábiles; los otros estados siguen en 5", async () => {
  assertEquals(diasHabilesDesde("2026-10-22", AHORA), 2); // jueves → 23 + 26
  assertEquals(diasHabilesDesde("2026-10-21", AHORA), 3);
  const { d, telegram } = deps();
  const h = await procesarPlazoPap([
    F({ ref: "VT-9201", estado: "Borrador", fechaVenta: "2026-10-22" }), // 2 → no
    F({ ref: "VT-9202", estado: " Bórrador ", fechaVenta: "2026-10-21" }), // 3 → sí
    F({ ref: "VT-9203", estado: "Asignado a ruta", fechaVenta: "2026-10-21" }), // 3 → no (umbral 5)
  ], AHORA, d);
  assertEquals(h.map((x) => [x.ref, x.dias]), [["VT-9202", 3]]);
  assertEquals(telegram.length, 1);
});

Deno.test("27-10: plazo PaP → tipo plazo_pap, destino enrique (va al resumen por la política), con el pedido", async () => {
  const opts: unknown[] = [];
  const { d } = deps();
  d.avisar = (_t, _b, o) => (opts.push(o), Promise.resolve({ ok: true }));
  await procesarPlazoPap([F()], AHORA, d);
  assertEquals(opts, [{ tipo: "plazo_pap", destino: "enrique", pedido: "#9100" }]);
});
