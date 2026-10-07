#!/usr/bin/env node
// Compara ElevenLabs Scribe v2 contra OpenAI gpt-transcribe sobre una carpeta LOCAL de audios .ogg
// (notas de voz de WhatsApp). Node 26, sin dependencias.
//
// Uso:
//   ELEVENLABS_API_KEY=... OPENAI_API_KEY=... node scripts/comparar-transcripcion.mjs <carpeta-audios> [--salida <carpeta>]
//
// - El informe (Markdown + JSON) se escribe FUERA del repo: por defecto en la carpeta de audios,
//   o en --salida. Si la salida cae dentro del repo, el script se niega (el repo es público).
// - OpenAI no lista OGG entre sus formatos (mp3, mp4, mpeg, mpga, m4a, wav, webm): si hay ffmpeg,
//   cada .ogg se re-empaqueta a .webm SIN recodificar (mismo Opus) en una carpeta temporal del sistema
//   que se borra al terminar. Sin ffmpeg se manda el .ogg tal cual y, si OpenAI lo rechaza, queda anotado.
// - Si falta una de las dos claves, se corre solo el proveedor que tenga clave.
//
// Precios verificados el 06-10-2026 (USD):
//   Scribe v2: 0,22 por hora + keyterms 0,05 por hora · https://elevenlabs.io/pricing/api
//   gpt-transcribe: 0,0045 por minuto · https://developers.openai.com/api/docs/pricing

import { readdir, readFile, writeFile, mkdtemp, rm, stat } from "node:fs/promises";
import { join, resolve, basename, relative, isAbsolute, dirname } from "node:path";
import { tmpdir } from "node:os";
import { execFile } from "node:child_process";
import { promisify } from "node:util";
import { fileURLToPath } from "node:url";

const ejecutar = promisify(execFile);
const RAIZ_REPO = resolve(dirname(fileURLToPath(import.meta.url)), "..");

const PALABRAS_CLAVE = [
  "Voltra", "tiras nasales", "parches bucales", "raspador", "ejercitador",
  "Ciudad del Este", "Asunción", "Encarnación", "Luque", "San Lorenzo",
];
const PRECIO = {
  scribe_hora: 0.22,
  scribe_keyterms_hora: 0.05,
  openai_minuto: 0.0045,
};
const MODELO_OPENAI = "gpt-transcribe";

function ayuda(motivo) {
  if (motivo) console.log(`\n${motivo}\n`);
  console.log(`Comparar transcripción: Scribe v2 (ElevenLabs) vs ${MODELO_OPENAI} (OpenAI)

Uso:
  ELEVENLABS_API_KEY=... OPENAI_API_KEY=... \\
    node scripts/comparar-transcripcion.mjs <carpeta-con-audios-.ogg> [--salida <carpeta>]

Pasos:
  1. Bajá unas 20 notas de voz reales de WhatsApp a una carpeta FUERA del repo
     (por ejemplo ~/Descargas/audios-voltra). No las copies a fw-os: el repo es público.
  2. Exportá las claves en la terminal (no las escribas en archivos del repo).
  3. Corré el comando. El informe queda en la carpeta de audios (o en --salida):
     comparacion-transcripcion.md y comparacion-transcripcion.json.

Con una sola clave corre solo ese proveedor. ffmpeg (opcional) re-empaqueta OGG→WebM para OpenAI.`);
}

function dentroDelRepo(p) {
  const r = relative(RAIZ_REPO, resolve(p));
  return r === "" || (!r.startsWith("..") && !isAbsolute(r));
}

async function hayFfmpeg() {
  try {
    await ejecutar("ffmpeg", ["-version"]);
    return true;
  } catch {
    return false;
  }
}

async function duracionSeg(archivo) {
  try {
    const { stdout } = await ejecutar("ffprobe", [
      "-v", "error", "-show_entries", "format=duration", "-of", "default=nw=1:nk=1", archivo,
    ]);
    const d = Number(stdout.trim());
    return Number.isFinite(d) ? d : null;
  } catch {
    return null;
  }
}

async function scribe(bytes, nombre, clave) {
  const form = new FormData();
  form.append("model_id", "scribe_v2");
  form.append("language_code", "spa");
  form.append("tag_audio_events", "false");
  for (const p of PALABRAS_CLAVE) form.append("keyterms", p);
  form.append("file", new Blob([bytes], { type: "audio/ogg" }), nombre);
  const t0 = performance.now();
  const r = await fetch("https://api.elevenlabs.io/v1/speech-to-text", {
    method: "POST",
    headers: { "xi-api-key": clave },
    body: form,
    signal: AbortSignal.timeout(120_000),
  });
  const ms = Math.round(performance.now() - t0);
  const j = await r.json().catch(() => ({}));
  if (!r.ok) return { error: `HTTP ${r.status}: ${JSON.stringify(j?.detail ?? j).slice(0, 200)}`, ms };
  const probs = (j.words ?? []).filter((w) => w.type === "word" && typeof w.logprob === "number")
    .map((w) => Math.exp(Math.min(0, w.logprob)));
  const confianza = probs.length ? probs.reduce((a, b) => a + b, 0) / probs.length : null;
  return { texto: (j.text ?? "").trim(), ms, duracion: j.audio_duration_secs ?? null, confianza };
}

async function openai(bytes, nombre, tipo, clave) {
  const form = new FormData();
  form.append("model", MODELO_OPENAI);
  form.append("languages[]", "es");
  form.append("prompt", "Nota de voz de un cliente de Paraguay que compra por WhatsApp; puede mezclar español y guaraní (jopara).");
  for (const p of PALABRAS_CLAVE) form.append("keywords[]", p);
  form.append("file", new Blob([bytes], { type: tipo }), nombre);
  const t0 = performance.now();
  const r = await fetch("https://api.openai.com/v1/audio/transcriptions", {
    method: "POST",
    headers: { Authorization: `Bearer ${clave}` },
    body: form,
    signal: AbortSignal.timeout(120_000),
  });
  const ms = Math.round(performance.now() - t0);
  const j = await r.json().catch(() => ({}));
  if (!r.ok) return { error: `HTTP ${r.status}: ${j?.error?.message ?? ""}`.slice(0, 250), ms };
  return { texto: (j.text ?? "").trim(), ms };
}

const usd = (x) => (x == null ? "—" : `$${x.toFixed(5)}`);
const celda = (s) => String(s ?? "").replace(/\|/g, "\\|").replace(/\n/g, " ");

async function main() {
  const args = process.argv.slice(2);
  const iSalida = args.indexOf("--salida");
  const salidaArg = iSalida >= 0 ? args[iSalida + 1] : null;
  const carpeta = args.find((a, i) => !a.startsWith("--") && (iSalida < 0 || i !== iSalida + 1));

  if (!carpeta) return ayuda();
  const claveEL = process.env.ELEVENLABS_API_KEY;
  const claveOA = process.env.OPENAI_API_KEY;
  if (!claveEL && !claveOA) return ayuda("Faltan ELEVENLABS_API_KEY y OPENAI_API_KEY (con una alcanza para correr ese proveedor).");

  let info;
  try {
    info = await stat(carpeta);
  } catch {
    return ayuda(`No existe la carpeta: ${carpeta}`);
  }
  if (!info.isDirectory()) return ayuda(`No es una carpeta: ${carpeta}`);
  const salida = resolve(salidaArg ?? carpeta);
  if (dentroDelRepo(salida)) {
    return ayuda(`La salida (${salida}) está dentro del repo, que es público. Usá una carpeta fuera, con --salida.`);
  }

  const archivos = (await readdir(carpeta)).filter((f) => /\.(ogg|opus|oga)$/i.test(f)).sort();
  if (!archivos.length) return ayuda(`No hay audios .ogg/.opus en ${carpeta}.`);

  const ffmpeg = claveOA ? await hayFfmpeg() : false;
  const tmp = await mkdtemp(join(tmpdir(), "voltra-stt-"));
  const filas = [];
  try {
    for (const f of archivos) {
      const ruta = join(carpeta, f);
      const bytes = await readFile(ruta);
      const fila = { archivo: f, duracion: await duracionSeg(ruta) };
      process.stdout.write(`· ${f} `);

      if (claveEL) {
        fila.scribe = await scribe(bytes, f, claveEL).catch((e) => ({ error: String(e?.message ?? e) }));
        fila.duracion ??= fila.scribe.duracion ?? null;
      }
      if (claveOA) {
        let b = bytes, nombre = f, tipo = "audio/ogg";
        if (ffmpeg) {
          const destino = join(tmp, basename(f).replace(/\.[^.]+$/, ".webm"));
          try {
            await ejecutar("ffmpeg", ["-v", "error", "-y", "-i", ruta, "-c:a", "copy", destino]);
            b = await readFile(destino);
            nombre = basename(destino);
            tipo = "audio/webm";
          } catch { /* se manda el .ogg tal cual */ }
        }
        fila.openai = await openai(b, nombre, tipo, claveOA).catch((e) => ({ error: String(e?.message ?? e) }));
      }
      const min = fila.duracion != null ? fila.duracion / 60 : null;
      if (fila.scribe && !fila.scribe.error && min != null) {
        fila.scribe.costo = (min / 60) * (PRECIO.scribe_hora + PRECIO.scribe_keyterms_hora);
      }
      if (fila.openai && !fila.openai.error && min != null) fila.openai.costo = min * PRECIO.openai_minuto;
      filas.push(fila);
      console.log("listo");
    }
  } finally {
    await rm(tmp, { recursive: true, force: true });
  }

  const total = (k, campo) => filas.reduce((a, f) => a + (f[k]?.[campo] ?? 0), 0);
  const ok = (k) => filas.filter((f) => f[k] && !f[k].error).length;
  const fecha = new Date().toISOString().slice(0, 10);
  let md = `# Comparación de transcripción (${fecha})\n\n`;
  md += `Audios: ${filas.length} · Scribe v2 (${claveEL ? "sí" : "sin clave"}) · ${MODELO_OPENAI} (${claveOA ? "sí" : "sin clave"})`;
  md += claveOA ? ` · OGG→WebM: ${ffmpeg ? "ffmpeg, sin recodificar" : "sin ffmpeg, se mandó OGG"}\n\n` : "\n\n";
  md += `| Proveedor | OK | Tiempo total (s) | Costo total (USD) |\n|---|---|---|---|\n`;
  if (claveEL) md += `| Scribe v2 | ${ok("scribe")}/${filas.length} | ${(total("scribe", "ms") / 1000).toFixed(1)} | ${usd(total("scribe", "costo"))} |\n`;
  if (claveOA) md += `| ${MODELO_OPENAI} | ${ok("openai")}/${filas.length} | ${(total("openai", "ms") / 1000).toFixed(1)} | ${usd(total("openai", "costo"))} |\n`;
  md += `\nCosto calculado con la duración de cada audio (ffprobe o la que devuelve Scribe). Precios: Scribe USD ${PRECIO.scribe_hora}/h + keyterms USD ${PRECIO.scribe_keyterms_hora}/h; ${MODELO_OPENAI} USD ${PRECIO.openai_minuto}/min.\n\n`;
  md += `## Por audio\n\n| Audio | Seg | Scribe | Conf. | ms | ${MODELO_OPENAI} | ms |\n|---|---|---|---|---|---|---|\n`;
  for (const f of filas) {
    const s = f.scribe, o = f.openai;
    md += `| ${celda(f.archivo)} | ${f.duracion?.toFixed(1) ?? "—"} | ${celda(s ? s.error ?? s.texto : "—")} | ${s?.confianza != null ? s.confianza.toFixed(2) : "—"} | ${s?.ms ?? "—"} | ${celda(o ? o.error ?? o.texto : "—")} | ${o?.ms ?? "—"} |\n`;
  }
  md += `\nPara decidir: marcá a mano qué transcripción entendió mejor cada audio (sobre todo jopara, nombres de producto y ciudades).\n`;

  await writeFile(join(salida, "comparacion-transcripcion.md"), md);
  await writeFile(join(salida, "comparacion-transcripcion.json"), JSON.stringify({ fecha, precios: PRECIO, filas }, null, 2));
  console.log(`\nInforme: ${join(salida, "comparacion-transcripcion.md")}`);
}

main().catch((e) => {
  console.error("Error:", e?.message ?? e);
  process.exitCode = 1;
});
