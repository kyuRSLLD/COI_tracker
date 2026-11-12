import { z } from 'zod'
import { dbAll, dbGet } from '../db/db.ts'
import { normalizeLoginEmail } from './loginRateLimit.ts'

const registrationEmail = z.string().max(254).email()

export function isValidRegistrationEmail(email: string): boolean {
  return registrationEmail.safeParse(email).success
}

// Use the same JavaScript normalization for stored and submitted addresses.
// SQLite's lower() is ASCII-only and PostgreSQL's depends on its collation;
// neither reliably implements String.toLowerCase() for legacy Unicode data.
// Page by the indexed primary key rather than materializing the entire table.
// Stop as soon as a collision is found; never select an arbitrary account.
// This scan is O(number of users) and is not an atomic snapshot. Concurrent
// inserts/updates can race this check; durable normalized uniqueness and
// transactional account creation require a separately planned DB migration.
export async function findNormalizedEmailUsers(normalizedEmail: string): Promise<Array<{ id: string; email: string }>> {
  const matches: Array<{ id: string; email: string }> = []
  let afterId: string | undefined
  const pageSize = 500
  while (true) {
    const rows: Array<{ id: string; email: string }> = afterId === undefined
      ? await dbAll('SELECT id, email FROM users ORDER BY id LIMIT ?', [pageSize])
      : await dbAll('SELECT id, email FROM users WHERE id > ? ORDER BY id LIMIT ?', [afterId, pageSize])
    for (const row of rows) {
      if (typeof row.email === 'string' && normalizeLoginEmail(row.email) === normalizedEmail) {
        matches.push(row)
        if (matches.length === 2) return matches
      }
    }
    if (rows.length < pageSize) return matches
    afterId = rows[rows.length - 1].id
  }
}

// Refuse to use a selected record if its email changed after the scan.
export async function getMatchedUser(match: { id: string; email: string }): Promise<any | undefined> {
  const user = await dbGet('SELECT * FROM users WHERE id = ? AND email = ?', [match.id, match.email])
  return user?.email === match.email ? user : undefined
}
