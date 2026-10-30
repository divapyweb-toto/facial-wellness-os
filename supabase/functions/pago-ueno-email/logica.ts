// pago-ueno-email/logica.ts · 29-10. Puro: lee el texto plano del correo "Transferencia recibida" de ueno bank.
// Dos formatos vistos en voltraparaguay@gmail.com:
//   A) ueno → ueno: Monto, Titular cuenta débito, Entidad débito, Beneficiario, Nro. de transacción, Fecha y hora.
//   B) otro banco → ueno: Monto, Entidad pagadora, Mensaje, Fecha y hora (sin titular ni nro.).

export interface AvisoUeno {
  monto: number;
  /** ISO con zona de Asunción (−03:00). */
  fecha: string;
  titular?: string;
  banco?: string;
  nro_transaccion?: string;
}

const limpiar = (t: string) => t.replace(/\[[^\]]*\]\([^)]*\)/g, " ").replace(/[|#*]/g, " ").replace(/[ \t]+/g, " ");

function campo(texto: string, etiqueta: RegExp, siguientes: string[]): string | undefined {
  const m = etiqueta.exec(texto);
  if (!m) return undefined;
  let resto = texto.slice(m.index + m[0].length);
  const corte = resto.split("\n")[0];
  resto = corte;
  for (const s of siguientes) {
    const i = resto.indexOf(s);
    if (i >= 0) resto = resto.slice(0, i);
  }
  const v = resto.trim();
  return v || undefined;
}

const ETIQUETAS = ["Monto", "Titular cuenta débito", "Entidad débito", "Beneficiario", "Entidad beneficiario", "Entidad pagadora", "Mensaje", "Nro. de transacción", "Fecha y hora transferencia"];

/** null si no es un aviso de transferencia recibida o le falta monto/fecha. */
export function parsearAvisoUeno(cuerpo: string): AvisoUeno | null {
  const t = limpiar(cuerpo ?? "");
  if (!/Recibiste una transferencia/i.test(t)) return null;
  const montoTxt = /Monto\s+Gs\.?\s*([\d.]+)/i.exec(t)?.[1];
  const f = /Fecha y hora transferencia\s+(\d{2})\/(\d{2})\/(\d{4})\s+(\d{2}):(\d{2})(?::(\d{2}))?/i.exec(t);
  if (!montoTxt || !f) return null;
  const monto = Number(montoTxt.replace(/\./g, ""));
  if (!Number.isFinite(monto) || monto <= 0) return null;
  const fecha = `${f[3]}-${f[2]}-${f[1]}T${f[4]}:${f[5]}:${f[6] ?? "00"}-03:00`;
  const otros = (e: string) => ETIQUETAS.filter((x) => x !== e);
  const titular = campo(t, /Titular cuenta débito\s+/i, otros("Titular cuenta débito"));
  const banco = campo(t, /Entidad (?:débito|pagadora)\s+/i, otros("Entidad débito"));
  const nro = /Nro\.? de transacción\s+(\d{3,})/i.exec(t)?.[1];
  return { monto, fecha, ...(titular ? { titular } : {}), ...(banco ? { banco } : {}), ...(nro ? { nro_transaccion: nro } : {}) };
}
