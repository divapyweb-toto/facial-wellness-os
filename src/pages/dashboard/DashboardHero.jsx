// src/pages/dashboard/DashboardHero.jsx
// ═══════════════════════════════════════════════════════════
// EL HERO: "¿cómo va el negocio HOY?" en 3 segundos.
//
// Lo primero que se ve al abrir el sistema. Cuatro números y nada más:
// ventas de hoy, tasa de entrega de la semana, plata en la calle, alertas.
// Abajo, las tres tareas de todos los días a un tap.
//
// Es un componente PURO: recibe los números ya calculados por DashboardPage
// a partir de datos que la página ya traía — cero consultas propias.
// `pendiente` marca los números que todavía están llegando (primera carga):
// se muestra "…" en vez de un 0 que parecería real.
// ═══════════════════════════════════════════════════════════
import { useNavigate } from 'react-router-dom'
import { formatGs } from '../../lib/supabase'
import { Plus, PackageCheck, Search, AlertTriangle } from 'lucide-react'
import { textoEsperada, textoRango, textoFuente, colorTasa as colorTasaReal } from '../../lib/tasaEntrega'

const fechaLarga = () => {
  const f = new Date().toLocaleDateString('es-PY', { weekday: 'long', day: 'numeric', month: 'long' })
  return f.charAt(0).toUpperCase() + f.slice(1)
}

// tasa7dReal (12-10): resultado de tasaEntregaRealista. Se muestra "~esperada"
// y el rango con lo en camino; con pocos resueltos el color es neutro (antes
// 4 de 4 resueltos daba "100%" verde). tasa7d/resueltos7d quedan de respaldo.
export default function DashboardHero({ nombre, hoyCount, hoyMonto, tasa7d, resueltos7d, tasa7dReal = null, enCalleCount, enCalleMonto, alertasCount, pendiente = {} }) {
  const navigate = useNavigate()
  const colorTasa = tasa7dReal ? colorTasaReal(tasa7dReal, { verde: 60, amarillo: 40 })
    : tasa7d == null ? 'var(--text-secondary)'
    : tasa7d >= 0.6 ? 'var(--green)' : tasa7d >= 0.4 ? 'var(--yellow)' : 'var(--red)'

  return (
    <div style={{ display: 'flex', flexDirection: 'column', gap: 10 }}>
      <div className="hero">
        <div className="hero-fecha">{fechaLarga()}</div>
        <div className="hero-big">
          Hola {nombre} — hoy: <em>{hoyCount} {hoyCount === 1 ? 'venta' : 'ventas'}</em>
        </div>
        <div className="hero-sub">
          {hoyCount > 0 ? `${formatGs(hoyMonto)} generados hoy` : 'Todavía no entró ninguna venta hoy'}
        </div>
        <div className="hero-stats">
          <div className="hero-stat">
            <span>Entrega 7d</span>
            <b style={{ color: colorTasa }}>
              {pendiente.tasa ? '…' : tasa7dReal ? textoEsperada(tasa7dReal) : tasa7d == null ? '—' : `${Math.round(tasa7d * 100)}%`}
            </b>
            <span style={{ textTransform: 'none', letterSpacing: 0 }} title={tasa7dReal ? textoFuente(tasa7dReal) : undefined}>
              {pendiente.tasa ? 'cargando' : tasa7dReal ? textoRango(tasa7dReal) : resueltos7d ? `${resueltos7d} resueltos` : 'sin resueltos aún'}
            </span>
          </div>
          <div className="hero-stat">
            <span>En la calle</span>
            <b style={{ color: enCalleCount ? 'var(--yellow)' : 'var(--text-primary)' }}>{pendiente.enCalle ? '…' : enCalleCount}</b>
            <span style={{ textTransform: 'none', letterSpacing: 0 }}>{pendiente.enCalle ? 'cargando' : formatGs(enCalleMonto)}</span>
          </div>
          <div className="hero-stat">
            <span>Alertas</span>
            <b style={{ color: pendiente.alertas ? 'var(--text-secondary)' : alertasCount ? 'var(--red)' : 'var(--green)' }}>
              {pendiente.alertas ? '…' : alertasCount || 'Sin alertas'}
            </b>
            {!pendiente.alertas && alertasCount > 0 && (
              <span style={{ textTransform: 'none', letterSpacing: 0, display: 'inline-flex', alignItems: 'center', gap: 3 }}>
                <AlertTriangle size={9} /> revisar abajo
              </span>
            )}
          </div>
        </div>
      </div>

      {/* Las 3 tareas de todos los días. Navegan a la pantalla ya existente. */}
      <div className="quick-actions">
        <button className="quick-action" onClick={() => navigate('/ventas?nueva=1')}>
          <Plus size={20} /> Cargar venta
        </button>
        <button className="quick-action" onClick={() => navigate('/despacho')}>
          <PackageCheck size={20} /> Despachar
        </button>
        <button className="quick-action" onClick={() => navigate('/reclamos')}>
          <Search size={20} /> Buscar pedido
        </button>
      </div>
    </div>
  )
}
