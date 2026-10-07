// Tests de _shared/transcripcion.ts con fetch simulado (nunca llama a ElevenLabs).
import { assert, assertEquals } from "jsr:@std/assert@1";
import {
  calcularConfianza,
  costoScribe,
  limpiarPalabrasClave,
  tarifasDesdeConfig,
  PALABRAS_CLAVE_POR_DEFECTO,
  transcribirAudio,
  URL_SCRIBE,
} from "./transcripcion.ts";

const AUDIO = new Uint8Array([0x4f, 0x67, 0x67, 0x53, 1, 2, 3, 4]); // "OggS..."

type Captura = { url: string; headers: Headers; form: FormData };

function fetchFalso(status: number, cuerpo: unknown, cap: Captura[] = []): typeof fetch {
  return async (input, init) => {
    cap.push({ url: String(input), headers: new Headers(init?.headers), form: init?.body as FormData });
    await Promise.resolve();
    return new Response(typeof cuerpo === "string" ? cuerpo : JSON.stringify(cuerpo), { status });
  };
}

Deno.test("transcribirAudio: éxito con Scribe v2, multipart correcto y confianza", async () => {
  const cap: Captura[] = [];
  const r = await transcribirAudio(AUDIO, "audio/ogg; codecs=opus", {
    apiKey: "clave-de-prueba",
    modoSimulado: false,
    fetch: fetchFalso(200, {
      language_code: "spa",
      language_probability: 0.97,
      text: " Quiero las tiras nasales ",
      audio_duration_secs: 3600,
      words: [
        { text: "Quiero", type: "word", logprob: 0 },
        { text: " ", type: "spacing", logprob: -5 },
        { text: "las", type: "word", logprob: Math.log(0.8) },
      ],
    }, cap),
  });
  assertEquals(r.ok, true);
  assertEquals(r.texto, "Quiero las tiras nasales");
  assertEquals(r.confianza, 0.9);
  assertEquals(r.confianzaBaja, false);
  assertEquals(r.simulado, false);
  assertEquals(r.idioma, "spa");
  assertEquals(r.costoUsd, 0.27); // 1 h × (0,22 + 0,05 keyterms)

  assertEquals(cap[0].url, URL_SCRIBE);
  assertEquals(cap[0].headers.get("xi-api-key"), "clave-de-prueba");
  const f = cap[0].form;
  assertEquals(f.get("model_id"), "scribe_v2");
  assertEquals(f.get("language_code"), "spa");
  assertEquals(f.getAll("keyterms"), PALABRAS_CLAVE_POR_DEFECTO);
  const archivo = f.get("file") as File;
  assertEquals(archivo.name, "audio.ogg");
  assertEquals(archivo.type, "audio/ogg");
  assertEquals(archivo.size, AUDIO.length);
});

Deno.test("transcribirAudio: palabras clave propias y confianza baja", async () => {
  const cap: Captura[] = [];
  const r = await transcribirAudio(AUDIO, "audio/ogg", {
    apiKey: "k",
    modoSimulado: false,
    palabrasClave: ["Voltra", "voltra", "a<b", ""],
    fetch: fetchFalso(200, { text: "mmm", words: [{ text: "mmm", type: "word", logprob: -2 }] }, cap),
  });
  assertEquals(cap[0].form.getAll("keyterms"), ["Voltra"]);
  assert(r.ok);
  assert(r.confianza < 0.2);
  assertEquals(r.confianzaBaja, true);
});

Deno.test("transcribirAudio: texto vacío → confianza 0 y baja", async () => {
  const r = await transcribirAudio(AUDIO, "audio/ogg", { apiKey: "k", modoSimulado: false, fetch: fetchFalso(200, { text: "", words: [] }) });
  assertEquals(r.ok, true);
  assertEquals(r.confianza, 0);
  assertEquals(r.confianzaBaja, true);
});

Deno.test("transcribirAudio: errores HTTP, JSON roto y red", async () => {
  const e1 = await transcribirAudio(AUDIO, "audio/ogg", {
    apiKey: "k", modoSimulado: false, fetch: fetchFalso(401, { detail: { status: "invalid_api_key", message: "Invalid API key" } }),
  });
  assertEquals(e1, { ok: false, texto: "", confianza: 0, confianzaBaja: true, simulado: false, error: "scribe 401: Invalid API key" });
  const e2 = await transcribirAudio(AUDIO, "audio/ogg", {
    apiKey: "k", modoSimulado: false, fetch: fetchFalso(422, { detail: [{ loc: ["body", "file"], msg: "field required", type: "missing" }] }),
  });
  assertEquals(e2.error, "scribe 422: field required");
  const e3 = await transcribirAudio(AUDIO, "audio/ogg", { apiKey: "k", modoSimulado: false, fetch: fetchFalso(200, "<html>") });
  assertEquals(e3.error, "scribe 200");
  const e4 = await transcribirAudio(AUDIO, "audio/ogg", {
    apiKey: "k", modoSimulado: false, fetch: () => Promise.reject(new Error("sin conexión")),
  });
  assertEquals(e4.error, "red: sin conexión");
  assertEquals(e4.confianzaBaja, true);
});

Deno.test("transcribirAudio: simulado sin clave o con modoSimulado, determinista y sin fetch", async () => {
  let llamado = false;
  const nunca: typeof fetch = () => {
    llamado = true;
    return Promise.reject(new Error("no debería llamarse"));
  };
  const a = await transcribirAudio(AUDIO, "audio/ogg", { apiKey: null, modoSimulado: false, fetch: nunca });
  const b = await transcribirAudio(AUDIO, "audio/ogg", { apiKey: "k", modoSimulado: true, fetch: nunca });
  assertEquals(a.simulado, true);
  assertEquals(a.ok, true);
  assertEquals(a.texto, b.texto);
  assertEquals(a.confianzaBaja, false);
  assertEquals(llamado, false);
});

Deno.test("transcribirAudio: audio vacío", async () => {
  const r = await transcribirAudio(new Uint8Array(), "audio/ogg", { apiKey: "k" });
  assertEquals(r.error, "audio_vacio");
});

Deno.test("auxiliares: limpiarPalabrasClave, calcularConfianza, costoScribe", () => {
  assertEquals(limpiarPalabrasClave(["  tiras   nasales ", "uno dos tres cuatro cinco seis", "x".repeat(50), "[a]"]), ["tiras nasales"]);
  assertEquals(calcularConfianza(null), 0);
  assertEquals(calcularConfianza([{ type: "word", logprob: 0 }, { type: "audio_event", logprob: -9 }]), 1);
  assertEquals(costoScribe(30, false), 0.001833);
  assertEquals(costoScribe(30, true, { base_hora: 0.36, keyterms_hora: 0 }), 0.003);
});

// ─── Tarifa desde config_wa.transcripcion.usd_por_hora ───
const RESPUESTA_1H = { language_code: "spa", text: "Hola", audio_duration_secs: 3600, words: [{ text: "Hola", type: "word", logprob: 0 }] };

Deno.test("transcribirAudio: usa config_wa.transcripcion.usd_por_hora para el costo", async () => {
  let lecturas = 0;
  const r = await transcribirAudio(AUDIO, "audio/ogg", {
    apiKey: "k",
    modoSimulado: false,
    fetch: fetchFalso(200, RESPUESTA_1H),
    leerConfig: () => {
      lecturas++;
      return Promise.resolve({ proveedor: "elevenlabs_scribe_v2", usd_por_hora: 0.4, con_palabras_clave: true });
    },
  });
  assertEquals(r.costoUsd, 0.4);
  assertEquals(lecturas, 1);
});

Deno.test("transcribirAudio: sin config, config inválida o lectura que falla → tarifa por defecto", async () => {
  for (const leerConfig of [
    () => Promise.resolve(null),
    () => Promise.resolve({ usd_por_hora: "barato" }),
    () => Promise.resolve({ usd_por_hora: -1 }),
    () => Promise.reject(new Error("sin base")),
  ]) {
    const r = await transcribirAudio(AUDIO, "audio/ogg", { apiKey: "k", modoSimulado: false, fetch: fetchFalso(200, RESPUESTA_1H), leerConfig });
    assertEquals(r.costoUsd, 0.27);
  }
});

Deno.test("transcribirAudio: opciones.tarifas gana sobre la config; el modo simulado no lee config", async () => {
  const r = await transcribirAudio(AUDIO, "audio/ogg", {
    apiKey: "k",
    modoSimulado: false,
    fetch: fetchFalso(200, RESPUESTA_1H),
    tarifas: { base_hora: 1, keyterms_hora: 0 },
    leerConfig: () => Promise.resolve({ usd_por_hora: 0.4 }),
  });
  assertEquals(r.costoUsd, 1);
  const s = await transcribirAudio(AUDIO, "audio/ogg", {
    apiKey: "k",
    modoSimulado: true,
    leerConfig: () => { throw new Error("no debería leer"); },
  });
  assertEquals(s.simulado, true);
  assertEquals(s.costoUsd, 0);
});

Deno.test("tarifasDesdeConfig: total por hora, sin recargo aparte de keyterms", () => {
  assertEquals(tarifasDesdeConfig({ usd_por_hora: 0.27 }), { base_hora: 0.27, keyterms_hora: 0 });
  assertEquals(tarifasDesdeConfig({}), null);
  assertEquals(tarifasDesdeConfig(undefined), null);
});
