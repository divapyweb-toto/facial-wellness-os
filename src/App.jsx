import { Routes, Route, Navigate } from 'react-router-dom'
import { useAuth } from './lib/AuthContext'
import { ToastProvider } from './lib/toast'
import Layout from './components/layout/Layout'
import LoginPage from './pages/auth/LoginPage'
import DashboardPage from './pages/dashboard/DashboardPage'
import VentasPage from './pages/ventas/VentasPage'
import StockPage from './pages/stock/StockPage'
import AdsPage from './pages/ads/AdsPage'
import FinanzasPage from './pages/finanzas/FinanzasPage'
import RendicionPage from './pages/rendicion/RendicionPage'
import ReportesPage from './pages/reportes/ReportesPage'
import ConfigPage from './pages/config/ConfigPage'
import ClientesPage from './pages/clientes/ClientesPage'
import CalculadoraPage from './pages/calculadora/CalculadoraPage'
import ImportarPage from './pages/importar/ImportarPage'
import AnalyticsPage from './pages/analytics/AnalyticsPage'
import DespachoPagina from './pages/despacho/DespachoPagina'
import EntregasPage from './pages/entregas/EntregasPage'
import SistemaPage from './pages/sistema/SistemaPage'

function PrivateRoute({ children }) {
  const { user, loading } = useAuth()
  if (loading) return (
    <div style={{ display: 'flex', alignItems: 'center', justifyContent: 'center', height: '100vh', background: 'var(--bg-base)' }}>
      <div style={{ display: 'flex', flexDirection: 'column', alignItems: 'center', gap: 16 }}>
        <div style={{ width: 36, height: 36, border: '3px solid var(--border)', borderTopColor: 'var(--accent)', borderRadius: '50%' }} className="spinning" />
        <span style={{ color: 'var(--text-muted)', fontSize: 13 }}>Cargando...</span>
      </div>
    </div>
  )
  return user ? children : <Navigate to="/login" replace />
}

export default function App() {
  return (
    <ToastProvider>
      <Routes>
        <Route path="/login" element={<LoginPage />} />
        <Route path="/" element={<PrivateRoute><Layout /></PrivateRoute>}>
          <Route index element={<Navigate to="/dashboard" replace />} />
          <Route path="dashboard" element={<DashboardPage />} />
          <Route path="ventas" element={<VentasPage />} />
          <Route path="clientes" element={<ClientesPage />} />
          <Route path="stock" element={<StockPage />} />
          <Route path="ads" element={<AdsPage />} />
          <Route path="finanzas" element={<FinanzasPage />} />
          <Route path="rendicion" element={<RendicionPage />} />
          <Route path="despacho" element={<DespachoPagina />} />
          <Route path="entregas" element={<EntregasPage />} />
          <Route path="analytics" element={<AnalyticsPage />} />
          <Route path="calculadora" element={<CalculadoraPage />} />
          <Route path="importar" element={<ImportarPage />} />
          <Route path="reportes" element={<ReportesPage />} />
          <Route path="config" element={<ConfigPage />} />
          <Route path="sistema" element={<SistemaPage />} />
        </Route>
        <Route path="*" element={<Navigate to="/dashboard" replace />} />
      </Routes>
    </ToastProvider>
  )
}
