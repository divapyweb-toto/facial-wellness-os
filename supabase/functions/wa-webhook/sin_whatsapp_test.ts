// 23-10 · número sin WhatsApp (131026): aviso a Enrique con los posibles WhatsApp reales. Datos inventados.
import { assertEquals } from "jsr:@std/assert@1";
import { candidatosWhatsapp, type Deps, procesarEstado, telefonoLocal } from "./procesar.ts";

const AHORA = new Date("2026-10-23T12:00:00Z");

Deno.test("23-10 candidatosWhatsapp: un dígito de distancia primero, después mismo nombre de esta semana; nunca el mismo número", () => {
  const c = candidatosWhatsapp("+595981000111", "Mario Prueba", [
    { telefono: "+595981000111", nombre: "Mario", ultima_vez: "2026-10-23T11:00:00Z" }, // el mismo
    { telefono: "+595981000117", nombre: "Otro", ultima_vez: null }, // 1 dígito
    { telefono: "+595991222333", nombre: "Mario Gómez", ultima_vez: "2026-10-21T18:00:00Z" }, // mismo nombre, reciente
    { telefono: "+595991444555", nombre: "Mario", ultima_vez: "2026-10-01T18:00:00Z" }, // mismo nombre, viejo
    { telefono: "+595981000222", nombre: "Ana", ultima_vez: "2026-10-22T10:00:00Z" }, // 3 dígitos
  ], AHORA);
  assertEquals(c.map((x) => [telefonoLocal(x.telefono), x.motivo]), [["0981 000 117", "un_digito"], ["0991 222 333", "mismo_nombre"]]);
  assertEquals(candidatosWhatsapp("+595981000111", "Al", [{ telefono: "+595991222333", nombre: "Al", ultima_vez: "2026-10-23T10:00:00Z" }], AHORA), []);
});

Deno.test("23-10 procesarEstado: 'failed' con 131026 → avisarSinWhatsapp; otro código no", async () => {
  const llamados: string[] = [];
  const deps = {
    estadoMensaje: () => Promise.resolve("enviado"),
    actualizarMensaje: () => Promise.resolve(),
    config: () => Promise.resolve(null),
    avisarSinWhatsapp: (id: string) => (llamados.push(id), Promise.resolve()),
  } as unknown as Deps;
  await procesarEstado({ id: "wamid.A", status: "failed", errors: [{ code: 131026 }] } as never, deps);
  await procesarEstado({ id: "wamid.B", status: "failed", errors: [{ code: 131047 }] } as never, deps);
  assertEquals(llamados, ["wamid.A"]);
});
