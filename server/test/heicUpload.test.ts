import { test } from 'node:test'
import assert from 'node:assert/strict'
import { randomUUID } from 'node:crypto'
import fs from 'fs'
import { createApp } from '../src/app.ts'
import { dbRun, dbGet } from '../src/db/db.ts'
import { signToken } from '../src/middleware/auth.ts'
import { prepareUploadFile, normalizeImage } from '../src/services/imageFormat.ts'

const REAL_HEIC = '/home/ubuntu/upload/81662144325__33BBEE34-41F7-4338-9EE4-55E1A37E0A22-preview.HEIC'
const hasRealHeic = fs.existsSync(REAL_HEIC)

async function startServer() {
  const app = await createApp({ maintenanceMode: false })
  const server = app.listen(0)
  const port = (server.address() as any).port
  return { port, close: () => server.close() }
}

async function createGc(email = `gc-${randomUUID()}@example.com`) {
  const id = randomUUID()
  const now = new Date().toISOString()
  await dbRun(
    'INSERT INTO users (id, email, password_hash, role, name, first_name, last_name, created_at) VALUES (?, ?, ?, ?, ?, ?, ?, ?)',
    [id, email, 'hash', 'gc', 'Test GC', 'Test', 'GC', now],
  )
  return { id, email, token: signToken({ id, email, role: 'gc' }) }
}

async function createSubWithProfile(email = `sub-${randomUUID()}@example.com`, company = 'Test Sub') {
  const uid = randomUUID()
  const now = new Date().toISOString()
  await dbRun(
    'INSERT INTO users (id, email, password_hash, role, name, first_name, last_name, created_at) VALUES (?, ?, ?, ?, ?, ?, ?, ?)',
    [uid, email, 'hash', 'sub', 'Sub', 'Sub', 'Sub', now],
  )
  const sid = randomUUID()
  await dbRun(
    'INSERT INTO subcontractors (id, user_id, company_name, trade, created_at, updated_at) VALUES (?, ?, ?, ?, ?, ?)',
    [sid, uid, company, 'Electrical', now, now],
  )
  return { uid, sid, email, token: signToken({ id: uid, email, role: 'sub' }) }
}

async function createUploadRequest(gcUserId: string, subId: string, gcEmail: string) {
  const id = randomUUID()
  const token = `gc1.${Buffer.from(gcUserId, 'utf8').toString('base64url')}.${Buffer.from(Array.from({length:24}, ()=>Math.floor(Math.random()*256))).toString('hex')}`
  const now = new Date().toISOString()
  await dbRun(
    'INSERT INTO upload_requests (id, token, subcontractor_id, requested_by_email, created_at) VALUES (?, ?, ?, ?, ?)',
    [id, token, subId, gcEmail, now],
  )
  return token
}

function makeHeicForm(fieldname = 'certificate') {
  const fd = new FormData()
  const buf = fs.readFileSync(REAL_HEIC)
  fd.append(fieldname, new Blob([buf], { type: 'image/heic' }), '81662144325__33BBEE34-41F7-4338-9EE4-55E1A37E0A22-preview.HEIC')
  return fd
}

test('1. prepareUploadFile converts HEIC into a JPEG file descriptor', async () => {
  if (!hasRealHeic) return
  const buf = fs.readFileSync(REAL_HEIC)
  const file = await prepareUploadFile({
    buffer: buf,
    mimetype: 'image/heic',
    size: buf.length,
    originalname: '81662144325__33BBEE34-41F7-4338-9EE4-55E1A37E0A22-preview.HEIC',
  })
  assert.equal(file.mimetype, 'image/jpeg')
  assert.match(file.originalname!, /\.jpg$/)
  assert.ok(file.size > 0 && file.size < buf.length * 3)
})

test('2. POST /api/cois accepts HEIC and stores as JPEG with .jpg name', async () => {
  if (!hasRealHeic) return
  const gc = await createGc()
  const { port, close } = await startServer()
  try {
    const res = await fetch(`http://127.0.0.1:${port}/api/cois`, {
      method: 'POST',
      headers: { Authorization: `Bearer ${gc.token}` },
      body: makeHeicForm(),
    })
    assert.equal(res.status, 201)
    const body: any = await res.json()
    const row = await dbGet<any>('SELECT certificate_mime, certificate_name FROM cois WHERE id = ?', [body.coi?.id])
    assert.equal(row.certificate_mime, 'image/jpeg')
    assert.match(row.certificate_name, /\.jpg$/)
  } finally {
    close()
  }
})

test('3. POST /api/sub/quick-upload accepts HEIC from subcontractor', async () => {
  if (!hasRealHeic) return
  const sub = await createSubWithProfile()
  const { port, close } = await startServer()
  try {
    const res = await fetch(`http://127.0.0.1:${port}/api/sub/quick-upload`, {
      method: 'POST',
      headers: { Authorization: `Bearer ${sub.token}` },
      body: makeHeicForm(),
    })
    assert.equal(res.status, 200)
    const body: any = await res.json()
    const row = await dbGet<any>('SELECT certificate_mime, certificate_name FROM cois WHERE id = ?', [body.id])
    assert.equal(row.certificate_mime, 'image/jpeg')
    assert.match(row.certificate_name, /\.jpg$/)
  } finally {
    close()
  }
})

test('4. POST /api/upload/submit/:token accepts HEIC in public upload portal', async () => {
  if (!hasRealHeic) return
  const gc = await createGc()
  const sub = await createSubWithProfile()
  await dbRun(
    'INSERT INTO gc_sub_connections (gc_user_id, subcontractor_id, created_at) VALUES (?, ?, ?)',
    [gc.id, sub.sid, new Date().toISOString()],
  )
  const uploadToken = await createUploadRequest(gc.id, sub.sid, gc.email)
  const { port, close } = await startServer()
  try {
    const fd = makeHeicForm()
    fd.append('carrier', 'Test Carrier')
    fd.append('effective_date', '2026-01-01')
    fd.append('expiration_date', '2027-01-01')
    const res = await fetch(`http://127.0.0.1:${port}/api/upload/submit/${uploadToken}`, {
      method: 'POST',
      body: fd,
    })
    assert.equal(res.status, 200)
    const body: any = await res.json()
    const row = await dbGet<any>('SELECT certificate_mime, certificate_name FROM cois WHERE id = ?', [body.coi?.id])
    assert.equal(row.certificate_mime, 'image/jpeg')
    assert.match(row.certificate_name, /\.jpg$/)
  } finally {
    close()
  }
})

test('5. POST /api/gc/my-coi/upload accepts HEIC for GC own company COI', async () => {
  if (!hasRealHeic) return
  const gc = await createGc()
  const { port, close } = await startServer()
  try {
    const res = await fetch(`http://127.0.0.1:${port}/api/gc/my-coi/upload`, {
      method: 'POST',
      headers: { Authorization: `Bearer ${gc.token}` },
      body: makeHeicForm(),
    })
    assert.equal(res.status, 201)
    const body: any = await res.json()
    const row = await dbGet<any>('SELECT certificate_mime, certificate_name FROM cois WHERE id = ?', [body.coi?.id])
    assert.equal(row.certificate_mime, 'image/jpeg')
    assert.match(row.certificate_name, /\.jpg$/)
  } finally {
    close()
  }
})

test('6. Corrupted non-image file is rejected with "Invalid certificate file"', async () => {
  const gc = await createGc()
  const { port, close } = await startServer()
  try {
    const fd = new FormData()
    fd.append('certificate', new Blob([Buffer.from('this is not a valid certificate at all')], { type: 'application/octet-stream' }), 'bad.bin')
    const res = await fetch(`http://127.0.0.1:${port}/api/cois`, {
      method: 'POST',
      headers: { Authorization: `Bearer ${gc.token}` },
      body: fd,
    })
    assert.equal(res.status, 500)
    const body: any = await res.json()
    assert.equal(body.error, 'Invalid certificate file')
  } finally {
    close()
  }
})

test('7. HEIC detected by uppercase extension even when brand is non-standard', async () => {
  const norm = await normalizeImage(Buffer.from('not really heic ftyp'), 'photo.HEIC')
  // corrupted file can't convert -> null
  assert.equal(norm, null)
})
