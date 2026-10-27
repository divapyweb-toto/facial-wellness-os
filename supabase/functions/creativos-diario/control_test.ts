import { assertEquals } from "@std/assert";
import { avisoDescuadreCreativos, diasFueraDeRango } from "./control.ts";
import { decidirRuta } from "../_shared/telegram_politica.ts";

Deno.test("22-10: el control marca el 19-10 (₲3.986 contra ₲212.559) y no los días dentro del 2 %", () => {
  const filas = [
    { fecha: "2026-10-18", creativos: 269142, anuncio: 269142 },
    { fecha: "2026-10-19", creativos: 3986, anuncio: 212559 },
    { fecha: "2026-10-20", creativos: 170946, anuncio: 170946 },
    { fecha: "2026-10-21", creativos: 194638, anuncio: 194731 },   // 0,05 %
    { fecha: "2026-10-22", creativos: 59003, anuncio: null },      // hoy: sin dato del otro lado → no se compara
    { fecha: "2026-10-14", creativos: 100, anuncio: 200000 },      // fuera de la ventana de control
  ];
  assertEquals(diasFueraDeRango(filas, "2026-10-15", "2026-10-21").map((f) => f.fecha), ["2026-10-19"]);
  assertEquals(diasFueraDeRango(filas, "2026-10-15", "2026-10-18"), []);
  assertEquals(diasFueraDeRango([{ fecha: "2026-10-19", creativos: 208000, anuncio: 212559 }], "2026-10-15", "2026-10-21").length, 1); // 2,14 % → fuera
  assertEquals(diasFueraDeRango([{ fecha: "2026-10-19", creativos: 209000, anuncio: 212559 }], "2026-10-15", "2026-10-21").length, 0); // 1,7 % → dentro
});

Deno.test("27-10: descuadre del libro de creativos va a administración, 1 por día por fecha", () => {
  const o = avisoDescuadreCreativos("2026-10-25");
  assertEquals(o, { tipo: "creativos_libro_descuadre", destino: "admin", unaVezPorDia: true, clave: "2026-10-25" });
  assertEquals(decidirRuta(null, o), "admin");
});
