#!/usr/bin/env node
// Prueba de punta a punta del sistema de WhatsApp de Voltra contra producción (Node 26, sin dependencias).
//
//   node scripts/prueba-e2e.mjs                 → modo seguro (por defecto): no manda nada a nadie
//   node scripts/prueba-e2e.mjs --solo-lectura  → solo mira: funciones responden y tablas existen
//   node scripts/prueba-e2e.mjs --real          → deja salir la confirmación REAL a PRUEBA_TELEFONO
//   node scripts/prueba-e2e.mjs --ayuda
//
// Lee .env.produccion si existe. Usa SUPABASE_PROJECT_REF, SUPABASE_SERVICE_ROLE_KEY,
// SHOPIFY_CLIENT_SECRET, SHOPIFY_STORE y PRUEBA_TELEFONO. Nunca imprime secretos.
//
// Modo seguro, paso a paso:
//   1. Cada función de supabase/functions (descubiertas por carpeta) responde: cualquier HTTP < 500
//      que no sea 404 (401 = pide JWT, 405 = solo POST: esperados).
//   2. Cada tabla creada en supabase/migrations/*.sql existe (consulta de solo lectura, limit 0).
//   3. Un webhook de Shopify con firma INVÁLIDA → tiene que dar 401.
//   4. Un webhook orders/create firmado con un pedido de PRUEBA (id fuera del rango de Shopify,
//      nombre #PRUEBA-E2E, tag PRUEBA_E2E, teléfono PRUEBA_TELEFONO) → 200.
//   5. Espera a que aparezcan los envíos programados (conf, rec, ret, canc) del pedido de prueba.
//   6. Los cancela antes de que venzan (la confirmación sale a los 2 min) y borra el pedido de prueba
//      y sus envíos. El evento crudo queda en eventos_crudos (id_externo prueba-e2e-...) como registro.
// Con --real: cancela solo rec/ret/canc (ret y canc actuarían sobre Shopify), deja la confirmación,
// espera hasta 4 min a que procesar-envios la mande y muestra el resultado.

import { existsSync, readdirSync, readFileSync } from 'node:fs';
import { join, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';
import { createHmac, randomBytes } from 'node:crypto';

const RAIZ = join(dirname(fileURLToPath(import.meta.url)), '..');
const ENV_FILE = process.env.ENV_PRODUCCION ?? join(RAIZ, '.env.produccion');
const DIR_FUNCIONES = join(RAIZ, 'supabase', 'functions');
const DIR_MIGRACIONES = join(RAIZ, 'supabase', 'migrations');

const args = new Set(process.argv.slice(2));
const AYUDA = args.has('--ayuda') || args.has('--help');
const SOLO_LECTURA = args.has('--solo-lectura');
const REAL = args.has('--real');

export function listarFunciones(dir = DIR_FUNCIONES) {
  return readdirSync(dir, { withFileTypes: true })
    .filter((d) => d.isDirectory() && !d.name.startsWith('_') && existsSync(join(dir, d.name, 'index.ts')))
    .map((d) => d.name)
    .sort();
}

export function listarTablas(dir = DIR_MIGRACIONES) {
  const tablas = new Set();
  for (const f of readdirSync(dir).filter((x) => x.endsWith('.sql')).sort()) {
    const sql = readFileSync(join(dir, f), 'utf8').replace(/--.*$/gm, '');
    for (const m of sql.matchAll(/create\s+table\s+(?:if\s+not\s+exists\s+)?(?:public\.)?"?([a-z_][a-z0-9_]*)"?/gi)) {
      tablas.add(m[1].toLowerCase());
    }
  }
  return [...tablas].sort();
}

/** Teléfono enmascarado para mostrar: +5959****000 */
export const enmascarar = (t) => (t.length > 6 ? `${t.slice(0, 5)}****${t.slice(-3)}` : '****');

/** Id del pedido de prueba: por encima de los ids reales de Shopify y dentro de Number.MAX_SAFE_INTEGER. */
export const idPrueba = () => 8_800_000_000_000_000 + (Date.now() % 1_000_000_000);

export function pedidoDePrueba(id, telefono) {
  return {
    id,
    admin_graphql_api_id: `gid://shopify/Order/${id}`,
    name: '#PRUEBA-E2E',
    created_at: new Date().toISOString(),
    phone: telefono,
    total_price: '1000',
    currency: 'PYG',
    tags: 'PRUEBA_E2E',
    cancelled_at: null,
    line_items: [{ title: 'Producto de prueba', quantity: 1 }],
    shipping_address: { name: 'Cliente Prueba', first_name: 'Cliente', last_name: 'Prueba', address1: 'Calle de prueba 123', city: 'Ciudad del Este', phone: telefono },
    customer: { first_name: 'Cliente', last_name: 'Prueba', phone: telefono },
    note_attributes: [],
  };
}

export const firmaShopify = (cuerpo, secreto) => createHmac('sha256', secreto).update(cuerpo, 'utf8').digest('base64');

function ayuda() {
  console.log(`Prueba de punta a punta (producción).

  node scripts/prueba-e2e.mjs                 modo seguro: simula un pedido de PRUEBA, verifica que se
                                              programaron los envíos, los cancela y borra el pedido. No manda nada.
  node scripts/prueba-e2e.mjs --solo-lectura  solo consulta: funciones responden y tablas existen.
  node scripts/prueba-e2e.mjs --real          deja salir la confirmación al número PRUEBA_TELEFONO (tuyo, nunca un cliente).

Variables (de .env.produccion): SUPABASE_PROJECT_REF, SUPABASE_SERVICE_ROLE_KEY,
SHOPIFY_CLIENT_SECRET, SHOPIFY_STORE, PRUEBA_TELEFONO.

Funciones que revisa (${listarFunciones().length}): ${listarFunciones().join(', ')}
Tablas que revisa (${listarTablas().length}): ${listarTablas().join(', ')}`);
}

// ── ejecución ─────────────────────────────────────────────────────────────────
let fallas = 0;
const ok = (m) => console.log(`    OK  ${m}`);
const mal = (m) => { fallas++; console.log(`    X   ${m}`); };
const info = (m) => console.log(`    ${m}`);
const dormir = (ms) => new Promise((r) => setTimeout(r, ms));

async function main() {
  if (AYUDA) return ayuda();
  if (existsSync(ENV_FILE)) process.loadEnvFile(ENV_FILE);
  const env = (k) => (process.env[k] ?? '').trim();

  const necesarias = ['SUPABASE_PROJECT_REF', 'SUPABASE_SERVICE_ROLE_KEY'];
  if (!SOLO_LECTURA) necesarias.push('SHOPIFY_CLIENT_SECRET', 'SHOPIFY_STORE', 'PRUEBA_TELEFONO');
  const faltan = necesarias.filter((k) => !env(k));
  if (faltan.length) {
    console.error(`Faltan variables: ${faltan.join(', ')} (completalas en .env.produccion).`);
    process.exitCode = 1;
    return;
  }

  const BASE = `https://${env('SUPABASE_PROJECT_REF')}.supabase.co`;
  const CLAVE = env('SUPABASE_SERVICE_ROLE_KEY');
  const rest = async (ruta, opciones = {}) => {
    const r = await fetch(`${BASE}/rest/v1/${ruta}`, {
      ...opciones,
      headers: { apikey: CLAVE, Authorization: `Bearer ${CLAVE}`, 'Content-Type': 'application/json', ...(opciones.headers ?? {}) },
      signal: AbortSignal.timeout(20000),
    });
    const texto = await r.text();
    let json = null;
    try { json = JSON.parse(texto); } catch { /* vacío */ }
    return { status: r.status, ok: r.ok, json, texto };
  };

  // 1. Funciones
  console.log('\n1. Las funciones responden');
  for (const f of listarFunciones()) {
    try {
      const r = await fetch(`${BASE}/functions/v1/${f}`, { method: 'GET', signal: AbortSignal.timeout(15000) });
      await r.body?.cancel();
      if (r.status === 404 || r.status >= 500) mal(`${f}: HTTP ${r.status} (¿no está desplegada?)`);
      else ok(`${f}: HTTP ${r.status}${r.status === 401 ? ' (pide autenticación: esperado)' : r.status === 405 ? ' (solo POST: esperado)' : ''}`);
    } catch (e) { mal(`${f}: ${e.message}`); }
  }

  // 2. Tablas
  console.log('\n2. Las tablas existen (consulta de solo lectura)');
  for (const t of listarTablas()) {
    try {
      const r = await rest(`${t}?select=*&limit=0`);
      if (r.ok) ok(t);
      else mal(`${t}: HTTP ${r.status} ${r.json?.message ?? ''}`.trim());
    } catch (e) { mal(`${t}: ${e.message}`); }
  }
  const conf = await rest('config_wa?select=clave&clave=eq.confirmacion').catch(() => null);
  if (conf?.ok && conf.json?.length) ok('config_wa tiene la semilla (clave confirmacion)');
  else mal('config_wa no tiene la clave confirmacion (falta la semilla)');

  if (SOLO_LECTURA) return cerrar();

  // 3 y 4. Webhook de Shopify simulado
  const telefono = env('PRUEBA_TELEFONO');
  const id = idPrueba();
  const cuerpo = JSON.stringify(pedidoDePrueba(id, telefono));
  const cabeceras = (firma) => ({
    'Content-Type': 'application/json',
    'X-Shopify-Topic': 'orders/create',
    'X-Shopify-Hmac-Sha256': firma,
    'X-Shopify-Webhook-Id': `prueba-e2e-${id}`,
    'X-Shopify-Shop-Domain': env('SHOPIFY_STORE'),
    'X-Shopify-Event-Id': `prueba-e2e-${randomBytes(4).toString('hex')}`,
    'X-Shopify-API-Version': '2026-10',
  });
  const urlShopify = `${BASE}/functions/v1/shopify-webhook`;

  console.log('\n3. Webhook de Shopify con firma inválida');
  try {
    const r = await fetch(urlShopify, { method: 'POST', headers: cabeceras('firma-invalida'), body: cuerpo, signal: AbortSignal.timeout(15000) });
    await r.body?.cancel();
    if (r.status === 401) ok('rechazado con 401');
    else mal(`respondió HTTP ${r.status} (esperado 401)`);
  } catch (e) { mal(`shopify-webhook: ${e.message}`); }

  console.log(`\n4. Pedido de PRUEBA firmado (id ${id}, teléfono ${enmascarar(telefono)})`);
  try {
    const r = await fetch(urlShopify, { method: 'POST', headers: cabeceras(firmaShopify(cuerpo, env('SHOPIFY_CLIENT_SECRET'))), body: cuerpo, signal: AbortSignal.timeout(15000) });
    const t = await r.text();
    if (r.status === 200) ok(`aceptado (${t})`);
    else { mal(`respondió HTTP ${r.status} ${t}`); return cerrar(); }
  } catch (e) { mal(`shopify-webhook: ${e.message}`); return cerrar(); }

  // 5. Envíos programados
  console.log('\n5. Se programaron los envíos');
  let envios = [];
  for (let i = 0; i < 15 && envios.length < 4; i++) {
    await dormir(2000);
    const r = await rest(`envios_programados?select=id,clave_unica,plantilla,estado,enviar_desde&shopify_order_id=eq.${id}&order=enviar_desde`);
    envios = r.json ?? [];
  }
  if (!envios.length) mal('no apareció ningún envío programado en 30 s (mirá los logs de shopify-webhook y eventos_crudos.error)');
  for (const e of envios) info(`${e.clave_unica.split(':')[0].padEnd(5)} ${e.plantilla.padEnd(34)} ${e.estado.padEnd(10)} ${e.enviar_desde}`);
  const tipos = new Set(envios.map((e) => e.clave_unica.split(':')[0]));
  for (const t of ['conf', 'rec', 'ret', 'canc']) (tipos.has(t) ? ok : mal)(`envío ${t} programado`);

  // 6. Cancelar / limpiar
  if (REAL) {
    console.log('\n6. Modo --real: cancelo rec/ret/canc y dejo salir la confirmación');
    const r = await rest(`envios_programados?shopify_order_id=eq.${id}&estado=eq.pendiente&clave_unica=neq.conf:${id}`, {
      method: 'PATCH', headers: { Prefer: 'return=representation' }, body: JSON.stringify({ estado: 'cancelado' }),
    });
    r.ok ? ok(`${r.json?.length ?? 0} envíos cancelados`) : mal(`no pude cancelar: HTTP ${r.status}`);
    let estado = 'pendiente';
    for (let i = 0; i < 24 && estado === 'pendiente'; i++) {
      await dormir(10000);
      const c = await rest(`envios_programados?select=estado,ultimo_error&clave_unica=eq.conf:${id}`);
      estado = c.json?.[0]?.estado ?? 'desconocido';
      if (estado !== 'pendiente' && c.json?.[0]?.ultimo_error) info(`último error: ${c.json[0].ultimo_error}`);
    }
    (estado === 'enviado' ? ok : mal)(`confirmación: ${estado}${estado === 'enviado' ? ` → revisá WhatsApp en ${enmascarar(telefono)}` : ''}`);
    info(`El pedido de prueba ${id} queda en shopify_pedidos para que pruebes los botones; no existe en Shopify,`);
    info('así que las tags fallan (esperado). Borralo después: delete from shopify_pedidos where shopify_order_id = ' + id + ';');
  } else {
    console.log('\n6. Modo seguro: cancelo los envíos y borro el pedido de prueba');
    const r = await rest(`envios_programados?shopify_order_id=eq.${id}&estado=eq.pendiente`, {
      method: 'PATCH', headers: { Prefer: 'return=representation' }, body: JSON.stringify({ estado: 'cancelado' }),
    });
    r.ok ? ok(`${r.json?.length ?? 0} envíos cancelados antes de vencer`) : mal(`no pude cancelar: HTTP ${r.status}`);
    const yaSalio = envios.some((e) => e.estado !== 'pendiente' && e.estado !== 'cancelado');
    if (yaSalio) mal('algún envío ya no estaba pendiente: revisá envios_programados');
    const d1 = await rest(`envios_programados?shopify_order_id=eq.${id}`, { method: 'DELETE' });
    const d2 = await rest(`shopify_pedidos?shopify_order_id=eq.${id}`, { method: 'DELETE' });
    d1.ok && d2.ok ? ok('pedido de prueba y sus envíos borrados') : mal(`limpieza incompleta (HTTP ${d1.status}/${d2.status}); id ${id}`);
  }
  return cerrar();
}

function cerrar() {
  if (fallas) { console.log(`\n${fallas} prueba(s) fallaron.`); process.exitCode = 1; }
  else console.log('\nTodas las pruebas pasaron.');
}

if (import.meta.main) await main();
