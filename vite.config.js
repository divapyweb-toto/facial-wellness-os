import { defineConfig } from 'vite'
import react from '@vitejs/plugin-react'

// Sello de compilación: se inyecta la fecha/hora real de cada build para que
// la app pueda mostrarla. Sirve para saber, mirando la pantalla, si el
// navegador está corriendo la última versión desplegada o una vieja en caché.
const BUILD_ID = new Date().toLocaleString('es-PY', {
  day: '2-digit', month: '2-digit', hour: '2-digit', minute: '2-digit', hour12: false,
})

export default defineConfig({
  plugins: [react()],
  define: {
    __BUILD_ID__: JSON.stringify(BUILD_ID),
  },
  base: '/facial-wellness-os/',
  build: {
    outDir: 'dist',
    emptyOutDir: true,
    // Historia: separar CADA librería en su propio archivo rompió la app (lucide-react quedaba separado de
    // React → "reading 'forwardRef'"). 11-10: separación SEGURA y mínima: React, react-dom, scheduler,
    // el router y lucide-react van JUNTOS en 'vendor' (los íconos siempre al lado de React), y Supabase
    // (que no depende de React) aparte. Todo lo demás (gráficos, xlsx, docx…) lo sigue armando Vite solo.
    // Beneficio: esos archivos casi nunca cambian, el navegador los guarda y cada despliegue baja solo el
    // código propio.
    rollupOptions: {
      output: {
        manualChunks(id) {
          if (!id.includes('node_modules')) return undefined
          if (/node_modules\/@supabase\//.test(id)) return 'supabase'
          if (/node_modules\/(react|react-dom|scheduler|react-router|react-router-dom|@remix-run|lucide-react)\//.test(id)) return 'vendor'
          return undefined
        },
      },
    },
  },
})
