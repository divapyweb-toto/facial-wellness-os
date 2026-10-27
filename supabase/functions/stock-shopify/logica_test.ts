import { assertEquals } from "@std/assert";
import { avisoStockBajo, familia, stockReal } from "./logica.ts";
import { decidirRuta } from "../_shared/telegram_politica.ts";

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

// 26-10: Kit Deporte = 1 botella + 1 tiras. Antes de este cambio el título del kit caía en "Tiras".
Deno.test("Kit Deporte: familia propia (no Tiras ni Botella) y vale lo que alcancen botellas y tiras", () => {
  assertEquals(familia("Kit Deporte: Botella Flexible + Tiras Nasales"), "Kit Deporte");
  assertEquals(familia("Kit Deporte (Botella Flexible + Tiras nasales)"), "Kit Deporte");
  assertEquals(familia("Botella Deportiva Flexible: se enrolla y no pesa"), "Botella");
  const PK = [...P, { id: "b", nombre: "Botella Flexible", stock: 42, esCombo: false, componentes: [] },
    { id: "kd", nombre: "Kit Deporte (Botella Flexible + Tiras nasales)", stock: 0, esCombo: true, componentes: [{ id: "b", qty: 1 }, { id: "t", qty: 1 }] }];
  const r = stockReal(PK, [ped("Kit Deporte: Botella + Tiras", 2), ped("Botella Deportiva Flexible", 1)]);
  assertEquals(r.get("Botella")?.real, 39); // 42 − 2 del kit − 1 suelta
  assertEquals(r.get("Tiras")?.real, 29); // 31 − 2 del kit
  assertEquals(r.get("Kit Deporte")?.real, 29); // lo que alcancen: min(39, 29)
  assertEquals(r.get("Kit Deporte")?.sinDescontar, 2);
  assertEquals(r.get("Pack")?.real, 29); // el Pack también comparte las tiras
});

Deno.test("27-10: stock bajo va a administración, 1 por día por familia", () => {
  const o = avisoStockBajo("Tiras");
  assertEquals(o, { tipo: "stock_bajo", destino: "admin", unaVezPorDia: true, clave: "Tiras" });
  assertEquals(decidirRuta(null, o), "admin");
});
