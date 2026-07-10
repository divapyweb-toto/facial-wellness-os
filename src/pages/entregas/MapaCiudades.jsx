// src/pages/entregas/MapaCiudades.jsx
// ═══════════════════════════════════════════════════════════
// MAPA DE RENTABILIDAD POR CIUDAD
//
// Dibuja cada ciudad como una burbuja sobre el mapa de Paraguay:
//   · tamaño  = cantidad de pedidos
//   · color   = tasa de entrega (verde llega bien, rojo se devuelve)
// Al tocar una burbuja, muestra la contribución y el detalle.
//
// Usa Leaflet + OpenStreetMap: mapa real, sin API key, sin tarjeta.
// Se usan CircleMarker (círculos SVG), NO los marcadores por defecto de
// Leaflet — así se evita el bug clásico de los íconos rotos en Vite.
// ═══════════════════════════════════════════════════════════
import { MapContainer, TileLayer, CircleMarker, Tooltip, Popup } from 'react-leaflet'
import 'leaflet/dist/leaflet.css'
import { formatGs } from '../../lib/supabase'

// Color según tasa de entrega (mismo criterio que la tabla)
function colorTasa(tasa) {
  if (tasa >= 70) return '#22c55e'
  if (tasa >= 50) return '#eab308'
  return '#ef4444'
}

// Radio en píxeles según pedidos (escala suave para que ninguna tape a las demás)
function radio(pedidos, maxPedidos) {
  const min = 7, max = 26
  if (maxPedidos <= 1) return min
  const t = Math.sqrt(pedidos) / Math.sqrt(maxPedidos) // raíz: el área ~ pedidos
  return Math.round(min + t * (max - min))
}

export default function MapaCiudades({ ciudades }) {
  // Solo las que tienen coordenadas (las no reconocidas no se dibujan)
  const conCoords = (ciudades || []).filter(c => c.lat != null && c.lng != null && c.total > 0)
  if (!conCoords.length) return null

  const maxPedidos = Math.max(...conCoords.map(c => c.total))
  // Centrar el mapa en el promedio ponderado de los pedidos
  const centro = [-25.5, -56.8] // Paraguay, vista general

  return (
    <div className="card" style={{ padding: 0, overflow: 'hidden' }}>
      <div style={{ padding: '14px 20px', borderBottom: '1px solid var(--border)', display: 'flex', alignItems: 'center', gap: 8, flexWrap: 'wrap' }}>
        <span style={{ fontSize: 13, fontWeight: 700 }}>Mapa de pedidos</span>
        <div style={{ display: 'flex', gap: 14, marginLeft: 'auto', fontSize: 11, color: 'var(--text-secondary)', flexWrap: 'wrap' }}>
          <span style={{ display: 'inline-flex', alignItems: 'center', gap: 5 }}><i style={{ width: 10, height: 10, borderRadius: '50%', background: '#22c55e', display: 'inline-block' }} /> Entrega ≥70%</span>
          <span style={{ display: 'inline-flex', alignItems: 'center', gap: 5 }}><i style={{ width: 10, height: 10, borderRadius: '50%', background: '#eab308', display: 'inline-block' }} /> 50–70%</span>
          <span style={{ display: 'inline-flex', alignItems: 'center', gap: 5 }}><i style={{ width: 10, height: 10, borderRadius: '50%', background: '#ef4444', display: 'inline-block' }} /> &lt;50%</span>
          <span style={{ color: 'var(--text-muted)' }}>· tamaño = pedidos</span>
        </div>
      </div>
      <div style={{ height: 460, width: '100%' }}>
        <MapContainer
          center={centro}
          zoom={6}
          style={{ height: '100%', width: '100%', background: '#0e1116' }}
          scrollWheelZoom={false}
        >
          <TileLayer
            attribution='&copy; OpenStreetMap'
            url="https://{s}.basemaps.cartocdn.com/dark_all/{z}/{x}/{y}{r}.png"
          />
          {conCoords.map(c => {
            const color = colorTasa(c.tasaEntrega)
            const negativa = c.contribucionFirme < 0
            return (
              <CircleMarker
                key={c.clave}
                center={[c.lat, c.lng]}
                radius={radio(c.total, maxPedidos)}
                pathOptions={{
                  color: negativa ? '#ef4444' : color,
                  weight: negativa ? 2.5 : 1.5,
                  fillColor: color,
                  fillOpacity: 0.6,
                }}
              >
                <Tooltip direction="top" offset={[0, -4]}>
                  <strong>{c.nombre}</strong> · {c.total} pedidos · {c.tasaEntrega}% entrega
                </Tooltip>
                <Popup>
                  <div style={{ minWidth: 160, fontFamily: 'system-ui' }}>
                    <div style={{ fontWeight: 700, fontSize: 14, marginBottom: 4 }}>{c.nombre}</div>
                    <div style={{ fontSize: 12, lineHeight: 1.7 }}>
                      <div>Pedidos: <strong>{c.total}</strong></div>
                      <div>Entregados: {c.entregados} · Devueltos: {c.devueltos}</div>
                      <div>Tasa de entrega: <strong style={{ color }}>{c.tasaEntrega}%</strong></div>
                      <div style={{ marginTop: 4, paddingTop: 4, borderTop: '1px solid #ddd' }}>
                        Contribución:{' '}
                        <strong style={{ color: negativa ? '#ef4444' : '#22c55e' }}>
                          {formatGs(c.contribucionFirme)}
                        </strong>
                      </div>
                      {c.sangradoFlete > 0 && (
                        <div style={{ color: '#ef4444', fontSize: 11 }}>
                          Sangrado en fletes: {formatGs(c.sangradoFlete)}
                        </div>
                      )}
                    </div>
                  </div>
                </Popup>
              </CircleMarker>
            )
          })}
        </MapContainer>
      </div>
    </div>
  )
}
