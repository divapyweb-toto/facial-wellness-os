// src/components/layout/Layout.jsx
import { Outlet, NavLink, useNavigate, useLocation } from 'react-router-dom'
import { useState } from 'react'
import BusquedaGlobal from './BusquedaGlobal'
import { useAuth } from '../../lib/AuthContext'
import {
  LayoutDashboard, ShoppingCart, Package, Megaphone,
  DollarSign, Truck, FileBarChart2, Settings, LogOut, Shield,
  Users, Calculator, Upload, BarChart3, PackageCheck, MapPin, X,
  Grid3X3, Search as SearchIcon,
} from 'lucide-react'

// ── Logo embebido (PNG transparente, negro → invertir con CSS) ──
const LOGO_SRC = 'data:image/png;base64,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'

// ── Navegación agrupada por función (claridad nivel empresa) ──
const navPrincipal = [
  { to: '/dashboard', icon: LayoutDashboard, label: 'Dashboard' },
  { to: '/ventas',    icon: ShoppingCart,    label: 'Ventas'    },
  { to: '/clientes',  icon: Users,           label: 'Clientes'  },
  { to: '/stock',     icon: Package,         label: 'Stock'     },
]
const navLogistica = [
  { to: '/despacho',  icon: PackageCheck,    label: 'Despacho'  },
  { to: '/entregas',  icon: MapPin,          label: 'Entregas'  },
  { to: '/rendicion', icon: Truck,           label: 'Rendición' },
]
const navDinero = [
  { to: '/finanzas',  icon: DollarSign,      label: 'Gastos'    },
  { to: '/ads',       icon: Megaphone,       label: 'Campañas'  },
  { to: '/reportes',  icon: FileBarChart2,   label: 'Reportes'  },
]
const navHerramientas = [
  { to: '/calculadora', icon: Calculator,    label: 'Calculadora' },
  { to: '/importar',    icon: Upload,        label: 'Importar'    },
]
const navMovilFijo = [
  { to: '/dashboard', icon: LayoutDashboard, label: 'Inicio'   },
  { to: '/ventas',    icon: ShoppingCart,    label: 'Ventas'   },
  { to: '/entregas',  icon: MapPin,          label: 'Entregas' },
  { to: '/reportes',  icon: FileBarChart2,   label: 'Reportes' },
]

export default function Layout() {
  const { profile, signOut, isAdmin } = useAuth()
  const navigate  = useNavigate()
  const location  = useLocation()
  const [masAbierto, setMasAbierto] = useState(false)

  const handleSignOut = async () => {
    setMasAbierto(false)
    await signOut()
    navigate('/login')
  }

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
            alt="Facial Wellness"
            draggable={false}
          />
          {/* FW mark — visible en sidebar colapsado (tablet) */}
          <div className="sidebar-logo-mark">
            <span>FW</span>
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
              alt="Facial Wellness"
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
          <Outlet />
        </div>
      </main>

      {/* Búsqueda global — se abre con ⌘K / Ctrl+K */}
      <BusquedaGlobal />
    </div>
  )
}
