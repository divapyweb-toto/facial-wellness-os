// _shared/sifen/totales.ts · IVA por ítem y totales del DE (precios con IVA incluido).
// Fuentes (Manual Técnico SIFEN v150 + NT vigentes):
//  - E727 dTotBruOpeItem = E721 * E711.
//  - EA008 dTotOpeItem = (E721 – EA002 – EA004 – EA006 – EA007) * E711 (D013 = 1). Autofactura (C002=4): E721 * E711.
//  - EA003 dPorcDesIt = EA002 * 100 / E721 (solo si EA002 > 0).
//  - E733 dPropIVA: % gravado (100 gravado, 0 exento/exonerado).
//  - E735 dBasGravIVA = [EA008 * (E733/100)] / 1,1 (10 %) o / 1,05 (5 %); 0 si E731 = 2 o 3.
//  - E736 dLiqIVAItem = E735 * (E734/100); 0 si E731 = 2 o 3.
//  - E737 dBasExe (NT 13): 0 si E731 = 1, 2 o 3; fórmula propia si E731 = 4 (no soportado aquí).
//  - F002/F003/F004/F005 subtotales por afectación y tasa (suma de EA008); F008 = F002+F003+F004+F005.
//  - F009 dTotDesc = Σ EA002 * E711; F011 dDescTotal = descuento particular + global; F013 dRedon = 0.
//  - F014 dTotGralOpe = F008 – F013 + F025 (definición del campo). [VERIFICAR] la regla de validación
//    F014 del MT dice "F008–F011–F012–F013"; como EA008 ya viene neto de descuentos, restar F011 de nuevo
//    descontaría dos veces. Seguimos la definición del campo (y la práctica de emisores aprobados).
//  - F015/F016 = Σ E736 por tasa; F017 = F015 + F016; F018/F019 = Σ E735 por tasa; F020 = F018 + F019.
//  - Redondeo (MT, grupo F): "para cualquier cálculo que contenga decimales, las reglas de validación
//    aceptarán redondeos de 50 céntimos (por encima o por debajo)".
//
// Decisión de redondeo para PYG (0 decimales):
//  - Por ítem se informa la fórmula exacta con hasta 8 decimales (tipo tMontoBase del XSD admite 8).
//  - Los totales F0xx en PYG se redondean a entero (half-up). IVA total = round(Σ E736) y la base total
//    = subtotal gravado – IVA total, así base + IVA = subtotal exacto y la diferencia con Σ E735 queda ≤ 0,5.
//  [VERIFICAR] en el ambiente de test de SIFEN con un pedido real de varios ítems.

import type { ItemDE, TipoDE, TotalesDE } from "./tipos.ts";

/** Redondeo half-up a `dec` decimales sin errores típicos de binario (1.005 → 1.01). */
export function redondear(valor: number, dec = 0): number {
  if (!Number.isFinite(valor)) throw new Error(`Monto no numérico: ${valor}.`);
  const signo = valor < 0 ? -1 : 1;
  const abs = Math.abs(valor);
  const r = Number(Math.round(Number(`${abs}e${dec}`)) + `e-${dec}`);
  return signo * r;
}

/** Formato numérico del XML: punto decimal, sin exponente, hasta 8 decimales, sin ceros sobrantes. */
export function numXml(valor: number, maxDec = 8): string {
  if (!Number.isFinite(valor)) throw new Error(`Monto no numérico: ${valor}.`);
  const s = redondear(valor, maxDec).toFixed(maxDec);
  const t = s.includes(".") ? s.replace(/0+$/, "").replace(/\.$/, "") : s;
  return t === "-0" ? "0" : t;
}

export const DESCRIPCION_AFECTACION_IVA: Record<number, string> = {
  // E732 dDesAfecIVA, valores exactos del XSD DE_Types_v150.xsd (tdDesAfecIVA).
  1: "Gravado IVA",
  2: "Exonerado (Art. 100 - Ley 6380/2019)",
  3: "Exento",
  4: "Gravado parcial (Grav- Exento)",
};

export interface ItemCalculado {
  item: ItemDE;
  precioUnitario: number; // E721
  cantidad: number; // E711
  totalBruto: number; // E727
  descuentoUnitario: number; // EA002
  porcentajeDescuento: number; // EA003
  totalOperacion: number; // EA008
  afectacion: 1 | 2 | 3 | 4; // E731
  proporcionIva: number; // E733
  tasaIva: 0 | 5 | 10; // E734
  baseGravada: number; // E735 (8 decimales)
  liquidacionIva: number; // E736 (8 decimales)
  baseExenta: number; // E737 (NT 13)
}

export interface ResultadoTotales {
  items: ItemCalculado[];
  totales: TotalesDE;
  /** Campos F del grupo gTotSub ya redondeados según moneda (PYG = 0 decimales). */
  campos: {
    dSubExe: number; dSubExo: number; dSub5: number; dSub10: number;
    dTotOpe: number; dTotDesc: number; dTotDescGlotem: number; dTotAntItem: number; dTotAnt: number;
    dPorcDescTotal: number; dDescTotal: number; dAnticipo: number; dRedon: number; dTotGralOpe: number;
    dIVA5: number; dIVA10: number; dLiqTotIVA5: number; dLiqTotIVA10: number; dTotIVA: number;
    dBaseGrav5: number; dBaseGrav10: number; dTBasGraIVA: number;
  };
}

function validarItem(it: ItemDE, i: number, tipo: TipoDE, moneda: string): void {
  const n = `Ítem ${i + 1} ("${it?.descripcion ?? ""}")`;
  if (!it || typeof it !== "object") throw new Error(`Ítem ${i + 1}: dato vacío.`);
  if (!(typeof it.cantidad === "number" && Number.isFinite(it.cantidad) && it.cantidad > 0)) {
    throw new Error(`${n}: la cantidad debe ser mayor a 0.`);
  }
  if (redondear(it.cantidad, 8) !== it.cantidad) throw new Error(`${n}: la cantidad admite hasta 8 decimales (E711).`);
  const precioObligatorio = tipo !== 7; // en la nota de remisión no se informan precios (E720 no se informa si C002=7)
  if (precioObligatorio) {
    if (!(typeof it.precioUnitario === "number" && Number.isFinite(it.precioUnitario) && it.precioUnitario > 0)) {
      throw new Error(`${n}: el precio unitario debe ser mayor a 0.`);
    }
    if (moneda === "PYG" && !Number.isInteger(it.precioUnitario)) {
      throw new Error(`${n}: en guaraníes el precio unitario debe ser entero (sin decimales).`);
    }
    const desc = it.descuentoUnitario ?? 0;
    if (!(Number.isFinite(desc) && desc >= 0)) throw new Error(`${n}: el descuento no puede ser negativo.`);
    if (desc >= it.precioUnitario) throw new Error(`${n}: el descuento (${desc}) debe ser menor al precio unitario (${it.precioUnitario}).`);
    if (moneda === "PYG" && !Number.isInteger(desc)) throw new Error(`${n}: en guaraníes el descuento debe ser entero.`);
    if (tipo === 4 && desc > 0) throw new Error(`${n}: la autofactura no admite descuentos (EA008 = E721 * E711 para C002=4).`);
  }
  if (tipo === 4 || tipo === 7) return; // gCamIVA no se informa en autofactura ni remisión (E730)
  if (![1, 2, 3, 4].includes(it.ivaAfectacion)) throw new Error(`${n}: afectación de IVA inválida (${it.ivaAfectacion}).`);
  if (it.ivaAfectacion === 4) {
    throw new Error(`${n}: "Gravado parcial" (iAfecIVA=4) no está soportado: requiere proporción gravada (E733) que el contrato no trae.`);
  }
  if (it.ivaAfectacion === 1 && it.ivaTasa !== 5 && it.ivaTasa !== 10) {
    throw new Error(`${n}: un ítem gravado debe tener tasa 5 o 10 (E734).`);
  }
  if ((it.ivaAfectacion === 2 || it.ivaAfectacion === 3) && it.ivaTasa !== 0) {
    throw new Error(`${n}: un ítem exento o exonerado debe tener tasa 0 (E734).`);
  }
}

/** Calcula los valores por ítem (grupos gValorItem/gValorRestaItem/gCamIVA). */
export function calcularItem(it: ItemDE, tipo: TipoDE = 1): ItemCalculado {
  const precio = it.precioUnitario ?? 0;
  const cantidad = it.cantidad;
  const desc = tipo === 4 ? 0 : (it.descuentoUnitario ?? 0);
  const totalBruto = redondear(precio * cantidad, 8); // E727
  const totalOperacion = redondear((precio - desc) * cantidad, 8); // EA008
  const porcentajeDescuento = desc > 0 ? redondear((desc * 100) / precio, 8) : 0; // EA003
  const afectacion = it.ivaAfectacion;
  const gravado = afectacion === 1;
  const tasa: 0 | 5 | 10 = gravado ? it.ivaTasa : 0;
  const proporcionIva = gravado ? 100 : 0; // E733
  let baseGravada = 0;
  let liquidacionIva = 0;
  if (gravado && tipo !== 4 && tipo !== 7) {
    const divisor = tasa === 10 ? 1.1 : 1.05; // E735
    baseGravada = redondear((totalOperacion * (proporcionIva / 100)) / divisor, 8);
    liquidacionIva = redondear(baseGravada * (tasa / 100), 8); // E736
  }
  return {
    item: it,
    precioUnitario: precio,
    cantidad,
    totalBruto,
    descuentoUnitario: desc,
    porcentajeDescuento,
    totalOperacion,
    afectacion,
    proporcionIva,
    tasaIva: tasa,
    baseGravada,
    liquidacionIva,
    baseExenta: 0, // E737: 0 para E731 = 1, 2, 3 (NT 13)
  };
}

/**
 * Calcula ítems y totales del DE. `tipo` cambia reglas: autofactura (4) sin IVA ni descuentos;
 * remisión (7) sin valores (los totales quedan informativos).
 */
export function calcularTotales(items: ItemDE[], tipo: TipoDE = 1, moneda: "PYG" = "PYG"): ResultadoTotales {
  if (moneda !== "PYG") throw new Error(`Moneda no soportada: ${moneda}. Solo PYG.`);
  if (!Array.isArray(items) || items.length === 0) throw new Error("El documento debe tener al menos 1 ítem.");
  if (items.length > 999) throw new Error("El documento admite como máximo 999 ítems (gCamItem 1-999).");
  items.forEach((it, i) => validarItem(it, i, tipo, moneda));
  const calc = items.map((it) => calcularItem(it, tipo));
  const decTot = moneda === "PYG" ? 0 : 8; // PYG sin decimales
  const suma = (f: (c: ItemCalculado) => number, filtro: (c: ItemCalculado) => boolean = () => true) =>
    calc.filter(filtro).reduce((a, c) => a + f(c), 0);

  const esAF = tipo === 4;
  const sub10 = esAF ? 0 : redondear(suma((c) => c.totalOperacion, (c) => c.afectacion === 1 && c.tasaIva === 10), decTot);
  const sub5 = esAF ? 0 : redondear(suma((c) => c.totalOperacion, (c) => c.afectacion === 1 && c.tasaIva === 5), decTot);
  const subExe = esAF ? 0 : redondear(suma((c) => c.totalOperacion, (c) => c.afectacion === 3), decTot);
  const subExo = esAF ? 0 : redondear(suma((c) => c.totalOperacion, (c) => c.afectacion === 2), decTot);
  const totOpe = esAF ? redondear(suma((c) => c.totalOperacion), decTot) : sub10 + sub5 + subExe + subExo; // F008
  const totDesc = redondear(suma((c) => c.descuentoUnitario * c.cantidad), decTot); // F009
  const descTotal = totDesc; // F011 (sin descuento global por ítem)
  const redon = 0; // F013 (precios ya en guaraníes enteros)
  const totGral = totOpe - redon; // F014 = F008 – F013 + F025 (sin comisión)

  const iva10 = esAF ? 0 : redondear(suma((c) => c.liquidacionIva, (c) => c.tasaIva === 10), decTot); // F016
  const iva5 = esAF ? 0 : redondear(suma((c) => c.liquidacionIva, (c) => c.tasaIva === 5), decTot); // F015
  const base10 = esAF ? 0 : sub10 - iva10; // F019 (≈ Σ E735, dif ≤ 0,5)
  const base5 = esAF ? 0 : sub5 - iva5; // F018
  const totIva = iva5 + iva10; // F017

  const totales: TotalesDE = {
    total: totGral,
    totalIva: totIva,
    iva10,
    iva5,
    base10,
    base5,
    gravado10: sub10,
    gravado5: sub5,
    exento: subExe,
    exonerado: subExo,
    descuentoTotal: descTotal,
  };
  return {
    items: calc,
    totales,
    campos: {
      dSubExe: subExe, dSubExo: subExo, dSub5: sub5, dSub10: sub10,
      dTotOpe: totOpe, dTotDesc: totDesc, dTotDescGlotem: 0, dTotAntItem: 0, dTotAnt: 0,
      dPorcDescTotal: 0, dDescTotal: descTotal, dAnticipo: 0, dRedon: redon, dTotGralOpe: totGral,
      dIVA5: iva5, dIVA10: iva10, dLiqTotIVA5: 0, dLiqTotIVA10: 0, dTotIVA: totIva,
      dBaseGrav5: base5, dBaseGrav10: base10, dTBasGraIVA: base5 + base10,
    },
  };
}
