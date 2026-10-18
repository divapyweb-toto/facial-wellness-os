import { assertEquals } from "@std/assert";
import { familia, stockReal } from "./logica.ts";

const P = [
  { id: "r", nombre: "Raspador de Lengua", stock: 92, esCombo: false, componentes: [] },
  { id: "t", nombre: "Tiras nasales", stock: 31, esCombo: false, componentes: [] },
  { id: "p", nombre: "Parches bucales", stock: 112, esCombo: false, componentes: [] },
  { id: "j", nombre: "Ejercitador de mandibula JawFlex Pro", stock: 26, esCombo: false, componentes: [] },
  { id: "k", nombre: "tiras nasales + parches bucales Pack Gudair", stock: 0, esCombo: true, componentes: [{ id: "t", qty: 1 }, { id: "p", qty: 1 }] },
];
const ped = (titulo: string, cantidad: number) => ({ lineas: [{ titulo, cantidad }] });

Deno.test("familias de los títulos de Shopify", () => {
  assertEquals(familia("Pack GUDAIR: nariz abierta, boca cerrada"), "Pack");
  assertEquals(familia("Ejercitador de Mandíbula: entrená en minutos"), "JawFlex");
  assertEquals(familia("Tiras Nasales: más aire por la nariz"), "Tiras");
});

Deno.test("stock real = stock − pendientes; el Pack consume tiras y parches y vale lo que alcancen", () => {
  const r = stockReal(P, [ped("Raspador de Lengua", 2), ped("Tiras Nasales", 1), ped("Parches Bucales", 2), ped("Pack GUDAIR", 1), ped("Pack GUDAIR", 1),
    ...Array.from({ length: 6 }, () => ped("Ejercitador de Mandíbula", 1))]);
  assertEquals(r.get("Raspador")?.real, 90);
  assertEquals(r.get("Tiras")?.real, 28);
  assertEquals(r.get("Parches")?.real, 108);
  assertEquals(r.get("JawFlex")?.real, 20);
  assertEquals(r.get("Pack")?.real, 28);
  assertEquals(r.get("Pack")?.sinDescontar, 2);
});

Deno.test("nunca negativo", () => {
  assertEquals(stockReal(P, [ped("Raspador", 500)]).get("Raspador")?.real, 0);
});
