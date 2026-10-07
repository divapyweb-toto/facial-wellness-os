// Valida las plantillas reales de supabase/plantillas/ con las reglas del script.
// Correr: node --test tests/plantillas-wa.test.mjs
import { test } from 'node:test';
import assert from 'node:assert/strict';
import {
  validarTodas, validarPlantilla, cargarPalabrasProhibidas, buscarProhibida, cuerpoParaMeta
} from '../scripts/crear-plantillas-wa.mjs';

const ESPERADAS = [
  'voltra_confirmacion_pedido', 'voltra_entrega_hoy', 'voltra_no_entregado',
  'voltra_pedido_despachado', 'voltra_recordatorio_confirmacion', 'voltra_seguimiento_entrega',
  'voltra_recuperar_borrador',
  'voltra_mk_cruzada', 'voltra_mk_lanzamiento', 'voltra_mk_pack', 'voltra_mk_reposicion'
].sort();
const palabras = cargarPalabrasProhibidas();

test('las 11 plantillas (7 de utilidad + 4 voltra_mk_ de marketing) existen y pasan la validación', () => {
  const r = validarTodas();
  assert.deepEqual(r.map((x) => x.plantilla.name).sort(), ESPERADAS);
  for (const { archivo, errores } of r) assert.deepEqual(errores, [], archivo);
  for (const { plantilla: p } of r) assert.equal(p.category, p.name.startsWith('voltra_mk_') ? 'MARKETING' : 'UTILITY', p.name);
});

test('la confirmación y el recordatorio llevan Confirmar / Corregir datos / Cancelar con los payloads del contrato', () => {
  for (const x of validarTodas().filter((x) => /confirmacion/.test(x.plantilla.name))) {
    const botones = x.plantilla.components.find((c) => c.type === 'BUTTONS').buttons.map((b) => b.text);
    assert.deepEqual(botones, ['Confirmar', 'Corregir datos', 'Cancelar']);
    assert.deepEqual(x.plantilla._notas.botones_payload, ['conf_si', 'conf_corregir', 'conf_cancelar']);
  }
});

test('lo que se manda a Meta no lleva las notas internas', () => {
  const p = validarTodas()[0].plantilla;
  assert.equal('_notas' in cuerpoParaMeta(p), false);
  assert.deepEqual(Object.keys(cuerpoParaMeta(p)).sort(), ['category', 'components', 'language', 'name']);
});

test('detecta palabras prohibidas sin importar tildes ni mayúsculas', () => {
  assert.equal(buscarProhibida('Tenés GARANTIA total', palabras), 'garantía');
  assert.equal(buscarProhibida('compra sin  riesgo', palabras), 'sin riesgo');
  assert.equal(buscarProhibida('te lo curamos', palabras), 'cura'); // conjugaciones de curar también
  assert.equal(buscarProhibida('esto cura todo', palabras), 'cura');
  assert.equal(buscarProhibida('procuramos llegar hoy', palabras), null);
});

const base = () => ({
  name: 'voltra_prueba', language: 'es', category: 'UTILITY',
  components: [
    { type: 'BODY', text: 'Hola {{1}}, tu pedido de Voltra ({{2}}) está en camino hacia tu casa.', example: { body_text: [['Ana', 'Tiras']] } },
    { type: 'BUTTONS', buttons: [{ type: 'QUICK_REPLY', text: 'Necesito ayuda' }] }
  ],
  _notas: { variables: ['nombre', 'producto'], botones_payload: ['ayuda'] }
});
const errores = (mod) => { const p = base(); mod(p); return validarPlantilla(p, palabras).join(' | '); };

test('rechaza los errores típicos de Meta', () => {
  assert.equal(errores(() => {}), '');
  assert.match(errores((p) => { p.components[0].example.body_text = [['Ana']]; }), /ejemplos/);
  assert.match(errores((p) => { delete p.components[0].example; }), /faltan los ejemplos/);
  assert.match(errores((p) => { p.components[0].text = '{{1}}, tu pedido de Voltra ({{2}}) está en camino hacia tu casa.'; }), /empezar/);
  assert.match(errores((p) => { p.components[0].text = 'Hola, tu pedido de Voltra está en camino hacia tu casa {{1}} {{2}}.'; }), /terminar|pegadas/);
  assert.match(errores((p) => { p.components[0].text = 'Hola {{1}}, tu pedido de Voltra ({{3}}) está en camino hacia tu casa.'; }), /fuera de orden/);
  assert.match(errores((p) => { p.components[0].text += ' Con garantía.'; }), /prohibida/);
  assert.match(errores((p) => { p.category = 'MARKETING'; }), /utilidad/);
  assert.match(errores((p) => { p.language = 'es_PY'; }), /idioma/);
  assert.match(errores((p) => {
    p.components[1].buttons = ['A', 'B', 'C', 'D'].map((t) => ({ type: 'QUICK_REPLY', text: t }));
    p._notas.botones_payload = ['a', 'b', 'c', 'd'];
  }), /más de 3 botones/);
  assert.match(errores((p) => { p.components[1].buttons[0].text = 'x'.repeat(26); }), /límite de Meta/);
  assert.match(errores((p) => { p.components[1].buttons[0].text = 'x'.repeat(21); }), /más de 20/);
  assert.match(errores((p) => { p.components[0].text = 'Hola {{1}} {{2}} ok listo ya.'; }), /pegadas|demasiadas/);
});

test('MARKETING solo se permite con prefijo voltra_mk_', () => {
  // Nombre sin voltra_mk_ con MARKETING → rechazada (también con prefijos parecidos).
  assert.match(errores((p) => { p.category = 'MARKETING'; }), /se esperaba UTILITY/);
  assert.match(errores((p) => { p.name = 'voltra_mkt_prueba'; p.category = 'MARKETING'; }), /se esperaba UTILITY/);
  // voltra_mk_ con MARKETING → OK; voltra_mk_ con UTILITY → rechazada (sería una oferta disfrazada).
  assert.equal(errores((p) => { p.name = 'voltra_mk_prueba'; p.category = 'MARKETING'; }), '');
  assert.match(errores((p) => { p.name = 'voltra_mk_prueba'; }), /se esperaba MARKETING/);
  assert.match(errores((p) => { p.name = 'voltra_mk_prueba'; p.category = 'AUTHENTICATION'; }), /categoría/);
});

// ─── Semilla de config_wa (integración ola 1) ───
import { readFileSync } from 'node:fs';

function jsonDeSemilla(archivo = 'seed_config_wa.sql') {
  const sql = readFileSync(new URL(`../supabase/${archivo}`, import.meta.url), 'utf8')
    .split('\n').filter((l) => !l.trim().startsWith('--')).join('\n');
  const filas = {};
  // ('clave', '<json>'::jsonb)
  for (const m of sql.matchAll(/\(\s*'([a-z_]+)'\s*,\s*'((?:[^']|'')*)'::jsonb\s*\)/g)) {
    filas[m[1]] = JSON.parse(m[2].replace(/''/g, "'"));
  }
  return filas;
}

function textos(x, out = []) {
  if (typeof x === 'string') out.push(x);
  else if (Array.isArray(x)) x.forEach((v) => textos(v, out));
  else if (x && typeof x === 'object') Object.values(x).forEach((v) => textos(v, out));
  return out;
}

test('la semilla de config_wa tiene todas las claves que leen las funciones', () => {
  const f = jsonDeSemilla();
  for (const k of [
    'palabras_prohibidas', 'horario_marketing', 'plazos_courier', 'tarifas_usd', 'confirmacion',
    'aceptaciones', 'respuestas_confirmacion', 'plantillas_cancelables_al_responder', 'textos_botones',
    'textos_decisiones', 'prefijos_courier', 'usar_texto_libre_en_ventana', 'textos_libres',
    'horario_avisos_envio', 'procesar_envios', 'salud_canal',
  ]) assert.ok(k in f, `falta ${k}`);
  assert.deepEqual(Object.keys(f.respuestas_confirmacion).sort(), ['a_corregir', 'cancelado', 'confirmado']);
  assert.deepEqual(Object.keys(f.textos_decisiones).sort(), ['cancelado', 'escribo', 'reposicion']);
  assert.deepEqual(f.horario_avisos_envio, { desde: 8, hasta: 20 });
  assert.deepEqual(f.prefijos_courier.lucero, ['VT-', 'FW-']);
  assert.equal(f.usar_texto_libre_en_ventana, false);
  assert.ok(f.textos_botones.consentimiento_si.length <= 20 && f.textos_botones.consentimiento_no.length <= 20);
});

test('ningún texto de la semilla usa palabras prohibidas', () => {
  const f = jsonDeSemilla();
  const { palabras_prohibidas, ...resto } = f;
  assert.ok(palabras_prohibidas.length >= 8);
  for (const t of textos(resto)) assert.equal(buscarProhibida(t, palabras), null, t);
  for (const t of textos(jsonDeSemilla('seed_integracion.sql'))) assert.equal(buscarProhibida(t, palabras), null, t);
});

test('seed_integracion.sql trae las claves del contrato y el link de la bandeja sin ?c= (lo agrega auditoria-diaria)', () => {
  const f = jsonDeSemilla('seed_integracion.sql');
  assert.deepEqual(Object.keys(f).sort(), ['auditoria', 'textos_marketing', 'transcripcion']);
  assert.deepEqual(f.transcripcion, { proveedor: 'elevenlabs_scribe_v2', usd_por_hora: 0.27, con_palabras_clave: true });
  assert.equal(f.auditoria.url_bandeja, 'https://divapyweb-toto.github.io/facial-wellness-os/#/bandeja');
  assert.deepEqual(Object.keys(f.textos_marketing).sort(), ['baja_confirmada', 'mas_adelante']);
});
