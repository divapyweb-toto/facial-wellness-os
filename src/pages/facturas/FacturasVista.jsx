// src/pages/facturas/FacturasVista.jsx
// Parte visual del panel de facturas: recibe todo por props (sin Supabase),
// así se puede revisar con datos inventados sin tocar la base.
import { useMemo, useState } from 'react'
import {
  FileText, FileSpreadsheet, Download, Copy, MessageCircle, Eye, AlertTriangle,
  Clock, XCircle, Ban, Receipt, CalendarDays, Loader2, FlaskConical,
} from 'lucide-react'
import { formatGs } from '../../lib/supabase'
import { etiquetaMes, mesesRecientes } from '../../lib/fechas'
import {
  PESTANAS, filtrarPorPestana, contarPorPestana, resumenMes, esModoPrueba, infoEstado,
  siglaTipo, nombreTipo, numeroCompleto, etiquetaPedido, etiquetaCliente, etiquetaRuc,
  ivaTotal, fechaHoraCorta, fechaFactura,
} from './logica'
import './facturas.css'

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
                </div>
              </div>

              {visibles.length === 0 ? (
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
