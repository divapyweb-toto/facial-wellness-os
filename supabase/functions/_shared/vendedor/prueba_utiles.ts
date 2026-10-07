// Dobles de prueba del vendedor (solo los usan los *_test.ts). Datos inventados: repo público.
import { armarConfigTurno } from "./config.ts";
import { revisarRespuesta } from "./filtro_salida.ts";
import type { ConfigTurno, CtxTurno, DepsHerramientas, PedidoChat, PedidoCliente, ProductoShopify } from "./tipos.ts";

export const TEL = "+595981000000";
export const CONV = "11111111-1111-4111-8111-111111111111";
export const CLIENTE = "22222222-2222-4222-8222-222222222222";

export const PRODUCTOS: ProductoShopify[] = [
  {
    id: "gid://shopify/Product/1",
    handle: "tiras-prueba",
    title: "Tiras Nasales de prueba",
    imagen: "https://cdn.example.com/tiras.jpg",
    variantes: [{ id: "gid://shopify/ProductVariant/11", title: "Default Title", price: 79000, disponible: true }],
  },
  {
    id: "gid://shopify/Product/2",
    handle: "raspador-prueba",
    title: "Raspador de prueba",
    imagen: "https://cdn.example.com/raspador.jpg",
    variantes: [{ id: "gid://shopify/ProductVariant/21", title: "Default Title", price: 79000, disponible: true }],
  },
];

export function configPrueba(extra: Record<string, unknown> = {}): ConfigTurno {
  return armarConfigTurno({
    vendedor: { modelo: "claude-haiku-4-5-20251001", espera_agrupar_s: 0, whatsapp_enrique: "595990000000" },
    vendedor_envio: { costo_gs: 33000, plazo: "2 a 5 días hábiles" },
    vendedor_glosario: [{ escribe: "katu", significa: "dale", accion: "cerrar" }],
    vendedor_fichas: {},
    vendedor_afirmaciones: ["Pagás al recibir", "Cualquier problema lo vemos por acá caso por caso"],
    vendedor_ofertas: { "tiras-prueba": { "2": 125000, "3": 155000 } },
    vendedor_media: { "tiras-prueba": { video: "https://cdn.example.com/tiras.mp4" } },
    vendedor_textos: {},
    aceptaciones: ["si", "sí", "ok", "dale", "ya", "katu", "confirmo"],
    palabras_prohibidas: ["garantía", "devolución", "reembolso", "sin riesgo", "cura", "curar", "tratamiento", "oxígeno"],
    ...extra,
  }).cfg;
}

export function ctxPrueba(over: Partial<CtxTurno> = {}, permitidos: number[] = [33000]): CtxTurno {
  const cfg = over.cfg ?? configPrueba();
  return {
    conversacionId: CONV,
    clienteId: CLIENTE,
    destino: TEL,
    telefono: TEL,
    waUserId: "PY.1234567890",
    nombreCliente: "Ana Prueba",
    textoEntrada: "hola",
    mensajeEntradaId: "wamid.IN1",
    ahora: new Date("2026-10-06T15:00:00Z"),
    cfg,
    revisar: (t) => revisarRespuesta(t, { catalogo: permitidos, prohibidas: cfg.prohibidas, afirmaciones: cfg.afirmaciones }),
    ...over,
  };
}

export type Registro = {
  catalogoLlamadas: number;
  textos: { to: string; texto: string }[];
  interactivos: { to: string; interactive: Record<string, unknown> }[];
  medias: { tipo: string; link: string; caption: string | null }[];
  avisos: { texto: string; botones?: unknown }[];
  pedidosChat: PedidoChat[];
  ordenes: Record<string, unknown>[];
  releasit: Record<string, unknown>[];
  humano: string[];
  avanzarReloj: (ms: number) => void;
};

export function depsPrueba(over: Partial<DepsHerramientas> = {}, pedidos: PedidoCliente[] = []): { deps: DepsHerramientas; reg: Registro } {
  let n = 0;
  let reloj = 1_000_000;
  const reg: Registro = {
    catalogoLlamadas: 0, textos: [], interactivos: [], medias: [], avisos: [], pedidosChat: [], ordenes: [], releasit: [], humano: [],
    avanzarReloj: (ms) => {
      reloj += ms;
    },
  };
  const deps: DepsHerramientas = {
    catalogoShopify: () => {
      reg.catalogoLlamadas++;
      return Promise.resolve(PRODUCTOS);
    },
    pedidosDeCliente: () => Promise.resolve(pedidos),
    guardarPedidoChat: (fila) => {
      const existente = fila.id ? reg.pedidosChat.find((p) => p.id === fila.id) : undefined;
      if (existente) {
        Object.assign(existente, fila);
        return Promise.resolve(existente);
      }
      const nueva: PedidoChat = { ...fila, id: `pc-${++n}`, creado_en: "2026-10-06T14:59:00Z" } as PedidoChat;
      reg.pedidosChat.push(nueva);
      return Promise.resolve(nueva);
    },
    ultimoPedidoChat: () => Promise.resolve(reg.pedidosChat[reg.pedidosChat.length - 1] ?? null),
    crearOrdenShopify: (input) => {
      reg.ordenes.push(input);
      return Promise.resolve({ ok: true, shopify_order_id: 5550001, gid: "gid://shopify/Order/5550001", nombre: "#1050", total: 112000, nodo: { id: "gid://shopify/Order/5550001" } });
    },
    registrarComoReleasit: (nodo) => (reg.releasit.push(nodo), Promise.resolve()),
    pasarAHumano: (id) => (reg.humano.push(id), Promise.resolve()),
    avisar: (texto, botones) => (reg.avisos.push({ texto, botones }), Promise.resolve({ ok: true })),
    enviarTexto: (to, texto) => (reg.textos.push({ to, texto }), Promise.resolve({ ok: true, wa_message_id: `wamid.OUT${reg.textos.length}` })),
    enviarInteractivo: (to, interactive) => (reg.interactivos.push({ to, interactive }), Promise.resolve({ ok: true, wa_message_id: "wamid.INT" })),
    enviarMedia: (_to, tipo, link, caption) => (reg.medias.push({ tipo, link, caption }), Promise.resolve({ ok: true })),
    normalizarTelefono: (x) => (x.startsWith("+595") ? x : null),
    ahoraMs: () => reloj,
    ...over,
  };
  return { deps, reg };
}
