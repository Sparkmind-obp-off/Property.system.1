/**
 * Integration harness — runs the REAL Hono application against a REAL SQLite
 * database, in-process.
 * Traceability: PS-MASTER-001 §34 (testing), §35 (bootstrap test),
 *               §36 (user management test)
 *
 * Why a hand-written D1 adapter instead of a Workers test runtime:
 *   §34 asks for behavioural guarantees about authentication, bootstrap, RBAC
 *   and secret exposure. Those live in the application code and the SQL schema,
 *   not in the Workers runtime. Driving `src/index.tsx` over `fetch()` with the
 *   project's own migrations applied exercises the exact request pipeline
 *   (middleware → authorize → validate → service → domain rule → D1) with no
 *   extra dependency and no network.
 *
 * The adapter implements the slice of the D1 API this codebase actually uses:
 *   prepare().bind().first()/all()/run(), and batch() with real atomicity.
 * `batch()` wraps the statements in a SQLite transaction, so the rental
 * integrity rule of §24 is enforced by the same mechanism as in production.
 */
import { readdirSync, readFileSync } from 'node:fs'
import { createRequire } from 'node:module'
import { join } from 'node:path'

import app from '../../src/index'
import { resetBootstrapMemo } from '../../src/modules/identity/application/bootstrap.gate'

/**
 * `node:sqlite` is loaded through createRequire rather than a static import so
 * Vite's module graph never tries to resolve (and bundle) a Node built-in that
 * has no browser/Workers counterpart. It exists only in this test harness.
 */
const nodeRequire = createRequire(import.meta.url)
const { DatabaseSync } = nodeRequire('node:sqlite') as typeof import('node:sqlite')
type DatabaseSync = InstanceType<typeof DatabaseSync>

const MIGRATIONS_DIR = join(import.meta.dirname ?? __dirname, '..', '..', 'migrations')

/* ------------------------------- D1 adapter ------------------------------- */

/** Values SQLite can bind natively; everything else must be normalized first. */
type Bindable = string | number | bigint | null | Uint8Array

function normalize(value: unknown): Bindable {
  if (value === undefined || value === null) return null
  if (typeof value === 'boolean') return value ? 1 : 0
  if (typeof value === 'number' || typeof value === 'bigint' || typeof value === 'string') return value
  if (value instanceof Uint8Array) return value
  // Objects/arrays only ever reach D1 as JSON in this codebase.
  return JSON.stringify(value)
}

class SqliteStatement {
  constructor(
    private readonly db: DatabaseSync,
    private readonly sql: string,
    private readonly params: Bindable[] = []
  ) {}

  bind(...params: unknown[]): SqliteStatement {
    return new SqliteStatement(this.db, this.sql, params.map(normalize))
  }

  async first<T>(column?: string): Promise<T | null> {
    const row = this.db.prepare(this.sql).get(...this.params) as Record<string, unknown> | undefined
    if (!row) return null
    return (column ? (row[column] as T) : (row as T)) ?? null
  }

  async all<T>(): Promise<{ results: T[]; success: true; meta: Record<string, unknown> }> {
    const rows = this.db.prepare(this.sql).all(...this.params) as T[]
    return { results: rows, success: true, meta: {} }
  }

  async run(): Promise<{ success: true; meta: Record<string, unknown> }> {
    const info = this.db.prepare(this.sql).run(...this.params)
    return {
      success: true,
      meta: {
        changes: Number(info.changes ?? 0),
        last_row_id: Number(info.lastInsertRowid ?? 0),
        rows_written: Number(info.changes ?? 0)
      }
    }
  }

  /** Used by the raw-SQL paths (migrations); not part of the app's hot path. */
  execute(): void {
    this.db.exec(this.sql)
  }
}

/**
 * Minimal D1Database shim. `batch()` is a real transaction: a failure rolls the
 * whole batch back, which is what the §24 double-rental guard relies on.
 */
function createD1(db: DatabaseSync) {
  return {
    prepare: (sql: string) => new SqliteStatement(db, sql),
    async batch(statements: SqliteStatement[]) {
      db.exec('BEGIN')
      try {
        const out = []
        for (const s of statements) out.push(await s.run())
        db.exec('COMMIT')
        return out
      } catch (err) {
        db.exec('ROLLBACK')
        throw err
      }
    },
    async exec(sql: string) {
      db.exec(sql)
      return { count: 0, duration: 0 }
    },
    async dump() {
      throw new Error('not implemented in the test harness')
    },
    withSession() {
      throw new Error('not implemented in the test harness')
    }
  }
}

/* -------------------------------- Test app -------------------------------- */

export interface TestEnv {
  ADMIN_EMAIL?: string
  ADMIN_PASSWORD?: string
  JWT_SECRET?: string
  JWT_TTL_SECONDS?: string
}

export interface ApiResponse<T = any> {
  status: number
  body: T
  /** Raw response text — used by the §37 "no secret anywhere" assertions. */
  text: string
}

export class TestApp {
  private readonly sqlite: DatabaseSync
  readonly db: ReturnType<typeof createD1>

  private constructor(
    sqlite: DatabaseSync,
    private readonly env: TestEnv
  ) {
    this.sqlite = sqlite
    this.db = createD1(sqlite)
  }

  /** Exposed so `redeploy()` can reuse the underlying database. */
  private get connection(): DatabaseSync {
    return this.sqlite
  }

  /**
   * Fresh in-memory database with every project migration applied, so the test
   * schema is the deployed schema — not a hand-maintained copy.
   */
  static create(env: TestEnv = {}): TestApp {
    const sqlite = new DatabaseSync(':memory:')
    sqlite.exec('PRAGMA foreign_keys = ON')

    const files = readdirSync(MIGRATIONS_DIR)
      .filter((f) => f.endsWith('.sql'))
      .sort()
    for (const file of files) {
      sqlite.exec(readFileSync(join(MIGRATIONS_DIR, file), 'utf8'))
    }

    // Each scenario is an independent "deployment": the bootstrap memo is
    // module-level state and must not leak between tests (§35).
    resetBootstrapMemo()
    return new TestApp(sqlite, env)
  }

  /**
   * Model a REDEPLOY: a new application instance (fresh isolate, fresh
   * bootstrap memo, possibly different environment) over the SAME database.
   * This is the exact scenario §4 protects — an existing Admin must survive.
   */
  static redeploy(previous: TestApp, env: TestEnv = previous.env): TestApp {
    resetBootstrapMemo()
    return new TestApp(previous.connection, env)
  }

  /** Drive the real app over fetch(), exactly as Cloudflare would. */
  async request<T = any>(
    method: string,
    path: string,
    opts: { body?: unknown; token?: string } = {}
  ): Promise<ApiResponse<T>> {
    const headers: Record<string, string> = {}
    if (opts.body !== undefined) headers['content-type'] = 'application/json'
    if (opts.token) headers.authorization = `Bearer ${opts.token}`

    const res = await app.fetch(
      new Request(`https://test.local${path}`, {
        method,
        headers,
        body: opts.body === undefined ? undefined : JSON.stringify(opts.body)
      }),
      { DB: this.db, ...this.env } as any
    )

    const text = await res.text()
    let body: any = null
    try {
      body = text ? JSON.parse(text) : null
    } catch {
      body = text
    }
    return { status: res.status, body, text }
  }

  get = <T = any>(path: string, token?: string) => this.request<T>('GET', path, { token })
  post = <T = any>(path: string, body?: unknown, token?: string) =>
    this.request<T>('POST', path, { body, token })
  patch = <T = any>(path: string, body?: unknown, token?: string) =>
    this.request<T>('PATCH', path, { body, token })
  put = <T = any>(path: string, body?: unknown, token?: string) =>
    this.request<T>('PUT', path, { body, token })

  /** Log in and return the bearer token, failing loudly on an unexpected 4xx. */
  async login(email: string, password: string): Promise<string> {
    const res = await this.post('/api/v1/auth/login', { email, password })
    if (res.status !== 200) {
      throw new Error(`login failed (${res.status}): ${res.text}`)
    }
    return res.body.data.token
  }

  /** Direct SQL read — used to assert what was actually persisted. */
  query<T = Record<string, unknown>>(sql: string, params: unknown[] = []): T[] {
    return this.sqlite.prepare(sql).all(...params.map(normalize)) as T[]
  }

  close(): void {
    this.sqlite.close()
    resetBootstrapMemo()
  }
}

/**
 * A bootstrap secret that satisfies MIN_BOOTSTRAP_PASSWORD. Deliberately
 * distinctive so the §37 leak assertions can search for it as a literal.
 */
export const BOOTSTRAP_PASSWORD = 'Bootstrap-Secret-9f2a!'
export const BOOTSTRAP_EMAIL = 'admin@property.test'

/** Standard "correctly configured production" environment. */
export function prodEnv(overrides: TestEnv = {}): TestEnv {
  return {
    ADMIN_EMAIL: BOOTSTRAP_EMAIL,
    ADMIN_PASSWORD: BOOTSTRAP_PASSWORD,
    JWT_SECRET: 'integration-test-jwt-secret-value-long-enough',
    ...overrides
  }
}
