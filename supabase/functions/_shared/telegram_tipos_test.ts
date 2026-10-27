// 27-10: cada `tipo: "..."` que el código pasa a avisar() tiene que estar en TIPOS_AVISO, y la política que se carga
// en config no puede mandar a 'admin' ni descartar un aviso que el inventario marca para Enrique.
import { assert, assertEquals } from "@std/assert";
import { politicaInicial, TIPOS_AVISO } from "./telegram_tipos.ts";
import { decidirRuta } from "./telegram_politica.ts";

const RAIZ = new URL("../", import.meta.url).pathname;
// Del chat WhatsApp (los reclasifica él); el resto es de FUNCIONES.
const AJENOS = ["wa-webhook", "seguimiento-chat", "_shared/vendedor"];

async function* archivos(dir: string): AsyncGenerator<string> {
  for await (const e of Deno.readDir(dir)) {
    const p = `${dir}${e.name}`;
    if (e.isDirectory) { if (!e.name.startsWith(".") && e.name !== "node_modules") yield* archivos(`${p}/`); }
    else if (/\.ts$/.test(e.name) && !/_test\.ts$/.test(e.name)) yield p;
  }
}

async function tiposEnCodigo(): Promise<Map<string, { destino: string; archivo: string }>> {
  const m = new Map<string, { destino: string; archivo: string }>();
  for await (const p of archivos(RAIZ)) {
    const rel = p.slice(RAIZ.length);
    if (AJENOS.some((a) => rel.startsWith(a)) || rel.startsWith("_shared/telegram")) continue;
    const s = await Deno.readTextFile(p);
    for (const x of s.matchAll(/tipo:\s*"([a-z0-9_]+)"\s*,\s*destino:\s*"(enrique|admin)"/g)) m.set(x[1], { destino: x[2], archivo: rel });
  }
  return m;
}

Deno.test("cada tipo usado en el código está registrado en TIPOS_AVISO", async () => {
  const faltan = [...(await tiposEnCodigo()).entries()].filter(([t]) => !TIPOS_AVISO[t]).map(([t, v]) => `${t} (${v.archivo})`);
  assertEquals(faltan, []);
});

Deno.test("ningún aviso de Enrique se pierde: destino 'enrique' del código → inmediato o resumen en la política", async () => {
  const pol = politicaInicial();
  const perdidos = [...(await tiposEnCodigo()).entries()]
    .filter(([t, v]) => v.destino === "enrique" && TIPOS_AVISO[t] && !["inmediato", "resumen"].includes(TIPOS_AVISO[t].ruta))
    .map(([t]) => t);
  assertEquals(perdidos, []);
  for (const [t, v] of Object.entries(TIPOS_AVISO)) {
    const ruta = decidirRuta(pol, { tipo: t, destino: v.ruta === "inmediato" || v.ruta === "resumen" ? "enrique" : "admin" });
    assertEquals(ruta, { inmediato: "telegram", resumen: "resumen", admin: "admin", descartar: "descartar" }[v.ruta], t);
  }
});

Deno.test("política inicial: urgentes inmediatos y no urgentes en el resumen (pedido de administración 27-10)", () => {
  const pol = politicaInicial();
  assert(pol.enrique.includes("lista_despacho"));
  for (const t of Object.keys(TIPOS_AVISO)) assert(!(pol.enrique.includes(t) && pol.resumen.includes(t)), t);
});
