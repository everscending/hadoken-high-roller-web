import { defineConfig } from 'vite'
import react from '@vitejs/plugin-react'
import { resolve } from 'path'

export default defineConfig({
  root: '.',
  build: { outDir: 'dist/client' },
  resolve: { alias: { '@renderer': resolve(__dirname, 'src/client') } },
  plugins: [react()],
  server: {
    proxy: { '/api': 'http://localhost:8787' },
  },
})
