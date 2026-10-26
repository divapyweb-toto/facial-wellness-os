// 26-10: oferta extra post-compra (datos inventados).
import { assert, assertEquals } from "jsr:@std/assert@1";
import { extrasVendedor } from "./config.ts";
import {
  botonOfertaExtra, datosModificacionExtra, elegirOfertaExtra, esModificacionExtra, interactivoOfertaExtra, textoOfertaExtra,
  textoTrasSi, TEXTO_EXTRA_EN_PROCESO, TEXTO_EXTRA_VENCIDA,
} from "./oferta_extra.ts";
import { botonesPrimerTurno, cuerpoPrimerTurno, frasesCantidad, type ItemCatalogo } from "./herramientas.ts";
import type { CfgVendedor, PedidoChat, ProductoShopify } from "./tipos.ts";

const PARCHES = "parches-bucales-gudair-30-unidades";
const OFERTAS = {
  parches_raspador: {
    activo: true, si_lleva: "raspador", no_si_lleva: "parche|pack", extra: PARCHES, precio: 49000, stock_min: 10,
    tag: "OFERTA_EXTRA_PARCHES", texto: "¿Querés sumar parches bucales por {precio} en el mismo envío? Precio normal 79.000.",
  },
};
const prod = (handle: string, stock: number | null, disponible = true): ProductoShopify => ({
  id: `gid://shopify/Product/${handle}`, handle, title: `Título ${handle}`, imagen: null, stock,
  variantes: [{ id: `gid://shopify/ProductVariant/${handle}`, title: "Default Title", price: 79000, disponible }],
});
const CATALOGO = [prod(PARCHES, 95), prod("raspador-de-lengua", 55), prod("pack-gudair", 19)];
const lin = (handle: string, cantidad = 1, total = 79000) => ({ handle, titulo: handle, variante_id: `v-${handle}`, cantidad, total });

Deno.test("elegirOfertaExtra: Raspador → parches; nunca a quien lleva parches o pack; stock > mínimo; apagada no", () => {
  assertEquals(elegirOfertaExtra([lin("raspador-de-lengua")], OFERTAS, CATALOGO)?.clave, "parches_raspador");
  assertEquals(elegirOfertaExtra([lin("raspador-de-lengua"), lin(PARCHES)], OFERTAS, CATALOGO), null);
  assertEquals(elegirOfertaExtra([lin("raspador-de-lengua"), lin("pack-gudair")], OFERTAS, CATALOGO), null);
  assertEquals(elegirOfertaExtra([lin("tiras-nasales")], OFERTAS, CATALOGO), null);
  assertEquals(elegirOfertaExtra([lin("raspador-de-lengua")], OFERTAS, [prod(PARCHES, 10)]), null); // 10 no es MÁS de 10
  assertEquals(elegirOfertaExtra([lin("raspador-de-lengua")], OFERTAS, [prod(PARCHES, 11)])?.clave, "parches_raspador");
  assertEquals(elegirOfertaExtra([lin("raspador-de-lengua")], OFERTAS, [prod(PARCHES, null)]), null); // sin dato de stock
  assertEquals(elegirOfertaExtra([lin("raspador-de-lengua")], OFERTAS, [prod(PARCHES, 95, false)]), null);
  assertEquals(elegirOfertaExtra([lin("raspador-de-lengua")], { x: { ...OFERTAS.parches_raspador, activo: false } }, CATALOGO), null);
});

Deno.test("datosModificacionExtra: el pedido tal cual + 1 extra al precio de config, mismo envío, con la etiqueta", () => {
  const pc = {
    id: "pc1", conversacion_id: "c", cliente_id: "cli", estado: "creado", total: 112000, shopify_order_id: 1, creado_en: "x",
    datos: { lineas: [lin("raspador-de-lengua")], envio: 33000, total: 112000 },
  } as unknown as PedidoChat;
  const e = elegirOfertaExtra(pc.datos.lineas, OFERTAS, CATALOGO)!;
  const d = datosModificacionExtra(pc, "#2001", e);
  assertEquals([d.total, d.envio, d.lineas.length, d.lineas[1].total, d.lineas[1].cantidad], [161000, 33000, 2, 49000, 1]);
  assertEquals([d.camino, d.oferta_extra, d.tags_extra], ["reemplazar", "parches_raspador", ["OFERTA_EXTRA_PARCHES"]]);
  assertEquals(d.total_antes, 112000);
});

Deno.test("texto y botones de la oferta: precio de config; Sí = vend_mod (ejecuta), No = vend_extra_no", () => {
  assertEquals(textoOfertaExtra(OFERTAS.parches_raspador), "¿Querés sumar parches bucales por ₲49.000 en el mismo envío? Precio normal 79.000.");
  const i = JSON.stringify(interactivoOfertaExtra(OFERTAS.parches_raspador, "m-1"));
  assert(i.includes("vend_mod:m-1") && i.includes("vend_extra_no:m-1") && i.includes("Sí, quiero") && i.includes("No, gracias"), i);
  assertEquals(botonOfertaExtra("[botón] No, gracias (vend_extra_no:m-1)"), { tipo: "no", id: "m-1" });
  assertEquals(botonOfertaExtra("[botón] Sí, quiero (vend_mod:m-1)"), { tipo: "si", id: "m-1" });
  assertEquals(botonOfertaExtra("dale"), null);
  assert(!esModificacionExtra(null));
  assert(esModificacionExtra({ datos: { oferta_extra: "parches_raspador" } } as never));
  assert(!esModificacionExtra({ datos: {} } as never)); // un cambio pedido por el cliente sigue por el modelo
});

Deno.test("textoTrasSi: el de modificar_pedido; vencida; si falla, 'te confirmo en un ratito'", () => {
  assertEquals(textoTrasSi({ resultado: { ok: true, texto_respuesta: "Listo, quedó." } }), "Listo, quedó.");
  assertEquals(textoTrasSi({ resultado: { ok: false, error: "resumen_vencido: mostrá" }, esError: true }), TEXTO_EXTRA_VENCIDA);
  assertEquals(textoTrasSi({ resultado: { ok: false, error: "shopify_fallo" }, esError: true }), TEXTO_EXTRA_EN_PROCESO);
});

Deno.test("config: ofertas_extra y primer_turno_producto (incompletas o regex inválida no se usan; por defecto apagado)", () => {
  const base = { tope_mensual_usd: 90 } as unknown as CfgVendedor;
  assertEquals(extrasVendedor(base).ofertas_extra, {});
  assertEquals(extrasVendedor(base).primer_turno_producto, {});
  const x = extrasVendedor({
    ...base,
    ofertas_extra: {
      ok: { ...OFERTAS.parches_raspador, activo: "true" }, // "true" texto no prende
      sin_precio: { ...OFERTAS.parches_raspador, precio: 0 },
      regex_mala: { ...OFERTAS.parches_raspador, si_lleva: "(" },
    },
    primer_turno_producto: { jaw: { sin_oferta_2: true, texto: " Es un ejercitador. ", media: "foto", otra: 1 }, mal: "x" },
  } as unknown as CfgVendedor);
  assertEquals(Object.keys(x.ofertas_extra), ["ok"]);
  assertEquals(x.ofertas_extra.ok.activo, false);
  assertEquals(x.primer_turno_producto, { jaw: { sin_oferta_2: true, texto: "Es un ejercitador.", media: "foto" } });
});

Deno.test("primer turno sin oferta de 2 (JawFlex, Botella): sin botón ni frase de 2; el resto igual", () => {
  const item = {
    handle: "ejercitador", titulo: "JawFlex", precio: 79000, total: 112000, disponible: true, frase_precio: "79.000 + 33.000",
    ofertas: [{ cantidad: 2, precio: 125000, total: 158000, frase_precio: "2 por 158.000" }],
  } as unknown as ItemCatalogo;
  assertEquals(botonesPrimerTurno(item).map((b) => b.titulo), ["2 con envío gratis", "Quiero 1", "Tengo una duda"]);
  assertEquals(botonesPrimerTurno(item, true).map((b) => b.titulo), ["Quiero 1", "Tengo una duda"]);
  assert(cuerpoPrimerTurno(item).includes("Llevando 2"));
  assert(!cuerpoPrimerTurno(item, true).includes("Llevando 2"));
  assertEquals(frasesCantidad(item, true), {});
  assert("pasar_a_2" in frasesCantidad(item));
});
