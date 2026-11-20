// shopify-webhook · bloqueo de pedidos falsos (20-11-2026). La noche del 19-11 entraron 16 pedidos de broma por el formulario
// de Releasit. Enrique: "entraron muchisimos pedidos falsos investiga a fondo entre las 21 y 00:00 y bloquea denuncia etc".
// Lista en config.bloqueo_pedidos (JSON, fuera del repo: el repo es público):
//   { "telefonos":     [{ "v": "5959…", "hasta": null | "AAAA-MM-DD", "motivo": "…" } | "5959…"],
//     "ips":           [{ "v": "1.2.3.4", "hasta": "AAAA-MM-DD" }],          // IPv4 exacta (puede ser compartida: con vencimiento)
//     "prefijos_ipv6": [{ "v": "2803:abcd:1:2", "hasta": null }] }            // primeros 4 bloques = /64
// Un pedido que coincide se cancela solo en Shopify (FRAUD, sin avisar al cliente, devuelve stock), no recibe la
// confirmación por WhatsApp, no va a Meta ni al despacho, y a Enrique le llega un Telegram por día.
type Dict = Record<string, unknown>;
const obj = (x: unknown): Dict => (x && typeof x === "object" ? x as Dict : {});

export interface EntradaBloqueo { v: string; hasta: string | null; motivo: string | null }
export interface ListaBloqueo { telefonos: EntradaBloqueo[]; ips: EntradaBloqueo[]; prefijosIpv6: EntradaBloqueo[] }
export const LISTA_VACIA: ListaBloqueo = { telefonos: [], ips: [], prefijosIpv6: [] };
export const CLAVE_CONFIG_BLOQUEO = "bloqueo_pedidos";

function entradas(x: unknown): EntradaBloqueo[] {
  if (!Array.isArray(x)) return [];
  return x.flatMap((e) => {
    if (typeof e === "string" && e.trim()) return [{ v: e.trim(), hasta: null, motivo: null }];
    const o = obj(e), v = typeof o.v === "string" ? o.v.trim() : "";
    if (!v) return [];
    const hasta = typeof o.hasta === "string" && /^\d{4}-\d{2}-\d{2}$/.test(o.hasta) ? o.hasta : null;
    return [{ v, hasta, motivo: typeof o.motivo === "string" ? o.motivo : null }];
  });
}

/** config.valor (texto JSON o ya parseado) → lista. Ilegible = lista vacía (nunca bloquea por error de carga). */
export function listaBloqueoDesde(valor: unknown): ListaBloqueo {
  let v = valor;
  if (typeof v === "string") { try { v = JSON.parse(v); } catch { return LISTA_VACIA; } }
  const o = obj(v);
  return { telefonos: entradas(o.telefonos), ips: entradas(o.ips), prefijosIpv6: entradas(o.prefijos_ipv6) };
}

/** Día de Paraguay (UTC−3). */
const diaPy = (d: Date) => new Date(d.getTime() - 3 * 3_600_000).toISOString().slice(0, 10);
const vigente = (e: EntradaBloqueo, ahora: Date) => !e.hasta || diaPy(ahora) <= e.hasta;
const soloDigitos = (s: string) => s.replace(/\D/g, "");

/** IPv6 → 8 bloques en minúscula sin ceros a la izquierda (expande "::"). null si no es IPv6. */
export function bloquesIpv6(ip: string): string[] | null {
  const s = ip.trim().toLowerCase().replace(/%.*$/, "");
  if (!s.includes(":") || !/^[0-9a-f:.]+$/.test(s)) return null;
  const [izq, der, ...resto] = s.split("::");
  if (resto.length) return null;
  const a = izq ? izq.split(":") : [], b = der !== undefined ? (der ? der.split(":") : []) : null;
  const faltan = b === null ? 0 : 8 - a.length - b.length;
  const todos = b === null ? a : [...a, ...Array(Math.max(faltan, 0)).fill("0"), ...b];
  if (todos.length !== 8 || todos.some((x) => !/^[0-9a-f]{1,4}$/.test(x))) return null;
  return todos.map((x) => x.replace(/^0+(?=.)/, ""));
}
const prefijo64 = (p: string) => p.trim().toLowerCase().replace(/\/64$/, "").replace(/:+$/, "").split(":").slice(0, 4).map((x) => x.replace(/^0+(?=.)/, ""));
/** Atributos del pedido: note_attributes {name, value} (webhook) o customAttributes {key, value} (GraphQL, conciliación). */
const atributos = (r: Dict) => [
  ...(Array.isArray(r.note_attributes) ? r.note_attributes : []).map(obj).map((a) => ({ k: String(a.name ?? ""), v: String(a.value ?? "") })),
  ...(Array.isArray(r.customAttributes) ? r.customAttributes : []).map(obj).map((a) => ({ k: String(a.key ?? ""), v: String(a.value ?? "") })),
];

/** IPs del pedido: atributo de Releasit ("IP address"), browser_ip y client_details.browser_ip. */
export function ipsDelPedido(raw: unknown): string[] {
  const r = obj(raw);
  const attrs = atributos(r).filter((a) => /^ip\b/i.test(a.k)).map((a) => a.v);
  return [...attrs, String(r.browser_ip ?? ""), String(obj(r.client_details).browser_ip ?? "")].map((x) => x.trim()).filter(Boolean);
}

/** Teléfonos del pedido (crudos): phone, envío, facturación, cliente y atributos "Teléfono"/"Phone". */
export function telefonosDelPedido(raw: unknown): string[] {
  const r = obj(raw);
  const attrs = atributos(r).filter((a) => /tel[eé]fono|phone|celular|whatsapp/i.test(a.k)).map((a) => a.v);
  return [r.phone, obj(r.shipping_address).phone, obj(r.billing_address).phone, obj(r.customer).phone,
    obj(r.shippingAddress).phone, obj(r.customer).phone, ...attrs]
    .map((x) => String(x ?? "").trim()).filter(Boolean);
}

export interface CoincidenciaBloqueo { por: "telefono" | "ip" | "prefijo_ipv6"; valor: string; motivo: string | null }

/**
 * ¿El pedido coincide con la lista? `normalizar` = normalizarTelefonoPY (595…). Compara teléfonos por dígitos
 * normalizados, IPv4 exacta y IPv6 por los primeros 4 bloques (/64). Solo entradas vigentes (`hasta` incluido).
 */
export function coincideBloqueo(raw: unknown, lista: ListaBloqueo, ahora: Date, normalizar: (t: string) => string | null): CoincidenciaBloqueo | null {
  const tels = new Set(telefonosDelPedido(raw).map((t) => normalizar(t) ?? soloDigitos(t)).filter(Boolean).map(soloDigitos));
  for (const e of lista.telefonos) {
    if (!vigente(e, ahora)) continue;
    const n = soloDigitos(normalizar(e.v) ?? e.v);
    if (n && tels.has(n)) return { por: "telefono", valor: e.v, motivo: e.motivo };
  }
  const ips = ipsDelPedido(raw);
  for (const e of lista.ips) {
    if (vigente(e, ahora) && ips.includes(e.v)) return { por: "ip", valor: e.v, motivo: e.motivo };
  }
  const v6 = ips.map(bloquesIpv6).filter((b): b is string[] => !!b);
  for (const e of lista.prefijosIpv6) {
    if (!vigente(e, ahora)) continue;
    const p = prefijo64(e.v);
    if (p.length === 4 && v6.some((b) => b.slice(0, 4).join(":") === p.join(":"))) return { por: "prefijo_ipv6", valor: e.v, motivo: e.motivo };
  }
  return null;
}

export const TAG_BLOQUEADO = "BLOQUEADO_FRAUDE";
export const textoNotaBloqueo = (c: CoincidenciaBloqueo) =>
  `Cancelado automático: pedido en la lista de bloqueo (${c.por === "telefono" ? "teléfono" : c.por === "ip" ? "IP" : "prefijo IPv6"} ${c.valor})${c.motivo ? ` · ${c.motivo}` : ""}.`;
