// src/lib/barcode.js
// Genera códigos de barras Code128 para las guías de despacho.
//
// Code128 es el estándar de logística: denso, rápido de leer con escáner
// lineal, y soportado por cualquier lector 1D/2D. Se imprime con el número
// legible abajo, así que si el escaneo falla (etiqueta rota, arrugada),
// siempre se puede tipear a mano.
//
// El contenido del código es el n_referencia del pedido, que es único
// y es la llave que conecta Shopify → ventas → reportes de Punto a Punto.

import JsBarcode from 'jsbarcode'

// Devuelve el PNG del código de barras como Uint8Array (listo para docx ImageRun).
export function generarBarcodePNG(texto, opciones = {}) {
  const valor = String(texto || '').trim()
  if (!valor) return null

  const canvas = document.createElement('canvas')
  JsBarcode(canvas, valor, {
    format: 'CODE128',
    width: 2,           // grosor de la barra más fina (px)
    height: 60,         // alto de las barras
    displayValue: true, // imprime el número debajo (fallback manual)
    fontSize: 16,
    textMargin: 2,
    margin: 8,          // zona de silencio: sin esto el escáner no lee
    background: '#ffffff',
    lineColor: '#000000',
    ...opciones,
  })

  const dataUrl = canvas.toDataURL('image/png')
  const base64 = dataUrl.split(',')[1]
  const bin = atob(base64)
  const bytes = new Uint8Array(bin.length)
  for (let i = 0; i < bin.length; i++) bytes[i] = bin.charCodeAt(i)
  return bytes
}

// Normaliza lo que llega del escáner o del teclado.
// El lector escribe el texto y manda Enter, igual que un teclado.
export function normalizarEscaneo(valor) {
  if (!valor) return ''
  let v = String(valor).replace(/[#\s.\-/]/g, '').trim()
  if (/^\d+$/.test(v)) v = String(parseInt(v, 10)) // "001595" → "1595"
  return v
}
