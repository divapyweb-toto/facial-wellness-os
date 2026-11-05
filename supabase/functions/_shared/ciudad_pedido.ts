// _shared/ciudad_pedido.ts · 05-11 (#1150 "Casa", #1205 "Central"): la ciudad de un pedido vive en DOS lugares: la dirección
// de envío de Shopify y el atributo "Ciudad" que carga el formulario de Releasit (lo lee Despacho). Corregir solo la
// dirección dejaba el pedido trabado en "ciudad no reconocida". Toda corrección de ciudad pasa por acá y cambia los dos.
import { gql } from "./shopify.ts";

export type Atributo = { key: string; value: string };

/** Los mismos atributos con "Ciudad" = ciudad (si no estaba, se agrega). No toca los demás ni su orden. */
export function atributosConCiudad(attrs: Atributo[], ciudad: string): Atributo[] {
  const c = ciudad.trim();
  if (!attrs.some((a) => a.key === "Ciudad")) return [...attrs, { key: "Ciudad", value: c }];
  return attrs.map((a) => (a.key === "Ciudad" ? { key: a.key, value: c } : a));
}

/** Cambia la ciudad del pedido en la dirección de envío y en el atributo "Ciudad". null = ok; si no, el error. */
export async function corregirCiudadPedido(orderId: number, ciudad: string, provincia?: string | null): Promise<string | null> {
  const id = `gid://shopify/Order/${orderId}`;
  if (!ciudad.trim()) return "ciudad vacía";
  const d = await gql<{ order: { customAttributes: Atributo[] } | null }>(`query($id: ID!) { order(id: $id) { customAttributes { key value } } }`, { id });
  if (!d.order) return "pedido no encontrado";
  const r = await gql<{ orderUpdate: { userErrors: Array<{ message: string }> } }>(
    `mutation($i: OrderInput!) { orderUpdate(input: $i) { userErrors { message } } }`,
    { i: { id, shippingAddress: { city: ciudad.trim(), ...(provincia ? { province: provincia } : {}) }, customAttributes: atributosConCiudad(d.order.customAttributes, ciudad) } },
  );
  const e = r.orderUpdate.userErrors;
  return e.length ? e.map((x) => x.message).join("; ") : null;
}
