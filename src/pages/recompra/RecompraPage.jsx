// src/pages/recompra/RecompraPage.jsx
import { useState, useEffect, useCallback } from 'react'
import { supabase } from '../../lib/supabase'
import { useToast } from '../../lib/toast'
import { RefreshCw, Download, Send, Users, Repeat, Layers, TrendingUp } from 'lucide-react'
import { segmentarRecompra, familiaProducto, DIAS_COOLDOWN } from '../../lib/recompra'
import { generarExcelRecompra } from '../../lib/recompraExcel'

// Normaliza referencia para cruzar ventas ↔ entregas (mismo criterio que el matcher)
function normalizarRef(ref) {
  if (!ref) return ''
  let r = String(ref).replace(/[#\s.\-/]/g, '').trim()
  if (/^\d+$/.test(r)) r = String(parseInt(r, 10))
  return r
}

export default function RecompraPage() {
  const { toast } = useToast()
  const [lineas, setLineas] = useState([])
  const [excluidos, setExcluidos] = useState(new Set())
  const [loading, setLoading] = useState(true)
  const [generando, setGenerando] = useState(false)
  const [resultado, setResultado] = useState(null) // { g1, g2, g3 } del último cálculo

  const cargar = useCallback(async () => {
    setLoading(true)
    try {
      // 1. Ventas entregadas (fuente de verdad de clientes)
      const { data: ventas } = await supabase
        .from('ventas')
        .select('n_referencia, cliente_nombre, cliente_telefono, producto_nombre, cantidad, fecha, estado')
        .eq('estado', 'entregado')
        .is('deleted_at', null)

      // 2. Fecha de entrega REAL desde PaP (tabla entregas), por referencia. Si hay varias, la más reciente.
      const { data: entregas } = await supabase
        .from('entregas')
        .select('n_referencia, fecha_entrega')
      const fechaEntregaPorRef = {}
      for (const e of (entregas || [])) {
        if (!e.n_referencia || !e.fecha_entrega) continue
        const ref = normalizarRef(e.n_referencia)
        if (!fechaEntregaPorRef[ref] || new Date(e.fecha_entrega) > new Date(fechaEntregaPorRef[ref])) {
          fechaEntregaPorRef[ref] = e.fecha_entrega
        }
      }

      // 3. Teléfonos en cooldown (contactados en los últimos 25 días)
      const desde = new Date(Date.now() - DIAS_COOLDOWN * 86400000).toISOString()
      const { data: logs } = await supabase
        .from('recompra_log')
        .select('telefono')
        .gte('fecha_envio', desde)
      const excl = new Set((logs || []).map(l => l.telefono))

      // 4. Construir líneas para el motor (fecha entrega real, o fecha de venta como proxy)
      const ls = (ventas || []).map(v => {
        const ref = normalizarRef(v.n_referencia)
        const fechaEntrega = fechaEntregaPorRef[ref] || v.fecha // proxy: fecha de venta
        return {
          telefono: v.cliente_telefono,
          nombre: v.cliente_nombre,
          familia: familiaProducto(v.producto_nombre),
          cantidad: v.cantidad || 1,
          fechaEntrega,
        }
      })

      setLineas(ls)
      setExcluidos(excl)
    } catch (e) {
      toast('Error cargando datos: ' + e.message, 'error')
    } finally {
      setLoading(false)
    }
  }, [toast])

  useEffect(() => { cargar() }, [cargar])

  // Cuántos están listos hoy (sin registrar nada) — para el contador
  const preview = (() => {
    if (loading) return null
    return segmentarRecompra(lineas, excluidos, new Date())
  })()

  const totalListos = preview ? preview.g1.length + preview.g2.length + preview.g3.length : 0

  // ── Botón A: Previsualizar (genera Excel SIN registrar) ──
  const previsualizar = async () => {
    setGenerando(true)
    try {
      const seg = segmentarRecompra(lineas, excluidos, new Date())
      setResultado(seg)
      const nombre = await generarExcelRecompra(seg)
      toast(`Excel generado: ${nombre} (sin marcar enviados)`, 'success')
    } catch (e) {
      toast('Error generando Excel: ' + e.message, 'error')
    } finally {
      setGenerando(false)
    }
  }

  // ── Botón B: Generar y marcar enviados (genera + registra en recompra_log) ──
  const generarYMarcar = async () => {
    setGenerando(true)
    try {
      const seg = segmentarRecompra(lineas, excluidos, new Date())
      const filas = [...seg.g1, ...seg.g2, ...seg.g3]
      if (!filas.length) {
        toast('No hay clientes para contactar hoy.', 'info')
        setGenerando(false)
        return
      }
      const nombre = await generarExcelRecompra(seg)
      // Registrar cada cliente incluido (para el cooldown de 25 días)
      const registros = filas.map(r => ({
        telefono: r.telefono,
        grupo: String(r.grupo),
        producto_ofrecido: r.productoOfrecido,
      }))
      const { error } = await supabase.from('recompra_log').insert(registros)
      if (error) throw error
      setResultado(seg)
      toast(`${nombre} · ${filas.length} clientes marcados como contactados`, 'success')
      // Recargar para reflejar el nuevo cooldown
      cargar()
    } catch (e) {
      toast('Error: ' + e.message, 'error')
    } finally {
      setGenerando(false)
    }
  }

  const mostrar = resultado || preview
  const conteo = mostrar
    ? { g1: mostrar.g1.length, g2: mostrar.g2.length, g3: mostrar.g3.length }
    : { g1: 0, g2: 0, g3: 0 }

  return (
    <div className="page">
      <div className="page-header">
        <div>
          <h1 className="page-title">Recompra</h1>
          <p className="page-subtitle">
            {loading ? 'Calculando…' : `${totalListos} cliente${totalListos === 1 ? '' : 's'} listo${totalListos === 1 ? '' : 's'} para contactar hoy`}
          </p>
        </div>
        <button className="btn btn-ghost btn-sm" onClick={cargar} disabled={loading} title="Recalcular">
          <RefreshCw size={15} className={loading ? 'spinning' : ''} />
        </button>
      </div>

      {/* Explicación breve */}
      <div className="card" style={{ padding: '14px 18px' }}>
        <p style={{ fontSize: 13, color: 'var(--text-secondary)', lineHeight: 1.6, margin: 0 }}>
          Esta lista se recalcula sola cada día: clientes cuya entrega ya cruzó el umbral entran automáticamente, y los que contactaste en los últimos {DIAS_COOLDOWN} días quedan afuera para no repetir. Corré esto cuando vayas a hacer outreach por WhatsApp.
        </p>
      </div>

      {/* Conteo por grupo */}
      <div className="kpi-grid">
        <div className="kpi-card" style={{ borderLeft: '3px solid #3B86C9' }}>
          <div className="kpi-label"><Repeat size={13} style={{ verticalAlign: -2 }} /> Grupo 1 · Reponer</div>
          <div className="kpi-value">{conteo.g1}</div>
          <div className="kpi-sub">Consumible por acabarse (+28 días)</div>
        </div>
        <div className="kpi-card" style={{ borderLeft: '3px solid #2BB673' }}>
          <div className="kpi-label"><Layers size={13} style={{ verticalAlign: -2 }} /> Grupo 2 · Combo sueño</div>
          <div className="kpi-value">{conteo.g2}</div>
          <div className="kpi-sub">Les falta completar el dúo</div>
        </div>
        <div className="kpi-card" style={{ borderLeft: '3px solid #E8973A' }}>
          <div className="kpi-label"><TrendingUp size={13} style={{ verticalAlign: -2 }} /> Grupo 3 · Cross-sell</div>
          <div className="kpi-value">{conteo.g3}</div>
          <div className="kpi-sub">Compró durable, ofrecer otro</div>
        </div>
        <div className="kpi-card">
          <div className="kpi-label"><Users size={13} style={{ verticalAlign: -2 }} /> Total a contactar</div>
          <div className="kpi-value" style={{ color: 'var(--accent)' }}>{conteo.g1 + conteo.g2 + conteo.g3}</div>
          <div className="kpi-sub">Suma de los 3 grupos</div>
        </div>
      </div>

      {/* Botones */}
      <div style={{ display: 'flex', gap: 10, flexWrap: 'wrap' }}>
        <button className="btn btn-secondary" onClick={previsualizar} disabled={loading || generando || totalListos === 0}>
          <Download size={15} /> Previsualizar (sin marcar)
        </button>
        <button className="btn btn-primary" onClick={generarYMarcar} disabled={loading || generando || totalListos === 0}>
          <Send size={15} /> Generar y marcar enviados
        </button>
      </div>

      <p style={{ fontSize: 11, color: 'var(--text-muted)', marginTop: -4 }}>
        <strong>Previsualizar</strong> descarga el Excel para mirar, sin gastar el cupo de {DIAS_COOLDOWN} días.{' '}
        <strong>Generar y marcar</strong> descarga y registra a cada cliente como contactado (usalo cuando ya vas a mandar los mensajes).
      </p>
    </div>
  )
}
