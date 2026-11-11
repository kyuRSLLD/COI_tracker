import { defineConfig } from 'vite'
import react from '@vitejs/plugin-react'
import { resolve } from 'node:path'

export default defineConfig({
  root: resolve(__dirname, '../..'),
  plugins: [react()],
  build: {
    outDir: '/tmp/coi-v2-shell-standalone-dist',
    emptyOutDir: true,
    rollupOptions: { input: resolve(__dirname, 'index.html') },
  },
})
