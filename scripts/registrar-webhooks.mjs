#!/usr/bin/env node
// Registra los webhooks del sistema de WhatsApp de Voltra (Node 26, sin dependencias).
//
//   node scripts/registrar-webhooks.mjs            → registra (idempotente: no duplica)
//   node scripts/registrar-webhooks.mjs --dry-run  → imprime lo que haría, sin red
//   WA_PIN=xxxxxx node scripts/registrar-webhooks.mjs --solo-registrar-numero
//        → POST /{phone-number-id}/register (el PIN llega por entorno desde desplegar.sh; nunca en un archivo)
//
// Lee .env.produccion si existe (las variables ya exportadas tienen prioridad). Nunca imprime secretos.
//
// Qué hace:
//   Meta     · (si hay WA_APP_ID) configura el webhook de la app: POST /{app-id}/subscriptions
//              con callback_url + verify_token + campos, con token de app (app_id|app_secret).
//            · POST /{waba-id}/subscribed_apps (suscribe la app a la WABA) y lo confirma con GET.
//            · Comprueba que la función responde al GET de verificación con el verify token.
//   Shopify  · token de la app (client credentials), lista webhookSubscriptions y crea solo los que faltan
//              (ORDERS_CREATE, ORDERS_UPDATED, DRAFT_ORDERS_CREATE) con webhookSubscriptionCreate (2026-10, campo `uri`).
//   Telegram · setWebhook con secret_token y allowed_updates; confirma con getWebhookInfo.

import { existsSync } from 'node:fs';
import { join, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';
import { randomBytes } from 'node:crypto';

const RAIZ = join(dirname(fileURLToPath(import.meta.url)), '..');
const ENV_FILE = process.env.ENV_PRODUCCION ?? join(RAIZ, '.env.produccion');
if (existsSync(ENV_FILE)) process.loadEnvFile(ENV_FILE); // no pisa variables ya exportadas

const GRAPH = 'https://graph.facebook.com/v25.0';
const SHOPIFY_API = '2026-10';
export const TOPICOS_SHOPIFY = ['ORDERS_CREATE', 'ORDERS_UPDATED', 'DRAFT_ORDERS_CREATE'];
export const CAMPOS_META = ['messages', 'phone_number_quality_update', 'account_update', 'message_template_status_update'];
export const ALLOWED_UPDATES_TELEGRAM = ['callback_query', 'message'];

const args = new Set(process.argv.slice(2));
const DRY = args.has('--dry-run');
const env = (k) => (process.env[k] ?? '').trim();

export function urls(ref) {
  const base = `https://${ref || '<SUPABASE_PROJECT_REF>'}.supabase.co/functions/v1`;
  return { wa: `${base}/wa-webhook`, shopify: `${base}/shopify-webhook`, telegram: `${base}/telegram-webhook` };
}

export function dominioTienda(store) {
  const limpio = store.trim().replace(/^https?:\/\//, '').replace(/\/.*$/, '');
  return limpio.endsWith('.myshopify.com') ? limpio : `${limpio}.myshopify.com`;
}

const U = urls(env('SUPABASE_PROJECT_REF'));
let fallas = 0;
const ok = (m) => console.log(`    OK  ${m}`);
const mal = (m) => { fallas++; console.log(`    X   ${m}`); };
const info = (m) => console.log(`    ${m}`);
const faltan = (lista) => lista.filter((k) => !env(k));

async function pedir(url, opciones = {}, ms = 20000) {
  const r = await fetch(url, { ...opciones, signal: AbortSignal.timeout(ms) });
  const texto = await r.text();
  let json = null;
  try { json = JSON.parse(texto); } catch { /* no es JSON */ }
  return { status: r.status, ok: r.ok, texto, json };
}
const errorMeta = (j) => j?.error ? `${j.error.code ?? ''} ${j.error.error_user_msg ?? j.error.message ?? ''}`.trim() : '';

// ── Meta ──────────────────────────────────────────────────────────────────────
async function meta() {
  console.log('\nMeta (WhatsApp)');
  const req = ['SUPABASE_PROJECT_REF', 'WA_TOKEN', 'WA_WABA_ID', 'WA_VERIFY_TOKEN'];
  if (DRY) {
    if (env('WA_APP_ID')) info(`POST ${GRAPH}/<WA_APP_ID>/subscriptions object=whatsapp_business_account callback_url=${U.wa} fields=${CAMPOS_META.join(',')} (token de app)`);
    else info('Sin WA_APP_ID: la URL del webhook y los campos se configuran a mano en el panel de la app [ENRIQUE].');
    info(`POST ${GRAPH}/<WA_WABA_ID>/subscribed_apps (Bearer WA_TOKEN) y GET para confirmar`);
    info(`GET ${U.wa}?hub.mode=subscribe&hub.verify_token=<WA_VERIFY_TOKEN>&hub.challenge=<aleatorio> → 200 con el challenge`);
    const f = faltan(req); if (f.length) info(`(faltan para el registro real: ${f.join(', ')})`);
    return;
  }
  const f = faltan(req);
  if (f.length) return mal(`faltan variables: ${f.join(', ')}`);

  // 1) La función tiene que responder al GET de verificación antes de que Meta lo pruebe.
  const challenge = randomBytes(8).toString('hex');
  const q = new URLSearchParams({ 'hub.mode': 'subscribe', 'hub.verify_token': env('WA_VERIFY_TOKEN'), 'hub.challenge': challenge });
  try {
    const r = await pedir(`${U.wa}?${q}`);
    if (r.status === 200 && r.texto === challenge) ok('wa-webhook responde al GET de verificación con el verify token');
    else return mal(`wa-webhook no devolvió el challenge (HTTP ${r.status}). ¿Está desplegada y con WA_VERIFY_TOKEN igual?`);
    const q2 = new URLSearchParams({ 'hub.mode': 'subscribe', 'hub.verify_token': 'token-incorrecto', 'hub.challenge': challenge });
    const r2 = await pedir(`${U.wa}?${q2}`);
    if (r2.status === 403) ok('con un token incorrecto responde 403');
    else mal(`con un token incorrecto respondió HTTP ${r2.status} (esperado 403)`);
  } catch (e) { return mal(`no pude llamar a wa-webhook: ${e.message}`); }

  // 2) Webhook de la app (si hay WA_APP_ID).
  if (env('WA_APP_ID') && env('WA_APP_SECRET')) {
    const cuerpo = new URLSearchParams({
      object: 'whatsapp_business_account',
      callback_url: U.wa,
      verify_token: env('WA_VERIFY_TOKEN'),
      fields: CAMPOS_META.join(','),
      include_values: 'true',
      access_token: `${env('WA_APP_ID')}|${env('WA_APP_SECRET')}`,
    });
    const r = await pedir(`${GRAPH}/${env('WA_APP_ID')}/subscriptions`, { method: 'POST', body: cuerpo });
    if (r.json?.success) ok(`webhook de la app → ${U.wa} (campos: ${CAMPOS_META.join(', ')})`);
    else mal(`no pude configurar el webhook de la app: ${errorMeta(r.json) || `HTTP ${r.status}`}`);
  } else {
    info('Sin WA_APP_ID: confirmá en developers.facebook.com → tu app → WhatsApp → Configuración que la URL');
    info(`de devolución sea ${U.wa}, el token sea WA_VERIFY_TOKEN y estén suscriptos: ${CAMPOS_META.join(', ')} [ENRIQUE]`);
  }

  // 3) Suscribir la app a la WABA (idempotente).
  const auth = { Authorization: `Bearer ${env('WA_TOKEN')}` };
  const r = await pedir(`${GRAPH}/${env('WA_WABA_ID')}/subscribed_apps`, { method: 'POST', headers: auth });
  if (r.json?.success) ok('app suscripta a la WABA');
  else return mal(`subscribed_apps falló: ${errorMeta(r.json) || `HTTP ${r.status}`}`);
  const g = await pedir(`${GRAPH}/${env('WA_WABA_ID')}/subscribed_apps`, { headers: auth });
  const apps = g.json?.data ?? [];
  if (apps.length) ok(`apps suscriptas a la WABA: ${apps.length}`);
  else mal('GET subscribed_apps no devolvió ninguna app');
}

async function registrarNumero() {
  console.log('\nMeta · registro del número en la Cloud API');
  const pin = env('WA_PIN');
  if (DRY) return info(`POST ${GRAPH}/<WA_PHONE_NUMBER_ID>/register {messaging_product:"whatsapp", pin:<6 dígitos>}`);
  const f = faltan(['WA_TOKEN', 'WA_PHONE_NUMBER_ID']);
  if (f.length) return mal(`faltan variables: ${f.join(', ')}`);
  if (!/^\d{6}$/.test(pin)) return mal('WA_PIN tiene que ser de 6 dígitos (lo pide desplegar.sh --registrar-numero)');
  const r = await pedir(`${GRAPH}/${env('WA_PHONE_NUMBER_ID')}/register`, {
    method: 'POST',
    headers: { Authorization: `Bearer ${env('WA_TOKEN')}`, 'Content-Type': 'application/json' },
    body: JSON.stringify({ messaging_product: 'whatsapp', pin }),
  });
  if (r.json?.success) ok('número registrado (límite de Meta: 10 intentos cada 72 h)');
  else mal(`register falló: ${errorMeta(r.json) || `HTTP ${r.status}`}`);
}

// ── Shopify ───────────────────────────────────────────────────────────────────
async function shopify() {
  console.log('\nShopify');
  const req = ['SUPABASE_PROJECT_REF', 'SHOPIFY_STORE', 'SHOPIFY_CLIENT_ID', 'SHOPIFY_CLIENT_SECRET'];
  if (DRY) {
    info(`POST https://<SHOPIFY_STORE>/admin/oauth/access_token (client credentials)`);
    info(`query webhookSubscriptions → crea solo los que falten de ${TOPICOS_SHOPIFY.join(', ')} con uri=${U.shopify}`);
    const f = faltan(req); if (f.length) info(`(faltan para el registro real: ${f.join(', ')})`);
    return;
  }
  const f = faltan(req);
  if (f.length) return mal(`faltan variables: ${f.join(', ')}`);
  const tienda = dominioTienda(env('SHOPIFY_STORE'));
  const t = await pedir(`https://${tienda}/admin/oauth/access_token`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
    body: new URLSearchParams({ grant_type: 'client_credentials', client_id: env('SHOPIFY_CLIENT_ID'), client_secret: env('SHOPIFY_CLIENT_SECRET') }),
  });
  const token = t.json?.access_token;
  if (!token) return mal(`Shopify no entregó token (HTTP ${t.status}). Revisá client id/secret e instalación de la app.`);

  const gql = async (query, variables = {}) => {
    const r = await pedir(`https://${tienda}/admin/api/${SHOPIFY_API}/graphql.json`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', 'X-Shopify-Access-Token': token },
      body: JSON.stringify({ query, variables }),
    });
    if (r.json?.errors) throw new Error(r.json.errors.map((e) => e.message).join('; '));
    if (!r.ok) throw new Error(`HTTP ${r.status}`);
    return r.json.data;
  };

  try {
    const d = await gql(`query { webhookSubscriptions(first: 100) { nodes { id topic uri } } }`);
    const existentes = d.webhookSubscriptions.nodes;
    for (const topic of TOPICOS_SHOPIFY) {
      const igual = existentes.find((w) => w.topic === topic && w.uri === U.shopify);
      if (igual) { ok(`${topic} ya existe (${igual.id})`); continue; }
      const otro = existentes.find((w) => w.topic === topic && /\/functions\/v1\/shopify-webhook$/.test(w.uri ?? ''));
      if (otro) info(`${topic}: hay otro apuntando a ${otro.uri}; se crea el nuevo y el viejo queda (borralo si es de otro proyecto)`);
      const c = await gql(
        `mutation crear($topic: WebhookSubscriptionTopic!, $webhookSubscription: WebhookSubscriptionInput!) {
           webhookSubscriptionCreate(topic: $topic, webhookSubscription: $webhookSubscription) {
             webhookSubscription { id topic uri } userErrors { field message } } }`,
        { topic, webhookSubscription: { uri: U.shopify } },
      );
      const errs = c.webhookSubscriptionCreate.userErrors;
      if (errs.length) mal(`${topic}: ${errs.map((e) => e.message).join('; ')}`);
      else ok(`${topic} creado (${c.webhookSubscriptionCreate.webhookSubscription.id})`);
    }
  } catch (e) {
    mal(`GraphQL: ${e.message} (¿la app tiene read_orders y read_draft_orders?)`);
  }
}

// ── Telegram ──────────────────────────────────────────────────────────────────
async function telegram() {
  console.log('\nTelegram');
  const req = ['SUPABASE_PROJECT_REF', 'TELEGRAM_BOT_TOKEN', 'TELEGRAM_WEBHOOK_SECRET'];
  if (DRY) {
    info(`POST api.telegram.org/bot<TOKEN>/setWebhook url=${U.telegram} secret_token=<TELEGRAM_WEBHOOK_SECRET> allowed_updates=${JSON.stringify(ALLOWED_UPDATES_TELEGRAM)}`);
    info('getWebhookInfo para confirmar');
    const f = faltan(req); if (f.length) info(`(faltan para el registro real: ${f.join(', ')})`);
    return;
  }
  const f = faltan(req);
  if (f.length) return mal(`faltan variables: ${f.join(', ')}`);
  if (!/^[A-Za-z0-9_-]{1,256}$/.test(env('TELEGRAM_WEBHOOK_SECRET'))) return mal('TELEGRAM_WEBHOOK_SECRET: solo letras, números, _ y -');
  const base = `https://api.telegram.org/bot${env('TELEGRAM_BOT_TOKEN')}`; // nunca se imprime
  try {
    const r = await pedir(`${base}/setWebhook`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ url: U.telegram, secret_token: env('TELEGRAM_WEBHOOK_SECRET'), allowed_updates: ALLOWED_UPDATES_TELEGRAM }),
    });
    if (!r.json?.ok) return mal(`setWebhook falló: ${r.json?.description ?? `HTTP ${r.status}`}`);
    ok('setWebhook aceptado');
    const i = await pedir(`${base}/getWebhookInfo`);
    const w = i.json?.result ?? {};
    if (w.url === U.telegram) ok(`webhook → ${w.url} (pendientes: ${w.pending_update_count ?? 0})`);
    else mal(`getWebhookInfo devuelve otra URL: ${w.url ?? '(vacía)'}`);
    if (w.last_error_message) info(`último error que vio Telegram: ${w.last_error_message}`);
  } catch (e) {
    mal(`no pude llamar a Telegram: ${e.message}`);
  }
}

async function main() {
  if (args.has('--ayuda') || args.has('--help')) {
    console.log('Uso: node scripts/registrar-webhooks.mjs [--dry-run] [--solo-registrar-numero]');
    return;
  }
  if (DRY) console.log('Modo --dry-run: no se llama a ninguna API.');
  if (args.has('--solo-registrar-numero')) await registrarNumero();
  else { await meta(); await shopify(); await telegram(); }
  if (fallas) { console.log(`\n${fallas} problema(s).`); process.exitCode = 1; }
  else console.log(DRY ? '\nFin del dry-run.' : '\nWebhooks registrados.');
}

if (import.meta.main) await main();
