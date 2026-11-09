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

async function seed() {
  await initDatabase()
  console.log('[seed] Populating database...')

  // Clear existing
  for (const t of ['email_logs', 'upload_requests', 'client_share_links', 'project_subcontractors', 'coi_coverages', 'cois', 'subcontractors', 'gc_settings', 'users', 'companies']) {
    try { await dbRun(`DELETE FROM ${t}`) } catch {}
  }

    // 0. Admin User
  const adminId = uuidv4()
  const adminHash = await bcrypt.hash('admin123', 10)
  await dbRun(
    `INSERT INTO users (id, email, password_hash, name, company_name, role, created_at)
     VALUES (?, ?, ?, ?, ?, 'admin', ?)`,
    [adminId, 'admin@safecoi.com', adminHash, 'Platform Admin', 'safecoi.com', new Date().toISOString()]
  )

  // 1. GC User
  const userId = uuidv4()
  const hash = await bcrypt.hash('password123', 10)
  await dbRun(
    `INSERT INTO users (id, email, password_hash, name, company_name, role, created_at)
     VALUES (?, ?, ?, ?, ?, 'gc', ?)`,
    [userId, 'gc@apexconstruction.demo', hash, 'Michael Vance', 'Apex Construction Group', new Date().toISOString()]
  )

  // 2. GC Settings
  await dbRun(
    `INSERT INTO gc_settings (id, user_id, company_name, license_number, address, phone, email, logo_url, additional_insured_wording, required_gl_limit, required_auto_limit, required_wc_limit, required_umbrella_limit, expiration_warning_days, updated_at)
     VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, 30, ?)`,
    [
      uuidv4(),
      userId,
      'Apex Construction Group',
      'CBC1258904',
      '2400 Riverside Blvd, Suite 800, Chicago, IL 60601',
      '(312) 555-0147',
      'compliance@apexconstruction.demo',
      '',
      'Apex Construction Group, LLC and Project Owner shall be named as Additional Insured on General Liability, Auto Liability, and Umbrella policies. A Waiver of Subrogation applies in favor of Apex Construction Group, LLC.',
      '$1,000,000 / $2,000,000',
      '$1,000,000',
      'Statutory Limits',
      '$5,000,000',
      new Date().toISOString(),
    ]
  )

  // 3. Subcontractors + COIs
  const today = new Date()
  const nowISO = today.toISOString()

  const subDefs = [
    {
      company_name: 'Horizon Electrical Services',
      trade: 'Electrical',
      contact_person: 'Elena Ramos',
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
        expiration: addDays(today, 14), // EXPIRING SOON!
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
        policy_number: 'CHB-COMM-991204',
        effective: subDays(today, 245),
        expiration: addDays(today, 120),
        status: 'compliant',
        coverages: [
          { type: 'General Liability', per: '$2,000,000', agg: '$4,000,000', ai: 1, wos: 1 },
          { type: 'Automobile Liability', per: '$1,000,000', agg: '$1,000,000', ai: 1, wos: 0 },
          { type: "Workers' Compensation", per: 'Statutory', agg: 'Statutory', ai: 0, wos: 1 },
        ],
      },
    },
    {
      company_name: 'Benchmark Concrete & Foundation',
      trade: 'Concrete',
      contact_person: 'Dmitri Pavlov',
      phone: '(312) 555-0644',
      email: 'dmitri@benchmarkconcrete.demo',
      address: '2210 S Halsted St, Chicago, IL',
      notes: 'URGENT: expired policy, sub should not be on site until renewed',
      status: 'active',
      coi: {
        carrier: 'Zurich North America',
        am_best: 'A+ (Superior)',
        policy_number: 'ZNA-GL-2024-7719',
        effective: subDays(today, 383),
        expiration: subDays(today, 18), // EXPIRED!
        status: 'compliant', // was compliant, expiration date makes it expired
        coverages: [
          { type: 'General Liability', per: '$1,000,000', agg: '$2,000,000', ai: 1, wos: 0 },
          { type: 'Automobile Liability', per: '$1,000,000', agg: '$1,000,000', ai: 0, wos: 0 },
          { type: "Workers' Compensation", per: 'Statutory', agg: 'Statutory', ai: 0, wos: 1 },
        ],
      },
    },
    {
      company_name: 'Titan Steel Erectors',
      trade: 'Framing & Structural',
      contact_person: 'Cole Vance',
      phone: '(630) 555-0275',
      email: 'cole@titansteel.demo',
      address: '500 E North Ave, Glendale Heights, IL',
      notes: 'Heavy structural frame specialist, great safety record',
      status: 'active',
      coi: {
        carrier: 'The Hartford',
        am_best: 'A+ (Superior)',
        policy_number: 'TH-PKG-2025-63022',
        effective: subDays(today, 145),
        expiration: addDays(today, 220),
        status: 'compliant',
        coverages: [
          { type: 'General Liability', per: '$1,000,000', agg: '$2,000,000', ai: 1, wos: 1 },
          { type: 'Automobile Liability', per: '$1,000,000', agg: '$1,000,000', ai: 1, wos: 1 },
          { type: "Workers' Compensation", per: 'Statutory', agg: 'Statutory', ai: 0, wos: 1 },
          { type: 'Umbrella Liability', per: '$5,000,000', agg: '$5,000,000', ai: 1, wos: 1 },
        ],
      },
    },
    {
      company_name: 'Prairie State Roofing & Waterproofing',
      trade: 'Roofing',
      contact_person: 'Tasha Warren',
      phone: '(815) 555-0810',
      email: 'tasha@prairiestateroofing.demo',
      address: '310 N State St, Aurora, IL',
      notes: 'Roofing season crunch; renewal binder promised by end of week',
      status: 'active',
      coi: {
        carrier: 'Nationwide',
        am_best: 'A+ (Superior)',
        policy_number: 'NW-COMM-55201',
        effective: subDays(today, 360),
        expiration: addDays(today, 5), // EXPIRING SOON — 5 days!
        status: 'compliant',
        coverages: [
          { type: 'General Liability', per: '$1,000,000', agg: '$2,000,000', ai: 1, wos: 1 },
          { type: 'Automobile Liability', per: '$1,000,000', agg: '$1,000,000', ai: 1, wos: 0 },
          { type: "Workers' Compensation", per: 'Statutory', agg: 'Statutory', ai: 0, wos: 1 },
        ],
      },
    },
    {
      company_name: 'Apex Drywall & Acoustics',
      trade: 'Drywall',
      contact_person: 'Carlos Delgado',
      phone: '(773) 555-0456',
      email: 'carlos@apexdrywall.demo',
      address: '6100 W Belmont Ave, Chicago, IL',
      notes: 'New sub, COI requested — magic link sent',
      status: 'pending_review',
      coi: null, // MISSING
    },
    {
      company_name: 'Lakeview Painting & Finishing',
      trade: 'Painting',
      contact_person: 'Sora Tanaka',
      phone: '(312) 555-0799',
      email: 'sora@lakeviewpainting.demo',
      address: '1900 N Ashland Ave, Chicago, IL',
      notes: 'Submitted through self-service upload portal, awaiting review',
      status: 'pending_review',
      coi: {
        carrier: 'CNA Financial',
        am_best: 'A (Excellent)',
        policy_number: 'CNA-GL-2025-3310',
        effective: subDays(today, 10),
        expiration: addDays(today, 355),
        status: 'pending_review', // GC must review!
        coverages: [
          { type: 'General Liability', per: '$1,000,000', agg: '$2,000,000', ai: 1, wos: 0 },
          { type: 'Automobile Liability', per: '$1,000,000', agg: '$1,000,000', ai: 0, wos: 0 },
          { type: "Workers' Compensation", per: 'Statutory', agg: 'Statutory', ai: 0, wos: 1 },
        ],
      },
    },
  ]

  const createdSubs: any[] = []
  for (const s of subDefs) {
    const id = uuidv4()
    await dbRun(
      `INSERT INTO subcontractors (id, company_name, trade, contact_person, phone, email, address, notes, status, created_at, updated_at)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
      [id, s.company_name, s.trade, s.contact_person, s.phone, s.email, s.address, s.notes, s.status, nowISO, nowISO]
    )
    if (s.coi) {
      const coiId = uuidv4()
      await dbRun(
        `INSERT INTO cois (id, subcontractor_id, carrier, am_best_rating, policy_number, effective_date, expiration_date, status, created_at, updated_at)
         VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
        [coiId, id, s.coi.carrier, s.coi.am_best, s.coi.policy_number, s.coi.effective, s.coi.expiration, s.coi.status, nowISO, nowISO]
      )
      for (const cv of s.coi.coverages) {
        await dbRun(
          `INSERT INTO coi_coverages (id, coi_id, type, per_occurrence_limit, aggregate_limit, additional_insured, waiver_of_subrogation)
           VALUES (?, ?, ?, ?, ?, ?, ?)`,
          [uuidv4(), coiId, cv.type, cv.per, cv.agg, cv.ai, cv.wos]
        )
      }
    }
    createdSubs.push({ id, ...s })
  }

  // 4. Project
  const projectId = uuidv4()
  await dbRun(
    `INSERT INTO projects (id, name, code, address, client_name, client_email, start_date, end_date, notes, created_at)
     VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
    [
      projectId,
      'Riverside Commerce Center',
      'RCC-2026',
      '2100 Riverside Plaza, Chicago, IL',
      'Meridian Property Partners',
      'compliance@meridianpp.demo',
      subDays(today, 120),
      addDays(today, 240),
      '14-story core-and-shell mixed-use office tower. Client requires 100% compliant COIs before each sub mobilizes.',
      nowISO,
    ]
  )

  // assign subs 1-7 to project (all except Painting, which joins later)
  for (const s of createdSubs.slice(0, 7)) {
    await dbRun(
      'INSERT INTO project_subcontractors (id, project_id, subcontractor_id, created_at) VALUES (?, ?, ?, ?)',
      [uuidv4(), projectId, s.id, nowISO]
    )
  }

  // 5. Pre-made Client Share Link (testable immediately!)
  const shareToken = 'rcc-meridian-2026'
  await dbRun(
    `INSERT INTO client_share_links (id, project_id, token, expires_at, created_at, note)
     VALUES (?, ?, ?, ?, ?, ?)`,
    [uuidv4(), projectId, shareToken, null, nowISO, 'Permanent demo link for client presentation']
  )

  // 6. Pre-made Subcontractor Upload Requests
  await dbRun(
    `INSERT INTO upload_requests (id, subcontractor_id, token, requested_by_email, message, expires_at, used, created_at)
     VALUES (?, ?, 'upload-horizon-2026', 'compliance@apexconstruction.demo', 'Please upload your 2026/27 renewal COI before the next phase mobilization.', ?, 0, ?)`,
    [uuidv4(), createdSubs[0].id, addDays(today, 60), nowISO]
  )
  await dbRun(
    `INSERT INTO upload_requests (id, subcontractor_id, token, requested_by_email, message, expires_at, used, created_at)
     VALUES (?, ?, 'upload-drywall-2026', 'compliance@apexconstruction.demo', 'Welcome to Apex projects — please provide your COI and endorsements.', ?, 0, ?)`,
    [uuidv4(), createdSubs[6].id, addDays(today, 30), nowISO]
  )

  // 7. Sample Email Logs (audit trail)
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

  // 8. Additional seeded companies on different subscription plans (MRR demo)
  const extraCompanies = [
    { name: 'Apex Construction Group', plan: 'Professional', mrr: 149, ownerId: userId, ownerEmail: 'gc@apexconstruction.demo', ownerName: 'Michael Vance' },
    { name: 'Pinnacle Builders Inc.', plan: 'Professional', mrr: 149, ownerEmail: 'sarah@pinnaclebuilders.demo', ownerName: 'Sarah Lin' },
    { name: 'Summit Contracting', plan: 'Starter', mrr: 49, ownerEmail: 'dave@summitcontracting.demo', ownerName: 'Dave Morris' },
    { name: 'Cornerstone Construction', plan: 'Enterprise', mrr: 499, ownerEmail: 'kevin@cornerstone.demo', ownerName: 'Kevin Ortiz' },
    { name: 'Riverview Homes', plan: 'Free Demo', mrr: 0, ownerEmail: 'mia@riverviewhomes.demo', ownerName: 'Mia Zhao' },
  ]
  const defaultPw = await bcrypt.hash('demo1234', 10)
  for (let i = 0; i < extraCompanies.length; i++) {
    const comp = extraCompanies[i]
    let ownerId = (comp as any).ownerId
    if (!ownerId) {
      ownerId = uuidv4()
      await dbRun(
        `INSERT INTO users (id, email, password_hash, name, company_name, role, created_at)
         VALUES (?, ?, ?, ?, ?, 'gc', ?)`,
        [ownerId, comp.ownerEmail, defaultPw, comp.ownerName, comp.name, new Date().toISOString()]
      )
    }
    await dbRun(
      `INSERT INTO companies (id, name, plan, mrr, status, owner_user_id, created_at)
       VALUES (?, ?, ?, ?, 'active', ?, ?)`,
      [uuidv4(), comp.name, comp.plan, comp.mrr, ownerId, new Date().toISOString()]
    )
  }

  console.log('[seed] Done!')
  console.log(`[seed] Admin login: admin@safecoi.com / admin123`)
  console.log(`[seed] GC login: gc@apexconstruction.demo / password123`)
  console.log(`[seed] Client share link: /share/${shareToken}`)
  console.log(`[seed] Sub upload link: /upload/upload-drywall-2026`)
}

seed().then(() => process.exit(0)).catch((err) => { console.error(err); process.exit(1) })
