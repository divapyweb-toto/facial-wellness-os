import { defineConfig } from 'vite'
import react from '@vitejs/plugin-react'

export default defineConfig({
  plugins: [react()],
  base: '/facial-wellness-os/',
  build: {
    outDir: 'dist',
    emptyOutDir: true,
    // Separar las librerías pesadas en archivos propios. Así el navegador las
    // cachea una vez y no las vuelve a bajar cuando cambia tu código — solo
    // re-baja el chunk chico que cambió, no los ~18 MB de librerías.
    //
    // Se usa la forma de FUNCIÓN (no objeto) a propósito: agrupa por lo que
    // realmente aparece en el árbol de imports, sin romper si alguna librería
    // no está instalada.
    rollupOptions: {
      output: {
        manualChunks(id) {
          if (!id.includes('node_modules')) return
          if (id.includes('recharts') || id.includes('d3-')) return 'vendor-charts'
          if (id.includes('xlsx') || id.includes('exceljs')) return 'vendor-excel'
          if (id.includes('docx')) return 'vendor-docx'
          if (id.includes('leaflet')) return 'vendor-map'
          if (id.includes('/react') || id.includes('/scheduler') || id.includes('react-router') || id.includes('react-dom')) return 'vendor-react'
          return 'vendor'
        },
      },
    },
    chunkSizeWarningLimit: 1500,
  },
})
