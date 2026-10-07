import { assert, assertEquals } from "jsr:@std/assert@1";
import { cfgDeSemilla } from "./semilla_prueba.ts";
import type { ItemPlan, MensajeMk } from "./calendario.ts";
import { type Consentimiento, type Deps, ejecutarRecompra, type PedidoFila, type PlanFila } from "./logica.ts";

const cfg = cfgDeSemilla();
const ENTREGA = new Date("2026-10-01T15:00:00Z"); // 12:00 Asunción
const enDia = (n: number) => new Date(ENTREGA.getTime() + n * 86_400_000); // mismo horario, n días después

interface Envio {
  id: string;
  cliente_id: string;
  plantilla: string;
  variables: (string | number)[];
  enviar_desde: string;
  clave_unica: string;
  estado: string;
}

/** Base en memoria con la misma semántica que index.ts (claves únicas, cancelación solo de pendientes). */
function base(op: { consent?: Consentimiento; pedidos?: PedidoFila[]; mensajes?: MensajeMk[] } = {}) {
  const s = {
    ahora: enDia(0),
    consent: new Map<string, Consentimiento>([["c1", op.consent === undefined ? "si" : op.consent]]),
    pedidos: op.pedidos ?? [pedido(1001, [["Tiras nasales", 1]])],
    planes: [] as (PlanFila & { motivo?: string | null })[],
    envios: [] as Envio[],
    mensajes: op.mensajes ?? [] as MensajeMk[],
    topes: [] as unknown[],
  };
  let n = 0;
  const deps: Deps = {
    ahora: () => s.ahora,
    cfg,
    pedidos: () => Promise.resolve(s.pedidos),
    consentimientos: (ids) => Promise.resolve(new Map(ids.map((i) => [i, s.consent.get(i) ?? null]))),
    insertarPlanes: (items: ItemPlan[]) => {
      let nuevas = 0;
      for (const i of items) {
        if (s.planes.some((p) => p.clave_unica === i.clave_unica)) continue;
        s.planes.push({
          id: `p${++n}`,
          cliente_id: i.cliente_id,
          shopify_order_id: i.shopify_order_id,
          tipo: i.tipo,
          producto_clave: i.producto_clave,
          dia_objetivo: i.dia_objetivo,
          estado: "planificado",
          plantilla: i.plantilla,
          variables: i.variables,
          clave_unica: i.clave_unica,
          envio_id: null,
        });
        nuevas++;
      }
      return Promise.resolve(nuevas);
    },
    planesAbiertos: () => {
      // igual que index.ts: los programados cuyo envío ya no está pendiente se cierran
      for (const p of s.planes) {
        const e = s.envios.find((x) => x.id === p.envio_id);
        if (p.estado === "programado" && e && e.estado !== "pendiente") {
          p.estado = e.estado === "enviado" ? "enviado" : "cancelado";
        }
      }
      return Promise.resolve(
        s.planes.filter((p) => p.estado === "planificado" || p.estado === "programado").map((p) => ({ ...p })),
      );
    },
    actualizarPlan: (id, c) => {
      Object.assign(s.planes.find((p) => p.id === id)!, c);
      return Promise.resolve();
    },
    historialMarketing: () =>
      Promise.resolve({
        mensajes: s.mensajes,
        enCola: s.envios.filter((e) => e.estado === "pendiente").map((e) => new Date(e.enviar_desde)),
      }),
    programarEnvio: (e) => {
      const ya = s.envios.find((x) => x.clave_unica === e.clave_unica);
      if (ya) return Promise.resolve(ya.id);
      const id = `e${++n}`;
      s.envios.push({ id, estado: "pendiente", ...e });
      return Promise.resolve(id);
    },
    cancelarEnvio: (id, motivo) => {
      const e = s.envios.find((x) => x.id === id);
      if (e && e.estado === "pendiente") Object.assign(e, { estado: "cancelado", ultimo_error: motivo });
      return Promise.resolve();
    },
    guardarTope: (f) => {
      s.topes.push(f);
      return Promise.resolve();
    },
  };
  /** Simula que procesar-envios mandó todo lo pendiente y que el cliente lo leyó (o no). */
  const mandarPendientes = (leido: boolean) => {
    for (const e of s.envios.filter((x) => x.estado === "pendiente")) {
      e.estado = "enviado";
      s.mensajes.push({ enviado_en: new Date(e.enviar_desde), leido });
    }
  };
  return { s, deps, mandarPendientes };
}

function pedido(id: number, lineas: [string, number][], o: Partial<PedidoFila> = {}): PedidoFila {
  return {
    shopify_order_id: id,
    cliente_id: "c1",
    nombre_cliente: "Ana",
    creado_en: new Date("2026-09-28T12:00:00Z"),
    entregado_en: ENTREGA,
    cancelado: false,
    lineas: lineas.map(([titulo, cantidad]) => ({ titulo, cantidad })),
    ...o,
  };
}

Deno.test("sin consentimiento de marketing no planifica ni programa", async () => {
  for (const c of [null, "no", "baja"] as const) {
    const { s, deps } = base({ consent: c });
    s.ahora = enDia(23);
    const r = await ejecutarRecompra(deps);
    assertEquals([r.pedidos_entregados, r.planes_nuevos, r.programados, s.planes.length, s.envios.length], [
      1,
      0,
      0,
      0,
      0,
    ]);
  }
});

Deno.test("día de entrega: crea M1 y M2 pero no programa nada todavía", async () => {
  const { s, deps } = base();
  const r = await ejecutarRecompra(deps);
  assertEquals(r.planes_nuevos, 2);
  assertEquals(s.planes.map((p) => [p.tipo, p.dia_objetivo, p.estado]), [
    ["M1", "2026-10-24", "planificado"],
    ["M2", "2026-11-04", "planificado"],
  ]);
  assertEquals(s.envios.length, 0);
});

Deno.test("día 23: programa M1 como marketing a las 9:00; correr dos veces no duplica", async () => {
  const { s, deps } = base();
  s.ahora = new Date("2026-10-24T11:00:00Z"); // 8:00 Asunción, antes de la hora de envío
  const r1 = await ejecutarRecompra(deps);
  const r2 = await ejecutarRecompra(deps);
  assertEquals([r1.planes_nuevos, r1.programados, r2.planes_nuevos, r2.programados], [2, 1, 0, 0]);
  assertEquals(s.planes.length, 2);
  assertEquals(s.envios.length, 1);
  assertEquals(s.envios[0], {
    id: s.envios[0].id,
    estado: "pendiente",
    cliente_id: "c1",
    shopify_order_id: 1001,
    plantilla: "voltra_mk_reposicion",
    variables: ["Ana", "tiras nasales", "otra bolsa", 79000],
    enviar_desde: "2026-10-24T12:00:00.000Z",
    clave_unica: "rc:1001:M1",
  } as unknown as Envio);
  assertEquals(s.planes[0].estado, "programado");
});

Deno.test("recompró antes de M2: M2 se cancela y no sale", async () => {
  const { s, deps, mandarPendientes } = base();
  s.ahora = enDia(23);
  await ejecutarRecompra(deps);
  mandarPendientes(true);
  // el cliente toca "Sí, mandame" y entra un pedido nuevo de tiras el día 24
  s.pedidos.push(pedido(1002, [["Tiras nasales", 1]], { creado_en: enDia(24), entregado_en: null }));
  s.ahora = enDia(34);
  const r = await ejecutarRecompra(deps);
  assertEquals(r.programados, 0);
  const m2 = s.planes.find((p) => p.tipo === "M2")!;
  assertEquals([m2.estado, m2.motivo], ["cancelado", "recompro"]);
  assertEquals(s.planes.find((p) => p.tipo === "M1")!.estado, "enviado");
  assertEquals(s.envios.length, 1);
});

Deno.test("no recompró: M2 sale el día 34 con la oferta del pack", async () => {
  const { s, deps, mandarPendientes } = base();
  s.ahora = enDia(23);
  await ejecutarRecompra(deps);
  mandarPendientes(true);
  s.ahora = enDia(34);
  const r = await ejecutarRecompra(deps);
  assertEquals(r.programados, 1);
  assertEquals(s.envios.map((e) => [e.clave_unica, e.plantilla, e.variables[3]]), [
    ["rc:1001:M1", "voltra_mk_reposicion", 79000],
    ["rc:1001:M2", "voltra_mk_pack", 125000],
  ]);
});

Deno.test("tope semana: marketing hace 3 días → se posterga 4 días", async () => {
  const { s, deps } = base({ mensajes: [{ enviado_en: enDia(20), leido: true }] });
  s.ahora = enDia(23);
  const r = await ejecutarRecompra(deps);
  assertEquals([r.programados, r.postergados], [0, 1]);
  const m1 = s.planes.find((p) => p.tipo === "M1")!;
  assertEquals([m1.estado, m1.dia_objetivo, m1.motivo], ["planificado", "2026-10-28", "tope_semana"]);
  s.ahora = enDia(27);
  assertEquals((await ejecutarRecompra(deps)).programados, 1);
});

Deno.test("dos pedidos del mismo cliente vencen el mismo día: sale uno solo", async () => {
  const { s, deps } = base({
    pedidos: [pedido(1001, [["Tiras", 1]]), pedido(1003, [["Raspador de lengua", 1]], { entregado_en: enDia(9) })],
  });
  s.ahora = enDia(23); // M1 de 1001 (día 23) y CRUZADA de 1003 (día 9 + 14 = 23)
  const r = await ejecutarRecompra(deps);
  assertEquals([r.programados, s.envios.length], [1, 1]);
});

Deno.test("baja entre M1 y M2: se cancela todo lo pendiente del cliente", async () => {
  const { s, deps } = base();
  s.ahora = enDia(23);
  await ejecutarRecompra(deps); // M1 queda en cola, sin mandar
  s.consent.set("c1", "baja");
  s.ahora = enDia(24);
  const r = await ejecutarRecompra(deps);
  assertEquals(r.cancelados, 2);
  assertEquals(s.planes.map((p) => [p.tipo, p.estado]), [["M1", "cancelado"], ["M2", "cancelado"]]);
  assertEquals(s.envios[0].estado, "cancelado");
});

Deno.test("60 días sin leer: sale de la lista y se cancelan sus planes", async () => {
  const { s, deps } = base({
    mensajes: [{ enviado_en: new Date("2026-07-20T12:00:00Z"), leido: false }],
  });
  s.ahora = enDia(23);
  const r = await ejecutarRecompra(deps);
  assertEquals(r.programados, 0);
  assert(s.planes.every((p) => p.estado === "cancelado" && p.motivo === "sin_leer_60_dias"));
  assertEquals((s.topes.at(-1) as { fuera: boolean }).fuera, true);
});

Deno.test("arranque con entregas viejas: no crea avisos cuyo día ya pasó hace más de 3 días", async () => {
  const { s, deps } = base();
  s.ahora = enDia(40); // M1 (23) y M2 (34) ya pasaron
  const r = await ejecutarRecompra(deps);
  assertEquals([r.planes_nuevos, s.envios.length], [0, 0]);
});
