// src/components/layout/Layout.jsx
import { Outlet, NavLink, useNavigate, useLocation } from 'react-router-dom'
import { useState } from 'react'
import { useAuth } from '../../lib/AuthContext'
import {
  LayoutDashboard, ShoppingCart, Package, Megaphone,
  DollarSign, Truck, FileBarChart2, Settings, LogOut, Shield,
  Users, Calculator, Upload, BarChart3, PackageCheck, MapPin, X,
  Grid3X3,
} from 'lucide-react'

const navMain = [
  { to: '/dashboard', icon: LayoutDashboard, label: 'Dashboard' },
  { to: '/ventas',    icon: ShoppingCart,    label: 'Ventas'    },
  { to: '/clientes',  icon: Users,           label: 'Clientes'  },
  { to: '/stock',     icon: Package,         label: 'Stock'     },
  { to: '/ads',       icon: Megaphone,       label: 'Campañas'  },
  { to: '/finanzas',  icon: DollarSign,      label: 'Finanzas'  },
  { to: '/rendicion', icon: Truck,           label: 'Rendición' },
  { to: '/despacho',  icon: PackageCheck,    label: 'Despacho'  },
  { to: '/entregas',  icon: MapPin,          label: 'Entregas'  },
]

const navHerramientas = [
  { to: '/analytics',  icon: BarChart3,     label: 'Analytics'   },
  { to: '/calculadora',icon: Calculator,    label: 'Calculadora' },
  { to: '/importar',   icon: Upload,        label: 'Importar'    },
  { to: '/reportes',   icon: FileBarChart2, label: 'Reportes'    },
]

// 4 accesos fijos en bottom nav (los más usados en celular)
const navMovilFijo = [
  { to: '/dashboard', icon: LayoutDashboard, label: 'Inicio'   },
  { to: '/ventas',    icon: ShoppingCart,    label: 'Ventas'   },
  { to: '/entregas',  icon: MapPin,          label: 'Entregas' },
  { to: '/analytics', icon: BarChart3,       label: 'Stats'    },
]

export default function Layout() {
  const { profile, signOut, isAdmin } = useAuth()
  const navigate = useNavigate()
  const location = useLocation()
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
    ...navMain,
    ...navHerramientas,
    ...(isAdmin ? [{ to: '/config', icon: Settings, label: 'Configuración' }] : []),
  ]

  return (
    <div className="app-shell">

      {/* ══════════════════════════════════════════════
          SIDEBAR — desktop / tablet
      ══════════════════════════════════════════════ */}
      <aside className="sidebar">

        {/* Logo */}
        <div className="sidebar-logo">
          <div className="sidebar-logo-mark">
            <span>FW</span>
          </div>
          <span>Business OS</span>
        </div>

        {/* Navigation */}
        <nav className="sidebar-nav">
          <span className="nav-section-label">Principal</span>
          {navMain.map(({ to, icon: Icon, label }) => (
            <NavLink
              key={to}
              to={to}
              className={({ isActive }) => `nav-item${isActive ? ' active' : ''}`}
            >
              <Icon size={16} /><span>{label}</span>
            </NavLink>
          ))}

          <span className="nav-section-label">Herramientas</span>
          {navHerramientas.map(({ to, icon: Icon, label }) => (
            <NavLink
              key={to}
              to={to}
              className={({ isActive }) => `nav-item${isActive ? ' active' : ''}`}
            >
              <Icon size={16} /><span>{label}</span>
            </NavLink>
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

      {/* ══════════════════════════════════════════════
          BOTTOM NAV — solo móvil
      ══════════════════════════════════════════════ */}
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

      {/* ══════════════════════════════════════════════
          BOTTOM SHEET "Más" — solo móvil
      ══════════════════════════════════════════════ */}
      {masAbierto && (
        <div
          className="mobile-more-overlay"
          onClick={() => setMasAbierto(false)}
        >
          <div
            className="mobile-more-sheet"
            onClick={e => e.stopPropagation()}
          >
            {/* Drag handle */}
            <div className="mobile-more-handle" />

            {/* Header */}
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
              <button
                className="mobile-more-close"
                onClick={() => setMasAbierto(false)}
              >
                <X size={18} />
              </button>
            </div>

            {/* All modules grid */}
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

            {/* Logout */}
            <button className="mobile-more-logout" onClick={handleSignOut}>
              <LogOut size={15} />
              <span>Cerrar sesión</span>
            </button>
          </div>
        </div>
      )}

      {/* ══════════════════════════════════════════════
          MAIN CONTENT — con page transition
      ══════════════════════════════════════════════ */}
      <main className="main-content">
        {/*
          key={location.pathname} → React remounts on route change
          → triggers .page-enter CSS animation on every navigation
        */}
        <div
          key={location.pathname}
          className="page-content page-enter"
        >
          <Outlet />
        </div>
      </main>
    </div>
  )
}
