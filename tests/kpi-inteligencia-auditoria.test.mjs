// tests/kpi-inteligencia-auditoria.test.mjs
// Hallazgos de auditoría 8, 10 y 13 (12-10-2026). Datos inventados (repo público).
// Correr: node --import ./tests/registrar.mjs tests/kpi-inteligencia-auditoria.test.mjs
import { derivarEntrega, agregarEntrega, fmtPorEntregado, KPIS, variacion, MIN_RESUELTO_SEMANA } from '../src/pages/kpi-whatsapp/kpi.js'
import { normalizarParaInteligencia, analizarEntregas, serieRealista, tendenciaRealista, COLUMNA_FECHA_PERIODO, COLUMNAS_INTELIGENCIA } from '../src/lib/inteligenciaEntrega.js'
import { tituloExcelRecompra } from '../src/lib/recompraExcel.js'
import { colorTasa } from '../src/lib/tasaEntrega.js'

let fallas = 0
const ok = (c, m) => { console.log(`${c ? '✓' : '✗'} ${m}`); if (!c) fallas++ }
const kpi = (clave) => KPIS.find(k => k.clave === clave)

// ── 10. KPI WhatsApp: 5 entregados, 0 no, 28 confirmados ──
const semEnCamino = { semana: '2026-10-05', pedidos: 33, confirmados: 28, entregados: 5, no_entregados: 0,
  pct_entregados: 100, costo_mensajes_usd: 15.1, costo_mensajes_por_entregado_usd: 3.02,
  costo_ia_usd: 9.145, costo_ia_por_entregado_usd: 1.829 }
const d = derivarEntrega(semEnCamino)
ok(d.en_camino === 23, `en camino = 28 − 5 − 0 = 23 (${d.en_camino})`)
ok(Math.abs(d.pct_resuelto - 5 / 28 * 100) < 1e-9, 'resuelto = 5/28')
ok(d.semana_resuelta === false, 'semana con 18% resuelto no está resuelta')
const ent = kpi('pct_entrega_esperada')
ok(!!ent && ent.etiqueta === 'Entregados', 'la tarjeta Entregados usa la tasa esperada')
ok(ent.valor(d) !== '100 %' && !ent.valor(d).startsWith('100'), `ya no dice 100% (${ent.valor(d)})`)
ok(ent.valor(d).startsWith('~'), 'muestra "~esperada"')
ok(ent.sub(d).includes('5 de 28 confirmados') && ent.sub(d).includes('23 en camino'), `sub: ${ent.sub(d)}`)
ok(ent.color(d) === 'var(--text-secondary)', 'muestra chica → color neutro, nunca verde')
ok(fmtPorEntregado(d, 'costo_mensajes_por_entregado_usd') === 'parcial', 'mensajes/entregado → parcial')
ok(kpi('costo_ia_por_entregado_usd').valor(d) === 'parcial', 'IA/entregado → parcial')
ok(kpi('costo_mensajes_por_entregado_usd').sub(d).includes('18 % resuelto'), 'sub indica el % resuelto')

// Semana resuelta (≥ 80%): el costo por entregado se muestra
const semCerrada = { semana: '2026-09-28', pedidos: 31, confirmados: 30, entregados: 22, no_entregados: 6,
  costo_mensajes_usd: 11, costo_mensajes_por_entregado_usd: 0.5, costo_ia_por_entregado_usd: 0.25 }
const dc = derivarEntrega(semCerrada)
ok(dc.semana_resuelta && dc.pct_resuelto >= MIN_RESUELTO_SEMANA, `28/30 resuelto → resuelta (${dc.pct_resuelto.toFixed(1)}%)`)
ok(fmtPorEntregado(dc, 'costo_mensajes_por_entregado_usd').startsWith('US$'), 'semana resuelta → costo en US$')
ok(fmtPorEntregado(derivarEntrega({ confirmados: 0 }), 'costo_ia_por_entregado_usd') === '—', 'sin datos → —')

// agregarEntrega: la proyección usa la tasa de las semanas resueltas (≥ 20 resueltos)
const lista = agregarEntrega([semEnCamino, semCerrada])
ok(lista[0].tasa_entrega.fuente === 'historica', 'proyecta con la historia de semanas cerradas')
ok(Math.abs(lista[0].tasa_entrega.tasaUsada - 22 / 28) < 1e-9, 'tasa usada = 22/28 de la semana cerrada')
ok(lista[0].sin_respuesta === undefined && lista[0].pedidos === 33, 'conserva las columnas de la vista')

// variacion: no compara semanas sin resolver
ok(variacion(ent, lista[0], lista[1]) === null, 'Entregados: sin variación si una semana está abierta')
ok(variacion(kpi('pedidos'), lista[0], lista[1]) !== null, 'Pedidos sigue comparando')

// ── 8. Inteligencia: filtro por fecha de ingreso + categoría de Lucero ──
ok(COLUMNA_FECHA_PERIODO === 'fecha_ingreso', 'el período se filtra por fecha_ingreso')
ok(COLUMNAS_INTELIGENCIA.includes('transportadora') && COLUMNAS_INTELIGENCIA.includes('categoria'),
  'se leen transportadora y categoria (las necesita sanearEntrega)')
const filas = [
  { transportadora: 'lucero', estado_pap: 'Entregado', categoria: 'entregado', ciudad: 'Ciudad A', fecha_ingreso: '2026-09-01', fecha_entrega: '2026-09-03' },
  { transportadora: 'lucero', estado_pap: 'Cancelado', categoria: 'devuelto', ciudad: 'Ciudad A', fecha_ingreso: '2026-09-02', fecha_entrega: null },
  { transportadora: 'lucero', estado_pap: 'Aceptado', categoria: 'en_proceso', ciudad: 'Ciudad A', fecha_ingreso: '2026-10-10', fecha_entrega: null },
  { transportadora: 'pap', estado_pap: 'Entregado', categoria: 'entregado', ciudad: 'Ciudad B', fecha_ingreso: '2026-09-05', fecha_entrega: '2026-09-07' },
  { transportadora: 'pap', estado_pap: 'Borrador', categoria: 'en_proceso', ciudad: 'Ciudad B', fecha_ingreso: '2026-09-06', fecha_entrega: null },
  { transportadora: 'pap', estado_pap: 'En custodia', motivo: 'Fin de custodia', ciudad: 'Ciudad B', fecha_ingreso: '2026-09-06', fecha_entrega: null },
]
const norm = normalizarParaInteligencia(filas)
ok(norm.length === 5, 'el borrador (nunca salió) queda afuera')
ok(norm[1].categoria === 'devuelto', 'Lucero "Cancelado" sigue devuelto (antes caía en en_proceso)')
ok(norm[2].categoria === 'en_proceso', 'Lucero "Aceptado" = en camino')
ok(norm[4].categoria === 'devuelto', 'PaP "fin de custodia" = devuelto (regla única)')
ok(norm.every(e => e.fecha), 'todas tienen fecha (de ingreso) aunque no tengan fecha_entrega')
const a = analizarEntregas(norm, 30000)
ok(a.entregados === 2 && a.devueltos === 2 && a.enProceso === 1, `totales 2/2/1 (${a.entregados}/${a.devueltos}/${a.enProceso})`)
const ciudadA = a.porCiudad.find(g => g.clave === 'Ciudad A')
ok(ciudadA.resueltos === 2 && ciudadA.tasa === 0.5 && ciudadA.enProceso === 1, 'Lucero ya no sale 100%: 1 de 2 resueltos + 1 en camino')

// Serie y tendencia: con muestra chica no hay tendencia
const serie = serieRealista(norm)
ok(serie.length === 2 && serie[1].mes === '2026-10' && serie[1].enCamino === 1, 'serie por mes de ingreso incluye en camino')
ok(tendenciaRealista(serie) === null, 'meses con pocos resueltos → sin tendencia')
const muchos = (mes, e, d) => [
  ...Array.from({ length: e }, () => ({ categoria: 'entregado', fecha: `${mes}-10` })),
  ...Array.from({ length: d }, () => ({ categoria: 'devuelto', fecha: `${mes}-10` })),
]
const tend = tendenciaRealista(serieRealista([...muchos('2026-08', 16, 8), ...muchos('2026-09', 21, 4)]))
ok(tend && tend.sube && tend.delta === 17, `tendencia con resueltos suficientes (+${tend?.delta})`)
ok(colorTasa(serie[1].t, { verde: 70, amarillo: 55 }) === 'var(--text-secondary)', 'mes con muestra chica → neutro')

// ── 13. Excel de recompra: título según tienda ──
ok(tituloExcelRecompra('voltra') === 'VOLTRA', 'voltra → VOLTRA')
ok(tituloExcelRecompra('fw') === 'FACIAL WELLNESS', 'fw → FACIAL WELLNESS')
ok(!/FACIAL|VOLTRA$/.test(tituloExcelRecompra('todas')), `todas → neutro (${tituloExcelRecompra('todas')})`)
ok(tituloExcelRecompra() === 'VOLTRA', 'por defecto (sin localStorage) → VOLTRA')

if (fallas) { console.error(`\n${fallas} falla(s)`); process.exit(1) }
console.log('\nTodo OK')
