import { assertEquals } from "@std/assert";
import { CASOS_BATERIA, COMUN_BATERIA } from "./bateria_embebida.ts";
import { cargarBateria } from "./probar.ts";

// Si falla: cambiaron los .json de supabase/vendedor/pruebas/ → `node scripts/generar-bateria-embebida.mjs`.
Deno.test("bateria_embebida.ts está sincronizado con supabase/vendedor/pruebas/", async () => {
  const { casos, comun } = await cargarBateria();
  assertEquals(CASOS_BATERIA.length, casos.length);
  assertEquals(CASOS_BATERIA, casos);
  assertEquals(COMUN_BATERIA, comun);
});
