import { defineConfig } from 'vite'
import react from '@vitejs/plugin-react'

export default defineConfig({
  plugins: [react()],
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
