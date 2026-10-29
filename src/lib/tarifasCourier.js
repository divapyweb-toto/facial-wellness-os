// src/lib/tarifasCourier.js · 20-10-2026
// ═══════════════════════════════════════════════════════════
// TARIFAS CON COBRANZA POR COURIER Y CIUDAD (copia en memoria de la base)
//
// La fuente es la base (migración 20261020000001_tarifas_courier.sql):
//   · vista tarifas_courier_vigente  → precio, zona, tiempo y si COBRA contra entrega, por courier y ciudad
//   · vista tasa_entrega_courier     → tasa de entrega usada por courier (respaldo 85 Lucero / 75 PaP)
//   · config 'tarifas_zona_pap'      → precio por zona de PaP, para ciudades fuera de la tabla
// Los precios NO están en el código (el repo es público): se cargan al iniciar la app, igual que cargarConfig().
//
// Si la carga falla o vuelve vacía (p. ej. todavía sin sesión: la tabla tiene RLS), la caché queda "sin cargar"
// y transportadoras.js sigue con el comportamiento viejo (flete plano de Config, lista de cobertura del código).
//
// tarifaCourier y sugerirCourier son la MISMA lógica que las funciones SQL public.tarifa_courier y
// public.sugerir_courier: si cambia una, cambiar la otra.
// ═══════════════════════════════════════════════════════════
import { supabase } from './supabase'
// 29-10: la misma clave fonética que public.ciudad_fonetica (migración 20261029000002): "Mbocayaty" = "Mbocajaty".
import { claveFonetica } from '../../supabase/functions/_shared/sale_hoy.js'

// Tasa de entrega de respaldo (la misma que usa la vista con menos de 10 pedidos resueltos).
export const TASA_RESPALDO = { lucero: 85, pap: 75 }
export const COURIERS_TARIFA = ['pap', 'lucero']

// Misma normalización que public.ciudad_norm y que `norm` de scripts/tarifas-courier.mjs: minúsculas, sin tildes,
// sin lo que va entre paréntesis, cnel/cnl → coronel, gral → general, pdte/pte → presidente, signos → espacio.
export const normCiudad = (t) => String(t ?? '').toLowerCase()
  .normalize('NFD').replace(/[̀-ͯ]/g, '')
  .replace(/\(.*?\)/g, ' ')
  .replace(/\b(cnel|cnl)\.?(\s|$)/g, 'coronel ').replace(/\bgral\.?(\s|$)/g, 'general ').replace(/\b(pdte|pte)\.?(\s|$)/g, 'presidente ')
  .replace(/[^a-z0-9' ]+/g, ' ').replace(/\s+/g, ' ').trim()

// ── Caché ──
// null = sin cargar. Forma: { tarifas: [fila de la vista], tasas: { pap: {...}, lucero: {...} }, zonasPaP: {...} | null }
let datos = null
let estado = { hecho: false, filas: 0, error: null }
let enCurso = null

export const tarifasCourierCargadas = () => datos != null
export const getEstadoTarifasCourier = () => ({ ...estado })

const aEntero = (v) => (v == null || v === '' || !Number.isFinite(Number(v)) ? null : Number(v))

function limpiarFila(f) {
  const ciudad = normCiudad(f?.ciudad)
  const precio = aEntero(f?.precio)
  if (!ciudad || !COURIERS_TARIFA.includes(f?.courier) || !(precio > 0)) return null
  return {
    courier: f.courier,
    ciudad,
    ciudad_nombre: f.ciudad_nombre || ciudad,
    alias: (Array.isArray(f.alias) ? f.alias : []).map(normCiudad).filter(Boolean),
    zona: f.zona ?? null,
    precio,
    tiempo: f.tiempo ?? null,
    dias_min: aEntero(f.dias_min),
    dias_max: aEntero(f.dias_max),
    aplica_cobranza: f.aplica_cobranza === true,
    tiene_agencia: f.tiene_agencia ?? null,
  }
}

function limpiarTasas(filas) {
  const out = {}
  for (const c of COURIERS_TARIFA) {
    const f = (filas || []).find((x) => x?.courier === c)
    const tasa = aEntero(f?.tasa_usada)
    out[c] = f && tasa != null
      ? { tasa_usada: tasa, pocos_datos: f.pocos_datos === true, resueltos: aEntero(f.resueltos) ?? 0 }
      // Sin la vista: el mismo respaldo que usa ella con pocos datos.
      : { tasa_usada: TASA_RESPALDO[c], pocos_datos: true, resueltos: 0 }
  }
  return out
}

function limpiarZonas(z) {
  let obj = z
  if (typeof z === 'string') { try { obj = JSON.parse(z) } catch { obj = null } }
  if (!obj || typeof obj !== 'object') return null
  const out = {}
  for (const [k, v] of Object.entries(obj)) { const n = aEntero(v); if (n > 0) out[String(k).toUpperCase()] = n }
  return Object.keys(out).length ? out : null
}

// Arma la caché a partir de datos crudos (los de la base, o los de un test). Sin tarifas válidas → sin cargar.
// fijarTarifasCourier(null) la vacía.
export function fijarTarifasCourier(crudo) {
  if (!crudo) { datos = null; return false }
  const tarifas = (crudo.tarifas || []).map(limpiarFila).filter(Boolean)
  if (!tarifas.length) { datos = null; return false }
  // 26-10: preferirLucero = config.courier_preferir_lucero.activo (regla del MANDATO v2: Lucero donde llega).
  datos = { tarifas, tasas: limpiarTasas(crudo.tasas), zonasPaP: limpiarZonas(crudo.zonasPaP), preferirLucero: crudo.preferirLucero === true }
  return true
}

// config.valor es texto JSON ({"activo": true}); cualquier cosa rara = apagado.
function leerActivo(valor) {
  try { return (typeof valor === 'string' ? JSON.parse(valor) : valor)?.activo === true } catch { return false }
}

// Trae las fuentes de la base. Nunca tira: si falla, la caché queda como estaba y se anota el error.
export async function cargarTarifasCourier() {
  if (enCurso) return enCurso
  enCurso = (async () => {
    try {
      const [rt, rs, rz, rp] = await Promise.all([
        supabase.from('tarifas_courier_vigente')
          .select('courier, ciudad, ciudad_nombre, alias, zona, precio, tiempo, dias_min, dias_max, aplica_cobranza, tiene_agencia'),
        supabase.from('tasa_entrega_courier').select('courier, entregados, resueltos, tasa_medida, pocos_datos, tasa_usada'),
        supabase.from('config').select('valor').eq('clave', 'tarifas_zona_pap').maybeSingle(),
        supabase.from('config').select('valor').eq('clave', 'courier_preferir_lucero').maybeSingle(),
      ])
      if (rt.error) throw rt.error
      const ok = fijarTarifasCourier({
        tarifas: rt.data || [],
        tasas: rs.error ? [] : (rs.data || []),
        zonasPaP: rz.error ? null : rz.data?.valor,
        preferirLucero: leerActivo(rp.error ? null : rp.data?.valor),
      })
      estado = {
        hecho: true,
        filas: ok ? datos.tarifas.length : 0,
        error: ok ? (rs.error ? `tasas: ${rs.error.message}` : null) : 'la tabla de tarifas vino vacía (¿sin sesión?)',
      }
    } catch (e) {
      estado = { hecho: true, filas: datos?.tarifas.length || 0, error: e?.message || String(e) }
    } finally {
      enCurso = null
    }
    return tarifasCourierCargadas()
  })()
  return enCurso
}

// Carga solo si todavía no cargó (para llamarla al abrir Despacho, ya con sesión).
export const asegurarTarifasCourier = () => (tarifasCourierCargadas() ? Promise.resolve(true) : cargarTarifasCourier())

// ── Búsqueda de la ciudad (= public.tarifa_courier) ──
// Clave exacta o alias → si no, la ciudad/alias más larga contenida como palabras completas en el texto →
// 29-10: si no, la misma clave fonética entera (y→j, v→b, z→s, sin espacios ni letras repetidas).
const contiene = (texto, palabra) => (' ' + texto + ' ').includes(' ' + palabra + ' ')

export function filaTarifa(courier, ciudad, d = datos) {
  if (!d) return null
  const k = normCiudad(ciudad)
  if (!k) return null
  const f = claveFonetica(ciudad)
  let mejor = null, mejorOrden = 9, mejorLargo = -1
  for (const v of d.tarifas) {
    if (v.courier !== courier) continue
    const exacta = v.ciudad === k || v.alias.includes(k)
    const parcial = !exacta && (contiene(k, v.ciudad) || v.alias.some((a) => contiene(k, a)))
    // 29-10: último intento (orden 2), la clave fonética ENTERA de la ciudad o de un alias (= public.tarifa_courier).
    const fonetica = !exacta && !parcial && (claveFonetica(v.ciudad) === f || v.alias.some((a) => claveFonetica(a) === f))
    if (!exacta && !parcial && !fonetica) continue
    const orden = exacta ? 0 : parcial ? 1 : 2
    const largo = Math.max(v.ciudad.length, ...v.alias.filter((a) => contiene(k, a)).map((a) => a.length), 0)
    if (orden < mejorOrden || (orden === mejorOrden && largo > mejorLargo)) { mejor = v; mejorOrden = orden; mejorLargo = largo }
  }
  return mejor
}

// Tarifa de un courier para una ciudad escrita libre.
// → { courier, ciudad, precio, zona, tiempo, dias_min, dias_max, cobranza, agencia, estimado } | null
// Sin match: PaP sale por la zona más cara (INTERIOR 2) con estimado=true; Lucero null. Sin caché: null.
export function tarifaCourier(courier, ciudad, d = datos) {
  if (!d) return null
  const v = filaTarifa(courier, ciudad, d)
  if (v) {
    return {
      courier, ciudad: v.ciudad_nombre, precio: v.precio, zona: v.zona, tiempo: v.tiempo,
      dias_min: v.dias_min, dias_max: v.dias_max, cobranza: v.aplica_cobranza, agencia: v.tiene_agencia, estimado: false,
    }
  }
  const zona = d.zonasPaP?.['INTERIOR 2']
  if (courier === 'pap' && normCiudad(ciudad) && zona > 0) {
    return { courier: 'pap', ciudad: null, precio: zona, zona: 'INTERIOR 2', tiempo: null, dias_min: 3, dias_max: 5, cobranza: null, agencia: null, estimado: true }
  }
  return null
}

// Courier sugerido (no asigna nada) = public.sugerir_courier. 26-10: con preferirLucero, Lucero donde es válido.
// Entre los que COBRAN contra entrega en esa ciudad (tarifas no estimadas), el de menor precio ÷ (tasa/100).
// Con cod=false (pago anticipado) cuenta también donde el courier llega sin cobranza.
export function sugerirCourier(ciudad, { cod = true } = {}, d = datos) {
  if (!d) return null
  const op = COURIERS_TARIFA.map((courier) => {
    const t = tarifaCourier(courier, ciudad, d)
    const te = d.tasas?.[courier] || {}
    const tasa = te.tasa_usada ?? null
    const valido = t != null && !t.estimado && (!cod || t.cobranza === true)
    const costo = t && tasa ? Math.round(t.precio / (tasa / 100)) : null
    return { courier, t, tasa, pocos_datos: te.pocos_datos ?? null, resueltos: te.resueltos ?? null, valido, costo }
  })
  // Orden de la SQL: costo ascendente, nulos al final, empate por nombre de courier.
  const porCosto = (a, b) => (a.costo == null) - (b.costo == null) || (a.costo ?? 0) - (b.costo ?? 0) || a.courier.localeCompare(b.courier)
  const validos = op.filter((o) => o.valido).sort(porCosto)
  // 26-10: con la regla activa, si Lucero es válido (cobra acá, o llega con pago anticipado) → Lucero.
  const regla = d.preferirLucero && validos.some((o) => o.courier === 'lucero') ? 'preferir_lucero' : 'costo'
  return {
    ciudad,
    sugerido: regla === 'preferir_lucero' ? 'lucero' : (validos[0]?.courier ?? null),
    regla,
    sugerido_costo: validos[0]?.courier ?? null,
    sin_cobertura: validos.length === 0,
    // false = ningún courier tiene la ciudad en su tabla (typo o pueblo chico): no avisar "sin cobertura" por esto solo.
    ciudad_reconocida: op.some((o) => o.t != null && !o.t.estimado),
    opciones: op.filter((o) => o.t != null).sort(porCosto).map((o) => ({
      courier: o.courier, precio: o.t.precio, estimado: !!o.t.estimado, cobranza: o.t.cobranza, zona: o.t.zona,
      tiempo: o.t.tiempo, dias_min: o.t.dias_min, dias_max: o.t.dias_max,
      tasa: o.tasa, pocos_datos: o.pocos_datos, resueltos: o.resueltos,
      costo_por_entregado: o.costo, valido: o.valido,
    })),
  }
}

// ── Texto para Despacho ──
const NOMBRE = { pap: 'PaP', lucero: 'Lucero' }
const miles = (n) => Number(n || 0).toLocaleString('es-PY')
const cien = (n) => Math.round((n || 0) / 100) * 100

// Una línea: "Sugerido por costo: Lucero · Lucero A ÷ 93% = X · PaP B ÷ 75% (pocos datos) = Y" (precios de la tabla).
// → { texto, nivel: 'ok' | 'sin_cobertura' | 'desconocida' } | null (sin caché)
export function textoSugerenciaCosto(s, { cod = true } = {}) {
  if (!s) return null
  if (!s.ciudad_reconocida) return { texto: 'Ciudad fuera de las tablas de tarifas: sin sugerencia por costo (¿mal escrita?)', nivel: 'desconocida' }
  const partes = s.opciones.map((o) => {
    const n = NOMBRE[o.courier] || o.courier
    if (o.estimado) return `${n} sin tarifa para esta ciudad`
    if (cod && o.cobranza !== true) return `${n} no cobra contra entrega acá`
    return `${n} ${miles(o.precio)} ÷ ${Math.round(o.tasa)}%${o.pocos_datos ? ' (pocos datos)' : ''} = ${miles(cien(o.costo_por_entregado))}`
  })
  if (s.sin_cobertura) {
    return { texto: [cod ? 'Sin cobertura contra entrega' : 'Sin cobertura', ...partes].join(' · '), nivel: 'sin_cobertura' }
  }
  if (s.regla === 'preferir_lucero') {
    const nota = s.sugerido_costo && s.sugerido_costo !== 'lucero' ? ` (por costo sería ${NOMBRE[s.sugerido_costo] || s.sugerido_costo})` : ''
    return { texto: [`Sugerido: Lucero, llega ${cod ? 'con cobranza' : 'a esta ciudad'}${nota}`, ...partes].join(' · '), nivel: 'ok' }
  }
  return { texto: [`Sugerido por costo: ${NOMBRE[s.sugerido] || s.sugerido}`, ...partes].join(' · '), nivel: 'ok' }
}
