// src/pages/kpi-whatsapp/KpiWhatsappPage.jsx — Panel semanal de WhatsApp (ola 3).
// Lee la vista kpi_whatsapp_semanal (lunes a domingo, hora de Asunción). Se mira cada lunes
// sobre la semana anterior; la semana en curso aparece marcada porque sus números todavía cambian.
import { useCallback, useEffect, useMemo, useState } from 'react'
import { RefreshCw, BarChart3 } from 'lucide-react'
import { supabase } from '../../lib/supabase'
import TarjetasKpi from './TarjetasKpi'
import TablaSemanas from './TablaSemanas'
import { agregarSinRespuesta, lunesActual, rangoSemana } from './kpi'
import { fetchAll } from '../../lib/fetchAll'
import './kpi-whatsapp.css'

const SEMANAS = 12

export default function KpiWhatsappPage() {
  const [filas, setFilas] = useState([])
  const [cargando, setCargando] = useState(true)
  const [error, setError] = useState(null)
  const [elegida, setElegida] = useState(null)
  const semanaActual = useMemo(() => lunesActual(), [])

  const cargar = useCallback(async () => {
    setCargando(true)
    setError(null)
    const { data, error: e } = await supabase
      .from('kpi_whatsapp_semanal')
      .select('*')
      .order('semana', { ascending: false })
      .limit(SEMANAS)
    if (e) {
      setError(e.message)
    } else {
      const base = data ?? []
      // "Cayó sin respuesta" no es confirmado: se cuenta aparte (la vista no lo separa).
      const desde = base.length ? base[base.length - 1].semana : null
      let cancelados = null
      if (desde) {
        try {
          cancelados = await fetchAll(() => supabase.from('shopify_pedidos').select('shopify_order_id, creado_en')
            .eq('estado_confirmacion', 'cancelado_sin_respuesta').eq('es_borrador', false)
            .gte('creado_en', `${String(desde).slice(0, 10)}T00:00:00Z`), { columnaOrden: 'shopify_order_id' })
        } catch { cancelados = null }
      }
      const lista = agregarSinRespuesta(base, cancelados)
      setFilas(lista)
      // Por defecto, la última semana cerrada (la que se revisa el lunes).
      setElegida((prev) => prev && lista.some((f) => f.semana === prev)
        ? prev
        : (lista.find((f) => f.semana < semanaActual) ?? lista[0])?.semana ?? null)
    }
    setCargando(false)
  }, [semanaActual])

  useEffect(() => { cargar() }, [cargar])

  const idx = filas.findIndex((f) => f.semana === elegida)
  const fila = idx >= 0 ? filas[idx] : null
  const anterior = idx >= 0 ? filas[idx + 1] ?? null : null

  return (
    <div className="fade-in">
      <div className="page-header">
        <div>
          <h1 className="page-title">KPI WhatsApp</h1>
          <p className="page-subtitle">Semana de lunes a domingo. Pedidos, entrega y recompra por semana del pedido; mensajes, chats y reclamos por semana en que pasaron.</p>
        </div>
        <div className="page-actions">
          <button className="btn btn-ghost btn-sm" onClick={cargar} disabled={cargando}>
            <RefreshCw size={14} className={cargando ? 'spinning' : ''} /> Actualizar
          </button>
        </div>
      </div>

      {error && (
        <div className="alert alert-error" role="alert">
          No se pudieron leer los KPI ({error}). Revisá la conexión y tocá Actualizar; si sigue, falta aplicar la migración 20261006000006 en Supabase.
        </div>
      )}

      {cargando && !filas.length ? (
        <div className="kpi-grid kpi-wa-grid">
          {Array.from({ length: 10 }).map((_, i) => <div key={i} className="skeleton skeleton-kpi" style={{ height: 96 }} />)}
        </div>
      ) : !filas.length && !error ? (
        <div className="empty-state">
          <div className="empty-state-icon"><BarChart3 size={22} /></div>
          <div className="empty-state-title">Todavía no hay semanas para mostrar</div>
          <div className="empty-state-desc">Aparecen solas cuando entran pedidos de Shopify o chats de WhatsApp. Las dos primeras semanas sirven de línea de base.</div>
        </div>
      ) : filas.length ? (
        <>
          <div className="kpi-wa-semanas" role="tablist" aria-label="Elegir semana">
            {filas.map((f) => (
              <button
                key={f.semana}
                role="tab"
                aria-selected={f.semana === elegida}
                className={`chip-choice ${f.semana === elegida ? 'active' : ''}`}
                onClick={() => setElegida(f.semana)}
              >
                {rangoSemana(f.semana)}{f.semana === semanaActual ? ' · en curso' : ''}
              </button>
            ))}
          </div>

          <div className="kpi-wa-seccion">
            <span className="section-label">
              Semana {rangoSemana(elegida)}{elegida === semanaActual ? ' (en curso: los números todavía cambian)' : ''}
            </span>
            <TarjetasKpi fila={fila} anterior={anterior} />
            <p className="kpi-wa-nota">
              Confirmados % = confirmados ÷ todos los pedidos de la semana; los que cayeron sin respuesta cuentan como NO confirmados y se muestran aparte.
              Entregados % = entregados ÷ (entregados + no entregados) de los pedidos creados esa semana: sube a medida que el courier reporta.
              Costos en dólares, como los factura Meta y Anthropic. La IA cuenta desde que exista el vendedor (ola 2).
            </p>
          </div>

          <div className="kpi-wa-seccion">
            <span className="section-label">Últimas {filas.length} semanas</span>
            <TablaSemanas filas={filas} elegida={elegida} onElegir={setElegida} semanaActual={semanaActual} />
          </div>
        </>
      ) : null}
    </div>
  )
}
