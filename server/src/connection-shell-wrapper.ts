import express from 'express'
import type { Express } from 'express'
import { lstatSync, readFileSync, readdirSync } from 'node:fs'
import { join } from 'node:path'

const CSP = "default-src 'none'; script-src 'self'; style-src 'self'; connect-src 'self'; img-src 'self'; media-src 'self'; font-src 'self'; base-uri 'none'; form-action 'none'; frame-ancestors 'none'; object-src 'none'; worker-src 'none'"
const MAX_FILE = 4 * 1024 * 1024
const MAX_TOTAL = 8 * 1024 * 1024

type Asset = { bytes: Buffer; contentType: string }
function loadFile(path: string): Buffer {
  const stat = lstatSync(path)
  if (!stat.isFile() || stat.isSymbolicLink() || stat.size > MAX_FILE) throw new Error('Invalid build output')
  const bytes = readFileSync(path)
  if (bytes.length !== stat.size) throw new Error('Invalid build output')
  return bytes
}

/** Reads only expected build output at construction; never reads request paths from disk. */
export function createConnectionShell(pilot: Express, outputDirectory: string): Express {
  const root = lstatSync(outputDirectory)
  const assetDir = join(outputDirectory, 'assets')
  const assetsDir = lstatSync(assetDir)
  if (!root.isDirectory() || root.isSymbolicLink() || !assetsDir.isDirectory() || assetsDir.isSymbolicLink()) throw new Error('Invalid build output')
  const index = loadFile(join(outputDirectory, 'index.html'))
  const assets = new Map<string, Asset>()
  let total = index.length
  for (const name of readdirSync(assetDir)) {
    // Strict Vite-hashed assets only; no directories, arbitrary files or path fallback.
    if (!/^[A-Za-z0-9_-]+-[A-Za-z0-9_-]{8}\.(?:js|css)$/.test(name)) throw new Error('Invalid build output')
    const bytes = loadFile(join(assetDir, name))
    total += bytes.length
    if (total > MAX_TOTAL || assets.size >= 64) throw new Error('Invalid build output')
    assets.set(`/assets/${name}`, { bytes, contentType: name.endsWith('.js') ? 'text/javascript; charset=utf-8' : 'text/css; charset=utf-8' })
  }
  if (!assets.size) throw new Error('Invalid build output')
  const app = express()
  app.disable('x-powered-by'); app.disable('etag')
  app.use((req, res, next) => {
    // Existing browser cookies are not application credentials; never forward them.
    delete req.headers.cookie
    const original = res.setHeader
    res.setHeader = function(this: typeof res, name, value) {
      if (name.toLowerCase() === 'set-cookie') return this
      return original.call(this, name, value)
    } as typeof res.setHeader
    const writeHead = res.writeHead
    res.writeHead = function(this: typeof res, status: number, ...args: any[]) {
      this.removeHeader('set-cookie')
      const idx = typeof args[0] === 'string' ? 1 : 0
      const headers = args[idx]
      if (Array.isArray(headers)) {
        const filtered: string[] = []
        for (let i = 0; i < headers.length; i += 2) if (String(headers[i]).toLowerCase() !== 'set-cookie') filtered.push(headers[i], headers[i + 1])
        args[idx] = filtered
      } else if (headers && typeof headers === 'object') {
        args[idx] = Object.fromEntries(Object.entries(headers).filter(([name]) => name.toLowerCase() !== 'set-cookie'))
      }
      return (writeHead as any).call(this, status, ...args)
    } as typeof res.writeHead
    res.set({ 'Cache-Control': 'no-store', 'Pragma': 'no-cache', 'X-Content-Type-Options': 'nosniff', 'Referrer-Policy': 'no-referrer', 'X-Frame-Options': 'DENY', 'Content-Security-Policy': CSP, 'Permissions-Policy': 'camera=(self), microphone=(), geolocation=()' })
    next()
  })
  app.use((req, res, next) => {
    const length = req.headers['content-length']
    if (length && (!/^[0-9]+$/.test(length) || Number(length) > 8192)) { res.status(413).end(); return }
    if ((req.method === 'GET' || req.method === 'HEAD') && (req.headers['transfer-encoding'] || (length && Number(length) !== 0))) { res.status(400).end(); return }
    if ((req.url === '/' || assets.has(req.url)) && (req.method === 'GET' || req.method === 'HEAD')) {
      const asset = req.url === '/' ? { bytes: index, contentType: 'text/html; charset=utf-8' } : assets.get(req.url)!
      res.set('Content-Type', asset.contentType).set('Content-Length', String(asset.bytes.length))
      res.end(req.method === 'HEAD' ? undefined : asset.bytes)
      return
    }
    // createPilot applies its own exact allowlist, security headers, limits and API routing.
    if (req.url === '/healthz' || req.url.startsWith('/api/v2/')) { next(); return }
    res.status(404).end()
  })
  app.use(pilot)
  app.use((_req, res) => { res.status(404).end() })
  return app
}
