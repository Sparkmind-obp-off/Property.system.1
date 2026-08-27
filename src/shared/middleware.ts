/**
 * HTTP middleware: request id, authentication, authorization.
 * Traceability: PS-DATA-009 §60 | PS-TECH-008 §25 | PS-MASTER-001 §34
 *
 * Pipeline: REQUEST → AUTHENTICATE → AUTHORIZE → VALIDATE → SERVICE → …
 */
import type { MiddlewareHandler } from 'hono'
import { verifyJwt } from './crypto'
import { ForbiddenError, UnauthorizedError } from './errors'
import { ID } from './id'
import { toAuthUser, type Env } from './types'

export function jwtSecret(env: { JWT_SECRET?: string }): string {
  // Local dev fallback keeps the sandbox usable; production MUST set the secret.
  return env.JWT_SECRET || 'dev-only-insecure-secret-change-me'
}

export function jwtTtl(env: { JWT_TTL_SECONDS?: string }): number {
  const n = Number(env.JWT_TTL_SECONDS)
  return Number.isFinite(n) && n > 0 ? n : 43_200
}

/** Attach a correlation id to every request (§47 observability). */
export const requestId: MiddlewareHandler<Env> = async (c, next) => {
  const incoming = c.req.header('x-request-id')
  const id = incoming && incoming.length <= 64 ? incoming : ID.request()
  c.set('requestId', id)
  await next()
  c.header('x-request-id', id)
}

/** Requires a valid bearer token; populates c.var.user. */
export const authenticate: MiddlewareHandler<Env> = async (c, next) => {
  const header = c.req.header('authorization') || ''
  const token = header.toLowerCase().startsWith('bearer ') ? header.slice(7).trim() : ''
  if (!token) throw new UnauthorizedError('Authentication required.')
  const payload = await verifyJwt(token, jwtSecret(c.env))
  c.set('user', toAuthUser(payload))
  await next()
}

/**
 * Requires ALL listed permissions. Server-side is the only authority
 * (PS-TECH-008 §29 — UI hiding is a usability layer).
 */
export function requirePermission(...required: string[]): MiddlewareHandler<Env> {
  return async (c, next) => {
    const user = c.var.user
    if (!user) throw new UnauthorizedError()
    const missing = required.filter((p) => !user.permissions.includes(p))
    if (missing.length > 0) {
      throw new ForbiddenError('You do not have permission to perform this action.', {
        required,
        missing
      })
    }
    await next()
  }
}

/** Requires at least one of the listed roles. */
export function requireRole(...roles: string[]): MiddlewareHandler<Env> {
  return async (c, next) => {
    const user = c.var.user
    if (!user) throw new UnauthorizedError()
    if (!user.roles.some((r) => roles.includes(r))) {
      throw new ForbiddenError('Your role cannot access this resource.', { roles })
    }
    await next()
  }
}
