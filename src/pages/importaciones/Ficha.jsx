// src/pages/importaciones/Ficha.jsx
// Ficha de propuesta de importación (una página, tipo memo de inversión),
// en el orden a–h de la decisión de Enrique 18-11 (3), + previsto vs real,
// botones de decisión (quedan en pi_decisiones con el texto de Enrique) y PDF.
import { useState, useEffect, useCallback, useMemo, useRef } from 'react'
import { ArrowLeft, Star, Trash2, Upload, Link2, FileDown, Ship, Plane, Store, ShieldAlert, CheckCircle2, AlertTriangle, ImageOff } from 'lucide-react'
import { useToast } from '../../lib/toast'
import { actualizarCandidato, crearOrden, crearTrabajo, leerResultadoExperimentos, esModoDemo } from '../productos/api'
import { fmtGs, fmtFecha, fmtFechaHora, fmtDinero, fmtPct, aMinor, claveVendedor, tipoEvidenciaInfo, TIPOS_EVIDENCIA, vencida, urlSegura } from '../productos/formato'
import { Campo, Demo, BadgeEstado, BadgeTipo, ErrorCaja, Modal } from '../productos/ui'
import { cargarFicha, subirFoto, agregarFotoExterna, marcarPrincipal, borrarFoto, cambiarEtapa, registrarDecision } from './api'
import { ETAPAS, etapaDe, reglaFotos, semaforo, alertasDe, plataTotal, compararProveedores, costoConRuta, escalera, cantidadRecomendada, TOPE_ADS_VOLTRA, MAX_MESES_NO_PROBADO, alertaFoto } from './logica'
import { exportarPDF } from './pdf'
import FotoImg from './FotoImg'

const FUENTES_FOTO = [['proveedor', 'Proveedor'], ['muestra', 'Muestra'], ['propia', 'Propia'], ['ia_referencia', 'IA de referencia']]
const COLOR_SEM = { verde: 'badge-green', amarillo: 'badge-yellow', rojo: 'badge-red' }

export default function Ficha({ candidatoId, onVolver }) {
  const { toast } = useToast()
  const [d, setD] = useState(null)
  const [error, setError] = useState(null)
  const cargar = useCallback(async () => {
    setError(null)
    try { setD(await cargarFicha(candidatoId)) } catch (e) { setError(e) }
  }, [candidatoId])
  useEffect(() => { cargar() }, [cargar])

  if (error) return <div className="pi-col"><button className="btn btn-ghost btn-sm pi-volver" onClick={onVolver}><ArrowLeft size={13} /> Tablero</button><ErrorCaja error={error} onReintentar={cargar} /></div>
  if (!d) return <div className="pi-col"><div className="skeleton skeleton-title" /><div className="skeleton" style={{ height: 320, borderRadius: 'var(--radius)' }} /></div>
  if (!d.candidato) return <div className="pi-col"><button className="btn btn-ghost btn-sm pi-volver" onClick={onVolver}><ArrowLeft size={13} /> Tablero</button><p className="pi-desc">No encontramos esta propuesta.</p></div>
  return <FichaCuerpo d={d} recargar={cargar} onVolver={onVolver} toast={toast} />
}

function FichaCuerpo({ d, recargar, onVolver, toast }) {
  const c = d.candidato
  const esc = d.escenarios.find(e => /base/i.test(e.nombre || '')) || d.escenarios[0] || null
  const R = esc?.resultado || {}
  const r = R.resumen || {}
  const caso = d.casos.reduce((m, x) => (!m || (x.version || 0) > (m.version || 0) ? x : m), null)
  const fotos = d.fotos || []
  const regla = reglaFotos(fotos)
  const sem = semaforo({ esc, caso, fotos, cots: d.cotizaciones })
  const alertas = alertasDe({ cots: d.cotizaciones, esc })
  const comparacion = useMemo(() => compararProveedores(d, esc), [d, esc])
  const ordenBorrador = (d.ordenes || []).find(o => o.estado !== 'CANCELADA') || null
  const elegida = comparacion.find(x => ordenBorrador && x.c.id === ordenBorrador.cotizacion_id) || comparacion[0] || null
  const etapa = etapaDe(c)
  const [ritmo, setRitmo] = useState('')
  const cant = cantidadRecomendada({ ritmoUnidadesDia: ritmo, moq: elegida?.c?.moq ?? null, costoUnit: r.costoUnit ?? null, semaforoCaja: esc?.entradas?.semaforoCaja, probado: etapa === 'IMPORTADO' })

  const numeros = {
    ganancia: r.contribDespuesAdsConfirmado ?? null, plata: plataTotal(R), pico: r.cajaNecesaria ?? null, dias: r.diasRecuperacion ?? null,
    recupera: r.recupera ?? null, adsMax: r.adsMaxConfirmado ?? null, costoUnit: r.costoUnit ?? null, precio: esc?.entradas?.motor?.precio ?? null,
  }

  const moverEtapa = async (nueva) => {
    if (nueva === 'DECIDIR' && !regla.ok) { toast(regla.motivo, 'error'); return }
    try { await cambiarEtapa(c.id, nueva); toast(`Etapa: ${ETAPAS.find(e => e.v === nueva)?.label}`, 'success'); recargar() } catch (e) { toast(e.message, 'error') }
  }
  const pdf = async () => {
    try { await exportarPDF({ d, esc, numeros, sem, regla, comparacion, elegida, cant, caso }); toast('PDF generado', 'success') } catch (e) { toast(`No se pudo generar el PDF: ${e.message}`, 'error') }
  }

  return (
    <div className="pi-col imp-ficha">
      <button className="btn btn-ghost btn-sm pi-volver" onClick={onVolver}><ArrowLeft size={13} /> Tablero</button>

      <div className="card card-sm">
        <div className="pi-barra">
          <div style={{ display: 'flex', alignItems: 'center', gap: 8, flexWrap: 'wrap' }}>
            <h2 className="pi-titulo">{c.nombre}</h2>
            {c.demo && <Demo />}
            <span className={`badge ${COLOR_SEM[sem.color]}`} title={sem.motivos.join(' · ')}>Semáforo {sem.color}</span>
            <BadgeEstado estado={c.estado} />
          </div>
          <button className="btn btn-secondary btn-sm" onClick={pdf}><FileDown size={13} /> Exportar PDF</button>
        </div>
        <p className="pi-sub" style={{ marginTop: 6 }}>{sem.motivos.join(' · ')}</p>
        {alertas.length > 0 && <div className="imp-alertas" style={{ marginTop: 6 }}>{alertas.map((a, i) => <span key={i} className={`badge ${a.tipo === 'vencida' ? 'badge-red' : 'badge-yellow'}`}><AlertTriangle size={10} /> {a.texto}</span>)}</div>}
        <div className="imp-etapas">
          {ETAPAS.map(e => {
            const bloqueada = e.v === 'DECIDIR' && !regla.ok
            return (
              <button key={e.v} className={`chip-choice ${etapa === e.v ? 'active' : ''}`} disabled={bloqueada || etapa === e.v} title={bloqueada ? regla.motivo : `Mover a ${e.label}`} onClick={() => moverEtapa(e.v)}>{e.label}</button>
            )
          })}
        </div>
        {!regla.ok && <p className="pi-sub pi-rojo" style={{ marginTop: 4 }}>"Decidir" deshabilitado: {regla.motivo}</p>}
      </div>

      <Galeria d={d} fotos={fotos} regla={regla} recargar={recargar} toast={toast} />
      <Numeros n={numeros} esc={esc} />
      <Trato d={d} comparacion={comparacion} elegida={elegida} />
      <CostoPuesto esc={esc} elegida={elegida} toast={toast} />
      <Precio d={d} esc={esc} />
      <Cantidad ritmo={ritmo} setRitmo={setRitmo} cant={cant} elegida={elegida} esc={esc} />
      <Escenarios esc={esc} caso={caso} />
      <Evidencia d={d} />
      {(etapa === 'EN_PRUEBA' || etapa === 'IMPORTADO') && <PrevistoReal d={d} numeros={numeros} />}
      <Decisiones d={d} sem={sem} regla={regla} numeros={numeros} esc={esc} elegida={elegida} cant={cant} recargar={recargar} toast={toast} />
    </div>
  )
}

const Seccion = ({ letra, titulo, children, extra }) => (
  <div className="card">
    <div className="pi-barra"><div className="section-label">{letra} · {titulo}</div>{extra}</div>
    <div style={{ marginTop: 10 }}>{children}</div>
  </div>
)

// ─── a. Galería (obligatoria) ───────────────────────────────
function Galeria({ d, fotos, regla, recargar, toast }) {
  const input = useRef(null)
  const [f, setF] = useState({ fuente: 'proveedor', descripcion: '', url: '' })
  const [subiendo, setSubiendo] = useState(false)
  const opts = () => ({ fuente: f.fuente, descripcion: f.descripcion, esPrincipal: fotos.length === 0, orden: fotos.length + 1 })

  const subir = async (e) => {
    const file = e.target.files?.[0]; e.target.value = ''
    if (!file) return
    setSubiendo(true)
    try { await subirFoto(d.candidato.id, file, opts()); toast('Foto subida', 'success'); setF(p => ({ ...p, descripcion: '' })); recargar() } catch (err) { toast(err.message, 'error') } finally { setSubiendo(false) }
  }
  const externa = async () => {
    if (!/^https:\/\//.test(f.url.trim())) { toast('El link tiene que empezar con https://', 'error'); return }
    try { await agregarFotoExterna(d.candidato.id, f.url.trim(), opts()); setF(p => ({ ...p, url: '', descripcion: '' })); recargar() } catch (err) { toast(err.message, 'error') }
  }
  const principal = async (id) => { try { await marcarPrincipal(fotos, id); recargar() } catch (err) { toast(err.message, 'error') } }
  const quitar = async (foto) => { if (!confirm('¿Borrar esta foto?')) return; try { await borrarFoto(foto); recargar() } catch (err) { toast(err.message, 'error') } }

  return (
    <Seccion letra="a" titulo="Fotos del producto (obligatorias)" extra={<span className={`badge ${regla.ok ? 'badge-green' : 'badge-red'}`}>{regla.reales} reales · {regla.proveedor} del proveedor</span>}>
      {d.fotos === null && <p className="pi-desc">La tabla de fotos todavía no está en la base.</p>}
      {d.fotos !== null && alertaFoto(fotos) && (
        <div className="alert alert-error" style={{ marginBottom: 10 }}>
          <AlertTriangle size={15} style={{ flexShrink: 0, marginTop: 1 }} />
          <span><b>{alertaFoto(fotos).texto}.</b> {fotos.length ? 'Tocá la estrella de la foto que va en la tarjeta.' : 'Subí al menos una foto: es la que se ve en la tarjeta.'}</span>
        </div>
      )}
      {fotos.length === 0 ? (
        <div className="imp-sin-foto imp-sin-foto-grande"><ImageOff size={26} /><span>Sin fotos. Mínimo 3 (al menos 1 real del proveedor; después de la muestra, 1 propia).</span></div>
      ) : (
        <div className="imp-galeria">
          {fotos.map(ft => (
            <figure key={ft.id} className={`imp-foto-item ${ft.es_principal ? 'principal' : ''}`}>
              <FotoImg foto={ft} />
              <figcaption>
                <span className={`badge ${ft.fuente === 'ia_referencia' ? 'badge-purple' : ft.fuente === 'proveedor' ? 'badge-blue' : 'badge-green'}`}>{FUENTES_FOTO.find(x => x[0] === ft.fuente)?.[1] || ft.fuente}{ft.fuente === 'ia_referencia' ? ' · no es el producto real' : ''}</span>
                <span className="pi-sub">{ft.descripcion || ''}</span>
                <span style={{ display: 'flex', gap: 4 }}>
                  <button className="btn btn-ghost btn-sm btn-icon" title={ft.es_principal ? 'Foto principal' : 'Usar como principal'} onClick={() => principal(ft.id)} disabled={ft.es_principal}><Star size={12} fill={ft.es_principal ? 'currentColor' : 'none'} /></button>
                  <button className="btn btn-ghost btn-sm btn-icon" title="Borrar" onClick={() => quitar(ft)}><Trash2 size={12} /></button>
                </span>
              </figcaption>
            </figure>
          ))}
        </div>
      )}
      <div className="form-grid form-grid-3" style={{ marginTop: 12 }}>
        <Campo label="Fuente de la foto"><select className="form-select" value={f.fuente} onChange={e => setF(p => ({ ...p, fuente: e.target.value }))}>{FUENTES_FOTO.map(([v, l]) => <option key={v} value={v}>{l}</option>)}</select></Campo>
        <Campo label="Descripción"><input className="form-input" value={f.descripcion} onChange={e => setF(p => ({ ...p, descripcion: e.target.value }))} placeholder="qué muestra" /></Campo>
        <Campo label="Subir foto (JPG/PNG/WEBP, ≤ 8 MB)" hint="Va al bucket privado pi-fotos; se ve con un link firmado de 1 hora.">
          <input ref={input} type="file" accept="image/jpeg,image/png,image/webp" style={{ display: 'none' }} onChange={subir} />
          <button className="btn btn-secondary btn-sm" onClick={() => input.current?.click()} disabled={subiendo}><Upload size={12} /> {subiendo ? 'Subiendo…' : 'Elegir archivo'}</button>
        </Campo>
        <Campo label="…o link https de la foto" span={2}><input className="form-input" value={f.url} onChange={e => setF(p => ({ ...p, url: e.target.value }))} placeholder="https://…" /></Campo>
        <Campo label=" "><button className="btn btn-ghost btn-sm" onClick={externa} disabled={!f.url.trim()}><Link2 size={12} /> Agregar link</button></Campo>
      </div>
    </Seccion>
  )
}

// ─── b. 3 números grandes ───────────────────────────────────
function Numeros({ n, esc }) {
  const pasaTope = n.adsMax != null && n.adsMax >= TOPE_ADS_VOLTRA
  return (
    <Seccion letra="b" titulo="Los números">
      <div className="imp-numeros">
        <div className="imp-num"><span className="data-label">Ganancia por pedido confirmado</span><span className={`imp-num-valor ${n.ganancia != null && n.ganancia < 0 ? 'pi-rojo' : ''}`}>{n.ganancia != null ? fmtGs(n.ganancia) : 'desconocido'}</span><span className="pi-sub">después de anuncios · escenario base · contribución, no utilidad neta</span></div>
        <div className="imp-num"><span className="data-label">Plata total necesaria</span><span className="imp-num-valor">{n.plata != null ? fmtGs(n.plata) : 'desconocido'}</span><span className="pi-sub">muestra + lote + flete + tributos + anuncios de prueba{n.pico != null ? ` · pico de caja ${fmtGs(n.pico)}` : ''}</span></div>
        <div className="imp-num"><span className="data-label">Días para recuperarla</span><span className="imp-num-valor">{n.dias != null ? n.dias : n.recupera === false ? 'no recupera' : 'desconocido'}</span><span className="pi-sub">sin anualizar, dentro del horizonte cargado</span></div>
      </div>
      <div className={`alert ${n.adsMax == null ? 'alert-info' : pasaTope ? 'alert-success' : 'alert-warning'}`} style={{ marginTop: 10 }}>
        {pasaTope ? <CheckCircle2 size={15} /> : <AlertTriangle size={15} />}
        <span>Costo de anuncios máximo que aguanta: <b>{n.adsMax != null ? fmtGs(n.adsMax) : 'desconocido'}</b> por confirmado, contra el tope de Voltra de {fmtGs(TOPE_ADS_VOLTRA)} por confirmado. {n.adsMax != null && (pasaTope ? 'Aguanta el tope.' : 'No aguanta el tope: con ese costo de anuncios pierde plata.')}</span>
      </div>
      {!esc && <p className="pi-desc">Sin escenario guardado: cargalo en Productos nuevos → Rentabilidad.</p>}
    </Seccion>
  )
}

// ─── c. Trato pactado con el proveedor ──────────────────────
function Trato({ d, comparacion, elegida }) {
  const top = comparacion.slice(0, 3)
  const evProv = (prov, re) => d.evidencias.find(e => re.test(e.campo || '') && prov && e.fuente_entidad && claveVendedor(e.fuente_entidad) === claveVendedor(prov.razon_social_declarada))
  return (
    <Seccion letra="c" titulo="Trato con el proveedor">
      {top.length === 0 ? <p className="pi-desc">Sin cotizaciones cargadas.</p> : (
        <div className="imp-proveedores">
          {top.map(x => {
            const pago = evProv(x.prov, /pago/), garantia = evProv(x.prov, /garantia|defecto/)
            const msgs = (d.mensajes || []).filter(m => m.proveedor_id === x.c.proveedor_id)
            const esElegida = elegida && x.c.id === elegida.c.id
            return (
              <div key={x.c.id} className={`imp-prov ${esElegida ? 'elegido' : ''}`}>
                <div style={{ display: 'flex', justifyContent: 'space-between', gap: 6, alignItems: 'flex-start' }}>
                  <b>{x.prov?.razon_social_declarada || 'proveedor'}</b>
                  {esElegida && <span className="badge badge-accent">elegido</span>}
                </div>
                <div className="pi-sub">{x.prov?.plataforma} · ficha v{x.c.ficha_version ?? '?'} · <span className={x.c.tipo === 'firme' ? '' : 'pi-rojo'}>{x.c.tipo === 'escaparate' ? 'escaparate (no firme)' : x.c.tipo}</span></div>
                <div className="imp-prov-costo"><span className="data-label">Costo puesto por unidad vendible</span><span className="imp-num-valor" style={{ fontSize: 20 }}>{x.costoPuesto != null ? fmtGs(x.costoPuesto) : x.precioVendible != null ? fmtGs(x.precioVendible) : 'desconocido'}</span><span className="pi-sub">{x.costoPuesto != null ? `estimado con la logística del escenario base${x.sinFleteInternacional ? ' (sin flete internacional: compra local)' : ''}` : x.falta || 'solo precio de compra (sin escenario)'}</span></div>
                <dl className="imp-dl">
                  <dt>Escalones</dt><dd>{x.escalones.map(e => `${e.cantidad} u: ${fmtDinero(e.precio_unit_minor, x.c.moneda)}`).join(' · ') || 'desconocido'}</dd>
                  <dt>Pedido mínimo</dt><dd>{x.c.moq ?? 'desconocido'}</dd>
                  <dt>Muestra</dt><dd>{x.c.costo_muestra_minor != null ? fmtDinero(x.c.costo_muestra_minor, x.c.moneda) : 'desconocido'}</dd>
                  <dt>Producción y despacho</dt><dd>{x.c.plazo_dias != null ? `${x.c.plazo_dias} días` : 'desconocido'}{x.c.lugar ? ` · ${x.c.lugar}` : ''}{x.c.incoterm ? ` · ${x.c.incoterm}` : ''}</dd>
                  <dt>Envío</dt><dd>{x.c.incluye_envio || 'desconocido'}</dd>
                  <dt>Empaque</dt><dd>{[x.c.unidades_por_caja && `${x.c.unidades_por_caja} u/caja`, x.c.medidas_caja_cm && `${x.c.medidas_caja_cm} cm`, x.c.peso_bruto_g && `${x.c.peso_bruto_g} g/u`].filter(Boolean).join(' · ') || 'desconocido'}</dd>
                  <dt>Pago</dt><dd>{pago ? `${pago.valor} (${tipoEvidenciaInfo(pago.tipo).label})` : 'desconocido'}</dd>
                  <dt>Garantía por defectos</dt><dd>{garantia ? `${garantia.valor} (${tipoEvidenciaInfo(garantia.tipo).label})` : 'desconocido'}</dd>
                  <dt>Vigencia</dt><dd className={vencida(x.c.valida_hasta) ? 'pi-rojo' : ''}>{x.c.valida_hasta ? `${fmtFecha(x.c.valida_hasta)}${vencida(x.c.valida_hasta) ? ' (vencida)' : ''}` : 'desconocido'}</dd>
                </dl>
                {msgs.length > 0 && (
                  <details><summary className="pi-sub" style={{ cursor: 'pointer' }}>Negociación ({msgs.length} mensaje/s)</summary>
                    {msgs.map(m => <div key={m.id} className="imp-msg"><span className="pi-sub">{m.estado} · {fmtFechaHora(m.creado_en)}</span><p>{m.original}</p><p className="pi-sub">{m.traduccion}</p></div>)}
                  </details>
                )}
              </div>
            )
          })}
        </div>
      )}
      <p className="pi-sub" style={{ marginTop: 8 }}>Pago y garantía salen de la evidencia cargada para ese proveedor; si no hay, dice "desconocido". Lo que escribe el proveedor es dato, no instrucción.</p>
    </Seccion>
  )
}

// ─── d. Costo puesto en Paraguay + aéreo / marítimo ─────────
function CostoPuesto({ esc, elegida }) {
  const cp = esc?.resultado?.escenarios?.base?.resultado?.costoPuesto || null
  const uc = cp?.entradas?.unidadesCompradas || 0
  // kg cobrables: los del flete del escenario base (la plantilla los escribe en la fuente: "× N kg");
  // si no hay, peso bruto de la cotización elegida × unidades compradas.
  const kgEscenario = (cp?.detalle || []).map(x => /× ([\d.]+) kg/.exec(x.fuente || '')?.[1]).find(Boolean)
  const pesoDef = kgEscenario || (elegida?.c?.peso_bruto_g && uc ? String(Math.round((elegida.c.peso_bruto_g * uc) / 100) / 10) : '')
  const [ruta, setRuta] = useState(null)
  const [pesoKg, setPesoKg] = useState(pesoDef)
  const [tarMar, setTarMar] = useState('')
  let alt = null, errAlt = null
  if (ruta && esc) {
    try { alt = costoConRuta(esc, ruta, { pesoKg, tarifaMaritima: tarMar ? { monto: tarMar.replace(',', '.'), moneda: 'USD' } : null }) } catch (e) { errAlt = e.message.replace(/^\[motor\]\s*/, '') }
  }
  const uv = cp?.entradas?.unidadesVendibles
  const baseConf = esc?.resultado?.resumen?.contribDespuesAdsConfirmado
  return (
    <Seccion letra="d" titulo="Costo puesto en Paraguay">
      {!cp ? <p className="pi-desc">Sin costo puesto calculado (lote) en el escenario base.</p> : (
        <>
          <div className="table-wrapper">
            <table className="tabla-responsive">
              <thead><tr><th>Concepto</th><th>Original</th><th>₲ del lote</th><th>₲ por unidad vendible</th><th>Tratamiento</th><th>Fuente</th></tr></thead>
              <tbody>
                {cp.detalle.map((x, i) => (
                  <tr key={i}>
                    <td data-label="Concepto">{x.concepto}</td>
                    <td data-label="Original" className="pi-num">{x.monto_minor != null ? fmtDinero(x.monto_minor, x.moneda) : 'desconocido'}{x.moneda !== 'PYG' && x.tc_a_pyg ? <div className="pi-sub">1 {x.moneda} = ₲ {x.tc_a_pyg}</div> : null}</td>
                    <td data-label="₲ lote" className="pi-num">{x.pyg != null ? fmtGs(x.pyg) : x.rangoPYG ? `${fmtGs(x.rangoPYG.min)}–${fmtGs(x.rangoPYG.max)}` : '—'}</td>
                    <td data-label="₲ / u vendible" className="pi-num">{x.pyg != null && uv ? fmtGs(Math.round(x.pyg / uv)) : '—'}</td>
                    <td data-label="Tratamiento" style={{ whiteSpace: 'normal' }} className="pi-sub">{x.tratamiento}</td>
                    <td data-label="Fuente" style={{ whiteSpace: 'normal', maxWidth: 220 }} className="pi-sub">{x.fuente || 'sin fuente'}</td>
                  </tr>
                ))}
                <tr><td data-label="Merma"><b>Merma</b></td><td colSpan={2} data-label="">{cp.merma.unidades} u ({fmtPct(cp.merma.pct)})</td><td data-label="" /><td data-label="" className="pi-sub">se reparte en las vendibles</td><td data-label="" /></tr>
              </tbody>
            </table>
          </div>
          <div className="imp-total">Costo por unidad vendible: <b className="pi-num">{cp.porUnidadVendible != null ? fmtGs(cp.porUnidadVendible) : `${fmtGs(cp.rango?.porUnidadVendible?.min)} a ${fmtGs(cp.rango?.porUnidadVendible?.max)}`}</b> <span className="pi-sub">({uv} vendibles de {uc} compradas)</span></div>
          {cp.avisos?.length > 0 && <ul className="pi-avisos">{cp.avisos.map((a, i) => <li key={i}>{a}</li>)}</ul>}

          <div className="section-label" style={{ marginTop: 14 }}>Cambiar la ruta del flete internacional</div>
          <div className="pi-barra" style={{ justifyContent: 'flex-start', marginTop: 6 }}>
            <button className={`chip-choice ${ruta === 'avion_easybox' ? 'active' : ''}`} onClick={() => setRuta('avion_easybox')}><Plane size={12} /> Aéreo</button>
            <button className={`chip-choice ${ruta === 'barco_easybox' ? 'active' : ''}`} onClick={() => setRuta('barco_easybox')}><Ship size={12} /> Marítimo</button>
            <button className={`chip-choice ${ruta === 'local_cde' ? 'active' : ''}`} onClick={() => setRuta('local_cde')}><Store size={12} /> Local CDE</button>
            <input className="form-input pi-in pi-in-num" style={{ width: 120 }} value={pesoKg} onChange={e => setPesoKg(e.target.value)} placeholder="kg cobrables" title="kg cobrables del lote (el mayor entre real y volumétrico)" />
            {ruta === 'barco_easybox' && <input className="form-input pi-in pi-in-num" style={{ width: 150 }} value={tarMar} onChange={e => setTarMar(e.target.value)} placeholder="USD/kg (verificar)" title="Sin tarifa marítima validada: si no se carga, queda desconocido" />}
          </div>
          {errAlt && <div className="alert alert-warning" style={{ marginTop: 8 }}><AlertTriangle size={15} /> {errAlt}</div>}
          {alt && (
            <div className="imp-comparar-ruta">
              <div><span className="data-label">Costo por unidad vendible</span><span className="pi-num">{fmtGs(alt.costoPuesto?.porUnidadVendible)}</span><span className="pi-sub">antes {fmtGs(cp.porUnidadVendible)} · diferencia {alt.costoPuesto?.porUnidadVendible != null && cp.porUnidadVendible != null ? fmtGs(alt.costoPuesto.porUnidadVendible - cp.porUnidadVendible) : '—'}</span></div>
              <div><span className="data-label">Ganancia por confirmado</span><span className="pi-num">{fmtGs(alt.contribucion.porConfirmado.contribucionDespuesAds)}</span><span className="pi-sub">antes {fmtGs(baseConf)}</span></div>
              <div><span className="data-label">Plantilla</span><span className="pi-sub">{(alt.costoPuesto?.detalle || []).filter(x => /^Flete internacional/.test(x.concepto)).map(x => x.fuente).join(' · ')}</span></div>
            </div>
          )}
        </>
      )}
    </Seccion>
  )
}

// ─── e. Precio de venta: escalera 1/2/3 vs competencia ──────
function Precio({ d, esc }) {
  const p1 = esc?.entradas?.motor?.precio
  const [precios, setPrecios] = useState([p1 != null ? String(p1) : '', '', ''])
  const filas = escalera(esc, precios.map(p => aMinor(p, 'PYG')))
  return (
    <Seccion letra="e" titulo="Precio de venta propuesto">
      <div className="form-grid form-grid-3">
        {[0, 1, 2].map(i => <Campo key={i} label={`${i + 1} unidad${i ? 'es' : ''} (₲, IVA incl.)`}><input className="form-input" value={precios[i]} onChange={e => setPrecios(p => p.map((x, j) => j === i ? e.target.value : x))} inputMode="numeric" /></Campo>)}
      </div>
      {filas.length === 0 ? <p className="pi-desc" style={{ marginTop: 8 }}>Hace falta un escenario guardado para calcular la ganancia de cada oferta.</p> : (
        <div className="table-wrapper" style={{ marginTop: 10 }}>
          <table className="tabla-responsive">
            <thead><tr><th>Oferta</th><th>Precio</th><th>Ganancia por confirmado</th><th>Ganancia por pedido iniciado</th><th>Anuncios máx. por confirmado</th></tr></thead>
            <tbody>{filas.map(x => (
              <tr key={x.unidades}>
                <td data-label="Oferta">{x.unidades} u</td>
                <td data-label="Precio" className="pi-num">{x.precio != null ? fmtGs(x.precio) : '—'}</td>
                <td data-label="Por confirmado" className={`pi-num ${x.porConfirmado < 0 ? 'pi-rojo' : ''}`}>{x.error ? <span className="pi-sub">{x.error}</span> : x.porConfirmado != null ? fmtGs(x.porConfirmado) : '—'}</td>
                <td data-label="Por iniciado" className="pi-num">{x.porIniciado != null ? fmtGs(x.porIniciado) : '—'}</td>
                <td data-label="Ads máx." className="pi-num">{x.adsMax != null ? fmtGs(x.adsMax) : '—'}</td>
              </tr>
            ))}</tbody>
          </table>
        </div>
      )}
      <div className="section-label" style={{ marginTop: 12 }}>Competencia en Paraguay</div>
      {d.ofertas.length === 0 ? <p className="pi-desc">Sin ofertas relevadas.</p> : (
        <div className="table-wrapper" style={{ marginTop: 6 }}>
          <table className="tabla-responsive">
            <thead><tr><th>Vendedor</th><th>Comparación</th><th>Zona</th><th>Precio</th><th>Observado</th><th>Fuente</th></tr></thead>
            <tbody>{d.ofertas.map(o => (
              <tr key={o.id}>
                <td data-label="Vendedor">{o.vendedor}</td><td data-label="Comparación">{o.comparacion}</td><td data-label="Zona">{o.zona}</td>
                <td data-label="Precio" className="pi-num">{fmtDinero(o.precio_minor, o.moneda)}{o.incluye_envio ? <span className="pi-sub"> envío incl.</span> : ''}</td>
                <td data-label="Observado">{fmtFecha(o.observado_en)}</td>
                <td data-label="Fuente">{urlSegura(o.url) ? <a className="pi-link" href={urlSegura(o.url)} target="_blank" rel="noopener noreferrer">link</a> : 'sin fuente'}</td>
              </tr>
            ))}</tbody>
          </table>
        </div>
      )}
      <p className="pi-sub" style={{ marginTop: 6 }}>El costo por unidad y los anuncios son los del escenario base (anuncios por pedido, no por unidad). Precio publicado de la competencia ≠ unidades vendidas.</p>
    </Seccion>
  )
}

// ─── f. Cantidad recomendada ────────────────────────────────
function Cantidad({ ritmo, setRitmo, cant, elegida, esc }) {
  return (
    <Seccion letra="f" titulo="Cantidad recomendada">
      <div className="form-grid form-grid-3">
        <Campo label="Ritmo de venta esperado (unidades por día)" hint="Hipótesis: con un piloto se reemplaza por el dato real."><input className="form-input" value={ritmo} onChange={e => setRitmo(e.target.value)} inputMode="decimal" /></Campo>
        <Campo label="Pedido mínimo del proveedor elegido"><input className="form-input" value={elegida?.c?.moq ?? 'desconocido'} disabled /></Campo>
        <Campo label="Semáforo de caja (del escenario)"><input className="form-input" value={esc?.entradas?.semaforoCaja || 'DESCONOCIDO'} disabled /></Campo>
      </div>
      {!cant ? <p className="pi-desc" style={{ marginTop: 8 }}>Cargá el ritmo esperado (y un escenario con costo) para ver piloto contra marítimo.</p> : (
        <>
          <div className="imp-numeros" style={{ marginTop: 10 }}>
            <div className={`imp-num ${cant.recomendado === 'piloto' ? 'recomendado' : ''}`}><span className="data-label">Piloto: muestra + lote aéreo chico</span><span className="imp-num-valor">{cant.piloto} u</span><span className="pi-sub">{fmtGs(cant.plataPiloto)} de mercadería puesta</span></div>
            <div className={`imp-num ${cant.recomendado === 'maritimo' ? 'recomendado' : ''}`}><span className="data-label">Lote marítimo</span><span className="imp-num-valor">{cant.maritimo} u</span><span className="pi-sub">{fmtGs(cant.plataMaritimo)} (con el costo aéreo; recalculá la ruta en d)</span></div>
            <div className="imp-num"><span className="data-label">Tope: {MAX_MESES_NO_PROBADO} meses de venta</span><span className="imp-num-valor">{cant.tope} u</span><span className="pi-sub">nunca más que esto de algo no probado</span></div>
          </div>
          <p className={`pi-sub ${cant.recomendado === 'solo_muestra' ? 'pi-rojo' : ''}`} style={{ marginTop: 8 }}>{cant.nota}{cant.moqSuperaTope ? ' Ojo: el pedido mínimo del proveedor supera 4 meses de venta; renegociar el mínimo o buscar otro proveedor.' : ''}</p>
        </>
      )}
    </Seccion>
  )
}

// ─── g. Escenarios, riesgos y bloqueos ──────────────────────
function Escenarios({ esc, caso }) {
  const e = esc?.resultado?.escenarios
  const bloqueos = caso?.bloqueos?.bloqueos || []
  const avisos = caso?.bloqueos?.avisos || []
  const pt = caso?.rubrica?.puntaje
  return (
    <Seccion letra="g" titulo="Escenarios, riesgos y bloqueos">
      {!e ? <p className="pi-desc">Sin escenarios calculados.</p> : (
        <div className="table-wrapper">
          <table className="tabla-responsive">
            <thead><tr><th>Escenario</th><th>Costo unit.</th><th>Ganancia por confirmado</th><th>Ganancia por pedido iniciado</th><th>Anuncios máx. por confirmado</th><th>Fuente</th></tr></thead>
            <tbody>{['adverso', 'base', 'favorable'].map(k => e[k] && (
              <tr key={k}>
                <td data-label="Escenario" style={{ textTransform: 'capitalize' }}>{k}</td>
                <td data-label="Costo unit." className="pi-num">{fmtGs(e[k].resumen.costoUnit)}</td>
                <td data-label="Por confirmado" className={`pi-num ${e[k].resumen.porConfirmado.despuesAds < 0 ? 'pi-rojo' : ''}`}>{fmtGs(e[k].resumen.porConfirmado.despuesAds)}</td>
                <td data-label="Por iniciado" className="pi-num">{fmtGs(e[k].resumen.porIniciado.despuesAds)}</td>
                <td data-label="Ads máx." className="pi-num">{fmtGs(e[k].resumen.porConfirmado.adsMaximo)}</td>
                <td data-label="Fuente" className="pi-sub" style={{ whiteSpace: 'normal', maxWidth: 220 }}>{e[k].fuentes ? String(e[k].fuentes) : 'sin fuente: verificar'}</td>
              </tr>
            ))}</tbody>
          </table>
        </div>
      )}
      <p className="pi-sub" style={{ marginTop: 6 }}>Escenarios = hipótesis configurables, no probabilidades.</p>
      {!caso ? <p className="pi-desc" style={{ marginTop: 8 }}>Sin rúbrica evaluada: guardá una decisión en Productos nuevos → Decisión.</p> : (
        <>
          {bloqueos.length === 0 ? <p className="pi-desc" style={{ marginTop: 8 }}><CheckCircle2 size={13} color="var(--green)" /> Sin bloqueos duros en la última evaluación (v{caso.version}).</p>
            : <ul className="pi-bloqueos">{bloqueos.map((b, i) => <li key={i}><span className="badge badge-red">{b.codigo}</span> {b.mensaje}</li>)}</ul>}
          {avisos.length > 0 && <ul className="pi-avisos">{avisos.map((a, i) => <li key={i}><span className="badge badge-yellow">{a.codigo}</span> {a.mensaje}</li>)}</ul>}
          {pt && <p className="pi-sub" style={{ marginTop: 8 }}>Puntaje de prioridad: <b>{pt.puntaje} / 100</b> (cobertura de la evidencia {fmtPct(pt.cobertura, 0)}). No es una probabilidad de éxito.</p>}
        </>
      )}
    </Seccion>
  )
}

// ─── h. Evidencia ───────────────────────────────────────────
function Evidencia({ d }) {
  return (
    <Seccion letra="h" titulo="Evidencia: qué es dato y qué no">
      <div className="imp-evid">
        {TIPOS_EVIDENCIA.map(t => {
          const items = d.evidencias.filter(e => e.tipo === t.v)
          return (
            <div key={t.v} className="imp-evid-col">
              <div><BadgeTipo tipo={t.v} /> <span className="pi-num">{items.length}</span></div>
              <ul>{items.slice(0, 8).map(e => <li key={e.id} className={vencida(e.valido_hasta) ? 'pi-rojo' : ''}>{e.campo}: {e.valor ?? 'desconocido'}{e.fuente_entidad ? ` · ${e.fuente_entidad}` : ''}{vencida(e.valido_hasta) ? ' (vencida)' : ''}</li>)}</ul>
            </div>
          )
        })}
      </div>
    </Seccion>
  )
}

// ─── Previsto contra real (después de importar) ─────────────
function PrevistoReal({ d, numeros }) {
  const [res, setRes] = useState(undefined)
  useEffect(() => { leerResultadoExperimentos(d.candidato.id).then(setRes).catch(() => setRes(null)) }, [d.candidato.id])
  const r = res?.find(x => x.candidato_id === d.candidato.id) || res?.[0] || null
  const entregaReal = r && (r.entregados + r.devueltos) > 0 ? r.entregados / (r.entregados + r.devueltos) : null
  return (
    <Seccion letra="+" titulo="Previsto contra real">
      {res === undefined ? <div className="skeleton" style={{ height: 60 }} /> : !r ? <p className="pi-desc">Sin resultados reales todavía (cargá la prueba con sus anuncios en Productos nuevos → Prueba).</p> : (
        <div className="table-wrapper">
          <table className="tabla-responsive">
            <thead><tr><th>Métrica</th><th>Previsto</th><th>Real</th></tr></thead>
            <tbody>
              <tr><td data-label="Métrica">Costo de anuncios por confirmado</td><td data-label="Previsto" className="pi-num">{fmtGs(numeros.adsMax)} (máximo)</td><td data-label="Real" className="pi-num">{fmtGs(r.costo_por_confirmado)}</td></tr>
              <tr><td data-label="Métrica">Confirmados (30 días)</td><td data-label="Previsto">≥ 30 para ganador</td><td data-label="Real" className="pi-num">{r.confirmados_30d ?? '—'}</td></tr>
              <tr><td data-label="Métrica">Entrega (entregados ÷ resueltos)</td><td data-label="Previsto" className="pi-num">{fmtPct(d.escenarios[0]?.entradas?.motor?.tasas?.entrega)}</td><td data-label="Real" className="pi-num">{entregaReal != null ? fmtPct(entregaReal) : '—'}</td></tr>
              <tr><td data-label="Métrica">¿Ganador?</td><td data-label="Previsto">—</td><td data-label="Real">{r.ganador === true ? 'Sí' : r.ganador === false ? 'No' : 'todavía no se sabe'}</td></tr>
            </tbody>
          </table>
        </div>
      )}
    </Seccion>
  )
}

// ─── Botones de decisión ────────────────────────────────────
const DECISIONES = [
  { v: 'IMPORTAR', label: 'Importar', compra: true, ayuda: 'Arma la orden en BORRADOR con la cantidad recomendada. Pasar de borrador exige tu texto en la orden; el pago lo hacés vos.' },
  { v: 'MUESTRA', label: 'Pedir muestra', compra: true, ayuda: 'Pasa a la etapa Muestra. Comprar la muestra necesita tu confirmación aparte.' },
  { v: 'RENEGOCIAR', label: 'Renegociar', compra: false, ayuda: 'Crea un trabajo para Claude (dentro del permiso para negociar autorizado).' },
  { v: 'DESCARTAR', label: 'Descartar', compra: false, ayuda: 'Pide el motivo. Queda registrado para aprender.' },
]

function Decisiones({ d, sem, numeros, esc, elegida, cant, recargar, toast }) {
  const [abierta, setAbierta] = useState(null)
  const [f, setF] = useState({ texto: '', motivo: '', cantidad: '' })
  const [guardando, setGuardando] = useState(false)
  const rojo = sem.color === 'rojo'

  const abrir = (dec) => { setAbierta(dec); setF({ texto: '', motivo: '', cantidad: String(cant?.piloto || elegida?.c?.moq || '') }) }
  const confirmar = async () => {
    const dec = abierta
    if (!f.texto.trim()) { toast('Falta lo que escribió Enrique (textual).', 'error'); return }
    if (dec.v === 'DESCARTAR' && !f.motivo.trim()) { toast('Descartar pide el motivo.', 'error'); return }
    const cantidad = parseInt(f.cantidad, 10)
    if (dec.v === 'IMPORTAR' && (!elegida || !cantidad)) { toast('Para importar hace falta una cotización elegida y una cantidad.', 'error'); return }
    setGuardando(true)
    try {
      const snapshot = { ...numeros, semaforo: sem.color, motivosSemaforo: sem.motivos, escenario: esc ? { id: esc.id, nombre: esc.nombre, version: esc.version } : null, cotizacion_id: elegida?.c?.id || null, proveedor: elegida?.prov?.razon_social_declarada || null, costoPuestoProveedor: elegida?.costoPuesto ?? null, cantidad: cantidad || null, fotos: (d.fotos || []).length, fecha: new Date().toISOString() }
      await registrarDecision(d.candidato.id, { decision: dec.v, texto_enrique: f.texto, motivo: f.motivo, snapshot })
      if (dec.v === 'IMPORTAR') {
        const esc2 = (elegida.escalones || []).filter(e => e.cantidad <= cantidad).pop() || elegida.escalones[0]
        await crearOrden({
          candidato_id: d.candidato.id, proveedor_id: elegida.c.proveedor_id, cotizacion_id: elegida.c.id, plataforma: elegida.prov?.plataforma || 'otro',
          variante: elegida.c.variante, cantidad, precio_unit_minor: esc2?.precio_unit_minor ?? null, envio_minor: 0,
          total_minor: esc2 ? esc2.precio_unit_minor * cantidad : null, moneda: elegida.c.moneda, notas: 'Orden armada desde Importaciones (BORRADOR). El pago lo hace Enrique.',
        })
        await cambiarEtapa(d.candidato.id, 'IMPORTADO')
      } else if (dec.v === 'MUESTRA') {
        await cambiarEtapa(d.candidato.id, 'MUESTRA')
        await actualizarCandidato(d.candidato.id, { estado: 'PROBAR_MUESTRA', siguiente_accion: 'Pedir la muestra (confirmación aparte de Enrique para pagarla)' })
      } else if (dec.v === 'RENEGOCIAR') {
        await crearTrabajo({ tipo: 'cotizar', candidato_id: d.candidato.id, carga: { consulta: `renegociar: ${d.candidato.nombre}`.slice(0, 300), notas: (f.motivo || f.texto).slice(0, 500) } })
      } else if (dec.v === 'DESCARTAR') {
        await cambiarEtapa(d.candidato.id, 'DESCARTADO')
        await actualizarCandidato(d.candidato.id, { estado: 'DESCARTAR', siguiente_accion: null })
      }
      toast(`Decisión registrada: ${dec.label}`, 'success'); setAbierta(null); recargar()
    } catch (e) { toast(e.message, 'error') } finally { setGuardando(false) }
  }

  return (
    <div className="card">
      <div className="section-label">Decisión de Enrique</div>
      <div className="imp-botones">
        {DECISIONES.map(dec => {
          const bloq = dec.compra && rojo
          return <button key={dec.v} className={`btn btn-sm ${dec.v === 'IMPORTAR' ? 'btn-primary' : dec.v === 'DESCARTAR' ? 'btn-danger' : 'btn-secondary'}`} disabled={bloq} title={bloq ? `Bloqueo duro: ${sem.motivos.join(' · ')}` : dec.ayuda} onClick={() => abrir(dec)}>{dec.label}</button>
        })}
      </div>
      {rojo && <p className="pi-sub pi-rojo" style={{ marginTop: 6 }}><ShieldAlert size={11} /> Importar y Pedir muestra están frenados por un bloqueo duro: {sem.motivos.join(' · ')}</p>}
      {(d.decisiones || []).length > 0 && (
        <div className="m-card-list" style={{ marginTop: 10 }}>
          {d.decisiones.map(x => (
            <div key={x.id} className="m-card" style={{ padding: '10px 14px' }}>
              <div style={{ display: 'flex', gap: 8, alignItems: 'center', flexWrap: 'wrap' }}><span className="badge badge-accent">{x.decision}</span><span className="pi-sub">{fmtFechaHora(x.creado_en)}</span>{esModoDemo() && <Demo />}</div>
              <div style={{ fontSize: 13, marginTop: 4 }}>"{x.texto_enrique}"</div>
              {x.motivo && <div className="pi-sub">Motivo: {x.motivo}</div>}
            </div>
          ))}
        </div>
      )}
      {d.decisiones === null && <p className="pi-desc" style={{ marginTop: 6 }}>La tabla pi_decisiones todavía no está en la base.</p>}

      {abierta && (
        <Modal titulo={abierta.label} onCerrar={() => setAbierta(null)} pie={<><button className="btn btn-ghost" onClick={() => setAbierta(null)}>Cancelar</button><button className="btn btn-primary" onClick={confirmar} disabled={guardando}>{guardando ? 'Guardando…' : 'Registrar decisión'}</button></>}>
          <p className="pi-desc" style={{ marginBottom: 10 }}>{abierta.ayuda}</p>
          <div className="form-grid">
            <Campo label="Lo que escribió Enrique (textual) *" span={2} hint="Se guarda tal cual, con la fecha y los números de este momento."><textarea className="form-textarea" value={f.texto} onChange={e => setF(p => ({ ...p, texto: e.target.value }))} /></Campo>
            {(abierta.v === 'DESCARTAR' || abierta.v === 'RENEGOCIAR') && <Campo label={abierta.v === 'DESCARTAR' ? 'Motivo *' : 'Qué renegociar'} span={2}><input className="form-input" value={f.motivo} onChange={e => setF(p => ({ ...p, motivo: e.target.value }))} /></Campo>}
            {abierta.v === 'IMPORTAR' && (
              <>
                <Campo label="Proveedor / cotización"><input className="form-input" value={elegida ? `${elegida.prov?.razon_social_declarada || '—'} · ${elegida.c.tipo}` : 'sin cotización'} disabled /></Campo>
                <Campo label="Cantidad" hint={cant ? `Recomendado: ${cant.piloto} u (piloto)` : 'Cargá el ritmo esperado en f para ver la recomendada'}><input className="form-input" value={f.cantidad} onChange={e => setF(p => ({ ...p, cantidad: e.target.value }))} inputMode="numeric" /></Campo>
              </>
            )}
          </div>
          {abierta.compra && <div className="alert alert-warning" style={{ marginTop: 10 }}><ShieldAlert size={15} /> El pago lo hace Enrique; 1688 necesita depósito de un agente en China. Esto no compra ni paga nada.</div>}
        </Modal>
      )}
    </div>
  )
}
