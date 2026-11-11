// This module is deliberately not imported by application startup.
// The caller owns the connection and must not share it concurrently during a migration.
import type sqlite3 from 'sqlite3'
import type pg from 'pg'

export type SqlValue = string | number | null
export type Row = Record<string, unknown>
export interface OwnerConnection {
  readonly dialect: 'sqlite' | 'postgres'
  // Single statement; positional '?' parameters only. Never interpolate user input.
  query<T extends Row = Row>(sql: string, values?: SqlValue[]): Promise<T[]>
}

export function sqliteOwnerConnection(db: sqlite3.Database): OwnerConnection {
  return {
    dialect: 'sqlite',
    query<T extends Row>(sql: string, values: SqlValue[] = []): Promise<T[]> {
      return new Promise((resolve, reject) => {
        db.all(sql, values, (error, rows) => error ? reject(error) : resolve((rows || []) as T[]))
      })
    },
  }
}

// Pass a checked-out PoolClient or connected Client, never a Pool. The caller
// controls connection lifecycle; a transaction must stay on exactly one session.
export function postgresOwnerConnection(client: pg.PoolClient | pg.Client): OwnerConnection {
  return {
    dialect: 'postgres',
    async query<T extends Row>(sql: string, values: SqlValue[] = []): Promise<T[]> {
      let index = 0
      const result = await client.query(sql.replace(/\?/g, () => `$${++index}`), values)
      return result.rows as T[]
    },
  }
}
