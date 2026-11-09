import { createApp } from './app.ts'
import { seed } from './seed.ts'
import { IncomingMessage, ServerResponse } from 'http'
import { Socket } from 'net'

function request(app: any, opts: { method?: string; url: string; headers?: Record<string, string>; body?: any }): Promise<{ status: number; headers: Record<string, string>; json: any; raw: string }> {
  return new Promise((resolve, reject) => {
    const socket = new Socket()
    const req = new IncomingMessage(socket)
    req.url = opts.url
    req.method = opts.method || 'GET'
    req.headers = { ...(opts.headers || {}) }

    const bodyStr = opts.body !== undefined ? JSON.stringify(opts.body) : undefined
    if (bodyStr) {
      req.headers['content-type'] = 'application/json'
      req.headers['content-length'] = String(Buffer.byteLength(bodyStr))
    }

    const res = new ServerResponse(req)
    let raw = ''
    res.write = function (chunk: any) {
      raw += chunk.toString()
      return true
    }
    res.end = function (chunk: any) {
      if (chunk) raw += chunk.toString()
      let json: any = null
      try { json = JSON.parse(raw) } catch {}
      resolve({ status: res.statusCode, headers: res.getHeaders() as any, json, raw })
      return this
    }

    // feed body asynchronously so Express parsers get it properly
    setImmediate(() => {
      app(req, res, reject)
      if (bodyStr) {
        req.emit('data', Buffer.from(bodyStr))
        req.emit('end')
      } else {
        req.emit('end')
      }
    })
  })
}

let passed = 0
let failed = 0
function assert(name: string, ok: boolean, detail?: string) {
  if (ok) {
    passed++
    console.log(`  ✓ ${name}`)
  } else {
    failed++
    console.log(`  ✗ ${name} — ${detail || 'assertion failed'}`)
  }
}

console.log('\n========================================')
console.log(' COI Tracker API Integration Test Suite')
console.log('========================================\n')

await seed()
const app = await createApp()

// 1. Health check
const health = await request(app, { url: '/api/health' })
assert('Health check returns 200 with database + storage fields',
  health.status === 200 && health.json?.status === 'ok' && 'database' in health.json)

// 2. Register
const reg = await request(app, {
  method: 'POST',
  url: '/api/auth/register',
  body: { email: `qa-${Date.now()}@example.com`, password: 'password123', name: 'QA Tester', company_name: 'QA Builders' },
})
assert('User registration succeeds and returns JWT', reg.status === 200 && Boolean(reg.json?.token))

// 3. Login
const login = await request(app, {
  method: 'POST',
  url: '/api/auth/login',
  body: { email: 'gc@apexconstruction.demo', password: 'password123' },
})
const token = login.json?.token
assert('Login with seeded credentials returns token and user', login.status === 200 && Boolean(token))
const auth = { authorization: `Bearer ${token}` }

// 4. Me
const me = await request(app, { url: '/api/auth/me', headers: auth })
assert('Protected /api/auth/me returns current user', me.status === 200 && me.json?.user?.email === 'gc@apexconstruction.demo')

// 5. Subcontractors list
const subs = await request(app, { url: '/api/subcontractors', headers: auth })
const list = subs.json?.subcontractors || []
assert('Subcontractors list returns seeded records with computed statuses',
  subs.status === 200 && list.length >= 8 && list.every((s: any) => Boolean(s.computed_status)))

// 6. Subcontractor detail
const detail = await request(app, { url: `/api/subcontractors/${list[0].id}`, headers: auth })
assert('Subcontractor detail includes cois and coverages',
  detail.status === 200 && Array.isArray(detail.json?.subcontractor?.cois))

// 7. Expiry alerts
const alerts = await request(app, { url: '/api/cois/alerts/expiring?days=30', headers: auth })
assert('Expiry alerts endpoint returns policies within window', alerts.status === 200 && Array.isArray(alerts.json?.alerts))

// 8. PRIVACY TEST — CRITICAL REQUIREMENT
const clientShare = await request(app, { url: '/api/client/share/rcc-meridian-2026' })
const csSubs = clientShare.json?.subcontractors || []
const allNull = csSubs.length > 0 && csSubs.every((s: any) =>
  s.phone === null && s.email === null && s.contact_person === null && s.address === null && s.notes === null
)
// also verify raw response does not contain any known sub phone numbers
const raw = clientShare.raw
const leaks = ['(312) 555-0321', '(847) 555-0188', '(773) 555-0912', '(312) 555-0644', '(815) 555-0810', 'elena@horizonelectric.demo', 'brian@midwestmech.demo'].filter(s => raw.includes(s))
assert('PRIVACY: client view strictly strips subcontractor contact info (phone/email/contact/address = null)',
  allNull && leaks.length === 0, `leaked strings: ${leaks.join(', ')}`)
assert('PRIVACY: GC contact info is preserved for client to reach GC', Boolean(clientShare.json?.contractor?.email))
assert('Client view includes project scorecard and verified policies', clientShare.json?.scorecard?.score !== undefined)

// 9. Subcontractor self-service upload link validation
const uploadVal = await request(app, { url: '/api/upload/validate/upload-drywall-2026' })
assert('Self-service upload link validates and returns pre-fill + requirements',
  uploadVal.status === 200 && uploadVal.json?.subcontractor?.company_name === 'Apex Drywall & Acoustics' && Boolean(uploadVal.json?.gc?.company_name))

// 10. Dashboard stats KPIs
const stats = await request(app, { url: '/api/stats', headers: auth })
assert('Dashboard stats returns KPIs, score, and trade breakdown',
  stats.status === 200 && stats.json?.totals?.score !== undefined && Array.isArray(stats.json?.trades))

// 11. GC settings GET + PUT
const settings = await request(app, { url: '/api/settings', headers: auth })
assert('GC settings returns configurable company requirements', settings.status === 200 && Boolean(settings.json?.settings?.company_name))
const updatedSettings = await request(app, {
  method: 'PUT',
  url: '/api/settings',
  headers: auth,
  body: { company_name: 'Apex Construction Group', required_gl_limit: '$1,000,000 / $2,000,000', expiration_warning_days: 30 },
})
assert('GC settings update persists', updatedSettings.status === 200)

// 12. Email simulation log
const emailSend = await request(app, {
  method: 'POST',
  url: '/api/emails/send-request',
  headers: auth,
  body: { subcontractor_id: list[0].id, custom_message: 'Test request message' },
})
assert('COI request simulation creates email log and returns portalUrl', emailSend.status === 201 && Boolean(emailSend.json?.portalUrl))
const emailLogs = await request(app, { url: '/api/emails', headers: auth })
assert('Email audit log contains simulated entries', emailLogs.status === 200 && emailLogs.json?.logs?.length >= 5)

// 13. Admin dashboard security and endpoints
const adminNoAuth = await request(app, { url: '/api/admin/overview' })
assert('Admin overview requires authentication', adminNoAuth.status === 401)
const adminNonAdmin = await request(app, { url: '/api/admin/overview', headers: auth })
assert('Admin overview forbidden for non-admin GC user', adminNonAdmin.status === 403)
const adminLogin = await request(app, {
  method: 'POST',
  url: '/api/auth/login',
  body: { email: 'kyuchang@gmail.com', password: 'password123' },
})
assert('Admin seeded account logs in', adminLogin.status === 200 && adminLogin.json?.user?.role === 'admin')
const adminAuth = { authorization: `Bearer ${adminLogin.json.token}` }
const overview = await request(app, { url: '/api/admin/overview', headers: adminAuth })
assert('Admin overview returns user counts, revenue MRR, and platform KPIs',
  overview.status === 200 && overview.json?.users?.total >= 2 && typeof overview.json?.revenue?.mrr === 'number' && overview.json?.platform?.companies >= 1)
const companies = await request(app, { url: '/api/admin/companies', headers: adminAuth })
assert('Admin companies list includes plans and stats', companies.status === 200 && companies.json?.companies?.length >= 1)
const planUpdate = await request(app, {
  method: 'PUT',
  url: `/api/admin/companies/${companies.json.companies[0].id}/plan`,
  headers: adminAuth,
  body: { plan: 'Enterprise' },
})
assert('Admin can update company plan and MRR recalculates', planUpdate.status === 200 && planUpdate.json?.company?.mrr === 499)
const usersList = await request(app, { url: '/api/admin/users', headers: adminAuth })
assert('Admin users list returns all accounts with roles', usersList.status === 200 && Array.isArray(usersList.json?.users))
const gcUser = usersList.json.users.find((u: any) => u.email === 'gc@apexconstruction.demo')
const roleUpdate = await request(app, {
  method: 'PUT',
  url: `/api/admin/users/${gcUser.id}/role`,
  headers: adminAuth,
  body: { role: 'admin' },
})
assert('Admin can promote user role', roleUpdate.status === 200 && roleUpdate.json?.user?.role === 'admin')


// 14. Staff portal alias
const staffOverview = await request(app, { url: '/api/staff/overview', headers: adminAuth })
assert('/api/staff alias returns overview identical to /api/admin', staffOverview.status === 200 && staffOverview.json?.revenue?.mrr !== undefined)
// 14b. Delete actions and demo data reset
const beforeDel = await request(app, { url: '/api/admin/overview', headers: adminAuth })
const delTarget = usersList.json.users.find((u: any) => u.email === 'tom@northgategc.demo')
const delUser = await request(app, { method: 'DELETE', url: `/api/admin/users/${delTarget.id}`, headers: adminAuth })
assert('Admin can delete a user', delUser.status === 200)
const selfDel = await request(app, { method: 'DELETE', url: `/api/admin/users/${adminLogin.json.user.id}`, headers: adminAuth })
assert('Admin cannot delete own account', selfDel.status === 400)
const delComp = await request(app, { method: 'DELETE', url: `/api/admin/companies/${companies.json.companies[0].id}`, headers: adminAuth })
assert('Admin can delete a company', delComp.status === 200)
const afterDel = await request(app, { url: '/api/admin/overview', headers: adminAuth })
assert('Deletion reduces user count', afterDel.json.users.total === beforeDel.json.users.total - 1)
const resetData = await request(app, { method: 'POST', url: '/api/admin/danger/reset', headers: adminAuth })
assert('Admin can reset to demo data', resetData.status === 200)
const afterReset = await request(app, { url: '/api/admin/overview', headers: adminAuth })
assert('Reset restores full demo dataset', afterReset.json.users.total >= 13)

const adminLogin2 = await request(app, {
  method: 'POST',
  url: '/api/auth/login',
  body: { email: 'kyuchang@gmail.com', password: 'password123' },
})
const adminAuth2 = { authorization: `Bearer ${adminLogin2.json.token}` }

// 15. Password change flow
const pwBadCurrent = await request(app, {
  method: 'POST',
  url: '/api/auth/change-password',
  headers: adminAuth2,
  body: { current_password: 'wrongpassword', new_password: 'newsecret123' },
})
assert('Password change rejects wrong current password', pwBadCurrent.status === 401)
const pwShort = await request(app, {
  method: 'POST',
  url: '/api/auth/change-password',
  headers: adminAuth2,
  body: { current_password: 'password123', new_password: 'short' },
})
assert('Password change enforces minimum 8 characters', pwShort.status === 400)
const pwOk = await request(app, {
  method: 'POST',
  url: '/api/auth/change-password',
  headers: adminAuth2,
  body: { current_password: 'password123', new_password: 'MyNewPassword2026!' },
})
assert('Password change succeeds', pwOk.status === 200 && pwOk.json?.success === true)
const newLogin = await request(app, {
  method: 'POST',
  url: '/api/auth/login',
  body: { email: 'kyuchang@gmail.com', password: 'MyNewPassword2026!' },
})
assert('Login works with the changed password', newLogin.status === 200)
// 16. Bootstrap seed guard
const bootBlock = await request(app, { method: 'POST', url: '/api/admin/bootstrap-seed' })
assert('Bootstrap-seed is blocked when database already has users', bootBlock.status === 403)


console.log('\n========================================')
console.log(` Results:  ${passed} passed, ${failed} failed`)
console.log('========================================\n')

process.exit(failed > 0 ? 1 : 0)
