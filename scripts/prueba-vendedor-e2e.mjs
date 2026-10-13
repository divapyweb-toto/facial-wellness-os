#!/usr/bin/env node
// Prueba de punta a punta del VENDEDOR (12-10-2026): simula mensajes del teléfono de prueba hacia wa-webhook en
// producción (firmados como Meta) y muestra lo que el bot mandó según wa_mensajes (burbujas, botones, totales).
//
//   node scripts/prueba-vendedor-e2e.mjs --nueva --anuncio 120251028175490429 "¡Hola! Quiero más información" "boton:Quiero pedirlo"
//
//   --nueva            cierra las conversaciones abiertas del teléfono de prueba (arranca como cliente nuevo)
//   --anuncio <id>     el primer mensaje llega con referral de ese anuncio (sin ctwa_clid: no dispara eventos a Meta)
//   "texto"            un mensaje de texto
//   "boton:<título>"   toque de un botón de respuesta (busca el id en el último interactivo que mandó el bot)
//   "ubicacion:<lat>,<lng>"  pin de ubicación
//   --json             imprime el resultado en JSON (para revisar en otro script)
//
// Lee .env.produccion (SUPABASE_PROJECT_REF, SUPABASE_SERVICE_ROLE_KEY, WA_APP_SECRET, WA_PHONE_NUMBER_ID,
// WA_WABA_ID, PRUEBA_TELEFONO). Nunca imprime secretos ni el teléfono. Si la ventana de 24 h del teléfono de prueba
// está cerrada, WhatsApp rechaza las burbujas libres (quedan "fallido" con 131047), pero el contenido se ve igual.
import { existsSync, readFileSync } from 'node:fs';
import { join, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';
import { createHmac, randomBytes } from 'node:crypto';

const RAIZ = join(dirname(fileURLToPath(import.meta.url)), '..');
const ENV = join(RAIZ, '.env.produccion');
if (existsSync(ENV)) {
  for (const l of readFileSync(ENV, 'utf8').split('\n')) {
    const m = /^\s*([A-Z0-9_]+)\s*=\s*(.*)\s*$/.exec(l);
    if (m && !process.env[m[1]]) process.env[m[1]] = m[2].replace(/^['"]|['"]$/g, '');
  }
}
const E = (k) => {
  const v = (process.env[k] ?? '').trim();
  if (!v) { console.error(`falta ${k}`); process.exit(1); }
  return v;
};
const REF = E('SUPABASE_PROJECT_REF'), CLAVE = E('SUPABASE_SERVICE_ROLE_KEY'), SECRETO = E('WA_APP_SECRET');
const PHONE_ID = E('WA_PHONE_NUMBER_ID'), WABA = E('WA_WABA_ID');
const TEL = E('PRUEBA_TELEFONO').replace(/\D/g, '');
const REST = `https://${REF}.supabase.co/rest/v1`;
const H = { apikey: CLAVE, Authorization: `Bearer ${CLAVE}`, 'Content-Type': 'application/json' };
const espera = (ms) => new Promise((r) => setTimeout(r, ms));
/** El proxy local a veces corta la conexión reutilizada (UND_ERR_SOCKET): hasta 4 intentos. */
async function fetchR(url, op) {
  for (let i = 0; ; i++) {
    try { return await fetch(url, { ...op, signal: AbortSignal.timeout(20000) }); } catch (e) { if (i >= 3) throw e; await espera(1500 * (i + 1)); }
  }
}

const args = process.argv.slice(2);
const NUEVA = args.includes('--nueva');
const JSON_OUT = args.includes('--json');
const iAn = args.indexOf('--anuncio');
const ANUNCIO = iAn >= 0 ? args[iAn + 1] : null;
const pasos = args.filter((a, i) => !a.startsWith('--') && !(iAn >= 0 && i === iAn + 1));
if (!pasos.length) { console.error('Pasá al menos un mensaje.'); process.exit(1); }

async function rest(path, op = {}) {
  const r = await fetchR(`${REST}/${path}`, { ...op, headers: { ...H, ...(op.headers ?? {}) } });
  const t = await r.text();
  if (!r.ok) throw new Error(`${path.split('?')[0]}: HTTP ${r.status} ${t.slice(0, 200)}`);
  return t ? JSON.parse(t) : null;
}

const cliente = (await rest(`wa_clientes?select=id,wa_user_id,telefono&telefono=eq.%2B${TEL}`))[0] ?? null;
if (NUEVA && cliente) {
  await rest(`wa_conversaciones?cliente_id=eq.${cliente.id}&estado=neq.cerrada`, {
    method: 'PATCH', headers: { Prefer: 'return=minimal' }, body: JSON.stringify({ estado: 'cerrada' }),
  });
}

function mensaje(paso, primero, ultimoInteractivo) {
  const base = { from: TEL, id: `wamid.PRUEBA${randomBytes(10).toString('hex')}`, timestamp: String(Math.floor(Date.now() / 1000)) };
  if (cliente?.wa_user_id) base.from_user_id = cliente.wa_user_id;
  if (primero && ANUNCIO) {
    base.referral = { source_id: ANUNCIO, source_type: 'ad', source_url: 'https://fb.me/prueba', headline: 'Prueba E2E', body: 'Prueba E2E' };
  }
  if (paso.startsWith('boton:')) {
    const titulo = paso.slice(6);
    const b = (ultimoInteractivo?.action?.buttons ?? []).find((x) => x.reply?.title === titulo);
    if (!b) throw new Error(`no encontré el botón "${titulo}" en el último interactivo del bot`);
    return { ...base, type: 'interactive', interactive: { type: 'button_reply', button_reply: { id: b.reply.id, title: titulo } } };
  }
  if (paso.startsWith('ubicacion:')) {
    const [lat, lng] = paso.slice(10).split(',').map(Number);
    return { ...base, type: 'location', location: { latitude: lat, longitude: lng } };
  }
  return { ...base, type: 'text', text: { body: paso } };
}

async function enviar(m) {
  const cuerpo = JSON.stringify({
    object: 'whatsapp_business_account',
    entry: [{ id: WABA, changes: [{ field: 'messages', value: {
      messaging_product: 'whatsapp',
      metadata: { phone_number_id: PHONE_ID },
      contacts: [{ profile: { name: 'Prueba E2E' }, wa_id: TEL, ...(cliente?.wa_user_id ? { user_id: cliente.wa_user_id } : {}) }],
      messages: [m],
    } }] }],
  });
  const firma = 'sha256=' + createHmac('sha256', SECRETO).update(cuerpo).digest('hex');
  const r = await fetchR(`https://${REF}.supabase.co/functions/v1/wa-webhook`, {
    method: 'POST', headers: { 'Content-Type': 'application/json', 'X-Hub-Signature-256': firma }, body: cuerpo,
  });
  if (!r.ok) throw new Error(`wa-webhook: HTTP ${r.status} ${(await r.text()).slice(0, 200)}`);
}

/** Espera las salidas del bot: corta cuando pasan 20 s sin nada nuevo (máx. 120 s). */
async function salidasDesde(desdeISO) {
  let previas = -1, quieto = 0;
  for (let t = 0; t < 120; t += 5) {
    await espera(5000);
    const cl = (await rest(`wa_clientes?select=id&telefono=eq.%2B${TEL}`))[0];
    if (!cl) continue;
    const out = await rest(`wa_mensajes?select=tipo,texto,contenido,estado,error,creado_en&cliente_id=eq.${cl.id}&direccion=eq.out&creado_en=gte.${encodeURIComponent(desdeISO)}&order=creado_en.asc`);
    if (out.length === previas && out.length > 0) { quieto += 5; if (quieto >= 20) return out; } else quieto = 0;
    previas = out.length;
  }
  const cl = (await rest(`wa_clientes?select=id&telefono=eq.%2B${TEL}`))[0];
  return cl ? await rest(`wa_mensajes?select=tipo,texto,contenido,estado,error,creado_en&cliente_id=eq.${cl.id}&direccion=eq.out&creado_en=gte.${encodeURIComponent(desdeISO)}&order=creado_en.asc`) : [];
}

function legible(o) {
  const c = o.contenido ?? {};
  const i = c.interactive;
  const linea = { tipo: o.tipo, estado: o.estado, texto: o.texto };
  if (i) {
    linea.cuerpo = i.body?.text;
    linea.botones = (i.action?.buttons ?? []).map((b) => b.reply?.title);
    if (i.type === 'location_request_message') linea.botones = ['(Enviar ubicación)'];
  }
  if (c.video || c.image) linea.media = (c.video ?? c.image).link;
  if (o.error) linea.error = String(typeof o.error === 'string' ? o.error : JSON.stringify(o.error)).slice(0, 120);
  return linea;
}

const resultado = [];
let ultimoInteractivo = null;
for (let k = 0; k < pasos.length; k++) {
  const desde = new Date().toISOString();
  await enviar(mensaje(pasos[k], k === 0, ultimoInteractivo));
  const out = await salidasDesde(desde);
  const inter = [...out].reverse().find((o) => o.contenido?.interactive);
  if (inter) ultimoInteractivo = inter.contenido.interactive;
  resultado.push({ cliente_dice: pasos[k], bot: out.map(legible) });
  if (!JSON_OUT) {
    console.log(`\n▶ Cliente: ${pasos[k]}`);
    for (const l of out.map(legible)) {
      console.log(`  ◀ [${l.tipo}/${l.estado}] ${l.texto ?? l.cuerpo ?? ''}${l.botones ? `  {${l.botones.join(' | ')}}` : ''}${l.media ? `  (media)` : ''}${l.error ? `  ⚠ ${l.error}` : ''}`);
    }
    if (!out.length) console.log('  ◀ (el bot no mandó nada)');
  }
}
if (JSON_OUT) console.log(JSON.stringify(resultado, null, 2));
