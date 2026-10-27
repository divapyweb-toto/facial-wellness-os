// Pruebas del chequeo de salud del canal (datos inventados).
import { assert, assertEquals, assertStringIncludes } from "jsr:@std/assert@1";
import {
  aperturaDeHoy,
  AVISO_CANAL_SORDO,
  AVISO_SALUD_CHEQUEO_FALLO,
  avisoSalud,
  CFG_SALUD_CONTRATO,
  type EntradaSalud,
  evaluarSalud,
  extraerEventosCalidad,
  leerCfgSalud,
  MINIMO_ENTRE_AVISOS_H,
} from "./salud.ts";
import { decidirRuta } from "../_shared/telegram_politica.ts";

// Asunción = UTC-3 todo el año (desde oct-2024).
const local = (hhmm: string) => new Date(`2026-10-06T${hhmm}:00-03:00`);

function entrada(extra: Partial<EntradaSalud> = {}): EntradaSalud {
  return {
    ahora: local("14:00"),
    horario: { desde: 8, hasta: 21 },
    cfg: CFG_SALUD_CONTRATO,
    ultimaEntrada: local("13:30").toISOString(),
    fallidosUltimaHora: 0,
    eventosCalidad: [],
    estado: {},
    ...extra,
  };
}

Deno.test("todo normal: sin avisos", () => {
  const r = evaluarSalud(entrada());
  assert(r.enHorario);
  assertEquals(r.motivos, []);
});

Deno.test("3 h sin entrantes en horario → aviso", () => {
  const r = evaluarSalud(entrada({ ultimaEntrada: local("10:30").toISOString() }));
  assertEquals(r.motivos.map((m) => m.clave), ["sin_entrantes"]);
  assertEquals(r.nuevoEstado.sin_entrantes, local("14:00").toISOString());
});

Deno.test("a las 9:00 no cuenta la noche: el plazo arranca a las 8:00", () => {
  const r = evaluarSalud(entrada({ ahora: local("09:00"), ultimaEntrada: local("20:00").toISOString().replace("06T", "05T") }));
  assertEquals(r.motivos, []);
  const r2 = evaluarSalud(entrada({ ahora: local("11:00"), ultimaEntrada: "2026-10-05T23:00:00Z" }));
  assertEquals(r2.motivos.map((m) => m.clave), ["sin_entrantes"]);
});

Deno.test("fuera de horario no avisa nada", () => {
  const r = evaluarSalud(entrada({ ahora: local("22:00"), ultimaEntrada: local("12:00").toISOString(), fallidosUltimaHora: 10 }));
  assertEquals(r.enHorario, false);
  assertEquals(r.motivos, []);
  assertEquals(evaluarSalud(entrada({ ahora: local("21:00"), fallidosUltimaHora: 10 })).enHorario, false);
  assert(evaluarSalud(entrada({ ahora: local("08:00") })).enHorario);
});

Deno.test("3 o más fallidos en la última hora → aviso; 2 no", () => {
  assertEquals(evaluarSalud(entrada({ fallidosUltimaHora: 3 })).motivos.map((m) => m.clave), ["fallidos"]);
  assertEquals(evaluarSalud(entrada({ fallidosUltimaHora: 2 })).motivos, []);
});

Deno.test("no repite el mismo aviso antes de 6 h (27-10; antes 3 h)", () => {
  const estado = { fallidos: local("09:00").toISOString() };
  assertEquals(evaluarSalud(entrada({ fallidosUltimaHora: 5, estado })).motivos, []);
  const estadoViejo = { fallidos: local("07:59").toISOString() };
  assertEquals(evaluarSalud(entrada({ fallidosUltimaHora: 5, estado: estadoViejo })).motivos.length, 1);
});

Deno.test("27-10: tope global de 1 aviso cada 6 h por cualquier motivo; lo nuevo sale al vencer la ventana", () => {
  const eventosCalidad = [{ id: 30, recibido_en: "", campo: "phone_number_quality_update", evento: "FLAGGED", detalle: "" }];
  // Se avisó "sin entrantes" a las 9:00: a las 14:00 ni fallidos ni calidad salen, y el id de calidad no avanza.
  const estado = { sin_entrantes: local("09:00").toISOString() };
  const dentro = evaluarSalud(entrada({ fallidosUltimaHora: 9, eventosCalidad, estado }));
  assertEquals(dentro.motivos, []);
  assertEquals(dentro.nuevoEstado, estado);
  // 15:01 (6 h y 1 min después): sale todo junto en un solo aviso.
  const fuera = evaluarSalud(entrada({ ahora: local("15:01"), ultimaEntrada: local("15:00").toISOString(), fallidosUltimaHora: 9, eventosCalidad, estado }));
  assertEquals(fuera.motivos.map((m) => m.clave), ["fallidos", "calidad"]);
  assertEquals(fuera.nuevoEstado.ultimo_evento_calidad_id, 30);
  // La config no puede bajar el tope de 6 h.
  assertEquals(leerCfgSalud({ repetir_cada_h: 1 }).repetir_cada_h, MINIMO_ENTRE_AVISOS_H);
  assertEquals(leerCfgSalud({ repetir_cada_h: 12 }).repetir_cada_h, 12);
});

Deno.test("27-10: canal sordo → Enrique (Telegram); falla del chequeo → administración 1 por día", () => {
  assertEquals(AVISO_CANAL_SORDO, { tipo: "whatsapp_canal_sordo", destino: "enrique" });
  assertEquals(decidirRuta(null, AVISO_CANAL_SORDO), "telegram");
  assertEquals(AVISO_SALUD_CHEQUEO_FALLO, { tipo: "salud_canal_chequeo_fallo", destino: "admin", unaVezPorDia: true, clave: null });
  assertEquals(decidirRuta(null, AVISO_SALUD_CHEQUEO_FALLO), "admin");
});

Deno.test("canal sin estrenar (nunca entró nada): no avisa sin entrantes", () => {
  assertEquals(evaluarSalud(entrada({ ultimaEntrada: null })).motivos, []);
});

Deno.test("extrae eventos de calidad del cuerpo de Meta y de cambios sueltos", () => {
  const filas = [
    {
      id: 10,
      recibido_en: "2026-10-06T12:00:00Z",
      payload: {
        object: "whatsapp_business_account",
        entry: [{
          id: "0",
          changes: [{
            field: "phone_number_quality_update",
            value: { display_phone_number: "595981000000", event: "DOWNGRADE", current_limit: "TIER_250", old_limit: "TIER_1K" },
          }],
        }],
      },
    },
    { id: 11, recibido_en: "2026-10-06T12:05:00Z", payload: { field: "account_update", value: { event: "ACCOUNT_RESTRICTION" } } },
    { id: 12, recibido_en: "2026-10-06T12:06:00Z", payload: { mensaje: { id: "wamid.x", type: "text" } } },
    { id: 13, recibido_en: "2026-10-06T12:07:00Z", payload: { field: "messages", value: {} } },
  ];
  const ev = extraerEventosCalidad(filas);
  assertEquals(ev.map((e) => [e.id, e.evento]), [[10, "DOWNGRADE"], [11, "ACCOUNT_RESTRICTION"]]);
  assertStringIncludes(ev[0].detalle, "TIER_250");
});

Deno.test("calidad: avisa cada evento nuevo una vez y guarda el último id", () => {
  const eventosCalidad = [
    { id: 10, recibido_en: "", campo: "phone_number_quality_update", evento: "FLAGGED", detalle: "" },
    { id: 12, recibido_en: "", campo: "phone_number_quality_update", evento: "DOWNGRADE", detalle: "" },
  ];
  const r = evaluarSalud(entrada({ eventosCalidad }));
  assertEquals(r.motivos.map((m) => m.clave), ["calidad"]);
  assertEquals(r.nuevoEstado.ultimo_evento_calidad_id, 12);
  const r2 = evaluarSalud(entrada({ eventosCalidad, estado: r.nuevoEstado }));
  assertEquals(r2.motivos, []);
});

Deno.test("calidad de noche se avisa a la mañana (no avanza el id fuera de horario)", () => {
  const eventosCalidad = [{ id: 20, recibido_en: "", campo: "phone_number_quality_update", evento: "FLAGGED", detalle: "" }];
  const noche = evaluarSalud(entrada({ ahora: local("23:00"), eventosCalidad }));
  assertEquals(noche.nuevoEstado.ultimo_evento_calidad_id, undefined);
  const manana = evaluarSalud(entrada({ ahora: local("08:15"), ultimaEntrada: local("08:10").toISOString(), eventosCalidad }));
  assertEquals(manana.motivos.map((m) => m.clave), ["calidad"]);
});

Deno.test("aperturaDeHoy da las 8:00 locales", () => {
  assertEquals(aperturaDeHoy(local("14:37"), { desde: 8, hasta: 21 }).toISOString(), local("08:00").toISOString());
});

Deno.test("leerCfgSalud usa el contrato si falta o es inválido", () => {
  assertEquals(leerCfgSalud(null), CFG_SALUD_CONTRATO);
  assertEquals(leerCfgSalud({ fallidos_por_hora: 5, repetir_cada_h: -1 }).fallidos_por_hora, 5);
  assertEquals(leerCfgSalud({ repetir_cada_h: -1 }).repetir_cada_h, 6);
});

Deno.test("avisoSalud arma un texto con los motivos", () => {
  const a = avisoSalud([{ clave: "fallidos", texto: "4 envíos fallidos en la última hora." }]);
  assertStringIncludes(a.texto, "canal sordo");
  assertStringIncludes(a.texto, "• 4 envíos fallidos");
});
