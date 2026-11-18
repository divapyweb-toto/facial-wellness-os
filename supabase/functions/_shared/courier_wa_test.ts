import { assertEquals } from "jsr:@std/assert@1";
import { type DepsCourierWa, enviarACourier, partesPlantilla } from "./courier_wa.ts";

const CFG = {
  activo: true, tope_envios_dia: 3,
  numeros: [
    { telefono: "+595981000111", nombre: "Ana Prueba", empresa: "Lucero del Este" },
    { telefono: "+595981000222", nombre: "Oficina", empresa: "Lucero del Este", avisos: false },
    { telefono: "+595981000333", nombre: "Bea Prueba", empresa: "Punto a Punto" },
  ],
};

function deps(op: { ultimo?: string | null; aprobada?: boolean; hoy?: number; cfg?: unknown; nuevo?: boolean; falla?: boolean } = {}) {
  const log: string[] = [];
  const marcas = new Set<string>();
  const payloads: unknown[] = [];
  const d: DepsCourierWa = {
    ahora: () => new Date("2026-11-18T15:00:00Z"),
    config: async () => op.cfg ?? CFG,
    ultimoEntranteEn: async () => op.ultimo ?? null,
    enviadosHoy: async () => op.hoy ?? 0,
    yaEnviado: async (c) => marcas.has(c),
    marcarEnviado: async (c, p) => void (marcas.add(c), payloads.push(p)),
    yaLeEscribimos: async () => !op.nuevo,
    chatDe: async (t) => ({ clienteId: `k-${t.telefono}`, conversacionId: "c" }),
    plantillaAprobada: async () => op.aprobada ?? true,
    enviarTexto: async (to, t) => (log.push(`texto ${to} ${t}`), op.falla ? { ok: false, error: "131047" } : { ok: true, wa_message_id: "w" }),
    enviarPlantilla: async (to, v) => (log.push(`plantilla ${to} ${v.join("|")}`), { ok: true, wa_message_id: "w" }),
  };
  return { d, log, payloads, marcas };
}

Deno.test("courier_wa: ventana abierta → texto solo a los números de esa empresa con avisos", async () => {
  const { d, log } = deps({ ultimo: "2026-11-18T10:00:00Z" });
  const r = await enviarACourier({ courier: "lucero", ref: "VT-9001", texto: "VT-9001: YA PAGÓ, entregar sin cobrar", clave: "pagado:VT-9001" }, d);
  assertEquals(r, { ok: true, enviados: ["+595981000111"], fallas: [], wamids: ["w"] });
  assertEquals(log, ["texto +595981000111 VT-9001: YA PAGÓ, entregar sin cobrar"]);
  assertEquals((await enviarACourier({ courier: "lucero", ref: "VT-9001", texto: "otra vez", clave: "pagado:VT-9001" }, d)).repetido, true);
  assertEquals(log.length, 1);
});

Deno.test("courier_wa: ventana cerrada → plantilla aprobada en una línea; sin aprobar → falla (sigue el Telegram)", async () => {
  const a = deps({ ultimo: "2026-11-17T10:00:00Z" });
  await enviarACourier({ courier: "pap", ref: "VT-9002", texto: "VT-9002:\nreprogramar al viernes." }, a.d);
  assertEquals(a.log, ["plantilla +595981000333 Bea|VT-9002|VT-9002: · reprogramar al viernes"]);
  const b = deps({ aprobada: false });
  const r = await enviarACourier({ courier: "pap", ref: "VT-9002", texto: "x" }, b.d);
  assertEquals(r.ok, false);
  assertEquals(b.log.length, 0);
});

Deno.test("courier_wa: tope diario, modo apagado y courier sin número", async () => {
  assertEquals((await enviarACourier({ courier: "pap", ref: "VT-1", texto: "x" }, deps({ hoy: 3 }).d)).fallas, ["Bea Prueba: tope_diario"]);
  assertEquals((await enviarACourier({ courier: "pap", ref: "VT-1", texto: "x" }, deps({ cfg: { ...CFG, activo: false } }).d)).fallas, ["modo_transportadora_apagado"]);
  assertEquals((await enviarACourier({ courier: "pap", ref: "VT-1", texto: "x" }, deps({ cfg: { ...CFG, numeros: [] } }).d)).fallas, ["sin_numero_de_pap"]);
});

Deno.test("courier_wa: el candado se cierra SOLO si salió; guarda wamids y plazo para el respaldo", async () => {
  const f = deps({ ultimo: "2026-11-18T10:00:00Z", falla: true });
  const r = await enviarACourier({ courier: "lucero", ref: "VT-9001", texto: "x", clave: "k1" }, f.d);
  assertEquals(r.ok, false);
  assertEquals(f.marcas.size, 0); // sin candado: quien llama sigue con su Telegram
  const b = deps({ ultimo: "2026-11-18T10:00:00Z" });
  await enviarACourier({ courier: "lucero", ref: "VT-9001", texto: "x", clave: "k1", plazoLecturaH: 3 }, b.d);
  const p = b.payloads[0] as Record<string, unknown>;
  assertEquals([p.wamids, p.plazo_h, p.enviado_en], [["w"], 3, "2026-11-18T15:00:00.000Z"]);
});

Deno.test("courier_wa: primera vez por texto libre lleva la presentación", async () => {
  const a = deps({ ultimo: "2026-11-18T10:00:00Z", nuevo: true });
  await enviarACourier({ courier: "lucero", ref: "VT-9001", texto: "VT-9001: entregar sin cobrar" }, a.d);
  assertEquals(a.log, ["texto +595981000111 Hola, te escribe Voltra (antes Facial Wellness, es la misma empresa).\nVT-9001: entregar sin cobrar"]);
});

Deno.test("courier_wa: texto largo → varias plantillas numeradas, cada una ≤ 650", async () => {
  const largo = Array.from({ length: 12 }, (_, i) => `L-VT-90${10 + i} · Ana Prueba · Luque · el cliente pide entregar el viernes después de las 14 h`).join("\n");
  const partes = partesPlantilla(largo);
  assertEquals(partes.length > 1, true);
  assertEquals(partes.every((x) => x.length <= 660 && !x.includes("\n")), true);
  assertEquals(partes[0].startsWith(`(1/${partes.length}) `), true);
  const a = deps({ ultimo: null });
  await enviarACourier({ courier: "pap", ref: "lote", texto: largo }, a.d);
  assertEquals(a.log.length, partes.length);
  assertEquals(partesPlantilla("corto"), ["corto"]);
});
