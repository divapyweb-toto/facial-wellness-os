// src/pages/productos/Rentabilidad.jsx
// Pestaña Rentabilidad (§10.4): entradas editables, 3 escenarios, sensibilidad
// y caja. Todo el cálculo lo hace src/lib/productos/motor.js (vía calculo.js);
// se guarda en pi_escenarios_costo con entradas + resultado + versión.
import { useState, useMemo, useEffect } from 'react'
import { Plus, Trash2, Save, Database, AlertTriangle, Calculator } from 'lucide-react'
import { guardarEscenario, leerBaseOperativa, esModoDemo } from './api'
import { calcularTodo, formularioVacio, lineaDesdeRuta, tasasDesdeBaseOperativa, PLANTILLAS_RUTA } from './calculo'
import { fmtGs, fmtPct, fmtFechaHora, fmtFecha, MONEDAS } from './formato'
import { Campo, Vacio, ErrorCaja, Demo } from './ui'

export const SEMAFOROS = [
  { v: 'VERDE', label: 'Verde', badge: 'badge-green' },
  { v: 'AMARILLO', label: 'Amarillo', badge: 'badge-yellow' },
  { v: 'ROJO', label: 'Rojo', badge: 'badge-red' },
  { v: 'DESCONOCIDO', label: 'Desconocido', badge: 'badge-gray' },
]

export default function Rentabilidad({ d, recargar, toast }) {
  const ultimo = d.escenarios[0] // ordenados por calculado_en desc
  const [f, setF] = useState(() => ({ ...formularioVacio(), ...(ultimo?.entradas?.formulario || {}) }))
  const [guardando, setGuardando] = useState(false)
  const [base, setBase] = useState(null) // filas de pi_base_operativa
  const [errBase, setErrBase] = useState(null)
  const [ruta, setRuta] = useState({ id: 'avion_easybox', pesoKg: '', tcUSD: '' })

  const set = (k) => (e) => { const v = e?.target ? (e.target.type === 'checkbox' ? e.target.checked : e.target.value) : e; setF(p => ({ ...p, [k]: v })) }
  const setSub = (grupo, k) => (e) => { const v = e.target.value; setF(p => ({ ...p, [grupo]: { ...p[grupo], [k]: v } })) }
  const setLinea = (i, k, v) => setF(p => ({ ...p, lineas: p.lineas.map((l, j) => j === i ? { ...l, [k]: v } : l) }))

  const calc = useMemo(() => calcularTodo(f), [f])
  const r = calc.resultado
  const errores = Object.entries(calc.errores)

  const guardar = async () => {
    if (!r) { toast('No se puede guardar: el cálculo tiene errores. Completá los datos marcados.', 'error'); return }
    setGuardando(true)
    try {
      const entradas = { formulario: f, motor: calc.base, semaforoCaja: f.semaforoCaja }
      await guardarEscenario(d.candidato.id, f.nombre || 'base', entradas, r, d.escenarios)
      toast('Escenario guardado', 'success'); recargar()
    } catch (e) { toast(e.message, 'error') } finally { setGuardando(false) }
  }

  const traerReales = async () => {
    setErrBase(null)
    try { setBase(await leerBaseOperativa()) } catch (e) { setErrBase(e) }
  }
  const aplicarReal = (fila) => {
    const t = tasasDesdeBaseOperativa(fila)
    setF(p => ({
      ...p, confirmacion: t.confirmacion, canceladoTrasConfirmar: t.canceladoTrasConfirmar, entrega: t.entrega, devolucion: t.devolucion, flete: t.flete || p.flete,
      fuentes: `${p.fuentes ? p.fuentes + ' · ' : ''}pi_base_operativa ${fila.familia}/${fila.canal} (${fila.pedidos} pedidos, ${fila.ventana_desde} a ${fila.ventana_hasta}), leído ${new Date().toLocaleDateString('es-PY')}`,
    }))
    toast(`Tasas de ${fila.familia} · ${fila.canal} cargadas. Son de la operación actual, no del producto nuevo.`, 'info')
  }
  const agregarRuta = () => {
    try {
      const l = lineaDesdeRuta(ruta.id, ruta)
      setF(p => ({ ...p, lineas: [...p.lineas, l] }))
    } catch (e) { toast(e.message.replace('[motor] ', ''), 'error') }
  }

  // Si cambia de candidato (otra carga), reponer el formulario.
  useEffect(() => { setF({ ...formularioVacio(), ...(ultimo?.entradas?.formulario || {}) }) }, [d.candidato.id]) // eslint-disable-line react-hooks/exhaustive-deps

  return (
    <div className="pi-col">
      <div className="alert alert-info">
        <Calculator size={15} style={{ flexShrink: 0, marginTop: 1 }} />
        <span>Fórmula COD de Voltra: el anuncio y el flete se pagan en todo pedido despachado, se entregue o no (no se multiplican por la tasa de entrega). Precio con IVA 10% incluido. Esto es <b>contribución</b>, no utilidad neta (no descuenta fijos ni IRE).</span>
      </div>

      {/* ── Datos reales de Voltra ── */}
      <div className="card card-sm">
        <div className="pi-barra">
          <div className="section-label"><Database size={12} /> Datos reales de Voltra (solo lectura)</div>
          <button className="btn btn-secondary btn-sm" onClick={traerReales}><Database size={12} /> Traer datos reales de Voltra</button>
        </div>
        <ErrorCaja error={errBase} />
        {base && (base.length === 0 ? <p className="pi-desc">La vista no devolvió filas.</p> : (
          <>
            <div className="table-wrapper" style={{ marginTop: 8 }}>
              <table className="tabla-responsive">
                <thead><tr><th>Familia</th><th>Canal</th><th>Pedidos</th><th>Ticket</th><th title="sobre pedidos válidos">% cancelado antes de despachar</th><th title="sobre resueltos (entregado + devuelto)">% entregado</th><th>Flete prom.</th><th>Costo unit.</th><th>Ventana</th><th></th></tr></thead>
                <tbody>
                  {base.map((b, i) => (
                    <tr key={i} className={d.candidato.familia_producto && b.familia === d.candidato.familia_producto ? 'pi-resaltado' : ''}>
                      <td data-label="Familia">{b.familia} {esModoDemo() && <Demo />}</td>
                      <td data-label="Canal">{b.canal}</td>
                      <td data-label="Pedidos" className="pi-num">{b.pedidos}</td>
                      <td data-label="Ticket" className="pi-num">{fmtGs(b.ticket_prom)}</td>
                      <td data-label="% cancelado" className="pi-num">{b.pct_cancelado_antes_despacho ?? '—'} %</td>
                      <td data-label="% entregado" className="pi-num">{b.pct_entregado ?? '—'} %</td>
                      <td data-label="Flete" className="pi-num">{fmtGs(b.flete_prom)}</td>
                      <td data-label="Costo unit." className="pi-num">{fmtGs(b.costo_producto_unit)}</td>
                      <td data-label="Ventana">{fmtFecha(b.ventana_desde)} → {fmtFecha(b.ventana_hasta)}</td>
                      <td><button className="btn btn-ghost btn-sm" onClick={() => aplicarReal(b)}>Usar tasas</button></td>
                    </tr>
                  ))}
                </tbody>
              </table>
            </div>
            <p className="pi-sub" style={{ marginTop: 6 }}>"% cancelado" es sobre pedidos válidos; "% entregado" es sobre los resueltos (entregado + devuelto por el courier). Lo devuelto por el courier entra como entrega fallida; la devolución después de entregar no se mide acá (queda 0). Son tasas de productos actuales: para uno nuevo son referencia, no dato propio.</p>
          </>
        ))}
      </div>

      {/* ── Costo puesto ── */}
      <div className="card">
        <div className="pi-barra">
          <div className="section-label">1 · Costo puesto en Paraguay</div>
          <label className="pi-check"><input type="checkbox" checked={f.usarLote} onChange={set('usarLote')} /> Calcular desde un lote (si no, costo unitario directo)</label>
        </div>
        {f.usarLote ? (
          <>
            <div className="table-wrapper" style={{ marginTop: 8 }}>
              <table className="pi-tabla-edit">
                <thead><tr><th>Concepto</th><th>Monto</th><th>Moneda</th><th title="1 <moneda> = X PYG">TC a PYG</th><th title="IVA de compra recuperable: es desembolso, no costo">IVA recup.</th><th title="Sale caja ahora">Desemb.</th><th title="A4: sin factura a nombre de Voltra el IVA no se recupera">Factura Voltra</th><th>Incluido en</th><th title="Si el monto es desconocido">Rango mín–máx</th><th>Fuente</th><th></th></tr></thead>
                <tbody>
                  {f.lineas.map((l, i) => (
                    <tr key={i}>
                      <td><input className="form-input pi-in" value={l.concepto} onChange={e => setLinea(i, 'concepto', e.target.value)} /></td>
                      <td><input className="form-input pi-in pi-in-num" value={l.monto} onChange={e => setLinea(i, 'monto', e.target.value)} placeholder="desconocido" /></td>
                      <td><select className="form-select pi-in" value={l.moneda} onChange={e => setLinea(i, 'moneda', e.target.value)}>{MONEDAS.map(m => <option key={m}>{m}</option>)}</select></td>
                      <td><input className="form-input pi-in pi-in-num" value={l.moneda === 'PYG' ? '1' : l.tc} disabled={l.moneda === 'PYG'} onChange={e => setLinea(i, 'tc', e.target.value)} placeholder="ej. 7300" /></td>
                      <td style={{ textAlign: 'center' }}><input type="checkbox" checked={!!l.recuperable} onChange={e => setLinea(i, 'recuperable', e.target.checked)} /></td>
                      <td style={{ textAlign: 'center' }}><input type="checkbox" checked={l.desembolso !== false} onChange={e => setLinea(i, 'desembolso', e.target.checked)} /></td>
                      <td>
                        <select className="form-select pi-in" value={l.factura_a_nombre_voltra === true ? 'si' : l.factura_a_nombre_voltra === false ? 'no' : '?'} onChange={e => setLinea(i, 'factura_a_nombre_voltra', e.target.value === 'si' ? true : e.target.value === 'no' ? false : null)}>
                          <option value="si">sí</option><option value="no">no</option><option value="?">sin confirmar</option>
                        </select>
                      </td>
                      <td><input className="form-input pi-in" value={l.incluido_en} onChange={e => setLinea(i, 'incluido_en', e.target.value)} placeholder="—" /></td>
                      <td><div style={{ display: 'flex', gap: 4 }}><input className="form-input pi-in pi-in-num" value={l.rangoMin} onChange={e => setLinea(i, 'rangoMin', e.target.value)} /><input className="form-input pi-in pi-in-num" value={l.rangoMax} onChange={e => setLinea(i, 'rangoMax', e.target.value)} /></div></td>
                      <td><input className="form-input pi-in" value={l.fuente} onChange={e => setLinea(i, 'fuente', e.target.value)} placeholder="cotización, factura…" /></td>
                      <td><button className="btn btn-ghost btn-sm btn-icon" onClick={() => setF(p => ({ ...p, lineas: p.lineas.filter((_, j) => j !== i) }))}><Trash2 size={12} /></button></td>
                    </tr>
                  ))}
                </tbody>
              </table>
            </div>
            <div className="pi-barra" style={{ marginTop: 8 }}>
              <button className="btn btn-ghost btn-sm" onClick={() => setF(p => ({ ...p, lineas: [...p.lineas, { ...formularioVacio().lineas[0], concepto: '', moneda: 'PYG' }] }))}><Plus size={12} /> Línea</button>
              <div className="pi-ruta">
                <select className="form-select pi-in" value={ruta.id} onChange={e => setRuta(r2 => ({ ...r2, id: e.target.value }))}>
                  {Object.values(PLANTILLAS_RUTA).map(p => <option key={p.id} value={p.id}>{p.nombre} · {p.estado}</option>)}
                </select>
                <input className="form-input pi-in pi-in-num" placeholder="kg cobrables" value={ruta.pesoKg} onChange={e => setRuta(r2 => ({ ...r2, pesoKg: e.target.value }))} />
                <input className="form-input pi-in pi-in-num" placeholder="TC USD" value={ruta.tcUSD} onChange={e => setRuta(r2 => ({ ...r2, tcUSD: e.target.value }))} />
                <button className="btn btn-secondary btn-sm" onClick={agregarRuta}>+ flete de plantilla</button>
              </div>
            </div>
            <p className="pi-sub">Cada monto es el <b>total del lote</b> en su moneda (no por unidad); el motor lo divide por las unidades vendibles.</p>
            <p className="pi-sub">Plantillas de ruta = valores de referencia "verificar" (fuente y fecha en la línea). El peso cobrable y el divisor salen de la cotización del transportista: no hay divisor universal.</p>
            <div className="form-grid form-grid-3" style={{ marginTop: 10 }}>
              <Campo label="Unidades compradas"><input className="form-input" value={f.unidadesCompradas} onChange={set('unidadesCompradas')} inputMode="numeric" /></Campo>
              <Campo label="Unidades vendibles" hint="Compradas menos merma/defectos: es el denominador del costo."><input className="form-input" value={f.unidadesVendibles} onChange={set('unidadesVendibles')} inputMode="numeric" /></Campo>
              <Campo label="Si hay partidas desconocidas, usar" hint="El rango se muestra igual; esto elige con qué extremo se calcula.">
                <select className="form-select" value={f.usarRango} onChange={set('usarRango')}><option value="max">el máximo (prudente)</option><option value="min">el mínimo</option></select>
              </Campo>
            </div>
          </>
        ) : (
          <div className="form-grid form-grid-3" style={{ marginTop: 10 }}>
            <Campo label="Costo unitario puesto (₲)" hint="Solo si no se carga el lote."><input className="form-input" value={f.costoUnitDirecto} onChange={set('costoUnitDirecto')} inputMode="numeric" /></Campo>
          </div>
        )}
      </div>

      {/* ── Contribución ── */}
      <div className="card">
        <div className="section-label">2 · Contribución por pedido</div>
        <div className="form-grid form-grid-3" style={{ marginTop: 10 }}>
          <Campo label="Nombre del escenario"><input className="form-input" value={f.nombre} onChange={set('nombre')} /></Campo>
          <Campo label="Precio por pedido (₲, IVA incluido)"><input className="form-input" value={f.precio} onChange={set('precio')} inputMode="numeric" /></Campo>
          <Campo label="IVA incluido (%)"><input className="form-input" value={f.ivaPct} onChange={set('ivaPct')} inputMode="decimal" /></Campo>
          <Campo label="Unidades por pedido" hint="Promedio (ej. 1,5)"><input className="form-input" value={f.unidadesPorPedido} onChange={set('unidadesPorPedido')} inputMode="decimal" /></Campo>
          <Campo label="Flete por pedido despachado (₲)"><input className="form-input" value={f.flete} onChange={set('flete')} inputMode="numeric" /></Campo>
          <Campo label="Costo del bot por pedido iniciado (₲)"><input className="form-input" value={f.costoBot} onChange={set('costoBot')} inputMode="numeric" /></Campo>
          <Campo label="Salen a despacho (%)" hint="pedidos que salen ÷ pedidos iniciados"><input className="form-input" value={f.confirmacion} onChange={set('confirmacion')} inputMode="decimal" /></Campo>
          <Campo label="Cancelan después de confirmar (%)" hint="de los confirmados de Voltra; sin dato, el costo por confirmado se toma como por despachado"><input className="form-input" value={f.canceladoTrasConfirmar ?? ''} onChange={set('canceladoTrasConfirmar')} inputMode="decimal" /></Campo>
          <Campo label="Entrega (%)" hint="entregados ÷ despachados"><input className="form-input" value={f.entrega} onChange={set('entrega')} inputMode="decimal" /></Campo>
          <Campo label="Devolución después de entregar (%)" hint="0 si no hay dato"><input className="form-input" value={f.devolucion} onChange={set('devolucion')} inputMode="decimal" /></Campo>
          <Campo label="Pérdida por devuelto (₲)"><input className="form-input" value={f.perdidaDevuelto} onChange={set('perdidaDevuelto')} inputMode="numeric" /></Campo>
          <Campo label="Costo de anuncios (₲)">
            <div style={{ display: 'flex', gap: 6 }}>
              <input className="form-input" value={f.ads} onChange={set('ads')} inputMode="numeric" placeholder="vacío = sin ads" />
              <select className="form-select" style={{ width: 150 }} value={f.adsDenominador} onChange={set('adsDenominador')}>
                <option value="confirmado">por confirmado</option><option value="iniciado">por pedido iniciado</option>
              </select>
            </div>
          </Campo>
          <Campo label="Contribución objetivo (₲ por pedido iniciado)"><input className="form-input" value={f.contribucionObjetivo} onChange={set('contribucionObjetivo')} inputMode="numeric" /></Campo>
          <Campo label=" "><label className="pi-check"><input type="checkbox" checked={f.recuperaFallida} onChange={set('recuperaFallida')} /> El producto de una entrega fallida vuelve vendible</label></Campo>
          <Campo label="Fuentes de estas entradas" span={2}><input className="form-input" value={f.fuentes} onChange={set('fuentes')} placeholder="de dónde sale cada dato y su fecha" /></Campo>
        </div>
      </div>

      {/* ── Escenarios ── */}
      <div className="card">
        <div className="section-label">3 · Escenarios adverso y favorable</div>
        <p className="pi-sub">Vacío = igual que la base. Son hipótesis configurables, no probabilidades; ningún escenario se llama "realista".</p>
        <div className="pi-escenarios-form">
          {['adverso', 'favorable'].map(n => (
            <div key={n} className="pi-esc-col">
              <div className="data-label" style={{ textTransform: 'capitalize' }}>{n}</div>
              <div className="form-grid">
                <Campo label="Precio (₲)"><input className="form-input" value={f[n].precio} onChange={setSub(n, 'precio')} /></Campo>
                <Campo label={`Ads (₲ por ${f.adsDenominador === 'iniciado' ? 'pedido iniciado' : 'confirmado'})`}><input className="form-input" value={f[n].ads} onChange={setSub(n, 'ads')} /></Campo>
                <Campo label="Confirmación (%)"><input className="form-input" value={f[n].confirmacion} onChange={setSub(n, 'confirmacion')} /></Campo>
                <Campo label="Entrega (%)"><input className="form-input" value={f[n].entrega} onChange={setSub(n, 'entrega')} /></Campo>
                <Campo label="Flete (₲)"><input className="form-input" value={f[n].flete} onChange={setSub(n, 'flete')} /></Campo>
                <Campo label="TC USD" hint="solo con lote"><input className="form-input" value={f[n].tcUSD} onChange={setSub(n, 'tcUSD')} /></Campo>
                <Campo label="Fuente / por qué" span={2}><input className="form-input" value={f[n].fuentes} onChange={setSub(n, 'fuentes')} /></Campo>
              </div>
            </div>
          ))}
        </div>
        <div className="section-label" style={{ marginTop: 14 }}>Sensibilidad: qué variables mover</div>
        <div className="pi-chips">
          {[['precio', 'Precio'], ['ads', 'Anuncios'], ['tasas.confirmacion', 'Confirmación'], ['tasas.entrega', 'Entrega'], ['flete', 'Flete'], ['costoUnit', f.usarLote ? 'Unidades vendibles (merma)' : 'Costo unitario'], ['tc:USD', 'Tipo de cambio USD'], ['tc:CNY', 'Tipo de cambio CNY']].map(([v, l]) => (
            <button key={v} type="button" className={`chip-choice ${f.sensVars.includes(v) ? 'active' : ''}`} onClick={() => setF(p => ({ ...p, sensVars: p.sensVars.includes(v) ? p.sensVars.filter(x => x !== v) : [...p.sensVars, v] }))}>{l}</button>
          ))}
        </div>
        <Campo label="Pasos (%)" hint="Ej.: -20, -10, 10, 20"><input className="form-input" style={{ maxWidth: 260 }} value={f.sensPasos} onChange={set('sensPasos')} /></Campo>
      </div>

      {/* ── Caja ── */}
      <div className="card">
        <div className="pi-barra">
          <div className="section-label">4 · Caja (necesidad, pico y recuperación)</div>
          <Campo label="Semáforo de caja hoy (REGLAS-CAJA)">
            <select className="form-select" value={f.semaforoCaja} onChange={set('semaforoCaja')}>{SEMAFOROS.map(s => <option key={s.v} value={s.v}>{s.label}</option>)}</select>
          </Campo>
        </div>
        {(f.semaforoCaja === 'AMARILLO' || f.semaforoCaja === 'ROJO') && <div className="alert alert-error" style={{ marginTop: 8 }}><AlertTriangle size={15} /> Caja en {f.semaforoCaja.toLowerCase()}: es un bloqueo duro para comprar stock o muestras.</div>}
        {f.semaforoCaja === 'DESCONOCIDO' && <p className="pi-sub" style={{ marginTop: 6 }}>Semáforo desconocido: aviso, no bloqueo. Verificalo en socio/caja antes de comprometer plata.</p>}
        {r?.resumen?.desembolsoLote != null && (
          <button className="btn btn-ghost btn-sm" style={{ marginTop: 8 }} onClick={() => setF(p => ({ ...p, caja: { ...p.caja, primerLote: String(r.resumen.desembolsoLote) } }))}>
            Usar el desembolso del lote como primer lote ({fmtGs(r.resumen.desembolsoLote)})
          </button>
        )}
        <div className="form-grid form-grid-3" style={{ marginTop: 10 }}>
          {[['muestras', 'Muestras'], ['primerLote', 'Primer lote'], ['tributos', 'Tributos / despacho'], ['logistica', 'Logística (extra)'], ['publicidad', 'Publicidad (extra)'], ['devoluciones', 'Devoluciones'], ['reposicion', 'Reposición']].map(([k, l]) => (
            <Campo key={k} label={`${l} (₲) · día`}>
              <div style={{ display: 'flex', gap: 6 }}>
                <input className="form-input" value={f.caja[k]} onChange={setSub('caja', k)} inputMode="numeric" />
                <input className="form-input" style={{ width: 70 }} value={f.caja[`${k}Dia`]} onChange={setSub('caja', `${k}Dia`)} inputMode="numeric" title="día desde hoy" />
              </div>
            </Campo>
          ))}
          <Campo label="Piloto: arranca el día"><input className="form-input" value={f.caja.pilotoDesde} onChange={setSub('caja', 'pilotoDesde')} inputMode="numeric" /></Campo>
          <Campo label="Piloto: días"><input className="form-input" value={f.caja.pilotoDias} onChange={setSub('caja', 'pilotoDias')} inputMode="numeric" /></Campo>
          <Campo label="Piloto: pedidos iniciados por día"><input className="form-input" value={f.caja.pilotoPedidosDia} onChange={setSub('caja', 'pilotoPedidosDia')} inputMode="decimal" /></Campo>
          <Campo label="Días hasta cobrar (rendición)"><input className="form-input" value={f.caja.diasHastaCobro} onChange={setSub('caja', 'diasHastaCobro')} inputMode="numeric" /></Campo>
          <Campo label="Días hasta pagar flete"><input className="form-input" value={f.caja.diasHastaFlete} onChange={setSub('caja', 'diasHastaFlete')} inputMode="numeric" /></Campo>
        </div>
      </div>

      {/* ── Resultados ── */}
      {errores.length > 0 && (
        <div className="alert alert-warning">
          <AlertTriangle size={15} style={{ flexShrink: 0, marginTop: 1 }} />
          <div>{errores.map(([k, m]) => <div key={k}><b>{k}:</b> {m}</div>)}</div>
        </div>
      )}
      {r ? <Resultados r={r} adsDen={f.adsDenominador} /> : <Vacio icono={Calculator} titulo="Faltan datos para calcular" desc="Completá precio, flete, tasas y el costo (lote o unitario). Lo que falta se marca arriba." />}

      <div className="pi-barra">
        <span className="pi-sub">{ultimo ? `Último guardado: ${ultimo.nombre} v${ultimo.version} · ${fmtFechaHora(ultimo.calculado_en)}` : 'Sin escenarios guardados'}</span>
        <button className="btn btn-primary btn-sm" onClick={guardar} disabled={guardando || !r}><Save size={13} /> {guardando ? 'Guardando…' : 'Guardar escenario'}</button>
      </div>
      {d.escenarios.length > 0 && (
        <div className="table-wrapper">
          <table className="tabla-responsive">
            <thead><tr><th>Escenario</th><th>Versión</th><th>Calculado</th><th>Contrib. después de ads · por confirmado</th><th>· por pedido iniciado</th><th>Caja necesaria</th><th></th></tr></thead>
            <tbody>
              {d.escenarios.map(e => {
                const s = e.resultado?.resumen || {}
                return (
                  <tr key={e.id}>
                    <td data-label="Escenario">{e.nombre}</td><td data-label="Versión">v{e.version}</td><td data-label="Calculado">{fmtFechaHora(e.calculado_en)}</td>
                    <td data-label="Por confirmado" className="pi-num">{fmtGs(s.contribDespuesAdsConfirmado)}</td>
                    <td data-label="Por iniciado" className="pi-num">{fmtGs(s.contribDespuesAdsIniciado)}</td>
                    <td data-label="Caja" className="pi-num">{fmtGs(s.cajaNecesaria)}</td>
                    <td>{e.entradas?.formulario && <button className="btn btn-ghost btn-sm" onClick={() => setF({ ...formularioVacio(), ...e.entradas.formulario })}>Cargar</button>}</td>
                  </tr>
                )
              })}
            </tbody>
          </table>
        </div>
      )}
    </div>
  )
}

function Resultados({ r }) {
  const esc = r.escenarios
  const fila = (nombre, x) => {
    const c = x.resultado.contribucion
    return (
      <tr key={nombre}>
        <td data-label="Escenario" style={{ textTransform: 'capitalize' }}>{nombre}</td>
        <td data-label="Costo unit." className="pi-num">{fmtGs(x.resumen.costoUnit)}</td>
        <td data-label="Antes de ads · por iniciado" className="pi-num">{fmtGs(c.porIniciado.contribucionAntesAds)}</td>
        <td data-label="Después de ads · por iniciado" className={`pi-num ${c.porIniciado.contribucionDespuesAds < 0 ? 'pi-rojo' : ''}`}>{fmtGs(c.porIniciado.contribucionDespuesAds)}</td>
        <td data-label="Después de ads · por confirmado" className={`pi-num ${c.porConfirmado.contribucionDespuesAds < 0 ? 'pi-rojo' : ''}`}>{fmtGs(c.porConfirmado.contribucionDespuesAds)}</td>
        <td data-label="Ads máx · por confirmado" className="pi-num">{fmtGs(c.porConfirmado.costoAdsMaximo)}</td>
        <td data-label="Ads máx · por entregado" className="pi-num">{fmtGs(c.porEntregado.costoAdsMaximo)}</td>
      </tr>
    )
  }
  const cb = esc.base.resultado.contribucion
  const cp = esc.base.resultado.costoPuesto
  const avisos = [...(cp?.avisos || []), ...(cb.avisos || [])]
  const cj = r.caja
  return (
    <div className="pi-col">
      <div className="card">
        <div className="section-label">Resultado · 3 escenarios</div>
        <div className="table-wrapper" style={{ marginTop: 8 }}>
          <table className="tabla-responsive">
            <thead><tr><th>Escenario</th><th>Costo unit. vendible</th><th>Contrib. antes de ads<br />por pedido iniciado</th><th>Contrib. después de ads<br />por pedido iniciado</th><th>Contrib. después de ads<br />por confirmado</th><th>Ads máximo<br />por confirmado</th><th>Ads máximo<br />por entregado</th></tr></thead>
            <tbody>{fila('base', esc.base)}{fila('adverso', esc.adverso)}{fila('favorable', esc.favorable)}</tbody>
          </table>
        </div>
        <p className="pi-sub" style={{ marginTop: 6 }}>Denominadores: "por pedido iniciado" = todo pedido creado (cancelados incluidos); "por confirmado" = {cb.porConfirmado.denominador}; conversión {cb.porConfirmado.conversion}. {cb.nota}</p>
        {cp?.rango && <p className="pi-sub">Costo puesto con partidas desconocidas: entre {fmtGs(cp.rango.porUnidadVendible.min)} y {fmtGs(cp.rango.porUnidadVendible.max)} por unidad vendible ({cp.desconocidos.map(x => x.concepto).join(', ')}).</p>}
        {cp && <p className="pi-sub">Desembolso del lote: {fmtGs(cp.desembolsoPYG)} · IVA recuperable (desembolso, no costo): {fmtGs(cp.ivaRecuperablePYG)} · merma {fmtPct(cp.merma.pct)}.</p>}
        {avisos.length > 0 && <ul className="pi-avisos">{avisos.map((a, i) => <li key={i}>{a}</li>)}</ul>}
        <details style={{ marginTop: 8 }}>
          <summary className="pi-sub" style={{ cursor: 'pointer' }}>Ramas del pedido iniciado (base)</summary>
          <div className="table-wrapper" style={{ marginTop: 6 }}>
            <table>
              <thead><tr><th>Rama</th><th>Probabilidad</th><th>Ingreso neto</th><th>Producto</th><th>Flete</th><th>Bot</th><th>Pérdida</th><th>Aporte</th></tr></thead>
              <tbody>{cb.detalleRamas.map(x => (
                <tr key={x.rama}><td>{x.rama}</td><td className="pi-num">{fmtPct(x.probabilidad)}</td><td className="pi-num">{fmtGs(x.ingresoNeto)}</td><td className="pi-num">{fmtGs(x.costos.producto)}</td><td className="pi-num">{fmtGs(x.costos.flete)}</td><td className="pi-num">{fmtGs(x.costos.bot)}</td><td className="pi-num">{fmtGs(x.costos.perdida)}</td><td className="pi-num">{fmtGs(x.aporte)}</td></tr>
              ))}</tbody>
            </table>
          </div>
        </details>
      </div>

      {r.sensibilidad && (
        <div className="card">
          <div className="section-label">Sensibilidad · contribución después de ads por confirmado</div>
          <div className="table-wrapper" style={{ marginTop: 8 }}>
            <table>
              <thead><tr><th>Variable (más impacto primero)</th>{[...new Set(r.sensibilidad.filas.map(x => x.paso))].map(p => <th key={p}>{p > 0 ? '+' : ''}{Math.round(p * 100)} %</th>)}</tr></thead>
              <tbody>
                {r.sensibilidad.impacto.map(({ variable }) => (
                  <tr key={variable}>
                    <td>{variable}</td>
                    {r.sensibilidad.filas.filter(x => x.variable === variable).map((x, i) => (
                      <td key={i} className={`pi-num ${(x.porConfirmadoDespuesAds ?? 0) < 0 ? 'pi-rojo' : ''}`}>{fmtGs(x.porConfirmadoDespuesAds ?? x.porIniciadoAntesAds)}{x.recortado ? ' *' : ''}</td>
                    ))}
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
          <p className="pi-sub" style={{ marginTop: 6 }}>Referencia (base): {fmtGs(r.sensibilidad.referencia.porConfirmado.despuesAds)} por confirmado. * = tasa recortada a 0–100 %.</p>
        </div>
      )}

      {cj && (
        <div className="card">
          <div className="section-label">Caja</div>
          <div className="kpi-grid" style={{ marginTop: 8 }}>
            <div className="kpi-card"><div className="kpi-label">Necesidad de caja</div><div className="kpi-value">{fmtGs(cj.necesidadCaja)}</div><div className="kpi-sub">pico negativo del horizonte cargado</div></div>
            <div className="kpi-card"><div className="kpi-label">Día del pico</div><div className="kpi-value">{cj.diaPico ?? '—'}</div></div>
            <div className="kpi-card"><div className="kpi-label">Días para recuperar</div><div className={`kpi-value ${cj.recupera ? 'green' : 'red'}`}>{cj.diasRecuperacion ?? (cj.recupera ? '0' : 'no recupera')}</div><div className="kpi-sub">sin anualizar</div></div>
            <div className="kpi-card"><div className="kpi-label">Neto del horizonte</div><div className={`kpi-value ${cj.totales.neto < 0 ? 'red' : ''}`}>{fmtGs(cj.totales.neto)}</div></div>
          </div>
          <p className="pi-sub" style={{ marginTop: 6 }}>{cj.nota}</p>
        </div>
      )}
    </div>
  )
}
