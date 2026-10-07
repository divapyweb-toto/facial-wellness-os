// _shared/vendedor/interactivos.ts · Dueño: G1 (ola 2)
// Piezas puras que no están en _shared/wa_interactivos.ts (G2): el botón con enlace (cta_url) y el
// texto que ve el vendedor a partir de un mensaje entrante especial (ubicación, flow, contacto, botón...).
// Sin red ni base: se prueban con `deno test`.

export type Interactivo = Record<string, unknown> & { type: string };

const recortar = (s: string, n: number) => (s.length > n ? s.slice(0, n - 1) + "…" : s);

/**
 * Botón que abre un enlace (cta_url de Meta), por ejemplo wa.me de Enrique con el resumen ya escrito.
 * _shared/wa_interactivos.ts (G2) no lo trae; el resto de los interactivos sale de ahí.
 */
export function botonEnlace(texto: string, tituloBoton: string, url: string): Interactivo {
  return {
    type: "cta_url",
    body: { text: recortar(texto, 1024) },
    action: { name: "cta_url", parameters: { display_text: recortar(tituloBoton, 20), url } },
  };
}

// ---------- entrantes → texto para el vendedor ----------

type Dict = Record<string, unknown>;
const obj = (v: unknown): Dict => (v && typeof v === "object" ? v as Dict : {});
const str = (v: unknown): string | null => (typeof v === "string" && v.trim() ? v.trim() : null);

/** Objeto plano → "clave: valor · clave: valor" (sin claves técnicas). */
export function aTextoPlano(x: unknown): string {
  if (typeof x === "string") return x;
  if (!x || typeof x !== "object") return String(x ?? "");
  return Object.entries(x as Dict)
    .filter(([k, v]) => v !== null && v !== undefined && v !== "" && !/^(flow_token|wa_id|id)$/.test(k))
    .map(([k, v]) => `${k}: ${typeof v === "object" ? aTextoPlano(v) : String(v)}`)
    .join(" · ");
}

/**
 * Texto que recibe el vendedor por cada tipo de mensaje. Marcas: [ubicación], [formulario], [contacto],
 * [botón], [imagen], [video], [documento], [sticker]. Devuelve null si no hay nada que pasarle.
 */
export function textoDeEntrante(m: Dict): string | null {
  const tipo = String(m.type ?? "");
  switch (tipo) {
    case "text":
      return str(obj(m.text).body);
    case "location": {
      const l = obj(m.location);
      const partes = [
        l.latitude !== undefined && l.longitude !== undefined ? `${l.latitude},${l.longitude}` : null,
        str(l.name),
        str(l.address),
      ].filter(Boolean);
      return `[ubicación] ${partes.join(" · ")}`.trim();
    }
    case "contacts": {
      const c = (Array.isArray(m.contacts) ? m.contacts : []).map((x) => {
        const o = obj(x);
        const nombre = str(obj(o.name).formatted_name) ?? str(obj(o.name).first_name);
        const tel = (Array.isArray(o.phones) ? o.phones : []).map((p) => str(obj(p).phone) ?? str(obj(p).wa_id)).filter(Boolean)[0];
        return [nombre, tel].filter(Boolean).join(" ");
      }).filter(Boolean);
      return `[contacto] ${c.join(" | ")}`.trim();
    }
    case "interactive": {
      const i = obj(m.interactive);
      if (i.type === "nfm_reply") {
        const r = obj(i.nfm_reply);
        let datos: unknown = r.response_json;
        if (typeof datos === "string") {
          try {
            datos = JSON.parse(datos);
          } catch { /* queda el string */ }
        }
        return `[formulario] ${aTextoPlano(datos)}`.trim();
      }
      const br = obj(i.button_reply), lr = obj(i.list_reply);
      const titulo = str(br.title) ?? str(lr.title);
      const id = str(br.id) ?? str(lr.id);
      return titulo || id ? `[botón] ${titulo ?? ""}${id ? ` (${id})` : ""}`.trim() : null;
    }
    case "button": {
      const b = obj(m.button);
      return `[botón] ${str(b.text) ?? ""}${str(b.payload) ? ` (${str(b.payload)})` : ""}`.trim();
    }
    case "image":
    case "video":
    case "document":
    case "sticker": {
      const etiqueta: Record<string, string> = { image: "imagen", video: "video", document: "documento", sticker: "sticker" };
      const cap = str(obj(m[tipo]).caption);
      return `[${etiqueta[tipo]}]${cap ? ` ${cap}` : ""}`;
    }
    default:
      return null;
  }
}
