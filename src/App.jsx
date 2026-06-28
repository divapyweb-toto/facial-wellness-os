import { Routes, Route, Navigate } from 'react-router-dom'
import { lazy, Suspense } from 'react'
import { useAuth } from './lib/AuthContext'
import { ToastProvider } from './lib/toast'
import Layout from './components/layout/Layout'
import LoginPage from './pages/auth/LoginPage'
// Páginas más usadas: carga directa (inicio instantáneo)
import DashboardPage from './pages/dashboard/DashboardPage'
import VentasPage from './pages/ventas/VentasPage'
// Resto: carga diferida (se baja solo al abrir cada sección) → bundle inicial más liviano
const StockPage = lazy(() => import('./pages/stock/StockPage'))
const AdsPage = lazy(() => import('./pages/ads/AdsPage'))
const FinanzasPage = lazy(() => import('./pages/finanzas/FinanzasPage'))
const RendicionPage = lazy(() => import('./pages/rendicion/RendicionPage'))
const ReportesPage = lazy(() => import('./pages/reportes/ReportesPage'))
const ConfigPage = lazy(() => import('./pages/config/ConfigPage'))
const ClientesPage = lazy(() => import('./pages/clientes/ClientesPage'))
const CalculadoraPage = lazy(() => import('./pages/calculadora/CalculadoraPage'))
const ImportarPage = lazy(() => import('./pages/importar/ImportarPage'))
const AnalyticsPage = lazy(() => import('./pages/analytics/AnalyticsPage'))
const DespachoPagina = lazy(() => import('./pages/despacho/DespachoPagina'))
const EntregasPage = lazy(() => import('./pages/entregas/EntregasPage'))
const SistemaPage = lazy(() => import('./pages/sistema/SistemaPage'))

// Spinner mientras carga una página diferida
function PageLoader() {
  return (
    <div style={{ display: 'flex', alignItems: 'center', justifyContent: 'center', minHeight: '60vh' }}>
      <div style={{ width: 32, height: 32, border: '3px solid var(--border)', borderTopColor: 'var(--accent)', borderRadius: '50%' }} className="spinning" />
    </div>
  )
}

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
          <Route path="clientes" element={<Suspense fallback={<PageLoader />}><ClientesPage /></Suspense>} />
          <Route path="stock" element={<Suspense fallback={<PageLoader />}><StockPage /></Suspense>} />
          <Route path="ads" element={<Suspense fallback={<PageLoader />}><AdsPage /></Suspense>} />
          <Route path="finanzas" element={<Suspense fallback={<PageLoader />}><FinanzasPage /></Suspense>} />
          <Route path="rendicion" element={<Suspense fallback={<PageLoader />}><RendicionPage /></Suspense>} />
          <Route path="despacho" element={<Suspense fallback={<PageLoader />}><DespachoPagina /></Suspense>} />
          <Route path="entregas" element={<Suspense fallback={<PageLoader />}><EntregasPage /></Suspense>} />
          <Route path="analytics" element={<Suspense fallback={<PageLoader />}><AnalyticsPage /></Suspense>} />
          <Route path="calculadora" element={<Suspense fallback={<PageLoader />}><CalculadoraPage /></Suspense>} />
          <Route path="importar" element={<Suspense fallback={<PageLoader />}><ImportarPage /></Suspense>} />
          <Route path="reportes" element={<Suspense fallback={<PageLoader />}><ReportesPage /></Suspense>} />
          <Route path="config" element={<Suspense fallback={<PageLoader />}><ConfigPage /></Suspense>} />
          <Route path="sistema" element={<Suspense fallback={<PageLoader />}><SistemaPage /></Suspense>} />
        </Route>
        <Route path="*" element={<Navigate to="/dashboard" replace />} />
      </Routes>
    </ToastProvider>
  )
}
