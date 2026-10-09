// _shared/sifen/cdc.ts · Código de Control (CDC) de 44 dígitos, dígito verificador módulo 11
// y código de seguridad (dCodSeg).
// Fuentes:
//  - Manual Técnico SIFEN v150 (DNIT), sección 10.1 "Estructura del código de control (CDC) de los DE",
//    10.2 "Dígito verificador del CDC" (módulo 11) y 10.3 "Generación del código de seguridad".
//  - Campo A002 (Id del DE): "cuando un RUC contenga letras, para el cálculo del DV y la generación
//    del CDC se realizará la conversión de dicha letra por su valor en código ASCII".
//  - Algoritmo módulo 11 de la SET/DNIT (documento "digito-verificador.pdf", baseMax = 11),
//    el mismo que se usa para el DV del RUC (campos D102, D207, E625, E984: "Según algoritmo módulo 11").
//  - Ejemplo oficial del MT (sección 10.1): CDC 01444444017001001001452822017012515873260988.

import type { TipoDE, TipoEmision } from "./tipos.ts";

/**
 * Dígito verificador módulo 11 (algoritmo oficial SET/DNIT, baseMax 11).
 * Las letras se reemplazan por su código ASCII (en mayúscula) antes de calcular.
 * Pesos 2..baseMax desde la derecha, ciclando; resto = suma % 11; DV = resto > 1 ? 11 - resto : 0.
 */
export function dvModulo11(numero: string, baseMax = 11): number {
  const limpio = String(numero).trim().toUpperCase();
  if (!limpio) throw new Error("No se puede calcular el dígito verificador de un número vacío.");
  let digitos = "";
  for (const c of limpio) {
    if (c >= "0" && c <= "9") digitos += c;
    else digitos += String(c.charCodeAt(0)); // MT A002: letra → código ASCII
  }
  let k = 2;
  let total = 0;
  for (let i = digitos.length - 1; i >= 0; i--) {
    if (k > baseMax) k = 2;
    total += Number(digitos[i]) * k;
    k++;
  }
  const resto = total % 11;
  return resto > 1 ? 11 - resto : 0;
}

/** RUC sin DV: 3 a 8 caracteres, patrón del XSD tRuc ([1-9][0-9]*[0-9A-D]?). */
export function rucConFormatoValido(ruc: string): boolean {
  return /^[1-9][0-9]*[0-9A-D]?$/.test(ruc) && ruc.length >= 3 && ruc.length <= 8;
}

/** true si el DV corresponde al RUC según módulo 11 (MT D102/D207). */
export function validarRuc(ruc: string, dv: string | number): boolean {
  const r = String(ruc ?? "").trim().toUpperCase();
  const d = String(dv ?? "").trim();
  if (!rucConFormatoValido(r) || !/^[0-9]$/.test(d)) return false;
  return dvModulo11(r) === Number(d);
}

export interface DatosCdc {
  tipo: TipoDE; // iTiDE (C002) · 2 dígitos
  ruc: string; // dRucEm (D101) sin DV · se completa a 8 con ceros a la izquierda
  dv: string; // dDVEmi (D102) · 1 dígito
  establecimiento: string; // dEst (C005) · 3
  punto: string; // dPunExp (C006) · 3
  numero: number; // dNumDoc (C007) · 7
  tipoContribuyente: 1 | 2; // iTipCont (D103) · 1
  /** "AAAA-MM-DD..." (se toma la fecha de dFeEmiDE, D002) · AAAAMMDD = 8 */
  fechaEmision: string;
  tipoEmision: TipoEmision; // iTipEmi (B002) · 1
  codigoSeguridad: string; // dCodSeg (B004) · 9
}

/**
 * Arma el CDC (MT 10.1): iTiDE(2) + RUC(8) + DV(1) + establecimiento(3) + punto(3) + número(7)
 * + tipo contribuyente(1) + fecha AAAAMMDD(8) + tipo emisión(1) + código de seguridad(9) + DV(1) = 44.
 */
export function armarCdc(d: DatosCdc): string {
  if (![1, 4, 5, 6, 7].includes(d.tipo)) throw new Error(`CDC: tipo de documento inválido (${d.tipo}). Válidos: 1, 4, 5, 6, 7.`);
  const ruc = String(d.ruc ?? "").trim().toUpperCase();
  if (!rucConFormatoValido(ruc)) throw new Error(`CDC: RUC del emisor inválido ("${d.ruc}"). Debe tener 3 a 8 caracteres, sin DV.`);
  if (!validarRuc(ruc, d.dv)) throw new Error(`CDC: el DV ${d.dv} no corresponde al RUC ${ruc} (módulo 11 debería dar ${dvModulo11(ruc)}).`);
  if (!/^\d{3}$/.test(d.establecimiento)) throw new Error(`CDC: establecimiento inválido ("${d.establecimiento}"), deben ser 3 dígitos.`);
  if (!/^\d{3}$/.test(d.punto)) throw new Error(`CDC: punto de expedición inválido ("${d.punto}"), deben ser 3 dígitos.`);
  if (!Number.isInteger(d.numero) || d.numero < 1 || d.numero > 9999999) throw new Error(`CDC: número de documento inválido (${d.numero}), debe ser 1 a 9999999.`);
  if (d.tipoContribuyente !== 1 && d.tipoContribuyente !== 2) throw new Error(`CDC: tipo de contribuyente inválido (${d.tipoContribuyente}).`);
  const m = /^(\d{4})-(\d{2})-(\d{2})/.exec(d.fechaEmision ?? "");
  if (!m) throw new Error(`CDC: fecha de emisión inválida ("${d.fechaEmision}"), se espera AAAA-MM-DD.`);
  if (d.tipoEmision !== 1 && d.tipoEmision !== 2) throw new Error(`CDC: tipo de emisión inválido (${d.tipoEmision}).`);
  if (!/^\d{9}$/.test(d.codigoSeguridad)) throw new Error(`CDC: código de seguridad inválido ("${d.codigoSeguridad}"), deben ser 9 dígitos.`);

  const base = String(d.tipo).padStart(2, "0") +
    ruc.padStart(8, "0") +
    String(d.dv) +
    d.establecimiento +
    d.punto +
    String(d.numero).padStart(7, "0") +
    String(d.tipoContribuyente) +
    m[1] + m[2] + m[3] +
    String(d.tipoEmision) +
    d.codigoSeguridad;
  if (base.length !== 43) throw new Error(`CDC: largo inesperado (${base.length}) antes del DV.`);
  return base + String(dvModulo11(base));
}

/** true si el CDC tiene 44 caracteres válidos y su último dígito es el DV módulo 11 de los 43 anteriores. */
export function validarCdc(cdc: string): boolean {
  if (typeof cdc !== "string" || !/^[0-9]{2}[0-9]{7}[0-9A-D][0-9]{34}$/.test(cdc)) return false; // XSD tCDC
  return dvModulo11(cdc.slice(0, 43)) === Number(cdc[43]);
}

/** dDVId (A003): dígito verificador del identificador del DE = último dígito del CDC. */
export function dvDelCdc(cdc: string): string {
  if (!validarCdc(cdc)) throw new Error(`CDC inválido: "${cdc}".`);
  return cdc[43];
}

/** Representación para el KuDE (MT 10.1): grupos de 4 caracteres separados por espacio. */
export function formatearCdcKude(cdc: string): string {
  return (cdc.match(/.{1,4}/g) ?? []).join(" ");
}

/**
 * dCodSeg (MT 10.3): 9 dígitos, aleatorio criptográfico, rango 000000001–999999999,
 * completado con ceros a la izquierda. Si se pasa `numeroDocumento`, se garantiza que no sea igual
 * al número de documento (dNumDoc) como exige el MT.
 */
export function codigoSeguridad(numeroDocumento?: number): string {
  const buf = new Uint32Array(1);
  for (;;) {
    crypto.getRandomValues(buf);
    // 2^32 = 4294967296; descartamos el sesgo quedándonos con < 3_999_999_996 (múltiplo de 999_999_999).
    if (buf[0] >= 3_999_999_996) continue;
    const n = (buf[0] % 999_999_999) + 1; // 1..999999999
    const s = String(n).padStart(9, "0");
    if (numeroDocumento !== undefined && s === String(numeroDocumento).padStart(9, "0")) continue;
    return s;
  }
}
