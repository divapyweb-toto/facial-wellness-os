// _shared/transportadoras_sync_test.ts · 12-10: la copia del ruteo que usan las Edge Functions tiene que ser la de
// la web. Si falla: node scripts/sincronizar-ruteo.mjs (desde la raíz del repo).
import { assert, assertEquals } from "jsr:@std/assert@1";
import { DESTINO, FUENTES, generarCopias } from "../../../scripts/sincronizar-ruteo.mjs";

const raiz = new URL("../../../", import.meta.url);
const leer = (ruta: string) => Deno.readTextFile(new URL(ruta, raiz));

Deno.test("transportadoras.js y cobranzaPaP.js de _shared están al día con src/lib (si no: node scripts/sincronizar-ruteo.mjs)", async () => {
  const fuentes = {
    transportadoras: await leer(FUENTES.transportadoras),
    cobranza: await leer(FUENTES.cobranza),
    config: await leer(FUENTES.config),
    recompra: await leer(FUENTES.recompra),
  };
  const copias = generarCopias(fuentes);
  assertEquals(Object.keys(copias).sort(), ["cobranzaPaP.js", "transportadoras.js"]);
  for (const [nombre, esperado] of Object.entries(copias)) {
    const actual = await leer(`${DESTINO}/${nombre}`);
    // Sin assertEquals: el diff de 600 líneas tapa el mensaje que importa.
    assert(actual === esperado, `${DESTINO}/${nombre} quedó vieja respecto de src/lib: corré node scripts/sincronizar-ruteo.mjs`);
    assert(actual.startsWith("// COPIA GENERADA de src/lib/"), nombre);
  }
});

Deno.test("generarCopias frena ante un import que la copia no sabe resolver (no genera una copia rota)", () => {
  const base = { transportadoras: "", cobranza: "export const X = 1\n", config: "flete_pap: 29000,", recompra: "" };
  const t = (transportadoras: string, extra: Partial<typeof base> = {}) => () => generarCopias({ ...base, transportadoras, ...extra });
  const lanza = (f: () => unknown, re: RegExp) => {
    try {
      f();
    } catch (e) {
      assert(re.test(String(e)), String(e));
      return;
    }
    throw new Error(`no lanzó: ${re}`);
  };
  lanza(t("import { x } from './otro'\n"), /import no previsto/);
  lanza(t("import { getEnvioCliente } from './config'\n"), /getEnvioCliente/);
  lanza(t("import algo from './cobranzaPaP'\n"), /otra forma/);
  lanza(t("import { familiaProducto } from './recompra'\n"), /familiaProducto/);
  lanza(t("", { cobranza: "import { a } from './b'\n" }), /cobranzaPaP\.js ahora importa/);
});

Deno.test("la copia anda en Deno: ruteo oficial del 09-10 (Capiatá y 6 más a PaP; Itá y Fernando de la Mora con Lucero)", async () => {
  const { ruteoOficial, velocidadLucero, ciudadLucero, cubre, sugerirTransportadora } = await import("./transportadoras.js");
  for (const c of ["Capiatá", "Limpio", "Ñemby", "Areguá", "Itauguá", "J. Augusto Saldívar", "Ypané"]) assertEquals(ruteoOficial(c), "pap", c);
  for (const c of ["Itá", "Fernando de la Mora", "Asunción", "Ciudad del Este", "Encarnación"]) assertEquals(ruteoOficial(c), "lucero", c);
  assertEquals(ruteoOficial("Pueblo Inventado"), null);
  assertEquals(velocidadLucero(ciudadLucero("Asunción")), "diaria");
  assertEquals(cubre("pap", "Capiatá"), true);
  // La función completa también corre (Config de fábrica: flete 29.000, tarifario de transportadoras.js).
  assert(["lucero", "pap"].includes(sugerirTransportadora("Capiatá").transportadora));
});
