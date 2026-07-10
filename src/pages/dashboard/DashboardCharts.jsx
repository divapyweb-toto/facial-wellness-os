// src/pages/dashboard/DashboardCharts.jsx
// ═══════════════════════════════════════════════════════════
// GRÁFICOS DEL DASHBOARD (carga diferida)
//
// recharts pesa ~5 MB. Si el Dashboard lo importara arriba, el navegador
// tendría que bajar toda la librería de gráficos ANTES de mostrarte los
// números. Al separarlo en este componente y cargarlo con lazy(), los KPIs
// aparecen al instante y los gráficos se dibujan un momento después.
// ═══════════════════════════════════════════════════════════
import {
  AreaChart, Area, XAxis, YAxis, CartesianGrid,
  Tooltip, ResponsiveContainer, BarChart, Bar, Legend,
} from 'recharts'
import { formatGs } from '../../lib/supabase'

const CustomTooltip = ({ active, payload, label }) => {
  if (active && payload && payload.length) {
    return (
      <div style={{ background: 'var(--bg-card)', border: '1px solid var(--border)', borderRadius: 8, padding: '10px 14px', fontSize: 12 }}>
        <p style={{ color: 'var(--text-secondary)', marginBottom: 6 }}>{label}</p>
        {payload.map((p, i) => (
          <p key={i} style={{ color: p.color, fontWeight: 600 }}>{p.name}: {formatGs(p.value)}</p>
        ))}
      </div>
    )
  }
  return null
}

// Gráfico de área — últimos 7 días
export function ChartUltimos7({ chartData }) {
  return (
    <ResponsiveContainer width="100%" height={160}>
      <AreaChart data={chartData} margin={{ top: 5, right: 5, left: 0, bottom: 0 }}>
        <defs>
          <linearGradient id="gV" x1="0" y1="0" x2="0" y2="1">
            <stop offset="5%" stopColor="var(--accent)" stopOpacity={0.25} />
            <stop offset="95%" stopColor="var(--accent)" stopOpacity={0} />
          </linearGradient>
          <linearGradient id="gN" x1="0" y1="0" x2="0" y2="1">
            <stop offset="5%" stopColor="var(--green)" stopOpacity={0.2} />
            <stop offset="95%" stopColor="var(--green)" stopOpacity={0} />
          </linearGradient>
        </defs>
        <CartesianGrid strokeDasharray="3 3" stroke="var(--border)" vertical={false} />
        <XAxis dataKey="fecha" tick={{ fontSize: 9, fill: 'var(--text-muted)' }} axisLine={false} tickLine={false} />
        <YAxis tick={{ fontSize: 9, fill: 'var(--text-muted)' }} axisLine={false} tickLine={false}
          tickFormatter={v => v >= 1000000 ? `${(v / 1000000).toFixed(1)}M` : v >= 1000 ? `${(v / 1000).toFixed(0)}k` : v} />
        <Tooltip content={<CustomTooltip />} />
        <Area type="monotone" dataKey="ventas" name="Ventas" stroke="var(--accent)" fill="url(#gV)" strokeWidth={2} dot={false} />
        <Area type="monotone" dataKey="neto" name="Neto" stroke="var(--green)" fill="url(#gN)" strokeWidth={2} dot={false} />
      </AreaChart>
    </ResponsiveContainer>
  )
}

// Gráfico de barras — evolución 6 meses
export function ChartEvolucion({ historico6m }) {
  return (
    <ResponsiveContainer width="100%" height={200}>
      <BarChart data={historico6m} margin={{ top: 5, right: 10, left: 0, bottom: 0 }}>
        <CartesianGrid strokeDasharray="3 3" stroke="var(--border)" vertical={false} />
        <XAxis dataKey="mes" tick={{ fontSize: 11, fill: 'var(--text-muted)' }} axisLine={false} tickLine={false} />
        <YAxis tick={{ fontSize: 9, fill: 'var(--text-muted)' }} axisLine={false} tickLine={false}
          tickFormatter={v => v >= 1000000 ? `${(v / 1000000).toFixed(1)}M` : `${(v / 1000).toFixed(0)}k`} />
        <Tooltip formatter={(v, n) => [formatGs(v), n]} contentStyle={{ background: 'var(--bg-card)', border: '1px solid var(--border)', borderRadius: 8, fontSize: 12 }} />
        <Legend wrapperStyle={{ fontSize: 12 }} />
        <Bar dataKey="ventas" name="Ventas brutas" fill="var(--accent)" opacity={0.85} radius={[3, 3, 0, 0]} />
        <Bar dataKey="neto" name="Ingresos netos" fill="var(--green)" opacity={0.8} radius={[3, 3, 0, 0]} />
      </BarChart>
    </ResponsiveContainer>
  )
}

// Default export para que lazy() lo cargue como un módulo con ambos gráficos
export default { ChartUltimos7, ChartEvolucion }
