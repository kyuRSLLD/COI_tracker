// Deliberately disconnected from application startup and routes. The subject must
// come ONLY from a credential verified by the trusted caller, never request data.
import { randomUUID } from 'node:crypto'
import { z } from 'zod'
import type { OwnerConnection, SqlValue } from '../db/ownerConnection.ts'

export class OwnerWriteError extends Error {
  readonly code: 'INVALID_INPUT' | 'STORAGE_FAILURE'
  constructor(code: 'INVALID_INPUT' | 'STORAGE_FAILURE') {
    super(code === 'INVALID_INPUT' ? 'Invalid input' : 'Owner write unavailable')
    this.name = 'OwnerWriteError'
    this.code = code
  }
}
const required = z.string().trim().min(1).max(500)
const optional = z.string().max(4000).nullable().optional()
const date = z.string().regex(/^\d{4}-\d{2}-\d{2}$/).refine(s => {
  const d = new Date(`${s}T00:00:00.000Z`)
  return !Number.isNaN(d.valueOf()) && d.toISOString().slice(0, 10) === s
})
const subFields = {
  company_name: required, trade: required, contact_person: optional, phone: optional,
  email: optional, address: optional, notes: optional,
}
const coiFields = {
  carrier: required, am_best_rating: optional, policy_number: optional,
  effective_date: date, expiration_date: date, reviewer_notes: optional,
}
const createSubSchema = z.object(subFields).strict()
const updateSubSchema = createSubSchema.partial().strict().refine(v => Object.keys(v).length > 0)
const createCoiSchema = z.object({ subcontractor_id: required, ...coiFields }).strict()
const updateCoiSchema = z.object(coiFields).partial().strict().refine(v => Object.keys(v).length > 0)
const idSchema = z.string().min(1).max(500).refine(s => s.trim().length > 0)
const subColumns = ['company_name', 'trade', 'contact_person', 'phone', 'email', 'address', 'notes'] as const
const coiColumns = ['carrier', 'am_best_rating', 'policy_number', 'effective_date', 'expiration_date', 'reviewer_notes'] as const

export type CreateSubcontractorInput = z.input<typeof createSubSchema>
export type UpdateSubcontractorInput = z.input<typeof updateSubSchema>
export type CreateCoiInput = z.input<typeof createCoiSchema>
export type UpdateCoiInput = z.input<typeof updateCoiSchema>
export type CreatedOrUpdated = { id: string } | undefined

function parse<T>(schema: z.ZodType<T, any, any>, input: unknown): T {
  const result = schema.safeParse(input)
  if (!result.success) throw new OwnerWriteError('INVALID_INPUT')
  return result.data
}
function checkDates(effective: string, expiration: string): void {
  if (effective > expiration) throw new OwnerWriteError('INVALID_INPUT')
}

/**
 * Requires an exclusively held, idle connection, with enforced foreign keys on
 * every SQLite write connection. No pool, nested transaction, or shared session.
 * Each method returns undefined for missing, unmapped, unrelated, or non-GC.
 * A database failure is sanitized; discard the session and investigate before retry.
 */
export function ownerWrites(db: OwnerConnection, verifiedSubject: string) {
  parse(idSchema, verifiedSubject)
  const lock = db.dialect === 'postgres' ? ' FOR UPDATE' : ''

  async function transaction<T>(work: () => Promise<T>): Promise<T | undefined> {
    let begun = false
    try {
      if (db.dialect === 'sqlite') {
        const fk = await db.query<{ foreign_keys: number }>('PRAGMA foreign_keys')
        if (fk[0]?.foreign_keys !== 1) throw new Error('foreign keys unavailable')
      }
      await db.query(db.dialect === 'sqlite' ? 'BEGIN IMMEDIATE' : 'BEGIN')
      begun = true
      // Lock before examining role: a concurrent role change either precedes the
      // write or waits until it commits. SQLite's immediate transaction serializes writers.
      const role = await db.query<{ id: string }>(`SELECT id FROM users WHERE id = ? AND role = 'gc'${lock}`, [verifiedSubject])
      const result = role.length ? await work() : undefined
      await db.query('COMMIT')
      begun = false
      return result
    } catch (error) {
      if (begun) {
        try { await db.query('ROLLBACK') } catch { throw new OwnerWriteError('STORAGE_FAILURE') }
      }
      if (error instanceof OwnerWriteError && error.code === 'INVALID_INPUT') throw error
      // Never attach original SQL/driver errors or data as cause.
      throw new OwnerWriteError('STORAGE_FAILURE')
    }
  }

  async function lockSub(id: string): Promise<boolean> {
    const rows = await db.query<{ subcontractor_id: string }>(
      `SELECT subcontractor_id FROM owner_subcontractor_connections WHERE subcontractor_id = ? AND owner_user_id = ?${lock}`,
      [id, verifiedSubject])
    return rows.length === 1
  }
  async function lockCoi(id: string): Promise<string | undefined> {
    const rows = await db.query<{ subcontractor_id: string }>(
      `SELECT subcontractor_id FROM owner_coi_records WHERE coi_id = ? AND owner_user_id = ?${lock}`,
      [id, verifiedSubject])
    const sub = rows[0]?.subcontractor_id
    return sub && await lockSub(sub) ? sub : undefined
  }

  return {
    async createSubcontractor(input: CreateSubcontractorInput): Promise<CreatedOrUpdated> {
      const data = parse(createSubSchema, input)
      return transaction(async () => {
        const id = randomUUID(), now = new Date().toISOString()
        await db.query(`INSERT INTO subcontractors
          (id, company_name, trade, contact_person, phone, email, address, notes, status, created_at, updated_at)
          VALUES (?, ?, ?, ?, ?, ?, ?, ?, 'pending_review', ?, ?)`,
          [id, data.company_name, data.trade, data.contact_person ?? null, data.phone ?? null,
            data.email ?? null, data.address ?? null, data.notes ?? null, now, now])
        await db.query('INSERT INTO owner_subcontractor_connections (subcontractor_id, owner_user_id, assigned_at) VALUES (?, ?, ?)',
          [id, verifiedSubject, now])
        return { id }
      })
    },
    async updateSubcontractor(id: string, input: UpdateSubcontractorInput): Promise<CreatedOrUpdated> {
      parse(idSchema, id)
      const data = parse(updateSubSchema, input)
      return transaction(async () => {
        if (!await lockSub(id)) return undefined
        // Column names come only from the static allowlist, never the request.
        const cols = subColumns.filter(k => data[k] !== undefined)
        if (!cols.length) throw new OwnerWriteError('INVALID_INPUT')
        const values: SqlValue[] = cols.map(k => data[k] as string | null)
        const rows = await db.query<{ id: string }>(`UPDATE subcontractors SET ${cols.map(k => `${k} = ?`).join(', ')}, updated_at = ?
          WHERE id = ? AND EXISTS (SELECT 1 FROM owner_subcontractor_connections sc
            JOIN users u ON u.id = sc.owner_user_id AND u.role = 'gc'
            WHERE sc.subcontractor_id = subcontractors.id AND sc.owner_user_id = ?) RETURNING id`,
          [...values, new Date().toISOString(), id, verifiedSubject])
        return rows[0]
      })
    },
    async createCoi(input: CreateCoiInput): Promise<CreatedOrUpdated> {
      const data = parse(createCoiSchema, input)
      checkDates(data.effective_date, data.expiration_date)
      return transaction(async () => {
        if (!await lockSub(data.subcontractor_id)) return undefined
        const id = randomUUID(), now = new Date().toISOString()
        const rows = await db.query<{ id: string }>(`INSERT INTO cois
          (id, subcontractor_id, carrier, am_best_rating, policy_number, effective_date, expiration_date, status, reviewer_notes, created_at, updated_at)
          SELECT ?, sc.subcontractor_id, ?, ?, ?, ?, ?, 'pending_review', ?, ?, ?
          FROM owner_subcontractor_connections sc JOIN users u ON u.id = sc.owner_user_id AND u.role = 'gc'
          WHERE sc.subcontractor_id = ? AND sc.owner_user_id = ? RETURNING id`,
          [id, data.carrier, data.am_best_rating ?? null, data.policy_number ?? null,
            data.effective_date, data.expiration_date, data.reviewer_notes ?? null, now, now,
            data.subcontractor_id, verifiedSubject])
        if (!rows.length) return undefined
        await db.query('INSERT INTO owner_coi_records (coi_id, subcontractor_id, owner_user_id, assigned_at) VALUES (?, ?, ?, ?)',
          [id, data.subcontractor_id, verifiedSubject, now])
        return { id }
      })
    },
    async updateCoi(id: string, input: UpdateCoiInput): Promise<CreatedOrUpdated> {
      parse(idSchema, id)
      const data = parse(updateCoiSchema, input)
      return transaction(async () => {
        if (!await lockCoi(id)) return undefined
        const current = await db.query<{ effective_date: string; expiration_date: string }>(`SELECT c.effective_date, c.expiration_date FROM cois c
          JOIN owner_coi_records oc ON oc.coi_id = c.id AND oc.subcontractor_id = c.subcontractor_id
          JOIN owner_subcontractor_connections sc ON sc.subcontractor_id = oc.subcontractor_id AND sc.owner_user_id = oc.owner_user_id
          JOIN users u ON u.id = oc.owner_user_id AND u.role = 'gc'
          WHERE c.id = ? AND oc.owner_user_id = ?${lock}`, [id, verifiedSubject])
        if (!current.length) return undefined
        checkDates(data.effective_date ?? current[0].effective_date, data.expiration_date ?? current[0].expiration_date)
        const cols = coiColumns.filter(k => data[k] !== undefined)
        if (!cols.length) throw new OwnerWriteError('INVALID_INPUT')
        const values: SqlValue[] = cols.map(k => data[k] as string | null)
        const rows = await db.query<{ id: string }>(`UPDATE cois SET ${cols.map(k => `${k} = ?`).join(', ')}, updated_at = ?
          WHERE id = ? AND EXISTS (SELECT 1 FROM owner_coi_records oc
            JOIN owner_subcontractor_connections sc ON sc.subcontractor_id = oc.subcontractor_id AND sc.owner_user_id = oc.owner_user_id
            JOIN users u ON u.id = oc.owner_user_id AND u.role = 'gc'
            WHERE oc.coi_id = cois.id AND oc.subcontractor_id = cois.subcontractor_id AND oc.owner_user_id = ?) RETURNING id`,
          [...values, new Date().toISOString(), id, verifiedSubject])
        return rows[0]
      })
    },
  }
}
