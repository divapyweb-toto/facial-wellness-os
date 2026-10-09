// _shared/sifen/validar_xsd.ts · Validación de XML contra los XSD OFICIALES de SIFEN (supabase/sifen/xsd).
// Motores:
//  - "wasm" (por defecto): npm:xmllint-wasm@5.1.0 (libxml2 compilado a WebAssembly). Funciona en Deno sin binarios.
//  - "binario": /usr/bin/xmllint vía Deno.Command (solo tests/build en una máquina con libxml2).
// Los XSD oficiales incluyen sus dependencias con URL absoluta (https://ekuatia.set.gov.py/sifen/xsd/...).
// Para no depender de la red, en memoria se reescriben a nombres locales (los archivos en disco quedan
// idénticos a los descargados de la DNIT; ver supabase/sifen/FUENTES.md).
//
// LIMITACIÓN Edge Functions: el runtime de Supabase solo empaqueta lo que está dentro de supabase/functions.
// supabase/sifen/xsd/ queda AFUERA, así que en producción esta validación no encuentra los XSD salvo que
// se pase `dirXsd` apuntando a una copia empaquetada (p. ej. static_files en config.toml). Uso previsto:
// tests y verificación previa en CI/local. En la Edge, SIFEN igual valida el schema y rechaza con código.

const URL_OFICIAL = "https://ekuatia.set.gov.py/sifen/xsd/";
const DIR_XSD_DEFECTO = new URL("../../../sifen/xsd/", import.meta.url);

export type TipoXsd = "rDE" | "evento";

/** XSD raíz por tipo (MT, sección 7 "Schemas XML": siRecepDE_v150.xsd y siRecepEvento_v150.xsd). */
export const XSD_RAIZ: Record<TipoXsd, string> = {
  rDE: "siRecepDE_v150.xsd",
  evento: "siRecepEvento_v150.xsd",
};

export interface ResultadoXsd {
  valido: boolean;
  errores: string[];
  motor: "wasm" | "binario";
}

export interface OpcionesXsd {
  motor?: "wasm" | "binario";
  /** Carpeta con los XSD (por defecto supabase/sifen/xsd). */
  dirXsd?: URL;
}

interface ArchivoXsd {
  fileName: string;
  contents: string;
}

const cache = new Map<string, ArchivoXsd[]>();

function nombresIncluidos(contenido: string): string[] {
  const out: string[] = [];
  for (const m of contenido.matchAll(/schemaLocation\s*=\s*"([^"]+)"/g)) {
    const loc = m[1].trim();
    const nombre = loc.split("/").pop()!;
    if (nombre.endsWith(".xsd")) out.push(nombre);
  }
  return out;
}

function localizar(contenido: string): string {
  // Reescribe includes/imports absolutos a nombres de archivo locales (solo en memoria).
  return contenido.replace(/schemaLocation\s*=\s*"([^"]+)"/g, (_m, loc: string) => `schemaLocation="${loc.trim().replace(URL_OFICIAL, "")}"`);
}

/** Carga el XSD raíz y todas sus dependencias (recursivo), con includes localizados. El primero es la raíz. */
export async function cargarXsd(tipo: TipoXsd, dirXsd: URL = DIR_XSD_DEFECTO): Promise<ArchivoXsd[]> {
  const clave = `${dirXsd.href}|${tipo}`;
  const enCache = cache.get(clave);
  if (enCache) return enCache;
  const vistos = new Set<string>();
  const cola = [XSD_RAIZ[tipo]];
  const archivos: ArchivoXsd[] = [];
  while (cola.length) {
    const nombre = cola.shift()!;
    if (vistos.has(nombre)) continue;
    vistos.add(nombre);
    let contenido: string;
    try {
      contenido = await Deno.readTextFile(new URL(nombre, dirXsd));
    } catch (e) {
      throw new Error(`No se pudo leer el XSD "${nombre}" en ${dirXsd.href}: ${(e as Error).message}`);
    }
    archivos.push({ fileName: nombre, contents: localizar(contenido) });
    cola.push(...nombresIncluidos(contenido));
  }
  cache.set(clave, archivos);
  return archivos;
}

function mensajeLegible(raw: string): string {
  // "doc.xml:1: Schemas validity error : Element '{ns}dNumDoc': [facet 'length'] ..." → texto sin ruido
  return raw
    .replace(/^.*?:\d+:\s*/, "")
    .replace(/\{http:\/\/ekuatia\.set\.gov\.py\/sifen\/xsd\}/g, "")
    .replace(/\{http:\/\/www\.w3\.org\/2000\/09\/xmldsig#\}/g, "ds:")
    .replace(/^Schemas validity error\s*:\s*/, "")
    .replace(/^parser error\s*:\s*/, "XML mal formado: ")
    .trim();
}

async function validarWasm(xml: string, xsd: ArchivoXsd[]): Promise<string[]> {
  const { validateXML } = await import("npm:xmllint-wasm@5.1.0");
  const r = await validateXML({
    xml: [{ fileName: "documento.xml", contents: xml }],
    schema: [xsd[0]],
    preload: xsd.slice(1),
  });
  if (r.valid) return [];
  const errs = r.errors.map((e: { rawMessage?: string; message?: string; loc?: { lineNumber?: number } | null }) => {
    const linea = e.loc?.lineNumber ? `línea ${e.loc.lineNumber}: ` : "";
    return linea + mensajeLegible(e.message ?? e.rawMessage ?? "");
  });
  return errs.length ? errs : [mensajeLegible(r.rawOutput || "XML inválido (sin detalle)")];
}

async function validarBinario(xml: string, xsd: ArchivoXsd[]): Promise<string[]> {
  const dir = await Deno.makeTempDir({ prefix: "sifen-xsd-" });
  try {
    for (const f of xsd) await Deno.writeTextFile(`${dir}/${f.fileName}`, f.contents);
    await Deno.writeTextFile(`${dir}/documento.xml`, xml);
    const out = await new Deno.Command("/usr/bin/xmllint", {
      args: ["--noout", "--nonet", "--schema", `${dir}/${xsd[0].fileName}`, `${dir}/documento.xml`],
      stdout: "piped",
      stderr: "piped",
    }).output();
    if (out.code === 0) return [];
    const texto = new TextDecoder().decode(out.stderr);
    const lineas = texto.split("\n").map((l) => l.trim()).filter((l) => l && !/fails to validate$|validates$/.test(l) && !/^\^$/.test(l));
    const errs = lineas
      .filter((l) => /error|warning/i.test(l))
      .map((l) => {
        const m = /documento\.xml:(\d+):/.exec(l);
        return (m ? `línea ${m[1]}: ` : "") + mensajeLegible(l);
      });
    return errs.length ? errs : [mensajeLegible(texto || `xmllint terminó con código ${out.code}`)];
  } finally {
    await Deno.remove(dir, { recursive: true }).catch(() => {});
  }
}

/** Valida `xml` contra el XSD oficial del tipo indicado. No tira error: devuelve la lista de errores. */
export async function validar(xml: string, tipo: TipoXsd = "rDE", opciones: OpcionesXsd = {}): Promise<ResultadoXsd> {
  if (typeof xml !== "string" || xml.trim() === "") return { valido: false, errores: ["XML vacío."], motor: opciones.motor ?? "wasm" };
  const xsd = await cargarXsd(tipo, opciones.dirXsd);
  const motor = opciones.motor ?? "wasm";
  const errores = motor === "binario" ? await validarBinario(xml, xsd) : await validarWasm(xml, xsd);
  return { valido: errores.length === 0, errores, motor };
}

/** Igual que validar(), pero tira Error con un mensaje en español si el XML no cumple el XSD. */
export async function validarOFallar(xml: string, tipo: TipoXsd = "rDE", opciones: OpcionesXsd = {}): Promise<void> {
  const r = await validar(xml, tipo, opciones);
  if (!r.valido) {
    throw new Error(`El XML no cumple el XSD oficial ${XSD_RAIZ[tipo]}:\n- ${r.errores.slice(0, 20).join("\n- ")}`);
  }
}
