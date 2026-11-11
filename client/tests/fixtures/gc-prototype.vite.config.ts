import { defineConfig } from 'vite'
import react from '@vitejs/plugin-react'
import { resolve } from 'node:path'

export default defineConfig({
  root: resolve(__dirname, '../..'),
  envDir: process.env.GC_TEST_ENV_DIR,
  plugins: [react()],
  build: {
    outDir: process.env.GC_TEST_OUT_DIR || '/tmp/gc-prototype-ui-build',
    emptyOutDir: true,
    rollupOptions: { input: resolve(__dirname, 'gc-prototype.html') },
  },
})
