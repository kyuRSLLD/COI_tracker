/**
 * Pre-renders the marketing routes into dist/prerendered/*.html so the raw HTML
 * response contains the full page copy, headings, pricing and FAQ — not just a
 * head and an empty #root. AI crawlers and link unfurlers do not run JavaScript.
 *
 * Runs after `vite build` (client bundle) and `vite build --ssr` (entry-server).
 */
import fs from 'node:fs'
import path from 'node:path'
import { fileURLToPath, pathToFileURL } from 'node:url'

const here = path.dirname(fileURLToPath(import.meta.url))
const root = path.resolve(here, '..')
const dist = path.join(root, 'dist')
const ssrDir = path.join(root, 'dist-ssr')

const OUTPUT = {
  '/': 'home.html',
  '/pricing': 'pricing.html',
  '/solutions/subcontractor-coi-tracking': 'solutions/subcontractor-coi-tracking.html',
  '/industries/remodeling-contractor-compliance': 'industries/remodeling-contractor-compliance.html',
  '/features/acord-25-endorsement-verification': 'features/acord-25-endorsement-verification.html',
  '/tools/insurance-clause-generator': 'tools/insurance-clause-generator.html',
}

const template = fs.readFileSync(path.join(dist, 'index.html'), 'utf8')
const entry = path.join(ssrDir, 'entry-server.js')
if (!fs.existsSync(entry)) {
  console.error(`[prerender] missing ${entry} — run the SSR build first`)
  process.exit(1)
}
const { render, structuredData, PRERENDER_ROUTES } = await import(pathToFileURL(entry).href)

let written = 0
for (const route of PRERENDER_ROUTES) {
  const file = OUTPUT[route]
  if (!file) {
    console.warn(`[prerender] no output path for ${route}, skipping`)
    continue
  }
  const markup = render(route)
  let html = template.replace('<div id="root"></div>', `<div id="root">${markup}</div>`)
  if (html === template) {
    console.error('[prerender] could not find <div id="root"></div> in dist/index.html')
    process.exit(1)
  }
  const ld = structuredData(route)
  if (ld) {
    html = html.replace('</head>', `    <script type="application/ld+json">${ld}</script>\n  </head>`)
  }
  const out = path.join(dist, 'prerendered', file)
  fs.mkdirSync(path.dirname(out), { recursive: true })
  fs.writeFileSync(out, html)
  written += 1
  console.log(`[prerender] ${route} -> prerendered/${file} (${markup.length} chars of markup)`)
}

if (written !== PRERENDER_ROUTES.length) {
  console.error(`[prerender] wrote ${written} of ${PRERENDER_ROUTES.length} routes`)
  process.exit(1)
}
console.log(`[prerender] done — ${written} routes`)
