/**
 * HTTP response contract helpers.
 * Traceability: PS-DATA-009 §52, §53 | PS-TECH-008 §26
 *
 * Success: { "data": ..., "meta": {...} }
 * Error:   { "error": { "code", "message", "details" } }
 */
import type { Context } from 'hono'
import { AppError, ErrorCode } from './errors'

export type Meta = Record<string, unknown>

export function ok<T>(c: Context, data: T, meta: Meta = {}, status = 200) {
  return c.json({ data, meta }, status as 200)
}

export function created<T>(c: Context, data: T, meta: Meta = {}) {
  return c.json({ data, meta }, 201)
}

export interface PageMeta {
  page: number
  limit: number
  total: number
  total_pages: number
}

export function paginated<T>(c: Context, rows: T[], page: number, limit: number, total: number, extra: Meta = {}) {
  const meta: PageMeta & Meta = {
    page,
    limit,
    total,
    total_pages: limit > 0 ? Math.ceil(total / limit) : 0,
    ...extra
  }
  return c.json({ data: rows, meta })
}

export function fail(c: Context, err: unknown) {
  if (err instanceof AppError) {
    return c.json(err.toJSON(), err.status as 400)
  }
  // Map raw DB constraint breaches into the stable contract instead of leaking SQL.
  const raw = err instanceof Error ? err.message : String(err)
  if (/UNIQUE constraint failed: *rentals/i.test(raw) || /uq_rentals_one_occupying_per_property/i.test(raw)) {
    return c.json(
      {
        error: {
          code: ErrorCode.BUSINESS_RULE_VIOLATION,
          message: 'Property already has an occupying rental.',
          details: {},
          rule: 'DR-008'
        }
      },
      409
    )
  }
  if (/UNIQUE constraint failed/i.test(raw)) {
    return c.json(
      { error: { code: ErrorCode.CONFLICT, message: 'Record already exists.', details: {} } },
      409
    )
  }
  if (/FOREIGN KEY constraint failed/i.test(raw)) {
    return c.json(
      {
        error: {
          code: ErrorCode.VALIDATION_ERROR,
          message: 'A referenced record does not exist.',
          details: {}
        }
      },
      422
    )
  }
  console.error('[UNHANDLED]', raw)
  return c.json(
    { error: { code: ErrorCode.INTERNAL_ERROR, message: 'An unexpected error occurred.', details: {} } },
    500
  )
}

/** Parse ?page= & ?limit= with safe bounds (§58 performance: always paginate). */
export function readPagination(c: Context, defaultLimit = 20, maxLimit = 100) {
  const page = Math.max(1, Number(c.req.query('page') ?? 1) || 1)
  const rawLimit = Number(c.req.query('limit') ?? defaultLimit) || defaultLimit
  const limit = Math.min(maxLimit, Math.max(1, rawLimit))
  return { page, limit, offset: (page - 1) * limit }
}

/**
 * Parse ?sort=-score into a safe ORDER BY clause.
 * Only whitelisted columns are accepted (§54 filtering must stay restricted).
 */
export function readSort(c: Context, allowed: readonly string[], fallback: string) {
  const raw = c.req.query('sort')
  if (!raw) return fallback
  const desc = raw.startsWith('-')
  const field = desc ? raw.slice(1) : raw
  if (!allowed.includes(field)) return fallback
  return `${field} ${desc ? 'DESC' : 'ASC'}`
}
