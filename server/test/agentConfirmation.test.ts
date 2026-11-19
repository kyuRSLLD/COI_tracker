import test from 'node:test'
import assert from 'node:assert/strict'
import { randomUUID } from 'node:crypto'
import { initDatabase, dbRun, dbGet, dbAll } from '../src/db/db.ts'
import { createApp } from '../src/app.ts'
import { signToken } from '../src/middleware/auth.ts'
import {
  createAgentApiKey,
  verifyAgentKey,
  revokeAgentKey,
  listAgentKeys,
  buildCoiBrief,
  listConfirmationQueue,
  dispatchCall,
  recordCallResult,
  sendConfirmationEmail,
  recordEmailResult,
  listConfirmations,
} from '../src/services/agentConfirmation.ts'

let port = 0
let server: any

async function start() {
  await initDatabase()
  const app = await createApp()
  server = app.listen(0)
  port = (server.address() as any).port
}

function stop() {
  server?.close()
}

async function mkAdmin(): Promise<{ id: string; email: string; token: string }> {
  const id = randomUUID()
  const email = `admin-${id}@test.local`
  await dbRun(
    "INSERT INTO users (id, email, password_hash, name, role, created_at) VALUES (?, ?, 'x', 'Admin', 'admin', ?)",
    [id, email, new Date().toISOString()],
  )
  return { id, email, token: signToken({ id, email, role: 'admin' }) }
}

async function mkCoi(withReview?: any): Promise<string> {
  const now = new Date().toISOString()
  const gcId = randomUUID()
  const subId = randomUUID()
  const coiId = randomUUID()
  await dbRun("INSERT INTO users (id, email, password_hash, name, role, created_at) VALUES (?, ?, 'x', 'GC', 'gc', ?)", [gcId, `gc-${gcId}@t.l`, now])
  await dbRun("INSERT INTO users (id, email, password_hash, name, role, created_at) VALUES (?, ?, 'x', 'Sub', 'subcontractor', ?)", [subId, `sub-${subId}@t.l`, now])
  await dbRun("INSERT INTO subcontractors (id, user_id, company_name, trade, created_at, updated_at) VALUES (?, ?, ?, 'Roofing', ?, ?)", [subId, subId, 'Acme Roofing', now, now])
  await dbRun("INSERT INTO gc_sub_connections (gc_user_id, subcontractor_id, created_at) VALUES (?, ?, ?)", [gcId, subId, now])
  await dbRun(
    `INSERT INTO cois (id, subcontractor_id, carrier, policy_number, effective_date, expiration_date, status, certificate_key, created_at, updated_at)
     VALUES (?, ?, 'Pekin Insurance', 'POL-1', '01/01/2026', '12/31/2026', 'pending_review', 'cois/key.png', ?, ?)`,
    [coiId, subId, now, now],
  )
  if (withReview) {
    await dbRun(
      `INSERT INTO coi_field_reviews (coi_id, source_tag, details_json) VALUES (?, 'ai', ?)`,
      [coiId, JSON.stringify(withReview)],
    )
  }
  return coiId
}

test('agent API keys: create returns plaintext once, hash stored, prefix displayed', async () => {
  await start()
  try {
    const admin = await mkAdmin()
    const key = await createAgentApiKey('voice-agent', 'coi:confirm', admin.id)
    assert.ok(key.key.startsWith('sc_'))
    assert.equal(key.name, 'voice-agent')
    assert.equal(key.prefix, key.key.slice(0, 10))
    const row = await dbGet<any>('SELECT * FROM agent_api_keys WHERE id = ?', [key.id])
    assert.ok(!JSON.stringify(row).includes(key.key), 'plaintext never stored')
    const list = await listAgentKeys()
    assert.ok(list.some((k) => k.id === key.id && k.key_prefix === key.prefix))
    const revoked = await revokeAgentKey(key.id)
    assert.equal(revoked, true)
    const after = await verifyAgentKey(key.key)
    assert.equal(after.ok, false)
    assert.equal(after.reason, 'key revoked')
  } finally {
    stop()
  }
})

test('requireAgentKey: accepts X-Agent-Key and Bearer sc_, rejects invalid/revoked, accepts admin JWT', async () => {
  await start()
  try {
    const admin = await mkAdmin()
    const key = await createAgentApiKey('voice-agent', 'coi:confirm', admin.id)
    const coiId = await mkCoi()
    const get = (headers: Record<string, string>) =>
      fetch(`http://127.0.0.1:${port}/api/agent/v1/brief/${coiId}`, { headers })

    let r = await get({ 'X-Agent-Key': key.key })
    assert.equal(r.status, 200)

    r = await get({ authorization: `Bearer ${key.key}` })
    assert.equal(r.status, 200)

    r = await get({})
    assert.equal(r.status, 401)

    r = await get({ 'X-Agent-Key': 'sc_badkey' })
    assert.equal(r.status, 401)

    await revokeAgentKey(key.id)
    r = await get({ 'X-Agent-Key': key.key })
    assert.equal(r.status, 401)

    r = await get({ authorization: `Bearer ${admin.token}` })
    assert.equal(r.status, 200)
  } finally {
    stop()
  }
})

test('admin key management endpoints are admin-only', async () => {
  await start()
  try {
    const admin = await mkAdmin()
    const uid = randomUUID()
    await dbRun("INSERT INTO users (id, email, password_hash, name, role, created_at) VALUES (?, ?, 'x', 'U', 'gc', ?)", [uid, `u-${uid}@test.local`, new Date().toISOString()])
    const userToken = signToken({ id: uid, email: `u-${uid}@test.local`, role: 'gc' })
    const base = `http://127.0.0.1:${port}/api/agent/v1/admin/keys`

    let r = await fetch(base, { method: 'POST', headers: { authorization: `Bearer ${userToken}`, 'content-type': 'application/json' }, body: JSON.stringify({ name: 'k' }) })
    assert.equal(r.status, 403)

    r = await fetch(base, { method: 'POST', headers: { authorization: `Bearer ${admin.token}`, 'content-type': 'application/json' }, body: JSON.stringify({ name: 'elevenlabs-voice' }) })
    assert.equal(r.status, 200)
    const data = await r.json() as any
    assert.ok(data.key.key.startsWith('sc_'))

    r = await fetch(base, { headers: { authorization: `Bearer ${admin.token}` } })
    assert.equal(r.status, 200)

    r = await fetch(`${base}/${data.key.id}`, { method: 'DELETE', headers: { authorization: `Bearer ${admin.token}` } })
    assert.equal(r.status, 200)
  } finally {
    stop()
  }
})

test('buildCoiBrief returns dossier with preferred channel logic', async () => {
  await start()
  try {
    const both = await mkCoi({
      insured: { name: 'Acme Roofing LLC' },
      producer: { name: 'Apex Agency', phone: '312-555-0100', email: 'agency@apex.test' },
      policies: [{ type: 'GL', policyNumber: 'GL-9', effectiveDate: '01/01/2026', expirationDate: '12/31/2026', limits: [{ label: 'Occ', amount: '$1,000,000' }] }],
    })
    const b = await buildCoiBrief(both)
    assert.ok(b)
    assert.equal(b!.preferred_channel, 'both')
    assert.equal(b!.insured.name, 'Acme Roofing LLC')
    assert.equal(b!.policies[0].policyNumber, 'GL-9')

    const phoneOnly = await mkCoi({ producer: { phone: '312-555-0100' } })
    assert.equal((await buildCoiBrief(phoneOnly))!.preferred_channel, 'call')

    const emailOnly = await mkCoi({ producer: { email: 'a@b.test' } })
    assert.equal((await buildCoiBrief(emailOnly))!.preferred_channel, 'email')

    const none = await mkCoi()
    assert.equal((await buildCoiBrief(none))!.preferred_channel, 'none')
  } finally {
    stop()
  }
})

test('dispatchCall creates confirmation row; recordCallResult verified marks COI compliant via phone_call', async () => {
  await start()
  try {
    const admin = await mkAdmin()
    const key = await createAgentApiKey('voice', 'coi:confirm', admin.id)
    const coiId = await mkCoi({ producer: { phone: '312-555-0199', name: 'Metro Agency' } })

    const res = await fetch(`http://127.0.0.1:${port}/api/agent/v1/calls/dispatch`, {
      method: 'POST',
      headers: { 'X-Agent-Key': key.key, 'content-type': 'application/json' },
      body: JSON.stringify({ coiId, provider: 'external' }),
    })
    assert.equal(res.status, 200)
    const data = await res.json() as any
    assert.equal(data.confirmation.status, 'in_progress')
    assert.equal(data.confirmation.channel, 'call')
    assert.ok(data.dialing.script_prompt.includes('SafeCOI'))

    const r2 = await fetch(`http://127.0.0.1:${port}/api/agent/v1/calls/${data.confirmation.id}/result`, {
      method: 'POST',
      headers: { 'X-Agent-Key': key.key, 'content-type': 'application/json' },
      body: JSON.stringify({
        outcome: 'verified',
        notes: 'Rep Maria confirmed GL-9 active, no lapse history',
        answers: { insured_exists: true, all_active: true },
        recordingUrl: 'https://cdn.test/calls/123.mp3',
      }),
    })
    assert.equal(r2.status, 200)
    const coi = await dbGet<any>('SELECT * FROM cois WHERE id = ?', [coiId])
    assert.equal(coi.status, 'compliant')
    assert.equal(coi.confirmed_via, 'phone_call')
    assert.ok(coi.confirmed_at)
    assert.ok(coi.confirmed_notes.includes('Maria'))
    const conf = await dbGet<any>('SELECT * FROM coi_confirmations WHERE id = ?', [data.confirmation.id])
    assert.equal(conf.status, 'verified')
    assert.equal(conf.recording_url, 'https://cdn.test/calls/123.mp3')
  } finally {
    stop()
  }
})

test('sendConfirmationEmail creates confirmation row and recordEmailResult verifies COI', async () => {
  await start()
  try {
    const admin = await mkAdmin()
    const key = await createAgentApiKey('email-agent', 'coi:confirm', admin.id)
    const coiId = await mkCoi({ producer: { email: 'agency@metro.test' } })

    const res = await fetch(`http://127.0.0.1:${port}/api/agent/v1/emails/send`, {
      method: 'POST',
      headers: { 'X-Agent-Key': key.key, 'content-type': 'application/json' },
      body: JSON.stringify({ coiId }),
    })
    assert.equal(res.status, 200)
    const data = await res.json() as any
    assert.equal(data.confirmation.channel, 'email')
    assert.equal(data.confirmation.status, 'in_progress')

    const r2 = await fetch(`http://127.0.0.1:${port}/api/agent/v1/emails/${data.confirmation.id}/result`, {
      method: 'POST',
      headers: { 'X-Agent-Key': key.key, 'content-type': 'application/json' },
      body: JSON.stringify({ outcome: 'verified', notes: 'Agency replied confirming all policies' }),
    })
    assert.equal(r2.status, 200)
    const coi = await dbGet<any>('SELECT * FROM cois WHERE id = ?', [coiId])
    assert.equal(coi.status, 'compliant')
    assert.equal(coi.confirmed_via, 'email')
  } finally {
    stop()
  }
})

test('listConfirmationQueue respects channel and contact filters', async () => {
  await start()
  try {
    const c1 = await mkCoi({ producer: { phone: '1', email: 'a@b.c' } })
    const c2 = await mkCoi({ producer: { phone: '1' } })
    const c3 = await mkCoi({ producer: { email: 'a@b.c' } })
    const c4 = await mkCoi()

    const phone = await listConfirmationQueue({ has_phone: true })
    const ids = phone.map((p) => p.coi_id)
    assert.ok(ids.includes(c1))
    assert.ok(ids.includes(c2))
    assert.ok(!ids.includes(c3))
    assert.ok(!ids.includes(c4))

    const email = await listConfirmationQueue({ has_email: true })
    const eids = email.map((p) => p.coi_id)
    assert.ok(eids.includes(c1))
    assert.ok(eids.includes(c3))
    assert.ok(!eids.includes(c2))
  } finally {
    stop()
  }
})

test('webhook updates provider payload on call completion', async () => {
  await start()
  try {
    const admin = await mkAdmin()
    const key = await createAgentApiKey('voice', 'coi:confirm', admin.id)
    const coiId = await mkCoi({ producer: { phone: '1' } })
    const d = await dispatchCall(coiId, { provider: 'external' })
    await dbRun(`UPDATE coi_confirmations SET provider_payload_json = ? WHERE id = ?`, [JSON.stringify({ call_id: 'CA_xyz' }), d.confirmation.id])
    const r = await fetch(`http://127.0.0.1:${port}/api/agent/v1/webhooks/calls`, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ CallSid: 'CA_xyz', CallStatus: 'completed', Duration: 84 }),
    })
    console.log('WEBHOOK BODY:', await r.text()); assert.equal(r.status, 200)
    const row = await dbGet<any>('SELECT provider_payload_json FROM coi_confirmations WHERE id = ?', [d.confirmation.id])
    assert.ok(row.provider_payload_json.includes('completed'))
  } finally {
    stop()
  }
})

test('GET confirmations history and detail', async () => {
  await start()
  try {
    const admin = await mkAdmin()
    const key = await createAgentApiKey('voice', 'coi:confirm', admin.id)
    const coiId = await mkCoi({ producer: { phone: '1' } })
    const d = await dispatchCall(coiId, { provider: 'external' })
    let r = await fetch(`http://127.0.0.1:${port}/api/agent/v1/cois/${coiId}/confirmations`, { headers: { 'X-Agent-Key': key.key } })
    assert.equal(r.status, 200)
    const data = await r.json() as any
    assert.equal(data.confirmations.length, 1)

    r = await fetch(`http://127.0.0.1:${port}/api/agent/v1/confirmations/${d.confirmation.id}`, { headers: { 'X-Agent-Key': key.key } })
    assert.equal(r.status, 200)
  } finally {
    stop()
  }
})
