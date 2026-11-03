// src/lib/unirPdf.js
// ═══════════════════════════════════════════════════════════
// UNIR VARIOS PDF EN UNO (pdf-lib)
//
// Recibe los PDF como ArrayBuffer/Uint8Array (ya bajados) y devuelve los
// bytes de un solo PDF con todas las páginas, en el mismo orden.
// No baja nada ni toca la base: eso lo hace quien llama.
//
// Si un PDF viene roto:
//   · sin `alFallar` → se corta todo con un error que dice cuál (posición).
//   · con `alFallar(i, error)` → se avisa y se saltea ese, sigue con el resto.
// ═══════════════════════════════════════════════════════════

import { PDFDocument } from 'pdf-lib'

/**
 * @param {(ArrayBuffer|Uint8Array)[]} buffers
 * @param {{ alFallar?: (indice: number, error: Error) => void }} [opciones]
 * @returns {Promise<Uint8Array>}
 */
export async function unirPdf(buffers, { alFallar } = {}) {
  const destino = await PDFDocument.create()
  const lista = buffers || []
  for (let i = 0; i < lista.length; i++) {
    try {
      // Algunos emisores protegen el PDF contra edición: igual se puede copiar
      // la página para imprimir.
      const origen = await PDFDocument.load(lista[i], { ignoreEncryption: true })
      const paginas = await destino.copyPages(origen, origen.getPageIndices())
      for (const p of paginas) destino.addPage(p)
    } catch (e) {
      if (!alFallar) throw new Error(`El PDF n.º ${i + 1} no se pudo leer: ${e?.message || e}`)
      alFallar(i, e)
    }
  }
  return destino.save()
}
