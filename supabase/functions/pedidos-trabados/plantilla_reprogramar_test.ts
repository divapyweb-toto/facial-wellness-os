import { assertEquals, assertStringIncludes } from "@std/assert";
import { activarPlantillaReprogramar, type DepsActivar, yaActiva } from "./plantilla_reprogramar.ts";

function deps(estado: string | null, cfg: unknown = null) {
  const guardado: Array<Record<string, unknown>> = [], telegram: string[] = [], candados = new Set<string>();
  const d: DepsActivar = {
    leerConfig: () => Promise.resolve(cfg),
    estado: () => Promise.resolve({ estado }),
    guardarConfig: (v) => { guardado.push(v); cfg = JSON.stringify(v); return Promise.resolve(); },
    candado: (id) => { if (candados.has(id)) return Promise.resolve(false); candados.add(id); return Promise.resolve(true); },
    telegram: (t) => { telegram.push(t); return Promise.resolve(true); },
    ahora: () => new Date("2026-10-23T12:00:00Z"),
  };
  return { d, guardado, telegram, leer: () => cfg };
}

Deno.test("22-10: pendiente → no activa; aprobada → activa y avisa UNA vez; rechazada → avisa una vez y no activa", async () => {
  const p = deps("PENDING");
  assertEquals((await activarPlantillaReprogramar(p.d)).resultado, "pendiente (PENDING)");
  assertEquals([p.guardado.length, p.telegram.length], [0, 0]);

  const a = deps("APPROVED");
  assertEquals((await activarPlantillaReprogramar(a.d, true)).resultado, "se_activaría"); // simular no toca nada
  assertEquals(a.guardado.length, 0);
  assertEquals((await activarPlantillaReprogramar(a.d)).resultado, "activada");
  assertEquals(yaActiva(a.leer()), true);
  assertStringIncludes(a.telegram[0], "ACTIVA");
  assertStringIncludes(a.telegram[0], "UN solo mensaje");
  // segunda corrida: ya activa, ni config ni Telegram de nuevo
  assertEquals((await activarPlantillaReprogramar(a.d)).resultado, "ya_activa");
  assertEquals([a.guardado.length, a.telegram.length], [1, 1]);

  const r = deps("REJECTED");
  assertEquals((await activarPlantillaReprogramar(r.d)).resultado, "rechazada");
  await activarPlantillaReprogramar(r.d);
  assertEquals([r.guardado.length, r.telegram.length], [0, 1]);
});

Deno.test("22-10: config inválida o sin fila = apagada; sin respuesta de Meta no hace nada", async () => {
  assertEquals(yaActiva("{roto"), false);
  assertEquals(yaActiva(null), false);
  assertEquals(yaActiva({ plantilla_aprobada: false }), false);
  const e = deps(null);
  e.d.estado = () => Promise.resolve({ estado: null, error: "timeout" });
  assertEquals((await activarPlantillaReprogramar(e.d)).resultado, "sin_dato: timeout");
});
