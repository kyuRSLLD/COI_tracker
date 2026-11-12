import { defineConfig } from 'vite'
import react from '@vitejs/plugin-react'
import { fileURLToPath } from 'node:url'

const port = process.env.E2E_BACKEND_PORT
if (!port || !/^[1-9][0-9]{0,4}$/.test(port) || Number(port) > 65535) throw new Error('Explicit loopback backend port required')
export default defineConfig({
  root: fileURLToPath(new URL('../../', import.meta.url)), plugins: [react()],
  server: { host: '127.0.0.1', strictPort: true, proxy: { '/api': `http://127.0.0.1:${port}` } },
})
