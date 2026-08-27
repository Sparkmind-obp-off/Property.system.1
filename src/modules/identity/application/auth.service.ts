/**
 * Identity — application service.
 * Traceability: PS-IMP-011 §6 (Identity module) | PS-TECH-008 §13, §14
 */
import { hashPassword, signJwt, verifyPassword } from '../../../shared/crypto'
import { ConflictError, UnauthorizedError } from '../../../shared/errors'
import { ID } from '../../../shared/id'
import { PERMISSIONS, ROLE_PERMISSIONS, permissionsForRoles } from '../../../shared/permissions'
import { findMany, findOne, transaction } from '../../../shared/repository'
import { auditStmt } from '../../../shared/audit'
import type { Role } from '../../../shared/types'

interface UserRow {
  id: string
  name: string
  email: string
  password_hash: string
  status: string
}

export interface AuthResult {
  token: string
  expires_in: number
  user: {
    id: string
    name: string
    email: string
    roles: string[]
    permissions: string[]
  }
}

export class AuthService {
  constructor(
    private readonly db: D1Database,
    private readonly secret: string,
    private readonly ttl: number
  ) {}

  private async rolesOf(userId: string): Promise<string[]> {
    const rows = await findMany<{ name: string }>(
      this.db,
      `SELECT r.name FROM user_roles ur JOIN roles r ON r.id = ur.role_id WHERE ur.user_id = ?`,
      [userId]
    )
    return rows.map((r) => r.name)
  }

  /** Login: verifies credentials then issues a signed access token. */
  async login(email: string, password: string, requestId: string): Promise<AuthResult> {
    const user = await findOne<UserRow>(this.db, `SELECT * FROM users WHERE email = ?`, [
      email.toLowerCase()
    ])
    // Uniform error message: never reveal whether the email exists.
    if (!user) throw new UnauthorizedError('Invalid email or password.')
    if (user.status !== 'ACTIVE') throw new UnauthorizedError('This account is inactive.')

    const valid = await verifyPassword(password, user.password_hash)
    if (!valid) throw new UnauthorizedError('Invalid email or password.')

    const roles = await this.rolesOf(user.id)
    const permissions = permissionsForRoles(roles)

    const token = await signJwt(
      { sub: user.id, email: user.email, name: user.name, roles, permissions },
      this.secret,
      this.ttl
    )

    await transaction(this.db, [
      auditStmt(this.db, {
        userId: user.id,
        entityType: 'USER',
        entityId: user.id,
        action: 'LOGIN',
        requestId
      })
    ])

    return {
      token,
      expires_in: this.ttl,
      user: { id: user.id, name: user.name, email: user.email, roles, permissions }
    }
  }

  /** Create a user with roles (ADMIN-only use case). */
  async createUser(
    input: { name: string; email: string; password: string; roles: string[] },
    actorId: string,
    requestId: string
  ) {
    const existing = await findOne(this.db, `SELECT id FROM users WHERE email = ?`, [
      input.email.toLowerCase()
    ])
    if (existing) throw new ConflictError('A user with this email already exists.', { email: input.email })

    const userId = ID.user()
    const passwordHash = await hashPassword(input.password)

    const statements: D1PreparedStatement[] = [
      this.db
        .prepare(
          `INSERT INTO users (id, name, email, password_hash, status) VALUES (?, ?, ?, ?, 'ACTIVE')`
        )
        .bind(userId, input.name, input.email.toLowerCase(), passwordHash)
    ]

    const roleRows = await findMany<{ id: string; name: string }>(
      this.db,
      `SELECT id, name FROM roles WHERE name IN (${input.roles.map(() => '?').join(', ')})`,
      input.roles
    )
    for (const role of roleRows) {
      statements.push(
        this.db
          .prepare(`INSERT INTO user_roles (id, user_id, role_id) VALUES (?, ?, ?)`)
          .bind(ID.userRole(), userId, role.id)
      )
    }
    statements.push(
      auditStmt(this.db, {
        userId: actorId,
        entityType: 'USER',
        entityId: userId,
        action: 'USER_CREATED',
        newValue: { email: input.email, roles: roleRows.map((r) => r.name) },
        requestId
      })
    )

    await transaction(this.db, statements)

    return {
      id: userId,
      name: input.name,
      email: input.email.toLowerCase(),
      status: 'ACTIVE',
      roles: roleRows.map((r) => r.name)
    }
  }

  /** Current session profile (used by the SPA to bootstrap permission-aware UI). */
  async me(userId: string) {
    const user = await findOne<UserRow>(
      this.db,
      `SELECT id, name, email, status FROM users WHERE id = ?`,
      [userId]
    )
    if (!user) throw new UnauthorizedError('Session user no longer exists.')
    const roles = await this.rolesOf(user.id)
    return {
      id: user.id,
      name: user.name,
      email: user.email,
      status: user.status,
      roles,
      permissions: permissionsForRoles(roles)
    }
  }

  async listUsers() {
    const rows = await findMany<{ id: string; name: string; email: string; status: string; roles: string }>(
      this.db,
      `SELECT u.id, u.name, u.email, u.status, u.created_at,
              COALESCE(GROUP_CONCAT(r.name), '') AS roles
         FROM users u
         LEFT JOIN user_roles ur ON ur.user_id = u.id
         LEFT JOIN roles r ON r.id = ur.role_id
        GROUP BY u.id
        ORDER BY u.created_at ASC`
    )
    return rows.map((r) => ({ ...r, roles: r.roles ? r.roles.split(',') : ([] as string[]) }))
  }

  /**
   * Roles enriched with their effective permission set and current member count.
   * The governance screen must be able to show WHAT a role can do, not just its
   * name — otherwise role assignment is a blind operation (§3).
   */
  async listRoles() {
    const rows = await findMany<{ id: string; name: string; description: string | null; members: number }>(
      this.db,
      `SELECT r.id, r.name, r.description,
              (SELECT COUNT(*) FROM user_roles ur WHERE ur.role_id = r.id) AS members
         FROM roles r
        ORDER BY r.name`
    )
    return rows.map((r) => {
      const permissions = ROLE_PERMISSIONS[r.name as Role] ?? []
      return {
        ...r,
        assignable: ASSIGNABLE_ROLES.includes(r.name as Role),
        permission_count: permissions.length,
        permissions: [...permissions].sort()
      }
    })
  }

  /** The full permission registry, so the UI never hardcodes the matrix. */
  listPermissions() {
    return {
      permissions: [...PERMISSIONS],
      roles: ASSIGNABLE_ROLES.map((r) => ({ role: r, permissions: [...(ROLE_PERMISSIONS[r] ?? [])].sort() }))
    }
  }
}

export const ASSIGNABLE_ROLES: readonly Role[] = ['OWNER', 'OPERATOR', 'MARKETING', 'ANALYST', 'ADMIN']
