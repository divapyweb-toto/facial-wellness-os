// Selector de tienda: Voltra / Facial Wellness / Todas. Va arriba de todas las
// pantallas; al cambiar, la pantalla se vuelve a cargar con los datos de esa tienda.
import { TIENDAS, setTienda, useTienda } from '../../lib/tienda'

export default function SelectorTienda() {
  const actual = useTienda()
  return (
    <div style={{ display: 'flex', alignItems: 'center', gap: 8, padding: '6px 0 10px', flexWrap: 'wrap' }}>
      <span style={{ fontSize: 11, color: 'var(--text-muted)', textTransform: 'uppercase', letterSpacing: '0.06em' }}>Tienda</span>
      <div className="tabs" style={{ marginLeft: 0 }}>
        {TIENDAS.map(t => (
          <button key={t.id} className={`tab ${actual === t.id ? 'active' : ''}`} onClick={() => setTienda(t.id)}>{t.label}</button>
        ))}
      </div>
    </div>
  )
}
