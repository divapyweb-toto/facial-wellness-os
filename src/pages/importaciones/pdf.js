// src/pages/importaciones/pdf.js
// Exporta la ficha de propuesta a PDF (jspdf, carga diferida). Texto en el
// orden a–h; foto principal si es JPG/PNG. Las fuentes estándar del PDF no
// tienen "₲" ni algunos símbolos: se escriben como "Gs." y en ASCII.
import { fmtFecha, fmtPct, fmtDinero, tipoEvidenciaInfo } from '../productos/formato'

const limpio = (s) => String(s ?? '')
  .replace(/₲\s?/g, 'Gs. ').replace(/≤/g, '<=').replace(/≥/g, '>=').replace(/→/g, '->').replace(/÷/g, '/').replace(/−/g, '-').replace(/[·•]/g, '-')
  .replace(/[^\x20-\x7E -ÿ\n]/g, '')
const gs = (n) => (n == null ? 'desconocido' : `Gs. ${new Intl.NumberFormat('es-PY').format(Math.round(n))}`)

async function aDataURL(url) {
  if (!url) return null
  if (url.startsWith('data:image/jpeg') || url.startsWith('data:image/png')) return url
  if (url.startsWith('data:')) return null // SVG u otros: jspdf no los dibuja
  try {
    const r = await fetch(url)
    const b = await r.blob()
    if (!/image\/(jpeg|png)/.test(b.type)) return null
    return await new Promise((ok) => { const fr = new FileReader(); fr.onload = () => ok(fr.result); fr.onerror = () => ok(null); fr.readAsDataURL(b) })
  } catch { return null }
}

export async function exportarPDF({ d, esc, numeros, sem, regla, comparacion, elegida, cant, caso }) {
  const { jsPDF } = await import('jspdf')
  const doc = new jsPDF({ unit: 'mm', format: 'a4' })
  const M = 14, W = 210 - 2 * M
  let y = 16
  const salto = (h = 6) => { if (y + h > 285) { doc.addPage(); y = 16 } }
  const titulo = (t) => { salto(10); y += 3; doc.setFont('helvetica', 'bold'); doc.setFontSize(11); doc.text(limpio(t), M, y); y += 6; doc.setFont('helvetica', 'normal'); doc.setFontSize(9.5) }
  const parrafo = (t) => { for (const l of doc.splitTextToSize(limpio(t), W)) { salto(5); doc.text(l, M, y); y += 4.6 } }

  const c = d.candidato
  doc.setFont('helvetica', 'bold'); doc.setFontSize(15); doc.text(limpio(`Propuesta de importación - ${c.nombre}`), M, y); y += 6
  doc.setFont('helvetica', 'normal'); doc.setFontSize(9)
  parrafo(`${c.demo ? 'DEMO: datos inventados. ' : ''}Generado ${new Date().toLocaleString('es-PY', { timeZone: 'America/Asuncion' })} - semáforo ${sem.color} (${sem.motivos.join('; ')})`)
  parrafo('Contribución no es utilidad neta. El puntaje es de prioridad, no una probabilidad de éxito.')

  titulo('a. Fotos')
  const fotos = d.fotos || []
  parrafo(`${fotos.length} foto(s): ${regla.reales} reales, ${regla.proveedor} del proveedor. ${regla.ok ? 'Cumple la regla de fotos.' : regla.motivo}`)
  const principal = fotos.find(f => f.es_principal) || fotos[0]
  const img = await aDataURL(principal?.url)
  if (img) { salto(62); try { doc.addImage(img, img.includes('image/png') ? 'PNG' : 'JPEG', M, y, 80, 60); y += 63 } catch { /* foto ilegible: se sigue sin ella */ } }
  fotos.forEach(f => parrafo(`- ${f.fuente}${f.fuente === 'ia_referencia' ? ' (no es el producto real)' : ''}: ${f.descripcion || 'sin descripción'}`))

  titulo('b. Los números')
  parrafo(`Ganancia por pedido confirmado (después de anuncios, escenario base): ${gs(numeros.ganancia)}`)
  parrafo(`Plata total necesaria: ${gs(numeros.plata)}${numeros.pico != null ? ` (pico de caja ${gs(numeros.pico)})` : ''}`)
  parrafo(`Días para recuperarla: ${numeros.dias ?? (numeros.recupera === false ? 'no recupera en el horizonte cargado' : 'desconocido')}`)
  parrafo(`Costo de anuncios máximo que aguanta: ${gs(numeros.adsMax)} por confirmado (tope de Voltra: Gs. 35.000 por confirmado)`)

  titulo('c. Trato con el proveedor')
  if (!comparacion.length) parrafo('Sin cotizaciones.')
  comparacion.slice(0, 3).forEach(x => {
    parrafo(`${elegida && x.c.id === elegida.c.id ? '[ELEGIDO] ' : ''}${x.prov?.razon_social_declarada || 'proveedor'} (${x.prov?.plataforma || '?'}, ${x.c.tipo}, ficha v${x.c.ficha_version ?? '?'}): costo puesto por unidad vendible ${gs(x.costoPuesto ?? x.precioVendible)}; escalones ${x.escalones.map(e => `${e.cantidad} u ${fmtDinero(e.precio_unit_minor, x.c.moneda)}`).join(', ') || 'desconocido'}; mínimo ${x.c.moq ?? 'desconocido'}; muestra ${x.c.costo_muestra_minor != null ? fmtDinero(x.c.costo_muestra_minor, x.c.moneda) : 'desconocido'}; plazo ${x.c.plazo_dias ?? '?'} días; vigencia ${x.c.valida_hasta ? fmtFecha(x.c.valida_hasta) : 'desconocida'}.`)
  })

  titulo('d. Costo puesto en Paraguay')
  const cp = esc?.resultado?.escenarios?.base?.resultado?.costoPuesto
  if (!cp) parrafo('Sin costo puesto calculado.')
  else {
    cp.detalle.forEach(x => parrafo(`- ${x.concepto}: ${x.pyg != null ? gs(x.pyg) : 'desconocido'} (${x.tratamiento}${x.fuente ? `; fuente: ${x.fuente}` : ''})`))
    parrafo(`Merma: ${cp.merma.unidades} u (${fmtPct(cp.merma.pct)}). Costo por unidad vendible: ${gs(cp.porUnidadVendible)}.`)
  }

  titulo('e. Precio de venta')
  parrafo(`Precio de prueba (1 unidad, IVA incluido): ${gs(numeros.precio)}.`)
  d.ofertas.forEach(o => parrafo(`- Competencia: ${o.vendedor} (${o.comparacion}, ${o.zona}) ${fmtDinero(o.precio_minor, o.moneda)}, observado ${fmtFecha(o.observado_en)}${o.url ? `, ${o.url}` : ''}`))

  titulo('f. Cantidad recomendada')
  parrafo(cant ? `Piloto ${cant.piloto} u (${gs(cant.plataPiloto)}) - marítimo ${cant.maritimo} u (${gs(cant.plataMaritimo)}) - tope 4 meses ${cant.tope} u. ${cant.nota}` : 'Falta el ritmo de venta esperado.')

  titulo('g. Escenarios, riesgos y bloqueos')
  const e = esc?.resultado?.escenarios
  if (e) ['adverso', 'base', 'favorable'].forEach(k => e[k] && parrafo(`- ${k}: ganancia ${gs(e[k].resumen.porConfirmado.despuesAds)} por confirmado; ${gs(e[k].resumen.porIniciado.despuesAds)} por pedido iniciado.`))
  ;(caso?.bloqueos?.bloqueos || []).forEach(b => parrafo(`- BLOQUEO ${b.codigo}: ${b.mensaje}`))
  ;(caso?.bloqueos?.avisos || []).forEach(a => parrafo(`- Aviso ${a.codigo}: ${a.mensaje}`))
  if (caso?.rubrica?.puntaje) parrafo(`Puntaje de prioridad ${caso.rubrica.puntaje.puntaje}/100 (no es probabilidad).`)

  titulo('h. Evidencia')
  d.evidencias.forEach(ev => parrafo(`- [${tipoEvidenciaInfo(ev.tipo).label}] ${ev.campo}: ${ev.valor ?? 'desconocido'}${ev.fuente_entidad ? ` (${ev.fuente_entidad})` : ''}${ev.observado_en ? `, ${fmtFecha(ev.observado_en)}` : ''}`))

  if ((d.decisiones || []).length) {
    titulo('Decisiones registradas')
    d.decisiones.forEach(x => parrafo(`- ${x.decision} (${fmtFecha(x.creado_en)}): "${x.texto_enrique}"${x.motivo ? ` - motivo: ${x.motivo}` : ''}`))
  }
  const nombre = (c.nombre || 'propuesta').normalize('NFD').replace(/[̀-ͯ]/g, '').toLowerCase().replace(/[^a-z0-9]+/g, '-').replace(/^-|-$/g, '')
  doc.save(`propuesta-${nombre}.pdf`)
}
