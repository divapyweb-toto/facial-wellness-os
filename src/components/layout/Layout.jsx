// src/components/layout/Layout.jsx
import { Outlet, NavLink, useNavigate, useLocation } from 'react-router-dom'
import { useState, useEffect } from 'react'
import BusquedaGlobal from './BusquedaGlobal'
import SelectorTienda from './SelectorTienda'
import { useTienda } from '../../lib/tienda'
import { useAuth } from '../../lib/AuthContext'
import {
  LayoutDashboard, ShoppingCart, Package, Megaphone,
  DollarSign, Truck, FileBarChart2, Settings, LogOut, Shield,
  Users, Calculator, BarChart3, PackageCheck, MapPin, X, MessageCircle,
  Grid3X3, Search as SearchIcon, Repeat, PackageOpen, ClipboardCheck, Link2, Inbox, Receipt, Store,
} from 'lucide-react'

// ── Logo embebido (PNG transparente, negro → invertir con CSS) ──
import LOGO_SRC from '../../assets/marca/voltra-logo-blanco.png'
import ICONO_SRC from '../../assets/marca/voltra-icono.png'

// ── Navegación agrupada por función (claridad nivel empresa) ──
const navPrincipal = [
  { to: '/dashboard', icon: LayoutDashboard, label: 'Dashboard' },
  { to: '/ventas',    icon: ShoppingCart,    label: 'Ventas'    },
  { to: '/pedido-mayorista', icon: Store,    label: 'Pedido mayorista' },
  { to: '/clientes',  icon: Users,           label: 'Clientes'  },
  { to: '/bandeja',   icon: Inbox,           label: 'Bandeja WhatsApp' },
  { to: '/kpi-whatsapp', icon: BarChart3,    label: 'KPI WhatsApp' },
  { to: '/stock',     icon: Package,         label: 'Stock'     },
]
const navLogistica = [
  { to: '/despacho',  icon: PackageCheck,    label: 'Despacho'  },
  { to: '/entregas',  icon: MapPin,          label: 'Entregas'  },
  { to: '/inteligencia', icon: BarChart3,    label: 'Inteligencia' },
  { to: '/seguimiento', icon: MessageCircle, label: 'Seguimiento' },
  { to: '/reclamos',  icon: ClipboardCheck,   label: 'Reclamos'  },
  { to: '/vinculos',  icon: Link2,           label: 'Vínculos'  },
  { to: '/recepcion', icon: PackageOpen,     label: 'Recepción' },
  { to: '/rendicion', icon: Truck,           label: 'Rendición' },
]
const navDinero = [
  { to: '/finanzas',  icon: DollarSign,      label: 'Gastos'    },
  { to: '/ads',       icon: Megaphone,       label: 'Campañas'  },
  { to: '/recompra',  icon: Repeat,          label: 'Recompra'  },
  { to: '/reportes',  icon: FileBarChart2,   label: 'Reportes'  },
  { to: '/facturas',  icon: Receipt,         label: 'Facturas'  },
]
const navHerramientas = [
  { to: '/calculadora', icon: Calculator,    label: 'Calculadora' },
]
// Barra fija del celular: las 3 tareas de TODOS los días + inicio.
// Cargar venta, despachar y buscar un pedido para un reclamo son el 90% del
// uso móvil; Entregas y Reportes (consulta, no operación) viven en «Más».
// Antes Reclamos estaba enterrado ahí: 3 taps con un cliente esperando.
const navMovilFijo = [
  { to: '/dashboard', icon: LayoutDashboard, label: 'Inicio'   },
  { to: '/ventas',    icon: ShoppingCart,    label: 'Ventas'   },
  { to: '/despacho',  icon: PackageCheck,    label: 'Despacho' },
  { to: '/reclamos',  icon: SearchIcon,      label: 'Reclamos' },
]

export default function Layout() {
  const { profile, signOut, isAdmin } = useAuth()
  const navigate  = useNavigate()
  const location  = useLocation()
  const [masAbierto, setMasAbierto] = useState(false)
  const tienda = useTienda()

  const handleSignOut = async () => {
    setMasAbierto(false)
    await signOut()
    navigate('/login')
  }

  // ── Atajos de teclado (MacBook = 80% del uso) ──
  // N = nueva venta · B = buscar pedido · D = despacho. Solo con el foco
  // fuera de un campo de texto y sin modificadores (⌘K ya vive en la
  // búsqueda global). Los hints aparecen al lado de cada ítem del menú.
  useEffect(() => {
    const onKey = (e) => {
      if (e.metaKey || e.ctrlKey || e.altKey) return
      const t = e.target
      if (t && (t.tagName === 'INPUT' || t.tagName === 'TEXTAREA' || t.tagName === 'SELECT' || t.isContentEditable)) return
      const k = e.key.toLowerCase()
      if (k === 'n') { e.preventDefault(); navigate('/ventas?nueva=1') }
      else if (k === 'b') { e.preventDefault(); navigate('/reclamos') }
      else if (k === 'd') { e.preventDefault(); navigate('/despacho') }
    }
    window.addEventListener('keydown', onKey)
    return () => window.removeEventListener('keydown', onKey)
  }, [navigate])

  const initials = profile?.nombre
    ? profile.nombre.split(' ').map(n => n[0]).join('').toUpperCase().slice(0, 2)
    : 'FW'

  const todosLosItems = [
    ...navPrincipal,
    ...navLogistica,
    ...navDinero,
    ...navHerramientas,
    ...(isAdmin ? [
      { to: '/config', icon: Settings, label: 'Configuración' },
      { to: '/sistema', icon: Shield, label: 'Sistema' },
    ] : []),
  ]

  return (
    <div className="app-shell">

      {/* ════════════════════════════════════════════
          SIDEBAR — desktop / tablet
      ════════════════════════════════════════════ */}
      <aside className="sidebar">

        {/* Logo area */}
        <div className="sidebar-logo">
          {/* Full logo — visible en sidebar expandido */}
          <img
            src={LOGO_SRC}
            className="sidebar-logo-full"
            alt="Voltra"
            draggable={false}
          />
          {/* Ícono Voltra — visible en sidebar colapsado (tablet) */}
          <div className="sidebar-logo-mark" style={{ overflow: 'hidden' }}>
            <img src={ICONO_SRC} alt="Voltra" draggable={false} style={{ width: '100%', height: '100%', display: 'block' }} />
          </div>
        </div>

        {/* Botón de búsqueda global */}
        <button
          className="sidebar-search-btn"
          onClick={() => window.dispatchEvent(new CustomEvent('abrir-busqueda'))}
          title="Buscar (⌘K)"
        >
          <SearchIcon size={15} />
          <span className="sidebar-search-text">Buscar...</span>
          <span className="sidebar-search-kbd">⌘K</span>
        </button>

        {/* Nav links */}
        <nav className="sidebar-nav">
          {[
            ['Principal', navPrincipal],
            ['Logística', navLogistica],
            ['Dinero', navDinero],
            ['Herramientas', navHerramientas],
          ].map(([titulo, items]) => (
            <div key={titulo}>
              <span className="nav-section-label">{titulo}</span>
              {items.map(({ to, icon: Icon, label }) => (
                <NavLink
                  key={to}
                  to={to}
                  className={({ isActive }) => `nav-item${isActive ? ' active' : ''}`}
                >
                  <Icon size={16} /><span>{label}</span>
                  {/* Hint del atajo de teclado (V/B/D navegan; N abre venta nueva) */}
                  {to === '/ventas' && <kbd className="nav-kbd">N</kbd>}
                  {to === '/reclamos' && <kbd className="nav-kbd">B</kbd>}
                  {to === '/despacho' && <kbd className="nav-kbd">D</kbd>}
                </NavLink>
              ))}
            </div>
          ))}

          {isAdmin && (
            <>
              <span className="nav-section-label">Admin</span>
              <NavLink
                to="/config"
                className={({ isActive }) => `nav-item${isActive ? ' active' : ''}`}
              >
                <Settings size={16} /><span>Configuración</span>
              </NavLink>
              <NavLink
                to="/sistema"
                className={({ isActive }) => `nav-item${isActive ? ' active' : ''}`}
              >
                <Shield size={16} /><span>Sistema</span>
              </NavLink>
            </>
          )}
        </nav>

        {/* Footer */}
        <div className="sidebar-footer">
          {/* Sello de build: permite saber de un vistazo QUÉ versión está
              corriendo el navegador. Sin esto, cuando algo no aparece no hay
              forma de distinguir "no se desplegó" de "el navegador tiene una
              versión vieja en memoria". __BUILD_ID__ lo reemplaza Vite en cada
              compilación con la fecha y hora reales. */}
          <div style={{ fontSize: 9, color: 'var(--text-muted)', textAlign: 'center', padding: '2px 0 6px', opacity: 0.7 }}>
            build {__BUILD_ID__}
          </div>
          <div className="user-card">
            <div className="user-avatar">{initials}</div>
            <div className="user-info">
              <div className="user-name">{profile?.nombre || 'Usuario'}</div>
              <div className="user-role" style={{ display: 'flex', alignItems: 'center', gap: 4 }}>
                {isAdmin && <Shield size={9} />}
                {profile?.rol || 'staff'}
              </div>
            </div>
          </div>
          <button
            className="nav-item"
            onClick={handleSignOut}
            style={{ marginTop: 4, color: 'var(--red)', width: '100%' }}
          >
            <LogOut size={16} /><span>Cerrar sesión</span>
          </button>
        </div>
      </aside>

      {/* ════════════════════════════════════════════
          BOTTOM NAV — solo móvil
      ════════════════════════════════════════════ */}
      <nav className="mobile-nav">
        {navMovilFijo.map(({ to, icon: Icon, label }) => (
          <NavLink
            key={to}
            to={to}
            className={({ isActive }) => `mobile-nav-item${isActive ? ' active' : ''}`}
          >
            <Icon size={22} />
            <span>{label}</span>
          </NavLink>
        ))}
        <button
          className={`mobile-nav-item${masAbierto ? ' active' : ''}`}
          onClick={() => setMasAbierto(true)}
        >
          <Grid3X3 size={22} />
          <span>Más</span>
        </button>
      </nav>

      {/* ════════════════════════════════════════════
          BOTTOM SHEET "Más" — solo móvil
      ════════════════════════════════════════════ */}
      {masAbierto && (
        <div
          className="mobile-more-overlay"
          onClick={() => setMasAbierto(false)}
        >
          <div
            className="mobile-more-sheet"
            onClick={e => e.stopPropagation()}
          >
            <div className="mobile-more-handle" />

            {/* Logo en el sheet */}
            <img
              src={LOGO_SRC}
              className="mobile-sheet-logo"
              alt="Voltra"
              draggable={false}
            />

            {/* User + close */}
            <div className="mobile-more-header">
              <div className="user-card" style={{ margin: 0, padding: '6px 10px' }}>
                <div className="user-avatar">{initials}</div>
                <div className="user-info">
                  <div className="user-name">{profile?.nombre || 'Usuario'}</div>
                  <div className="user-role" style={{ display: 'flex', alignItems: 'center', gap: 4 }}>
                    {isAdmin && <Shield size={9} />}
                    {profile?.rol || 'staff'}
                  </div>
                </div>
              </div>
              <button className="mobile-more-close" onClick={() => setMasAbierto(false)}>
                <X size={18} />
              </button>
            </div>

            {/* Módulos */}
            <div className="mobile-more-grid">
              {todosLosItems.map(({ to, icon: Icon, label }) => (
                <NavLink
                  key={to}
                  to={to}
                  onClick={() => setMasAbierto(false)}
                  className={({ isActive }) => `mobile-more-item${isActive ? ' active' : ''}`}
                >
                  <Icon size={22} />
                  <span>{label}</span>
                </NavLink>
              ))}
            </div>

            <button className="mobile-more-logout" onClick={handleSignOut}>
              <LogOut size={15} />
              <span>Cerrar sesión</span>
            </button>
          </div>
        </div>
      )}

      {/* ════════════════════════════════════════════
          MAIN CONTENT — page transition por ruta
      ════════════════════════════════════════════ */}
      <main className="main-content">
        <div key={location.pathname} className="page-content page-enter">
          <SelectorTienda />
          <div className="page-enter" key={`${location.pathname}:${tienda}`}><Outlet /></div>
        </div>
      </main>

      {/* Búsqueda global — se abre con ⌘K / Ctrl+K */}
      <BusquedaGlobal />
    </div>
  )
}
