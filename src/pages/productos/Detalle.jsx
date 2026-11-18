// src/pages/productos/Detalle.jsx
// Pantalla 2 (§10): detalle del candidato con pestañas. Acá viven Producto
// (ficha versionada), Evidencia y Competencia; el resto en sus archivos.
import { useState, useEffect, useCallback, useMemo } from 'react'
import { ArrowLeft, Package, FileSearch, Users, Truck, Calculator, Scale, FlaskConical, FileText, Rocket, Plus, Trash2, History } from 'lucide-react'
import { useToast } from '../../lib/toast'
import { cargarDetalle, guardarFicha, crearEvidencia, borrarEvidencia, crearOferta, borrarOferta, esModoDemo } from './api'
import {
  fmtDinero, fmtFecha, fmtFechaHora, vencida, aMinor, claveVendedor, fechaLocalAISO, hoyLocal, sumarDiasLocal,
  TIPOS_EVIDENCIA, CAMPOS_EVIDENCIA, vigenciaSugeridaDias, urlSegura } from './formato'
import { Campo, Demo, BadgeEstado, BadgeTipo, Vacio, ErrorCaja, SelectMoneda } from './ui'
import Proveedores from './Proveedores'
import Rentabilidad from './Rentabilidad'
import { Decision, Prueba, Dossier, Salida } from './Decision'

const TABS = [
  { v: 'producto', label: 'Producto', icon: Package },
  { v: 'evidencia', label: 'Evidencia', icon: FileSearch },
  { v: 'competencia', label: 'Competencia', icon: Users },
  { v: 'proveedores', label: 'Proveedores', icon: Truck },
  { v: 'rentabilidad', label: 'Rentabilidad', icon: Calculator },
  { v: 'decision', label: 'Decisión', icon: Scale },
  { v: 'prueba', label: 'Prueba', icon: FlaskConical },
  { v: 'dossier', label: 'Dossier', icon: FileText },
  { v: 'salida', label: 'Salida', icon: Rocket },
]

export default function Detalle({ candidatoId, onVolver, tab, onTab }) {
  const { toast } = useToast()
  const [d, setD] = useState(null)
  const [error, setError] = useState(null)

  const cargar = useCallback(async () => {
    setError(null)
    try { setD(await cargarDetalle(candidatoId)) } catch (e) { setError(e) }
  }, [candidatoId])
  useEffect(() => { cargar() }, [cargar])

  if (error) return <div className="pi-col"><button className="btn btn-ghost btn-sm pi-volver" onClick={onVolver}><ArrowLeft size={13} /> Oportunidades</button><ErrorCaja error={error} onReintentar={cargar} /></div>
  if (!d) return <div className="pi-col"><div className="skeleton skeleton-title" /><div className="skeleton" style={{ height: 240, borderRadius: 'var(--radius)' }} /></div>
  if (!d.candidato) return <div className="pi-col"><button className="btn btn-ghost btn-sm pi-volver" onClick={onVolver}><ArrowLeft size={13} /> Oportunidades</button><Vacio titulo="No encontramos este candidato" desc="Puede haberse borrado o ser de otro modo (DEMO / real)." /></div>

  const c = d.candidato
  const props = { d, recargar: cargar, toast }
  return (
    <div className="pi-col">
      <button className="btn btn-ghost btn-sm pi-volver" onClick={onVolver}><ArrowLeft size={13} /> Oportunidades</button>
      <div className="card card-sm">
        <div style={{ display: 'flex', alignItems: 'center', gap: 10, flexWrap: 'wrap' }}>
          <h2 className="pi-titulo">{c.nombre}</h2>
          <BadgeEstado estado={c.estado} />
          {c.demo && <Demo />}
        </div>
        {c.hipotesis && <p className="pi-desc" style={{ marginTop: 6 }}>Hipótesis: {c.hipotesis}</p>}
        <p className="pi-sub" style={{ marginTop: 4 }}>
          Siguiente acción: <b>{c.siguiente_accion || 'definir'}</b> · {c.familia_producto ? `familia ${c.familia_producto}` : 'sin familia en Voltra'} · creado {fmtFecha(c.creado_en)}
        </p>
      </div>

      <div className="tabs filter-scroll">
        {TABS.map(({ v, label, icon: I }) => (
          <button key={v} className={`tab ${tab === v ? 'active' : ''}`} onClick={() => onTab(v)}><I size={13} /> {label}</button>
        ))}
      </div>

      {tab === 'producto' && <TabProducto {...props} />}
      {tab === 'evidencia' && <TabEvidencia {...props} />}
      {tab === 'competencia' && <TabCompetencia {...props} />}
      {tab === 'proveedores' && <Proveedores {...props} />}
      {tab === 'rentabilidad' && <Rentabilidad {...props} />}
      {tab === 'decision' && <Decision {...props} />}
      {tab === 'prueba' && <Prueba {...props} />}
      {tab === 'dossier' && <Dossier {...props} />}
      {tab === 'salida' && <Salida {...props} />}
    </div>
  )
}

// ─── PRODUCTO: ficha versionada ─────────────────────────────
const CAMPOS_FICHA = [
  ['funcion', 'Función'], ['materiales', 'Materiales'], ['medidas', 'Medidas / tolerancias'], ['variante', 'Variante'],
  ['accesorios', 'Accesorios'], ['pack', 'Pack / empaque'], ['etiquetado', 'Etiquetado / personalización'], ['garantia', 'Garantía'],
  ['criterios_aceptacion', 'Criterios de aceptación'], ['imagenes', 'Imágenes de referencia (links autorizados)'],
  ['clientes', 'Clientes / segmento (hipótesis)'],
]
function TabProducto({ d, recargar, toast }) {
  const ultima = d.fichas[d.fichas.length - 1]
  const [ver, setVer] = useState(ultima?.version || null)
  const [editando, setEditando] = useState(!ultima)
  const [spec, setSpec] = useState(ultima?.spec || {})
  const [guardando, setGuardando] = useState(false)
  const mostrada = d.fichas.find(f => f.version === ver) || ultima

  const guardar = async () => {
    setGuardando(true)
    try {
      await guardarFicha(d.candidato.id, spec, ultima?.version || 0)
      toast(`Ficha guardada como versión ${(ultima?.version || 0) + 1}`, 'success')
      setEditando(false); await recargar()
    } catch (e) { toast(e.message, 'error') } finally { setGuardando(false) }
  }

  return (
    <div className="pi-col">
      <div className="alert alert-info">
        <History size={15} style={{ flexShrink: 0, marginTop: 1 }} />
        <span>La ficha nunca se pisa: cada cambio es una versión nueva. Las cotizaciones se comparan contra una versión concreta para no mezclar variantes distintas.</span>
      </div>
      {editando ? (
        <div className="card">
          <div className="section-label">Ficha {ultima ? `v${ultima.version + 1} (nueva)` : 'v1'}</div>
          <div className="form-grid" style={{ marginTop: 10 }}>
            {CAMPOS_FICHA.map(([k, l]) => (
              <Campo key={k} label={l}>
                <textarea className="form-textarea" style={{ minHeight: 56 }} value={spec[k] || ''} onChange={e => setSpec(s => ({ ...s, [k]: e.target.value }))} placeholder="desconocido" />
              </Campo>
            ))}
          </div>
          <div style={{ display: 'flex', gap: 8, justifyContent: 'flex-end', marginTop: 14 }}>
            {ultima && <button className="btn btn-ghost btn-sm" onClick={() => { setSpec(ultima.spec || {}); setEditando(false) }}>Cancelar</button>}
            <button className="btn btn-primary btn-sm" onClick={guardar} disabled={guardando}>{guardando ? 'Guardando…' : 'Guardar versión'}</button>
          </div>
        </div>
      ) : mostrada ? (
        <div className="card">
          <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'center', gap: 8, flexWrap: 'wrap' }}>
            <div className="tabs filter-scroll">
              {d.fichas.map(f => <button key={f.id} className={`tab ${f.version === mostrada.version ? 'active' : ''}`} onClick={() => setVer(f.version)}>v{f.version}</button>)}
            </div>
            <button className="btn btn-secondary btn-sm" onClick={() => { setSpec(ultima.spec || {}); setEditando(true) }}>Editar (crea v{ultima.version + 1})</button>
          </div>
          <div className="pi-ficha">
            {CAMPOS_FICHA.map(([k, l]) => (
              <div key={k} className="pi-ficha-fila">
                <span className="data-label">{l}</span>
                <span className={mostrada.spec?.[k] ? '' : 'pi-desc'}>{mostrada.spec?.[k] || 'desconocido'}</span>
              </div>
            ))}
          </div>
          <p className="pi-sub">Versión {mostrada.version} · guardada {fmtFechaHora(mostrada.creado_en)}</p>
        </div>
      ) : null}
    </div>
  )
}

// ─── EVIDENCIA ──────────────────────────────────────────────
function TabEvidencia({ d, recargar, toast }) {
  const vacio = { tipo: 'observed', campo: 'precio_minorista', valor: '', moneda: 'PYG', fuente_url: '', fuente_entidad: '', observado: hoyLocal(), valido: sumarDiasLocal(hoyLocal(), 7), variante: '', cobertura: '', captura_ref: '' }
  const [f, setF] = useState(vacio)
  const [abierto, setAbierto] = useState(false)
  const [filtroTipo, setFiltroTipo] = useState('todos')
  const set = (k) => (e) => setF(p => ({ ...p, [k]: e.target.value }))
  const ahora = new Date()

  const cambiarCampo = (campo) => {
    const dias = vigenciaSugeridaDias(campo)
    setF(p => ({ ...p, campo, valido: dias ? sumarDiasLocal(p.observado || hoyLocal(), dias) : '' }))
  }

  const guardar = async () => {
    if (!f.campo.trim()) { toast('Falta el campo (qué dato es)', 'error'); return }
    if (f.tipo !== 'unknown' && !f.valor.trim()) { toast('Falta el valor. Si no lo sabés, elegí tipo "Desconocido".', 'error'); return }
    if (f.tipo === 'observed' && !f.fuente_url.trim() && !f.fuente_entidad.trim()) { toast('Un dato observado necesita fuente (link o quién).', 'error'); return }
    try {
      await crearEvidencia({
        candidato_id: d.candidato.id, tipo: f.tipo, campo: f.campo.trim(), valor: f.valor.trim() || null,
        moneda: f.moneda && /precio|costo|flete|tributo/.test(f.campo) ? f.moneda : null,
        fuente_url: f.fuente_url.trim() || null, fuente_entidad: f.fuente_entidad.trim() || null,
        observado_en: fechaLocalAISO(f.observado), valido_hasta: fechaLocalAISO(f.valido, true),
        variante: f.variante.trim() || null, captura_ref: f.captura_ref.trim() || null, cobertura: f.cobertura.trim() || null,
        cargado_por: 'web',
      })
      toast('Evidencia cargada', 'success'); setF(vacio); setAbierto(false); recargar()
    } catch (e) { toast(e.message, 'error') }
  }
  const quitar = async (id) => {
    if (!confirm('¿Borrar esta evidencia? (queda el registro en pi_eventos)')) return
    try { await borrarEvidencia(id); recargar() } catch (e) { toast(e.message, 'error') }
  }

  const lista = d.evidencias.filter(e => filtroTipo === 'todos' || (filtroTipo === 'vencidas' ? vencida(e.valido_hasta, ahora) : e.tipo === filtroTipo))
  const conteo = Object.fromEntries(TIPOS_EVIDENCIA.map(t => [t.v, d.evidencias.filter(e => e.tipo === t.v).length]))
  const nVencidas = d.evidencias.filter(e => vencida(e.valido_hasta, ahora)).length

  return (
    <div className="pi-col">
      <div className="pi-barra">
        <div className="tabs filter-scroll">
          <button className={`tab ${filtroTipo === 'todos' ? 'active' : ''}`} onClick={() => setFiltroTipo('todos')}>Todos ({d.evidencias.length})</button>
          {TIPOS_EVIDENCIA.map(t => <button key={t.v} className={`tab ${filtroTipo === t.v ? 'active' : ''}`} onClick={() => setFiltroTipo(t.v)}>{t.label} ({conteo[t.v]})</button>)}
          <button className={`tab ${filtroTipo === 'vencidas' ? 'active' : ''}`} onClick={() => setFiltroTipo('vencidas')}>Vencidas ({nVencidas})</button>
        </div>
        <button className="btn btn-primary btn-sm" onClick={() => setAbierto(a => !a)}><Plus size={13} /> Cargar evidencia</button>
      </div>

      {abierto && (
        <div className="card">
          <div className="form-grid form-grid-3">
            <Campo label="Tipo" hint={TIPOS_EVIDENCIA.find(t => t.v === f.tipo)?.ayuda}>
              <select className="form-select" value={f.tipo} onChange={set('tipo')}>{TIPOS_EVIDENCIA.map(t => <option key={t.v} value={t.v}>{t.label}</option>)}</select>
            </Campo>
            <Campo label="Campo (qué dato)">
              <input className="form-input" list="pi-campos-ev" value={f.campo} onChange={e => cambiarCampo(e.target.value)} />
              <datalist id="pi-campos-ev">{CAMPOS_EVIDENCIA.map(c => <option key={c} value={c} />)}</datalist>
            </Campo>
            <Campo label="Valor" hint={f.campo === 'dias_activo_anuncio' ? 'Días que el anuncio lleva prendido en la Biblioteca de anuncios. Es un indicio, NO prueba ventas.' : 'Vacío solo si es "Desconocido".'}>
              <div style={{ display: 'flex', gap: 6 }}>
                <input className="form-input" value={f.valor} onChange={set('valor')} />
                {/precio|costo|flete|tributo/.test(f.campo) && <div style={{ width: 90 }}><SelectMoneda value={f.moneda} onChange={(m) => setF(p => ({ ...p, moneda: m }))} /></div>}
              </div>
            </Campo>
            <Campo label="Fuente (link)"><input className="form-input" value={f.fuente_url} onChange={set('fuente_url')} placeholder="https://…" /></Campo>
            <Campo label="Fuente (quién: vendedor, proveedor, sitio)"><input className="form-input" value={f.fuente_entidad} onChange={set('fuente_entidad')} /></Campo>
            <Campo label="Variante"><input className="form-input" value={f.variante} onChange={set('variante')} placeholder="color, modelo, pack" /></Campo>
            <Campo label="Observado el"><input type="date" className="form-input" value={f.observado} onChange={set('observado')} /></Campo>
            <Campo label="Válido hasta" hint="Precio/stock local y logística: 7 días. Proveedor: lo que diga la cotización."><input type="date" className="form-input" value={f.valido} onChange={set('valido')} /></Campo>
            <Campo label="Captura (archivo privado, no en el repo)"><input className="form-input" value={f.captura_ref} onChange={set('captura_ref')} placeholder="ruta o nombre" /></Campo>
            <Campo label="Cobertura y límites" span={3} hint="Qué se pudo y qué no se pudo consultar. Ausencia en Google ≠ ausencia de mercado."><input className="form-input" value={f.cobertura} onChange={set('cobertura')} /></Campo>
          </div>
          <div style={{ display: 'flex', justifyContent: 'flex-end', gap: 8, marginTop: 12 }}>
            <button className="btn btn-ghost btn-sm" onClick={() => setAbierto(false)}>Cancelar</button>
            <button className="btn btn-primary btn-sm" onClick={guardar}>Guardar</button>
          </div>
        </div>
      )}

      {lista.length === 0 ? (
        <Vacio icono={FileSearch} titulo="Sin evidencia en esta vista" desc="Cada dato importante va con tipo, fuente, fecha y vigencia. Lo que no se sabe se carga como Desconocido para que quede visible." />
      ) : (
        <div className="table-wrapper">
          <table className="tabla-responsive">
            <thead><tr><th>Tipo</th><th>Campo</th><th>Valor</th><th>Fuente</th><th>Variante</th><th>Observado</th><th>Vigencia</th><th>Cobertura</th><th></th></tr></thead>
            <tbody>
              {lista.map(e => {
                const venc = vencida(e.valido_hasta, ahora)
                return (
                  <tr key={e.id} className={venc ? 'pi-vencida' : ''}>
                    <td data-label="Tipo"><BadgeTipo tipo={e.tipo} /></td>
                    <td data-label="Campo">{e.campo}{e.campo === 'dias_activo_anuncio' && <div className="pi-sub">indicio, no prueba ventas</div>}</td>
                    <td data-label="Valor" className="pi-num">{e.valor == null ? <span className="pi-desc">desconocido</span> : e.moneda ? fmtDinero(aMinor(e.valor, e.moneda), e.moneda) : e.valor}</td>
                    <td data-label="Fuente" style={{ whiteSpace: 'normal', maxWidth: 200 }}>
                      {e.fuente_entidad || ''}{urlSegura(e.fuente_url) && <> {' '}<a href={urlSegura(e.fuente_url)} target="_blank" rel="noopener noreferrer" className="pi-link">link</a></>}
                      {!e.fuente_entidad && !e.fuente_url && <span className="pi-desc">sin fuente</span>}
                    </td>
                    <td data-label="Variante">{e.variante || '—'}</td>
                    <td data-label="Observado">{fmtFecha(e.observado_en)}</td>
                    <td data-label="Vigencia">{e.valido_hasta ? <>{fmtFecha(e.valido_hasta)} {venc && <span className="badge badge-yellow">vencida</span>}</> : '—'}</td>
                    <td data-label="Cobertura" style={{ whiteSpace: 'normal', maxWidth: 220 }} className="pi-sub">{e.cobertura || ''}</td>
                    <td><button className="btn btn-ghost btn-sm btn-icon" title="Borrar" onClick={() => quitar(e.id)}><Trash2 size={12} /></button></td>
                  </tr>
                )
              })}
            </tbody>
          </table>
        </div>
      )}
      <p className="pi-sub">"Dice el proveedor" prueba que el proveedor lo afirma, no que sea cierto (ej.: un certificado sin validar). Una evidencia vencida se revalida antes de cualquier compromiso.</p>
    </div>
  )
}

// ─── COMPETENCIA ────────────────────────────────────────────
const ZONAS = [['CDE', 'CDE'], ['GRAN_ASUNCION', 'Gran Asunción'], ['INTERIOR', 'Interior'], ['NACIONAL', 'Nacional'], ['DESCONOCIDA', 'Desconocida']]
const COMPARACION = [['identico', 'Idéntico'], ['equivalente', 'Equivalente funcional'], ['sustituto', 'Sustituto']]

function TabCompetencia({ d, recargar, toast }) {
  const vacio = { vendedor: '', comparacion: 'identico', zona: 'CDE', precio: '', moneda: 'PYG', tipo_precio: 'minorista contado', incluye_envio: false, url: '', observado: hoyLocal(), dias_activo: '' }
  const [f, setF] = useState(vacio)
  const [abierto, setAbierto] = useState(false)
  const set = (k) => (e) => setF(p => ({ ...p, [k]: e.target.type === 'checkbox' ? e.target.checked : e.target.value }))

  // Deduplicación por vendedor_clave: el mismo vendedor en varios canales cuenta una vez.
  const grupos = useMemo(() => {
    const m = new Map()
    for (const o of d.ofertas) {
      const k = o.vendedor_clave || claveVendedor(o.vendedor) || o.id
      if (!m.has(k)) m.set(k, [])
      m.get(k).push(o)
    }
    return [...m.entries()].map(([clave, ofs]) => ({ clave, ofs, min: ofs.filter(o => o.moneda === 'PYG' && o.precio_minor != null).sort((a, b) => a.precio_minor - b.precio_minor)[0] }))
  }, [d.ofertas])
  const comparables = grupos.filter(g => g.ofs.some(o => o.comparacion !== 'sustituto'))
  const preciosId = comparables.map(g => g.min?.precio_minor).filter(v => v != null).sort((a, b) => a - b)
  const mediana = preciosId.length ? preciosId[Math.floor((preciosId.length - 1) / 2)] : null
  const evDias = d.evidencias.filter(e => e.campo === 'dias_activo_anuncio')

  const guardar = async () => {
    if (!f.vendedor.trim()) { toast('Falta el vendedor', 'error'); return }
    const precio_minor = aMinor(f.precio, f.moneda)
    if (f.precio && precio_minor == null) { toast('El precio no es un número válido', 'error'); return }
    try {
      let evidencia_id = null
      // A8: días activo del anuncio del competidor se guarda como evidencia (campo dias_activo_anuncio).
      if (f.dias_activo.trim()) {
        const ev = await crearEvidencia({
          candidato_id: d.candidato.id, tipo: 'observed', campo: 'dias_activo_anuncio', valor: f.dias_activo.trim(), moneda: null,
          fuente_url: f.url.trim() || null, fuente_entidad: f.vendedor.trim(), observado_en: fechaLocalAISO(f.observado),
          valido_hasta: fechaLocalAISO(sumarDiasLocal(f.observado, 7), true), variante: null,
          cobertura: 'Biblioteca de anuncios de Meta. Indicio de que vende; no prueba ventas ni rentabilidad.', cargado_por: 'web',
        })
        evidencia_id = ev?.id || null
      }
      await crearOferta({
        candidato_id: d.candidato.id, vendedor: f.vendedor.trim(), vendedor_clave: claveVendedor(f.vendedor),
        comparacion: f.comparacion, zona: f.zona, precio_minor, moneda: f.moneda, tipo_precio: f.tipo_precio.trim() || null,
        incluye_envio: !!f.incluye_envio, url: f.url.trim() || null, observado_en: fechaLocalAISO(f.observado), evidencia_id,
      })
      toast('Oferta cargada', 'success'); setF(vacio); setAbierto(false); recargar()
    } catch (e) { toast(e.message, 'error') }
  }
  const quitar = async (id) => {
    if (!confirm('¿Borrar esta oferta?')) return
    try { await borrarOferta(id); recargar() } catch (e) { toast(e.message, 'error') }
  }

  const nVend = comparables.length
  return (
    <div className="pi-col">
      <div className="kpi-grid">
        <div className="kpi-card"><div className="kpi-label">Vendedores independientes</div><div className={`kpi-value ${nVend >= 3 ? 'green' : 'yellow'}`}>{nVend}</div><div className="kpi-sub">meta: ≥ 3 (idéntico o equivalente)</div></div>
        <div className="kpi-card"><div className="kpi-label">Ofertas cargadas</div><div className={`kpi-value ${d.ofertas.length >= 5 ? 'green' : 'yellow'}`}>{d.ofertas.length}</div><div className="kpi-sub">meta: ≥ 5 comparables</div></div>
        <div className="kpi-card"><div className="kpi-label">Precio mediano (1 por vendedor)</div><div className="kpi-value">{mediana != null ? fmtDinero(mediana, 'PYG') : '—'}</div><div className="kpi-sub">solo PYG, sin sustitutos</div></div>
        <div className="kpi-card"><div className="kpi-label">Anuncios con días activos</div><div className="kpi-value">{evDias.length}</div><div className="kpi-sub">indicio, no prueba ventas</div></div>
      </div>

      <div className="pi-barra">
        <span className="pi-sub">Mismo vendedor en web e Instagram cuenta una vez. Precio publicado ≠ unidades vendidas.</span>
        <button className="btn btn-primary btn-sm" onClick={() => setAbierto(a => !a)}><Plus size={13} /> Cargar oferta</button>
      </div>

      {abierto && (
        <div className="card">
          <div className="form-grid form-grid-3">
            <Campo label="Vendedor" hint={f.vendedor ? `clave para deduplicar: ${claveVendedor(f.vendedor) || '—'}` : null}><input className="form-input" value={f.vendedor} onChange={set('vendedor')} /></Campo>
            <Campo label="Comparación" hint="Foto idéntica no prueba mismo SKU ni calidad.">
              <select className="form-select" value={f.comparacion} onChange={set('comparacion')}>{COMPARACION.map(([v, l]) => <option key={v} value={v}>{l}</option>)}</select>
            </Campo>
            <Campo label="Zona"><select className="form-select" value={f.zona} onChange={set('zona')}>{ZONAS.map(([v, l]) => <option key={v} value={v}>{l}</option>)}</select></Campo>
            <Campo label="Precio final al cliente">
              <div style={{ display: 'flex', gap: 6 }}>
                <input className="form-input" value={f.precio} onChange={set('precio')} inputMode="decimal" />
                <div style={{ width: 90 }}><SelectMoneda value={f.moneda} onChange={(m) => setF(p => ({ ...p, moneda: m }))} /></div>
              </div>
            </Campo>
            <Campo label="Tipo de precio" hint="minorista/mayorista, contado/cuotas, promo/regular"><input className="form-input" value={f.tipo_precio} onChange={set('tipo_precio')} /></Campo>
            <Campo label="Observado el"><input type="date" className="form-input" value={f.observado} onChange={set('observado')} /></Campo>
            <Campo label="Link" span={2}><input className="form-input" value={f.url} onChange={set('url')} placeholder="https://…" /></Campo>
            <Campo label="Días activo del anuncio (Meta)" hint="Opcional. Se guarda como evidencia; no prueba ventas."><input className="form-input" value={f.dias_activo} onChange={set('dias_activo')} inputMode="numeric" /></Campo>
            <Campo label=" "><label style={{ display: 'flex', alignItems: 'center', gap: 6, fontSize: 13 }}><input type="checkbox" checked={f.incluye_envio} onChange={set('incluye_envio')} /> El precio incluye envío</label></Campo>
          </div>
          <div style={{ display: 'flex', justifyContent: 'flex-end', gap: 8, marginTop: 12 }}>
            <button className="btn btn-ghost btn-sm" onClick={() => setAbierto(false)}>Cancelar</button>
            <button className="btn btn-primary btn-sm" onClick={guardar}>Guardar</button>
          </div>
        </div>
      )}

      {grupos.length === 0 ? (
        <Vacio icono={Users} titulo="Sin ofertas de competencia" desc="Ideal: 5 ofertas comparables de al menos 3 vendedores. Si no existen, se deja la cobertura real; no se inventan filas." />
      ) : (
        <div className="table-wrapper">
          <table className="tabla-responsive">
            <thead><tr><th>Vendedor</th><th>Comparación</th><th>Zona</th><th>Precio</th><th>Tipo</th><th>Envío</th><th>Observado</th><th></th></tr></thead>
            <tbody>
              {grupos.flatMap(g => g.ofs.map((o, i) => (
                <tr key={o.id} className={i > 0 ? 'pi-duplicado' : ''}>
                  <td data-label="Vendedor" style={{ whiteSpace: 'normal' }}>
                    {o.vendedor} {urlSegura(o.url) && <a href={urlSegura(o.url)} target="_blank" rel="noopener noreferrer" className="pi-link">link</a>}
                    {i > 0 && <div className="pi-sub">mismo vendedor ({g.clave}): no suma</div>}
                    {i === 0 && g.ofs.length > 1 && <div className="pi-sub">{g.ofs.length} canales, cuenta 1</div>}
                  </td>
                  <td data-label="Comparación">{COMPARACION.find(c => c[0] === o.comparacion)?.[1] || o.comparacion}</td>
                  <td data-label="Zona">{ZONAS.find(z => z[0] === o.zona)?.[1] || o.zona}</td>
                  <td data-label="Precio" className="pi-num">{fmtDinero(o.precio_minor, o.moneda)}</td>
                  <td data-label="Tipo">{o.tipo_precio || '—'}</td>
                  <td data-label="Envío">{o.incluye_envio ? 'incluido' : 'aparte'}</td>
                  <td data-label="Observado">{fmtFecha(o.observado_en)}</td>
                  <td><button className="btn btn-ghost btn-sm btn-icon" title="Borrar" onClick={() => quitar(o.id)}><Trash2 size={12} /></button></td>
                </tr>
              )))}
            </tbody>
          </table>
        </div>
      )}
      {esModoDemo() && <p className="pi-sub"><Demo /> Vendedores inventados.</p>}
    </div>
  )
}
