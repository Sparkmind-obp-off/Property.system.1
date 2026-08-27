/**
 * Admin Bootstrap — integration tests.
 * Traceability: PS-MASTER-001 §3, §4 (bootstrap behavior), §5 (password
 *               security), §6 (secret configuration), §8 (admin first login),
 *               §15 (bootstrap state), §16 (public status page),
 *               §34 items 1–4, §35 (bootstrap test), §42 (error handling)
 *
 * These exercise the real request pipeline against a real SQLite database, so a
 * regression in the bootstrap contract fails here rather than in production.
 */
import { beforeEach, describe, expect, it } from 'vitest'

import { BOOTSTRAP_EMAIL, BOOTSTRAP_PASSWORD, TestApp, prodEnv } from './harness'

let app: TestApp

function adminCount(a: TestApp): number {
  const rows = a.query<{ c: number }>(
    `SELECT COUNT(*) AS c FROM users u
       JOIN user_roles ur ON ur.user_id = u.id
       JOIN roles r ON r.id = ur.role_id
      WHERE r.name = 'ADMIN'`
  )
  return Number(rows[0].c)
}

describe('§35 bootstrap — first deployment', () => {
  beforeEach(() => {
    app = TestApp.create(prodEnv())
  })

  /** §34.1 — Admin bootstrap creates Admin once. */
  it('provisions exactly one ADMIN from ADMIN_EMAIL / ADMIN_PASSWORD on first login', async () => {
    expect(adminCount(app)).toBe(0)

    const res = await app.post('/api/v1/auth/login', {
      email: BOOTSTRAP_EMAIL,
      password: BOOTSTRAP_PASSWORD
    })

    expect(res.status).toBe(200)
    expect(res.body.data.user.roles).toContain('ADMIN')
    expect(res.body.data.user.email).toBe(BOOTSTRAP_EMAIL)
    expect(adminCount(app)).toBe(1)
  })

  /** §8 — the bootstrap credential authenticates the operator as ADMIN. */
  it('grants the bootstrapped account the ADMIN permission set', async () => {
    const token = await app.login(BOOTSTRAP_EMAIL, BOOTSTRAP_PASSWORD)
    const me = await app.get('/api/v1/auth/me', token)

    expect(me.status).toBe(200)
    expect(me.body.data.roles).toContain('ADMIN')
    expect(me.body.data.permissions).toContain('user.manage')
  })

  /** §5 — only a PBKDF2 hash is persisted; the plaintext never is. */
  it('stores a password hash, never the plaintext bootstrap secret', async () => {
    await app.login(BOOTSTRAP_EMAIL, BOOTSTRAP_PASSWORD)

    const [row] = app.query<{ password_hash: string }>(
      `SELECT password_hash FROM users WHERE email = ?`,
      [BOOTSTRAP_EMAIL]
    )
    expect(row.password_hash).toMatch(/^pbkdf2\$\d+\$/)
    expect(row.password_hash).not.toContain(BOOTSTRAP_PASSWORD)
  })

  /** §8 — a bootstrap credential must be rotated by its owner. */
  it('flags the bootstrapped admin for mandatory password rotation', async () => {
    const res = await app.post('/api/v1/auth/login', {
      email: BOOTSTRAP_EMAIL,
      password: BOOTSTRAP_PASSWORD
    })
    expect(res.body.data.user.must_change_password).toBe(true)
  })

  /** §33 — the bootstrap itself is an auditable administrative action. */
  it('records an ADMIN_BOOTSTRAPPED audit entry without any secret value', async () => {
    await app.login(BOOTSTRAP_EMAIL, BOOTSTRAP_PASSWORD)

    const rows = app.query<{ action: string; new_value: string }>(
      `SELECT action, new_value FROM audit_logs WHERE action = 'ADMIN_BOOTSTRAPPED'`
    )
    expect(rows).toHaveLength(1)
    expect(rows[0].new_value).not.toContain(BOOTSTRAP_PASSWORD)
    expect(JSON.parse(rows[0].new_value)).toMatchObject({
      email: BOOTSTRAP_EMAIL,
      source: 'ENVIRONMENT_SECRET'
    })
  })

  /** §15 — the durable bootstrap marker is written, not re-derived every time. */
  it('persists the bootstrap completion marker in system_state', async () => {
    await app.login(BOOTSTRAP_EMAIL, BOOTSTRAP_PASSWORD)

    const rows = app.query<{ key: string; value: string }>(
      `SELECT key, value FROM system_state ORDER BY key`
    )
    const state = Object.fromEntries(rows.map((r) => [r.key, r.value]))
    expect(state['bootstrap.admin_email']).toBe(BOOTSTRAP_EMAIL)
    expect(state['bootstrap.completed_at']).toBeTruthy()
  })
})

describe('§35 bootstrap — redeploy must not reset credentials', () => {
  /**
   * §4 / §34.2 — the definitive redeploy guarantee. A new TestApp over the SAME
   * database models a redeploy: fresh isolate, fresh bootstrap memo, existing
   * data. The Admin must survive unchanged.
   */
  it('does not duplicate the Admin or overwrite its password on redeploy', async () => {
    const first = TestApp.create(prodEnv())
    await first.login(BOOTSTRAP_EMAIL, BOOTSTRAP_PASSWORD)

    const [before] = first.query<{ id: string; password_hash: string }>(
      `SELECT id, password_hash FROM users WHERE email = ?`,
      [BOOTSTRAP_EMAIL]
    )

    // The operator rotates the credential inside the app (§14).
    const token = await first.login(BOOTSTRAP_EMAIL, BOOTSTRAP_PASSWORD)
    const rotated = 'Rotated-In-App-Password-1!'
    const change = await first.post(
      '/api/v1/auth/change-password',
      { current_password: BOOTSTRAP_PASSWORD, new_password: rotated },
      token
    )
    expect(change.status).toBe(200)

    // Redeploy: same DB, same secrets still present in the environment.
    const redeployed = TestApp.redeploy(first)

    const relogin = await redeployed.post('/api/v1/auth/login', {
      email: BOOTSTRAP_EMAIL,
      password: rotated
    })
    expect(relogin.status).toBe(200)

    // The old bootstrap secret must NOT work again — §4 forbids reinstating it.
    const stale = await redeployed.post('/api/v1/auth/login', {
      email: BOOTSTRAP_EMAIL,
      password: BOOTSTRAP_PASSWORD
    })
    expect(stale.status).toBe(401)

    const [after] = first.query<{ id: string; password_hash: string }>(
      `SELECT id, password_hash FROM users WHERE email = ?`,
      [BOOTSTRAP_EMAIL]
    )
    expect(after.id).toBe(before.id)
    expect(after.password_hash).not.toBe(before.password_hash)
    expect(adminCount(first)).toBe(1)

    first.close()
  })
})

describe('§34 bootstrap configuration errors', () => {
  /** §34.3 — missing ADMIN_EMAIL produces a configuration error, not an account. */
  it('does not provision an Admin when ADMIN_EMAIL is absent', async () => {
    app = TestApp.create(prodEnv({ ADMIN_EMAIL: undefined }))

    const res = await app.post('/api/v1/auth/login', {
      email: BOOTSTRAP_EMAIL,
      password: BOOTSTRAP_PASSWORD
    })
    expect(res.status).toBe(401)
    expect(adminCount(app)).toBe(0)
  })

  /** §34.4 — missing ADMIN_PASSWORD produces a configuration error. */
  it('does not provision an Admin when ADMIN_PASSWORD is absent', async () => {
    app = TestApp.create(prodEnv({ ADMIN_PASSWORD: undefined }))

    const res = await app.post('/api/v1/auth/login', {
      email: BOOTSTRAP_EMAIL,
      password: BOOTSTRAP_PASSWORD
    })
    expect(res.status).toBe(401)
    expect(adminCount(app)).toBe(0)
  })

  /** §5 — a too-short bootstrap secret is rejected outright. */
  it('refuses a bootstrap secret shorter than the minimum length', async () => {
    app = TestApp.create(prodEnv({ ADMIN_PASSWORD: 'short' }))

    const res = await app.post('/api/v1/auth/login', {
      email: BOOTSTRAP_EMAIL,
      password: 'short'
    })
    expect(res.status).toBe(401)
    expect(adminCount(app)).toBe(0)
  })

  /**
   * §6 — a malformed ADMIN_EMAIL is a configuration error, not a silent pass.
   * The login request itself carries a well-formed address, so the 401 can only
   * come from the bootstrap refusing to provision — not from body validation.
   */
  it('refuses a malformed ADMIN_EMAIL', async () => {
    app = TestApp.create(prodEnv({ ADMIN_EMAIL: 'not-an-email' }))

    const res = await app.post('/api/v1/auth/login', {
      email: BOOTSTRAP_EMAIL,
      password: BOOTSTRAP_PASSWORD
    })
    expect(res.status).toBe(401)
    expect(adminCount(app)).toBe(0)
  })

  /**
   * §4 — a configuration fix must take effect without a fresh isolate: the memo
   * caches only a COMPLETE outcome, so a NOT_CONFIGURED verdict stays retryable.
   */
  it('provisions the Admin once the configuration is corrected', async () => {
    const broken = TestApp.create(prodEnv({ ADMIN_EMAIL: undefined }))
    await broken.post('/api/v1/auth/login', {
      email: BOOTSTRAP_EMAIL,
      password: BOOTSTRAP_PASSWORD
    })
    expect(adminCount(broken)).toBe(0)

    // Same database, now with a complete environment.
    const fixed = TestApp.redeploy(broken, prodEnv())

    const res = await fixed.post('/api/v1/auth/login', {
      email: BOOTSTRAP_EMAIL,
      password: BOOTSTRAP_PASSWORD
    })
    expect(res.status).toBe(200)
    expect(adminCount(broken)).toBe(1)

    broken.close()
  })
})

describe('§16 public system status', () => {
  /** §16 — the pre-login diagnostic is reachable without a token. */
  it('is served unauthenticated and reports NOT_CONFIGURED before bootstrap', async () => {
    app = TestApp.create(prodEnv())

    const res = await app.get('/api/v1/system/public-status')
    expect(res.status).toBe(200)
    expect(res.body.data).toEqual({
      application: 'READY',
      database: 'CONNECTED',
      authentication: 'READY',
      bootstrap: 'NOT_CONFIGURED',
      version: expect.any(String)
    })
  })

  /** §16 — it flips to COMPLETE once an Admin exists. */
  it('reports COMPLETE after the Admin has been provisioned', async () => {
    app = TestApp.create(prodEnv())
    await app.login(BOOTSTRAP_EMAIL, BOOTSTRAP_PASSWORD)

    const res = await app.get('/api/v1/system/public-status')
    expect(res.body.data.bootstrap).toBe('COMPLETE')
    expect(res.body.data.application).toBe('READY')
  })

  /**
   * §16 / §37 — the public payload is capped to the five permitted facts. This
   * asserts the SHAPE, so a future field cannot quietly widen the surface.
   */
  it('exposes only the five non-sensitive facts §16 permits', async () => {
    app = TestApp.create(prodEnv())
    await app.login(BOOTSTRAP_EMAIL, BOOTSTRAP_PASSWORD)

    const res = await app.get('/api/v1/system/public-status')
    expect(Object.keys(res.body.data).sort()).toEqual([
      'application',
      'authentication',
      'bootstrap',
      'database',
      'version'
    ])
    // Notably absent: admin_email, user counts, per-role breakdown, DB errors.
    expect(res.text).not.toContain(BOOTSTRAP_EMAIL)
    expect(res.text).not.toContain(BOOTSTRAP_PASSWORD)
  })

  /** §16 — reading status must never have the side effect of provisioning. */
  it('never provisions an Admin as a side effect of reading status', async () => {
    app = TestApp.create(prodEnv())

    await app.get('/api/v1/system/public-status')
    await app.get('/api/v1/system/public-status')

    expect(adminCount(app)).toBe(0)
  })

  /** §16 — degraded authentication is reported, never the secret itself. */
  it('reports authentication UNAVAILABLE when JWT_SECRET is not configured', async () => {
    app = TestApp.create(prodEnv({ JWT_SECRET: undefined }))

    const res = await app.get('/api/v1/system/public-status')
    expect(res.body.data.authentication).toBe('UNAVAILABLE')
    expect(res.body.data.application).toBe('DEGRADED')
  })
})

describe('§9 admin system status', () => {
  /** §9 — the rich status panel is ADMIN-only. */
  it('requires authentication', async () => {
    app = TestApp.create(prodEnv())
    const res = await app.get('/api/v1/system/status')
    expect(res.status).toBe(401)
  })

  /** §9 — it reports the operational picture the Admin needs. */
  it('reports bootstrap, database, authentication and user metadata to an ADMIN', async () => {
    app = TestApp.create(prodEnv())
    const token = await app.login(BOOTSTRAP_EMAIL, BOOTSTRAP_PASSWORD)

    const res = await app.get('/api/v1/system/status', token)
    expect(res.status).toBe(200)
    expect(res.body.data).toMatchObject({
      application: 'READY',
      database: { status: 'CONNECTED' },
      authentication: { status: 'ACTIVE', jwt_secret: 'CONFIGURED' },
      bootstrap: { status: 'COMPLETE', admin_email: BOOTSTRAP_EMAIL, admin_count: 1 }
    })
  })

  /**
   * §9 / §37 — the status payload must never carry the secret value or a hash,
   * even for an ADMIN. Asserted against the raw response text.
   */
  it('never includes the bootstrap secret, a hash or a token', async () => {
    app = TestApp.create(prodEnv())
    const token = await app.login(BOOTSTRAP_EMAIL, BOOTSTRAP_PASSWORD)

    const res = await app.get('/api/v1/system/status', token)
    expect(res.text).not.toContain(BOOTSTRAP_PASSWORD)
    expect(res.text).not.toContain('pbkdf2$')
    expect(res.text).not.toContain('password_hash')
    expect(res.text).not.toMatch(/"(admin_password|jwt_secret_value)"/)
  })
})
