/**
 * Identity — application service.
 * Traceability: PS-IMP-011 §6 (Identity module) | PS-TECH-008 §13, §14
 */
import { hashPassword, signJwt, verifyPassword } from '../../../shared/crypto'
import {
  BusinessRuleViolation,
  ConflictError,
  NotFoundError,
  UnauthorizedError,
  ValidationError
} from '../../../shared/errors'
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
  must_change_password?: number
  password_updated_at?: string | null
  bootstrap_origin?: number
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
    /** True while a bootstrap/reset credential still has to be rotated (§8). */
    must_change_password: boolean
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
      user: {
        id: user.id,
        name: user.name,
        email: user.email,
        roles,
        permissions,
        must_change_password: Number(user.must_change_password ?? 0) === 1
      }
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
          `INSERT INTO users
             (id, name, email, password_hash, status, password_updated_at, must_change_password)
           VALUES (?, ?, ?, ?, 'ACTIVE', datetime('now'), 1)`
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
      roles: roleRows.map((r) => r.name),
      must_change_password: true
    }
  }

  /* ------------------------- §10 user management -------------------------- */

  private async loadUser(userId: string): Promise<UserRow> {
    const user = await findOne<UserRow>(this.db, `SELECT * FROM users WHERE id = ?`, [userId])
    if (!user) throw new NotFoundError('User', userId)
    return user
  }

  /**
   * The number of ACTIVE users holding ADMIN. Used to refuse any change that
   * would leave the system with no administrator — that state is unrecoverable
   * from inside the application (§10) and would force the operator back into
   * Cloudflare, which §7 explicitly forbids as a routine requirement.
   */
  private async activeAdminCount(excludeUserId?: string): Promise<number> {
    const row = await findOne<{ c: number }>(
      this.db,
      `SELECT COUNT(DISTINCT u.id) AS c
         FROM users u
         JOIN user_roles ur ON ur.user_id = u.id
         JOIN roles r ON r.id = ur.role_id
        WHERE r.name = 'ADMIN' AND u.status = 'ACTIVE'
          ${excludeUserId ? 'AND u.id != ?' : ''}`,
      excludeUserId ? [excludeUserId] : []
    )
    return Number(row?.c ?? 0)
  }

  private async assertAdminRemains(userId: string, action: string) {
    if ((await this.activeAdminCount(userId)) === 0) {
      throw new BusinessRuleViolation(
        `${action} would leave the system without an active administrator.`,
        'DR-ADM-001',
        { user_id: userId }
      )
    }
  }

  /** Update profile fields (name / email). Never touches credentials. */
  async updateUser(
    userId: string,
    input: { name?: string; email?: string },
    actorId: string,
    requestId: string
  ) {
    const user = await this.loadUser(userId)

    const nextName = input.name ?? user.name
    const nextEmail = (input.email ?? user.email).toLowerCase()

    if (nextEmail !== user.email) {
      const clash = await findOne(this.db, `SELECT id FROM users WHERE email = ? AND id != ?`, [
        nextEmail,
        userId
      ])
      if (clash) throw new ConflictError('A user with this email already exists.', { email: nextEmail })
    }

    await transaction(this.db, [
      this.db
        .prepare(`UPDATE users SET name = ?, email = ?, updated_at = datetime('now') WHERE id = ?`)
        .bind(nextName, nextEmail, userId),
      auditStmt(this.db, {
        userId: actorId,
        entityType: 'USER',
        entityId: userId,
        action: 'USER_UPDATED',
        oldValue: { name: user.name, email: user.email },
        newValue: { name: nextName, email: nextEmail },
        requestId
      })
    ])

    return this.userDetail(userId)
  }

  /** Enable / disable an account. Disabling is the reversible alternative to deletion. */
  async setUserStatus(userId: string, status: 'ACTIVE' | 'INACTIVE', actorId: string, requestId: string) {
    const user = await this.loadUser(userId)
    if (user.status === status) return this.userDetail(userId)

    if (status === 'INACTIVE') {
      if (userId === actorId) {
        throw new BusinessRuleViolation(
          'You cannot disable your own account.',
          'DR-ADM-002',
          { user_id: userId }
        )
      }
      await this.assertAdminRemains(userId, 'Disabling this account')
    }

    await transaction(this.db, [
      this.db
        .prepare(`UPDATE users SET status = ?, updated_at = datetime('now') WHERE id = ?`)
        .bind(status, userId),
      auditStmt(this.db, {
        userId: actorId,
        entityType: 'USER',
        entityId: userId,
        action: status === 'ACTIVE' ? 'USER_ENABLED' : 'USER_DISABLED',
        oldValue: { status: user.status },
        newValue: { status },
        requestId
      })
    ])

    return this.userDetail(userId)
  }

  /** Replace the user's role set (§10 CHANGE ROLE). */
  async setUserRoles(userId: string, roles: string[], actorId: string, requestId: string) {
    await this.loadUser(userId)
    const current = await this.rolesOf(userId)

    const roleRows = await findMany<{ id: string; name: string }>(
      this.db,
      `SELECT id, name FROM roles WHERE name IN (${roles.map(() => '?').join(', ')})`,
      roles
    )
    const resolved = roleRows.map((r) => r.name)
    const unknown = roles.filter((r) => !resolved.includes(r))
    if (unknown.length > 0) {
      throw new ValidationError('Unknown role(s).', { roles: `not defined: ${unknown.join(', ')}` })
    }

    // Removing ADMIN from the last administrator is refused for the same reason
    // as disabling them: the system would become unmanageable from the app.
    if (current.includes('ADMIN') && !resolved.includes('ADMIN')) {
      await this.assertAdminRemains(userId, 'Removing the ADMIN role')
    }

    await transaction(this.db, [
      this.db.prepare(`DELETE FROM user_roles WHERE user_id = ?`).bind(userId),
      ...roleRows.map((r) =>
        this.db
          .prepare(`INSERT INTO user_roles (id, user_id, role_id) VALUES (?, ?, ?)`)
          .bind(ID.userRole(), userId, r.id)
      ),
      this.db.prepare(`UPDATE users SET updated_at = datetime('now') WHERE id = ?`).bind(userId),
      auditStmt(this.db, {
        userId: actorId,
        entityType: 'USER',
        entityId: userId,
        action: 'USER_ROLES_CHANGED',
        oldValue: { roles: current },
        newValue: { roles: resolved },
        requestId
      })
    ])

    return this.userDetail(userId)
  }

  /**
   * ADMIN resets another user's credential (§10 RESET USER CREDENTIAL).
   * Only the hash is stored, and the plaintext is never echoed back — the
   * administrator hands it over out-of-band, and rotation is forced on login.
   */
  async resetUserCredential(userId: string, newPassword: string, actorId: string, requestId: string) {
    const user = await this.loadUser(userId)
    const hash = await hashPassword(newPassword)

    await transaction(this.db, [
      this.db
        .prepare(
          `UPDATE users
              SET password_hash = ?, password_updated_at = datetime('now'),
                  must_change_password = 1, updated_at = datetime('now')
            WHERE id = ?`
        )
        .bind(hash, userId),
      auditStmt(this.db, {
        userId: actorId,
        entityType: 'USER',
        entityId: userId,
        // WHAT happened is recorded; the secret itself never enters the log (§5).
        action: 'USER_CREDENTIAL_RESET',
        newValue: { email: user.email, forced_rotation: true },
        requestId
      })
    ])

    return { id: userId, email: user.email, must_change_password: true }
  }

  /**
   * The account owner rotates their own password (§8 first-login rotation).
   * Requires the current password, so a stolen token alone cannot take over the
   * account permanently.
   */
  async changeOwnPassword(
    userId: string,
    currentPassword: string,
    newPassword: string,
    requestId: string
  ) {
    const user = await this.loadUser(userId)

    if (!(await verifyPassword(currentPassword, user.password_hash))) {
      throw new UnauthorizedError('Current password is incorrect.')
    }
    if (await verifyPassword(newPassword, user.password_hash)) {
      throw new ValidationError('Password rotation failed.', {
        new_password: 'must differ from the current password'
      })
    }

    const hash = await hashPassword(newPassword)
    await transaction(this.db, [
      this.db
        .prepare(
          `UPDATE users
              SET password_hash = ?, password_updated_at = datetime('now'),
                  must_change_password = 0, updated_at = datetime('now')
            WHERE id = ?`
        )
        .bind(hash, userId),
      auditStmt(this.db, {
        userId,
        entityType: 'USER',
        entityId: userId,
        action: 'PASSWORD_CHANGED',
        newValue: { self_service: true },
        requestId
      })
    ])

    return { id: userId, must_change_password: false }
  }

  /** Single user, with roles and credential METADATA (never the hash). */
  async userDetail(userId: string) {
    const user = await findOne<UserRow>(
      this.db,
      `SELECT id, name, email, status, created_at, updated_at,
              password_updated_at, must_change_password, bootstrap_origin
         FROM users WHERE id = ?`,
      [userId]
    )
    if (!user) throw new NotFoundError('User', userId)
    const roles = await this.rolesOf(userId)
    return {
      id: user.id,
      name: user.name,
      email: user.email,
      status: user.status,
      created_at: (user as any).created_at,
      updated_at: (user as any).updated_at,
      password_updated_at: user.password_updated_at ?? null,
      must_change_password: Number(user.must_change_password ?? 0) === 1,
      bootstrap_origin: Number(user.bootstrap_origin ?? 0) === 1,
      roles,
      permissions: permissionsForRoles(roles)
    }
  }

  /** Current session profile (used by the SPA to bootstrap permission-aware UI). */
  async me(userId: string) {
    const user = await findOne<UserRow>(
      this.db,
      `SELECT id, name, email, status, must_change_password, password_updated_at
         FROM users WHERE id = ?`,
      [userId]
    )
    if (!user) throw new UnauthorizedError('Session user no longer exists.')
    if (user.status !== 'ACTIVE') throw new UnauthorizedError('This account is inactive.')
    const roles = await this.rolesOf(user.id)
    return {
      id: user.id,
      name: user.name,
      email: user.email,
      status: user.status,
      must_change_password: Number(user.must_change_password ?? 0) === 1,
      password_updated_at: user.password_updated_at ?? null,
      roles,
      permissions: permissionsForRoles(roles)
    }
  }

  async listUsers() {
    const rows = await findMany<{
      id: string
      name: string
      email: string
      status: string
      roles: string
      must_change_password: number
      bootstrap_origin: number
    }>(
      this.db,
      `SELECT u.id, u.name, u.email, u.status, u.created_at,
              u.password_updated_at, u.must_change_password, u.bootstrap_origin,
              COALESCE(GROUP_CONCAT(r.name), '') AS roles
         FROM users u
         LEFT JOIN user_roles ur ON ur.user_id = u.id
         LEFT JOIN roles r ON r.id = ur.role_id
        GROUP BY u.id
        ORDER BY u.created_at ASC`
    )
    return rows.map((r) => ({
      ...r,
      roles: r.roles ? r.roles.split(',') : ([] as string[]),
      must_change_password: Number(r.must_change_password ?? 0) === 1,
      bootstrap_origin: Number(r.bootstrap_origin ?? 0) === 1
    }))
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
