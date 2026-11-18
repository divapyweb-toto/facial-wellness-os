// src/pages/productos/Proveedores.jsx
// Pestaña Proveedores (§10.3): proveedores, cotizaciones (carga manual),
// comparador normalizado por unidad vendible en ₲, campaña de negociación
// (pi_politicas), conversaciones (pi_mensajes) y órdenes de compra
// (pi_ordenes_compra). Esta pantalla no envía mensajes, no compra ni paga.
import { useState, useMemo } from 'react'
import { Plus, Trash2, ShieldAlert, Info, MessageSquare, ShoppingBag, Scale } from 'lucide-react'
import { crearProveedor, crearCotizacion, borrarCotizacion, crearOrden, actualizarOrden, autorizarPolitica, apagarPolitica, esModoDemo } from './api'
import { convertirAPYG } from '../../lib/productos/dinero'
import { aMinor, fmtDinero, fmtGs, fmtFecha, fmtFechaHora, vencida, fechaLocalAISO, urlSegura } from './formato'
import { Campo, Vacio, Demo, SelectMoneda, Modal } from './ui'

const PLATAFORMAS = [['alibaba', 'Alibaba'], ['1688', '1688'], ['local', 'Local / mayorista CDE'], ['otro', 'Otro']]
const TIPOS_COT = [['firme', 'Firme (por escrito, para esta ficha)'], ['escaparate', 'Escaparate (precio publicado)'], ['estimada', 'Estimada']]
const ESTADOS_ORDEN = [
  ['BORRADOR', 'Borrador', 'badge-gray'], ['CONFIRMADA_POR_ENRIQUE', 'Confirmada por Enrique', 'badge-blue'],
  ['PEDIDA', 'Pedida', 'badge-purple'], ['PAGADA_POR_ENRIQUE', 'Pagada por Enrique', 'badge-accent'],
  ['EN_TRANSITO', 'En tránsito', 'badge-yellow'], ['RECIBIDA', 'Recibida', 'badge-green'], ['CANCELADA', 'Cancelada', 'badge-red'],
]
const ESTADOS_MSG = { DRAFT: ['Borrador', 'badge-gray'], AUTHORIZED: ['Autorizado', 'badge-blue'], SENDING: ['Enviando', 'badge-yellow'], SENT_CONFIRMED: ['Enviado (confirmado)', 'badge-green'], SEND_UNKNOWN: ['Envío incierto: conciliar', 'badge-red'], FAILED: ['Falló', 'badge-red'] }

export default function Proveedores({ d, recargar, toast }) {
  const provPorId = useMemo(() => Object.fromEntries(d.proveedores.map(p => [p.id, p])), [d.proveedores])
  return (
    <div className="pi-col">
      <div className="alert alert-info">
        <Info size={15} style={{ flexShrink: 0, marginTop: 1 }} />
        <span><b>Abastecimiento:</b> Alibaba/1688 es el camino principal de compra; el local en CDE, para probar rápido (lote chico en días). Siempre se compara el costo puesto en Paraguay, no solo el precio del anuncio.</span>
      </div>
      <div className="alert alert-warning">
        <ShieldAlert size={15} style={{ flexShrink: 0, marginTop: 1 }} />
        <span>Claude negocia solo dentro de la campaña autorizada; comprar, pagar, muestras o exclusividad necesitan tu confirmación aparte.</span>
      </div>
      <Campana d={d} provPorId={provPorId} recargar={recargar} toast={toast} />
      <Cotizaciones d={d} recargar={recargar} toast={toast} provPorId={provPorId} />
      <Ordenes d={d} recargar={recargar} toast={toast} provPorId={provPorId} />
      <ListaProveedores d={d} recargar={recargar} toast={toast} />
    </div>
  )
}

// ─── Campaña y conversaciones ───────────────────────────────
function Campana({ d, provPorId, recargar, toast }) {
  const [autorizando, setAutorizando] = useState(null) // { politica, texto }
  const autorizar = async () => {
    if ((autorizando.texto || '').trim().length < 3) { toast('Escribí tu autorización con tus palabras (queda textual).', 'error'); return }
    try { await autorizarPolitica(autorizando.politica, autorizando.texto); toast('Campaña autorizada', 'success'); setAutorizando(null); recargar() }
    catch (e) { toast(e.message, 'error') }
  }
  const apagar = async (p) => {
    try { await apagarPolitica(p.id); toast('Campaña apagada: los mensajes vuelven a borrador', 'success'); recargar() }
    catch (e) { toast(e.message, 'error') }
  }
  if (d.politicas === null) return <div className="card card-sm"><p className="pi-desc">La tabla de campañas (pi_politicas) todavía no está en la base.</p></div>
  const ahora = new Date()
  return (
    <div className="card">
      <div className="section-label"><MessageSquare size={12} /> Campaña de negociación y conversaciones</div>
      {d.politicas.length === 0 ? (
        <p className="pi-desc" style={{ marginTop: 6 }}>Sin campaña autorizada para este producto: los mensajes quedan en borrador. Claude propone la campaña (alcance por defecto: 5 proveedores, 2 rondas, seguimiento a los 2 días hábiles, 14 días de vigencia) y la autorizás vos acá con el botón "Autorizar", con tu sesión: la base no acepta la autorización de nadie más.</p>
      ) : d.politicas.map(p => {
        const vigente = p.permite_envio && (!p.vigente_hasta || new Date(p.vigente_hasta) > ahora)
        const a = p.alcance || {}
        return (
          <div key={p.id} className="pi-campana">
            <div style={{ display: 'flex', gap: 8, alignItems: 'center', flexWrap: 'wrap' }}>
              <span className={`badge ${vigente ? 'badge-green' : 'badge-gray'}`}>{vigente ? 'Vigente: permite enviar' : p.permite_envio ? 'Vencida' : 'Solo borradores'}</span>
              {p.vigente_hasta && <span className="pi-sub">hasta {fmtFecha(p.vigente_hasta)}</span>}
              {p.autorizada_por && <span className="pi-sub">autorizó {p.autorizada_por} · {fmtFechaHora(p.autorizada_en)}</span>}
              {esModoDemo() && <Demo />}
              {!esModoDemo() && !p.permite_envio && <button className="btn btn-primary btn-sm" onClick={() => setAutorizando({ politica: p, texto: '' })}>Autorizar</button>}
              {!esModoDemo() && p.permite_envio && <button className="btn btn-ghost btn-sm" onClick={() => apagar(p)}>Apagar</button>}
            </div>
            <div className="data-row" style={{ marginTop: 8, flexWrap: 'wrap' }}>
              {Object.entries(a).map(([k, v]) => (
                <div key={k} className="data-col"><span className="data-label">{k.replace(/_/g, ' ')}</span><span className="data-value">{Array.isArray(v) ? v.join(' / ') : typeof v === 'object' && v !== null ? JSON.stringify(v) : String(v)}</span></div>
              ))}
            </div>
            <div className="copy-block" style={{ marginTop: 8 }}>
              <span className="data-label">Lo que escribió Enrique (textual)</span><br />
              {p.autorizada_texto ? `"${p.autorizada_texto}"` : <span className="pi-desc">sin texto de autorización</span>}
            </div>
          </div>
        )
      })}

      {autorizando && (
        <Modal titulo="Autorizar campaña de negociación" onCerrar={() => setAutorizando(null)} pie={<><button className="btn btn-ghost" onClick={() => setAutorizando(null)}>Cancelar</button><button className="btn btn-primary" onClick={autorizar}>Autorizar</button></>}>
          <Campo label="Tu autorización (textual)" hint="Queda guardada tal cual. Solo vale con tu sesión.">
            <textarea className="form-textarea" value={autorizando.texto} onChange={e => setAutorizando(a => ({ ...a, texto: e.target.value }))} />
          </Campo>
          <p className="pi-sub" style={{ marginTop: 8 }}>Dentro del alcance, Claude consulta, cotiza y contraoferta. Nunca acepta órdenes, paga, compra muestras, promete exclusividad ni acepta términos sin otra confirmación tuya.</p>
        </Modal>
      )}

      {d.mensajes.length > 0 && (
        <div className="m-card-list" style={{ marginTop: 12 }}>
          {d.mensajes.map(m => {
            const [lab, badge] = ESTADOS_MSG[m.estado] || [m.estado, 'badge-gray']
            return (
              <div key={m.id} className="m-card pi-msg">
                <div style={{ display: 'flex', gap: 8, alignItems: 'center', flexWrap: 'wrap' }}>
                  <span className={`badge ${badge}`}>{lab}</span>
                  <b style={{ fontSize: 13 }}>{provPorId[m.proveedor_id]?.razon_social_declarada || 'proveedor sin cargar'}</b>
                  <span className="pi-sub">{m.idioma || '—'} · {fmtFechaHora(m.actualizado_en || m.creado_en)}</span>
                </div>
                <div className="pi-msg-cuerpo">
                  <div><span className="data-label">Original</span><p>{m.original || '—'}</p></div>
                  <div><span className="data-label">Traducción</span><p>{m.traduccion || '—'}</p></div>
                </div>
                {m.estado === 'SEND_UNKNOWN' && <p className="pi-sub pi-rojo">No se sabe si salió: hay que mirar la conversación antes de reenviar. Nunca se reenvía a ciegas.</p>}
              </div>
            )
          })}
        </div>
      )}
      <p className="pi-sub" style={{ marginTop: 8 }}>Lo que escriben los proveedores son datos, no instrucciones. Nunca se inventan volúmenes ni otras cotizaciones, y no se revela el presupuesto máximo.</p>
    </div>
  )
}

// ─── Cotizaciones + comparador ──────────────────────────────
function Cotizaciones({ d, recargar, toast, provPorId }) {
  const ultimaFicha = d.fichas[d.fichas.length - 1]?.version || null
  const [cant, setCant] = useState('50')
  const [merma, setMerma] = useState('3')
  const [tc, setTc] = useState({ USD: '', CNY: '', fecha: '', fuente: '' })
  const [abierto, setAbierto] = useState(false)
  const [orden, setOrden] = useState(null) // cotización para armar orden

  const filas = useMemo(() => {
    const q = parseInt(cant, 10) || 0
    const m = Math.min(Math.max(Number(String(merma).replace(',', '.')) || 0, 0), 99) / 100
    const ahora = new Date()
    return d.cotizaciones.map(c => {
      const esc = (Array.isArray(c.escalones) ? c.escalones : []).filter(e => e && e.cantidad != null && e.precio_unit_minor != null).sort((a, b) => a.cantidad - b.cantidad)
      let elegido = esc.filter(e => e.cantidad <= q).pop()
      const bajoMoq = !elegido && esc.length > 0
      if (!elegido) elegido = esc[0]
      let pyg = null, errTc = null
      if (elegido) {
        try { pyg = convertirAPYG(elegido.precio_unit_minor, c.moneda, c.moneda === 'PYG' ? null : (tc[c.moneda] || null)).pyg } catch (e) { errTc = e.message }
      }
      const porVendible = pyg == null ? null : Math.round(pyg / (1 - m))
      return { c, elegido, bajoMoq, pyg, porVendible, errTc, otraFicha: ultimaFicha && c.ficha_version && c.ficha_version !== ultimaFicha, venc: vencida(c.valida_hasta, ahora) }
    }).sort((a, b) => (a.porVendible ?? Infinity) - (b.porVendible ?? Infinity))
  }, [d.cotizaciones, cant, merma, tc, ultimaFicha])

  const quitar = async (id) => {
    if (!confirm('¿Borrar esta cotización?')) return
    try { await borrarCotizacion(id); recargar() } catch (e) { toast(e.message, 'error') }
  }

  return (
    <div className="card">
      <div className="pi-barra">
        <div className="section-label"><Scale size={12} /> Cotizaciones y comparador</div>
        <button className="btn btn-primary btn-sm" onClick={() => setAbierto(true)} disabled={d.proveedores.length === 0} title={d.proveedores.length === 0 ? 'Cargá primero un proveedor (abajo)' : ''}><Plus size={13} /> Cargar cotización</button>
      </div>
      <div className="form-grid form-grid-3" style={{ marginTop: 10 }}>
        <Campo label="Cantidad a evaluar" hint="Elige el escalón de cada cotización."><input className="form-input" value={cant} onChange={e => setCant(e.target.value)} inputMode="numeric" /></Campo>
        <Campo label="Merma / defectos (%)" hint="Para pasar a unidad vendible."><input className="form-input" value={merma} onChange={e => setMerma(e.target.value)} inputMode="decimal" /></Campo>
        <Campo label="1 USD = ₲ · 1 CNY = ₲" hint={tc.fecha || tc.fuente ? `${tc.fuente || 'sin fuente'} · ${tc.fecha || 'sin fecha'}` : 'Con fecha y fuente; sin cambio no se convierte.'}>
          <div style={{ display: 'flex', gap: 6 }}>
            <input className="form-input" placeholder="USD" value={tc.USD} onChange={e => setTc(t => ({ ...t, USD: e.target.value.replace(',', '.') }))} />
            <input className="form-input" placeholder="CNY" value={tc.CNY} onChange={e => setTc(t => ({ ...t, CNY: e.target.value.replace(',', '.') }))} />
          </div>
        </Campo>
        <Campo label="Fuente del cambio"><input className="form-input" value={tc.fuente} onChange={e => setTc(t => ({ ...t, fuente: e.target.value }))} placeholder="BCP, cambios Chaco…" /></Campo>
        <Campo label="Fecha del cambio"><input type="date" className="form-input" value={tc.fecha} onChange={e => setTc(t => ({ ...t, fecha: e.target.value }))} /></Campo>
      </div>

      {filas.length === 0 ? (
        <Vacio icono={Scale} titulo="Sin cotizaciones" desc="Ideal: 3 cotizaciones comparables de la misma ficha. Si responde uno solo, queda a la vista la concentración." />
      ) : (
        <div className="table-wrapper" style={{ marginTop: 10 }}>
          <table className="tabla-responsive">
            <thead><tr><th>Proveedor</th><th>Tipo</th><th>Ficha</th><th>Escalón usado</th><th>Precio unit. original</th><th>₲ por unidad comprada</th><th>₲ por unidad vendible</th><th>MOQ</th><th>Envío / lugar</th><th>Vence</th><th></th></tr></thead>
            <tbody>
              {filas.map(({ c, elegido, bajoMoq, pyg, porVendible, errTc, otraFicha, venc }) => (
                <tr key={c.id} className={venc ? 'pi-vencida' : ''}>
                  <td data-label="Proveedor" style={{ whiteSpace: 'normal' }}>{provPorId[c.proveedor_id]?.razon_social_declarada || '—'}<div className="pi-sub">{provPorId[c.proveedor_id]?.plataforma}</div></td>
                  <td data-label="Tipo"><span className={`badge ${c.tipo === 'firme' ? 'badge-green' : c.tipo === 'escaparate' ? 'badge-yellow' : 'badge-blue'}`}>{c.tipo === 'escaparate' ? 'escaparate (no firme)' : c.tipo}</span></td>
                  <td data-label="Ficha">v{c.ficha_version ?? '?'} {otraFicha && <span className="badge badge-red">otra versión</span>}<div className="pi-sub">{c.variante || ''}</div></td>
                  <td data-label="Escalón">{elegido ? `${elegido.cantidad} u` : '—'}{bajoMoq && <div className="pi-sub pi-rojo">la cantidad no llega al primer escalón</div>}</td>
                  <td data-label="Precio original" className="pi-num">{elegido ? fmtDinero(elegido.precio_unit_minor, c.moneda) : 'desconocido'}</td>
                  <td data-label="₲ comprada" className="pi-num">{pyg != null ? fmtGs(pyg) : <span className="pi-desc" title={errTc || ''}>{errTc ? 'falta cambio' : '—'}</span>}</td>
                  <td data-label="₲ vendible" className="pi-num"><b>{porVendible != null ? fmtGs(porVendible) : '—'}</b></td>
                  <td data-label="MOQ" className="pi-num">{c.moq ?? '—'}</td>
                  <td data-label="Envío" style={{ whiteSpace: 'normal' }}>{c.incluye_envio || 'sin dato'}<div className="pi-sub">{[c.incoterm, c.lugar].filter(Boolean).join(' · ')}</div></td>
                  <td data-label="Vence">{fmtFecha(c.valida_hasta)} {venc && <span className="badge badge-yellow">vencida</span>}</td>
                  <td style={{ whiteSpace: 'nowrap' }}>
                    <button className="btn btn-ghost btn-sm" onClick={() => setOrden(c)} title="Armar orden propuesta (no compra nada)"><ShoppingBag size={12} /> Orden</button>
                    <button className="btn btn-ghost btn-sm btn-icon" onClick={() => quitar(c.id)}><Trash2 size={12} /></button>
                  </td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      )}
      <p className="pi-sub" style={{ marginTop: 6 }}>Es el precio de compra normalizado, no el costo puesto: flete, tributos, agente y merma real van en Rentabilidad. "Escaparate" es el precio publicado, nunca una cotización firme. Una cotización de otra versión de la ficha no es comparable. El silencio del proveedor no extiende una cotización vencida.</p>

      {abierto && <NuevaCotizacion d={d} ultimaFicha={ultimaFicha} onCerrar={() => setAbierto(false)} onListo={() => { setAbierto(false); recargar() }} toast={toast} />}
      {orden && <NuevaOrden d={d} cot={orden} prov={provPorId[orden.proveedor_id]} cant={parseInt(cant, 10) || orden.moq || 1} onCerrar={() => setOrden(null)} onListo={() => { setOrden(null); recargar() }} toast={toast} />}
    </div>
  )
}

function NuevaCotizacion({ d, ultimaFicha, onCerrar, onListo, toast }) {
  const [f, setF] = useState({ proveedor_id: d.proveedores[0]?.id || '', ficha_version: ultimaFicha ? String(ultimaFicha) : '', variante: '', moneda: 'USD', escalones: [{ cantidad: '', precio: '' }], moq: '', incoterm: '', lugar: '', incluye_envio: '', plazo_dias: '', valida_hasta: '', costo_muestra: '', peso_bruto_g: '', unidades_por_caja: '', medidas_caja_cm: '', tipo: 'firme' })
  const set = (k) => (e) => setF(p => ({ ...p, [k]: e.target.value }))
  const int = (t) => (String(t).trim() === '' ? null : parseInt(String(t).replace(/\D/g, ''), 10))

  const guardar = async () => {
    const escalones = f.escalones.filter(e => e.cantidad && e.precio).map(e => ({ cantidad: int(e.cantidad), precio_unit_minor: aMinor(e.precio, f.moneda) }))
    if (!f.proveedor_id) { toast('Elegí el proveedor', 'error'); return }
    if (escalones.some(e => e.precio_unit_minor == null || !e.cantidad)) { toast('Algún escalón tiene cantidad o precio inválido', 'error'); return }
    try {
      await crearCotizacion({
        candidato_id: d.candidato.id, proveedor_id: f.proveedor_id, ficha_version: int(f.ficha_version), variante: f.variante.trim() || null,
        moneda: f.moneda, escalones, moq: int(f.moq), incoterm: f.incoterm.trim() || null, lugar: f.lugar.trim() || null,
        incluye_envio: f.incluye_envio.trim() || null, plazo_dias: int(f.plazo_dias), valida_hasta: fechaLocalAISO(f.valida_hasta, true),
        costo_muestra_minor: f.costo_muestra ? aMinor(f.costo_muestra, f.moneda) : null, peso_bruto_g: int(f.peso_bruto_g),
        unidades_por_caja: int(f.unidades_por_caja), medidas_caja_cm: f.medidas_caja_cm.trim() || null, tipo: f.tipo,
      })
      toast('Cotización cargada', 'success'); onListo()
    } catch (e) { toast(e.message, 'error') }
  }

  return (
    <Modal titulo="Cargar cotización (manual)" onCerrar={onCerrar} ancho="modal-xl" pie={<><button className="btn btn-ghost" onClick={onCerrar}>Cancelar</button><button className="btn btn-primary" onClick={guardar}>Guardar</button></>}>
      <div className="form-grid form-grid-3">
        <Campo label="Proveedor"><select className="form-select" value={f.proveedor_id} onChange={set('proveedor_id')}>{d.proveedores.map(p => <option key={p.id} value={p.id}>{p.razon_social_declarada || p.id_externo || p.id} · {p.plataforma}</option>)}</select></Campo>
        <Campo label="Tipo"><select className="form-select" value={f.tipo} onChange={set('tipo')}>{TIPOS_COT.map(([v, l]) => <option key={v} value={v}>{l}</option>)}</select></Campo>
        <Campo label="Versión de ficha" hint="La cotización tiene que corresponder a esta versión."><input className="form-input" value={f.ficha_version} onChange={set('ficha_version')} /></Campo>
        <Campo label="Variante"><input className="form-input" value={f.variante} onChange={set('variante')} /></Campo>
        <Campo label="Moneda"><SelectMoneda value={f.moneda} onChange={(m) => setF(p => ({ ...p, moneda: m }))} /></Campo>
        <Campo label="MOQ"><input className="form-input" value={f.moq} onChange={set('moq')} inputMode="numeric" /></Campo>
        <Campo label="Escalones (cantidad → precio unitario)" span={3}>
          {f.escalones.map((e, i) => (
            <div key={i} style={{ display: 'flex', gap: 6, marginBottom: 6 }}>
              <input className="form-input" placeholder="cantidad" value={e.cantidad} onChange={ev => setF(p => ({ ...p, escalones: p.escalones.map((x, j) => j === i ? { ...x, cantidad: ev.target.value } : x) }))} />
              <input className="form-input" placeholder={`precio unit. ${f.moneda}`} value={e.precio} onChange={ev => setF(p => ({ ...p, escalones: p.escalones.map((x, j) => j === i ? { ...x, precio: ev.target.value } : x) }))} />
              <button className="btn btn-ghost btn-sm btn-icon" onClick={() => setF(p => ({ ...p, escalones: p.escalones.filter((_, j) => j !== i) }))}><Trash2 size={12} /></button>
            </div>
          ))}
          <button className="btn btn-ghost btn-sm" onClick={() => setF(p => ({ ...p, escalones: [...p.escalones, { cantidad: '', precio: '' }] }))}><Plus size={12} /> Escalón</button>
        </Campo>
        <Campo label="Incoterm"><input className="form-input" value={f.incoterm} onChange={set('incoterm')} placeholder="EXW, FOB, DDP…" /></Campo>
        <Campo label="Lugar exacto"><input className="form-input" value={f.lugar} onChange={set('lugar')} /></Campo>
        <Campo label="Qué incluye el envío" hint='"DDP" o "envío incluido" sin alcance por escrito no resuelve la importación.'><input className="form-input" value={f.incluye_envio} onChange={set('incluye_envio')} /></Campo>
        <Campo label="Plazo (días)"><input className="form-input" value={f.plazo_dias} onChange={set('plazo_dias')} /></Campo>
        <Campo label="Válida hasta"><input type="date" className="form-input" value={f.valida_hasta} onChange={set('valida_hasta')} /></Campo>
        <Campo label={`Costo de muestra (${f.moneda})`}><input className="form-input" value={f.costo_muestra} onChange={set('costo_muestra')} /></Campo>
        <Campo label="Peso bruto (g)"><input className="form-input" value={f.peso_bruto_g} onChange={set('peso_bruto_g')} /></Campo>
        <Campo label="Unidades por caja"><input className="form-input" value={f.unidades_por_caja} onChange={set('unidades_por_caja')} /></Campo>
        <Campo label="Medidas de la caja (cm)"><input className="form-input" value={f.medidas_caja_cm} onChange={set('medidas_caja_cm')} /></Campo>
      </div>
    </Modal>
  )
}

// ─── Órdenes de compra ──────────────────────────────────────
function NuevaOrden({ d, cot, prov, cant, onCerrar, onListo, toast }) {
  const esc = (Array.isArray(cot.escalones) ? cot.escalones : []).filter(e => e.cantidad <= cant).sort((a, b) => a.cantidad - b.cantidad).pop() || cot.escalones?.[0]
  const plataforma = prov?.plataforma || 'otro'
  const [f, setF] = useState({ cantidad: String(cant), precio: esc ? String(esc.precio_unit_minor / (cot.moneda === 'PYG' ? 1 : 100)) : '', envio: '', deposito_destino: '', forwarder: '', notas: '' })
  const set = (k) => (e) => setF(p => ({ ...p, [k]: e.target.value }))
  const cantidad = parseInt(f.cantidad, 10) || 0
  const pu = aMinor(f.precio, cot.moneda)
  const env = f.envio ? aMinor(f.envio, cot.moneda) : 0
  const total = pu != null && cantidad ? pu * cantidad + (env || 0) : null

  const guardar = async () => {
    if (!cantidad || pu == null) { toast('Falta cantidad o precio', 'error'); return }
    if (plataforma === '1688' && !f.deposito_destino.trim()) toast('1688 no envía al exterior: sin depósito de un agente en China la orden queda bloqueada.', 'info')
    try {
      await crearOrden({
        candidato_id: d.candidato.id, proveedor_id: cot.proveedor_id, cotizacion_id: cot.id, plataforma, variante: cot.variante,
        cantidad, precio_unit_minor: pu, envio_minor: env || 0, total_minor: total, moneda: cot.moneda,
        deposito_destino: f.deposito_destino.trim() || null, forwarder: f.forwarder.trim() || null, notas: f.notas.trim() || null,
      })
      toast('Orden propuesta guardada como BORRADOR. No se compró nada.', 'success'); onListo()
    } catch (e) { toast(e.message, 'error') }
  }

  return (
    <Modal titulo="Orden propuesta (borrador)" onCerrar={onCerrar} pie={<><button className="btn btn-ghost" onClick={onCerrar}>Cancelar</button><button className="btn btn-primary" onClick={guardar}>Guardar borrador</button></>}>
      <div className="alert alert-warning" style={{ marginBottom: 12 }}><ShieldAlert size={15} /> El pago lo hace Enrique; 1688 necesita depósito de un agente en China.</div>
      <div className="form-grid">
        <Campo label="Proveedor"><input className="form-input" value={`${prov?.razon_social_declarada || '—'} · ${plataforma}`} disabled /></Campo>
        <Campo label="Cantidad"><input className="form-input" value={f.cantidad} onChange={set('cantidad')} /></Campo>
        <Campo label={`Precio unitario (${cot.moneda})`}><input className="form-input" value={f.precio} onChange={set('precio')} /></Campo>
        <Campo label={`Envío (${cot.moneda})`}><input className="form-input" value={f.envio} onChange={set('envio')} /></Campo>
        <Campo label="Depósito de destino" hint={plataforma === '1688' ? 'Obligatorio para 1688: dirección en China del agente/forwarder.' : null}><input className="form-input" value={f.deposito_destino} onChange={set('deposito_destino')} /></Campo>
        <Campo label="Agente / forwarder"><input className="form-input" value={f.forwarder} onChange={set('forwarder')} /></Campo>
        <Campo label="Notas" span={2}><input className="form-input" value={f.notas} onChange={set('notas')} /></Campo>
      </div>
      <p style={{ marginTop: 10, fontSize: 14 }}>Total: <b className="pi-num">{total != null ? fmtDinero(total, cot.moneda) : 'desconocido'}</b></p>
    </Modal>
  )
}

function Ordenes({ d, recargar, toast, provPorId }) {
  const [cambio, setCambio] = useState(null) // { orden, estado, texto, tracking }
  if (d.ordenes === null) return <div className="card card-sm"><p className="pi-desc">La tabla de órdenes (pi_ordenes_compra) todavía no está en la base.</p></div>

  const aplicar = async () => {
    const { orden, estado, texto, tracking } = cambio
    const necesitaTexto = !['BORRADOR', 'CANCELADA'].includes(estado) && !orden.confirmada_texto
    if (necesitaTexto && !texto.trim()) { toast('Para pasar de borrador hace falta lo que escribió Enrique al confirmar producto y total.', 'error'); return }
    try {
      const cambios = { estado }
      if (necesitaTexto) cambios.confirmada_texto = texto.trim() // confirmada_en la pone la base
      if (tracking !== undefined) cambios.tracking = tracking.trim() || null
      await actualizarOrden(orden.id, cambios)
      toast('Orden actualizada', 'success'); setCambio(null); recargar()
    } catch (e) { toast(e.message, 'error') }
  }

  return (
    <div className="card">
      <div className="section-label"><ShoppingBag size={12} /> Órdenes</div>
      <div className="alert alert-warning" style={{ marginTop: 8 }}><ShieldAlert size={15} style={{ flexShrink: 0, marginTop: 1 }} /> El pago lo hace Enrique; 1688 necesita depósito de un agente en China.</div>
      {d.ordenes.length === 0 ? (
        <p className="pi-desc" style={{ marginTop: 8 }}>Sin órdenes. Se arman desde una cotización (botón "Orden") y quedan en borrador hasta que Enrique confirma producto y total.</p>
      ) : (
        <div className="table-wrapper" style={{ marginTop: 8 }}>
          <table className="tabla-responsive">
            <thead><tr><th>Estado</th><th>Proveedor</th><th>Cantidad</th><th>Precio unit.</th><th>Envío</th><th>Total</th><th>Depósito</th><th>Confirmación de Enrique</th><th>Tracking</th><th></th></tr></thead>
            <tbody>
              {d.ordenes.map(o => {
                const [, lab, badge] = ESTADOS_ORDEN.find(e => e[0] === o.estado) || [o.estado, o.estado, 'badge-gray']
                const bloqueada = o.plataforma === '1688' && !o.deposito_destino
                return (
                  <tr key={o.id}>
                    <td data-label="Estado"><span className={`badge ${badge}`}>{lab}</span>{bloqueada && <div className="pi-sub pi-rojo">bloqueada: falta depósito en China</div>}</td>
                    <td data-label="Proveedor">{provPorId[o.proveedor_id]?.razon_social_declarada || '—'}<div className="pi-sub">{o.plataforma}</div></td>
                    <td data-label="Cantidad" className="pi-num">{o.cantidad}</td>
                    <td data-label="Precio unit." className="pi-num">{fmtDinero(o.precio_unit_minor, o.moneda)}</td>
                    <td data-label="Envío" className="pi-num">{fmtDinero(o.envio_minor, o.moneda)}</td>
                    <td data-label="Total" className="pi-num"><b>{fmtDinero(o.total_minor, o.moneda)}</b></td>
                    <td data-label="Depósito" style={{ whiteSpace: 'normal' }}>{o.deposito_destino || '—'}<div className="pi-sub">{o.forwarder || ''}</div></td>
                    <td data-label="Confirmación" style={{ whiteSpace: 'normal', maxWidth: 220 }}>{o.confirmada_texto ? <>"{o.confirmada_texto}"<div className="pi-sub">{fmtFechaHora(o.confirmada_en)}</div></> : <span className="pi-desc">sin confirmar</span>}</td>
                    <td data-label="Tracking">{o.tracking || '—'}</td>
                    <td><button className="btn btn-ghost btn-sm" onClick={() => setCambio({ orden: o, estado: o.estado, texto: '', tracking: o.tracking || '' })}>Estado</button></td>
                  </tr>
                )
              })}
            </tbody>
          </table>
        </div>
      )}
      {cambio && (
        <Modal titulo="Cambiar estado de la orden" onCerrar={() => setCambio(null)} pie={<><button className="btn btn-ghost" onClick={() => setCambio(null)}>Cancelar</button><button className="btn btn-primary" onClick={aplicar}>Guardar</button></>}>
          <div className="form-grid">
            <Campo label="Estado" span={2}>
              <select className="form-select" value={cambio.estado} onChange={e => setCambio(c => ({ ...c, estado: e.target.value }))}>{ESTADOS_ORDEN.map(([v, l]) => <option key={v} value={v}>{l}</option>)}</select>
            </Campo>
            {!['BORRADOR', 'CANCELADA'].includes(cambio.estado) && !cambio.orden.confirmada_texto && (
              <Campo label="Tu confirmación de producto y total (textual)" span={2} hint="Sacar una orden de borrador o marcarla pagada lo puede hacer solo Enrique, con su sesión: la base rechaza a cualquier otro.">
                <textarea className="form-textarea" value={cambio.texto} onChange={e => setCambio(c => ({ ...c, texto: e.target.value }))} />
              </Campo>
            )}
            <Campo label="Tracking" span={2}><input className="form-input" value={cambio.tracking} onChange={e => setCambio(c => ({ ...c, tracking: e.target.value }))} /></Campo>
          </div>
          <p className="pi-sub" style={{ marginTop: 8 }}>Cambiar el estado acá solo registra lo que pasó. El pago lo hace Enrique en la plataforma; este sistema no paga ni ingresa datos de tarjetas.</p>
        </Modal>
      )}
    </div>
  )
}

// ─── Proveedores ────────────────────────────────────────────
function ListaProveedores({ d, recargar, toast }) {
  const [abierto, setAbierto] = useState(false)
  const [f, setF] = useState({ plataforma: 'alibaba', id_externo: '', razon_social_declarada: '', url: '', riesgos: '', notas: '' })
  const set = (k) => (e) => setF(p => ({ ...p, [k]: e.target.value }))
  const guardar = async () => {
    if (!f.razon_social_declarada.trim() && !f.id_externo.trim()) { toast('Poné al menos la razón social declarada o el ID de la plataforma', 'error'); return }
    try {
      await crearProveedor(Object.fromEntries(Object.entries(f).map(([k, v]) => [k, typeof v === 'string' ? (v.trim() || null) : v])))
      toast('Proveedor cargado', 'success'); setAbierto(false); setF({ plataforma: 'alibaba', id_externo: '', razon_social_declarada: '', url: '', riesgos: '', notas: '' }); recargar()
    } catch (e) { toast(e.message, 'error') }
  }
  return (
    <div className="card">
      <div className="pi-barra">
        <div className="section-label">Proveedores ({d.proveedores.length})</div>
        <button className="btn btn-secondary btn-sm" onClick={() => setAbierto(a => !a)}><Plus size={12} /> Proveedor</button>
      </div>
      {abierto && (
        <div className="form-grid form-grid-3" style={{ marginTop: 10 }}>
          <Campo label="Plataforma"><select className="form-select" value={f.plataforma} onChange={set('plataforma')}>{PLATAFORMAS.map(([v, l]) => <option key={v} value={v}>{l}</option>)}</select></Campo>
          <Campo label="ID en la plataforma (real)"><input className="form-input" value={f.id_externo} onChange={set('id_externo')} /></Campo>
          <Campo label="Razón social declarada" hint="Lo que dice el proveedor; no está verificado."><input className="form-input" value={f.razon_social_declarada} onChange={set('razon_social_declarada')} /></Campo>
          <Campo label="Link"><input className="form-input" value={f.url} onChange={set('url')} /></Campo>
          <Campo label="Riesgos"><input className="form-input" value={f.riesgos} onChange={set('riesgos')} /></Campo>
          <Campo label="Notas"><input className="form-input" value={f.notas} onChange={set('notas')} /></Campo>
          <div style={{ gridColumn: '1 / -1', display: 'flex', justifyContent: 'flex-end', gap: 8 }}>
            <button className="btn btn-ghost btn-sm" onClick={() => setAbierto(false)}>Cancelar</button>
            <button className="btn btn-primary btn-sm" onClick={guardar}>Guardar</button>
          </div>
        </div>
      )}
      {d.proveedores.length > 0 && (
        <div className="m-card-list" style={{ marginTop: 10 }}>
          {d.proveedores.map(p => (
            <div key={p.id} className="m-card" style={{ padding: '10px 14px' }}>
              <div style={{ fontWeight: 600, fontSize: 13 }}>{p.razon_social_declarada || p.id_externo} <span className="badge badge-gray">{p.plataforma}</span> {esModoDemo() && <Demo />}</div>
              <div className="pi-sub">{p.id_externo || 'sin ID'} {urlSegura(p.url) && <a className="pi-link" href={urlSegura(p.url)} target="_blank" rel="noopener noreferrer">link</a>} {p.riesgos ? `· riesgos: ${p.riesgos}` : ''}</div>
            </div>
          ))}
        </div>
      )}
      <p className="pi-sub" style={{ marginTop: 6 }}>Los proveedores son comunes a todos los candidatos. Nada de contactos personales en notas: este módulo no guarda credenciales.</p>
    </div>
  )
}
