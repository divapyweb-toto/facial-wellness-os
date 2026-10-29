#!/usr/bin/env node
// scripts/tarifas-courier.mjs · 20-10-2026
// Lee el CSV local de tarifas CON COBRANZA (PaP + Lucero, una fila por ciudad) y escribe por stdout el SQL que
// carga public.tarifas_courier y config 'tarifas_zona_pap'. Los datos NO van al repo (es público): solo este script.
//
//   node scripts/tarifas-courier.mjs ~/Negocios/datos-couriers/tarifas-cobranza-2026-10-20.csv 2026-10-20 > /tmp/t.sql
//   supabase db query --linked -f /tmp/t.sql
//
// Columnas: ciudad, pap_zona, pap_precio, pap_tiempo, pap_cobranza, pap_agencia, lucero_precio, lucero_tiempo, …
// Volver a correrlo con la misma fecha reemplaza esa carga; con otra fecha suma una versión nueva (queda histórico).
import { readFileSync } from 'node:fs'

const [csvPath, vigente = new Date().toISOString().slice(0, 10)] = process.argv.slice(2)
if (!csvPath || !/^\d{4}-\d{2}-\d{2}$/.test(vigente)) {
  console.error('uso: node scripts/tarifas-courier.mjs <archivo.csv> [AAAA-MM-DD]')
  process.exit(1)
}

// Misma normalización que public.ciudad_norm (ver migración 20261020000001).
export const norm = (t) => String(t ?? '').toLowerCase()
  .normalize('NFD').replace(/[̀-ͯ]/g, '')
  .replace(/\(.*?\)/g, ' ')
  .replace(/\b(cnel|cnl)\.?(\s|$)/g, 'coronel ').replace(/\bgral\.?(\s|$)/g, 'general ').replace(/\b(pdte|pte)\.?(\s|$)/g, 'presidente ')
  .replace(/[^a-z0-9' ]+/g, ' ').replace(/\s+/g, ' ').trim()

// Misma ciudad escrita distinto en las dos listas → una sola clave.
const UNIR = { itagua: 'itaugua' }
// Grafías que escriben los clientes (normalizadas). Nada genérico que pueda pisar otra ciudad ("san pedro", "santa rosa").
// 26-10: + grafías reales de ventas sin tarifa (Cd. Del Este, CiudadDe este, Asucioñ, Frenando, santo del guaira).
const ALIAS = {
  'ciudad del este': ['cuidad del este', 'cde', 'ciudad del este cde', 'cd del este', 'ciudadde este'],
  'salto del guaira': ['salto del guara', 'saltos del guaira', 'santo del guaira'],
  'yby yau': ['ybyyau'],
  'itaugua': ['itagua'],
  'j augusto saldivar': ['julian augusto saldivar', 'augusto saldivar'],
  'dr j eulogio estigarribia': ['eulogio estigarribia', 'doctor juan eulogio estigarribia'],
  "juan e o'leary": ['juan e oleary', 'juan eulogio oleary'],
  'mariano roque alonso': ['mra'],
  'pedro juan caballero': ['pjc'],
  'san pedro del ycuamandyju': ['san pedro del ycuamandiyu', 'san pedro de ycuamandyyu'],
  'santani': ['san estanislao'],
  'san ignacio misiones': ['san ignacio'],
  'colonia independencia': ['independencia'],
  'juan leon mallorquin': ['mallorquin'],
  'fernando de la mora': ['fdo de la mora', 'frenando de la mora'],
  'asuncion': ['asucion'],
  'mauricio jose troche': ['troche'],
  // 29-10: grafías reales sin tarifa (#1159 Mbocayaty; Villa Rica). Mismos que la migración 20261029000002.
  'mbocajaty': ['mbocayaty'],
  'villarrica': ['villa rica'],
}
// Días hábiles desde el despacho. PaP cuenta sus horas desde Asunción: +1 día al máximo por el tramo CDE → Asunción.
const DIAS_PAP = { '24HS': [1, 2], '24/48HS': [1, 3], '48/72HS': [2, 4], '72/96HS': [3, 5] }
const DIAS_LUCERO = { '24 hs': [1, 2], '24 a 48 hs': [1, 2], '48 a 72 hs': [2, 5], '72 hs': [3, 5] }
const CDE = new Set(['ciudad del este', 'hernandarias', 'minga guazu', 'presidente franco'])

const filas = readFileSync(csvPath, 'utf8').trim().split(/\r?\n/)
const cab = filas.shift().split(',')
const parse = (l) => { // CSV simple (sin comas dentro de los campos)
  const v = l.split(','); return Object.fromEntries(cab.map((c, i) => [c.trim(), (v[i] ?? '').trim()]))
}
const q = (s) => s == null ? 'null' : `'${String(s).replace(/'/g, "''")}'`
const arr = (a) => `array[${a.map(q).join(',')}]::text[]`

const out = new Map() // `${courier}|${clave}` → fila
const zonas = {}
for (const r of filas.map(parse)) {
  let k = norm(r.ciudad); k = UNIR[k] ?? k
  const nombre = r.ciudad.replace(/\s+/g, ' ').replace(/\s*\(.*?\)\s*/g, ' ').trim()
  const titulo = nombre === nombre.toUpperCase() ? nombre.toLowerCase().replace(/(^|\s)\S/g, (m) => m.toUpperCase()) : nombre
  if (r.pap_precio) {
    const p = Number(r.pap_precio), z = r.pap_zona.toUpperCase()
    zonas[z] = Math.max(zonas[z] ?? 0, p)
    const [dmin, dmax] = DIAS_PAP[r.pap_tiempo.toUpperCase()] ?? [null, null]
    out.set(`pap|${k}`, { courier: 'pap', k, titulo, zona: z, precio: p, tiempo: r.pap_tiempo, dmin, dmax,
      cobranza: /^s[ií]$/i.test(r.pap_cobranza), agencia: /^s[ií]$/i.test(r.pap_agencia) })
  }
  if (r.lucero_precio) {
    const [dmin, dmax] = CDE.has(k) ? [0, 1] : (DIAS_LUCERO[r.lucero_tiempo.toLowerCase()] ?? [null, null])
    // Si la misma ciudad viene dos veces (p. ej. Itaguá / ITAUGUA), gana el nombre con tilde y minúsculas.
    const prev = out.get(`lucero|${k}`)
    out.set(`lucero|${k}`, { courier: 'lucero', k, titulo: prev?.titulo ?? titulo, zona: null, precio: Number(r.lucero_precio),
      tiempo: r.lucero_tiempo, dmin, dmax, cobranza: true, agencia: null })
  }
}
zonas['INTERIOR 3'] ??= zonas['INTERIOR 2'] // PaP: Interior 2 y 3 cobran lo mismo (tarifario oficial)

const valores = [...out.values()].map((f) => `(${q(f.courier)}, ${q(f.k)}, ${q(f.titulo)}, ${arr(ALIAS[f.k] ?? [])}, ${q(f.zona)}, ${f.precio}, ` +
  `${q(f.tiempo)}, ${f.dmin ?? 'null'}, ${f.dmax ?? 'null'}, ${f.cobranza}, ${f.agencia ?? 'null'}, ${q(vigente)})`)

console.log(`-- generado por scripts/tarifas-courier.mjs desde ${csvPath.split('/').pop()} · ${out.size} filas
begin;
delete from public.tarifas_courier where vigente_desde = ${q(vigente)};
insert into public.tarifas_courier (courier, ciudad, ciudad_nombre, alias, zona, precio, tiempo, dias_min, dias_max, aplica_cobranza, tiene_agencia, vigente_desde) values
${valores.join(',\n')};
insert into public.config (clave, valor) values ('tarifas_zona_pap', ${q(JSON.stringify(zonas))})
  on conflict (clave) do update set valor = excluded.valor, actualizado = now();
commit;`)
