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
    // Nota: NO se separan las librerías en chunks manuales. Se probó y rompía
    // la app (pantalla negra): librerías como lucide-react usan React.forwardRef
    // al cargar, y quedaban en un chunk separado de React → "Cannot read
    // properties of undefined (reading 'forwardRef')". Vite arma los chunks solo.
    // La velocidad de arranque ya se resolvió cargando los gráficos aparte
    // (DashboardCharts.jsx con lazy), que es independiente de esto.
  },
})
