// Datos inventados (repo público). Sin red ni base.
import { assert, assertEquals } from "jsr:@std/assert@1";
import {
  type Borrador,
  componentesMensaje,
  configRecuperacion,
  type ConfigRecuperacion,
  type DepsRecuperar,
  evidenciaConsentimiento,
  recuperarBorradores,
  TAG_BORRADOR_RELEASIT,
} from "./logica.ts";

// 2026-10-06 15:00 UTC = 12:00 en Asunción (dentro de horario).
const AHORA = new Date("2026-10-06T15:00:00Z");

function borrador(over: Partial<Borrador> = {}, attrs: Array<{ name: string; value: string }> = []): Borrador {
  return {
    shopify_order_id: 7001,
    nombre: "#D1",
    cliente_id: "cli-1",
    telefono: "+595981000000",
    tags: [TAG_BORRADOR_RELEASIT],
    creado_en: "2026-10-06T12:00:00Z", // 3 h
    raw: {
      created_at: "2026-10-06T12:00:00Z",
      note_attributes: attrs,
      line_items: [{ title: "Tiras nasales", quantity: 2 }],
      shipping_address: { name: "Ana Prueba" },
    },
    ...over,
  };
}
const CONSENT = [{ name: "consentimiento_whatsapp", value: "true" }];
const cfgOn = (o: Partial<ConfigRecuperacion> = {}): ConfigRecuperacion =>
  configRecuperacion({ activo: true, claves_consentimiento: ["consentimiento_whatsapp"], ...o });

function deps(bs: Borrador[], o: {
  cfg?: ConfigRecuperacion; previo?: "si" | "baja" | null; posterior?: boolean; ahora?: Date; falla?: boolean;
} = {}) {
  const reclamados = new Set<number>();
  const log = { enviados: [] as Array<{ tel: string; plantilla: string }>, cerrados: [] as string[], consultas: 0 };
  const d: DepsRecuperar = {
    ahora: () => o.ahora ?? AHORA,
    config: () => Promise.resolve(o.cfg ?? cfgOn()),
    borradores: () => { log.consultas++; return Promise.resolve(bs); },
    consentimiento: () => Promise.resolve({ utilidad: o.previo ?? null, marketing: null }),
    hayPedidoPosterior: () => Promise.resolve(o.posterior ?? false),
    contactadoReciente: () => Promise.resolve(false),
    reclamar: (b) => {
      if (reclamados.has(b.shopify_order_id)) return Promise.resolve(false);
      reclamados.add(b.shopify_order_id);
      return Promise.resolve(true);
    },
    enviar: (tel, plantilla) => {
      log.enviados.push({ tel, plantilla });
      return Promise.resolve(o.falla ? { ok: false, error: "x" } : { ok: true, wa_message_id: "wamid.T" });
    },
    cerrar: (_b, estado) => { log.cerrados.push(estado); return Promise.resolve(); },
  };
  return { d, log };
}

Deno.test("bandera apagada (por defecto): no consulta ni manda nada", async () => {
  assertEquals(configRecuperacion(undefined).activo, false);
  assertEquals(configRecuperacion({ activo: "true" }).activo, false);
  const { d, log } = deps([borrador({}, CONSENT)], { cfg: configRecuperacion({ activo: false }) });
  const r = await recuperarBorradores(d);
  assertEquals(r.accion, "bandera_apagada");
  assertEquals(log.enviados.length, 0);
  assertEquals(log.consultas, 0);
});

Deno.test("con consentimiento en el borrador: manda una vez con la plantilla", async () => {
  const { d, log } = deps([borrador({}, CONSENT)]);
  const r = await recuperarBorradores(d);
  assertEquals(r.enviados, 1);
  assertEquals(log.enviados, [{ tel: "+595981000000", plantilla: "voltra_recuperar_borrador" }]);
  assertEquals(log.cerrados, ["enviado"]);
});

Deno.test("sin consentimiento: no manda", async () => {
  const { d, log } = deps([borrador({}, [])]);
  const r = await recuperarBorradores(d);
  assertEquals(r.enviados, 0);
  assertEquals(r.omitidos.sin_consentimiento, 1);
  assertEquals(log.enviados.length, 0);
});

Deno.test("claves de consentimiento vacías y sin consentimiento previo: no manda aunque haya atributos", async () => {
  const { d, log } = deps([borrador({}, CONSENT)], { cfg: configRecuperacion({ activo: true }) });
  await recuperarBorradores(d);
  assertEquals(log.enviados.length, 0);
});

Deno.test("consentimiento previo 'si' alcanza; 'baja' bloquea aun con evidencia", async () => {
  let x = deps([borrador({}, [])], { previo: "si" });
  assertEquals((await recuperarBorradores(x.d)).enviados, 1);
  x = deps([borrador({}, CONSENT)], { previo: "baja" });
  const r = await recuperarBorradores(x.d);
  assertEquals(r.enviados, 0);
  assertEquals(r.omitidos.baja, 1);
});

Deno.test("valor negativo del atributo no es evidencia", () => {
  assertEquals(evidenciaConsentimiento({ note_attributes: [{ name: "Consentimiento_WhatsApp", value: "No" }] }, ["consentimiento_whatsapp"]), null);
  assertEquals(evidenciaConsentimiento({ note_attributes: [{ name: "Consentimiento_WhatsApp", value: "Sí" }] }, ["consentimiento_whatsapp"]), "Consentimiento_WhatsApp");
});

Deno.test("ventana de 1 a 24 h", async () => {
  const joven = borrador({ raw: { created_at: "2026-10-06T14:30:00Z", note_attributes: CONSENT } });
  const viejo = borrador({ shopify_order_id: 7002, raw: { created_at: "2026-10-05T10:00:00Z", note_attributes: CONSENT } });
  const { d, log } = deps([joven, viejo]);
  const r = await recuperarBorradores(d);
  assertEquals(log.enviados.length, 0);
  assertEquals(r.omitidos.muy_reciente, 1);
  assertEquals(r.omitidos.muy_viejo, 1);
});

Deno.test("pedido real posterior del mismo teléfono: no manda", async () => {
  const { d, log } = deps([borrador({}, CONSENT)], { posterior: true });
  const r = await recuperarBorradores(d);
  assertEquals(log.enviados.length, 0);
  assertEquals(r.omitidos.pedido_posterior, 1);
});

Deno.test("borrador completado o sin teléfono: no manda", async () => {
  const comp = borrador({ raw: { created_at: "2026-10-06T12:00:00Z", completed_at: "2026-10-06T13:00:00Z", note_attributes: CONSENT } });
  const sinTel = borrador({ shopify_order_id: 7003, telefono: null }, CONSENT);
  const { d, log } = deps([comp, sinTel]);
  await recuperarBorradores(d);
  assertEquals(log.enviados.length, 0);
});

Deno.test("idempotencia: dos corridas seguidas mandan un solo mensaje", async () => {
  const { d, log } = deps([borrador({}, CONSENT)]);
  await recuperarBorradores(d);
  const r2 = await recuperarBorradores(d);
  assertEquals(log.enviados.length, 1);
  assertEquals(r2.omitidos.ya_reclamado, 1);
});

Deno.test("fallo de envío: se cierra como fallido y no se reintenta", async () => {
  const { d, log } = deps([borrador({}, CONSENT)], { falla: true });
  const r = await recuperarBorradores(d);
  assertEquals(r.fallidos, 1);
  assertEquals(log.cerrados, ["fallido"]);
  await recuperarBorradores(d);
  assertEquals(log.enviados.length, 1);
});

Deno.test("fuera de horario (3:00 Asunción): no manda", async () => {
  const { d, log } = deps([borrador({}, CONSENT)], { ahora: new Date("2026-10-06T06:00:00Z") });
  const r = await recuperarBorradores(d);
  assertEquals(r.accion, "fuera_de_horario");
  assertEquals(log.enviados.length, 0);
});

Deno.test("componentes: primer nombre y producto con cantidad", () => {
  const c = componentesMensaje(borrador({}, CONSENT)) as Array<{ parameters: Array<{ text: string }> }>;
  assertEquals(c[0].parameters.map((p) => p.text), ["Ana", "2 Tiras nasales"]);
  assert(c.length === 1);
});
