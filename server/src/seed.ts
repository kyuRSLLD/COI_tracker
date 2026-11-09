import bcrypt from 'bcryptjs'
import { v4 as uuidv4 } from 'uuid'
import { initDatabase, dbRun, dbGet } from './db/db.ts'

function addDays(d: Date, n: number): string {
  const c = new Date(d)
  c.setDate(c.getDate() + n)
  return c.toISOString().slice(0, 10)
}
function subDays(d: Date, n: number): string {
  const c = new Date(d)
  c.setDate(c.getDate() - n)
  return c.toISOString().slice(0, 10)
}

export async function seed() {
  await initDatabase()
  console.log('[seed] Populating database...')

  // Clear existing
  for (const t of [
    'email_logs',
    'upload_requests',
    'client_share_links',
    'project_subcontractors',
    'coi_coverages',
    'cois',
    'subcontractors',
    'gc_settings',
    'users',
    'companies',
  ]) {
    try {
      await dbRun(`DELETE FROM ${t}`)
    } catch {}
  }

  const today = new Date()
  const nowISO = today.toISOString()
  const daysAgo = (n: number) => new Date(Date.now() - n * 86400000).toISOString()

  // 0. Admin User (Kyu)
  const adminId = uuidv4()
  const adminHash = await bcrypt.hash('password123', 10)
  await dbRun(
    `INSERT INTO users (id, email, password_hash, name, company_name, role, created_at)
     VALUES (?, ?, ?, ?, ?, 'admin', ?)`,
    [adminId, 'kyuchang@gmail.com', adminHash, 'Kyu Chang', 'SafeCOI', daysAgo(150)]
  )

  // 1. GC User (Apex Construction Group)
  const userId = uuidv4()
  const userHash = await bcrypt.hash('password123', 10)
  await dbRun(
    `INSERT INTO users (id, email, password_hash, name, company_name, role, created_at)
     VALUES (?, ?, ?, ?, ?, 'gc', ?)`,
    [userId, 'gc@apexconstruction.demo', userHash, 'Michael Vance', 'Apex Construction Group', daysAgo(90)]
  )

  // 2. GC Company Settings
  await dbRun(
    `INSERT INTO gc_settings (id, user_id, company_name, license_number, address, phone, email, logo_url,
      additional_insured_wording, required_gl_limit, required_auto_limit, required_wc_limit, required_umbrella_limit,
      expiration_warning_days, updated_at)
     VALUES (?, ?, ?, ?, ?, ?, ?, '', ?, ?, ?, ?, ?, 30, ?)`,
    [
      uuidv4(),
      userId,
      'Apex Construction Group',
      'IL-GC-49210-2019',
      '200 S Michigan Ave, Suite 1400, Chicago, IL 60604',
      '(312) 555-0100',
      'compliance@apexconstruction.demo',
      'Apex Construction Group and its affiliated entities must be named as additional insured on a primary and non-contributory basis, with a waiver of subrogation on all policies.',
      '$1,000,000 / $2,000,000',
      '$1,000,000',
      'Statutory',
      '$5,000,000',
      nowISO,
    ]
  )

  // 3. Subcontractors with COIs
  const subs = [
    {
      company_name: 'Horizon Electrical Services',
      trade: 'Electrical',
      contact_person: 'Elena Rossi',
      phone: '(312) 555-0321',
      email: 'elena@horizonelectric.demo',
      address: '1420 W Grand Ave, Chicago, IL',
      notes: 'Master electrician, reliable on past 4 projects',
      status: 'active',
      coi: {
        carrier: 'Liberty Mutual',
        am_best: 'A (Excellent)',
        policy_number: 'LM-GL-2025-44912',
        effective: subDays(today, 185),
        expiration: addDays(today, 180),
        status: 'compliant',
        coverages: [
          { type: 'General Liability', per: '$1,000,000', agg: '$2,000,000', ai: 1, wos: 1 },
          { type: 'Automobile Liability', per: '$1,000,000', agg: '$1,000,000', ai: 1, wos: 0 },
          { type: "Workers' Compensation", per: 'Statutory', agg: 'Statutory', ai: 0, wos: 1 },
          { type: 'Umbrella Liability', per: '$5,000,000', agg: '$5,000,000', ai: 1, wos: 0 },
        ],
      },
    },
    {
      company_name: 'Midwest Mechanical Systems',
      trade: 'HVAC',
      contact_person: 'Brian Chen',
      phone: '(847) 555-0188',
      email: 'brian@midwestmech.demo',
      address: '8900 N Milwaukee Ave, Niles, IL',
      notes: 'Renewal already requested; broker confirms policy bound',
      status: 'active',
      coi: {
        carrier: 'Travelers',
        am_best: 'A++ (Superior)',
        policy_number: 'TRV-PKG-882103',
        effective: subDays(today, 351),
        expiration: addDays(today, 14),
        status: 'compliant',
        coverages: [
          { type: 'General Liability', per: '$1,000,000', agg: '$2,000,000', ai: 1, wos: 1 },
          { type: 'Automobile Liability', per: '$1,000,000', agg: '$1,000,000', ai: 1, wos: 1 },
          { type: "Workers' Compensation", per: 'Statutory', agg: 'Statutory', ai: 0, wos: 1 },
          { type: 'Umbrella Liability', per: '$10,000,000', agg: '$10,000,000', ai: 1, wos: 1 },
        ],
      },
    },
    {
      company_name: 'Blue Ridge Plumbing & Fire Protection',
      trade: 'Plumbing',
      contact_person: 'Marcus Brody',
      phone: '(773) 555-0912',
      email: 'marcus@blueridgeplumbing.demo',
      address: '4300 S Cicero Ave, Chicago, IL',
      notes: 'Licensed sprinkler contractor, current on all jobs',
      status: 'active',
      coi: {
        carrier: 'Chubb',
        am_best: 'A++ (Superior)',
        policy_number: 'CHB-COMM-663219',
        effective: subDays(today, 90),
        expiration: addDays(today, 275),
        status: 'compliant',
        coverages: [
          { type: 'General Liability', per: '$2,000,000', agg: '$4,000,000', ai: 1, wos: 1 },
          { type: 'Automobile Liability', per: '$1,000,000', agg: '$1,000,000', ai: 1, wos: 1 },
          { type: "Workers' Compensation", per: 'Statutory', agg: 'Statutory', ai: 1, wos: 1 },
          { type: 'Umbrella Liability', per: '$10,000,000', agg: '$10,000,000', ai: 1, wos: 1 },
        ],
      },
    },
    {
      company_name: 'Benchmark Concrete & Foundation',
      trade: 'Concrete',
      contact_person: 'James O\'Reilly',
      phone: '(630) 555-0444',
      email: 'james@benchmarkconcrete.demo',
      address: '220 Industrial Dr, Aurora, IL',
      notes: 'EXPIRED POLICY — do not dispatch until renewal is on file',
      status: 'active',
      coi: {
        carrier: 'Zurich North America',
        am_best: 'A+ (Superior)',
        policy_number: 'ZUR-PKG-441209',
        effective: subDays(today, 383),
        expiration: subDays(today, 18),
        status: 'expired',
        coverages: [
          { type: 'General Liability', per: '$1,000,000', agg: '$2,000,000', ai: 1, wos: 1 },
          { type: 'Automobile Liability', per: '$1,000,000', agg: '$1,000,000', ai: 1, wos: 1 },
          { type: "Workers' Compensation", per: 'Statutory', agg: 'Statutory', ai: 1, wos: 1 },
          { type: 'Umbrella Liability', per: '$5,000,000', agg: '$5,000,000', ai: 1, wos: 0 },
        ],
      },
    },
    {
      company_name: 'Titan Steel Erectors',
      trade: 'Framing & Structural',
      contact_person: 'Dan Kovacs',
      phone: '(219) 555-0761',
      email: 'dan@titansteel.demo',
      address: '7800 Indianapolis Blvd, Hammond, IN',
      notes: 'AISC certified, union crew, 8 years with Apex',
      status: 'active',
      coi: {
        carrier: 'The Hartford',
        am_best: 'A+ (Superior)',
        policy_number: 'HTF-COM-910443',
        effective: subDays(today, 145),
        expiration: addDays(today, 220),
        status: 'compliant',
        coverages: [
          { type: 'General Liability', per: '$2,000,000', agg: '$4,000,000', ai: 1, wos: 1 },
          { type: 'Automobile Liability', per: '$1,000,000', agg: '$1,000,000', ai: 1, wos: 1 },
          { type: "Workers' Compensation", per: 'Statutory', agg: 'Statutory', ai: 1, wos: 1 },
          { type: 'Umbrella Liability', per: '$15,000,000', agg: '$15,000,000', ai: 1, wos: 1 },
        ],
      },
    },
    {
      company_name: 'Prairie State Roofing & Waterproofing',
      trade: 'Roofing',
      contact_person: 'Tasha Williams',
      phone: '(309) 555-0275',
      email: 'tasha@prairiestateroofing.demo',
      address: '1500 N Prospect Ave, Champaign, IL',
      notes: 'Expires in 5 days; new certificate promised by broker Friday',
      status: 'active',
      coi: {
        carrier: 'Nationwide',
        am_best: 'A+ (Superior)',
        policy_number: 'NW-CP-554129',
        effective: subDays(today, 360),
        expiration: addDays(today, 5),
        status: 'compliant',
        coverages: [
          { type: 'General Liability', per: '$1,000,000', agg: '$2,000,000', ai: 1, wos: 1 },
          { type: 'Automobile Liability', per: '$1,000,000', agg: '$1,000,000', ai: 1, wos: 1 },
          { type: "Workers' Compensation", per: 'Statutory', agg: 'Statutory', ai: 1, wos: 1 },
          { type: 'Umbrella Liability', per: '$5,000,000', agg: '$5,000,000', ai: 1, wos: 1 },
        ],
      },
    },
    {
      company_name: 'Apex Drywall & Acoustics',
      trade: 'Drywall',
      contact_person: 'Carlos Mendoza',
      phone: '(708) 555-0639',
      email: 'carlos@apexdrywall.demo',
      address: '9600 S Harlem Ave, Bridgeview, IL',
      notes: 'New sub for 2026; magic upload link sent 3 days ago, awaiting submission',
      status: 'active',
      coi: null,
    },
    {
      company_name: 'Lakeview Painting & Finishing',
      trade: 'Painting',
      contact_person: 'Sora Tanaka',
      phone: '(847) 555-0522',
      email: 'sora@lakeviewpainting.demo',
      address: '2500 Gross Point Rd, Evanston, IL',
      notes: 'Certificate uploaded via self-service portal — please review limits',
      status: 'active',
      coi: {
        carrier: 'CNA Financial',
        am_best: 'A (Excellent)',
        policy_number: 'CNA-GL-2026-70114',
        effective: subDays(today, 20),
        expiration: addDays(today, 345),
        status: 'pending_review',
        self_service: 1,
        coverages: [
          { type: 'General Liability', per: '$1,000,000', agg: '$2,000,000', ai: 1, wos: 1 },
          { type: 'Automobile Liability', per: '$1,000,000', agg: '$1,000,000', ai: 1, wos: 1 },
          { type: "Workers' Compensation", per: 'Statutory', agg: 'Statutory', ai: 1, wos: 1 },
          { type: 'Umbrella Liability', per: '$2,000,000', agg: '$2,000,000', ai: 0, wos: 0 },
        ],
      },
    },
  ]

  const createdSubs: Array<{ id: string; company_name: string }> = []
  for (const s of subs) {
    const id = uuidv4()
    await dbRun(
      `INSERT INTO subcontractors (id, user_id, company_name, trade, contact_person, phone, email, address, notes, status, created_at, updated_at)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
      [id, userId, s.company_name, s.trade, s.contact_person, s.phone, s.email, s.address, s.notes, s.status, nowISO, nowISO]
    )
    createdSubs.push({ id, company_name: s.company_name })
    if (s.coi) {
      const coiId = uuidv4()
      await dbRun(
        `INSERT INTO cois (id, subcontractor_id, carrier, am_best_rating, policy_number, effective_date, expiration_date,
          status, reviewer_notes, review_date, certificate_url, certificate_name, certificate_size, created_at, updated_at)
         VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, 'seed://coi.pdf', 'ACORD-25-sample.pdf', 342118, ?, ?)`,
        [
          coiId,
          id,
          s.coi.carrier,
          s.coi.am_best,
          s.coi.policy_number,
          s.coi.effective,
          s.coi.expiration,
          s.coi.status,
          s.coi.status === 'compliant' ? 'Verified against Apex company requirements.' : null,
          s.coi.status === 'compliant' ? nowISO : null,
          nowISO,
          nowISO,
        ]
      )
      for (const cv of s.coi.coverages) {
        await dbRun(
          `INSERT INTO coi_coverages (id, coi_id, type, per_occurrence_limit, aggregate_limit, additional_insured, waiver_of_subrogation)
           VALUES (?, ?, ?, ?, ?, ?, ?)`,
          [uuidv4(), coiId, cv.type, cv.per, cv.agg, cv.ai, cv.wos]
        )
      }
    }
  }

  // 4. Projects
  const projectId = uuidv4()
  await dbRun(
    `INSERT INTO projects (id, user_id, name, code, address, client_name, client_email, start_date, end_date, notes, created_at)
     VALUES (?, ?, 'Riverside Commerce Center', 'RCC-2026', '600 W Randolph St, Chicago, IL 60661', 'Meridian Property Partners', 'projects@meridianpp.demo', ?, ?, '14-story mixed-use tower. Client requires 100% compliant COIs before mobilization.', ?)`,
    [projectId, userId, subDays(today, 120), addDays(today, 240), nowISO]
  )
  for (let i = 0; i < 7; i++) {
    await dbRun(
      `INSERT INTO project_subcontractors (id, project_id, subcontractor_id, created_at)
       VALUES (?, ?, ?, ?)`,
      [uuidv4(), projectId, createdSubs[i].id, nowISO]
    )
  }

  // 5. Client Share Link
  const shareToken = 'rcc-meridian-2026'
  await dbRun(
    `INSERT INTO client_share_links (id, project_id, token, expires_at, created_at, access_count, note)
     VALUES (?, ?, ?, ?, ?, 3, 'Meridian client portal')`,
    [uuidv4(), projectId, shareToken, addDays(today, 180), nowISO]
  )

  // 6. Subcontractor Upload Request
  await dbRun(
    `INSERT INTO upload_requests (id, subcontractor_id, token, requested_by_email, message, expires_at, used, created_at)
     VALUES (?, ?, 'upload-drywall-2026', 'compliance@apexconstruction.demo', 'Welcome to Apex projects — please provide your COI and endorsements.', ?, 0, ?)`,
    [uuidv4(), createdSubs[6].id, addDays(today, 30), nowISO]
  )

  // 7. Sample Email Logs
  const emailSamples = [
    { to: 'brian@midwestmech.demo', subject: 'URGENT: Your Travelers insurance expires in 14 days — action required (Apex Construction Group)', type: 'expiration_reminder', when: subDays(today, 1) },
    { to: 'tasha@prairiestateroofing.demo', subject: 'URGENT: Your Nationwide insurance expires in 5 days — action required (Apex Construction Group)', type: 'expiration_reminder', when: subDays(today, 2) },
    { to: 'carlos@apexdrywall.demo', subject: 'Certificate of Insurance request from Apex Construction Group', type: 'coi_request', when: subDays(today, 5) },
    { to: 'sora@lakeviewpainting.demo', subject: 'COI received — thank you (Apex Construction Group)', type: 'general', when: subDays(today, 0) },
    { to: 'elena@horizonelectric.demo', subject: 'Certificate of Insurance request from Apex Construction Group', type: 'coi_request', when: subDays(today, 12) },
  ]
  for (const e of emailSamples) {
    await dbRun(
      `INSERT INTO email_logs (id, to_email, subject, body, type, status, sent_at)
       VALUES (?, ?, ?, ?, ?, 'simulated', ?)`,
      [uuidv4(), e.to, e.subject, 'Simulated email content logged for audit trail.', e.type, new Date(e.when).toISOString()]
    )
  }

  // 8. Rich demo subscriber companies (spread over 6 months for real-looking growth bars)
  const defaultPw = await bcrypt.hash('demo1234', 10)
  const demoCompanies = [
    { name: 'Apex Construction Group', plan: 'Professional', mrr: 149, ownerId: userId, ownerEmail: 'gc@apexconstruction.demo', ownerName: 'Michael Vance', days: 175 },
    { name: 'Pinnacle Builders Inc.', plan: 'Professional', mrr: 149, ownerEmail: 'sarah@pinnaclebuilders.demo', ownerName: 'Sarah Lin', days: 160 },
    { name: 'Cornerstone Construction', plan: 'Enterprise', mrr: 499, ownerEmail: 'kevin@cornerstone.demo', ownerName: 'Kevin Ortiz', days: 135 },
    { name: 'Summit Contracting', plan: 'Starter', mrr: 49, ownerEmail: 'dave@summitcontracting.demo', ownerName: 'Dave Morris', days: 120 },
    { name: 'Blue Ridge Constructors', plan: 'Enterprise', mrr: 499, ownerEmail: 'rachel@blueridgegc.demo', ownerName: 'Rachel Kim', days: 105 },
    { name: 'Harbor Mechanical Group', plan: 'Professional', mrr: 149, ownerEmail: 'omar@harbormechanical.demo', ownerName: 'Omar Hassan', days: 95 },
    { name: 'Meridian Prime Builders', plan: 'Professional', mrr: 149, ownerEmail: 'jenna@meridianprime.demo', ownerName: 'Jenna Cole', days: 85 },
    { name: 'Keystone Drywall & Frame', plan: 'Starter', mrr: 49, ownerEmail: 'leo@keystonedrywall.demo', ownerName: 'Leo Ramos', days: 70 },
    { name: 'Crestline Electrical Co.', plan: 'Starter', mrr: 49, ownerEmail: 'ana@crestlineelectric.demo', ownerName: 'Ana Morales', days: 55 },
    { name: 'Strata Steel & Structural', plan: 'Starter', mrr: 49, ownerEmail: 'paul@stratasteel.demo', ownerName: 'Paul Nowak', days: 35 },
    { name: 'Riverview Homes', plan: 'Free Demo', mrr: 0, ownerEmail: 'mia@riverviewhomes.demo', ownerName: 'Mia Zhao', days: 25 },
    { name: 'Northgate Construction', plan: 'Free Demo', mrr: 0, ownerEmail: 'tom@northgategc.demo', ownerName: 'Tom Bailey', days: 8 },
  ]

  for (const comp of demoCompanies) {
    let ownerId = (comp as any).ownerId
    if (!ownerId) {
      ownerId = uuidv4()
      await dbRun(
        `INSERT INTO users (id, email, password_hash, name, company_name, role, created_at)
         VALUES (?, ?, ?, ?, ?, 'gc', ?)`,
        [ownerId, comp.ownerEmail, defaultPw, comp.ownerName, comp.name, daysAgo(comp.days)]
      )
    }
    await dbRun(
      `INSERT INTO companies (id, name, plan, mrr, status, owner_user_id, created_at)
       VALUES (?, ?, ?, ?, 'active', ?, ?)`,
      [uuidv4(), comp.name, comp.plan, comp.mrr, ownerId, daysAgo(comp.days)]
    )
  }

  // Kyu's staff company
  await dbRun(
    `INSERT INTO companies (id, name, plan, mrr, status, owner_user_id, created_at)
     VALUES (?, ?, ?, ?, 'active', ?, ?)`,
    [uuidv4(), 'SafeCOI', 'Starter', 49, adminId, daysAgo(150)]
  )

  console.log('[seed] Done!')
  console.log(`[seed] Admin login: kyuchang@gmail.com / password123`)
  console.log(`[seed] Staff portal: /staff`)
  console.log(`[seed] GC login: gc@apexconstruction.demo / password123`)
  console.log(`[seed] Client share link: /share/${shareToken}`)
  console.log(`[seed] Sub upload link: /upload/upload-drywall-2026`)
}

// Auto-run when invoked directly
if (process.argv[1]?.endsWith('seed.ts') || process.argv[1]?.endsWith('seed.js')) {
  seed()
    .then(() => process.exit(0))
    .catch((err) => {
      console.error(err)
      process.exit(1)
    })
}
