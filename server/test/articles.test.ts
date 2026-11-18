import { test } from 'node:test'
import assert from 'node:assert/strict'
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { randomUUID } from 'node:crypto'

const tempDir = fs.mkdtempSync(path.join(os.tmpdir(), 'coi-articles-test-'))
process.env.SQLITE_PATH = path.join(tempDir, 'test.sqlite')
process.env.DATABASE_URL = ''
process.env.AWS_S3_BUCKET = ''
process.env.AWS_ACCESS_KEY_ID = ''
process.env.AWS_SECRET_ACCESS_KEY = ''
process.env.AWS_S3_ENDPOINT = ''
process.env.JWT_SECRET = 'articles-test-secret-only'
process.env.NODE_ENV = 'test'

const { createApp } = await import('../src/app.ts')
const { dbRun, dbGet, dbAll, initDatabase } = await import('../src/db/db.ts')
const { signToken } = await import('../src/middleware/auth.ts')

await initDatabase()

const now = () => new Date().toISOString()

async function startServer() {
  const app = await createApp({ maintenanceMode: false })
  const server = app.listen(0, '127.0.0.1')
  await new Promise((r) => server.once('listening', r))
  const port = (server.address() as any).port
  return { port, close: () => server.close() }
}

async function createAdmin() {
  const id = randomUUID()
  const email = `admin-${id}@example.test`
  await dbRun(
    `INSERT INTO users (id, email, password_hash, name, role, created_at) VALUES (?, ?, 'hash', 'Admin', 'admin', ?)`,
    [id, email, now()]
  )
  const token = signToken({ id, email, role: 'admin' })
  return { id, email, token }
}

test('articles seeded from static files into empty DB', async () => {
  const rows = await dbAll<any>('SELECT slug, title, status, position FROM articles ORDER BY position ASC')
  assert.equal(rows.length, 6)
  assert.equal(rows[0].slug, 'pass-workers-comp-audit-subcontractors')
  assert.equal(rows[0].status, 'published')
  for (const r of rows) assert.ok(r.title && r.title.length > 5)
})

test('public GET /articles/ renders hub HTML listing all published articles', async () => {
  const { port, close } = await startServer()
  try {
    const res = await fetch(`http://127.0.0.1:${port}/articles/`)
    assert.equal(res.status, 200)
    const ct = res.headers.get('content-type') || ''
    assert.ok(ct.includes('html'))
    const html = await res.text()
    assert.ok(html.includes('COI and Endorsement Guides for General Contractors | Safecoi'))
    assert.ok(html.includes('/articles/pass-workers-comp-audit-subcontractors/'))
    assert.ok(html.includes('/articles/check-acord-25-before-sub-on-site/'))
    assert.ok(html.includes('/articles/additional-insured-vs-certificate-holder/'))
  } finally {
    close()
  }
})

test('public GET /articles/:slug/ renders article page; GET /articles/:slug redirects', async () => {
  const { port, close } = await startServer()
  try {
    const redir = await fetch(`http://127.0.0.1:${port}/articles/check-acord-25-before-sub-on-site`, {
      redirect: 'manual',
    })
    assert.equal(redir.status, 301)
    assert.equal(redir.headers.get('location'), '/articles/check-acord-25-before-sub-on-site/')

    const res = await fetch(`http://127.0.0.1:${port}/articles/check-acord-25-before-sub-on-site/`)
    assert.equal(res.status, 200)
    const html = await res.text()
    assert.ok(html.includes("What to Check on a Subcontractor's ACORD 25 Before They Step on a Job Site"))
    assert.ok(html.includes('https://safecoi.com/articles/check-acord-25-before-sub-on-site/'))
    assert.ok(html.includes('The certificate is designed to look reassuring.'))
  } finally {
    close()
  }
})

test('static assets under /articles/ fall through and are not intercepted as slugs', async () => {
  const { port, close } = await startServer()
  try {
    const res = await fetch(`http://127.0.0.1:${port}/articles/styles.css`)
    assert.equal(res.status, 200)
    const ct = res.headers.get('content-type') || ''
    assert.ok(ct.includes('css'))
    const css = await res.text()
    assert.ok(css.includes('.site-header'))
  } finally {
    close()
  }
})

test('sitemap.xml is dynamically generated and includes published articles', async () => {
  const { port, close } = await startServer()
  try {
    const res = await fetch(`http://127.0.0.1:${port}/sitemap.xml`)
    assert.equal(res.status, 200)
    const ct = res.headers.get('content-type') || ''
    assert.ok(ct.includes('xml'))
    const xml = await res.text()
    assert.ok(xml.includes('https://safecoi.com/'))
    assert.ok(xml.includes('https://safecoi.com/articles/'))
    assert.ok(xml.includes('https://safecoi.com/articles/check-acord-25-before-sub-on-site/'))
  } finally {
    close()
  }
})

test('admin CRUD: list, get, create (published), update, delete', async () => {
  const { port, close } = await startServer()
  const { token } = await createAdmin()
  const auth = { Authorization: `Bearer ${token}` }
  try {
    // List
    const listRes = await fetch(`http://127.0.0.1:${port}/api/admin/articles`, { headers: auth })
    assert.equal(listRes.status, 200)
    const list = await listRes.json()
    assert.equal(list.articles.length, 6)

    // Get
    const one = list.articles[0]
    const getRes = await fetch(`http://127.0.0.1:${port}/api/admin/articles/${one.id}`, { headers: auth })
    assert.equal(getRes.status, 200)
    const get = await getRes.json()
    assert.ok(get.article.body_html.length > 100)

    // Create published article
    const createRes = await fetch(`http://127.0.0.1:${port}/api/admin/articles`, {
      method: 'POST',
      headers: { ...auth, 'Content-Type': 'application/json' },
      body: JSON.stringify({
        title: 'New Article Test Title',
        slug: 'new-article-test-title',
        description: 'A test description for the new article.',
        tag: 'Endorsements & Coverage',
        reading_time_min: 5,
        body_html: '<h2>First section</h2><p>This is the test body.</p>',
        status: 'published',
      }),
    })
    assert.equal(createRes.status, 201)
    const created = (await createRes.json()).article
    assert.equal(created.slug, 'new-article-test-title')
    assert.equal(created.status, 'published')
    assert.ok(created.published_at)

    // Immediately visible on the public hub
    const hub = await (await fetch(`http://127.0.0.1:${port}/articles/`)).text()
    assert.ok(hub.includes('New Article Test Title'))

    // Immediately visible at its URL
    const page = await (await fetch(`http://127.0.0.1:${port}/articles/new-article-test-title/`)).text()
    assert.ok(page.includes('New Article Test Title'))
    assert.ok(page.includes('This is the test body.'))

    // Update
    const upRes = await fetch(`http://127.0.0.1:${port}/api/admin/articles/${created.id}`, {
      method: 'PUT',
      headers: { ...auth, 'Content-Type': 'application/json' },
      body: JSON.stringify({ title: 'Updated Article Title' }),
    })
    assert.equal(upRes.status, 200)
    const hub2 = await (await fetch(`http://127.0.0.1:${port}/articles/`)).text()
    assert.ok(hub2.includes('Updated Article Title'))

    // Delete
    const delRes = await fetch(`http://127.0.0.1:${port}/api/admin/articles/${created.id}`, {
      method: 'DELETE',
      headers: auth,
    })
    assert.equal(delRes.status, 200)
    const hub3 = await (await fetch(`http://127.0.0.1:${port}/articles/`)).text()
    assert.ok(!hub3.includes('Updated Article Title'))
    assert.ok(!hub3.includes('new-article-test-title'))

    // Slug uniqueness 409
    const dupRes = await fetch(`http://127.0.0.1:${port}/api/admin/articles`, {
      method: 'POST',
      headers: { ...auth, 'Content-Type': 'application/json' },
      body: JSON.stringify({
        title: 'Dup',
        slug: 'pass-workers-comp-audit-subcontractors',
        description: 'dup',
        tag: 'dup',
        body_html: '<p>dup</p>',
      }),
    })
    assert.equal(dupRes.status, 409)

    // Admin endpoints require auth
    const anon = await fetch(`http://127.0.0.1:${port}/api/admin/articles`)
    assert.equal(anon.status, 401)
  } finally {
    close()
  }
})

test('draft articles are hidden from the hub and from anonymous readers, but sitemap includes only published', async () => {
  const { port, close } = await startServer()
  const { token } = await createAdmin()
  const auth = { Authorization: `Bearer ${token}` }
  try {
    const createRes = await fetch(`http://127.0.0.1:${port}/api/admin/articles`, {
      method: 'POST',
      headers: { ...auth, 'Content-Type': 'application/json' },
      body: JSON.stringify({
        title: 'Draft Only',
        slug: 'draft-only',
        description: 'draft description',
        tag: 'Waivers & Risk Transfer',
        body_html: '<p>draft</p>',
        status: 'draft',
      }),
    })
    assert.equal(createRes.status, 201)
    const draft = (await createRes.json()).article

    const hub = await (await fetch(`http://127.0.0.1:${port}/articles/`)).text()
    assert.ok(!hub.includes('Draft Only'))

    const sitemap = await (await fetch(`http://127.0.0.1:${port}/sitemap.xml`)).text()
    assert.ok(!sitemap.includes('/articles/draft-only/'))

    // Publish it
    await fetch(`http://127.0.0.1:${port}/api/admin/articles/${draft.id}`, {
      method: 'PUT',
      headers: { ...auth, 'Content-Type': 'application/json' },
      body: JSON.stringify({ status: 'published' }),
    })
    const hubPub = await (await fetch(`http://127.0.0.1:${port}/articles/`)).text()
    assert.ok(hubPub.includes('Draft Only'))
  } finally {
    close()
  }
})
