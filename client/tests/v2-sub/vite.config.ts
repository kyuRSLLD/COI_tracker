import { defineConfig } from 'vite'
import react from '@vitejs/plugin-react'
import { fileURLToPath } from 'node:url'

// Explicitly builds the test harness, not the legacy application's entry point.
export default defineConfig({
  plugins: [react()],
  root: fileURLToPath(new URL('../../', import.meta.url)),
  build: { rollupOptions: { input: fileURLToPath(new URL('./index.html', import.meta.url)) } },
})
