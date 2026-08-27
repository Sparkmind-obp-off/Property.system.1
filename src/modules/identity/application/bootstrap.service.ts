/**
 * Admin Bootstrap — first-deployment provisioning of the initial ADMIN account.
 * Traceability: PS-MASTER-001 §3 (admin bootstrap), §4 (bootstrap behavior),
 *               §5 (password security), §6 (secret configuration),
 *               §7 (secrets are inputs, not a UI concern), §9 (system status)
 *
 * Contract, restated so the code can be audited against it:
 *   - ADMIN_EMAIL / ADMIN_PASSWORD are BOOTSTRAP INPUTS supplied as Cloudflare
 *     secrets. They are never returned by an API, never rendered, never logged.
 *   - If no Admin account exists → create one from those inputs.
 *   - If an Admin account already exists → DO NOT recreate it and DO NOT
 *     overwrite its password. A redeploy must never reset credentials.
 *   - Only the password HASH is persisted (see shared/crypto.ts, §5).
 */
import { hashPassword } from '../../../shared/crypto'
import { ID } from '../../../shared/id'
import { findMany, findOne } from '../../../shared/repository'
import { auditStmt } from '../../../shared/audit'
import type { Bindings, Role } from '../../../shared/types'

/** Durable marker keys in `system_state`. */
export const STATE_KEYS = {
  bootstrapCompleted: 'bootstrap.completed_at',
  bootstrapAdminEmail: 'bootstrap.admin_email'
} as const

/** Minimum length accepted for the bootstrap secret (§5 password security). */
export const MIN_BOOTSTRAP_PASSWORD = 12

/** Reference roles the authorization matrix in shared/permissions.ts expects. */
const REFERENCE_ROLES: Array<{ id: string; name: Role; description: string }> = [
  { id: 'rol_owner', name: 'OWNER', description: 'Property owner — oversight and rental authority' },
  { id: 'rol_operator', name: 'OPERATOR', description: 'Daily operations across properties, leads and rentals' },
  { id: 'rol_marketing', name: 'MARKETING', description: 'Offers, campaigns and lead acquisition' },
  { id: 'rol_analyst', name: 'ANALYST', description: 'Market intelligence and performance analysis' },
  { id: 'rol_admin', name: 'ADMIN', description: 'System administration and governance' }
]

export type BootstrapState =
  /** An ADMIN account exists; the system is usable. */
  | 'COMPLETE'
  /** No ADMIN exists and ADMIN_EMAIL / ADMIN_PASSWORD are not configured. */
  | 'NOT_CONFIGURED'
  /** Secrets are present but invalid (bad email, password too short). */
  | 'INVALID_CONFIGURATION'
  /** Secrets are valid but provisioning failed (e.g. transient DB error). */
  | 'FAILED'

export interface BootstrapResult {
  state: BootstrapState
  /** True only on the request that actually created the account. */
  created: boolean
  /**
   * Machine-readable explanation. Never contains a secret value — at most the
   * NAME of the missing variable, which is public configuration surface (§6).
   */
  reason?: string
  /** Set only once an admin exists; the email is an identifier, not a secret. */
  adminEmail?: string
  completedAt?: string
}

/* -------------------------------------------------------------------------- */

function normalizeEmail(raw: string): string {
  return raw.trim().toLowerCase()
}

function isEmail(value: string): boolean {
  return /^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(value)
}

async function readState(db: D1Database, key: string): Promise<string | null> {
  const row = await findOne<{ value: string }>(db, `SELECT value FROM system_state WHERE key = ?`, [key])
  return row?.value ?? null
}

function setStateStmt(db: D1Database, key: string, value: string): D1PreparedStatement {
  return db
    .prepare(
      `INSERT INTO system_state (key, value, updated_at) VALUES (?, ?, datetime('now'))
         ON CONFLICT(key) DO UPDATE SET value = excluded.value, updated_at = excluded.updated_at`
    )
    .bind(key, value)
}

/** Statements that guarantee the five reference roles exist (idempotent). */
function referenceRoleStmts(db: D1Database): D1PreparedStatement[] {
  return REFERENCE_ROLES.map((r) =>
    db
      .prepare(`INSERT OR IGNORE INTO roles (id, name, description) VALUES (?, ?, ?)`)
      .bind(r.id, r.name, r.description)
  )
}

/** The current ADMIN population — the single source of truth for §4. */
async function findAdmins(db: D1Database) {
  return findMany<{ id: string; email: string; status: string; created_at: string }>(
    db,
    `SELECT u.id, u.email, u.status, u.created_at
       FROM users u
       JOIN user_roles ur ON ur.user_id = u.id
       JOIN roles r ON r.id = ur.role_id
      WHERE r.name = 'ADMIN'
      ORDER BY u.created_at ASC`
  )
}

/* -------------------------------------------------------------------------- */

/**
 * Idempotent bootstrap. Safe to call on every request: it performs one cheap
 * read when already complete, and only writes on a genuinely empty system.
 */
export async function runBootstrap(env: Bindings): Promise<BootstrapResult> {
  const db = env.DB

  const admins = await findAdmins(db)
  if (admins.length > 0) {
    // §4: an Admin already exists — never recreate, never overwrite the secret.
    const completedAt = (await readState(db, STATE_KEYS.bootstrapCompleted)) ?? admins[0].created_at
    if (!(await readState(db, STATE_KEYS.bootstrapCompleted))) {
      // Backfill the marker for systems bootstrapped before this mechanism existed.
      await db.batch([
        setStateStmt(db, STATE_KEYS.bootstrapCompleted, completedAt),
        setStateStmt(db, STATE_KEYS.bootstrapAdminEmail, admins[0].email)
      ])
    }
    return { state: 'COMPLETE', created: false, adminEmail: admins[0].email, completedAt }
  }

  const rawEmail = env.ADMIN_EMAIL?.trim() ?? ''
  const rawPassword = env.ADMIN_PASSWORD ?? ''

  if (!rawEmail && !rawPassword) {
    return {
      state: 'NOT_CONFIGURED',
      created: false,
      reason: 'ADMIN_EMAIL and ADMIN_PASSWORD are not set for this environment.'
    }
  }
  if (!rawEmail) {
    return { state: 'INVALID_CONFIGURATION', created: false, reason: 'ADMIN_EMAIL is not set.' }
  }
  if (!rawPassword) {
    return { state: 'INVALID_CONFIGURATION', created: false, reason: 'ADMIN_PASSWORD is not set.' }
  }

  const email = normalizeEmail(rawEmail)
  if (!isEmail(email)) {
    return { state: 'INVALID_CONFIGURATION', created: false, reason: 'ADMIN_EMAIL is not a valid email address.' }
  }
  if (rawPassword.length < MIN_BOOTSTRAP_PASSWORD) {
    // The length is reported; the value never is (§5).
    return {
      state: 'INVALID_CONFIGURATION',
      created: false,
      reason: `ADMIN_PASSWORD must be at least ${MIN_BOOTSTRAP_PASSWORD} characters.`
    }
  }

  try {
    const passwordHash = await hashPassword(rawPassword)
    const userId = ID.user()
    const now = new Date().toISOString()

    // An account may already exist under this email without the ADMIN role
    // (e.g. someone was created before roles were assigned). Promote it rather
    // than failing on the unique email index — but never touch its password.
    const existing = await findOne<{ id: string }>(db, `SELECT id FROM users WHERE email = ?`, [email])

    const statements: D1PreparedStatement[] = [...referenceRoleStmts(db)]

    if (existing) {
      statements.push(
        db
          .prepare(
            `INSERT INTO user_roles (id, user_id, role_id)
             SELECT ?, ?, r.id FROM roles r WHERE r.name = 'ADMIN'`
          )
          .bind(ID.userRole(), existing.id)
      )
    } else {
      statements.push(
        db
          .prepare(
            `INSERT INTO users
               (id, name, email, password_hash, status, password_updated_at, must_change_password, bootstrap_origin)
             VALUES (?, ?, ?, ?, 'ACTIVE', ?, 1, 1)`
          )
          .bind(userId, 'System Administrator', email, passwordHash, now),
        db
          .prepare(
            `INSERT INTO user_roles (id, user_id, role_id)
             SELECT ?, ?, r.id FROM roles r WHERE r.name = 'ADMIN'`
          )
          .bind(ID.userRole(), userId)
      )
    }

    const adminId = existing?.id ?? userId
    statements.push(
      setStateStmt(db, STATE_KEYS.bootstrapCompleted, now),
      setStateStmt(db, STATE_KEYS.bootstrapAdminEmail, email),
      auditStmt(db, {
        userId: adminId,
        entityType: 'USER',
        entityId: adminId,
        action: 'ADMIN_BOOTSTRAPPED',
        // Identifier + mechanism only. No secret, no hash (§5, §9).
        newValue: { email, roles: ['ADMIN'], source: 'ENVIRONMENT_SECRET' },
        requestId: 'bootstrap'
      })
    )

    await db.batch(statements)
    // Deliberately coarse log: confirms the mechanism ran, reveals no secret.
    console.log('[bootstrap] initial ADMIN account provisioned from environment secrets')
    return { state: 'COMPLETE', created: true, adminEmail: email, completedAt: now }
  } catch (err) {
    const message = err instanceof Error ? err.message : String(err)
    console.error('[bootstrap] provisioning failed:', message)
    return { state: 'FAILED', created: false, reason: 'Admin provisioning failed. See deployment logs.' }
  }
}

/* ----------------------------- System status ------------------------------ */

export interface SystemStatus {
  application: 'READY' | 'DEGRADED'
  version: string
  database: { status: 'CONNECTED' | 'UNAVAILABLE'; migrations_applied?: number; error?: string }
  authentication: { status: 'ACTIVE' | 'DEGRADED'; jwt_secret: 'CONFIGURED' | 'DEFAULT_INSECURE'; token_ttl_seconds: number }
  bootstrap: {
    status: BootstrapState
    admin_email: string | null
    completed_at: string | null
    admin_count: number
    reason?: string
    /** True when the bootstrap credential still has to be rotated (§8). */
    password_rotation_pending: boolean
  }
  users: { total: number; active: number; inactive: number; by_role: Record<string, number> }
}

/**
 * Assemble the §9 status panel. By construction this function may only read
 * metadata: no secret, no hash, no token is ever part of its output.
 */
export async function systemStatus(
  env: Bindings,
  opts: { version: string; jwtSecretConfigured: boolean; tokenTtl: number }
): Promise<SystemStatus> {
  const db = env.DB

  let database: SystemStatus['database'] = { status: 'UNAVAILABLE' }
  let users: SystemStatus['users'] = { total: 0, active: 0, inactive: 0, by_role: {} }
  let bootstrapState: BootstrapState = 'FAILED'
  let adminEmail: string | null = null
  let completedAt: string | null = null
  let adminCount = 0
  let rotationPending = false
  let reason: string | undefined

  try {
    const tables = await findOne<{ c: number }>(
      db,
      `SELECT COUNT(*) AS c FROM sqlite_master WHERE type = 'table' AND name NOT LIKE 'sqlite_%'`
    )
    database = { status: 'CONNECTED', migrations_applied: Number(tables?.c ?? 0) }

    const counts = await findOne<{ total: number; active: number }>(
      db,
      `SELECT COUNT(*) AS total, SUM(CASE WHEN status = 'ACTIVE' THEN 1 ELSE 0 END) AS active FROM users`
    )
    const byRole = await findMany<{ name: string; c: number }>(
      db,
      `SELECT r.name, COUNT(ur.user_id) AS c
         FROM roles r LEFT JOIN user_roles ur ON ur.role_id = r.id
        GROUP BY r.name ORDER BY r.name`
    )
    const total = Number(counts?.total ?? 0)
    const active = Number(counts?.active ?? 0)
    users = {
      total,
      active,
      inactive: total - active,
      by_role: Object.fromEntries(byRole.map((r) => [r.name, Number(r.c)]))
    }

    const admins = await findAdmins(db)
    adminCount = admins.length
    if (adminCount > 0) {
      bootstrapState = 'COMPLETE'
      adminEmail = (await readState(db, STATE_KEYS.bootstrapAdminEmail)) ?? admins[0].email
      completedAt = (await readState(db, STATE_KEYS.bootstrapCompleted)) ?? admins[0].created_at
      const pending = await findOne<{ c: number }>(
        db,
        `SELECT COUNT(*) AS c FROM users WHERE must_change_password = 1 AND status = 'ACTIVE'`
      )
      rotationPending = Number(pending?.c ?? 0) > 0
    } else {
      // Re-derive the configuration verdict without writing anything.
      const probe = await runBootstrapProbe(env)
      bootstrapState = probe.state
      reason = probe.reason
    }
  } catch (err) {
    database = {
      status: 'UNAVAILABLE',
      error: err instanceof Error ? err.message : String(err)
    }
    reason = 'Database unavailable — status is incomplete.'
  }

  const authentication: SystemStatus['authentication'] = {
    status: opts.jwtSecretConfigured ? 'ACTIVE' : 'DEGRADED',
    jwt_secret: opts.jwtSecretConfigured ? 'CONFIGURED' : 'DEFAULT_INSECURE',
    token_ttl_seconds: opts.tokenTtl
  }

  const healthy =
    database.status === 'CONNECTED' && authentication.status === 'ACTIVE' && bootstrapState === 'COMPLETE'

  return {
    application: healthy ? 'READY' : 'DEGRADED',
    version: opts.version,
    database,
    authentication,
    bootstrap: {
      status: bootstrapState,
      admin_email: adminEmail,
      completed_at: completedAt,
      admin_count: adminCount,
      ...(reason ? { reason } : {}),
      password_rotation_pending: rotationPending
    },
    users
  }
}

/* -------------------- Public (pre-login) system status -------------------- */

/**
 * The §16 public diagnostic payload.
 *
 * §16 permits exactly five facts: application, database, authentication,
 * bootstrap and version. This type is deliberately NARROWER than SystemStatus —
 * it carries no admin email, no user counts, no per-role breakdown, no database
 * error string. That is a structural guarantee: an unauthenticated caller
 * cannot learn anything beyond "is this deployment usable yet?".
 */
export interface PublicSystemStatus {
  application: 'READY' | 'DEGRADED'
  database: 'CONNECTED' | 'UNAVAILABLE'
  authentication: 'READY' | 'UNAVAILABLE'
  bootstrap: 'COMPLETE' | 'NOT_CONFIGURED'
  version: string
}

/**
 * Assemble the §16 pre-login status page payload.
 *
 * Read-only and side-effect free: it must never provision anything, and it must
 * never expose a secret, a hash, a token, a credential, a database identifier
 * or an internal stack trace (§16, §37, §42). Failure states are collapsed into
 * the coarse vocabulary §16 allows, so a probing client learns nothing about the
 * internal cause.
 */
export async function publicSystemStatus(
  env: Bindings,
  opts: { version: string; jwtSecretConfigured: boolean }
): Promise<PublicSystemStatus> {
  let database: PublicSystemStatus['database'] = 'UNAVAILABLE'
  let bootstrap: PublicSystemStatus['bootstrap'] = 'NOT_CONFIGURED'

  try {
    const admins = await findAdmins(env.DB)
    database = 'CONNECTED'
    // §16 allows only COMPLETE / NOT CONFIGURED here. Any non-complete internal
    // state (INVALID_CONFIGURATION, FAILED) collapses to NOT_CONFIGURED so the
    // reason — which names configuration variables — stays admin-only (§9).
    bootstrap = admins.length > 0 ? 'COMPLETE' : 'NOT_CONFIGURED'
  } catch {
    // Swallowed on purpose: §42 forbids surfacing the internal error.
    database = 'UNAVAILABLE'
  }

  const authentication: PublicSystemStatus['authentication'] = opts.jwtSecretConfigured
    ? 'READY'
    : 'UNAVAILABLE'

  return {
    application: database === 'CONNECTED' && authentication === 'READY' ? 'READY' : 'DEGRADED',
    database,
    authentication,
    bootstrap,
    version: opts.version
  }
}

/**
 * Configuration verdict WITHOUT side effects — used by the status endpoint so
 * reading status can never provision an account as a surprise.
 */
function runBootstrapProbe(env: Bindings): Promise<{ state: BootstrapState; reason?: string }> {
  const email = env.ADMIN_EMAIL?.trim() ?? ''
  const password = env.ADMIN_PASSWORD ?? ''
  if (!email && !password) {
    return Promise.resolve({
      state: 'NOT_CONFIGURED',
      reason: 'ADMIN_EMAIL and ADMIN_PASSWORD are not set for this environment.'
    })
  }
  if (!email) return Promise.resolve({ state: 'INVALID_CONFIGURATION', reason: 'ADMIN_EMAIL is not set.' })
  if (!password) return Promise.resolve({ state: 'INVALID_CONFIGURATION', reason: 'ADMIN_PASSWORD is not set.' })
  if (!isEmail(normalizeEmail(email))) {
    return Promise.resolve({ state: 'INVALID_CONFIGURATION', reason: 'ADMIN_EMAIL is not a valid email address.' })
  }
  if (password.length < MIN_BOOTSTRAP_PASSWORD) {
    return Promise.resolve({
      state: 'INVALID_CONFIGURATION',
      reason: `ADMIN_PASSWORD must be at least ${MIN_BOOTSTRAP_PASSWORD} characters.`
    })
  }
  return Promise.resolve({ state: 'FAILED', reason: 'Admin account has not been provisioned yet.' })
}
