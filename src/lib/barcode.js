// src/lib/barcode.js
// ═══════════════════════════════════════════════════════════
// CÓDIGOS DE BARRAS DE PEDIDO
//
// Formato del código: AAMMDD-REFERENCIA   (ej: 260709-1595)
//
// ¿Por qué el prefijo de fecha? Porque n_referencia viene de Shopify y nada
// garantiza que sea único para siempre: si conectás otra tienda, si Shopify
// reinicia numeración, o si un CSV trae una referencia repetida, dos pedidos
// distintos podrían compartir código. Con la fecha de venta adelante, el
// código es único aunque el número se repita en otro período.
//
// Se usa la FECHA DE VENTA (no la de impresión) a propósito: si reimprimís la
// guía de un pedido, el código sale idéntico — es la misma caja física.
//
// Code128: estándar de logística. Sin techo de volumen, lo lee cualquier
// lector 1D/2D, y se imprime con el número legible abajo como respaldo.
// ═══════════════════════════════════════════════════════════
import JsBarcode from 'jsbarcode'

// "2026-07-09" → "260709"
export function prefijoFecha(fecha) {
  const d = fecha ? new Date(String(fecha).slice(0, 10) + 'T00:00:00') : new Date()
  if (isNaN(d.getTime())) return prefijoFecha(null)
  const p = (n) => String(n).padStart(2, '0')
  return `${p(d.getFullYear() % 100)}${p(d.getMonth() + 1)}${p(d.getDate())}`
}

// Código completo que se imprime en la etiqueta.
export function codigoPedido(n_referencia, fecha) {
  const ref = String(n_referencia || '').replace(/[#\s]/g, '').trim()
  if (!ref) return null
  return `${prefijoFecha(fecha)}-${ref}`
}

// Normaliza un identificador suelto (referencia o guía) para comparar.
export function normalizarEscaneo(valor) {
  if (!valor) return ''
  let v = String(valor).replace(/[#\s.\-/]/g, '').trim()
  if (/^\d+$/.test(v)) v = String(parseInt(v, 10)) // "001595" → "1595"
  return v
}

// Interpreta lo que entra por el lector (o por teclado).
// Entiende el formato propio AAMMDD-REF, referencias sueltas y guías de PaP.
// → { ref, fecha, raw }
export function interpretarEscaneo(bruto) {
  const s = String(bruto || '').trim()
  // Código propio AAMMDD + separador + REF (ej: 260715-1881).
  // El separador puede NO ser un guión: según el layout de teclado, el lector
  // puede tipear '/', '\'', '.', espacio, etc. en su lugar. Aceptamos cualquiera.
  // También el caso sin separador (260715 1881 pegado): 6 dígitos de fecha +
  // el resto como referencia.
  let m = s.match(/^(\d{6})[^0-9A-Za-z]+(.+)$/)      // 260715-1881, 260715/1881, 260715 1881
  if (!m) m = s.match(/^(\d{6})(\d{2,})$/)            // 2607151881 (todo pegado)
  if (m) {
    // Validar que los 6 dígitos parezcan una fecha AAMMDD (mes 01-12, día 01-31)
    const mes = parseInt(m[1].slice(2, 4), 10)
    const dia = parseInt(m[1].slice(4, 6), 10)
    if (mes >= 1 && mes <= 12 && dia >= 1 && dia <= 31) {
      return { fecha: m[1], ref: normalizarEscaneo(m[2]), raw: normalizarEscaneo(s) }
    }
  }
  return { fecha: null, ref: normalizarEscaneo(s), raw: normalizarEscaneo(s) }
}

// Genera el PNG del código de barras.
// Devuelve { data, width, height } — las medidas sirven para escalar sin
// deformar (un barcode deformado deja de leerse).
export function generarBarcodePNG(texto, opciones = {}) {
  const valor = String(texto || '').trim()
  if (!valor) return null

  const canvas = document.createElement('canvas')
  JsBarcode(canvas, valor, {
    format: 'CODE128',
    width: 2,           // grosor de la barra más fina (px)
    height: 70,         // alto de las barras
    displayValue: true, // imprime el código debajo (respaldo si falla el escaneo)
    fontSize: 18,
    textMargin: 2,
    font: 'monospace',
    margin: 10,         // zona de silencio: sin esto el lector no engancha
    background: '#ffffff',
    lineColor: '#000000',
    ...opciones,
  })

  const dataUrl = canvas.toDataURL('image/png')
  const base64 = dataUrl.split(',')[1]
  const bin = atob(base64)
  const bytes = new Uint8Array(bin.length)
  for (let i = 0; i < bin.length; i++) bytes[i] = bin.charCodeAt(i)
  return { data: bytes, width: canvas.width, height: canvas.height }
}
