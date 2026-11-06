import sqlite3 from 'sqlite3'
import pg from 'pg'
import path from 'path'
import fs from 'fs'
import dotenv from 'dotenv'

dotenv.config()

const DB_FILE =
  process.env.SQLITE_PATH ||
  (process.cwd().endsWith('server')
    ? path.resolve(process.cwd(), 'coi.db')
    : path.resolve(process.cwd(), 'server/coi.db'))
const DATABASE_URL = process.env.DATABASE_URL && process.env.DATABASE_URL.trim() !== ''
  ? process.env.DATABASE_URL.trim()
  : null

export const isPostgres = Boolean(DATABASE_URL && !DATABASE_URL.includes('your_') && DATABASE_URL.startsWith('postgres'))

let pgPool: pg.Pool | null = null
let sqliteDb: sqlite3.Database | null = null

function getPgPool(): pg.Pool {
  if (!pgPool) {
    pgPool = new pg.Pool({
      connectionString: DATABASE_URL!,
      ssl: DATABASE_URL!.includes('railway') || process.env.NODE_ENV === 'production'
        ? { rejectUnauthorized: false }
        : undefined,
    })
  }
  return pgPool
}

function getSqlite(): Promise<sqlite3.Database> {
  return new Promise((resolve, reject) => {
    if (sqliteDb) return resolve(sqliteDb)
    fs.mkdirSync(path.dirname(DB_FILE), { recursive: true })
    const db = new (sqlite3.verbose().Database)(DB_FILE, (err) => {
      if (err) return reject(err)
      sqliteDb = db
      sqliteDb.run('PRAGMA foreign_keys = ON;')
      resolve(sqliteDb)
    })
  })
}

// Convert '?' placeholders to '$1, $2, ...' for Postgres
function toPgSql(sql: string): string {
  let i = 1
  return sql.replace(/\?/g, () => `$${i++}`)
}

export async function dbRun(sql: string, params: any[] = []): Promise<{ lastID?: number; changes?: number }> {
  if (isPostgres) {
    const res = await getPgPool().query(toPgSql(sql), params)
    return { changes: res.rowCount ?? 0 }
  }
  const db = await getSqlite()
  return new Promise((resolve, reject) => {
    db.run(sql, params, function (err) {
      if (err) return reject(err)
      resolve({ lastID: this.lastID, changes: this.changes })
    })
  })
}

export async function dbGet<T = any>(sql: string, params: any[] = []): Promise<T | undefined> {
  if (isPostgres) {
    const res = await getPgPool().query(toPgSql(sql), params)
    return res.rows[0] as T | undefined
  }
  const db = await getSqlite()
  return new Promise((resolve, reject) => {
    db.get(sql, params, (err, row) => {
      if (err) return reject(err)
      resolve(row as T | undefined)
    })
  })
}

export async function dbAll<T = any>(sql: string, params: any[] = []): Promise<T[]> {
  if (isPostgres) {
    const res = await getPgPool().query(toPgSql(sql), params)
    return res.rows as T[]
  }
  const db = await getSqlite()
  return new Promise((resolve, reject) => {
    db.all(sql, params, (err, rows) => {
      if (err) return reject(err)
      resolve((rows || []) as T[])
    })
  })
}

export async function dbExec(sql: string): Promise<void> {
  if (isPostgres) {
    await getPgPool().query(sql)
    return
  }
  const db = await getSqlite()
  return new Promise((resolve, reject) => {
    db.exec(sql, (err) => (err ? reject(err) : resolve()))
  })
}

export async function initDatabase(): Promise<void> {
  console.log(`[db] Using ${isPostgres ? 'PostgreSQL (' + DATABASE_URL?.replace(/:[^:@/]+@/, ':***@') + ')' : 'SQLite (' + DB_FILE + ')'}`)

  const schema = `
    CREATE TABLE IF NOT EXISTS users (
      id TEXT PRIMARY KEY,
      email TEXT UNIQUE NOT NULL,
      password_hash TEXT NOT NULL,
      name TEXT NOT NULL,
      company_name TEXT,
      role TEXT DEFAULT 'gc',
      created_at TEXT NOT NULL
    );

    CREATE TABLE IF NOT EXISTS subcontractors (
      id TEXT PRIMARY KEY,
      user_id TEXT,
      company_name TEXT NOT NULL,
      trade TEXT NOT NULL,
      contact_person TEXT,
      phone TEXT,
      email TEXT,
      address TEXT,
      notes TEXT,
      status TEXT DEFAULT 'pending_review',
      created_at TEXT NOT NULL,
      updated_at TEXT NOT NULL
    );

    CREATE TABLE IF NOT EXISTS cois (
      id TEXT PRIMARY KEY,
      subcontractor_id TEXT NOT NULL,
      carrier TEXT NOT NULL,
      am_best_rating TEXT,
      policy_number TEXT,
      effective_date TEXT NOT NULL,
      expiration_date TEXT NOT NULL,
      status TEXT DEFAULT 'pending_review',
      reviewer_notes TEXT,
      review_date TEXT,
      certificate_url TEXT,
      certificate_key TEXT,
      certificate_name TEXT,
      certificate_size INTEGER,
      certificate_mime TEXT,
      created_at TEXT NOT NULL,
      updated_at TEXT NOT NULL
    );

    CREATE TABLE IF NOT EXISTS coi_coverages (
      id TEXT PRIMARY KEY,
      coi_id TEXT NOT NULL,
      type TEXT NOT NULL,
      per_occurrence_limit TEXT,
      aggregate_limit TEXT,
      additional_insured INTEGER DEFAULT 0,
      waiver_of_subrogation INTEGER DEFAULT 0,
      notes TEXT
    );

    CREATE TABLE IF NOT EXISTS projects (
      id TEXT PRIMARY KEY,
      user_id TEXT,
      name TEXT NOT NULL,
      code TEXT,
      address TEXT,
      client_name TEXT,
      client_email TEXT,
      start_date TEXT,
      end_date TEXT,
      notes TEXT,
      created_at TEXT NOT NULL
    );

    CREATE TABLE IF NOT EXISTS project_subcontractors (
      id TEXT PRIMARY KEY,
      project_id TEXT NOT NULL,
      subcontractor_id TEXT NOT NULL,
      created_at TEXT NOT NULL,
      UNIQUE(project_id, subcontractor_id)
    );

    CREATE TABLE IF NOT EXISTS client_share_links (
      id TEXT PRIMARY KEY,
      project_id TEXT NOT NULL,
      token TEXT UNIQUE NOT NULL,
      expires_at TEXT,
      created_at TEXT NOT NULL,
      access_count INTEGER DEFAULT 0,
      last_accessed_at TEXT,
      note TEXT
    );

    CREATE TABLE IF NOT EXISTS upload_requests (
      id TEXT PRIMARY KEY,
      subcontractor_id TEXT NOT NULL,
      token TEXT UNIQUE NOT NULL,
      requested_by_email TEXT,
      message TEXT,
      expires_at TEXT,
      used INTEGER DEFAULT 0,
      used_at TEXT,
      created_at TEXT NOT NULL
    );

    CREATE TABLE IF NOT EXISTS email_logs (
      id TEXT PRIMARY KEY,
      to_email TEXT NOT NULL,
      subject TEXT NOT NULL,
      body TEXT,
      type TEXT,
      status TEXT DEFAULT 'simulated',
      sent_at TEXT NOT NULL
    );

    CREATE TABLE IF NOT EXISTS gc_settings (
      id TEXT PRIMARY KEY,
      user_id TEXT,
      company_name TEXT,
      license_number TEXT,
      address TEXT,
      phone TEXT,
      email TEXT,
      logo_url TEXT,
      additional_insured_wording TEXT,
      required_gl_limit TEXT,
      required_auto_limit TEXT,
      required_wc_limit TEXT,
      required_umbrella_limit TEXT,
      expiration_warning_days INTEGER DEFAULT 30,
      updated_at TEXT NOT NULL
    );

    CREATE INDEX IF NOT EXISTS idx_subcontractors_trade ON subcontractors(trade);
    CREATE INDEX IF NOT EXISTS idx_cois_subcontractor ON cois(subcontractor_id);
    CREATE INDEX IF NOT EXISTS idx_cois_expiration ON cois(expiration_date);
    CREATE INDEX IF NOT EXISTS idx_cois_status ON cois(status);
    CREATE INDEX IF NOT EXISTS idx_share_links_token ON client_share_links(token);
    CREATE INDEX IF NOT EXISTS idx_upload_requests_token ON upload_requests(token);
  `

  await dbExec(schema)
  console.log('[db] Schema initialized successfully')
}
