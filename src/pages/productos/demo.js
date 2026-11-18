// src/pages/productos/demo.js
// Datos DEMO del módulo Productos nuevos. TODO es ficticio y genérico:
// nombres, vendedores, proveedores y precios inventados para mostrar la
// pantalla sin base. Se ven con la etiqueta DEMO. No representan datos de
// Voltra ni de ningún proveedor real.

const ahora = Date.now()
const dias = (n) => new Date(ahora + n * 86400000).toISOString()
const C1 = 'demo-cand-0001'
const C2 = 'demo-cand-0002'
const P1 = 'demo-prov-0001'
const P2 = 'demo-prov-0002'
const P3 = 'demo-prov-0003'

// Fotos DEMO: dibujos SVG genéricos generados acá (nada descargado de afuera).
function fotoDemo(titulo, color, forma) {
  const figura = forma === 'clip'
    ? '<rect x="150" y="70" width="100" height="22" rx="8" fill="#f2f2f2"/><path d="M200 92 C 200 150, 170 170, 200 230" stroke="#f2f2f2" stroke-width="10" fill="none"/><rect x="170" y="228" width="60" height="18" rx="6" fill="#f2f2f2"/>'
    : forma === 'caja'
      ? '<rect x="120" y="90" width="160" height="130" rx="8" fill="none" stroke="#f2f2f2" stroke-width="8"/><path d="M120 120 H280" stroke="#f2f2f2" stroke-width="6"/>'
      : '<circle cx="200" cy="140" r="60" fill="none" stroke="#f2f2f2" stroke-width="10"/><path d="M160 210 H240" stroke="#f2f2f2" stroke-width="10"/>'
  const svg = `<svg xmlns="http://www.w3.org/2000/svg" width="400" height="300" viewBox="0 0 400 300"><rect width="400" height="300" fill="${color}"/>${figura}<rect x="12" y="12" width="74" height="26" rx="6" fill="#f59e0b"/><text x="49" y="31" font-family="Arial" font-size="16" font-weight="700" text-anchor="middle" fill="#111">DEMO</text><text x="200" y="282" font-family="Arial" font-size="15" text-anchor="middle" fill="#f2f2f2">${titulo}</text></svg>`
  return 'data:image/svg+xml;charset=utf-8,' + encodeURIComponent(svg)
}

const base = (id, extra) => ({ id, creado_en: dias(-6), actualizado_en: dias(-1), ...extra })

export const DEMO = {
  pi_candidatos: [
    base(C1, { nombre: 'DEMO · Lámpara de lectura recargable', hipotesis: 'DEMO: quien lee de noche quiere una luz que no moleste a la pareja.', categoria: 'hogar', origen: 'demanda', estado: 'SOLICITAR_COTIZACION', etapa: 'COTIZADO', familia_producto: null, siguiente_accion: 'Pedir 3 cotizaciones de la ficha v2 (DEMO)', notas: 'Datos inventados para mostrar la pantalla.', demo: true }),
    base(C2, { nombre: 'DEMO · Organizador de cables', hipotesis: 'DEMO: escritorio desordenado.', categoria: 'oficina', origen: 'producto', estado: 'INVESTIGAR', etapa: 'SUGERIDO', familia_producto: null, siguiente_accion: 'Buscar 5 ofertas en PY (DEMO)', notas: null, demo: true }),
  ],
  pi_fichas: [
    base('demo-ficha-1', { candidato_id: C1, version: 1, spec: { funcion: 'Luz LED con clip', materiales: 'ABS', medidas: '20 × 5 × 3 cm', variante: 'blanca', accesorios: 'cable USB-C', pack: 'caja individual', etiquetado: 'sin marca', garantia: '30 días', criterios_aceptacion: 'enciende 3 niveles; batería ≥ 4 h', imagenes: '' } }),
    base('demo-ficha-2', { candidato_id: C1, version: 2, spec: { funcion: 'Luz LED con clip y brazo flexible', materiales: 'ABS + silicona', medidas: '22 × 5 × 3 cm', variante: 'blanca', accesorios: 'cable USB-C', pack: 'caja individual compacta', etiquetado: 'sin marca', garantia: '30 días', criterios_aceptacion: 'enciende 3 niveles; batería ≥ 4 h; brazo no se afloja', imagenes: '' } }),
  ],
  pi_evidencias: [
    base('demo-ev-1', { candidato_id: C1, tipo: 'observed', campo: 'precio_minorista', valor: '99000', moneda: 'PYG', fuente_url: 'https://ejemplo.invalid/tienda-demo-a', fuente_entidad: 'Tienda DEMO A', observado_en: dias(-3), valido_hasta: dias(4), variante: 'blanca', cobertura: 'DEMO: una sola tienda de CDE', cargado_por: 'demo' }),
    base('demo-ev-2', { candidato_id: C1, tipo: 'observed', campo: 'dias_activo_anuncio', valor: '21', moneda: null, fuente_url: 'https://ejemplo.invalid/biblioteca-demo', fuente_entidad: 'Anunciante DEMO B', observado_en: dias(-10), valido_hasta: dias(-3), variante: null, cobertura: 'DEMO: no prueba ventas', cargado_por: 'demo' }),
    base('demo-ev-3', { candidato_id: C1, tipo: 'supplier_claim', campo: 'certificado', valor: 'CE', moneda: null, fuente_url: null, fuente_entidad: 'Proveedor DEMO 1', observado_en: dias(-2), valido_hasta: null, variante: null, cobertura: 'DEMO: afirmado, no verificado', cargado_por: 'demo' }),
    base('demo-ev-4', { candidato_id: C1, tipo: 'unknown', campo: 'tributos', valor: null, moneda: null, fuente_url: null, fuente_entidad: null, observado_en: null, valido_hasta: null, variante: null, cobertura: 'DEMO: falta clasificación con despachante', cargado_por: 'demo' }),
  ],
  pi_ofertas_competencia: [
    base('demo-of-1', { candidato_id: C1, vendedor: 'Tienda DEMO A', vendedor_clave: 'tiendademoa', comparacion: 'identico', zona: 'CDE', precio_minor: 99000, moneda: 'PYG', tipo_precio: 'minorista contado', incluye_envio: false, url: 'https://ejemplo.invalid/a', observado_en: dias(-3), evidencia_id: null }),
    base('demo-of-2', { candidato_id: C1, vendedor: 'tienda demo a (Instagram)', vendedor_clave: 'tiendademoa', comparacion: 'identico', zona: 'CDE', precio_minor: 105000, moneda: 'PYG', tipo_precio: 'minorista contado', incluye_envio: true, url: 'https://ejemplo.invalid/a-ig', observado_en: dias(-3), evidencia_id: null }),
    base('demo-of-3', { candidato_id: C1, vendedor: 'Bazar DEMO C', vendedor_clave: 'bazardemoc', comparacion: 'equivalente', zona: 'GRAN_ASUNCION', precio_minor: 129000, moneda: 'PYG', tipo_precio: 'minorista promo', incluye_envio: false, url: 'https://ejemplo.invalid/c', observado_en: dias(-2), evidencia_id: null }),
  ],
  pi_proveedores: [
    base(P1, { plataforma: 'local', id_externo: 'DEMO-LOCAL-1', razon_social_declarada: 'Mayorista DEMO CDE', url: null, riesgos: 'DEMO: precio más alto, lote chico', notas: null }),
    base(P2, { plataforma: 'alibaba', id_externo: 'DEMO-ALI-1', razon_social_declarada: 'Proveedor DEMO 1', url: 'https://ejemplo.invalid/p1', riesgos: 'DEMO: certificado no verificado', notas: null }),
    base(P3, { plataforma: '1688', id_externo: 'DEMO-1688-1', razon_social_declarada: 'Fábrica DEMO 2', url: 'https://ejemplo.invalid/p2', riesgos: 'DEMO: necesita agente de compra', notas: null }),
  ],
  pi_cotizaciones: [
    base('demo-cot-1', { candidato_id: C1, proveedor_id: P1, ficha_version: 2, variante: 'blanca', moneda: 'PYG', escalones: [{ cantidad: 10, precio_unit_minor: 45000 }, { cantidad: 50, precio_unit_minor: 40000 }], moq: 10, incoterm: null, lugar: 'CDE', incluye_envio: 'retiro en CDE', plazo_dias: 1, valida_hasta: dias(5), costo_muestra_minor: 45000, peso_bruto_g: 180, unidades_por_caja: 50, medidas_caja_cm: '40×30×30', tipo: 'firme', evidencia_id: null }),
    base('demo-cot-2', { candidato_id: C1, proveedor_id: P2, ficha_version: 2, variante: 'blanca', moneda: 'USD', escalones: [{ cantidad: 50, precio_unit_minor: 320 }, { cantidad: 100, precio_unit_minor: 280 }], moq: 50, incoterm: 'EXW', lugar: 'Shenzhen', incluye_envio: 'no', plazo_dias: 15, valida_hasta: dias(20), costo_muestra_minor: 2500, peso_bruto_g: 170, unidades_por_caja: 100, medidas_caja_cm: '50×40×35', tipo: 'escaparate', evidencia_id: null }),
    base('demo-cot-3', { candidato_id: C1, proveedor_id: P3, ficha_version: 1, variante: 'blanca', moneda: 'CNY', escalones: [{ cantidad: 100, precio_unit_minor: 1650 }], moq: 100, incoterm: null, lugar: 'Yiwu', incluye_envio: 'no', plazo_dias: 10, valida_hasta: dias(-1), costo_muestra_minor: null, peso_bruto_g: null, unidades_por_caja: null, medidas_caja_cm: null, tipo: 'estimada', evidencia_id: null }),
  ],
  pi_escenarios_costo: [],
  pi_casos: [],
  pi_experimentos: [
    base('demo-exp-1', { candidato_id: C1, hipotesis: 'DEMO: 10 unidades locales venden en 7 días por WhatsApp', presupuesto_minor: 280000, perdida_maxima_minor: 200000, metricas: { confirmados: 'meta ≥ 8', costo_por_confirmado: 'tope a definir' }, ventana_desde: null, ventana_hasta: null, criterio_cierre: 'DEMO: 7 días o presupuesto gastado', estado: 'PLANEADO', resultado: null, meta_adset_ids: [], meta_ad_ids: [], familia_producto: null }),
  ],
  pi_trabajos: [
    base('demo-tr-1', { tipo: 'investigar_py', candidato_id: C2, carga: { consulta: 'organizador de cables', zonas: ['CDE', 'GRAN_ASUNCION'] }, estado: 'QUEUED', intento: 0, lease_hasta: null, ejecutor: null, checkpoint: null, bloqueo: null, resultado: null }),
    base('demo-tr-2', { tipo: 'buscar_proveedores', candidato_id: C1, carga: { consulta: 'clip reading light', plataformas: ['alibaba'] }, estado: 'BLOCKED', intento: 1, lease_hasta: dias(-0.1), ejecutor: 'mac-demo', checkpoint: { paso: 'búsqueda', urls: 2 }, bloqueo: 'DEMO: la página pidió verificación (CAPTCHA). No se intenta saltar: hace falta que Enrique la resuelva o se sigue con otra fuente.', resultado: null }),
    base('demo-tr-3', { tipo: 'investigar_py', candidato_id: C1, carga: { consulta: 'lámpara de lectura' }, estado: 'SUCCEEDED', intento: 1, lease_hasta: null, ejecutor: 'mac-demo', checkpoint: null, bloqueo: null, resultado: { evidencias: 2 } }),
  ],
  pi_politicas: [
    // Permiso general DEMO (candidato_id null = vale para todos los productos), sin autorizar.
    base('demo-pol-general', { candidato_id: null, autorizada_texto: null, alcance: { tipo: 'general', negocia: ['precio', 'cantidades', 'color_variante', 'calidad', 'empaque', 'plazos', 'condiciones'], proveedores_max_por_producto: 10, rondas_max_por_producto: 3, seguimiento_dias_habiles: 2 }, permite_envio: false, vigente_hasta: null, autorizada_por: null, autorizada_en: null }),
    base('demo-pol-1', { candidato_id: C1, autorizada_texto: null, alcance: { proveedores_max: 5, mensajes_max: 10, rondas: 2, plazo_dias: 7 }, permite_envio: false, vigente_hasta: null, autorizada_por: null, autorizada_en: null }),
  ],
  pi_mensajes: [
    base('demo-msg-2', { politica_id: 'demo-pol-general', candidato_id: C1, proveedor_id: P3, estado: 'DRAFT', idempotencia: 'demo-pol-general:demo-cand-0001:demo-prov-0003:v1:rfq', original: 'Hello, could you quote 50/100 units in white, with individual box? Evaluation quantities, not a commitment. (DEMO)', traduccion: 'Hola, ¿podés cotizar 50/100 unidades en blanco, con caja individual? Cantidades de evaluación, no un compromiso. (DEMO)', idioma: 'en' }),
    base('demo-msg-1', { politica_id: 'demo-pol-1', proveedor_id: P2, estado: 'DRAFT', idempotencia: 'demo-pol-1:demo-prov-0002:v1:rfq', original: 'Hello, we would like a quotation for 20/50/100 units of the attached spec (v2). These are evaluation quantities, not a commitment. (DEMO)', traduccion: 'Hola, quisiéramos cotización para 20/50/100 unidades de la ficha adjunta (v2). Son cantidades de evaluación, no un compromiso. (DEMO)', idioma: 'en' }),
  ],
  pi_ordenes_compra: [
    base('demo-oc-1', { candidato_id: C1, proveedor_id: P1, cotizacion_id: 'demo-cot-1', plataforma: 'local', variante: 'blanca', cantidad: 10, precio_unit_minor: 45000, envio_minor: 0, total_minor: 450000, moneda: 'PYG', deposito_destino: 'retiro en CDE', forwarder: null, estado: 'BORRADOR', confirmada_texto: null, confirmada_en: null, tracking: null, notas: 'DEMO: orden propuesta, nadie la confirmó' }),
  ],
  pi_fotos: [
    base('demo-foto-1', { candidato_id: C1, storage_path: null, url_externa: fotoDemo('Foto del proveedor (DEMO)', '#1f3a5a', 'clip'), fuente: 'proveedor', es_principal: true, orden: 1, descripcion: 'DEMO: foto de la ficha del proveedor 1' }),
    base('demo-foto-2', { candidato_id: C1, storage_path: null, url_externa: fotoDemo('Empaque según proveedor (DEMO)', '#2a2f45', 'caja'), fuente: 'proveedor', es_principal: false, orden: 2, descripcion: 'DEMO: empaque individual' }),
    base('demo-foto-4', { candidato_id: C1, storage_path: null, url_externa: 'https://ejemplo.invalid/foto-demo-bloqueada.jpg', fuente: 'ia_referencia', es_principal: false, orden: 4, descripcion: 'DEMO: link externo que no carga (muestra el aviso de foto bloqueada)' }),
    base('demo-foto-3', { candidato_id: C1, storage_path: null, url_externa: fotoDemo('Referencia IA (DEMO)', '#3a2a45', 'aro'), fuente: 'ia_referencia', es_principal: false, orden: 3, descripcion: 'DEMO: imagen de referencia hecha con IA, no es el producto real' }),
  ],
  pi_decisiones: [],
  pi_eventos: [],
  // Vista de solo lectura (DEMO): en la base real sale de pedidos de Voltra.
  pi_base_operativa: [
    { familia: 'DEMO', canal: 'WA', pedidos: 100, ticket_prom: 160000, pct_cancelado_antes_despacho: 8, pct_entregado: 85, pct_devuelto: 15, flete_prom: 25000, costo_producto_unit: 30000, ventana_desde: dias(-74).slice(0, 10), ventana_hasta: dias(-14).slice(0, 10) },
    { familia: 'DEMO', canal: 'Web', pedidos: 60, ticket_prom: 150000, pct_cancelado_antes_despacho: 35, pct_entregado: 75, pct_devuelto: 25, flete_prom: 25000, costo_producto_unit: 30000, ventana_desde: dias(-74).slice(0, 10), ventana_hasta: dias(-14).slice(0, 10) },
  ],
  pi_resultado_experimentos: [],
  pi_tasa_acierto: [
    { candidatos_total: 2, candidatos_por_estado: { INVESTIGAR: 1, SOLICITAR_COTIZACION: 1 }, pruebas_total: 1, pruebas_en_curso: 0, pruebas_cerradas: 0, ganadores: 0, no_ganadores: 0, cerradas_sin_dato: 0, acierto_pct: null, pruebas_por_mes: [], criterio_ganador: '>=30 confirmados en 30 dias a <=35.000 PYG por confirmado' },
  ],
}
