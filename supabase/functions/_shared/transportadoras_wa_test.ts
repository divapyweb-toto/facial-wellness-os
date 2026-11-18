import { assert, assertEquals } from "jsr:@std/assert@1";
import { debeAvisar, leerCfgTransportadoras, pendientesDe, telefonosTransportadoras, transportadoraDe, ventanaAbierta } from "./transportadoras_wa.ts";

const CFG = { activo: true, numeros: [{ telefono: "0981 000 111", nombre: "Ana Prueba", empresa: "Courier Uno" }, { telefono: "basura", nombre: "x" }] };

Deno.test("transportadoras: normaliza teléfonos y descarta los inválidos", () => {
  const c = leerCfgTransportadoras(CFG);
  assertEquals(c.numeros, [{ telefono: "+595981000111", nombre: "Ana Prueba", empresa: "Courier Uno", avisos: true }]);
  assertEquals(c.aviso_telegram_horas, 2);
});

Deno.test("transportadoras: reconoce el número en cualquier formato; apagado o sin fila = nadie", () => {
  assertEquals(transportadoraDe(CFG, "+595981000111")?.nombre, "Ana Prueba");
  assertEquals(transportadoraDe(CFG, "595981000111")?.nombre, "Ana Prueba");
  assertEquals(transportadoraDe(CFG, "+595981000222"), null);
  assertEquals(transportadoraDe({ ...CFG, activo: false }, "+595981000111"), null);
  assertEquals(transportadoraDe(null, "+595981000111"), null);
  assertEquals(transportadoraDe(CFG, null), null);
  assertEquals([...telefonosTransportadoras(CFG)], ["+595981000111"]);
  assertEquals(telefonosTransportadoras({ ...CFG, activo: false }).size, 0);
});

const M = (direccion: "in" | "out", creado_en: string, estado = "enviado") => ({ direccion, creado_en, estado, wa_message_id: creado_en });

Deno.test("transportadoras: pendientes = entrantes después del último saliente que salió y de la marca visto", () => {
  const ms = [M("in", "2026-11-18T10:00:00Z"), M("out", "2026-11-18T11:00:00Z"), M("in", "2026-11-18T12:00:00Z"),
    M("out", "2026-11-18T12:30:00Z", "fallido"), M("in", "2026-11-18T13:00:00Z")];
  assertEquals(pendientesDe(ms).map((m) => m.creado_en), ["2026-11-18T12:00:00Z", "2026-11-18T13:00:00Z"]);
  assertEquals(pendientesDe(ms, "2026-11-18T12:10:00Z").map((m) => m.creado_en), ["2026-11-18T13:00:00Z"]);
  assertEquals(pendientesDe([...ms, M("out", "2026-11-18T14:00:00Z")]).length, 0);
});

Deno.test("transportadoras: Telegram solo pasadas las horas y dentro de la franja", () => {
  const c = leerCfgTransportadoras(CFG);
  const p = [M("in", "2026-11-18T12:00:00Z")];
  assert(!debeAvisar(c, p, new Date("2026-11-18T13:30:00Z"), 10)); // 1,5 h
  assert(debeAvisar(c, p, new Date("2026-11-18T14:00:00Z"), 11)); // 2 h
  assert(!debeAvisar(c, p, new Date("2026-11-18T14:00:00Z"), 23)); // fuera de franja
  assert(!debeAvisar(c, [], new Date("2026-11-18T14:00:00Z"), 11));
  assert(!debeAvisar({ ...c, aviso_telegram_horas: 0 }, p, new Date("2026-11-19T14:00:00Z"), 11));
});

Deno.test("transportadoras: ventana de 24 h por el último entrante", () => {
  const ms = [M("in", "2026-11-17T12:00:00Z"), M("out", "2026-11-18T11:00:00Z")];
  assert(ventanaAbierta(ms, new Date("2026-11-18T11:59:00Z")));
  assert(!ventanaAbierta(ms, new Date("2026-11-18T12:01:00Z")));
  assert(!ventanaAbierta([], new Date()));
});
