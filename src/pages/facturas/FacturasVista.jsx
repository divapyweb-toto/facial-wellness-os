// src/pages/facturas/FacturasVista.jsx
// Parte visual del panel de facturas: recibe todo por props (sin Supabase),
// así se puede revisar con datos inventados sin tocar la base.
import { useMemo, useState } from 'react'
import {
  FileText, FileSpreadsheet, Download, Copy, MessageCircle, Eye, AlertTriangle,
  Clock, XCircle, Ban, Receipt, CalendarDays, Loader2, FlaskConical, Unlock, X, Scale,
} from 'lucide-react'
import { formatGs } from '../../lib/supabase'
import { etiquetaMes, mesesRecientes } from '../../lib/fechas'
import {
  PESTANAS, filtrarPorPestana, contarPorPestana, resumenMes, esModoPrueba, infoEstado,
  siglaTipo, nombreTipo, numeroCompleto, etiquetaPedido, etiquetaCliente, etiquetaRuc,
  ivaTotal, fechaHoraCorta, fechaFactura,
} from './logica'
import { etiquetaMotivo, criterioValido } from './retenidos'
import './facturas.css'

const fechaCorta = (iso) => (iso ? fechaHoraCorta(iso).slice(0, 10) : '—')

/** Modal: pide el criterio de la contadora antes de liberar (obligatorio). */
function ModalLiberar({ fila, ocupado, onCancelar, onConfirmar }) {
  const [criterio, setCriterio] = useState('')
  const valido = criterioValido(criterio)
  return (
    <div className="modal-overlay" onClick={e => e.target === e.currentTarget && !ocupado && onCancelar()}>
      <div className="modal" role="dialog" aria-modal="true" aria-labelledby="fac-liberar-titulo">
        <div className="modal-header">
          <h2 className="modal-title" id="fac-liberar-titulo">Liberar pedido {fila.pedido}</h2>
          <button className="modal-close" onClick={onCancelar} disabled={ocupado} aria-label="Cerrar"><X size={18} /></button>
        </div>
        <p className="fac-ret-ayuda">
          {fila.cliente} · {formatGs(fila.monto)} · entregado {fechaCorta(fila.entregado_en)} · {fila.medio_pago}.
          Al liberarlo, la cola SIFEN lo factura en la próxima corrida (hasta 10 min), con fecha de emisión de ese momento.
        </p>
        <div className="form-group">
          <label className="form-label" htmlFor="fac-criterio">Criterio de la contadora (obligatorio)</label>
          <textarea id="fac-criterio" className="form-input" rows={3} value={criterio} autoFocus
            placeholder="Ej.: facturar con fecha de hoy; la venta se declara en el mes de emisión"
            onChange={e => setCriterio(e.target.value)} maxLength={2000} />
        </div>
        <div className="modal-footer">
          <button className="btn btn-secondary" onClick={onCancelar} disabled={ocupado}>Cancelar</button>
          <button className="btn btn-primary" disabled={!valido || ocupado} onClick={() => onConfirmar(criterio)}>
            {ocupado ? <Loader2 size={14} className="spinning" /> : <Unlock size={14} />}Liberar y facturar
          </button>
        </div>
      </div>
    </div>
  )
}

/** Pestaña "Pendientes de criterio contable": pedidos retenidos (p. ej. entregados antes del corte). */
function Retenidos({ filas, cargando, error, onLiberar, liberando, onExportar }) {
  const [abierto, setAbierto] = useState(null)
  const confirmar = async (criterio) => {
    if (await onLiberar(abierto, criterio)) setAbierto(null)
  }
  return (
    <>
      <div className="fac-ret-head">
        <p className="fac-ret-ayuda">
          No se facturan solos. La contadora decide el criterio; al liberar, la cola los factura. Solo pedidos de Shopify.
        </p>
        <button className="btn btn-secondary btn-sm" disabled={cargando || !filas.length} onClick={onExportar} title="CSV para la contadora">
          <Download size={14} />CSV contadora
        </button>
      </div>
      {error && <div className="fac-alerta-error"><AlertTriangle size={15} />No se pudieron cargar los pendientes: {error}</div>}
      {cargando ? (
        <div className="skeleton skeleton-hero" />
      ) : filas.length === 0 ? (
        <div className="card">
          <div className="empty-state">
            <div className="empty-state-icon"><Scale size={22} /></div>
            <div className="empty-state-title">Nada pendiente de criterio</div>
            <div className="empty-state-desc">Si un pedido entregado antes del corte llega a facturación, aparece acá en vez de facturarse.</div>
          </div>
        </div>
      ) : (
        <>
          <div className="table-wrapper desktop-only">
            <table className="fac-tabla">
              <thead>
                <tr>
                  <th>Pedido</th><th>Cliente</th><th>RUC/CI</th><th className="num">Monto</th><th>Entrega</th>
                  <th>Cobro</th><th>Medio de pago</th><th>Courier</th><th>Motivo</th><th></th>
                </tr>
              </thead>
              <tbody>
                {filas.map(f => (
                  <tr key={f.id}>
                    <td className="mono">{f.pedido}</td>
                    <td className="fac-cliente" title={f.cliente}>{f.cliente}</td>
                    <td className="mono">{f.ruc_ci || '—'}</td>
                    <td className="num">{formatGs(f.monto)}</td>
                    <td className="muted">{fechaCorta(f.entregado_en)}</td>
                    <td className="muted">{fechaCorta(f.cobrado_en)}</td>
                    <td>{f.medio_pago}</td>
                    <td>{f.courier || '—'}</td>
                    <td><span className="badge badge-yellow">{etiquetaMotivo(f.motivo)}</span></td>
                    <td>
                      <button className="btn btn-secondary btn-sm" disabled={liberando === f.id} onClick={() => setAbierto(f)}>
                        <Unlock size={13} />Liberar
                      </button>
                    </td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
          <div className="mobile-only">
            <div className="fac-cards">
              {filas.map(f => (
                <div key={f.id} className="product-card-mobile">
                  <div className="product-card-mobile-row">
                    <span className="fac-num-movil">{f.pedido}</span>
                    <span className="badge badge-yellow">{etiquetaMotivo(f.motivo)}</span>
                  </div>
                  <div className="product-card-mobile-row">
                    <span className="fac-cliente">{f.cliente}</span>
                    <b>{formatGs(f.monto)}</b>
                  </div>
                  <div className="product-card-mobile-row fac-meta">
                    <span>Entrega {fechaCorta(f.entregado_en)} · {f.medio_pago}</span>
                    <span>{f.courier || '—'}</span>
                  </div>
                  {f.ruc_ci && <div className="fac-meta">{f.ruc_ci}</div>}
                  <button className="btn btn-secondary fac-ret-btn-movil" disabled={liberando === f.id} onClick={() => setAbierto(f)}>
                    <Unlock size={14} />Liberar
                  </button>
                </div>
              ))}
            </div>
          </div>
        </>
      )}
      {abierto && (
        <ModalLiberar fila={abierto} ocupado={liberando === abierto.id} onCancelar={() => setAbierto(null)} onConfirmar={confirmar} />
      )}
    </>
  )
}

function Kpi({ label, valor, sub, color, Icon }) {
  return (
    <div className="kpi-card">
      <div className="kpi-label">{label}</div>
      <div className={`kpi-value ${color || ''}`}>{valor}</div>
      {sub && <div className="kpi-sub">{sub}</div>}
      {Icon && <div className="kpi-icon" style={{ background: 'var(--bg-hover)' }}><Icon size={14} color="var(--text-muted)" /></div>}
    </div>
  )
}

function Acciones({ f, onVerKude, onCopiarCdc, onReenviar, ocupado }) {
  return (
    <div className="fac-acciones">
      <button className="btn btn-ghost btn-sm btn-icon" title={f.kude_path ? 'Ver KuDE (PDF)' : 'Sin KuDE todavía'}
        disabled={!f.kude_path || ocupado} onClick={() => onVerKude(f)} aria-label="Ver KuDE">
        <Eye size={14} />
      </button>
      <button className="btn btn-ghost btn-sm btn-icon" title={f.cdc ? 'Copiar CDC' : 'Sin CDC todavía'}
        disabled={!f.cdc} onClick={() => onCopiarCdc(f)} aria-label="Copiar CDC">
        <Copy size={14} />
      </button>
      <button className="btn btn-ghost btn-sm btn-icon" title={f.kude_enviado_en ? `Reenviar por WhatsApp (último envío ${fechaHoraCorta(f.kude_enviado_en)})` : 'Reenviar por WhatsApp'}
        disabled={f.estado !== 'aprobada' || ocupado} onClick={() => onReenviar(f)} aria-label="Reenviar por WhatsApp">
        {ocupado ? <Loader2 size={14} className="spinning" /> : <MessageCircle size={14} />}
      </button>
    </div>
  )
}

function Motivo({ f }) {
  const texto = f.motivo_rechazo || (f.estado === 'error' || f.estado === 'revisar' ? f.error : null)
  if (!texto) return null
  return <div className="fac-motivo" title={texto}>{f.codigo_respuesta ? `${f.codigo_respuesta} · ` : ''}{texto}</div>
}

export default function FacturasVista({
  mes, onCambiarMes, facturas, nombresPedido = {}, cargando, noActivada, errorCarga,
  onVerKude, onCopiarCdc, onReenviar, onExportar, reenviando, exportando, ahora,
  retenidos = [], cargandoRetenidos = false, errorRetenidos = null, onLiberar, liberando, onExportarRetenidos,
}) {
  const [pestana, setPestana] = useState('todas')
  const meses = useMemo(() => mesesRecientes(12, ahora), [ahora])
  const resumen = useMemo(() => resumenMes(facturas, ahora), [facturas, ahora])
  const conteo = useMemo(() => contarPorPestana(facturas), [facturas])
  const visibles = useMemo(() => filtrarPorPestana(facturas, pestana), [facturas, pestana])
  const prueba = esModoPrueba(facturas)
  const t = resumen.totales
  const props = { onVerKude, onCopiarCdc, onReenviar }

  return (
    <div className="fade-in fac-pagina">
      <div className="page-header fac-header">
        <div>
          <h1 className="page-title">Facturas</h1>
          <p className="page-subtitle">Facturación electrónica SIFEN · {etiquetaMes(mes)} · hora de Asunción</p>
        </div>
        <div className="page-actions">
          <div className="fac-mes">
            <CalendarDays size={14} />
            <select className="form-select" value={mes} onChange={e => onCambiarMes(e.target.value)} aria-label="Mes">
              {(meses.includes(mes) ? meses : [mes, ...meses]).map(m => <option key={m} value={m}>{etiquetaMes(m)}</option>)}
            </select>
          </div>
          {!noActivada && (
            <>
              <button className="btn btn-secondary btn-sm" disabled={cargando || exportando || !facturas.length} onClick={() => onExportar('csv')} title="Comprobantes del mes en CSV (+ resumen)">
                <Download size={14} />CSV
              </button>
              <button className="btn btn-primary btn-sm" disabled={cargando || exportando || !facturas.length} onClick={() => onExportar('xlsx')} title="Excel con hoja de comprobantes y hoja de resumen">
                {exportando ? <Loader2 size={14} className="spinning" /> : <FileSpreadsheet size={14} />}Excel contadora
              </button>
            </>
          )}
        </div>
      </div>

      {noActivada ? (
        <div className="card">
          <div className="empty-state">
            <div className="empty-state-icon"><Receipt size={22} /></div>
            <div className="empty-state-title">La facturación electrónica todavía no está activada</div>
            <div className="empty-state-desc">Las tablas de facturas no existen en la base. Cuando se corra la migración de SIFEN, las facturas van a aparecer acá.</div>
          </div>
        </div>
      ) : (
        <>
          {prueba && (
            <div className="fac-prueba" role="status">
              <FlaskConical size={16} />
              <strong>Modo prueba — sin valor fiscal.</strong>
              <span>Hay comprobantes de ambiente de pruebas o simulados en este mes.</span>
            </div>
          )}
          {errorCarga && (
            <div className="fac-alerta-error"><AlertTriangle size={15} />No se pudieron cargar las facturas: {errorCarga}</div>
          )}

          {cargando ? (
            <div className="skeleton-page">
              <div className="fac-kpis">{[0, 1, 2, 3].map(i => <div key={i} className="skeleton skeleton-kpi" />)}</div>
              <div className="skeleton skeleton-hero" />
            </div>
          ) : (
            <>
              <div className="fac-kpis">
                <Kpi label="Facturas de hoy" valor={resumen.delDia} Icon={FileText} sub="emitidas hoy (Asunción)" />
                <Kpi label="Pendientes" valor={resumen.pendientes} color={resumen.pendientes ? 'yellow' : ''} Icon={Clock} sub="pendiente · enviada · error" />
                <Kpi label="Rechazadas" valor={resumen.rechazadas} color={resumen.rechazadas ? 'red' : ''} Icon={XCircle} sub="ver motivo en la pestaña" />
                <Kpi label="Canceladas" valor={resumen.canceladas} Icon={Ban} sub="evento de cancelación" />
              </div>

              <div className="card fac-total">
                <div className="fac-total-head">
                  <div>
                    <div className="kpi-label">Total facturado del mes</div>
                    <div className="fac-total-valor">{formatGs(t.total)}</div>
                    <div className="kpi-sub">{t.cantidad} comprobante{t.cantidad === 1 ? '' : 's'} aprobado{t.cantidad === 1 ? '' : 's'} · FE + ND − NC</div>
                  </div>
                  <div className="fac-total-iva">
                    <div className="kpi-label">Total IVA</div>
                    <div className="fac-total-valor sm">{formatGs(t.totalIva)}</div>
                  </div>
                </div>
                <div className="fac-iva-grid">
                  <div><span>Base 10 %</span><b>{formatGs(t.base10)}</b></div>
                  <div><span>IVA 10 %</span><b>{formatGs(t.iva10)}</b></div>
                  <div><span>Base 5 %</span><b>{formatGs(t.base5)}</b></div>
                  <div><span>IVA 5 %</span><b>{formatGs(t.iva5)}</b></div>
                  <div><span>Exento</span><b>{formatGs(t.exento)}</b></div>
                </div>
              </div>

              <div className="fac-tabs-wrap">
                <div className="tabs fac-tabs" role="tablist">
                  {PESTANAS.map(p => (
                    <button key={p.id} role="tab" aria-selected={pestana === p.id} className={`tab${pestana === p.id ? ' active' : ''}`} onClick={() => setPestana(p.id)}>
                      {p.label} <span className="fac-tab-n">{conteo[p.id]}</span>
                    </button>
                  ))}
                  <button role="tab" aria-selected={pestana === 'retenidos'} className={`tab${pestana === 'retenidos' ? ' active' : ''}`} onClick={() => setPestana('retenidos')}>
                    Pendientes de criterio contable <span className={`fac-tab-n${retenidos.length ? ' fac-tab-n-alerta' : ''}`}>{cargandoRetenidos ? '…' : retenidos.length}</span>
                  </button>
                </div>
              </div>

              {pestana === 'retenidos' ? (
                <Retenidos filas={retenidos} cargando={cargandoRetenidos} error={errorRetenidos}
                  onLiberar={onLiberar} liberando={liberando} onExportar={onExportarRetenidos} />
              ) : visibles.length === 0 ? (
                <div className="card">
                  <div className="empty-state">
                    <div className="empty-state-icon"><Receipt size={22} /></div>
                    <div className="empty-state-title">{facturas.length ? 'Nada en esta pestaña' : 'Sin facturas en este mes'}</div>
                    <div className="empty-state-desc">{facturas.length ? 'Probá con otra pestaña o con otro mes.' : 'Cuando se emitan facturas en este mes, aparecen acá.'}</div>
                  </div>
                </div>
              ) : (
                <>
                  {/* Escritorio: tabla */}
                  <div className="table-wrapper desktop-only">
                    <table className="fac-tabla">
                      <thead>
                        <tr>
                          <th>Fecha</th><th>Número</th><th>Tipo</th><th>Pedido</th><th>Cliente</th><th>RUC</th>
                          <th className="num">Total</th><th className="num">IVA</th><th>Estado</th><th>Acciones</th>
                        </tr>
                      </thead>
                      <tbody>
                        {visibles.map(f => {
                          const e = infoEstado(f.estado)
                          return (
                            <tr key={f.id}>
                              <td className="muted">{fechaHoraCorta(fechaFactura(f))}</td>
                              <td className="mono">{numeroCompleto(f)}</td>
                              <td><span className="badge badge-gray" title={nombreTipo(f.tipo_documento)}>{siglaTipo(f.tipo_documento)}</span></td>
                              <td>{etiquetaPedido(nombresPedido[f.shopify_order_id], f.shopify_order_id)}</td>
                              <td className="fac-cliente">{etiquetaCliente(f)}</td>
                              <td className="mono">{etiquetaRuc(f)}</td>
                              <td className="num">{formatGs(f.total)}</td>
                              <td className="num muted">{formatGs(ivaTotal(f))}</td>
                              <td><span className={`badge ${e.badge}`}>{e.label}</span><Motivo f={f} /></td>
                              <td><Acciones f={f} {...props} ocupado={reenviando === f.id} /></td>
                            </tr>
                          )
                        })}
                      </tbody>
                    </table>
                  </div>

                  {/* Móvil: tarjetas */}
                  <div className="mobile-only">
                    <div className="fac-cards">
                      {visibles.map(f => {
                        const e = infoEstado(f.estado)
                        return (
                          <div key={f.id} className="product-card-mobile">
                            <div className="product-card-mobile-row">
                              <span className="fac-num-movil">{siglaTipo(f.tipo_documento)} {numeroCompleto(f)}</span>
                              <span className={`badge ${e.badge}`}>{e.label}</span>
                            </div>
                            <div className="product-card-mobile-row">
                              <span className="fac-cliente">{etiquetaCliente(f)}</span>
                              <b>{formatGs(f.total)}</b>
                            </div>
                            <div className="product-card-mobile-row fac-meta">
                              <span>{etiquetaPedido(nombresPedido[f.shopify_order_id], f.shopify_order_id)} · {fechaHoraCorta(fechaFactura(f))}</span>
                              <span>IVA {formatGs(ivaTotal(f))}</span>
                            </div>
                            {f.ruc && <div className="fac-meta">RUC {f.ruc}</div>}
                            <Motivo f={f} />
                            <Acciones f={f} {...props} ocupado={reenviando === f.id} />
                          </div>
                        )
                      })}
                    </div>
                  </div>
                </>
              )}
            </>
          )}
        </>
      )}
    </div>
  )
}
