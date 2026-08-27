/**
 * Identity — HTTP routes.
 * Traceability: PS-DATA-009 §39 (/api/v1/users) | PS-UX-010 §47 (01 Login)
 */
import { Hono } from 'hono'
import { AuthService, ASSIGNABLE_ROLES } from '../application/auth.service'
import { authenticate, jwtSecret, jwtTtl, requirePermission } from '../../../shared/middleware'
import { created, ok } from '../../../shared/http'
import { v, validateBody } from '../../../shared/validate'
import { findMany } from '../../../shared/repository'
import { auditStmt } from '../../../shared/audit'
import type { Env } from '../../../shared/types'

export const identityRoutes = new Hono<Env>()

function service(c: any) {
  return new AuthService(c.env.DB, jwtSecret(c.env), jwtTtl(c.env))
}

/** POST /api/v1/auth/login — public. */
identityRoutes.post('/auth/login', async (c) => {
  const body = await validateBody(c.req.raw)
  const input = v(body).email('email', { required: true }).string('password', { required: true, min: 1 }).result<{
    email: string
    password: string
  }>()
  const result = await service(c).login(input.email, input.password, c.var.requestId)
  return ok(c, result)
})

/** POST /api/v1/auth/logout — token is stateless; audit the intent. */
identityRoutes.post('/auth/logout', authenticate, async (c) => {
  const user = c.var.user!
  await c.env.DB.batch([
    auditStmt(c.env.DB, {
      userId: user.id,
      entityType: 'USER',
      entityId: user.id,
      action: 'LOGOUT',
      requestId: c.var.requestId
    })
  ])
  return ok(c, { logged_out: true })
})

/** GET /api/v1/auth/me — session bootstrap for permission-aware UI. */
identityRoutes.get('/auth/me', authenticate, async (c) => {
  return ok(c, await service(c).me(c.var.user!.id))
})

/** GET /api/v1/users — ADMIN governance screen. */
identityRoutes.get('/users', authenticate, requirePermission('user.read'), async (c) => {
  return ok(c, await service(c).listUsers())
})

/** POST /api/v1/users */
identityRoutes.post('/users', authenticate, requirePermission('user.manage'), async (c) => {
  const body = await validateBody(c.req.raw)
  const base = v(body)
    .string('name', { required: true, min: 2, max: 120 })
    .email('email', { required: true })
    .string('password', { required: true, min: 8, max: 128 })
    .stringArray('roles', { required: true, maxItems: 5 })
    .result<{ name: string; email: string; password: string; roles: string[] }>()

  const roles = base.roles.map((r) => r.toUpperCase())
  const invalid = roles.filter((r) => !ASSIGNABLE_ROLES.includes(r as any))
  v({ roles }).check(invalid.length === 0, 'roles', `invalid role(s): ${invalid.join(', ')}`).result()

  const user = await service(c).createUser(
    { ...base, roles },
    c.var.user!.id,
    c.var.requestId
  )
  return created(c, user)
})

/** GET /api/v1/roles — roles + effective permissions + member counts. */
identityRoutes.get('/roles', authenticate, requirePermission('user.read'), async (c) => {
  return ok(c, await service(c).listRoles())
})

/** GET /api/v1/permissions — the permission registry (UI must not hardcode it). */
identityRoutes.get('/permissions', authenticate, requirePermission('user.read'), async (c) => {
  return ok(c, service(c).listPermissions())
})

/** GET /api/v1/audit-logs — governance / traceability screen (§46 audit). */
identityRoutes.get('/audit-logs', authenticate, requirePermission('audit.read'), async (c) => {
  const limit = Math.min(200, Math.max(1, Number(c.req.query('limit') ?? 50) || 50))
  const entityType = c.req.query('entity_type')
  const rows = await findMany(
    c.env.DB,
    // §46 requires WHO / WHAT / WHEN to be machine-readable, so the actor id is
    // exposed alongside the human-readable name/email.
    `SELECT a.id, a.user_id, a.entity_type, a.entity_id, a.action, a.old_value, a.new_value,
            a.created_at, a.request_id, u.name AS user_name, u.email AS user_email
       FROM audit_logs a
       LEFT JOIN users u ON u.id = a.user_id
      ${entityType ? 'WHERE a.entity_type = ?' : ''}
      ORDER BY a.created_at DESC
      LIMIT ?`,
    entityType ? [entityType, limit] : [limit]
  )
  return ok(c, rows, { limit })
})
