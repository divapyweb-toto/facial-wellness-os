// src/pages/calculadora/CalculadoraPage.jsx
import { useState } from 'react'
import { formatGs, formatPct } from '../../lib/supabase'
import { Calculator, TrendingUp, Target, DollarSign, Package, AlertTriangle, CheckCircle } from 'lucide-react'

export default function CalculadoraPage() {
  const [form, setForm] = useState({
    costo_producto: '',
    precio_venta: '',
    costo_envio: 27000,
    envio_cliente: 29000,
    grupo_envio: 'A',
    presupuesto_ads: '',
    ventas_estimadas: '',
  })

  const f = (key) => ({
    value: form[key],
    onChange: e => setForm(p => ({ ...p, [key]: e.target.value === '' ? '' : parseFloat(e.target.value) || e.target.value }))
  })

  // Cálculos principales
  const costo = parseFloat(form.costo_producto) || 0
  const precio = parseFloat(form.precio_venta) || 0
  const costoEnvio = parseFloat(form.costo_envio) || 27000
  const envioCliente = form.grupo_envio === 'A' ? (parseFloat(form.envio_cliente) || 29000) : 0
  const presupuestoAds = parseFloat(form.presupuesto_ads) || 0
  const ventasEstimadas = parseFloat(form.ventas_estimadas) || 1

  const margenBruto = precio - costo
  const margenBrutoPct = precio > 0 ? (margenBruto / precio) * 100 : 0

  const costoTotal = costo + costoEnvio - envioCliente
  const gananciaNeta = precio - costoTotal
  const margenNetoPct = precio > 0 ? (gananciaNeta / precio) * 100 : 0

  const cpaAds = presupuestoAds > 0 && ventasEstimadas > 0 ? presupuestoAds / ventasEstimadas : 0
  const gananciaDespuesAds = gananciaNeta - cpaAds
  const margenFinalPct = precio > 0 ? (gananciaDespuesAds / precio) * 100 : 0

  // ROAS mínimo de break-even = precio / ganancia neta por unidad
  // (cuántos Gs de ingreso por cada Gs de ads para no perder)
  const roasMinimoNum = gananciaNeta > 0 ? precio / gananciaNeta : 0

  const breakEvenUnidades = presupuestoAds > 0 && gananciaNeta > 0
    ? Math.ceil(presupuestoAds / gananciaNeta)
    : 0

  const ingresosTotales = precio * ventasEstimadas
  const roasReal = presupuestoAds > 0 ? ingresosTotales / presupuestoAds : 0
  const gananciaTotal = gananciaNeta * ventasEstimadas - presupuestoAds

  const esRentable = gananciaDespuesAds > 0
  const alertas = []
  if (margenNetoPct < 20) alertas.push({ tipo: 'error', msg: 'Margen neto muy bajo — menos del 20%' })
  if (margenNetoPct >= 20 && margenNetoPct < 40) alertas.push({ tipo: 'warning', msg: 'Margen neto moderado — puede ser ajustado con ads' })
  if (cpaAds > gananciaNeta) alertas.push({ tipo: 'error', msg: 'CPA estimado mayor que ganancia neta — perderías dinero con ads' })
  if (roasReal > 0 && roasReal < 2) alertas.push({ tipo: 'warning', msg: 'ROAS estimado bajo — revisá el presupuesto de ads' })

  return (
    <div style={{ display: 'flex', flexDirection: 'column', gap: 20 }}>
      <div className="page-header">
        <div>
          <h1 className="page-title">Calculadora CMV</h1>
          <p className="page-subtitle">Margen, break-even y ROAS mínimo en tiempo real</p>
        </div>
      </div>

      <div style={{ display: 'grid', gridTemplateColumns: '1fr 1fr', gap: 20 }}>
        {/* Panel izquierdo: inputs */}
        <div style={{ display: 'flex', flexDirection: 'column', gap: 14 }}>
          <div className="card">
            <div style={{ fontSize: 13, fontWeight: 700, color: 'var(--text-primary)', marginBottom: 14, display: 'flex', alignItems: 'center', gap: 8 }}>
              <Package size={15} color="var(--accent)" /> Producto
            </div>
            <div style={{ display: 'flex', flexDirection: 'column', gap: 12 }}>
              <div className="form-group">
                <label className="form-label">Costo del producto (Gs.)</label>
                <input className="form-input" type="number" {...f('costo_producto')} placeholder="20698" />
              </div>
              <div className="form-group">
                <label className="form-label">Precio de venta (Gs.)</label>
                <input className="form-input" type="number" {...f('precio_venta')} placeholder="98000" />
              </div>
              <div className="form-group">
                <label className="form-label">Grupo de envío</label>
                <select className="form-select" value={form.grupo_envio}
                  onChange={e => setForm(p => ({ ...p, grupo_envio: e.target.value }))}>
                  <option value="A">A — Cliente paga envío (+29.000 Gs.)</option>
                  <option value="B">B — Envío gratis (lo absorbés vos)</option>
                </select>
              </div>
              <div className="form-group">
                <label className="form-label">Costo de envío propio (Gs.)</label>
                <input className="form-input" type="number" {...f('costo_envio')} />
              </div>
            </div>
          </div>

          <div className="card">
            <div style={{ fontSize: 13, fontWeight: 700, color: 'var(--text-primary)', marginBottom: 14, display: 'flex', alignItems: 'center', gap: 8 }}>
              <Target size={15} color="var(--accent)" /> Publicidad (opcional)
            </div>
            <div style={{ display: 'flex', flexDirection: 'column', gap: 12 }}>
              <div className="form-group">
                <label className="form-label">Presupuesto de ads (Gs.)</label>
                <input className="form-input" type="number" {...f('presupuesto_ads')} placeholder="1000000" />
              </div>
              <div className="form-group">
                <label className="form-label">Ventas estimadas (#)</label>
                <input className="form-input" type="number" {...f('ventas_estimadas')} placeholder="10" />
              </div>
            </div>
          </div>
        </div>

        {/* Panel derecho: resultados */}
        <div style={{ display: 'flex', flexDirection: 'column', gap: 12 }}>
          {/* Alertas */}
          {alertas.map((a, i) => (
            <div key={i} className={`alert alert-${a.tipo === 'error' ? 'error' : 'warning'}`}>
              <AlertTriangle size={14} /> {a.msg}
            </div>
          ))}

          {/* Resultado principal */}
          {precio > 0 && costo > 0 && (
            <div style={{
              background: esRentable ? 'var(--green-dim)' : 'var(--red-dim)',
              border: `1px solid ${esRentable ? 'rgba(34,197,94,0.2)' : 'rgba(239,68,68,0.2)'}`,
              borderRadius: 12, padding: '18px 20px',
              display: 'flex', alignItems: 'center', justifyContent: 'space-between',
            }}>
              <div>
                <div style={{ fontSize: 12, fontWeight: 600, color: esRentable ? 'var(--green)' : 'var(--red)', textTransform: 'uppercase', letterSpacing: '0.06em' }}>
                  {esRentable ? '✓ Rentable' : '✗ No rentable'}
                </div>
                <div style={{ fontFamily: 'var(--font-display)', fontSize: 28, fontWeight: 800, color: esRentable ? 'var(--green)' : 'var(--red)', letterSpacing: '-0.02em', marginTop: 4 }}>
                  {formatGs(Math.round(presupuestoAds > 0 ? gananciaDespuesAds : gananciaNeta))}
                </div>
                <div style={{ fontSize: 12, color: 'var(--text-muted)', marginTop: 4 }}>
                  Ganancia neta por unidad {presupuestoAds > 0 ? '(incluyendo ads)' : ''}
                </div>
              </div>
              <div style={{
                fontFamily: 'var(--font-display)', fontSize: 36, fontWeight: 900,
                color: esRentable ? 'var(--green)' : 'var(--red)', opacity: 0.4
              }}>
                {formatPct(presupuestoAds > 0 ? margenFinalPct : margenNetoPct)}
              </div>
            </div>
          )}

          {/* Desglose */}
          {precio > 0 && (
            <div className="card">
              <div style={{ fontSize: 12, fontWeight: 700, color: 'var(--text-muted)', textTransform: 'uppercase', letterSpacing: '0.06em', marginBottom: 14 }}>
                Desglose por unidad
              </div>
              <div style={{ display: 'flex', flexDirection: 'column', gap: 8 }}>
                {[
                  { label: 'Precio de venta', value: formatGs(precio), color: 'var(--accent)' },
                  { label: '— Costo producto', value: `−${formatGs(costo)}`, color: 'var(--red)' },
                  ...(form.grupo_envio === 'A'
                    ? [
                        { label: '+ Envío cobrado al cliente', value: `+${formatGs(envioCliente)}`, color: 'var(--green)' },
                        { label: '— Flete a Punto a Punto', value: `−${formatGs(costoEnvio)}`, color: 'var(--red)' },
                      ]
                    : [
                        { label: '— Flete a Punto a Punto (envío gratis al cliente)', value: `−${formatGs(costoEnvio)}`, color: 'var(--red)' },
                      ]),
                  { label: '= Ganancia neta', value: formatGs(gananciaNeta), color: gananciaNeta > 0 ? 'var(--green)' : 'var(--red)', bold: true },
                  ...(cpaAds > 0 ? [
                    { label: `— CPA ads (${formatGs(presupuestoAds)} ÷ ${ventasEstimadas} ventas)`, value: `−${formatGs(Math.round(cpaAds))}`, color: 'var(--red)' },
                    { label: '= Ganancia final (con ads)', value: formatGs(Math.round(gananciaDespuesAds)), color: gananciaDespuesAds > 0 ? 'var(--accent)' : 'var(--red)', bold: true },
                  ] : []),
                ].map((row, i) => (
                  <div key={i} style={{
                    display: 'flex', justifyContent: 'space-between',
                    padding: row.bold ? '8px 10px' : '5px 10px',
                    background: row.bold ? 'var(--bg-hover)' : 'transparent',
                    borderRadius: 6,
                  }}>
                    <span style={{ fontSize: 12, color: 'var(--text-secondary)' }}>{row.label}</span>
                    <span style={{ fontSize: 13, fontWeight: row.bold ? 800 : 600, color: row.color, fontFamily: row.bold ? 'var(--font-display)' : undefined }}>
                      {row.value}
                    </span>
                  </div>
                ))}
              </div>
            </div>
          )}

          {/* Métricas de campaña */}
          {presupuestoAds > 0 && precio > 0 && (
            <div className="card">
              <div style={{ fontSize: 12, fontWeight: 700, color: 'var(--text-muted)', textTransform: 'uppercase', letterSpacing: '0.06em', marginBottom: 14 }}>
                Métricas de campaña
              </div>
              <div style={{ display: 'grid', gridTemplateColumns: '1fr 1fr', gap: 10 }}>
                {[
                  { label: 'ROAS mínimo para no perder', value: `${roasMinimoNum.toFixed(2)}x`, color: 'var(--yellow)' },
                  { label: 'ROAS estimado', value: `${roasReal.toFixed(2)}x`, color: roasReal >= roasMinimoNum ? 'var(--green)' : 'var(--red)' },
                  { label: 'Break-even (unidades)', value: breakEvenUnidades, color: 'var(--text-primary)' },
                  { label: 'Ganancia total campaña', value: formatGs(Math.round(gananciaTotal)), color: gananciaTotal > 0 ? 'var(--green)' : 'var(--red)' },
                  { label: 'Ingresos totales', value: formatGs(Math.round(ingresosTotales)), color: 'var(--accent)' },
                  { label: 'Margen final', value: formatPct(margenFinalPct), color: margenFinalPct > 20 ? 'var(--green)' : 'var(--red)' },
                ].map((m, i) => (
                  <div key={i} style={{ background: 'var(--bg-hover)', borderRadius: 8, padding: '10px 12px' }}>
                    <div style={{ fontSize: 10, color: 'var(--text-muted)', marginBottom: 4 }}>{m.label}</div>
                    <div style={{ fontFamily: 'var(--font-display)', fontSize: 16, fontWeight: 700, color: m.color }}>{m.value}</div>
                  </div>
                ))}
              </div>
            </div>
          )}
        </div>
      </div>
    </div>
  )
}
