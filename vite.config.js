import { defineConfig } from 'vite'
import react from '@vitejs/plugin-react'

export default defineConfig({
  plugins: [react()],
  base: '/facial-wellness-os/',
  build: {
    outDir: 'dist',
    emptyOutDir: true,
  }
})
