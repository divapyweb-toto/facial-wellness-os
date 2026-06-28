// src/components/layout/BusquedaGlobal.jsx
// ═══════════════════════════════════════════════════════════
// Búsqueda global / salto rápido. Se abre con Cmd+K (o Ctrl+K).
// Busca secciones de la app y, si escribís algo, ventas y clientes
// por nombre/referencia/teléfono.
// ═══════════════════════════════════════════════════════════
import { useState, useEffect, useRef, useCallback } from 'react'
import { useNavigate } from 'react-router-dom'
import { supabase } from '../../lib/supabase'
import { Search, X, ShoppingCart, Users, Package, DollarSign, BarChart3, Truck, Megaphone, LayoutDashboard, Calculator, Upload, FileBarChart2, MapPin, Settings, Shield, CornerDownLeft } from 'lucide-react'

// Secciones navegables (con sus iconos y palabras clave)
const SECCIONES = [
  { to: '/dashboard', label: 'Dashboard', icon: LayoutDashboard, keys: 'inicio resumen home panel' },
  { to: '/ventas', label: 'Ventas', icon: ShoppingCart, keys: 'pedidos ordenes vender' },
  { to: '/clientes', label: 'Clientes', icon: Users, keys: 'compradores contactos' },
  { to: '/stock', label: 'Stock', icon: Package, keys: 'inventario productos existencias reposicion' },
  { to: '/ads', label: 'Campañas', icon: Megaphone, keys: 'publicidad meta ads marketing' },
  { to: '/finanzas', label: 'Finanzas', icon: DollarSign, keys: 'gastos dinero plata costos' },
  { to: '/rendicion', label: 'Rendición', icon: Truck, keys: 'pap punto a punto cobros' },
  { to: '/despacho', label: 'Despacho', icon: Package, keys: 'envios preparar paquetes' },
  { to: '/entregas', label: 'Entregas', icon: MapPin, keys: 'mapa zonas reparto' },
  { to: '/analytics', label: 'Analytics', icon: BarChart3, keys: 'estadisticas graficos metricas' },
  { to: '/calculadora', label: 'Calculadora', icon: Calculator, keys: 'roas margen breakeven' },
  { to: '/importar', label: 'Importar', icon: Upload, keys: 'csv shopify subir datos' },
  { to: '/reportes', label: 'Reportes', icon: FileBarChart2, keys: 'informes pdf exportar' },
  { to: '/config', label: 'Configuración', icon: Settings, keys: 'ajustes productos precios usuarios admin' },
  { to: '/sistema', label: 'Sistema', icon: Shield, keys: 'papelera errores auditoria borrados admin' },
]

export default function BusquedaGlobal() {
  const navigate = useNavigate()
  const [abierto, setAbierto] = useState(false)
  const [query, setQuery] = useState('')
  const [resultadosDB, setResultadosDB] = useState([])
  const [idx, setIdx] = useState(0)
  const inputRef = useRef(null)
  const debounceRef = useRef(null)

  // Atajo Cmd+K / Ctrl+K para abrir, Esc para cerrar
  useEffect(() => {
    const onKey = (e) => {
      if ((e.metaKey || e.ctrlKey) && e.key.toLowerCase() === 'k') {
        e.preventDefault()
        setAbierto(a => !a)
      } else if (e.key === 'Escape') {
        setAbierto(false)
      }
    }
    const onAbrir = () => setAbierto(true)
    window.addEventListener('keydown', onKey)
    window.addEventListener('abrir-busqueda', onAbrir)
    return () => {
      window.removeEventListener('keydown', onKey)
      window.removeEventListener('abrir-busqueda', onAbrir)
    }
  }, [])

  // Focus al abrir
  useEffect(() => {
    if (abierto) { setQuery(''); setResultadosDB([]); setIdx(0); setTimeout(() => inputRef.current?.focus(), 50) }
  }, [abierto])

  // Secciones que matchean el query
  const q = query.trim().toLowerCase()
  const seccionesFiltradas = q
    ? SECCIONES.filter(s => s.label.toLowerCase().includes(q) || s.keys.includes(q))
    : SECCIONES.slice(0, 6)

  // Buscar en ventas y clientes (con debounce)
  useEffect(() => {
    if (!q || q.length < 2) { setResultadosDB([]); return }
    if (debounceRef.current) clearTimeout(debounceRef.current)
    debounceRef.current = setTimeout(async () => {
      try {
        const { data: ventas } = await supabase
          .from('ventas').select('id, n_referencia, producto_nombre, cliente_nombre, cliente_telefono, total')
          .is('deleted_at', null)
          .or(`producto_nombre.ilike.%${q}%,n_referencia.ilike.%${q}%,cliente_nombre.ilike.%${q}%,cliente_telefono.ilike.%${q}%`)
          .limit(5)
        const res = (ventas || []).map(v => ({
          tipo: 'venta', id: v.id,
          titulo: `${v.cliente_nombre || 'Cliente'} · ${v.producto_nombre || ''}`,
          sub: `#${v.n_referencia || '—'}${v.cliente_telefono ? ' · ' + v.cliente_telefono : ''}`,
          to: '/ventas',
        }))
        setResultadosDB(res)
      } catch (e) { setResultadosDB([]) }
    }, 250)
    return () => { if (debounceRef.current) clearTimeout(debounceRef.current) }
  }, [q])

  // Lista combinada para navegar con teclado
  const items = [
    ...seccionesFiltradas.map(s => ({ kind: 'seccion', ...s })),
    ...resultadosDB.map(r => ({ kind: 'db', ...r })),
  ]

  const irA = useCallback((item) => {
    setAbierto(false)
    navigate(item.to)
  }, [navigate])

  const onInputKey = (e) => {
    if (e.key === 'ArrowDown') { e.preventDefault(); setIdx(i => Math.min(items.length - 1, i + 1)) }
    else if (e.key === 'ArrowUp') { e.preventDefault(); setIdx(i => Math.max(0, i - 1)) }
    else if (e.key === 'Enter') { e.preventDefault(); if (items[idx]) irA(items[idx]) }
  }

  if (!abierto) return null

  return (
    <div
      onClick={(e) => e.target === e.currentTarget && setAbierto(false)}
      style={{ position: 'fixed', inset: 0, background: 'rgba(0,0,0,0.6)', backdropFilter: 'blur(4px)', zIndex: 1000, display: 'flex', alignItems: 'flex-start', justifyContent: 'center', paddingTop: '12vh', animation: 'fadeIn 0.15s ease' }}
    >
      <div style={{ width: '90%', maxWidth: 560, background: 'var(--bg-card)', border: '1px solid var(--border)', borderRadius: 14, overflow: 'hidden', boxShadow: '0 20px 60px rgba(0,0,0,0.5)', animation: 'scaleIn 0.18s ease' }}>
        {/* Input */}
        <div style={{ display: 'flex', alignItems: 'center', gap: 10, padding: '14px 16px', borderBottom: '1px solid var(--border-subtle)' }}>
          <Search size={18} color="var(--text-muted)" />
          <input
            ref={inputRef}
            value={query}
            onChange={(e) => { setQuery(e.target.value); setIdx(0) }}
            onKeyDown={onInputKey}
            placeholder="Buscar sección, venta, cliente..."
            style={{ flex: 1, background: 'transparent', border: 'none', outline: 'none', color: 'var(--text-primary)', fontSize: 15 }}
          />
          <button onClick={() => setAbierto(false)} style={{ background: 'var(--bg-hover)', border: 'none', borderRadius: 6, padding: '2px 6px', color: 'var(--text-muted)', cursor: 'pointer', fontSize: 11 }}>Esc</button>
        </div>

        {/* Resultados */}
        <div style={{ maxHeight: '50vh', overflowY: 'auto', padding: 8 }}>
          {items.length === 0 ? (
            <div style={{ padding: '24px 16px', textAlign: 'center', color: 'var(--text-muted)', fontSize: 13 }}>
              Sin resultados para "{query}"
            </div>
          ) : (
            <>
              {seccionesFiltradas.length > 0 && (
                <div style={{ fontSize: 10, color: 'var(--text-muted)', textTransform: 'uppercase', padding: '6px 10px', letterSpacing: 0.5 }}>Secciones</div>
              )}
              {items.map((item, i) => {
                const activo = i === idx
                const Icon = item.kind === 'seccion' ? item.icon : (item.tipo === 'venta' ? ShoppingCart : Users)
                const esPrimerDB = item.kind === 'db' && items[i - 1]?.kind === 'seccion'
                return (
                  <div key={`${item.kind}-${item.to}-${item.id || item.label}-${i}`}>
                    {esPrimerDB && <div style={{ fontSize: 10, color: 'var(--text-muted)', textTransform: 'uppercase', padding: '8px 10px 6px', letterSpacing: 0.5 }}>Resultados</div>}
                    <div
                      onClick={() => irA(item)}
                      onMouseEnter={() => setIdx(i)}
                      style={{ display: 'flex', alignItems: 'center', gap: 12, padding: '10px 12px', borderRadius: 8, cursor: 'pointer', background: activo ? 'var(--bg-hover)' : 'transparent', transition: 'background 0.1s' }}
                    >
                      <Icon size={16} color={activo ? 'var(--accent)' : 'var(--text-muted)'} />
                      <div style={{ flex: 1, minWidth: 0 }}>
                        <div style={{ fontSize: 13, fontWeight: 500, color: 'var(--text-primary)', overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap' }}>
                          {item.kind === 'seccion' ? item.label : item.titulo}
                        </div>
                        {item.kind === 'db' && <div style={{ fontSize: 11, color: 'var(--text-muted)' }}>{item.sub}</div>}
                      </div>
                      {activo && <CornerDownLeft size={13} color="var(--text-muted)" />}
                    </div>
                  </div>
                )
              })}
            </>
          )}
        </div>

        {/* Footer hint */}
        <div style={{ display: 'flex', gap: 14, padding: '8px 16px', borderTop: '1px solid var(--border-subtle)', fontSize: 10, color: 'var(--text-muted)' }}>
          <span>↑↓ navegar</span>
          <span>↵ abrir</span>
          <span>⌘K abrir/cerrar</span>
        </div>
      </div>
    </div>
  )
}
