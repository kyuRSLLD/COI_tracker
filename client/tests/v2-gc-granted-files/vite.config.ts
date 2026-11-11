import { defineConfig } from 'vite'
import react from '@vitejs/plugin-react'
import { resolve } from 'node:path'

export default defineConfig({
  plugins: [react()],
  cacheDir: '/tmp/coi-gc-granted-files-vite-cache',
  build: { rollupOptions: { input: resolve(__dirname, 'index.html') } },
})
