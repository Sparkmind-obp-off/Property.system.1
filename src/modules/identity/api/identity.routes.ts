/**
 * Identity — HTTP routes.
 * Traceability: PS-DATA-009 §39 (/api/v1/users) | PS-UX-010 §47 (01 Login)
 */
import { Hono } from 'hono'
import { AuthService, ASSIGNABLE_ROLES } from '../application/auth.service'
import { ensureBootstrap } from '../application/bootstrap.gate'
import { MIN_BOOTSTRAP_PASSWORD, publicSystemStatus, systemStatus } from '../application/bootstrap.service'
import {
  authenticate,
  hasExplicitJwtSecret,
  jwtSecret,
  jwtTtl,
  requirePermission
} from '../../../shared/middleware'
import { created, ok } from '../../../shared/http'
import { v, validateBody } from '../../../shared/validate'
import { findMany } from '../../../shared/repository'
import { auditStmt } from '../../../shared/audit'
import { APP_VERSION } from '../../../shared/version'
import type { Env } from '../../../shared/types'

export const identityRoutes = new Hono<Env>()

function service(c: any) {
  return new AuthService(c.env.DB, jwtSecret(c.env), jwtTtl(c.env))
}

/**
 * POST /api/v1/auth/login — public.
 *
 * The bootstrap gate runs before authentication so a freshly deployed system
 * provisions its initial ADMIN on the very first login attempt (§4, §8) instead
 * of requiring a separate manual step.
 */
identityRoutes.post('/auth/login', async (c) => {
  const body = await validateBody(c.req.raw)
  const input = v(body).email('email', { required: true }).string('password', { required: true, min: 1 }).result<{
    email: string
    password: string
  }>()
  await ensureBootstrap(c.env)
  const result = await service(c).login(input.email, input.password, c.var.requestId)
  return ok(c, result)
})

/**
 * GET /api/v1/system/status — §9 Admin Setup / System Status.
 *
 * ADMIN-only (`user.manage`). Returns operational STATUS ONLY: no secret value,
 * no password hash, no token, no API key ever appears in this payload (§9).
 */
identityRoutes.get('/system/status', authenticate, requirePermission('user.manage'), async (c) => {
  const status = await systemStatus(c.env, {
    version: APP_VERSION,
    jwtSecretConfigured: hasExplicitJwtSecret(c.env),
    tokenTtl: jwtTtl(c.env)
  })
  return ok(c, status)
})

/**
 * GET /api/v1/system/public-status — §16 pre-login diagnostic state.
 *
 * Deliberately UNAUTHENTICATED: §16 requires an operator to be able to tell,
 * before logging in, whether the deployment is usable. The payload is capped by
 * `PublicSystemStatus` to the five facts §16 allows — application, database,
 * authentication, bootstrap, version — and can therefore carry no secret, hash,
 * token, database credential or stack trace (§37, §42).
 *
 * No bootstrap gate here: reading status must never provision an account.
 */
identityRoutes.get('/system/public-status', async (c) => {
  const status = await publicSystemStatus(c.env, {
    version: APP_VERSION,
    jwtSecretConfigured: hasExplicitJwtSecret(c.env)
  })
  return ok(c, status)
})

/**
 * POST /api/v1/auth/change-password — the account owner rotates their own
 * credential. Mandatory after a bootstrap or an admin reset (§8).
 */
identityRoutes.post('/auth/change-password', authenticate, async (c) => {
  const body = await validateBody(c.req.raw)
  const input = v(body)
    .string('current_password', { required: true, min: 1 })
    .string('new_password', { required: true, min: MIN_BOOTSTRAP_PASSWORD, max: 128 })
    .result<{ current_password: string; new_password: string }>()

  const result = await service(c).changeOwnPassword(
    c.var.user!.id,
    input.current_password,
    input.new_password,
    c.var.requestId
  )
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

/** GET /api/v1/users/:id — single user with roles and credential METADATA. */
identityRoutes.get('/users/:id', authenticate, requirePermission('user.read'), async (c) => {
  return ok(c, await service(c).userDetail(c.req.param('id')))
})

/** PATCH /api/v1/users/:id — profile fields only; never credentials (§10 EDIT). */
identityRoutes.patch('/users/:id', authenticate, requirePermission('user.manage'), async (c) => {
  const body = await validateBody(c.req.raw)
  const input = v(body)
    .string('name', { min: 2, max: 120 })
    .email('email')
    .result<{ name?: string; email?: string }>()

  v(input)
    .check(
      input.name !== undefined || input.email !== undefined,
      'body',
      'provide at least one of: name, email'
    )
    .result()

  const user = await service(c).updateUser(c.req.param('id'), input, c.var.user!.id, c.var.requestId)
  return ok(c, user)
})

/** PATCH /api/v1/users/:id/status — DISABLE / ENABLE (§10). */
identityRoutes.patch('/users/:id/status', authenticate, requirePermission('user.manage'), async (c) => {
  const body = await validateBody(c.req.raw)
  const input = v(body)
    .enum('status', ['ACTIVE', 'INACTIVE'] as const, { required: true })
    .result<{ status: 'ACTIVE' | 'INACTIVE' }>()

  const user = await service(c).setUserStatus(
    c.req.param('id'),
    input.status,
    c.var.user!.id,
    c.var.requestId
  )
  return ok(c, user)
})

/**
 * POST /api/v1/users/:id/disable — §26 action-shaped alias of the status
 * transition above. §26 names `/disable` and `/enable` explicitly, and an
 * intent-named action is also safer than a free-form status field: the intent
 * is fixed by the URL, so no body can be crafted to mean something else.
 */
identityRoutes.post('/users/:id/disable', authenticate, requirePermission('user.manage'), async (c) => {
  const user = await service(c).setUserStatus(c.req.param('id'), 'INACTIVE', c.var.user!.id, c.var.requestId)
  return ok(c, user)
})

/** POST /api/v1/users/:id/enable — §26 counterpart of `/disable`. */
identityRoutes.post('/users/:id/enable', authenticate, requirePermission('user.manage'), async (c) => {
  const user = await service(c).setUserStatus(c.req.param('id'), 'ACTIVE', c.var.user!.id, c.var.requestId)
  return ok(c, user)
})

/** PUT /api/v1/users/:id/roles — CHANGE ROLE (§10). Replaces the role set. */
identityRoutes.put('/users/:id/roles', authenticate, requirePermission('user.manage'), async (c) => {
  const body = await validateBody(c.req.raw)
  const base = v(body).stringArray('roles', { required: true, maxItems: 5 }).result<{ roles: string[] }>()

  const roles = base.roles.map((r) => r.toUpperCase())
  const invalid = roles.filter((r) => !ASSIGNABLE_ROLES.includes(r as any))
  v({ roles })
    .check(roles.length > 0, 'roles', 'at least one role is required')
    .check(invalid.length === 0, 'roles', `invalid role(s): ${invalid.join(', ')}`)
    .result()

  const user = await service(c).setUserRoles(c.req.param('id'), roles, c.var.user!.id, c.var.requestId)
  return ok(c, user)
})

/**
 * POST /api/v1/users/:id/reset-credential — RESET USER CREDENTIAL (§10).
 * The response confirms the reset and forced rotation; it never echoes the
 * password back (§5).
 */
async function resetCredentialHandler(c: any) {
  const body = await validateBody(c.req.raw)
  const input = v(body)
    .string('password', { required: true, min: MIN_BOOTSTRAP_PASSWORD, max: 128 })
    .result<{ password: string }>()

  const result = await service(c).resetUserCredential(
    c.req.param('id'),
    input.password,
    c.var.user!.id,
    c.var.requestId
  )
  return ok(c, result)
}

identityRoutes.post(
  '/users/:id/reset-credential',
  authenticate,
  requirePermission('user.manage'),
  resetCredentialHandler
)

/**
 * POST /api/v1/users/:id/reset-access — §26 spelling of the same operation.
 * Shares one handler with `/reset-credential` so the two names can never drift
 * apart in authorization, validation or audit behaviour.
 */
identityRoutes.post(
  '/users/:id/reset-access',
  authenticate,
  requirePermission('user.manage'),
  resetCredentialHandler
)

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
