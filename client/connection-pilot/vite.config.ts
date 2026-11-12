import { defineConfig } from 'vite'
import react from '@vitejs/plugin-react'
import tailwindcss from 'tailwindcss'
import autoprefixer from 'autoprefixer'
import tailwindConfig from '../tailwind.config.js'
import { fileURLToPath } from 'node:url'

const root = fileURLToPath(new URL('.', import.meta.url))
export default defineConfig({
  root,
  base: '/',
  publicDir: false,
  plugins: [react()],
  css: { postcss: { plugins: [tailwindcss({ ...tailwindConfig, content: [fileURLToPath(new URL('../src/v2-auth/**/*.{ts,tsx}', import.meta.url))] }), autoprefixer()] } },
  build: {
    outDir: fileURLToPath(new URL('./dist', import.meta.url)),
    emptyOutDir: true,
    sourcemap: false,
    assetsInlineLimit: 0,
  },
})
