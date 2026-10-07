import { assertEquals } from "jsr:@std/assert@1";
import {
  dentroHorarioMarketing,
  partesAsuncion,
  proximaAperturaMarketing,
} from "./horario.ts";

const cfg = { desde: 8, hasta: 21 };
// Asunción en octubre 2026 = UTC-3.
const local = (hhmm: string, dia = "2026-10-06") => new Date(`${dia}T${hhmm}:00-03:00`);

Deno.test("partesAsuncion convierte desde UTC", () => {
  const p = partesAsuncion(new Date("2026-10-06T11:00:00Z"));
  assertEquals([p.hora, p.minuto, p.diaISO], [8, 0, "2026-10-06"]);
  const n = partesAsuncion(new Date("2026-10-07T01:30:00Z"));
  assertEquals([n.hora, n.minuto, n.diaISO], [22, 30, "2026-10-06"]);
});

Deno.test("bordes del horario de marketing", () => {
  assertEquals(dentroHorarioMarketing(local("07:59"), cfg), false);
  assertEquals(dentroHorarioMarketing(local("08:00"), cfg), true);
  assertEquals(dentroHorarioMarketing(local("20:59"), cfg), true);
  assertEquals(dentroHorarioMarketing(local("21:00"), cfg), false);
  assertEquals(dentroHorarioMarketing(local("00:00"), cfg), false);
});

Deno.test("próxima apertura", () => {
  // Dentro: devuelve el mismo instante.
  const dentro = local("12:00");
  assertEquals(proximaAperturaMarketing(dentro, cfg).getTime(), dentro.getTime());
  // Antes de abrir: hoy a las 8:00.
  assertEquals(proximaAperturaMarketing(local("07:59"), cfg).toISOString(), local("08:00").toISOString());
  assertEquals(proximaAperturaMarketing(local("02:15"), cfg).toISOString(), local("08:00").toISOString());
  // Después de cerrar: mañana a las 8:00.
  assertEquals(
    proximaAperturaMarketing(local("21:00"), cfg).toISOString(),
    local("08:00", "2026-10-07").toISOString(),
  );
  assertEquals(
    proximaAperturaMarketing(local("23:59"), cfg).toISOString(),
    local("08:00", "2026-10-07").toISOString(),
  );
  // Fin de mes.
  assertEquals(
    proximaAperturaMarketing(local("22:00", "2026-10-31"), cfg).toISOString(),
    local("08:00", "2026-11-01").toISOString(),
  );
});
