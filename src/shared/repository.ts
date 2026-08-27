/**
 * Thin repository helpers over D1.
 * Traceability: PS-IMP-011 §30, §31 | PS-MASTER-001 §37
 *
 * Application/domain code depends on these narrow helpers rather than on raw
 * ORM/driver semantics spread across the codebase.
 */
import { NotFoundError } from './errors'

export type Row = Record<string, unknown>

export async function findOne<T = Row>(
  db: D1Database,
  sql: string,
  params: unknown[] = []
): Promise<T | null> {
  const row = await db
    .prepare(sql)
    .bind(...params)
    .first<T>()
  return row ?? null
}

export async function findOneOrFail<T = Row>(
  db: D1Database,
  sql: string,
  params: unknown[],
  entity: string,
  id?: string
): Promise<T> {
  const row = await findOne<T>(db, sql, params)
  if (!row) throw new NotFoundError(entity, id)
  return row
}

export async function findMany<T = Row>(
  db: D1Database,
  sql: string,
  params: unknown[] = []
): Promise<T[]> {
  const res = await db
    .prepare(sql)
    .bind(...params)
    .all<T>()
  return res.results ?? []
}

export async function count(db: D1Database, sql: string, params: unknown[] = []): Promise<number> {
  const row = await findOne<{ c: number }>(db, sql, params)
  return Number(row?.c ?? 0)
}

export async function run(db: D1Database, sql: string, params: unknown[] = []) {
  return db
    .prepare(sql)
    .bind(...params)
    .run()
}

/**
 * Execute statements atomically. D1's batch() runs all statements inside a
 * single implicit transaction — all succeed or all roll back
 * (PS-IMP-011 §32 transaction boundary).
 */
export async function transaction(db: D1Database, statements: D1PreparedStatement[]) {
  return db.batch(statements)
}

/** Build a WHERE clause from whitelisted filters only (§54). */
export class FilterBuilder {
  private clauses: string[] = []
  private params: unknown[] = []

  eq(column: string, value: unknown) {
    if (value !== undefined && value !== null && value !== '') {
      this.clauses.push(`${column} = ?`)
      this.params.push(value)
    }
    return this
  }

  in(column: string, values?: string[] | null) {
    if (values && values.length > 0) {
      this.clauses.push(`${column} IN (${values.map(() => '?').join(', ')})`)
      this.params.push(...values)
    }
    return this
  }

  like(columns: string[], term?: string | null) {
    if (term && term.trim()) {
      const t = `%${term.trim().toLowerCase()}%`
      this.clauses.push(`(${columns.map((col) => `LOWER(${col}) LIKE ?`).join(' OR ')})`)
      columns.forEach(() => this.params.push(t))
    }
    return this
  }

  gte(column: string, value: unknown) {
    if (value !== undefined && value !== null && value !== '') {
      this.clauses.push(`${column} >= ?`)
      this.params.push(value)
    }
    return this
  }

  lte(column: string, value: unknown) {
    if (value !== undefined && value !== null && value !== '') {
      this.clauses.push(`${column} <= ?`)
      this.params.push(value)
    }
    return this
  }

  raw(clause: string, ...params: unknown[]) {
    this.clauses.push(clause)
    this.params.push(...params)
    return this
  }

  where(): string {
    return this.clauses.length ? `WHERE ${this.clauses.join(' AND ')}` : ''
  }

  values(): unknown[] {
    return this.params
  }
}

/** Safe JSON parse for TEXT columns holding JSON arrays/objects. */
export function parseJson<T>(raw: unknown, fallback: T): T {
  if (raw === null || raw === undefined) return fallback
  if (typeof raw !== 'string') return raw as T
  try {
    return JSON.parse(raw) as T
  } catch {
    return fallback
  }
}
