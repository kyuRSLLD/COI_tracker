import { test } from 'node:test'
import assert from 'node:assert/strict'
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import {
  MARKETING_META,
  injectMarketingMeta,
  isKnownRoute,
  renderNotFoundHtml,
} from '../src/seo.ts'

const tempDir = fs.mkdtempSync(path.join(os.tmpdir(), 'coi-seo-test-'))
process.env.SQLITE_PATH = path.join(tempDir, 'test.sqlite')
process.env.DATABASE_URL = ''
process.env.AWS_S3_BUCKET = ''
process.env.AWS_ACCESS_KEY_ID = ''
process.env.AWS_SECRET_ACCESS_KEY = ''
process.env.AWS_S3_ENDPOINT = ''
process.env.JWT_SECRET = 'seo-test-secret-only'
process.env.NODE_ENV = 'test'

const { createApp } = await import('../src/app.ts')
const { initDatabase } = await import('../src/db/db.ts')
await initDatabase()

async function startServer() {
  const app = await createApp({ maintenanceMode: false })
  const server = app.listen(0, '127.0.0.1')
  await new Promise((r) => server.once('listening', r))
  const port = (server.address() as any).port
  return { port, close: () => server.close() }
}

const TEMPLATE = `<!doctype html><html><head>
<title>Default Title | Safecoi</title>
<meta name="description" content="Default description" />
<link rel="canonical" href="https://safecoi.com/" />
<meta property="og:type" content="website" />
<meta property="og:site_name" content="Safecoi" />
<meta property="og:title" content="Default Title | Safecoi" />
<meta property="og:description" content="Default description" />
<meta property="og:url" content="https://safecoi.com/" />
<meta property="og:image" content="https://safecoi.com/articles/assets/og/home.png" />
<meta name="twitter:card" content="summary_large_image" />
<meta name="twitter:title" content="Default Title | Safecoi" />
<meta name="twitter:description" content="Default description" />
<meta name="twitter:image" content="https://safecoi.com/articles/assets/og/home.png" />
</head><body><div id="root"></div></body></html>`

test('unit: injectMarketingMeta rewrites title, description, canonical, OG, Twitter tags', () => {
  const out = injectMarketingMeta(TEMPLATE, {
    title: 'Test Title & "Escaped" <Tags>',
    description: 'Test description with <b>HTML</b>',
    canonical: 'https://safecoi.com/test',
    ogImage: 'https://safecoi.com/articles/assets/og/solutions.png',
  })
  assert.ok(out.includes('<title>Test Title &amp; &quot;Escaped&quot; &lt;Tags&gt;</title>'))
  assert.ok(out.includes('content="Test description with &lt;b&gt;HTML&lt;/b&gt;"'))
  assert.ok(out.includes('href="https://safecoi.com/test"'))
  assert.ok(out.includes('property="og:title" content="Test Title &amp; &quot;Escaped&quot; &lt;Tags&gt;"'))
  assert.ok(out.includes('property="og:url" content="https://safecoi.com/test"'))
  assert.ok(out.includes('property="og:image" content="https://safecoi.com/articles/assets/og/solutions.png"'))
  assert.ok(out.includes('name="twitter:image" content="https://safecoi.com/articles/assets/og/solutions.png"'))
})

test('unit: isKnownRoute whitelists known routes and prefixes only', () => {
  assert.equal(isKnownRoute('/'), true)
  assert.equal(isKnownRoute('/pricing'), true)
  assert.equal(isKnownRoute('/login'), true)
  assert.equal(isKnownRoute('/dashboard'), true)
  assert.equal(isKnownRoute('/share/abc-123'), true)
  assert.equal(isKnownRoute('/upload/token-xyz'), true)
  assert.equal(isKnownRoute('/join/code-789'), true)
  assert.equal(isKnownRoute('/staff/coi/coi-id-1'), true)
  // trailing slashes tolerated
  assert.equal(isKnownRoute('/pricing/'), true)
  // unknown routes -> false (the soft-404 kill test)
  assert.equal(isKnownRoute('/about'), false)
  assert.equal(isKnownRoute('/industries/commercial-construction'), false)
  assert.equal(isKnownRoute('/legal/privacy'), false)
  assert.equal(isKnownRoute('/definitely-unknown-path-xyz'), false)
  assert.equal(isKnownRoute('/share/'), false)
})

test('unit: renderNotFoundHtml returns noindex document with the path and home links', () => {
  const html = renderNotFoundHtml('/fake-page<script>')
  assert.ok(html.includes('<title>Page not found | Safecoi</title>'))
  assert.ok(html.includes('content="noindex, follow"'))
  assert.ok(html.includes('&lt;script&gt;'))
  assert.ok(html.includes('href="/"'))
  assert.ok(html.includes('href="/pricing"'))
  assert.ok(html.includes('href="/articles/"'))
})

test('integration: /pricing returns 200 with route-specific metadata', async () => {
  const { port, close } = await startServer()
  try {
    const res = await fetch(`http://127.0.0.1:${port}/pricing`)
    assert.equal(res.status, 200)
    assert.ok((res.headers.get('content-type') || '').includes('html'))
    const html = await res.text()
    assert.ok(html.includes('<title>SafeCOI Pricing'))
    assert.ok(html.includes('10/month'))
    assert.ok(html.includes('canonical" href="https://safecoi.com/pricing"'))
  } finally {
    close()
  }
})

test('integration: / (homepage) prerenders with home OG image', async () => {
  const { port, close } = await startServer()
  try {
    const res = await fetch(`http://127.0.0.1:${port}/`)
    assert.equal(res.status, 200)
    const html = await res.text()
    assert.ok(html.includes('COI Tracking & Validation Software for Contractors | Safecoi'))
    assert.ok(html.includes('property="og:image" content="https://safecoi.com/articles/assets/og/home.png"'))
  } finally {
    close()
  }
})

test('integration: each marketing page prerenders with its own OG image', async () => {
  const { port, close } = await startServer()
  try {
    const tests = [
      ['/solutions/subcontractor-coi-tracking', 'solutions.png', 'Subcontractor COI Tracking Software'],
      ['/industries/remodeling-contractor-compliance', 'remodeling.png', 'Remodelers &amp; Home Repair'],
      ['/features/acord-25-endorsement-verification', 'verification.png', 'ACORD 25 &amp; Endorsement Verification'],
      ['/tools/insurance-clause-generator', 'tool.png', 'Insurance Clause &amp; Requirement Generator'],
    ]
    for (const [route, ogImg, titleSnippet] of tests) {
      const res = await fetch(`http://127.0.0.1:${port}${route}`)
      assert.equal(res.status, 200, `${route} should return 200`)
      const html = await res.text()
      assert.ok(html.includes(titleSnippet), `${route} title`)
      assert.ok(
        html.includes(`content="https://safecoi.com/articles/assets/og/${ogImg}"`),
        `${route} og:image`
      )
    }
  } finally {
    close()
  }
})

test('integration: unknown routes return a real 404 (no soft-404)', async () => {
  const { port, close } = await startServer()
  try {
    for (const bad of [
      '/this-page-definitely-does-not-exist-xyz',
      '/about',
      '/legal/privacy',
      '/industries/commercial-construction',
    ]) {
      const res = await fetch(`http://127.0.0.1:${port}${bad}`)
      assert.equal(res.status, 404, `${bad} should return 404`)
      const html = await res.text()
      assert.ok(html.includes('Page not found'), `${bad} body`)
      assert.ok(html.includes('noindex'), `${bad} noindex`)
    }
  } finally {
    close()
  }
})

test('integration: unknown article slugs return 404 with noindex', async () => {
  const { port, close } = await startServer()
  try {
    const res = await fetch(`http://127.0.0.1:${port}/articles/this-article-does-not-exist-xyz/`)
    assert.equal(res.status, 404)
    const html = await res.text()
    assert.ok(html.includes('Page not found'))
    assert.ok(html.includes('noindex'))
  } finally {
    close()
  }
})

test('integration: known authenticated routes still serve index.html (200)', async () => {
  const { port, close } = await startServer()
  try {
    for (const route of ['/login', '/dashboard', '/share/test-share-123', '/upload/test-upload-456']) {
      const res = await fetch(`http://127.0.0.1:${port}${route}`)
      assert.equal(res.status, 200, `${route} should serve app shell`)
      const html = await res.text()
      assert.ok(html.includes('id="root"'), `${route} has root div`)
    }
  } finally {
    close()
  }
})

test('integration: sitemap.xml includes /pricing and no phantom routes', async () => {
  const { port, close } = await startServer()
  try {
    const res = await fetch(`http://127.0.0.1:${port}/sitemap.xml`)
    assert.equal(res.status, 200)
    assert.ok((res.headers.get('content-type') || '').includes('xml'))
    const xml = await res.text()
    assert.ok(xml.includes('<loc>https://safecoi.com/pricing</loc>'))
    assert.ok(xml.includes('<loc>https://safecoi.com/solutions/subcontractor-coi-tracking</loc>'))
    assert.ok(!xml.includes('/about</loc>'))
    assert.ok(!xml.includes('/legal/'))
    assert.ok(!xml.includes('commercial-construction'))
  } finally {
    close()
  }
})
