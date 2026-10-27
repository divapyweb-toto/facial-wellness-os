import { assert, assertEquals, assertStringIncludes } from "@std/assert";
import { armarResumen, diaParaguay, lineaRendicion, lineaSinCobertura, lineaSinPin, listaParados, type Pedido, type PedidoParado } from "./logica.ts";

const AHORA = new Date("2026-10-17T00:30:00Z"); // 21:30 del 16-10 en Paraguay
const p = (o: Partial<Pedido>): Pedido => ({
  nombre: "#1", creadoEn: "2026-10-16T15:00:00Z", total: 112000, tags: [], canceladoEn: null, esBorrador: false, nota: "",
  lineas: [{ titulo: "Raspador de Lengua", cantidad: 1 }], estadoConfirmacion: "confirmado", estadoEnvio: "DESPACHADO", clienteId: null, ...o,
});
const base = {
  hoy: "2026-10-16", ahora: AHORA, chatsAnuncioHoy: [{ clienteId: "c1" }, { clienteId: "c2" }], chatsBotV33: 98, botV33YaAvisado: null,
  stock: [{ nombre: "Raspador de Lengua", stock: 18 }, { nombre: "Botella Flexible", stock: 47 }],
  entrega7d: { entregados: 17, rechazados: 3 } as { entregados: number; rechazados: number } | null,
};
const pedidos = [
  p({ nombre: "#1" }), p({ nombre: "#2", tags: ["ORIGEN_WHATSAPP"], clienteId: "c1", lineas: [{ titulo: "Pack GUDAIR", cantidad: 1 }] }),
  p({ nombre: "#3", total: 158000, lineas: [{ titulo: "Tiras nasales", cantidad: 2 }] }),
  p({ nombre: "#4 PRUEBA" }), p({ nombre: "#5", canceladoEn: "2026-10-16T16:00:00Z" }), p({ nombre: "#6", esBorrador: true }),
  p({ nombre: "#7", creadoEn: "2026-10-16T02:00:00Z" }), // 15-10 23:00 en Paraguay: es de ayer
  p({ nombre: "#8", creadoEn: "2026-10-14T12:00:00Z", estadoEnvio: null }), // confirmado, +24 h, sin despachar
];
const par = (nombre: string, horas: number, ciudad: string | null, o: Partial<PedidoParado> = {}): PedidoParado =>
  ({ nombre, ciudad, horas, dias: Math.floor(horas / 24), etapa: "sin_despachar", courier: null, producto: "Raspador de Lengua", ...o });
const meta = {
  hoy: [{ nombre: "CAMPAÑA VENTAS WEB", gasto: 40000, presupuesto: 100000 }, { nombre: "CAMPAÑA VENTAS WHATSAPP", gasto: 60000, presupuesto: 100000 }],
  ayer: [{ nombre: "CAMPAÑA VENTAS WEB", gasto: 30000, presupuesto: 100000 }],
  gasto7d: 700000,
  prueba: { gasto: 34422, mejor: { nombre: "VID JAWFLEX V4", ctr: 1.93, inicios: 2, compras: 0 } },
};

Deno.test("día en hora de Paraguay (UTC−3)", () => {
  assertEquals(diaParaguay("2026-10-17T02:59:00Z"), "2026-10-16");
  assertEquals(diaParaguay("2026-10-17T03:00:00Z"), "2026-10-17");
});

Deno.test("cuenta solo pedidos válidos del día, por canal y producto; CPA; alertas", () => {
  const { texto } = armarResumen({ ...base, pedidos, meta, pedidosParados: [par("#8", 60, "Luque")] });
  assertStringIncludes(texto, "Pedidos válidos hoy: <b>3</b> (web 2 · WhatsApp 1) · piso 5-6/día ⚠️");
  assertStringIncludes(texto, "Raspador 1 · Tiras 1 · Pack 1 · JawFlex 0");
  assertStringIncludes(texto, "Unidades: 4 · Facturado: Gs 382.000");
  assertStringIncludes(texto, "Meta hoy: Gs 100.000 (web 40.000 · WhatsApp 60.000)");
  assertStringIncludes(texto, "CPA hoy: Gs 33.333 (web 20.000 · WA 60.000)");
  assertStringIncludes(texto, "50% terminó en pedido");
  assertStringIncludes(texto, "Bot v33: 98/100 chats (falta poco");
  assertStringIncludes(texto, "Prueba de productos: Gs 34.422 hoy");
  assertStringIncludes(texto, "CTR 1,9% · 2 inicios de pago · 0 compras");
  assertStringIncludes(texto, "Web gastó 40% del presupuesto (2.º día bajo 50%");
  assertStringIncludes(texto, "1 pedido sin despachar hace +24 h");
  assertStringIncludes(texto, "Raspador: 18 unidades");
  assertStringIncludes(texto, "CPA 7 días"); // 700.000 / 5 válidos en 7 días = 140.000 > 41.000
  assert(!texto.includes("Botella:"), "stock de Botella no alcanza el tope");
  assert(texto.split("\n").length <= 25, "máximo ~25 líneas");
});

Deno.test("Meta caída: el mensaje sale igual con los pedidos", () => {
  const { texto } = armarResumen({ ...base, pedidos, meta: null, prueba: true });
  assertStringIncludes(texto, "PRUEBA");
  assertStringIncludes(texto, "Meta no respondió");
  assertStringIncludes(texto, "Pedidos válidos hoy: <b>3</b>");
});

Deno.test("bot v33: 100/100 se muestra un día y después desaparece", () => {
  const a = armarResumen({ ...base, pedidos, meta, chatsBotV33: 100 });
  assert(a.botV33Listo); assertStringIncludes(a.texto, "100/100 ✅ listo para mejoras");
  const b = armarResumen({ ...base, pedidos, meta, chatsBotV33: 104, botV33YaAvisado: "2026-10-15" });
  assert(!b.texto.includes("Bot v33"));
});

Deno.test("línea de meta: arriba de todo, con el valor real; sin rechazos no inventa 100%", () => {
  const a = armarResumen({ ...base, pedidos, meta });
  const lineas = a.texto.split("\n");
  assertStringIncludes(lineas[2], "🎯 Meta: 15 pedidos/día · 85% entrega · CPA ≤ 35.000 → hoy: <b>3</b> · entrega 14 días: 85% ✅ · CPA 33.333 ✅");
  const b = armarResumen({ ...base, pedidos, meta: null, entrega7d: { entregados: 9, rechazados: 0 } });
  assertStringIncludes(b.texto, "entrega: sin datos de rechazos · CPA —");
});

Deno.test("libro de creativos: línea de cansancio (solo aviso)", () => {
  const { texto } = armarResumen({ ...base, pedidos, meta, cansados: [{ anuncio: "VID JAWFLEX V4", canal: "web", caidaPct: -88 }] });
  assertStringIncludes(texto, "⚠️ Se está cansando: VID JAWFLEX V4 (formularios/clic -88% contra sus primeros días)");
});

Deno.test("Lucero en gestión +3 días (solo referencias); custodia sin alerta", () => {
  const { texto } = armarResumen({ ...base, pedidos, meta, luceroGestion: [{ ref: "VT-9001", estado: "Fallido", dias: 4 }], papCustodia: [{ ref: "VT-9002", desde: "2026-10-17T10:00:00Z" }] });
  assertStringIncludes(texto, "📦 Lucero en gestión +3 días (reprogramar): VT-9001 Fallido 4d");
  assert(!texto.includes("custodia"), "custodia: solo se mide, sin alerta");
});

Deno.test("20-10 línea sin pin: cuenta sin pin, entregados y ubicación pendiente contra con pin", () => {
  const base = { esBorrador: false, canceladoEn: null, nota: "", lineas: [], total: 0, clienteId: null, estadoConfirmacion: "confirmado" };
  const ped = (n: string, tags: string[], estadoEnvio: string | null = null) =>
    ({ ...base, nombre: n, tags: ["ORIGEN_WHATSAPP", ...tags], estadoEnvio, creadoEn: "2026-10-20T15:00:00Z" }) as unknown as Parameters<typeof lineaSinPin>[0][number];
  const t = lineaSinPin([ped("#1", ["SIN_PIN"], "ENTREGADO"), ped("#2", ["SIN_PIN", "UBICACION_PENDIENTE"]), ped("#3", [])], "2026-10-20");
  assertEquals(t, "📍 Sin pin (14 días): 2 pedidos · 1 entregados · 1 con ubicación pendiente | Con pin: 1 · 0 entregados");
  assertEquals(lineaSinPin([ped("#3", [])], "2026-10-20"), null);
});

Deno.test("20-10: el equilibrio del resumen sale de la config (Varios) y, sin dato, del valor fijo 41.000", () => {
  const con = armarResumen({ ...base, pedidos, meta, equilibrioCpa: 37500 }).texto;
  assertStringIncludes(con, "equilibrio ~37.500");
  const sin = armarResumen({ ...base, pedidos, meta, equilibrioCpa: null }).texto;
  assertStringIncludes(sin, "equilibrio ~41.000");
});

Deno.test("20-10: alerta de CPA de 3 días de JawFlex sobre su equilibrio (con y sin pedidos)", () => {
  const jaw = (nombre: string, creadoEn: string) => p({ nombre, creadoEn, lineas: [{ titulo: "Ejercitador de mandibula JawFlex Pro", cantidad: 1 }] });
  const conJaw = [...pedidos, jaw("#20", "2026-10-15T15:00:00Z"), jaw("#21", "2026-10-13T15:00:00Z")]; // #21 fuera de los 3 días
  const m = (g: number) => ({ ...meta, gasto3dPorProducto: { JawFlex: g, Raspador: 90000 } });
  assertStringIncludes(armarResumen({ ...base, pedidos: conJaw, meta: m(70000), equilibrioJawFlex: 33000 }).texto, "CPA 3 días JawFlex Gs 70.000 > 33.000");
  assert(!armarResumen({ ...base, pedidos: conJaw, meta: m(30000), equilibrioJawFlex: 33000 }).texto.includes("JawFlex Gs"));
  assertStringIncludes(armarResumen({ ...base, pedidos, meta: m(40000), equilibrioJawFlex: 33000 }).texto, "CPA 3 días JawFlex sin pedidos (gastó Gs 40.000) > 33.000");
  assert(!armarResumen({ ...base, pedidos, meta: m(40000), equilibrioJawFlex: null }).texto.includes("JawFlex sin"));
});

Deno.test("20-10: aviso único cuando PaP llega a 20 resueltos en 60 días", () => {
  const r = armarResumen({ ...base, pedidos, meta, pap60d: { resueltos: 20, tasa: 78.5 } });
  assert(r.papAviso);
  assertStringIncludes(r.texto, "PaP ya tiene 20 pedidos resueltos en 60 días (entrega 78.5%)");
  assert(!armarResumen({ ...base, pedidos, meta, pap60d: { resueltos: 19, tasa: 70 } }).papAviso);
  const ya = armarResumen({ ...base, pedidos, meta, pap60d: { resueltos: 25, tasa: 80 }, papAvisoYaDado: true });
  assert(!ya.papAviso && !ya.texto.includes("PaP ya tiene"));
});

Deno.test("20-10: JawFlex muestra el gasto de anuncios pausados; si los activos solos no pasan, va como aviso ℹ️", () => {
  const jaw = (nombre: string) => p({ nombre, creadoEn: "2026-10-15T15:00:00Z", lineas: [{ titulo: "JawFlex Pro", cantidad: 1 }] });
  const ped = [...pedidos, jaw("#30")];
  const m = (g: number, pausado: number) => ({ ...meta, gasto3dPorProducto: { JawFlex: g }, gasto3dPausadoPorProducto: { JawFlex: pausado } });
  const a = armarResumen({ ...base, pedidos: ped, meta: m(150959, 20000), equilibrioJawFlex: 33000 }).texto; // activos 130.959 > 33.000
  assertStringIncludes(a, "⚠️ Alertas:");
  assertStringIncludes(a, "CPA 3 días JawFlex Gs 150.959 > 33.000 · Gs 20.000 de anuncios ya pausados");
  const b = armarResumen({ ...base, pedidos: ped, meta: m(150959, 130000), equilibrioJawFlex: 33000 }).texto; // activos 20.959 ≤ 33.000
  assertStringIncludes(b, "ℹ️ CPA 3 días JawFlex Gs 150.959 > 33.000 · Gs 130.000 de anuncios ya pausados");
  assert(!b.includes("⚠️ Alertas: CPA 3 días JawFlex") && !b.includes("· CPA 3 días JawFlex"));
});

Deno.test("21-10: línea de sin cobertura de la semana (desde el lunes): pagaron y cancelados", () => {
  // viernes 16-10 → semana desde el lunes 12-10
  const sc = (nombre: string, dia: string, tags: string[]) => p({ nombre, creadoEn: `${dia}T15:00:00Z`, tags: ["SIN_COBERTURA", ...tags] });
  const ped = [
    sc("#40", "2026-10-13", ["PAGADO"]),
    sc("#41", "2026-10-15", ["SIN_COBERTURA_CANCELADO"]),
    sc("#42", "2026-10-16", []),
    sc("#43", "2026-10-11", []), // domingo anterior: otra semana
    p({ nombre: "#44" }),
  ];
  assertEquals(lineaSinCobertura(ped, "2026-10-16"), "📍 Sin cobertura: 3 pedidos esta semana · pagaron 1 · cancelados 1");
  assertEquals(lineaSinCobertura([p({ nombre: "#1" })], "2026-10-16"), null);
  assertStringIncludes(armarResumen({ ...base, pedidos: [...pedidos, ...ped], meta }).texto, "Sin cobertura: 3 pedidos esta semana");
});

Deno.test("21-10: pedidos sin despachar salen de la vista pedidos_parados: número, ciudad, días, etapa y courier; más viejo primero; máx 10", () => {
  const cpc = { Villarrica: { sugerido: "pap", lucero: false, pap: true }, Luque: { sugerido: "lucero", lucero: true, pap: true }, X: { sugerido: null, lucero: false, pap: false } };
  const ps = [par("#A", 30, "Villarrica"), par("#B", 100, "Luque"), par("#P", 40, "X"), par("#C", 130, "Luque", { etapa: "sin_cargar" }), par("#D", 60, null, { courier: "lucero" })];
  const t = armarResumen({ ...base, pedidos, meta, pedidosParados: ps, courierPorCiudad: cpc }).texto;
  assertStringIncludes(t, "5 pedidos sin despachar hace +24 h: #C Luque 5 d · sin cargar en Ventas → Lucero · #B Luque 4 d · sin despachar → Lucero · #D ciudad ? 2 d · sin despachar → Lucero · #P X 1 d · sin despachar → sin courier · #A Villarrica 1 d · sin despachar → PaP");
  const muchos = Array.from({ length: 12 }, (_, i) => par(`#M${i}`, 30 + i, "Luque"));
  assertStringIncludes(armarResumen({ ...base, pedidos, meta, pedidosParados: muchos }).texto, "12 pedidos sin despachar hace +24 h:");
  assertStringIncludes(listaParados(muchos).lista, "y 2 más");
  assertEquals(listaParados(muchos).lista.split("sin despachar").length - 1, 10); // 10 ítems listados
  // sin parados (o sin pedir la vista): no hay línea; vista ilegible (null): aviso de que no se pudo leer
  assert(!armarResumen({ ...base, pedidos, meta, pedidosParados: [] }).texto.includes("sin despachar hace"));
  assert(!armarResumen({ ...base, pedidos, meta }).texto.includes("sin despachar hace"));
  assertStringIncludes(armarResumen({ ...base, pedidos, meta, pedidosParados: null }).texto, "No pude leer los pedidos parados");
});

Deno.test("21-10: pedido con courier ya asignado muestra ese; JawFlex: Lucero si llega; PaP si Lucero no llega; decidir a mano si ninguno", () => {
  const mk = (n: string, ciudad: string) => par(n, 100, ciudad, { producto: "JawFlex Pro" });
  const cpc = { A: { sugerido: "pap", lucero: true, pap: true }, B: { sugerido: "pap", lucero: false, pap: true }, C: { sugerido: null, lucero: false, pap: false } };
  const t = armarResumen({ ...base, pedidos, meta, pedidosParados: [mk("#1", "A"), mk("#2", "B"), mk("#3", "C")], courierPorCiudad: cpc }).texto;
  assertStringIncludes(t, "#1 A 4 d · sin despachar → Lucero");
  assertStringIncludes(t, "#2 B 4 d · sin despachar → PaP (JawFlex: Lucero no llega)");
  assertStringIncludes(t, "#3 C 4 d · sin despachar → sin courier: decidir a mano");
  // sin datos de cobertura de la ciudad, JawFlex con courier asignado muestra el asignado
  assertStringIncludes(listaParados([par("#4", 130, "Z", { producto: "JawFlex Pro", courier: "pap" })]).lista, "#4 Z 5 d · sin despachar → PaP");
});

Deno.test("21-10: línea de rendición atrasada con monto y total; sin filas no hay línea", () => {
  const rs = [{ ref: "VT-2", courier: "pap", dias: 16, montoNeto: 250000 }, { ref: "VT-1", courier: "lucero", dias: 5, montoNeto: 100000 }];
  assertEquals(lineaRendicion(rs), "💰 Rendición atrasada: PaP VT-2 16 días Gs 250.000 · Lucero VT-1 5 días Gs 100.000 · total Gs 350.000");
  assertEquals(lineaRendicion([]), null);
  assertEquals(lineaRendicion(null), null);
  assertStringIncludes(armarResumen({ ...base, pedidos, meta, rendicionAtrasada: rs }).texto, "total Gs 350.000");
  assert(!armarResumen({ ...base, pedidos, meta, rendicionAtrasada: [] }).texto.includes("Rendición atrasada"));
});

Deno.test("26-10: el Kit Deporte no cuenta como Tiras ni como Botella", async () => {
  const { familia } = await import("./logica.ts");
  assertEquals(familia("Kit Deporte: Botella Flexible + Tiras Nasales"), "Kit Deporte");
  assertEquals(familia("Tiras Nasales: más aire por la nariz"), "Tiras");
  assertEquals(familia("Botella Deportiva Flexible: se enrolla y no pesa"), "Botella");
});
