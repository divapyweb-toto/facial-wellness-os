// 05-11: la ciudad se corrige también en el atributo del formulario (datos inventados).
import { assertEquals } from "jsr:@std/assert@1";
import { atributosConCiudad } from "./ciudad_pedido.ts";

Deno.test("atributosConCiudad: cambia solo Ciudad y conserva el resto; si falta, la agrega", () => {
  const a = [{ key: "Nombre de pila", value: "Ana" }, { key: "Ciudad", value: "Casa" }, { key: "UTM source", value: "fb" }];
  assertEquals(atributosConCiudad(a, " Asunción "), [{ key: "Nombre de pila", value: "Ana" }, { key: "Ciudad", value: "Asunción" }, { key: "UTM source", value: "fb" }]);
  assertEquals(atributosConCiudad([{ key: "Nombre de pila", value: "Ana" }], "Luque"), [{ key: "Nombre de pila", value: "Ana" }, { key: "Ciudad", value: "Luque" }]);
});
