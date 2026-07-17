// src/pages/recompra/RecompraPage.jsx
import { useState, useEffect, useCallback, useMemo } from 'react'
import { supabase } from '../../lib/supabase'
import { fetchAll } from '../../lib/fetchAll'
import { useToast } from '../../lib/toast'
import { RefreshCw, Download, Repeat, MessageCircle, Loader2 } from 'lucide-react'
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

  const cargar = useCallback(async () => {
    setLoading(true)
    try {
      // Ventana: clientes que recibieron en los últimos 8 meses. Más viejo que
      // eso ya recompró o se perdió; no tiene sentido cargarlo (y es más rápido).
      const desdeVentas = new Date(); desdeVentas.setMonth(desdeVentas.getMonth() - 8)
      const desdeVentasStr = desdeVentas.toISOString().slice(0, 10)

      // 1. Ventas entregadas (fuente de verdad de clientes). Ordena por fecha
      //    (la tabla no tiene 'id' como orden de paginación).
      const ventas = await fetchAll(() => supabase
        .from('ventas')
        .select('n_referencia, cliente_nombre, cliente_telefono, producto_nombre, cantidad, fecha, estado')
        .eq('estado', 'entregado')
        .gte('fecha', desdeVentasStr)
        .is('deleted_at', null), { columnaOrden: 'fecha' })

      // 2. Fecha de entrega REAL desde PaP (tabla entregas), por referencia. Si hay varias, la más reciente.
      const entregas = await fetchAll(
        () => supabase.from('entregas').select('n_referencia, fecha_entrega').gte('fecha_entrega', desdeVentasStr),
        { columnaOrden: 'nro_guia_pap' })
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

  const [filtro, setFiltro] = useState('todos')  // todos | reponer | combo | crosssell
  const [copiado, setCopiado] = useState('')      // teléfono cuyo mensaje se copió

  // Segmentación de hoy
  const seg = useMemo(() => {
    if (loading) return { g1: [], g2: [], g3: [] }
    return segmentarRecompra(lineas, excluidos, new Date())
  }, [lineas, excluidos, loading])

  const totalListos = seg.g1.length + seg.g2.length + seg.g3.length

  // Lista UNIFICADA, ordenada por prioridad: primero reponer (ya se les acabó),
  // luego completar combo, luego cross-sell. Dentro de cada grupo, el que hace
  // más tiempo recibió primero.
  const listaUnificada = useMemo(() => {
    const marca = (arr, tipo, etiqueta, color) => arr
      .map(r => ({ ...r, tipo, etiqueta, color }))
      .sort((a, b) => (b.diasDesdeEntrega || 0) - (a.diasDesdeEntrega || 0))
    const todo = [
      ...marca(seg.g1, 'reponer', 'Reponer', '#3B86C9'),
      ...marca(seg.g2, 'combo', 'Completar combo', '#2BB673'),
      ...marca(seg.g3, 'crosssell', 'Nuevo producto', '#E8973A'),
    ]
    if (filtro === 'todos') return todo
    return todo.filter(r => r.tipo === filtro)
  }, [seg, filtro])

  // Arma el mensaje de WhatsApp para un cliente y lo copia al portapapeles.
  const mensajeWhatsApp = (r) => {
    const nombre = (r.nombre || '').split(' ')[0] || 'Hola'
    let cuerpo
    if (r.tipo === 'reponer') {
      cuerpo = `¡Hola ${nombre}! 👋 Vimos que ya hace un tiempo compraste tu ${r.productoComprado} y seguro se te está por acabar. Te reservamos una reposición: ${r.ofertaSugerida}. ¿Te lo mandamos?`
    } else if (r.tipo === 'combo') {
      cuerpo = `¡Hola ${nombre}! 👋 Para aprovechar al máximo tu ${r.productoComprado}, lo ideal es sumarle ${r.productoOfrecido} y completar el combo sueño. Te lo dejamos a: ${r.ofertaSugerida}. ¿Lo querés?`
    } else {
      cuerpo = `¡Hola ${nombre}! 👋 Gracias por tu compra de ${r.productoComprado}. Creemos que te va a encantar ${r.productoOfrecido}: ${r.ofertaSugerida}. ¿Te interesa?`
    }
    if (navigator.clipboard?.writeText) {
      navigator.clipboard.writeText(cuerpo).then(() => {
        setCopiado(r.telefono)
        setTimeout(() => setCopiado(''), 2500)
      }).catch(() => {})
    }
    // Abrir WhatsApp con el número y el texto prellenado
    const tel = String(r.telefono || '').replace(/\D/g, '').replace(/^0/, '595')
    const url = `https://wa.me/${tel}?text=${encodeURIComponent(cuerpo)}`
    window.open(url, '_blank')
  }

  // Marcar un cliente puntual como contactado (registra el cooldown)
  const marcarContactado = async (r) => {
    try {
      const { error } = await supabase.from('recompra_log').insert([{
        telefono: r.telefono, grupo: String(r.grupo), producto_ofrecido: r.productoOfrecido,
      }])
      if (error) throw error
      toast(`${r.nombre || r.telefono} marcado como contactado`, 'success')
      cargar()
    } catch (e) { toast('Error: ' + e.message, 'error') }
  }

  // ── Exportar Excel (opcional, se mantiene) ──
  const previsualizar = async () => {
    setGenerando(true)
    try {
      const nombre = await generarExcelRecompra(seg)
      toast(`Excel generado: ${nombre} (sin marcar enviados)`, 'success')
    } catch (e) {
      toast('Error generando Excel: ' + e.message, 'error')
    } finally {
      setGenerando(false)
    }
  }

  return (
    <div className="page">
      <div className="page-header">
        <div>
          <h1 className="page-title">Recompra</h1>
          <p className="page-subtitle">
            {loading ? 'Calculando…' : `${totalListos} cliente${totalListos === 1 ? '' : 's'} para recontactar hoy`}
          </p>
        </div>
        <div style={{ display: 'flex', gap: 8 }}>
          <button className="btn btn-secondary btn-sm" onClick={previsualizar} disabled={loading || generando || totalListos === 0} title="Descargar la lista en Excel">
            <Download size={14} /> Excel
          </button>
          <button className="btn btn-ghost btn-sm" onClick={cargar} disabled={loading} title="Recalcular">
            <RefreshCw size={15} className={loading ? 'spinning' : ''} />
          </button>
        </div>
      </div>

      {/* Explicación breve */}
      <div className="card" style={{ padding: '12px 16px' }}>
        <p style={{ fontSize: 12.5, color: 'var(--text-secondary)', lineHeight: 1.6, margin: 0 }}>
          Clientes que ya recibieron su producto y es buen momento para ofrecerles algo. Tocá <strong style={{ color: '#25D366' }}>WhatsApp</strong> y se abre el chat con el mensaje listo. Después marcá <strong>Contactado</strong> para no repetirlo en {DIAS_COOLDOWN} días.
        </p>
      </div>

      {/* Filtros por tipo */}
      {!loading && totalListos > 0 && (
        <div style={{ display: 'flex', gap: 8, flexWrap: 'wrap' }}>
          {[
            ['todos', `Todos (${totalListos})`, 'var(--accent)'],
            ['reponer', `Reponer (${seg.g1.length})`, '#3B86C9'],
            ['combo', `Completar combo (${seg.g2.length})`, '#2BB673'],
            ['crosssell', `Nuevo producto (${seg.g3.length})`, '#E8973A'],
          ].map(([val, lbl, color]) => (
            <button key={val} onClick={() => setFiltro(val)}
              style={{
                padding: '6px 14px', borderRadius: 20, fontSize: 12, fontWeight: 600, cursor: 'pointer',
                border: `1px solid ${filtro === val ? color : 'var(--border)'}`,
                background: filtro === val ? color : 'transparent',
                color: filtro === val ? '#0a0a0a' : 'var(--text-secondary)',
              }}>{lbl}</button>
          ))}
        </div>
      )}

      {/* Lista de clientes */}
      {loading ? (
        <div className="empty-state" style={{ padding: 60 }}><Loader2 size={28} className="spinning" /><p>Calculando recompra…</p></div>
      ) : totalListos === 0 ? (
        <div className="empty-state" style={{ padding: 60 }}>
          <div className="empty-state-icon"><Repeat size={28} /></div>
          <p style={{ fontWeight: 600 }}>Nadie para recontactar hoy</p>
          <p style={{ fontSize: 13, color: 'var(--text-muted)' }}>Cuando algún cliente pase el umbral de recompra, va a aparecer acá.</p>
        </div>
      ) : (
        <div style={{ display: 'flex', flexDirection: 'column', gap: 8 }}>
          {listaUnificada.map((r) => (
            <div key={r.telefono + r.tipo} className="card" style={{ padding: '12px 16px', display: 'flex', alignItems: 'center', gap: 14, flexWrap: 'wrap', borderLeft: `3px solid ${r.color}` }}>
              <div style={{ flex: 1, minWidth: 200 }}>
                <div style={{ display: 'flex', alignItems: 'center', gap: 8, flexWrap: 'wrap' }}>
                  <span style={{ fontWeight: 700, fontSize: 14 }}>{r.nombre || 'Sin nombre'}</span>
                  <span style={{ fontSize: 10, fontWeight: 700, padding: '2px 8px', borderRadius: 12, background: r.color + '22', color: r.color }}>{r.etiqueta}</span>
                </div>
                <div style={{ fontSize: 12, color: 'var(--text-muted)', marginTop: 3 }}>
                  <span className="mono">{r.telefono}</span> · compró {r.productoComprado} · recibió hace {r.diasDesdeEntrega} días
                </div>
                <div style={{ fontSize: 12.5, color: 'var(--text-secondary)', marginTop: 4 }}>
                  → Ofrecer: <strong>{r.ofertaSugerida}</strong>
                </div>
              </div>
              <div style={{ display: 'flex', gap: 8 }}>
                <button
                  onClick={() => mensajeWhatsApp(r)}
                  style={{ padding: '8px 14px', fontSize: 12.5, fontWeight: 700, borderRadius: 8, cursor: 'pointer', border: 'none', background: '#25D366', color: '#fff', display: 'flex', alignItems: 'center', gap: 6, whiteSpace: 'nowrap' }}
                >
                  <MessageCircle size={14} /> {copiado === r.telefono ? '¡Copiado!' : 'WhatsApp'}
                </button>
                <button
                  onClick={() => marcarContactado(r)}
                  title="Marcar como contactado (no vuelve a aparecer por un tiempo)"
                  style={{ padding: '8px 12px', fontSize: 12, fontWeight: 600, borderRadius: 8, cursor: 'pointer', border: '1px solid var(--border)', background: 'transparent', color: 'var(--text-secondary)', whiteSpace: 'nowrap' }}
                >
                  ✓ Contactado
                </button>
              </div>
            </div>
          ))}
        </div>
      )}
    </div>
  )
}
