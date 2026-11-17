import { test } from 'node:test'
import assert from 'node:assert/strict'
import { randomUUID } from 'node:crypto'
import { createApp } from '../src/app.ts'
import { dbRun, dbGet, dbAll } from '../src/db/db.ts'
import { signToken } from '../src/middleware/auth.ts'
import fs from 'fs'

async function startServer() {
  const app = await createApp({ maintenanceMode: false })
  const server = app.listen(0)
  const port = (server.address() as any).port
  return { port, close: () => server.close() }
}

async function createGc(company = 'Apex Contractors Inc.') {
  const id = randomUUID()
  const email = `gc-${id}@example.com`
  const now = new Date().toISOString()
  await dbRun(
    'INSERT INTO users (id, email, password_hash, role, name, first_name, last_name, company_name, created_at) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)',
    [id, email, 'hash', 'gc', 'Test GC', 'Test', 'GC', company, now],
  )
  return { id, email, company, token: signToken({ id, email, role: 'gc' }) }
}

async function createSub() {
  const id = randomUUID()
  const email = `sub-${id}@example.com`
  const now = new Date().toISOString()
  await dbRun(
    'INSERT INTO users (id, email, password_hash, role, name, first_name, last_name, created_at) VALUES (?, ?, ?, ?, ?, ?, ?, ?)',
    [id, email, 'hash', 'sub', 'Sub', 'Sub', 'Sub', now],
  )
  return { id, email, token: signToken({ id, email, role: 'sub' }) }
}

function pdfForm(eff = '2026-01-01', exp = '2027-01-01') {
  const fd = new FormData()
  fd.append('certificate', new Blob([Buffer.from('%PDF-1.4 test')], { type: 'application/pdf' }), 'cert.pdf')
  fd.append('carrier', 'Travelers')
  fd.append('policy_number', 'POL-1')
  fd.append('effective_date', eff)
  fd.append('expiration_date', exp)
  return fd
}

test('1. GET /api/gc/my-coi returns null COI when none on file', async () => {
  const gc = await createGc()
  const { port, close } = await startServer()
  try {
    const res = await fetch(`http://127.0.0.1:${port}/api/gc/my-coi`, {
      headers: { Authorization: `Bearer ${gc.token}` },
    })
    assert.equal(res.status, 200)
    const body: any = await res.json()
    assert.equal(body.company_name, gc.company)
    assert.equal(body.coi, null)
    assert.equal(body.share, null)
  } finally {
    close()
  }
})

test('2. POST /api/gc/my-coi/upload stores company COI with status pending_review', async () => {
  const gc = await createGc()
  const { port, close } = await startServer()
  try {
    const res = await fetch(`http://127.0.0.1:${port}/api/gc/my-coi/upload`, {
      method: 'POST',
      headers: { Authorization: `Bearer ${gc.token}` },
      body: pdfForm(),
    })
    assert.equal(res.status, 201)
    const body: any = await res.json()
    assert.equal(body.coi.status, 'pending_review')
    assert.equal(body.coi.is_company_coi, 1)

    const full = await fetch(`http://127.0.0.1:${port}/api/gc/my-coi`, {
      headers: { Authorization: `Bearer ${gc.token}` },
    }).then((r) => r.json()) as any
    assert.equal(full.coi.id, body.coi.id)
  } finally {
    close()
  }
})

test('3. POST /api/gc/my-coi/validate marks the company COI compliant', async () => {
  const gc = await createGc()
  const { port, close } = await startServer()
  try {
    await fetch(`http://127.0.0.1:${port}/api/gc/my-coi/upload`, {
      method: 'POST',
      headers: { Authorization: `Bearer ${gc.token}` },
      body: pdfForm(),
    })
    const res = await fetch(`http://127.0.0.1:${port}/api/gc/my-coi/validate`, {
      method: 'POST',
      headers: { Authorization: `Bearer ${gc.token}` },
    })
    assert.equal(res.status, 200)
    const body: any = await res.json()
    assert.equal(body.coi.status, 'compliant')

    const row = await dbGet<any>('SELECT status FROM cois WHERE id = ?', [body.coi.id])
    assert.equal(row.status, 'compliant')
  } finally {
    close()
  }
})

test('4. POST /api/gc/my-coi/validate rejects already-expired COI', async () => {
  const gc = await createGc()
  const { port, close } = await startServer()
  try {
    await fetch(`http://127.0.0.1:${port}/api/gc/my-coi/upload`, {
      method: 'POST',
      headers: { Authorization: `Bearer ${gc.token}` },
      body: pdfForm('2024-01-01', '2024-12-31'),
    })
    const res = await fetch(`http://127.0.0.1:${port}/api/gc/my-coi/validate`, {
      method: 'POST',
      headers: { Authorization: `Bearer ${gc.token}` },
    })
    assert.equal(res.status, 400)
    const body: any = await res.json()
    assert.match(body.error, /expired/i)
  } finally {
    close()
  }
})

test('5. POST /api/gc/my-coi/share creates public share link and returns sanitized record without auth', async () => {
  const gc = await createGc()
  const { port, close } = await startServer()
  try {
    await fetch(`http://127.0.0.1:${port}/api/gc/my-coi/upload`, {
      method: 'POST',
      headers: { Authorization: `Bearer ${gc.token}` },
      body: pdfForm(),
    })
    const shareRes = await fetch(`http://127.0.0.1:${port}/api/gc/my-coi/share`, {
      method: 'POST',
      headers: { Authorization: `Bearer ${gc.token}`, 'Content-Type': 'application/json' },
      body: JSON.stringify({ expires_in_days: 90 }),
    })
    assert.equal(shareRes.status, 201)
    const share: any = await shareRes.json()
    assert.ok(share.token && share.url.startsWith('/share/company/'))

    const pub = await fetch(`http://127.0.0.1:${port}/api/public/company-share/${share.token}`)
    assert.equal(pub.status, 200)
    const pubBody: any = await pub.json()
    assert.equal(pubBody.company.company_name, gc.company)
    assert.equal(pubBody.coi.carrier, 'Travelers')
    assert.equal(pubBody.coi.status, 'pending_review')
    // No secrets/keys leaked
    assert.equal(pubBody.coi.certificate_key, undefined)
    assert.equal(pubBody.coi.certificate_url, undefined)
  } finally {
    close()
  }
})

test('6. Expired share link returns 410', async () => {
  const gc = await createGc()
  const { port, close } = await startServer()
  try {
    await fetch(`http://127.0.0.1:${port}/api/gc/my-coi/upload`, {
      method: 'POST',
      headers: { Authorization: `Bearer ${gc.token}` },
      body: pdfForm(),
    })
    const share: any = await fetch(`http://127.0.0.1:${port}/api/gc/my-coi/share`, {
      method: 'POST',
      headers: { Authorization: `Bearer ${gc.token}`, 'Content-Type': 'application/json' },
      body: JSON.stringify({ expires_in_days: 1 }),
    }).then((r) => r.json())
    await dbRun('UPDATE company_share_links SET expires_at = ? WHERE token = ?', [new Date(Date.now() - 60000).toISOString(), share.token])
    const res = await fetch(`http://127.0.0.1:${port}/api/public/company-share/${share.token}`)
    assert.equal(res.status, 410)
  } finally {
    close()
  }
})

test('7. Company sub record is excluded from subcontractors list', async () => {
  const gc = await createGc()
  const { port, close } = await startServer()
  try {
    await fetch(`http://127.0.0.1:${port}/api/gc/my-coi`, {
      headers: { Authorization: `Bearer ${gc.token}` },
    })
    const res = await fetch(`http://127.0.0.1:${port}/api/subcontractors`, {
      headers: { Authorization: `Bearer ${gc.token}` },
    })
    assert.equal(res.status, 200)
    const body: any = await res.json()
    const names = body.subcontractors.map((s: any) => s.company_name)
    assert.ok(!names.includes(gc.company))
  } finally {
    close()
  }
})

test('8. Subcontractor users are rejected from /api/gc/ routes', async () => {
  const sub = await createSub()
  const { port, close } = await startServer()
  try {
    const res = await fetch(`http://127.0.0.1:${port}/api/gc/my-coi`, {
      headers: { Authorization: `Bearer ${sub.token}` },
    })
    assert.equal(res.status, 403)
  } finally {
    close()
  }
})

test('9. New version upload replaces the active company COI', async () => {
  const gc = await createGc()
  const { port, close } = await startServer()
  try {
    const r1: any = await fetch(`http://127.0.0.1:${port}/api/gc/my-coi/upload`, {
      method: 'POST',
      headers: { Authorization: `Bearer ${gc.token}` },
      body: pdfForm('2026-01-01', '2027-01-01'),
    }).then((r) => r.json())
    const r2: any = await fetch(`http://127.0.0.1:${port}/api/gc/my-coi/upload`, {
      method: 'POST',
      headers: { Authorization: `Bearer ${gc.token}` },
      body: pdfForm('2027-01-01', '2028-01-01'),
    }).then((r) => r.json())
    assert.notEqual(r1.coi.id, r2.coi.id)
    const cur: any = await fetch(`http://127.0.0.1:${port}/api/gc/my-coi`, {
      headers: { Authorization: `Bearer ${gc.token}` },
    }).then((r) => r.json())
    assert.equal(cur.coi.id, r2.coi.id)
  } finally {
    close()
  }
})
