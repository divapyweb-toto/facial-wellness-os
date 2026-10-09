// kude_test.ts · deno test --no-check -A _shared/sifen/kude_test.ts (desde supabase/functions)
// Datos 100 % inventados (repo público).
import { assert, assertEquals } from "@std/assert";
import { PDFDocument } from "npm:pdf-lib@1.17.1";
import jsQRModulo from "npm:jsqr@1.4.0";
// jsqr exporta CommonJS: según el loader, la función viene directa o en .default.
const jsQR = ((jsQRModulo as unknown as { default?: unknown }).default ?? jsQRModulo) as unknown as (d: Uint8ClampedArray, w: number, h: number) => { data: string } | null;
import { cdcEnGrupos, formatoGs, generarKude, generarKudeDetalle, LEYENDA_XML, MARCA_AGUA } from "./kude.ts";
import type { DatosEmisor, DocumentoDE, ItemDE, TotalesDE } from "./tipos.ts";

const EMISOR: DatosEmisor = {
  ruc: "80000001",
  dv: "7",
  razonSocial: "EMPRESA DE PRUEBA S.A.",
  nombreFantasia: "VOLTRA",
  tipoContribuyente: 2,
  direccion: "Avenida Inventada",
  numeroCasa: "123",
  departamento: { codigo: 10, descripcion: "ALTO PARANA" },
  distrito: { codigo: 145, descripcion: "CIUDAD DEL ESTE" },
  ciudad: { codigo: 3428, descripcion: "CIUDAD DEL ESTE" },
  telefono: "0900 000000",
  email: "facturas@ejemplo.com.py",
  actividades: [{ codigo: "47911", descripcion: "Comercio al por menor por correo y por internet" }],
  establecimiento: "001",
  punto: "001",
};
const CDC = "01800000017001001000000122026100811234567892";
const CDC_FE = "01800000017001001000000112026100811234567895";
const URL_QR =
  "https://ekuatia.set.gov.py/consultas-test/qr?nVersion=150&Id=01800000017001001000000122026100811234567892&dFeEmiDE=323032362d31302d30385431343a33303a3030&dRucRec=80000002&dTotGralOpe=224000&dTotIVA=20364&cItems=3&DigestValue=6a4e5a6a4d6a4d324e5759314f4449774d47566c4e6a63304e7a51794d4459334f544d304f474d3d&IdCSC=0001&cHashQR=0f3c4bb1a8d2b7e95ac0ee5bd8a6e9e7a1f1b2c3d4e5f60718293a4b5c6d7e8f";

function item(codigo: string, descripcion: string, cantidad: number, precio: number, extra: Partial<ItemDE> = {}): ItemDE {
  return { codigo, descripcion, cantidad, precioUnitario: precio, ivaTasa: 10, ivaAfectacion: 1, unidadMedida: 77, ...extra };
}

function totalesDe(items: ItemDE[]): TotalesDE {
  let g10 = 0, g5 = 0, exe = 0, dto = 0;
  for (const it of items) {
    const v = Math.round((it.precioUnitario - (it.descuentoUnitario ?? 0)) * it.cantidad);
    dto += (it.descuentoUnitario ?? 0) * it.cantidad;
    if (it.ivaAfectacion === 3 || it.ivaTasa === 0) exe += v;
    else if (it.ivaTasa === 5) g5 += v;
    else g10 += v;
  }
  const iva10 = Math.round(g10 / 11), iva5 = Math.round(g5 / 21);
  return {
    total: g10 + g5 + exe,
    totalIva: iva10 + iva5,
    iva10,
    iva5,
    base10: g10 - iva10,
    base5: g5 - iva5,
    gravado10: g10,
    gravado5: g5,
    exento: exe,
    exonerado: 0,
    descuentoTotal: dto,
  };
}

function docBase(items: ItemDE[], over: Partial<DocumentoDE> = {}): DocumentoDE {
  return {
    tipo: 1,
    establecimiento: "001",
    punto: "001",
    numero: 1,
    fechaEmision: "2026-10-08T14:30:00",
    tipoEmision: 1,
    codigoSeguridad: "123456789",
    receptor: { tipo: "innominado" },
    items,
    moneda: "PYG",
    condicion: { tipo: 1, pagos: [{ tipo: 1, monto: 0 }] },
    ...over,
  };
}

function args(doc: DocumentoDE, extra: Record<string, unknown> = {}) {
  return {
    doc,
    emisor: EMISOR,
    timbrado: "12345678",
    timbradoInicio: "2026-10-01",
    cdc: CDC,
    totales: totalesDe(doc.items),
    urlQr: URL_QR,
    ambiente: "test" as const,
    ...extra,
  };
}

function contiene(textos: string[], buscado: string) {
  // une con espacio: un texto puede haberse ajustado en varias líneas
  const todo = textos.join("\n") + "\n" + textos.join(" ");
  assert(todo.includes(buscado), `falta en el KuDE: "${buscado}"`);
}

const ITEMS_CF = [
  item("JAWFLEX", "JawFlex ejercitador mandibular", 2, 112000, { descuentoUnitario: 10000 }),
  item("TIRAS", "Tiras nasales x30", 1, 89000),
  item("ENVIO", "Envío a domicilio", 1, 25000),
];

const MUESTRAS = "/private/tmp/claude-501/kude-muestras";

Deno.test("formatos: miles con punto y CDC en grupos de 4", () => {
  assertEquals(formatoGs(112000), "112.000");
  assertEquals(formatoGs(1234567), "1.234.567");
  assertEquals(formatoGs(0), "0");
  assertEquals(cdcEnGrupos(CDC).split(" ").length, 11);
  assertEquals(cdcEnGrupos(CDC).split(" ")[0], "0180");
});

Deno.test("FE consumidor final (innominado) con 2 ítems + envío", async () => {
  const d = await generarKudeDetalle(args(docBase(ITEMS_CF)));
  assertEquals(new TextDecoder().decode(d.pdf.slice(0, 5)), "%PDF-");
  assertEquals(d.paginas, 1);
  for (
    const t of [
      "KuDE de Factura Electrónica",
      "FACTURA ELECTRÓNICA",
      "Nº 001-001-0000001",
      "VOLTRA",
      "EMPRESA DE PRUEBA S.A.",
      "80000001-7",
      "12345678",
      "2026-10-01",
      "2026-10-08 14:30:00",
      "Contado",
      "PYG · Guaraní",
      "Sin Nombre",
      "Venta de mercadería",
      "Comercio al por menor por correo y por internet",
      "Avenida Inventada Nº 123",
      "0900 000000",
      "facturas@ejemplo.com.py",
      "204.000", // (112.000 − 10.000) × 2
      "10.000",
      "318.000", // total
      "28.909", // IVA 10 %
      "TOTAL EN GUARANÍES:",
      "LIQUIDACIÓN IVA:",
      "TOTAL IVA:",
      "Consulte la validez de esta Factura Electrónica con el número de CDC impreso abajo en:",
      "https://ekuatia.set.gov.py/consultas-test/",
      `CDC: ${cdcEnGrupos(CDC)}`,
      LEYENDA_XML,
      MARCA_AGUA,
      "Página 1/1",
    ]
  ) contiene(d.textos, t);
  // el PDF abre con pdf-lib y trae metadatos
  const leido = await PDFDocument.load(d.pdf);
  assertEquals(leido.getPageCount(), 1);
  assertEquals(leido.getTitle(), "KuDE de Factura Electrónica 001-001-0000001");
  // fuentes Inter embebidas con mapa a Unicode (texto copiable/buscable)
  const crudo = new TextDecoder("latin1").decode(d.pdf);
  assert(crudo.includes("Inter"), "fuente Inter no embebida");
  assert(crudo.includes("/ToUnicode"), "falta ToUnicode");
  await Deno.mkdir(MUESTRAS, { recursive: true });
  await Deno.writeFile(`${MUESTRAS}/1-fe-consumidor-final.pdf`, d.pdf);
});

Deno.test("prod sin simulado: sin marca de agua y URL de producción", async () => {
  const d = await generarKudeDetalle(args(docBase(ITEMS_CF), { ambiente: "prod", simulado: false }));
  contiene(d.textos, "https://ekuatia.set.gov.py/consultas/");
  assert(!d.textos.includes(MARCA_AGUA), "no debe llevar marca de agua");
  const s = await generarKudeDetalle(args(docBase(ITEMS_CF), { ambiente: "prod", simulado: true }));
  assert(s.textos.includes(MARCA_AGUA), "simulado debe llevar marca de agua");
});

Deno.test("FE con RUC, 5 % y exenta", async () => {
  const items = [
    item("A1", "Producto gravado 10 %", 3, 45000),
    item("B1", "Libro de recetas", 1, 52500, { ivaTasa: 5 }),
    item("C1", "Servicio exento de prueba", 1, 30000, { ivaTasa: 0, ivaAfectacion: 3 }),
  ];
  const doc = docBase(items, {
    numero: 2,
    receptor: {
      tipo: "ruc",
      ruc: "80000002",
      dv: "5",
      razonSocial: "CLIENTE INVENTADO S.R.L.",
      direccion: "Calle Ficticia",
      numeroCasa: "456",
      // Con departamento y ciudad la dirección va en el XML (D213/D219/D223) y por eso también en el KuDE.
      departamento: 11,
      ciudad: 1,
      telefono: "0900 111222",
      email: "compras@cliente-inventado.com.py",
    } as DocumentoDE["receptor"], // departamento/ciudad: ReceptorExtra de xml.ts
    observacion: "Pedido de prueba #1001. Gracias por comprar en Voltra.",
  });
  const d = await generarKudeDetalle(args(doc));
  for (
    const t of [
      "80000002-5",
      "CLIENTE INVENTADO S.R.L.",
      "Calle Ficticia Nº 456",
      "compras@cliente-inventado.com.py",
      "Nº 001-001-0000002",
      "135.000",
      "52.500",
      "30.000",
      "217.500",
      "Información de interés del facturador electrónico emisor:",
    ]
  ) contiene(d.textos, t);
  await Deno.writeFile(`${MUESTRAS}/2-fe-con-ruc.pdf`, d.pdf);
});

Deno.test("NC con documento asociado (CDC) y motivo", async () => {
  const doc = docBase([item("JAWFLEX", "JawFlex ejercitador mandibular", 1, 112000)], {
    tipo: 5,
    numero: 1,
    condicion: undefined,
    asociado: { tipo: 1, cdc: CDC_FE },
    motivoNota: 2,
    receptor: { tipo: "documento", documentoTipo: 1, documentoNumero: "1234567", nombre: "María Inventada Núñez" },
  });
  const d = await generarKudeDetalle(args(doc));
  for (
    const t of [
      "KuDE de Nota de Crédito Electrónica",
      "NOTA DE CRÉDITO ELECTRÓNICA",
      "Electrónico",
      cdcEnGrupos(CDC_FE),
      "Devolución",
      "1234567",
      "María Inventada Núñez",
      "Consulte la validez de esta Nota de Crédito Electrónica con el número de CDC impreso abajo en:",
    ]
  ) contiene(d.textos, t);
  assert(!d.textos.includes("Venta de mercadería"), "D012 no se informa en NC");
  await Deno.writeFile(`${MUESTRAS}/3-nota-credito.pdf`, d.pdf);
});

Deno.test("40 ítems → paginado con encabezado repetido y totales al final", async () => {
  const items = Array.from({ length: 40 }, (_, i) => item(`SKU${i + 1}`, `Producto de prueba número ${i + 1}`, 1 + (i % 3), 15000 + i * 500));
  const d = await generarKudeDetalle(args(docBase(items)));
  assert(d.paginas >= 2, `esperaba ≥2 páginas, hubo ${d.paginas}`);
  const leido = await PDFDocument.load(d.pdf);
  assertEquals(leido.getPageCount(), d.paginas);
  contiene(d.textos, `Página ${d.paginas}/${d.paginas}`);
  // encabezado y bloque de consulta en cada página
  assertEquals(d.textos.filter((t) => t === "KuDE de Factura Electrónica").length, d.paginas);
  assertEquals(d.textos.filter((t) => t === "Descripción").length, d.paginas);
  assertEquals(d.textos.filter((t) => t === LEYENDA_XML).length, d.paginas);
  // totales una sola vez
  assertEquals(d.textos.filter((t) => t === "TOTAL EN GUARANÍES:").length, 1);
  contiene(d.textos, "SKU40");
  contiene(d.textos, formatoGs(totalesDe(items).total));
  await Deno.writeFile(`${MUESTRAS}/4-cuarenta-items.pdf`, d.pdf);
});

Deno.test("descripción muy larga se ajusta en varias líneas y ñ/á/€", async () => {
  const larga = "Kit de cuidado facial con ñandutí bordado, ácido hialurónico, vitamina C estabilizada y " +
    "accesorios de regalo — edición especial importada (precio referencia 20 €) " + "x".repeat(70);
  const items = [item("KIT-ÑANDÚ", larga, 1, 199000), item("ENVIO", "Envío", 1, 25000)];
  const d = await generarKudeDetalle(args(docBase(items)));
  const lineas = d.textos.filter((t) => larga.includes(t) && t.length > 3);
  assert(lineas.length >= 3, `la descripción debería ocupar ≥3 líneas (${lineas.length})`);
  contiene(d.textos, "ñandutí");
  contiene(d.textos, "ácido hialurónico");
  contiene(d.textos, "20 €)");
  contiene(d.textos, "KIT-ÑANDÚ");
  await Deno.writeFile(`${MUESTRAS}/5-descripcion-larga.pdf`, d.pdf);
});

Deno.test("QR: la matriz dibujada decodifica exactamente a urlQr (jsQR)", async () => {
  const d = await generarKudeDetalle(args(docBase(ITEMS_CF)));
  const { tamano: n, modulos } = d.qr;
  const esc = 4, quiet = 4;
  const lado = (n + 2 * quiet) * esc;
  const rgba = new Uint8ClampedArray(lado * lado * 4).fill(255);
  for (let r = 0; r < n; r++) {
    for (let c = 0; c < n; c++) {
      if (!modulos[r * n + c]) continue;
      for (let dy = 0; dy < esc; dy++) {
        for (let dx = 0; dx < esc; dx++) {
          const px = ((r + quiet) * esc + dy) * lado + (c + quiet) * esc + dx;
          rgba[px * 4] = rgba[px * 4 + 1] = rgba[px * 4 + 2] = 0;
        }
      }
    }
  }
  const res = jsQR(rgba, lado, lado);
  assert(res, "jsQR no pudo leer el QR");
  assertEquals(res.data, URL_QR);
});

Deno.test("generarKude (contrato) devuelve Uint8Array con %PDF", async () => {
  const pdf = await generarKude(args(docBase(ITEMS_CF)));
  assert(pdf instanceof Uint8Array);
  assertEquals(new TextDecoder().decode(pdf.slice(0, 4)), "%PDF");
});

Deno.test("multi-producto ficticio: 2 productos distintos + envío 33.000 + descuento", async () => {
  const items = [
    item("PROD-A", "Producto ficticio A", 1, 129000, { descuentoUnitario: 9000 }),
    item("PROD-B", "Producto ficticio B", 1, 99000, { descuentoUnitario: 9000 }),
    item("ENVIO", "Envío", 1, 33000),
  ];
  const tot = totalesDe(items);
  assertEquals(tot.total, 120000 + 90000 + 33000); // = total_price del pedido ficticio
  const d = await generarKudeDetalle(args(docBase(items)));
  for (const t of ["PROD-A", "PROD-B", "ENVIO", "120.000", "90.000", "33.000", "243.000", formatoGs(tot.iva10), "18.000"]) {
    contiene(d.textos, t);
  }
});

Deno.test("multi-producto ficticio: 3 productos distintos + envío + descuento", async () => {
  const items = [
    item("PROD-A", "Producto ficticio A", 2, 129000, { descuentoUnitario: 14500 }),
    item("PROD-B", "Producto ficticio B", 1, 99000),
    item("PROD-C", "Producto ficticio C", 1, 59000, { descuentoUnitario: 5000 }),
    item("ENVIO", "Envío", 1, 33000),
  ];
  const tot = totalesDe(items);
  assertEquals(tot.total, 229000 + 99000 + 54000 + 33000);
  const d = await generarKudeDetalle(args(docBase(items)));
  for (const t of ["PROD-C", "229.000", "54.000", "415.000", formatoGs(tot.iva10), formatoGs(tot.descuentoTotal)]) {
    contiene(d.textos, t);
  }
});
