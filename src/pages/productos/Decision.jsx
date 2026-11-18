// src/pages/productos/Decision.jsx
// Pestañas Decisión (rúbrica + bloqueos duros), Prueba (experimento con
// resultados reales de pi_resultado_experimentos), Dossier (Markdown) y
// Salida (checklist del proceso de producto nuevo; solo lectura).
import { useState, useMemo, useEffect } from 'react'
import { ShieldAlert, Scale, Save, Copy, Download, FlaskConical, Plus, Rocket, Search, CheckCircle2, AlertTriangle } from 'lucide-react'
import { bloqueosDuros, puntaje, decisionSugerida, PESOS_INICIALES, NOMBRES_DIMENSION, ESTADOS_COMPRA } from '../../lib/productos/rubrica'
import { armarDossier } from '../../lib/productos/dossier'
import { guardarCaso, actualizarCandidato, crearExperimento, actualizarExperimento, leerResultadoExperimentos, probarFamiliaProducto, esModoDemo } from './api'
import { fmtGs, fmtFechaHora, fmtPct, aMinor, deMinorTexto, ESTADOS_CANDIDATO, estadoInfo } from './formato'
import { SEMAFOROS } from './Rentabilidad'
import { derivar, armarDatosDossier } from './derivados'
import { Campo, Vacio, Demo, BadgeEstado } from './ui'

// ─── DECISIÓN ───────────────────────────────────────────────
export function Decision({ d, recargar, toast }) {
  const der = useMemo(() => derivar(d), [d])
  const previo = der.ultimoCaso?.rubrica || {}
  const resumen = der.esc?.resultado?.resumen || {}
  const cpBase = der.esc?.resultado?.escenarios?.base?.resultado?.costoPuesto
  const entradasBase = der.esc?.entradas?.motor || {}

  const [ent, setEnt] = useState(() => ({
    compromiso: previo.caso?.compromiso || 'PROBAR_MUESTRA',
    presupuestoDisponible: previo.caso?.presupuesto?.disponible != null ? String(previo.caso.presupuesto.disponible) : '',
    presupuestoRequerido: resumen.cajaNecesaria != null ? String(resumen.cajaNecesaria) : (resumen.desembolsoLote != null ? String(resumen.desembolsoLote) : ''),
    contribValidada: !!previo.caso?.contribucion?.validada,
    importacionRequerida: previo.caso?.importacion?.requerida ?? der.importa,
    importacionVerificada: !!previo.caso?.importacion?.verificada,
    muestra: previo.caso?.muestra?.estado || 'NO_PEDIDA',
    pilotoMaduro: previo.caso?.evidencia?.pilotoMaduro ?? der.pilotoMaduro,
    semaforoCaja: der.esc?.entradas?.semaforoCaja || previo.caso?.semaforoCaja || 'DESCONOCIDO',
    proveedorFactura: previo.caso?.proveedorFactura ?? null,
  }))
  const [dims, setDims] = useState(() => {
    const base = Object.fromEntries(Object.keys(PESOS_INICIALES).map(k => [k, { valor: '', razon: '', evidencia: '', faltantes: '' }]))
    for (const x of previo.puntaje?.detalle || []) base[x.dimension] = { valor: x.valor == null ? '' : String(x.valor), razon: x.razon || '', evidencia: (x.evidencia || []).join('; '), faltantes: (x.faltantes || []).filter(f => !/sin valoración/.test(f)).join('; ') }
    return base
  })
  const [pesos, setPesos] = useState(() => ({ ...PESOS_INICIALES, ...(previo.puntaje?.pesos || {}) }))
  const [fin, setFin] = useState({ estado: '', segmento: der.ultimoCaso?.segmento || '', oferta: der.ultimoCaso?.oferta || '', canal: der.ultimoCaso?.canal || 'whatsapp', precio: der.ultimoCaso?.precio_prueba_minor != null ? String(der.ultimoCaso.precio_prueba_minor) : '', siguiente: '' })
  const [guardando, setGuardando] = useState(false)
  const setE = (k) => (e) => { const v = e.target.type === 'checkbox' ? e.target.checked : e.target.value; setEnt(p => ({ ...p, [k]: v })) }

  // Costos desconocidos: del costo puesto (con rango → cota por pedido) y de evidencias "Desconocido" de costos (sin cota).
  const costosDesconocidos = useMemo(() => {
    const out = []
    const uv = cpBase?.entradas?.unidadesVendibles
    const upp = entradasBase.unidadesPorPedido || 1
    for (const x of cpBase?.desconocidos || []) out.push({ concepto: x.concepto, maximoPorPedido: uv ? Math.round((x.maxPYG / uv) * upp) : null })
    for (const e of d.evidencias) if (e.tipo === 'unknown' && /costo|flete|tributo|arancel|despacho|agente/.test(e.campo || '')) out.push({ concepto: e.campo, maximoPorPedido: null })
    return out
  }, [cpBase, entradasBase, d.evidencias])

  const n = (t) => (String(t).trim() === '' ? null : aMinor(t, 'PYG'))
  const caso = {
    compromiso: ent.compromiso,
    presupuesto: { disponible: n(ent.presupuestoDisponible), requerido: n(ent.presupuestoRequerido) },
    contribucion: { valor: resumen.contribDespuesAdsConfirmado ?? null, validada: !!ent.contribValidada, denominador: 'pedido confirmado' },
    costosDesconocidos,
    importacion: { requerida: !!ent.importacionRequerida, verificada: !!ent.importacionVerificada },
    muestra: { estado: ent.muestra },
    abastecimiento: { proveedoresDisponibles: der.provConCot },
    evidencia: { ofertasComparables: der.comparables.length, vendedoresIndependientes: der.vendedores, cotizacionesFirmes: der.firmes.length, pilotoMaduro: !!ent.pilotoMaduro },
    semaforoCaja: ent.semaforoCaja,
    proveedorFactura: ent.proveedorFactura,
  }

  let bd = null, pt = null, sug = null, errCalc = null
  try {
    bd = bloqueosDuros(caso)
    const dimsMotor = Object.fromEntries(Object.entries(dims).map(([k, v]) => [k, {
      valor: v.valor === '' ? null : Math.max(0, Math.min(100, Number(v.valor))),
      razon: v.razon || null, evidencia: v.evidencia ? v.evidencia.split(';').map(s => s.trim()).filter(Boolean) : [],
      faltantes: v.faltantes ? v.faltantes.split(';').map(s => s.trim()).filter(Boolean) : [],
    }]))
    const ps = Object.fromEntries(Object.entries(pesos).map(([k, v]) => [k, Number(v) || 0]))
    pt = puntaje(dimsMotor, ps)
    sug = decisionSugerida(caso, { puntaje: pt })
  } catch (e) { errCalc = e.message.replace(/^\[rubrica\]\s*/, '') }

  const estadoFinal = fin.estado || sug?.estado || 'INVESTIGAR'
  let bdFinal = null
  try { bdFinal = bloqueosDuros({ ...caso, compromiso: estadoFinal }) } catch { /* se muestra arriba */ }
  const bloqueaFinal = ESTADOS_COMPRA.includes(estadoFinal) && bdFinal?.bloqueaCompra
  const escalarSinBase = estadoFinal === 'ESCALAR' && !(ent.muestra === 'CONFORME' && ent.pilotoMaduro)

  const guardar = async () => {
    if (bloqueaFinal) { toast('Un bloqueo duro frena ese compromiso. Elegí un estado de investigación o resolvé el bloqueo.', 'error'); return }
    if (escalarSinBase) { toast('No se pasa a ESCALAR sin muestra conforme y piloto con datos propios maduros.', 'error'); return }
    setGuardando(true)
    try {
      const siguiente = fin.siguiente.trim() || sug?.siguienteAccion || null
      await guardarCaso(d.candidato.id, {
        segmento: fin.segmento.trim() || null, oferta: fin.oferta.trim() || null, canal: fin.canal || null,
        precio_prueba_minor: n(fin.precio), escenario_ids: der.esc ? [der.esc.id] : [],
        rubrica: { caso, puntaje: pt, sugerida: sug }, bloqueos: bdFinal, decision: estadoFinal,
      }, d.casos)
      await actualizarCandidato(d.candidato.id, { estado: estadoFinal, siguiente_accion: siguiente })
      toast(`Decisión guardada: ${estadoInfo(estadoFinal).label}`, 'success'); recargar()
    } catch (e) { toast(e.message, 'error') } finally { setGuardando(false) }
  }

  return (
    <div className="pi-col">
      <div className="alert alert-info">
        <Scale size={15} style={{ flexShrink: 0, marginTop: 1 }} />
        <span>Primero los <b>bloqueos duros</b>, después el puntaje. Un bloqueo gana siempre: frena comprar (muestra, lote, reorden, escalar), no frena investigar ni pedir cotizaciones. El puntaje es de <b>prioridad</b>, no una probabilidad de éxito.</span>
      </div>

      <div className="card">
        <div className="section-label">Datos del caso</div>
        <div className="form-grid form-grid-3" style={{ marginTop: 10 }}>
          <Campo label="Compromiso a evaluar"><select className="form-select" value={ent.compromiso} onChange={setE('compromiso')}>{ESTADOS_CANDIDATO.map(e => <option key={e.v} value={e.v}>{e.label}</option>)}</select></Campo>
          <Campo label="Presupuesto autorizado (₲)" hint="Lo que Enrique autorizó para este compromiso."><input className="form-input" value={ent.presupuestoDisponible} onChange={setE('presupuestoDisponible')} inputMode="numeric" /></Campo>
          <Campo label="Plata que pide (₲)" hint="Por defecto: necesidad de caja del último escenario."><input className="form-input" value={ent.presupuestoRequerido} onChange={setE('presupuestoRequerido')} inputMode="numeric" /></Campo>
          <Campo label="Semáforo de caja (A3)" hint="Amarillo o rojo bloquean comprar stock/muestras.">
            <select className="form-select" value={ent.semaforoCaja} onChange={setE('semaforoCaja')}>{SEMAFOROS.map(s => <option key={s.v} value={s.v}>{s.label}</option>)}</select>
          </Campo>
          <Campo label="Muestra">
            <select className="form-select" value={ent.muestra} onChange={setE('muestra')}>
              <option value="NO_PEDIDA">No pedida</option><option value="PENDIENTE">Pendiente</option><option value="CONFORME">Conforme con la ficha</option><option value="DEFECTUOSA">Defectuosa</option>
            </select>
          </Campo>
          <Campo label="Proveedor factura a nombre de Voltra">
            <select className="form-select" value={ent.proveedorFactura === true ? 'si' : ent.proveedorFactura === false ? 'no' : '?'} onChange={e => setEnt(p => ({ ...p, proveedorFactura: e.target.value === 'si' ? true : e.target.value === 'no' ? false : null }))}>
              <option value="?">Sin confirmar</option><option value="si">Sí</option><option value="no">No</option>
            </select>
          </Campo>
          <Campo label=" "><label className="pi-check"><input type="checkbox" checked={!!ent.importacionRequerida} onChange={setE('importacionRequerida')} /> Requiere importar</label></Campo>
          <Campo label=" "><label className="pi-check"><input type="checkbox" checked={!!ent.importacionVerificada} onChange={setE('importacionVerificada')} /> Importación verificada por escrito</label></Campo>
          <Campo label=" "><label className="pi-check"><input type="checkbox" checked={!!ent.pilotoMaduro} onChange={setE('pilotoMaduro')} /> Piloto con datos propios maduros</label></Campo>
          <Campo label=" " span={3}><label className="pi-check"><input type="checkbox" checked={!!ent.contribValidada} onChange={setE('contribValidada')} /> La contribución está validada con datos propios (no estimada)</label></Campo>
        </div>
        <div className="data-row" style={{ marginTop: 10, flexWrap: 'wrap' }}>
          <div className="data-col"><span className="data-label">Contribución después de ads</span><span className="data-value">{resumen.contribDespuesAdsConfirmado != null ? `${fmtGs(resumen.contribDespuesAdsConfirmado)} por confirmado` : 'desconocido'}</span></div>
          <div className="data-col"><span className="data-label">Ofertas comparables</span><span className="data-value">{der.comparables.length}</span></div>
          <div className="data-col"><span className="data-label">Vendedores independientes</span><span className="data-value">{der.vendedores}</span></div>
          <div className="data-col"><span className="data-label">Cotizaciones firmes vigentes</span><span className="data-value">{der.firmes.length}</span></div>
          <div className="data-col"><span className="data-label">Proveedores con cotización vigente</span><span className="data-value">{der.provConCot}</span></div>
          <div className="data-col"><span className="data-label">Costos desconocidos</span><span className="data-value">{costosDesconocidos.length}</span></div>
        </div>
        <p className="pi-sub" style={{ marginTop: 6 }}>{der.esc ? `Escenario usado: ${der.esc.nombre} v${der.esc.version} (${fmtFechaHora(der.esc.calculado_en)}).` : 'Sin escenario guardado: la contribución queda desconocida (guardá uno en Rentabilidad).'}</p>
      </div>

      {errCalc && <div className="alert alert-error"><AlertTriangle size={15} /> {errCalc}</div>}

      {bd && (
        <div className="card">
          <div className="section-label"><ShieldAlert size={12} /> Bloqueos duros para {estadoInfo(ent.compromiso).label}</div>
          {bd.bloqueos.length === 0 ? <p className="pi-desc" style={{ marginTop: 6 }}><CheckCircle2 size={13} color="var(--green)" /> Sin bloqueos duros.</p> : (
            <ul className="pi-bloqueos">{bd.bloqueos.map((b, i) => <li key={i}><span className="badge badge-red">{b.codigo}</span> {b.mensaje}</li>)}</ul>
          )}
          {bd.avisos.length > 0 && <ul className="pi-avisos">{bd.avisos.map((a, i) => <li key={i}><span className="badge badge-yellow">{a.codigo}</span> {a.mensaje}</li>)}</ul>}
        </div>
      )}

      <div className="card">
        <div className="section-label">Rúbrica (pesos editables)</div>
        <div className="table-wrapper" style={{ marginTop: 8 }}>
          <table className="pi-tabla-edit">
            <thead><tr><th>Dimensión</th><th>Peso</th><th>Valor 0-100</th><th>Evidencia (separá con ;)</th><th>Datos faltantes</th><th>Razón</th></tr></thead>
            <tbody>
              {Object.keys(PESOS_INICIALES).map(k => (
                <tr key={k}>
                  <td style={{ whiteSpace: 'normal', minWidth: 160 }}>{NOMBRES_DIMENSION[k]}</td>
                  <td><input className="form-input pi-in pi-in-num" style={{ width: 60 }} value={pesos[k]} onChange={e => setPesos(p => ({ ...p, [k]: e.target.value }))} /></td>
                  <td><input className="form-input pi-in pi-in-num" style={{ width: 70 }} value={dims[k].valor} placeholder="—" onChange={e => setDims(p => ({ ...p, [k]: { ...p[k], valor: e.target.value } }))} /></td>
                  <td><input className="form-input pi-in" value={dims[k].evidencia} onChange={e => setDims(p => ({ ...p, [k]: { ...p[k], evidencia: e.target.value } }))} /></td>
                  <td><input className="form-input pi-in" value={dims[k].faltantes} onChange={e => setDims(p => ({ ...p, [k]: { ...p[k], faltantes: e.target.value } }))} /></td>
                  <td><input className="form-input pi-in" value={dims[k].razon} onChange={e => setDims(p => ({ ...p, [k]: { ...p[k], razon: e.target.value } }))} /></td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
        {pt && (
          <div className="kpi-grid" style={{ marginTop: 10 }}>
            <div className="kpi-card"><div className="kpi-label">Puntaje de prioridad</div><div className="kpi-value">{pt.puntaje} / 100</div><div className="kpi-sub">no es una probabilidad de éxito</div></div>
            <div className="kpi-card"><div className="kpi-label">Cobertura de la evidencia</div><div className={`kpi-value ${pt.cobertura < 0.7 ? 'yellow' : ''}`}>{fmtPct(pt.cobertura, 0)}</div><div className="kpi-sub">parte del peso con valoración</div></div>
          </div>
        )}
      </div>

      {sug && (
        <div className="card">
          <div className="section-label">Decisión sugerida</div>
          <div style={{ display: 'flex', gap: 8, alignItems: 'center', marginTop: 8, flexWrap: 'wrap' }}>
            <BadgeEstado estado={sug.estado} />
            <span>{sug.siguienteAccion}</span>
            <span className="pi-sub">({sug.costoDeLaAccion})</span>
          </div>
          {sug.refutaSi && <p className="pi-sub" style={{ marginTop: 6 }}>La tesis se cae si {sug.refutaSi}.</p>}
          <ul className="pi-avisos">{sug.razones.map((r, i) => <li key={i}>{r}</li>)}</ul>

          <div className="form-grid form-grid-3" style={{ marginTop: 12 }}>
            <Campo label="Estado a guardar">
              <select className="form-select" value={estadoFinal} onChange={e => setFin(p => ({ ...p, estado: e.target.value }))}>
                {ESTADOS_CANDIDATO.map(e => <option key={e.v} value={e.v}>{e.label}{e.v === sug.estado ? ' (sugerido)' : ''}</option>)}
              </select>
            </Campo>
            <Campo label="Segmento"><input className="form-input" value={fin.segmento} onChange={e => setFin(p => ({ ...p, segmento: e.target.value }))} /></Campo>
            <Campo label="Canal">
              <select className="form-select" value={fin.canal} onChange={e => setFin(p => ({ ...p, canal: e.target.value }))}>
                <option value="whatsapp">WhatsApp</option><option value="web">Web</option><option value="mayorista">Mayorista</option><option value="complemento">Complemento de un pedido</option>
              </select>
            </Campo>
            <Campo label="Oferta" span={2}><input className="form-input" value={fin.oferta} onChange={e => setFin(p => ({ ...p, oferta: e.target.value }))} placeholder="qué se ofrece, promesa verificable, política de entrega" /></Campo>
            <Campo label="Precio de prueba (₲, IVA incl.)"><input className="form-input" value={fin.precio} onChange={e => setFin(p => ({ ...p, precio: e.target.value }))} inputMode="numeric" /></Campo>
            <Campo label="Siguiente acción" span={3} hint="La más barata que puede refutar la tesis. Vacío = la sugerida."><input className="form-input" value={fin.siguiente} onChange={e => setFin(p => ({ ...p, siguiente: e.target.value }))} placeholder={sug.siguienteAccion} /></Campo>
          </div>
          {bloqueaFinal && <div className="alert alert-error" style={{ marginTop: 10 }}><ShieldAlert size={15} /> Bloqueado: {bdFinal.bloqueos.map(b => b.codigo).join(', ')}. No se puede guardar un compromiso de compra con bloqueos.</div>}
          {escalarSinBase && <div className="alert alert-error" style={{ marginTop: 10 }}><ShieldAlert size={15} /> No se pasa a ESCALAR sin muestra conforme y piloto con datos propios maduros.</div>}
          <div style={{ display: 'flex', justifyContent: 'flex-end', marginTop: 12 }}>
            <button className="btn btn-primary btn-sm" onClick={guardar} disabled={guardando || bloqueaFinal || escalarSinBase}><Save size={13} /> {guardando ? 'Guardando…' : 'Guardar decisión'}</button>
          </div>
        </div>
      )}

      {d.casos.length > 0 && (
        <div className="table-wrapper">
          <table className="tabla-responsive">
            <thead><tr><th>Versión</th><th>Decisión</th><th>Puntaje (prioridad)</th><th>Bloqueos</th><th>Canal</th><th>Precio de prueba</th><th>Fecha</th></tr></thead>
            <tbody>
              {[...d.casos].sort((a, b) => (b.version || 0) - (a.version || 0)).map(c => (
                <tr key={c.id}>
                  <td data-label="Versión">v{c.version}</td>
                  <td data-label="Decisión"><BadgeEstado estado={c.decision} /></td>
                  <td data-label="Puntaje" className="pi-num">{c.rubrica?.puntaje?.puntaje ?? '—'}</td>
                  <td data-label="Bloqueos">{(c.bloqueos?.bloqueos || []).map(b => b.codigo).join(', ') || '—'}</td>
                  <td data-label="Canal">{c.canal || '—'}</td>
                  <td data-label="Precio" className="pi-num">{fmtGs(c.precio_prueba_minor)}</td>
                  <td data-label="Fecha">{fmtFechaHora(c.creado_en)}</td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      )}
    </div>
  )
}

// ─── PRUEBA ─────────────────────────────────────────────────
const lista = (t) => String(t || '').split(/[\s,;]+/).map(s => s.trim()).filter(Boolean)

export function Prueba({ d, recargar, toast }) {
  const [res, setRes] = useState(undefined)
  const [editando, setEditando] = useState(null) // experimento o {} nuevo
  useEffect(() => { leerResultadoExperimentos(d.candidato.id).then(setRes).catch(() => setRes(null)) }, [d.candidato.id, d.experimentos])

  return (
    <div className="pi-col">
      <div className="alert alert-info">
        <FlaskConical size={15} style={{ flexShrink: 0, marginTop: 1 }} />
        <span>Una prueba tiene hipótesis, presupuesto, pérdida máxima, ventana y criterio de cierre. Los resultados salen de los pedidos reales de Voltra atribuidos a los anuncios cargados (o por familia y canal). Ganador = ≥30 confirmados en 30 días a ≤₲35.000 por confirmado.</span>
      </div>
      <div className="pi-barra">
        <span className="pi-sub">{d.experimentos.length} prueba(s)</span>
        <button className="btn btn-primary btn-sm" onClick={() => setEditando({})}><Plus size={13} /> Nueva prueba</button>
      </div>

      {editando && <FormExperimento d={d} exp={editando} onCerrar={() => setEditando(null)} onListo={() => { setEditando(null); recargar() }} toast={toast} />}

      {d.experimentos.length === 0 && !editando ? (
        <Vacio icono={FlaskConical} titulo="Sin pruebas" desc="Definí la prueba más barata que puede refutar la tesis, con límite de pérdida." />
      ) : d.experimentos.map(x => {
        const r = res?.find(z => z.experimento_id === x.id)
        return (
          <div key={x.id} className="card">
            <div className="pi-barra">
              <div>
                <span className={`badge ${x.estado === 'CERRADO' ? 'badge-gray' : x.estado === 'EN_CURSO' ? 'badge-yellow' : 'badge-blue'}`}>{x.estado}</span>
                <b style={{ marginLeft: 8 }}>{x.hipotesis || 'sin hipótesis'}</b> {esModoDemo() && <Demo />}
              </div>
              <button className="btn btn-ghost btn-sm" onClick={() => setEditando(x)}>Editar</button>
            </div>
            <div className="data-row" style={{ marginTop: 8, flexWrap: 'wrap' }}>
              <div className="data-col"><span className="data-label">Presupuesto</span><span className="data-value">{fmtGs(x.presupuesto_minor)}</span></div>
              <div className="data-col"><span className="data-label">Pérdida máxima</span><span className="data-value">{fmtGs(x.perdida_maxima_minor)}</span></div>
              <div className="data-col"><span className="data-label">Ventana</span><span className="data-value">{x.ventana_desde || '—'} → {x.ventana_hasta || '—'}</span></div>
              <div className="data-col"><span className="data-label">Conjuntos Meta</span><span className="data-value">{(x.meta_adset_ids || []).join(', ') || '—'}</span></div>
              <div className="data-col"><span className="data-label">Anuncios Meta</span><span className="data-value">{(x.meta_ad_ids || []).join(', ') || '—'}</span></div>
              <div className="data-col"><span className="data-label">Familia · canal</span><span className="data-value">{x.familia_producto || '—'} · {x.canal || 'ambos'}</span></div>
            </div>
            {x.criterio_cierre && <p className="pi-sub" style={{ marginTop: 6 }}>Cierre: {x.criterio_cierre}</p>}
            {x.metricas && <p className="pi-sub">Métricas: {Object.entries(x.metricas).map(([k, v]) => `${k}: ${v}`).join(' · ')}</p>}
            <div className="section-label" style={{ marginTop: 10 }}>Resultado real (Voltra OS)</div>
            {res === null ? <p className="pi-desc">La vista pi_resultado_experimentos todavía no está en la base.</p>
              : !r ? <p className="pi-desc">{x.ventana_desde ? 'Sin datos todavía.' : 'Cargá la fecha de inicio de la ventana para que se midan los pedidos.'}</p>
              : (
                <div className="kpi-grid" style={{ marginTop: 6 }}>
                  <div className="kpi-card"><div className="kpi-label">Pedidos válidos</div><div className="kpi-value">{r.pedidos_validos ?? '—'}</div><div className="kpi-sub">atribución: {r.atribucion}</div></div>
                  <div className="kpi-card"><div className="kpi-label">Confirmados</div><div className="kpi-value">{r.confirmados ?? '—'}</div></div>
                  <div className="kpi-card"><div className="kpi-label">Entregados</div><div className="kpi-value green">{r.entregados ?? '—'}</div></div>
                  <div className="kpi-card"><div className="kpi-label">Devueltos</div><div className="kpi-value red">{r.devueltos ?? '—'}</div><div className="kpi-sub">sin resolver: {r.sin_resolver ?? '—'}</div></div>
                  <div className="kpi-card"><div className="kpi-label">Gasto Meta</div><div className="kpi-value">{fmtGs(r.gasto_minor)}</div></div>
                  <div className="kpi-card"><div className="kpi-label">Costo por confirmado</div><div className="kpi-value">{fmtGs(r.costo_por_confirmado)}</div><div className="kpi-sub">denominador: confirmados</div></div>
                  <div className="kpi-card"><div className="kpi-label">Confirmados 30 días</div><div className="kpi-value">{r.confirmados_30d ?? '—'}</div><div className="kpi-sub">gasto 30 d: {fmtGs(r.gasto_30d_minor)}</div></div>
                  <div className="kpi-card"><div className="kpi-label">¿Ganador?</div><div className={`kpi-value ${r.ganador === true ? 'green' : r.ganador === false ? 'red' : ''}`}>{r.ganador === true ? 'Sí' : r.ganador === false ? 'No' : 'Todavía no se sabe'}</div></div>
                </div>
              )}
            {x.resultado && <p className="pi-sub" style={{ marginTop: 6 }}>Cierre manual: {x.resultado.maduro ? 'datos maduros' : 'datos no maduros'}{x.resultado.notas ? ` · ${x.resultado.notas}` : ''}</p>}
          </div>
        )
      })}
    </div>
  )
}

function FormExperimento({ d, exp, onCerrar, onListo, toast }) {
  const [f, setF] = useState({
    hipotesis: exp.hipotesis || '', presupuesto: exp.presupuesto_minor != null ? deMinorTexto(exp.presupuesto_minor) : '',
    perdida: exp.perdida_maxima_minor != null ? deMinorTexto(exp.perdida_maxima_minor) : '', desde: exp.ventana_desde || '', hasta: exp.ventana_hasta || '',
    criterio: exp.criterio_cierre || '', estado: exp.estado || 'PLANEADO', adsets: (exp.meta_adset_ids || []).join(', '), ads: (exp.meta_ad_ids || []).join(', '),
    familia: exp.familia_producto ?? d.candidato.familia_producto ?? '', canal: exp.canal || '',
    metricas: exp.metricas ? Object.entries(exp.metricas).map(([k, v]) => `${k}: ${v}`).join('\n') : 'confirmados: \ncosto_por_confirmado: ',
    maduro: !!exp.resultado?.maduro, notas: exp.resultado?.notas || '',
  })
  const set = (k) => (e) => setF(p => ({ ...p, [k]: e.target.type === 'checkbox' ? e.target.checked : e.target.value }))

  const guardar = async () => {
    const metricas = Object.fromEntries(f.metricas.split('\n').map(l => l.split(':')).filter(p => p[0]?.trim()).map(([k, ...v]) => [k.trim(), v.join(':').trim()]))
    const fila = {
      candidato_id: d.candidato.id, hipotesis: f.hipotesis.trim() || null,
      presupuesto_minor: f.presupuesto ? aMinor(f.presupuesto, 'PYG') : null, perdida_maxima_minor: f.perdida ? aMinor(f.perdida, 'PYG') : null,
      ventana_desde: f.desde || null, ventana_hasta: f.hasta || null, criterio_cierre: f.criterio.trim() || null, estado: f.estado, metricas,
      meta_adset_ids: lista(f.adsets), meta_ad_ids: lista(f.ads), familia_producto: f.familia.trim() || null, canal: f.canal || null,
      resultado: f.estado === 'CERRADO' || f.notas ? { maduro: !!f.maduro, notas: f.notas.trim() || null } : (exp.resultado || null),
    }
    if (fila.presupuesto_minor != null && fila.perdida_maxima_minor != null && fila.perdida_maxima_minor > fila.presupuesto_minor) { toast('La pérdida máxima no puede superar el presupuesto', 'error'); return }
    if ([...fila.meta_adset_ids, ...fila.meta_ad_ids].some(id => !/^\d{6,25}$/.test(id))) { toast('Los IDs de Meta son solo números (copialos del Administrador de anuncios)', 'error'); return }
    try {
      if (exp.id) await actualizarExperimento(exp.id, fila); else await crearExperimento(fila)
      toast('Prueba guardada', 'success'); onListo()
    } catch (e) { toast(e.message, 'error') }
  }

  return (
    <div className="card">
      <div className="section-label">{exp.id ? 'Editar prueba' : 'Nueva prueba'}</div>
      <div className="form-grid form-grid-3" style={{ marginTop: 10 }}>
        <Campo label="Hipótesis" span={3}><input className="form-input" value={f.hipotesis} onChange={set('hipotesis')} /></Campo>
        <Campo label="Presupuesto autorizado (₲)"><input className="form-input" value={f.presupuesto} onChange={set('presupuesto')} inputMode="numeric" /></Campo>
        <Campo label="Pérdida máxima (₲)"><input className="form-input" value={f.perdida} onChange={set('perdida')} inputMode="numeric" /></Campo>
        <Campo label="Estado"><select className="form-select" value={f.estado} onChange={set('estado')}><option value="PLANEADO">Planeado</option><option value="EN_CURSO">En curso</option><option value="CERRADO">Cerrado</option></select></Campo>
        <Campo label="Ventana desde"><input type="date" className="form-input" value={f.desde} onChange={set('desde')} /></Campo>
        <Campo label="Ventana hasta"><input type="date" className="form-input" value={f.hasta} onChange={set('hasta')} /></Campo>
        <Campo label="Criterio de cierre"><input className="form-input" value={f.criterio} onChange={set('criterio')} /></Campo>
        <Campo label="IDs de conjuntos de Meta" hint="Separados por coma. Con IDs, se atribuyen los pedidos de esos conjuntos."><input className="form-input" value={f.adsets} onChange={set('adsets')} /></Campo>
        <Campo label="IDs de anuncios de Meta" hint="Cada anuncio tiene que estar también en el mapa del bot (config_wa.anuncios_producto)."><input className="form-input" value={f.ads} onChange={set('ads')} /></Campo>
        <Campo label="Familia (sin anuncios) · canal">
          <div style={{ display: 'flex', gap: 6 }}>
            <input className="form-input" value={f.familia} onChange={set('familia')} placeholder="familia_producto" />
            <select className="form-select" style={{ width: 110 }} value={f.canal} onChange={set('canal')}><option value="">ambos</option><option value="WA">WA</option><option value="Web">Web</option></select>
          </div>
        </Campo>
        <Campo label="Métricas (una por línea, clave: meta)" span={2}><textarea className="form-textarea" value={f.metricas} onChange={set('metricas')} /></Campo>
        <Campo label="Cierre manual">
          <label className="pi-check"><input type="checkbox" checked={f.maduro} onChange={set('maduro')} /> Datos maduros (cobro, entrega y devolución)</label>
          <input className="form-input" style={{ marginTop: 6 }} value={f.notas} onChange={set('notas')} placeholder="notas del cierre" />
        </Campo>
      </div>
      <div style={{ display: 'flex', justifyContent: 'flex-end', gap: 8, marginTop: 12 }}>
        <button className="btn btn-ghost btn-sm" onClick={onCerrar}>Cancelar</button>
        <button className="btn btn-primary btn-sm" onClick={guardar}>Guardar</button>
      </div>
    </div>
  )
}

// ─── DOSSIER ───────────────────────────────────────────────
export function Dossier({ d, toast }) {
  const { md, error } = useMemo(() => {
    try { return { md: armarDossier(armarDatosDossier(d)), error: null } } catch (e) { return { md: '', error: e.message } }
  }, [d])
  const nombreArchivo = `dossier-${(d.candidato.nombre || 'candidato').normalize('NFD').replace(/[̀-ͯ]/g, '').toLowerCase().replace(/[^a-z0-9]+/g, '-').replace(/^-|-$/g, '')}.md`

  const copiar = async () => {
    try { await navigator.clipboard.writeText(md); toast('Dossier copiado', 'success') } catch { toast('No se pudo copiar: seleccioná el texto a mano', 'error') }
  }
  const descargar = () => {
    const url = URL.createObjectURL(new Blob([md], { type: 'text/markdown;charset=utf-8' }))
    const a = document.createElement('a'); a.href = url; a.download = nombreArchivo; a.click()
    setTimeout(() => URL.revokeObjectURL(url), 1000)
  }

  return (
    <div className="pi-col">
      <div className="pi-barra">
        <span className="pi-sub">Responde las 11 preguntas con fuente y versión de cada cifra; lo que falta dice "desconocido". Usa el último escenario guardado (Rentabilidad) y la última decisión guardada (Decisión).</span>
        <div style={{ display: 'flex', gap: 6 }}>
          <button className="btn btn-secondary btn-sm" onClick={copiar} disabled={!md}><Copy size={12} /> Copiar</button>
          <button className="btn btn-primary btn-sm" onClick={descargar} disabled={!md}><Download size={12} /> Descargar .md</button>
        </div>
      </div>
      {error ? <div className="alert alert-error"><AlertTriangle size={15} /> {error}</div> : <pre className="copy-block pi-dossier">{md}</pre>}
    </div>
  )
}

// ─── SALIDA (A7): checklist del proceso de producto nuevo; no escribe en tablas ──
const PASOS_SALIDA = [
  { k: 'nombre', fase: 'Fase 1 · 4', txt: 'El nombre no choca con los detectores del sistema (familia_producto). Si choca, encargo a FUNCIONES: familia nueva + fila en productos + vistas de creativos.' },
  { k: 'releasit', fase: 'Fase 1 · 5', txt: 'Ofertas en Releasit solo del producto nuevo; no tocar umbrales, envío ni formulario global fuera de la ventana ni encima de una prueba. Cada número se verifica recargando.' },
  { k: 'productos', fase: 'Fase 1 · 4', txt: 'Fila en la tabla productos (costo real, stock que llegó).' },
  { k: 'equilibrio', fase: 'Fase 1 · 6', txt: 'Equilibrio del producto cargado en config.equilibrio_producto y freno por escrito.' },
  { k: 'contrato', fase: 'Fase 1 · 7', txt: 'Contrato común de lanzamiento (precios, claims, qué no se dice, orden de salida) y encargos a FUNCIONES, WHATSAPP API, WEB SETUP y CREATIVOS.' },
  { k: 'revision', fase: 'Fase 1 · 8', txt: 'Revisión independiente con datos crudos antes de publicar nada.' },
  { k: 'ok', fase: 'Fase 3 · 1', txt: 'OK de Enrique escrito en CADA chat que despliega (un OK reenviado no alcanza).' },
  { k: 'orden', fase: 'Fase 3 · 2', txt: 'Orden: sistema → bot → web → producto publicado → Releasit verificado en vivo → anuncios.' },
  { k: 'mapa', fase: 'Fase 3 · 3', txt: 'Cada anuncio cargado en config_wa.anuncios_producto ANTES de publicarlo y cruzado contra el mapa.' },
  { k: 'conjunto', fase: 'Fase 3 · 4', txt: 'Conjunto propio con presupuesto suficiente por producto para poder juzgarlo; excluir públicos de rechazos y devoluciones.' },
]

export function Salida({ d }) {
  const clave = `pi-salida-${d.candidato.id}`
  const [marcas, setMarcas] = useState(() => { try { return JSON.parse(localStorage.getItem(clave) || '{}') } catch { return {} } })
  const [nombre, setNombre] = useState(d.candidato.nombre.replace(/^DEMO\s*·\s*/, ''))
  const [prueba, setPrueba] = useState(null)
  const marcar = (k) => setMarcas(m => { const n = { ...m, [k]: !m[k] }; try { localStorage.setItem(clave, JSON.stringify(n)) } catch { /* solo comodidad */ } return n })

  const probar = async () => {
    setPrueba({ cargando: true })
    try { setPrueba(await probarFamiliaProducto(nombre)) } catch (e) { setPrueba({ ok: false, aviso: e.message }) }
  }

  return (
    <div className="pi-col">
      <div className="alert alert-info">
        <Rocket size={15} style={{ flexShrink: 0, marginTop: 1 }} />
        <span>Checklist del proceso fijo de producto nuevo. <b>Solo lectura:</b> esta pestaña no escribe en productos, config ni config_wa; cada paso lo hace el chat que corresponde con el OK de Enrique. Las marcas quedan solo en este navegador.</span>
      </div>
      <div className="card">
        <div className="section-label"><Search size={12} /> Probar el nombre contra familia_producto</div>
        <div style={{ display: 'flex', gap: 8, marginTop: 8, flexWrap: 'wrap' }}>
          <input className="form-input" style={{ maxWidth: 360 }} value={nombre} onChange={e => setNombre(e.target.value)} />
          <button className="btn btn-secondary btn-sm" onClick={probar} disabled={!nombre.trim() || prueba?.cargando}>{prueba?.cargando ? 'Probando…' : 'Probar nombre'}</button>
        </div>
        {prueba && !prueba.cargando && (prueba.ok ? (
          prueba.familia
            ? <div className="alert alert-warning" style={{ marginTop: 8 }}><AlertTriangle size={15} /> El sistema lo detecta como familia <b>{prueba.familia}</b>. Si no es ese producto, choca: encargo a FUNCIONES antes de lanzar.</div>
            : <div className="alert alert-success" style={{ marginTop: 8 }}><CheckCircle2 size={15} /> Ningún detector lo reconoce (familia vacía): no choca. Igual hace falta crear su familia con FUNCIONES.</div>
        ) : <div className="alert alert-warning" style={{ marginTop: 8 }}><AlertTriangle size={15} /> {prueba.aviso}</div>)}
      </div>
      <div className="card">
        <div className="section-label">Pasos antes y durante la salida</div>
        <div className="m-card-list" style={{ marginTop: 8 }}>
          {PASOS_SALIDA.map(p => (
            <label key={p.k} className="m-card pi-paso">
              <input type="checkbox" checked={!!marcas[p.k]} onChange={() => marcar(p.k)} />
              <div><span className="pi-sub">{p.fase}</span><div style={{ fontSize: 13 }}>{p.txt}</div></div>
            </label>
          ))}
        </div>
        <p className="pi-sub" style={{ marginTop: 8 }}>Estado del candidato: <BadgeEstado estado={d.candidato.estado} />. Se lanza solo con una decisión PROBAR_OFERTA o posterior y sin bloqueos.</p>
      </div>
    </div>
  )
}
