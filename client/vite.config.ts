import { defineConfig } from 'vite'
import react from '@vitejs/plugin-react'

export default defineConfig({
  plugins: [react(), {
    // Vite prepends its development client; keep the synchronous secret capture first.
    name: 'staged-fragment-first',
    transformIndexHtml: { order: 'post', handler(html) {
      const capture = html.match(/<script>\s*\/\/ Fragment secrets[\s\S]*?<\/script>/)?.[0]
      if (!capture) throw new Error('Fragment capture script missing')
      return html.replace(capture, '').replace('<head>', `<head>\n    ${capture}`)
    } },
  }],
  server: {
    port: 5173,
    host: '127.0.0.1',
    proxy: {
      '/api': {
        target: 'http://127.0.0.1:5001',
        changeOrigin: true,
      },
      '/uploads': {
        target: 'http://127.0.0.1:5001',
        changeOrigin: true,
      },
    },
  },
  build: {
    outDir: 'dist',
    emptyOutDir: true,
  },
})
