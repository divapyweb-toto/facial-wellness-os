import { Outlet, NavLink, useNavigate } from 'react-router-dom'
import { useAuth } from '../../lib/AuthContext'
import {
  LayoutDashboard, ShoppingCart, Package, Megaphone,
  DollarSign, Truck, FileBarChart2, Settings, LogOut, Shield,
  Users, Calculator, Upload, BarChart3, PackageCheck
} from 'lucide-react'

const navMain = [
  { to: '/dashboard', icon: LayoutDashboard, label: 'Dashboard' },
  { to: '/ventas', icon: ShoppingCart, label: 'Ventas' },
  { to: '/clientes', icon: Users, label: 'Clientes' },
  { to: '/stock', icon: Package, label: 'Stock' },
  { to: '/ads', icon: Megaphone, label: 'Campañas' },
  { to: '/finanzas', icon: DollarSign, label: 'Finanzas' },
  { to: '/rendicion', icon: Truck, label: 'Rendición' },
  { to: '/despacho', icon: PackageCheck, label: 'Despacho' },
]

const navHerramientas = [
  { to: '/analytics', icon: BarChart3, label: 'Analytics' },
  { to: '/calculadora', icon: Calculator, label: 'Calculadora' },
  { to: '/importar', icon: Upload, label: 'Importar' },
  { to: '/reportes', icon: FileBarChart2, label: 'Reportes' },
]

export default function Layout() {
  const { profile, signOut, isAdmin } = useAuth()
  const navigate = useNavigate()

  const handleSignOut = async () => { await signOut(); navigate('/login') }
  const initials = profile?.nombre ? profile.nombre.split(' ').map(n => n[0]).join('').toUpperCase().slice(0, 2) : 'FW'

  return (
    <div className="app-shell">
      <aside className="sidebar">
        <div className="sidebar-logo">
          <div style={{ width: 32, height: 32, background: 'var(--accent)', borderRadius: 7, display: 'flex', alignItems: 'center', justifyContent: 'center', flexShrink: 0 }}>
            <span style={{ fontFamily: 'var(--font-display)', fontWeight: 800, fontSize: 13, color: '#000' }}>FW</span>
          </div>
          <span>Business OS</span>
        </div>
        <nav className="sidebar-nav">
          <span className="nav-section-label">Principal</span>
          {navMain.map(({ to, icon: Icon, label }) => (
            <NavLink key={to} to={to} className={({ isActive }) => `nav-item ${isActive ? 'active' : ''}`}>
              <Icon size={16} /><span>{label}</span>
            </NavLink>
          ))}
          <span className="nav-section-label">Herramientas</span>
          {navHerramientas.map(({ to, icon: Icon, label }) => (
            <NavLink key={to} to={to} className={({ isActive }) => `nav-item ${isActive ? 'active' : ''}`}>
              <Icon size={16} /><span>{label}</span>
            </NavLink>
          ))}
          {isAdmin && (
            <>
              <span className="nav-section-label">Admin</span>
              <NavLink to="/config" className={({ isActive }) => `nav-item ${isActive ? 'active' : ''}`}>
                <Settings size={16} /><span>Configuración</span>
              </NavLink>
            </>
          )}
        </nav>
        <div className="sidebar-footer">
          <div className="user-card">
            <div className="user-avatar">{initials}</div>
            <div className="user-info">
              <div className="user-name">{profile?.nombre || 'Usuario'}</div>
              <div className="user-role" style={{ display: 'flex', alignItems: 'center', gap: 4 }}>
                {isAdmin && <Shield size={9} />}{profile?.rol || 'staff'}
              </div>
            </div>
          </div>
          <button className="nav-item" onClick={handleSignOut} style={{ marginTop: 4, color: 'var(--red)', width: '100%' }}>
            <LogOut size={16} /><span>Cerrar sesión</span>
          </button>
        </div>
      </aside>
      <main className="main-content">
        <div className="page-content"><Outlet /></div>
      </main>
    </div>
  )
}
