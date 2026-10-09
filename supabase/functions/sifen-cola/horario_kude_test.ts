import { assertEquals } from "jsr:@std/assert@1";
import { horarioAvisos, puedeMandarKude } from "./horario_kude.ts";

Deno.test("horario de avisos: valor por defecto 8 a 20 si falta o está mal", () => {
  assertEquals(horarioAvisos(undefined), { desde: 8, hasta: 20 });
  assertEquals(horarioAvisos({ desde: "8" }), { desde: 8, hasta: 20 });
  assertEquals(horarioAvisos({ desde: 9, hasta: 19 }), { desde: 9, hasta: 19 });
});

Deno.test("KuDE: de día sale, de noche espera (hora de Asunción, UTC-3)", () => {
  const h = { desde: 8, hasta: 20 };
  assertEquals(puedeMandarKude(new Date("2026-10-09T15:00:00Z"), h), true); // 12:00 local
  assertEquals(puedeMandarKude(new Date("2026-10-09T05:00:00Z"), h), false); // 02:00 local
  assertEquals(puedeMandarKude(new Date("2026-10-09T23:30:00Z"), h), false); // 20:30 local
});
