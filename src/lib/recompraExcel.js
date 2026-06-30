// src/lib/recompraExcel.js
// Genera el Excel de recompra (3 hojas estéticas) y dispara la descarga.
// Usa ExcelJS (writeBuffer → Blob → descarga) para soportar estilos ricos
// que SheetJS no hace: color de pestañas, escala de colores condicional, etc.

import ExcelJS from 'exceljs'

const GRUPOS_META = {
  g1: { num: '1', tab: '1 · Reponer',     color: 'FF3B86C9', nombre: 'Reponer consumible' },
  g2: { num: '2', tab: '2 · Combo Sueño', color: 'FF2BB673', nombre: 'Completar combo sueño' },
  g3: { num: '3', tab: '3 · Cross-sell',  color: 'FFE8973A', nombre: 'Cross-sell durable' },
}

const HEAD = ['Nombre', 'Teléfono', 'Producto comprado', 'Días desde entrega', 'Grupo', 'Oferta sugerida']
const FUENTE = 'Helvetica Neue'

function fechaHoy() {
  const d = new Date()
  const p = n => String(n).padStart(2, '0')
  return `${p(d.getDate())}/${p(d.getMonth() + 1)}/${d.getFullYear()}`
}

export async function generarExcelRecompra(segmentado) {
  const wb = new ExcelJS.Workbook()
  wb.creator = 'Facial Wellness OS'
  wb.created = new Date()
  const fecha = fechaHoy()

  for (const key of ['g1', 'g2', 'g3']) {
    const meta = GRUPOS_META[key]
    const rows = segmentado[key] || []
    const ws = wb.addWorksheet(meta.tab, { properties: { tabColor: { argb: meta.color } } })
    ws.columns = [{ width: 24 }, { width: 16 }, { width: 20 }, { width: 18 }, { width: 8 }, { width: 46 }]

    // ── Banda de marca (filas 1-2 fusionadas, fondo casi negro) ──
    ws.mergeCells('A1:F1'); ws.mergeCells('A2:F2')
    const t1 = ws.getCell('A1')
    t1.value = 'FACIAL WELLNESS'
    t1.font = { name: FUENTE, size: 20, bold: true, color: { argb: 'FFFFFFFF' } }
    t1.fill = { type: 'pattern', pattern: 'solid', fgColor: { argb: 'FF0A0A0A' } }
    t1.alignment = { vertical: 'middle', horizontal: 'left', indent: 1 }
    ws.getRow(1).height = 30
    const t2 = ws.getCell('A2')
    t2.value = `GRUPO ${meta.num} · ${meta.nombre} · ${rows.length} cliente${rows.length === 1 ? '' : 's'} · Generado ${fecha}`
    t2.font = { name: FUENTE, size: 10, color: { argb: 'FFB8B8B8' } }
    t2.fill = { type: 'pattern', pattern: 'solid', fgColor: { argb: 'FF0A0A0A' } }
    t2.alignment = { vertical: 'middle', horizontal: 'left', indent: 1 }
    ws.getRow(2).height = 18

    // ── Encabezado de tabla (fila 4) ──
    const hr = ws.getRow(4)
    HEAD.forEach((h, i) => {
      const c = hr.getCell(i + 1)
      c.value = h
      c.font = { name: FUENTE, size: 10, bold: true, color: { argb: 'FFFFFFFF' } }
      c.fill = { type: 'pattern', pattern: 'solid', fgColor: { argb: meta.color } }
      c.alignment = { vertical: 'middle', horizontal: i === 3 || i === 4 ? 'center' : 'left', wrapText: true }
      c.border = { bottom: { style: 'thin', color: { argb: 'FFCCCCCC' } } }
    })
    hr.height = 24

    // ── Filas de datos (o aviso si vacío) ──
    if (rows.length === 0) {
      ws.mergeCells('A5:F5')
      const e = ws.getCell('A5')
      e.value = 'Sin clientes en este grupo hoy.'
      e.font = { name: FUENTE, size: 10, italic: true, color: { argb: 'FF999999' } }
      e.alignment = { horizontal: 'center', vertical: 'middle' }
      ws.getRow(5).height = 22
    } else {
      rows.forEach((row, idx) => {
        const r = ws.getRow(5 + idx)
        const zebra = idx % 2 === 1 ? 'FFF2F6FA' : 'FFFFFFFF'
        const vals = [row.nombre || '—', row.telefono || '', row.productoComprado, row.diasDesdeEntrega, `G${row.grupo}`, row.ofertaSugerida]
        vals.forEach((v, i) => {
          const c = r.getCell(i + 1)
          c.value = v
          c.font = { name: FUENTE, size: 10 }
          c.fill = { type: 'pattern', pattern: 'solid', fgColor: { argb: zebra } }
          c.border = { bottom: { style: 'thin', color: { argb: 'FFEEEEEE' } } }
          c.alignment = { vertical: 'middle' }
          if (i === 1) { c.numFmt = '@'; c.alignment = { horizontal: 'left', vertical: 'middle' } } // teléfono como TEXTO
          if (i === 3) { c.alignment = { horizontal: 'center', vertical: 'middle' }; c.font = { name: FUENTE, size: 10, bold: true } }
          if (i === 4) { c.alignment = { horizontal: 'center', vertical: 'middle' } }
          if (i === 5) { c.alignment = { wrapText: true, vertical: 'middle' } }
        })
      })
      // Escala de 3 colores en "Días desde entrega" (verde→amarillo→rojo, más días = rojo)
      const lastRow = 4 + rows.length
      ws.addConditionalFormatting({
        ref: `D5:D${lastRow}`,
        rules: [{
          type: 'colorScale',
          cfvo: [{ type: 'min' }, { type: 'percentile', value: 50 }, { type: 'max' }],
          color: [{ argb: 'FF63BE7B' }, { argb: 'FFFFEB84' }, { argb: 'FFF8696B' }],
        }],
      })
    }

    // Congelar bajo la fila 4 + autofiltro en la fila 4
    ws.views = [{ state: 'frozen', ySplit: 4 }]
    ws.autoFilter = { from: { row: 4, column: 1 }, to: { row: 4, column: 6 } }
  }

  // writeBuffer → Blob → descarga (camino navegador)
  const buffer = await wb.xlsx.writeBuffer()
  const blob = new Blob([buffer], { type: 'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet' })
  const d = new Date()
  const nombre = `Recompra_FacialWellness_${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, '0')}-${String(d.getDate()).padStart(2, '0')}.xlsx`
  const url = URL.createObjectURL(blob)
  const a = document.createElement('a')
  a.href = url
  a.download = nombre
  document.body.appendChild(a)
  a.click()
  document.body.removeChild(a)
  URL.revokeObjectURL(url)
  return nombre
}
