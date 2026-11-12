import type sqlite3 from 'sqlite3'
import pg from 'pg'
import path from 'path'
import fs from 'fs'
import dotenv from 'dotenv'
import { v4 as uuidv4 } from 'uuid'

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
// Keep an entire SQLite transaction exclusive on the shared connection, even
// across awaited calls. This also supports a :memory: database in tests.
let sqliteQueue: Promise<void> = Promise.resolve()

function withSqliteLock<T>(operation: () => Promise<T>): Promise<T> {
  const result = sqliteQueue.then(operation)
  sqliteQueue = result.then(() => undefined, () => undefined)
  return result
}

function sqliteRun(db: sqlite3.Database, sql: string, params: any[] = []): Promise<{ lastID?: number; changes?: number }> {
  return new Promise((resolve, reject) => {
    db.run(sql, params, function (err) {
      if (err) return reject(err)
      resolve({ lastID: this.lastID, changes: this.changes })
    })
  })
}

export const PLAN_PRICES: Record<string, number> = {
  'Free Demo': 0,
  Subcontractor: 2,
  'General Contractor': 10,
  'Pro GC': 29,
}

export function planToMRR(plan: string): number {
  return PLAN_PRICES[plan] ?? 10
}

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

async function getSqlite(): Promise<sqlite3.Database> {
  const sqlite3 = (await import('sqlite3')).default
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

function toPgSql(sql: string): string {
  let i = 1
  return sql.replace(/\?/g, () => `$${i++}`)
}

export async function dbRun(sql: string, params: any[] = []): Promise<{ lastID?: number; changes?: number }> {
  if (isPostgres) {
    const res = await getPgPool().query(toPgSql(sql), params)
    return { changes: res.rowCount ?? 0 }
  }
  return withSqliteLock(async () => sqliteRun(await getSqlite(), sql, params))
}

export async function dbGet<T = any>(sql: string, params: any[] = []): Promise<T | undefined> {
  if (isPostgres) {
    const res = await getPgPool().query(toPgSql(sql), params)
    return res.rows[0] as T | undefined
  }
  return withSqliteLock(async () => {
    const db = await getSqlite()
    return new Promise((resolve, reject) => {
      db.get(sql, params, (err, row) => {
        if (err) return reject(err)
        resolve(row as T | undefined)
      })
    })
  })
}

export async function dbAll<T = any>(sql: string, params: any[] = []): Promise<T[]> {
  if (isPostgres) {
    const res = await getPgPool().query(toPgSql(sql), params)
    return res.rows as T[]
  }
  return withSqliteLock(async () => {
    const db = await getSqlite()
    return new Promise((resolve, reject) => {
      db.all(sql, params, (err, rows) => {
        if (err) return reject(err)
        resolve((rows || []) as T[])
      })
    })
  })
}

export async function dbExec(sql: string): Promise<void> {
  if (isPostgres) {
    await getPgPool().query(sql)
    return
  }
  return withSqliteLock(async () => {
    const db = await getSqlite()
    return new Promise((resolve, reject) => {
      db.exec(sql, (err) => (err ? reject(err) : resolve()))
    })
  })
}

// Delete the parent and its coverages together. The authorization predicate
// is part of the DELETE itself, not a check made before the write.
export async function deleteOwnedGcCOI(id: string, gcUserId: string): Promise<boolean> {
  const deleteSql = `DELETE FROM cois WHERE id = ? AND owner_gc_user_id = ?
    AND owner_sub_user_id IS NULL AND EXISTS (SELECT 1 FROM gc_sub_connections g
      WHERE g.subcontractor_id = cois.subcontractor_id AND g.gc_user_id = ?)`
  if (isPostgres) {
    const client = await getPgPool().connect()
    try {
      await client.query('BEGIN')
      const result = await client.query(toPgSql(deleteSql), [id, gcUserId, gcUserId])
      if (result.rowCount) await client.query('DELETE FROM coi_coverages WHERE coi_id = $1', [id])
      await client.query('COMMIT')
      return Boolean(result.rowCount)
    } catch (error) {
      await client.query('ROLLBACK')
      throw error
    } finally {
      client.release()
    }
  }
  return withSqliteLock(async () => {
    const db = await getSqlite()
    await sqliteRun(db, 'BEGIN IMMEDIATE')
    try {
      const result = await sqliteRun(db, deleteSql, [id, gcUserId, gcUserId])
      if (result.changes) await sqliteRun(db, 'DELETE FROM coi_coverages WHERE coi_id = ?', [id])
      await sqliteRun(db, 'COMMIT')
      return Boolean(result.changes)
    } catch (error) {
      await sqliteRun(db, 'ROLLBACK')
      throw error
    }
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
      first_name TEXT,
      last_name TEXT,
      phone TEXT,
      company_name TEXT,
      role TEXT DEFAULT 'gc',
      subcontractor_id TEXT,
      created_at TEXT NOT NULL
    );

    CREATE TABLE IF NOT EXISTS companies (
      id TEXT PRIMARY KEY,
      name TEXT NOT NULL,
      plan TEXT DEFAULT 'General Contractor',
      mrr INTEGER DEFAULT 10,
      status TEXT DEFAULT 'active',
      owner_user_id TEXT,
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
      website TEXT,
      status TEXT DEFAULT 'pending_review',
      created_at TEXT NOT NULL,
      updated_at TEXT NOT NULL
    );

    CREATE TABLE IF NOT EXISTS gc_sub_connections (
      gc_user_id TEXT NOT NULL,
      subcontractor_id TEXT NOT NULL,
      created_at TEXT NOT NULL,
      PRIMARY KEY(gc_user_id, subcontractor_id)
    );
    CREATE INDEX IF NOT EXISTS idx_gc_sub_connections_sub ON gc_sub_connections(subcontractor_id);

    CREATE TABLE IF NOT EXISTS cois (
      id TEXT PRIMARY KEY,
      subcontractor_id TEXT NOT NULL,
      owner_gc_user_id TEXT,
      owner_sub_user_id TEXT,
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

    CREATE TABLE IF NOT EXISTS sub_email_logs (
      email_log_id TEXT PRIMARY KEY,
      subcontractor_id TEXT NOT NULL
    );
    CREATE INDEX IF NOT EXISTS idx_sub_email_logs_sub ON sub_email_logs(subcontractor_id);

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
      invite_code TEXT,
      updated_at TEXT NOT NULL
    );

    CREATE INDEX IF NOT EXISTS idx_subcontractors_trade ON subcontractors(trade);
    CREATE INDEX IF NOT EXISTS idx_cois_subcontractor ON cois(subcontractor_id);
    CREATE INDEX IF NOT EXISTS idx_cois_expiration ON cois(expiration_date);
    CREATE INDEX IF NOT EXISTS idx_cois_status ON cois(status);
    CREATE INDEX IF NOT EXISTS idx_share_links_token ON client_share_links(token);
    CREATE TABLE IF NOT EXISTS user_phones (
      id TEXT PRIMARY KEY,
      user_id TEXT NOT NULL,
      phone TEXT NOT NULL,
      label TEXT DEFAULT 'mobile',
      is_primary INTEGER DEFAULT 0,
      created_at TEXT NOT NULL
    );
    CREATE INDEX IF NOT EXISTS idx_user_phones_user ON user_phones(user_id);
    CREATE INDEX IF NOT EXISTS idx_upload_requests_token ON upload_requests(token);
  `

  await dbExec(schema)
  console.log('[db] Schema initialized successfully')

  // A connection alone does not establish ownership. In particular, leave
  // existing rows unowned rather than guessing which user created them.
  for (const column of ['owner_gc_user_id', 'owner_sub_user_id']) {
    if (isPostgres) {
      await dbRun(`ALTER TABLE cois ADD COLUMN IF NOT EXISTS ${column} TEXT`)
    } else {
      const columns = await dbAll<{ name: string }>('PRAGMA table_info(cois)')
      if (!columns.some((entry) => entry.name === column)) {
        try {
          await dbRun(`ALTER TABLE cois ADD COLUMN ${column} TEXT`)
        } catch (error) {
          // Another process may have completed the same migration. Do not
          // suppress unrelated schema or database errors.
          const current = await dbAll<{ name: string }>('PRAGMA table_info(cois)')
          if (!current.some((entry) => entry.name === column)) throw error
        }
      }
    }
  }

  try {
    await dbRun('ALTER TABLE users ADD COLUMN subcontractor_id TEXT')
  } catch {}
  try {
    await dbRun('ALTER TABLE users ADD COLUMN first_name TEXT')
  } catch {}
  try {
    await dbRun('ALTER TABLE users ADD COLUMN last_name TEXT')
  } catch {}
  try {
    await dbRun('ALTER TABLE users ADD COLUMN phone TEXT')
  } catch {}
  try {
    await dbRun('ALTER TABLE gc_settings ADD COLUMN invite_code TEXT')
  } catch {}
  try {
    await dbRun('ALTER TABLE subcontractors ADD COLUMN website TEXT')
  } catch {}

  try {
    const users = await dbAll('SELECT id, company_name, created_at FROM users WHERE company_name IS NOT NULL')
    for (const u of users) {
      const existing = await dbGet('SELECT id FROM companies WHERE name = ?', [u.company_name])
      if (!existing) {
        await dbRun(
          `INSERT INTO companies (id, name, plan, mrr, status, owner_user_id, created_at)
           VALUES (?, ?, 'General Contractor', 10, 'active', ?, ?)`,
          [uuidv4(), u.company_name, u.id, u.created_at || new Date().toISOString()]
        )
      }
    }
  } catch (e: any) {
    console.warn('[db] companies backfill warning:', e?.message)
  }
}
