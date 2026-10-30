// Pruebas de email_factura.ts (guardar_email_factura y la pregunta del mail en guardar_factura). Sin red ni base.
// Datos inventados: repo público.
import { assert, assertEquals, assertFalse, assertMatch, assertStringIncludes } from "@std/assert";
import { EJECUTORES, HERRAMIENTAS } from "./herramientas.ts";
import {
  type DepsEmailFactura,
  debePreguntarEmail,
  elegirEmail,
  extraerEmails,
  type FacturaParaReenvio,
  guardarEmailFacturaHerr,
  PREGUNTA_EMAIL,
  sugerenciaTipeo,
  yaPreguntoEmail,
} from "./email_factura.ts";
import type { DepsPedidosWeb, PedidoWeb } from "./pedidos_web.ts";
import { digitoVerificadorRuc } from "../facturacion.ts";
import { CLIENTE, CONV, ctxPrueba, depsPrueba, TEL } from "./prueba_utiles.ts";
import type { CtxTurno, DepsHerramientas } from "./tipos.ts";

// ---------- dobles ----------

function pedido(over: Partial<PedidoWeb> = {}): PedidoWeb {
  return {
    shopify_order_id: 7000001,
    gid: "gid://shopify/Order/7000001",
    nombre: "#1072",
    creado_en: "2026-10-06T14:00:00Z",
    telefono: TEL,
    email: null,
    cliente_id: CLIENTE,
    nombre_cliente: "Ana Prueba",
    total: 112000,
    envio: 33000,
    cancelado: false,
    despachado: false,
    estado_confirmacion: "confirmado",
    app: "Releasit COD Form",
    merchant_editable: false,
    tags: ["CONFIRMADO"],
    atributos: [],
    nota: null,
    direccion: null,
    lineas: [],
    ...over,
  };
}

const FACTURA: FacturaParaReenvio = { id: "f-1", numero_completo: "001-001-0000123", total: 112000, kude_path: "kude/prueba.pdf" };

type Reg = {
  guardados: Array<{ id: number; email: string; conv: string }>;
  envios: Array<{ factura: FacturaParaReenvio; email: string; pedido: string; nombre: string | null }>;
  atributos: Array<{ gid: string }>;
  textosBot: string[];
};

function armar(o: {
  pedidos?: PedidoWeb[];
  tienda?: number | null;
  factura?: FacturaParaReenvio | null;
  envio?: { ok: boolean; simulado?: boolean; error?: string };
  guardarFalla?: string;
  emailConv?: string | null;
  estadoFalla?: boolean;
} = {}) {
  const reg: Reg = { guardados: [], envios: [], atributos: [], textosBot: [] };
  const pedidos = new Map((o.pedidos ?? [pedido()]).map((p) => [p.shopify_order_id, p]));
  const pw = {
    candidatos: (f: { numero?: number }) =>
      Promise.resolve([...pedidos.values()].filter((p) => !f.numero || p.nombre === `#${f.numero}`).map((p) => ({ ...p, conversacion_id: null }))),
    pedidoCompleto: (id: number) => Promise.resolve(pedidos.get(id) ?? null),
    vinculados: () => Promise.resolve([]),
    vincular: () => Promise.resolve(),
    actualizarAtributos: (gid: string) => (reg.atributos.push({ gid }), Promise.resolve({ ok: true })),
  } as unknown as DepsPedidosWeb;
  const ef: DepsEmailFactura = {
    guardar: (id, email, meta) => {
      if (o.guardarFalla) return Promise.resolve({ ok: false, error: o.guardarFalla });
      reg.guardados.push({ id, email, conv: meta.conversacionId });
      return Promise.resolve({ ok: true });
    },
    facturaAprobada: () => Promise.resolve(o.factura ?? null),
    enviarFactura: (a) => (reg.envios.push(a), Promise.resolve(o.envio ?? { ok: true })),
    estadoConversacion: () =>
      o.estadoFalla
        ? Promise.reject(new Error("base caída"))
        : Promise.resolve({ email: o.emailConv ?? (reg.guardados[0]?.email ?? null), textosBot: [...reg.textosBot] }),
  };
  const tienda = o.tienda === undefined ? 7000001 : o.tienda;
  const { deps, reg: regBase } = depsPrueba({
    pedidoTiendaAbierto: () => Promise.resolve(tienda ? { shopify_order_id: tienda, creado_en: "2026-10-06T14:00:00Z" } : null),
  });
  const d = { ...deps, pedidosWeb: pw, emailFactura: ef } as DepsHerramientas;
  return { deps: d, reg, avisos: regBase.avisos };
}

const ctx = (textoEntrada: string, over: Partial<CtxTurno> = {}) => ctxPrueba({ textoEntrada, ...over });
const guardarEmail = (i: Record<string, unknown>, c: CtxTurno, d: DepsHerramientas) => guardarEmailFacturaHerr.ejecutor(i, c, d);

// ---------- detección y validación ----------

Deno.test("email: detecta el correo en distintos textos", () => {
  assertEquals(extraerEmails("pasame por correo ana@x.com"), ["ana@x.com"]);
  assertEquals(extraerEmails("Mandámela al mail: Ana.Perez@Gmail.com."), ["ana.perez@gmail.com"]);
  assertEquals(extraerEmails("mi correo es ana @ hotmail.com gracias"), ["ana@hotmail.com"]);
  assertEquals(extraerEmails("<mailto:carlos_b@empresa.com.py>"), ["carlos_b@empresa.com.py"]);
  assertEquals(extraerEmails("¿me la mandás a ana+facturas@x.org?"), ["ana+facturas@x.org"]);
  assertEquals(extraerEmails("ana@x.com, otro@y.net y ana@x.com"), ["ana@x.com", "otro@y.net"]);
  assertEquals(extraerEmails("mandámela al mail porfa"), []);
});

Deno.test("email: rechaza los inválidos (sin @, sin dominio con punto, sin TLD)", () => {
  for (const t of ["ana.gmail.com", "ana@gmail", "ana@gmail.c", "@gmail.com", "ana@", "ana @ gmail"]) {
    assertEquals(extraerEmails(t), [], t);
  }
});

Deno.test("email: elegirEmail prefiere lo que escribió el cliente si el modelo lo copió distinto", () => {
  assertEquals(elegirEmail("ana@x.com", "es ana@x.com"), "ana@x.com");
  assertEquals(elegirEmail("ana@xx.com", "es ana@x.com"), "ana@x.com");
  assertEquals(elegirEmail("ana@x.com", "sí, a ese"), "ana@x.com"); // el mail vino en un turno anterior
  assertEquals(elegirEmail("ana@x.com", "a@b.com o c@d.com"), null); // dos en el texto y ninguno es el del modelo
  assertEquals(elegirEmail("ana", "mandámela al mail"), null);
});

Deno.test("email: dominio mal tipeado → sugerencia", () => {
  assertEquals(sugerenciaTipeo("ana@gmail.con"), "ana@gmail.com");
  assertEquals(sugerenciaTipeo("ana@hotmial.com"), "ana@hotmail.com");
  assertEquals(sugerenciaTipeo("ana@gmail.com"), null);
});

// ---------- guardar_email_factura ----------

Deno.test("guardar_email_factura: email inválido → error y no guarda nada", async () => {
  const { deps, reg } = armar();
  const r = await guardarEmail({ email: "ana@gmail" }, ctx("mandámela a ana@gmail"), deps);
  assertEquals(r.esError, true);
  assertMatch(String(r.resultado.error), /^email_invalido/);
  assertEquals(reg.guardados.length, 0);
  assertEquals(reg.envios.length, 0);
});

Deno.test("guardar_email_factura: dominio dudoso pregunta una vez; con confirmado=true guarda", async () => {
  const { deps, reg } = armar();
  let r = await guardarEmail({ email: "ana@gmail.con" }, ctx("ana@gmail.con"), deps);
  assertMatch(String(r.resultado.error), /^email_dudoso/);
  assertStringIncludes(String(r.resultado.error), "ana@gmail.com");
  assertEquals(reg.guardados.length, 0);
  r = await guardarEmail({ email: "ana@gmail.con", confirmado: true }, ctx("sí, es ese"), deps);
  assertEquals(r.resultado.ok, true);
  assertEquals(reg.guardados[0].email, "ana@gmail.con");
});

Deno.test("guardar_email_factura: sin factura todavía → solo guarda en el último pedido del cliente", async () => {
  const { deps, reg, avisos } = armar();
  const r = await guardarEmail({ email: "Ana@X.com" }, ctx("pasame por correo Ana@X.com"), deps);
  assertEquals(r.resultado.ok, true);
  assertEquals(reg.guardados, [{ id: 7000001, email: "ana@x.com", conv: CONV }]);
  assertEquals(reg.envios.length, 0);
  assertEquals(r.resultado.texto_respuesta, "Listo, te la mando a ana@x.com apenas esté.");
  assertEquals(avisos.length, 0);
});

Deno.test("guardar_email_factura: con número de pedido guarda en ESE pedido; uno de otro cliente no se toca", async () => {
  const otro = pedido({ shopify_order_id: 7000002, gid: "gid://shopify/Order/7000002", nombre: "#1080" });
  const ajeno = pedido({ shopify_order_id: 7000003, gid: "gid://shopify/Order/7000003", nombre: "#1090", cliente_id: "otro", telefono: "+595981999999" });
  const { deps, reg } = armar({ pedidos: [pedido(), otro, ajeno] });
  let r = await guardarEmail({ email: "ana@x.com", pedido: "#1080" }, ctx("para el 1080: ana@x.com"), deps);
  assertEquals(r.resultado.ok, true);
  assertEquals(reg.guardados.map((g) => g.id), [7000002]);
  r = await guardarEmail({ email: "ana@x.com", pedido: "#1090" }, ctx("ana@x.com"), deps);
  assertMatch(String(r.resultado.error), /^pedido_de_otro_cliente/);
  assertEquals(reg.guardados.length, 1);
});

Deno.test("guardar_email_factura: sin pedido en el chat → error sin_pedido, no guarda", async () => {
  const { deps, reg } = armar({ tienda: null });
  const r = await guardarEmail({ email: "ana@x.com" }, ctx("ana@x.com"), deps);
  assertMatch(String(r.resultado.error), /^sin_pedido/);
  assertEquals(reg.guardados.length, 0);
});

Deno.test("guardar_email_factura: pedido cancelado o reemplazado → error", async () => {
  let a = armar({ pedidos: [pedido({ cancelado: true })] });
  let r = await guardarEmail({ email: "ana@x.com" }, ctx("ana@x.com"), a.deps);
  assertMatch(String(r.resultado.error), /^pedido_cancelado/);
  a = armar({ pedidos: [pedido({ tags: ["REEMPLAZADO_POR_#1081"] })] });
  r = await guardarEmail({ email: "ana@x.com" }, ctx("ana@x.com"), a.deps);
  assertMatch(String(r.resultado.error), /^ya_reemplazado.*#1081/);
  assertEquals(a.reg.guardados.length, 0);
});

Deno.test("guardar_email_factura: factura aprobada con KuDE → la reenvía por correo (deps falsas, sin red)", async () => {
  const { deps, reg, avisos } = armar({ factura: FACTURA, envio: { ok: true } });
  const r = await guardarEmail({ email: "ana@x.com" }, ctx("mandámela al mail ana@x.com"), deps);
  assertEquals(r.resultado.ok, true);
  assertEquals(r.resultado.reenviada, true);
  assertEquals(r.resultado.texto_respuesta, "Te la reenvié a ana@x.com.");
  assertEquals(reg.guardados.length, 1);
  assertEquals(reg.envios, [{ factura: FACTURA, email: "ana@x.com", pedido: "#1072", nombre: "Ana Prueba" }]);
  assertEquals(avisos.length, 0);
});

Deno.test("guardar_email_factura: correo simulado (sin RESEND_API_KEY) o con error → aviso a Enrique, sin decir 'reenvié'", async () => {
  for (const envio of [{ ok: true, simulado: true }, { ok: false, error: "resend 500" }]) {
    const { deps, avisos } = armar({ factura: FACTURA, envio });
    const r = await guardarEmail({ email: "ana@x.com" }, ctx("ana@x.com"), deps);
    assertEquals(r.resultado.ok, true);
    assertEquals(r.resultado.reenviada, false);
    assertEquals(r.resultado.texto_respuesta, "Listo, te la mando a ana@x.com en un rato.");
    assertEquals(avisos.length, 1);
    assertStringIncludes(avisos[0].texto, "001-001-0000123");
    assertStringIncludes(avisos[0].texto, "ana@x.com");
    assertEquals((avisos[0].opts as { tipo: string }).tipo, "factura_guardada_vendedor");
  }
});

Deno.test("guardar_email_factura: si no se pudo guardar (migración sin aplicar) avisa a Enrique y el cliente igual queda atendido", async () => {
  const { deps, avisos } = armar({ guardarFalla: "falta aplicar la migración pedido_email_factura" });
  const r = await guardarEmail({ email: "ana@x.com" }, ctx("ana@x.com"), deps);
  assertEquals(r.resultado.ok, true);
  assertEquals(r.resultado.guardado, false);
  assertEquals(avisos.length, 1);
  assertStringIncludes(avisos[0].texto, "no se pudo guardar");
});

// ---------- la pregunta del mail en guardar_factura ----------

const RUC_OK = `4012344-${digitoVerificadorRuc("4012344")}`;
const RUC_OTRO = `80012345-${digitoVerificadorRuc("80012345")}`;

Deno.test("guardar_factura: la pregunta del mail sale una sola vez por chat", async () => {
  const { deps, reg } = armar();
  const ej = EJECUTORES.guardar_factura;
  let r = await ej({ factura: `${RUC_OK} Carlos Benítez`, pedido: "#1072" }, ctx("factura a Carlos"), deps);
  assertEquals(r.resultado.ok, true);
  assertEquals(r.resultado.preguntar_email, true);
  assertStringIncludes(String(r.resultado.nota), PREGUNTA_EMAIL);
  // El bot la hizo: queda en sus mensajes.
  reg.textosBot.push(`Listo, la factura sale a ese nombre. ${PREGUNTA_EMAIL}`);
  r = await ej({ factura: `${RUC_OTRO} Otra SA`, pedido: "#1072" }, ctx("perdón, a nombre de Otra SA"), deps);
  assertEquals(r.resultado.ok, true);
  assertFalse(String(r.resultado.nota).includes(PREGUNTA_EMAIL));
  assertEquals(r.resultado.preguntar_email, undefined);
  assertEquals(reg.atributos.length, 2);
});

Deno.test("guardar_factura: no pregunta si el chat ya dejó un correo, si no se puede leer el estado, ni con error", async () => {
  let a = armar({ emailConv: "ana@x.com" });
  let r = await EJECUTORES.guardar_factura({ factura: `${RUC_OK} Carlos Benítez` }, ctx("factura"), a.deps);
  assertEquals(r.resultado.ok, true);
  assertFalse(String(r.resultado.nota).includes(PREGUNTA_EMAIL));
  a = armar({ estadoFalla: true });
  r = await EJECUTORES.guardar_factura({ factura: `${RUC_OK} Carlos Benítez` }, ctx("factura"), a.deps);
  assertEquals(r.resultado.ok, true);
  assertFalse(String(r.resultado.nota).includes(PREGUNTA_EMAIL));
  a = armar();
  r = await EJECUTORES.guardar_factura({ factura: "4012344 Carlos" }, ctx("factura"), a.deps);
  assertEquals(r.esError, true);
  assertEquals(r.resultado.preguntar_email, undefined);
});

Deno.test("pregunta del mail: detecta si el bot ya la hizo", () => {
  assert(yaPreguntoEmail(["¿Te la mando también por correo? Pasame tu mail"]));
  assert(yaPreguntoEmail(["Pasame tu e-mail y te la envío"]));
  assertFalse(yaPreguntoEmail(["Listo, la factura sale a nombre de Carlos.", "Te llega por WhatsApp"]));
  assert(debePreguntarEmail({ email: null, textosBot: [] }));
  assertFalse(debePreguntarEmail({ email: "ana@x.com", textosBot: [] }));
  assertFalse(debePreguntarEmail(null));
});

Deno.test("guardar_email_factura está registrada con JSON Schema", () => {
  const h = HERRAMIENTAS.find((x) => x.name === "guardar_email_factura");
  assert(h);
  assertEquals(h.input_schema.type, "object");
  assertEquals(typeof EJECUTORES.guardar_email_factura, "function");
});
