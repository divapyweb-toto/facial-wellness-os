// _shared/texto_courier.ts · 10-10: mensaje listo para reenviar al courier (Lucero / Punto a Punto) desde Telegram.
// La API no puede entrar al grupo del courier: el sistema arma el texto y Enrique lo reenvía con 2 toques.
import { escaparHtml } from "./telegram_formato.ts";

export type DatosCourier = {
  pedido: string;
  nombre: string;
  telefono: string | null;
  direccion: string;
  referencia?: string | null;
  ciudad: string;
  ubicacion?: string | null; // "lat,lng"
  total: number | null;
  pagado?: boolean;
};

const gs = (n: number) => Math.round(n).toString().replace(/\B(?=(\d{3})+(?!\d))/g, ".");
const telLocal = (t: string | null) => (t ? t.replace(/^\+595/, "0") : "sin teléfono");

/** Datos desde el pedido guardado (shopify_pedidos.raw, formato del webhook REST o de GraphQL). */
export function datosCourierDesdeRaw(nombrePedido: string, raw: Record<string, unknown> | null | undefined, telefono: string | null): DatosCourier {
  const r = raw ?? {};
  const a = (r.shipping_address ?? r.shippingAddress ?? {}) as Record<string, unknown>;
  const s = (x: unknown) => (typeof x === "string" && x.trim() ? x.trim() : "");
  const nombre = s(a.name) || [s(a.first_name ?? a.firstName), s(a.last_name ?? a.lastName)].filter(Boolean).join(" ") || "Cliente";
  const lat = Number(a.latitude), lng = Number(a.longitude);
  const nota = s(r.note);
  const pinNota = /Ubicaci[oó]n:\s*(-?\d+\.\d+)\s*,\s*(-?\d+\.\d+)/.exec(nota);
  const ubicacion = pinNota ? `${pinNota[1]},${pinNota[2]}` : Number.isFinite(lat) && Number.isFinite(lng) && lat !== 0 ? `${lat},${lng}` : null;
  const fin = s(r.financial_status ?? r.displayFinancialStatus).toLowerCase();
  return {
    pedido: nombrePedido,
    nombre,
    telefono,
    direccion: s(a.address1) || "sin dirección",
    referencia: s(a.address2) || null,
    ciudad: s(a.city) || "?",
    ubicacion,
    total: Number(r.total_price ?? NaN) || null,
    pagado: fin === "paid",
  };
}

/** Texto plano para el courier. `pedido`: qué se le pide ("Volver a intentar la entrega…"). */
export function textoParaCourier(d: DatosCourier, pedido: string): string {
  const l = [
    `Hola, buenas. Pedido ${d.pedido} de Voltra:`,
    pedido,
    `Cliente: ${d.nombre} · ${telLocal(d.telefono)}`,
    `Dirección: ${[d.direccion, d.referencia].filter(Boolean).join(", ")}, ${d.ciudad}`,
  ];
  if (d.ubicacion) l.push(`Ubicación: https://maps.google.com/?q=${d.ubicacion.replace(/\s/g, "")}`);
  l.push(d.pagado ? "YA PAGADO: no cobrar." : d.total ? `Cobrar Gs ${gs(d.total)}.` : "Cobrar el total del pedido.");
  l.push("Por favor contactar al cliente antes de salir. Gracias!");
  return l.join("\n");
}

const NOMBRE: Record<string, string> = { lucero: "Lucero", pap: "Punto a Punto" };

/** Aviso de Telegram (HTML) con el texto en un bloque fácil de copiar. */
export function avisoParaCourier(d: DatosCourier, pedido: string, courier: string | null | undefined): string {
  const quien = NOMBRE[String(courier ?? "").toLowerCase()] ?? "el courier";
  return `📦 <b>Para reenviar a ${escaparHtml(quien)}</b> (${escaparHtml(d.pedido)}):\n<pre>${escaparHtml(textoParaCourier(d, pedido))}</pre>`;
}
