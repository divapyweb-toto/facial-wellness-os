import { assert, assertEquals } from "@std/assert";
import { armarConfigTurno } from "./config.ts";
import { armarPrompt, PLANTILLA_PROMPT } from "./prompt.ts";
import { armarPlantillaVersion, crearCacheVersion, type FilaVersion, normalizarFilaVersion, plantillaDeVersion, TTL_ERROR_MS } from "./version_activa.ts";
import { armarPromptVersion } from "../../mejora-mensual/proponer.ts";

const FILA: FilaVersion = {
  numero: 2,
  prompt: PLANTILLA_PROMPT,
  ejemplos: [{ cliente: "muy caro {x}", vendedor: "Con 2 pagás un solo envío. ¿Te armo el de 2?" }, { cliente: "sin vendedor" }],
  faq: [{ pregunta: "¿Llega al interior?", respuesta: "Sí, a todo el país." }, "basura"],
  objeciones: ["precio alto", "desconfía", 3],
};

Deno.test("versión activa: plantilla = prompt + objeciones + FAQ + ejemplos (igual que la batería de mejora-mensual)", () => {
  const { plantilla, motivo } = plantillaDeVersion(FILA);
  assertEquals(motivo, null);
  assert(plantilla!.startsWith(PLANTILLA_PROMPT.trimEnd()));
  assert(plantilla!.includes("ORDEN DE OBJECIONES (las más frecuentes primero): precio alto > desconfía."));
  assert(plantilla!.includes('- "¿Llega al interior?" → "Sí, a todo el país."'));
  assert(plantilla!.includes('Cliente: "muy caro (x)"')); // llaves neutralizadas fuera del prompt
  assert(!plantilla!.includes("sin vendedor")); // entradas mal formadas, afuera
  const v = normalizarFilaVersion(FILA)!;
  assertEquals(
    armarPromptVersion({ numero: 2, estado: "activa", origen: "manual", ...v }),
    armarPlantillaVersion(v),
  );
  // Las llaves del prompt siguen funcionando con armarPrompt.
  const armado = armarPrompt({ glosario: [], fichas: [], envio: { costo_gs: 33000 }, afirmaciones: [], aceptaciones: ["dale"] }, plantilla!);
  assert(!armado.includes("{fichas_de_producto}"));
  assertEquals(armarConfigTurno({ vendedor_prompt: plantilla }).cfg.plantillaPrompt, plantilla);
});

Deno.test("versión activa: sin fila, sin prompt o sin llaves ⇒ prompt del archivo", () => {
  assertEquals(plantillaDeVersion(null), { plantilla: null, motivo: null });
  assertEquals(plantillaDeVersion({ numero: 3, prompt: "" }).plantilla, null);
  const sinLlaves = plantillaDeVersion({ numero: 4, prompt: "Sos el vendedor. {glosario}" });
  assertEquals(sinLlaves.plantilla, null);
  assert(sinLlaves.motivo!.includes("fichas_de_producto"));
});

Deno.test("versión activa: caché de 5 min (no lee la base en cada mensaje) y reintento corto tras un error", async () => {
  let t = 0;
  let lecturas = 0;
  let falla = false;
  const logs: string[] = [];
  const c = crearCacheVersion(() => {
    lecturas++;
    return falla ? Promise.reject(new Error("relation vendedor_versiones does not exist")) : Promise.resolve(FILA);
  }, { ahora: () => t, log: (m) => logs.push(m) });
  const p1 = await c.obtener();
  t += 4 * 60_000;
  const p2 = await c.obtener();
  assertEquals(lecturas, 1);
  assertEquals(p1, p2);
  t += 2 * 60_000; // pasaron 6 min
  falla = true;
  assertEquals(await c.obtener(), null);
  assertEquals(lecturas, 2);
  assert(logs.at(-1)!.includes("uso el prompt del archivo"));
  t += TTL_ERROR_MS - 1;
  await c.obtener();
  assertEquals(lecturas, 2);
  t += 2;
  falla = false;
  assert((await c.obtener())!.includes("ORDEN DE OBJECIONES"));
  assertEquals(lecturas, 3);
  c.limpiar();
  await c.obtener();
  assertEquals(lecturas, 4);
});
