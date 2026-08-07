// src/pages/recepcion/RecepcionPage.jsx
// ═══════════════════════════════════════════════════════════
// RECEPCIÓN DE DEVOLUCIONES
//
// El courier dice "devuelto" apenas el cliente rechaza, pero la caja
// tarda semanas en volver. Hasta que no la tenés en la mano, esa
// mercadería NO es vendible. Acá se registra el reingreso físico:
// escaneás la pila que trajo el recolector, revisás, y confirmás.
// Recién ahí el stock vuelve a subir.
// ═══════════════════════════════════════════════════════════
import { useState, useEffect, useCallback, useRef, useMemo } from 'react'
import { supabase } from '../../lib/supabase'
import { fetchAll } from '../../lib/fetchAll'
import { useToast } from '../../lib/toast'
import { registrarReingresoLote } from '../../lib/stockEngine'
import { normalizarEscaneo, interpretarEscaneo } from '../../lib/barcode'
import { beep } from '../../lib/beep'
import {
  PackageOpen, ScanLine, CheckCircle, AlertTriangle, X, RefreshCw,
  Boxes, Clock,
} from 'lucide-react'

const diasDesde = (fecha) => {
  if (!fecha) return null
  return Math.floor((Date.now() - new Date(fecha).getTime()) / 86400000)
}

export default function RecepcionPage() {
  const { toast } = useToast()
  const inputRef = useRef(null)
  const [ventas, setVentas] = useState([])
  const [idxGuia, setIdxGuia] = useState({})
  const [loading, setLoading] = useState(true)
  const [confirmando, setConfirmando] = useState(false)
  const [valor, setValor] = useState('')
  const [tanda, setTanda] = useState([])        // paquetes escaneados en esta sesión
  const [ultimo, setUltimo] = useState(null)    // feedback del último escaneo
  const [verFaltantes, setVerFaltantes] = useState(false)

  const cargar = useCallback(async () => {
    setLoading(true)
    try {
      // Paginado: sin esto Supabase corta en 1.000 filas y un paquete devuelto
      // podría "no encontrarse" al escanearlo.
      const [vts, ents] = await Promise.all([
        fetchAll(() => supabase.from('ventas')
          .select('id, n_referencia, cliente_nombre, producto_nombre, cantidad, estado, stock_descontado, reingresado_at, fecha, ciudad, total')
          .is('deleted_at', null)),
        fetchAll(() => supabase.from('entregas').select('n_referencia, nro_guia_pap'), { columnaOrden: 'nro_guia_pap' }),
      ])
      setVentas(vts || [])
      // Índice guía PaP → referencia, para poder escanear la etiqueta del courier
      const gi = {}
      for (const e of (ents || [])) {
        if (e.nro_guia_pap && e.n_referencia) gi[normalizarEscaneo(e.nro_guia_pap)] = normalizarEscaneo(e.n_referencia)
      }
      setIdxGuia(gi)
    } catch (e) {
      toast('Error cargando datos: ' + e.message, 'error')
    } finally {
      setLoading(false)
    }
  }, [toast])

  useEffect(() => { cargar() }, [cargar])

  // Mantener el foco en el input: el escáner "teclea" y necesita el campo activo.
  useEffect(() => {
    const t = setInterval(() => {
      if (inputRef.current && document.activeElement !== inputRef.current && !confirmando) {
        inputRef.current.focus()
      }
    }, 800)
    return () => clearInterval(t)
  }, [confirmando])

  const idxRef = useMemo(() => {
    const m = {}
    for (const v of ventas) {
      const k = normalizarEscaneo(v.n_referencia)
      if (k) m[k] = v
    }
    return m
  }, [ventas])

  // Los que PaP marcó devueltos y todavía no volvieron físicamente
  const esperados = useMemo(
    () => ventas.filter(v => v.estado === 'devuelto' && !v.reingresado_at),
    [ventas]
  )
  const tandaIds = useMemo(() => new Set(tanda.map(t => t.id)), [tanda])
  const faltantes = useMemo(() => esperados.filter(e => !tandaIds.has(e.id)), [esperados, tandaIds])

  const procesar = (bruto) => {
    const { ref, raw } = interpretarEscaneo(bruto)
    if (!ref) return

    // Buscar por referencia propia (código nuevo o etiqueta vieja),
    // o por número de guía de Punto a Punto.
    let venta = idxRef[ref]
    if (!venta && idxGuia[raw]) venta = idxRef[idxGuia[raw]]
    if (!venta && idxGuia[ref]) venta = idxRef[idxGuia[ref]]

    if (!venta) {
      beep(false)
      setUltimo({ tipo: 'error', titulo: 'No encontrado', detalle: `"${bruto}" no coincide con ninguna venta ni guía de transportadora.` })
      return
    }
    if (venta.reingresado_at) {
      beep(false)
      const f = new Date(venta.reingresado_at).toLocaleDateString('es-PY', { day: '2-digit', month: 'short' })
      setUltimo({ tipo: 'error', titulo: 'Ya lo recibiste', detalle: `#${venta.n_referencia} — ${venta.producto_nombre}. Reingresado el ${f}.` })
      return
    }
    if (tandaIds.has(venta.id)) {
      beep(false)
      setUltimo({ tipo: 'warn', titulo: 'Repetido en esta tanda', detalle: `#${venta.n_referencia} ya está en la lista de abajo.` })
      return
    }

    const raro = venta.estado === 'entregado'
    beep(true)
    setTanda(prev => [{ ...venta, _raro: raro }, ...prev])
    setUltimo({
      tipo: raro ? 'warn' : 'ok',
      titulo: raro ? 'Figura como ENTREGADO' : 'Recibido',
      detalle: `#${venta.n_referencia} · ${venta.producto_nombre} ×${venta.cantidad || 1}${raro ? ' — revisá si el estado está mal' : ''}`,
      venta,
    })
  }

  const onSubmit = (e) => {
    e.preventDefault()
    procesar(valor)
    setValor('')
  }

  const quitar = (id) => setTanda(prev => prev.filter(t => t.id !== id))

  const confirmar = async () => {
    if (!tanda.length) return
    setConfirmando(true)
    try {
      const res = await registrarReingresoLote(tanda)
      toast(`${res.reingresadas} paquetes reingresados · ${res.unidades} unidades devueltas al stock`, 'success')
      setTanda([])
      setUltimo(null)
      await cargar()
    } catch (e) {
      toast('Error registrando reingreso: ' + e.message, 'error')
    } finally {
      setConfirmando(false)
      setTimeout(() => inputRef.current?.focus(), 100)
    }
  }

  const unidadesTanda = tanda.reduce((s, t) => s + (t.cantidad || 1), 0)

  return (
    <div className="page">
      <div className="page-header">
        <div>
          <h1 className="page-title">Recepción</h1>
          <p className="page-subtitle">
            {loading ? 'Cargando…' : `${esperados.length} paquete${esperados.length === 1 ? '' : 's'} esperando volver al depósito`}
          </p>
        </div>
        <button className="btn btn-ghost btn-sm" onClick={cargar} disabled={loading || confirmando} title="Recargar">
          <RefreshCw size={15} className={loading ? 'spinning' : ''} />
        </button>
      </div>

      {/* Explicación breve */}
      <div className="card" style={{ padding: '12px 16px' }}>
        <p style={{ fontSize: 12, color: 'var(--text-secondary)', lineHeight: 1.6, margin: 0 }}>
          Escaneá el código de barras de cada caja que trajo el recolector. También sirve el número de guía de la transportadora, o tipear la referencia a mano. El stock <strong>solo vuelve a subir</strong> cuando confirmás la tanda.
        </p>
      </div>

      {/* CAMPO DE ESCANEO — siempre enfocado */}
      <div className="card" style={{ padding: '18px 20px', border: '1px solid var(--accent)' }}>
        <form onSubmit={onSubmit}>
          <label style={{ fontSize: 11, color: 'var(--text-muted)', textTransform: 'uppercase', letterSpacing: 0.5, display: 'flex', alignItems: 'center', gap: 6, marginBottom: 8 }}>
            <ScanLine size={14} color="var(--accent)" /> Escaneá o tipeá la referencia
          </label>
          <input
            ref={inputRef}
            className="form-input"
            value={valor}
            onChange={e => setValor(e.target.value)}
            placeholder="Apuntá el lector al código…"
            autoFocus
            autoComplete="off"
            disabled={confirmando}
            style={{ fontSize: 22, fontFamily: 'var(--font-display)', letterSpacing: 1, padding: '12px 14px' }}
          />
        </form>

        {/* Feedback del último escaneo */}
        {ultimo && (
          <div style={{
            marginTop: 12, padding: '10px 14px', borderRadius: 10,
            background: ultimo.tipo === 'ok' ? 'var(--green-dim)' : 'var(--bg-hover)',
            border: `1px solid ${ultimo.tipo === 'ok' ? 'var(--green)' : ultimo.tipo === 'warn' ? 'var(--yellow)' : 'var(--red)'}`,
            display: 'flex', alignItems: 'flex-start', gap: 10,
          }}>
            {ultimo.tipo === 'ok'
              ? <CheckCircle size={16} color="var(--green)" style={{ flexShrink: 0, marginTop: 1 }} />
              : <AlertTriangle size={16} color={ultimo.tipo === 'warn' ? 'var(--yellow)' : 'var(--red)'} style={{ flexShrink: 0, marginTop: 1 }} />}
            <div>
              <div style={{ fontSize: 13, fontWeight: 700, color: ultimo.tipo === 'ok' ? 'var(--green)' : ultimo.tipo === 'warn' ? 'var(--yellow)' : 'var(--red)' }}>
                {ultimo.titulo}
              </div>
              <div style={{ fontSize: 12, color: 'var(--text-secondary)', marginTop: 2 }}>{ultimo.detalle}</div>
            </div>
          </div>
        )}
      </div>

      {/* CONTADOR + CONFIRMAR */}
      {tanda.length > 0 && (
        <div className="card" style={{ padding: '16px 20px', display: 'flex', alignItems: 'center', justifyContent: 'space-between', flexWrap: 'wrap', gap: 12 }}>
          <div>
            <div style={{ fontSize: 26, fontWeight: 800, fontFamily: 'var(--font-display)', color: 'var(--accent)', lineHeight: 1 }}>
              {tanda.length} <span style={{ fontSize: 14, color: 'var(--text-muted)', fontWeight: 500 }}>de {esperados.length} esperados</span>
            </div>
            <div style={{ fontSize: 12, color: 'var(--text-secondary)', marginTop: 4 }}>
              {unidadesTanda} unidad{unidadesTanda === 1 ? '' : 'es'} volverán al stock al confirmar
            </div>
          </div>
          <button className="btn btn-primary" onClick={confirmar} disabled={confirmando}>
            <Boxes size={15} /> {confirmando ? 'Registrando…' : `Confirmar reingreso de ${tanda.length}`}
          </button>
        </div>
      )}

      {/* LISTA DE LA TANDA */}
      {tanda.length > 0 && (
        <div className="card" style={{ padding: 0, overflow: 'hidden' }}>
          <div style={{ padding: '12px 20px', borderBottom: '1px solid var(--border)', fontSize: 12, fontWeight: 700, textTransform: 'uppercase', letterSpacing: 0.5, color: 'var(--text-secondary)' }}>
            Escaneados en esta tanda
          </div>
          <div style={{ maxHeight: 380, overflowY: 'auto' }}>
            <table className="tabla-responsive">
              <thead>
                <tr><th>Ref.</th><th>Producto</th><th>Cant.</th><th>Cliente</th><th>Estado</th><th></th></tr>
              </thead>
              <tbody>
                {tanda.map(t => (
                  <tr key={t.id} style={t._raro ? { background: 'rgba(234,179,8,0.06)' } : undefined}>
                    <td data-label="Ref." className="mono">#{t.n_referencia}</td>
                    <td data-label="Producto" style={{ fontSize: 12 }}>{t.producto_nombre}</td>
                    <td data-label="Cant." style={{ fontWeight: 700 }}>×{t.cantidad || 1}</td>
                    <td data-label="Cliente" className="muted" style={{ fontSize: 12 }}>{t.cliente_nombre || '—'}</td>
                    <td data-label="Estado">
                      <span style={{ fontSize: 11, fontWeight: 600, color: t._raro ? 'var(--yellow)' : 'var(--text-muted)' }}>
                        {t._raro ? '⚠ entregado' : t.estado}
                      </span>
                    </td>
                    <td>
                      <button className="btn btn-ghost btn-sm btn-icon" onClick={() => quitar(t.id)} title="Quitar de la tanda" style={{ color: 'var(--red)' }}>
                        <X size={14} />
                      </button>
                    </td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        </div>
      )}

      {/* FALTANTES — reconciliación */}
      {esperados.length > 0 && (
        <div className="card" style={{ padding: 0, overflow: 'hidden' }}>
          <button
            onClick={() => setVerFaltantes(v => !v)}
            style={{ width: '100%', background: 'none', border: 'none', cursor: 'pointer', padding: '14px 20px', display: 'flex', alignItems: 'center', justifyContent: 'space-between', color: 'inherit', textAlign: 'left' }}
          >
            <span style={{ display: 'flex', alignItems: 'center', gap: 8, fontSize: 13, fontWeight: 700 }}>
              <Clock size={15} color="var(--yellow)" />
              {tanda.length > 0 ? `Faltan ${faltantes.length} de los esperados` : `${esperados.length} devoluciones sin volver todavía`}
            </span>
            <span style={{ fontSize: 12, color: 'var(--text-muted)' }}>{verFaltantes ? 'Ocultar' : 'Ver'}</span>
          </button>

          {verFaltantes && (
            <div style={{ maxHeight: 380, overflowY: 'auto', borderTop: '1px solid var(--border)' }}>
              {faltantes.length === 0 ? (
                <p style={{ padding: 20, textAlign: 'center', color: 'var(--green)', fontSize: 13, margin: 0 }}>
                  Escaneaste todos los esperados. Nada pendiente.
                </p>
              ) : (
                <table className="tabla-responsive">
                  <thead>
                    <tr><th>Ref.</th><th>Producto</th><th>Cant.</th><th>Ciudad</th><th>Devuelto hace</th></tr>
                  </thead>
                  <tbody>
                    {faltantes
                      .slice()
                      .sort((a, b) => new Date(a.fecha) - new Date(b.fecha))
                      .map(f => {
                        const d = diasDesde(f.fecha)
                        return (
                          <tr key={f.id}>
                            <td data-label="Ref." className="mono">#{f.n_referencia}</td>
                            <td data-label="Producto" style={{ fontSize: 12 }}>{f.producto_nombre}</td>
                            <td data-label="Cant." style={{ fontWeight: 600 }}>×{f.cantidad || 1}</td>
                            <td data-label="Ciudad" className="muted" style={{ fontSize: 12 }}>{f.ciudad || '—'}</td>
                            <td data-label="Devuelto hace" style={{ fontWeight: 600, color: d > 60 ? 'var(--red)' : d > 30 ? 'var(--yellow)' : 'var(--text-muted)' }}>
                              {d != null ? `${d} días` : '—'}
                            </td>
                          </tr>
                        )
                      })}
                  </tbody>
                </table>
              )}
            </div>
          )}
        </div>
      )}

      {!loading && esperados.length === 0 && tanda.length === 0 && (
        <div className="empty-state">
          <div className="empty-state-icon"><PackageOpen size={22} /></div>
          <p>No hay devoluciones esperando reingreso.</p>
          <p style={{ fontSize: 12, color: 'var(--text-muted)' }}>
            Cuando la transportadora reporte devoluciones, van a aparecer acá para que las escanees al recibirlas.
          </p>
        </div>
      )}
    </div>
  )
}
