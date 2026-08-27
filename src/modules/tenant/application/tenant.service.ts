/**
 * Tenant + Tenant Segment — application service.
 * Traceability: PS-IMP-011 §10 | PS-DATA-009 §16, §17, §18
 *
 * Tenant is an ENTITY. It does NOT automatically become a Lead (§10).
 */
import { auditStmt } from '../../../shared/audit'
import { ID } from '../../../shared/id'
import {
  FilterBuilder,
  count,
  findMany,
  findOne,
  findOneOrFail,
  parseJson,
  transaction
} from '../../../shared/repository'

const SORTABLE = ['created_at', 'name', 'budget_max', 'space_need'] as const

export class TenantService {
  constructor(private readonly db: D1Database) {}

  async create(input: any, actorId: string, requestId: string) {
    const id = ID.tenant()
    await transaction(this.db, [
      this.db
        .prepare(
          `INSERT INTO tenants
             (id, name, tenant_type, business_category, contact_name, phone, email,
              budget_min, budget_max, space_need, location_preference, business_description, status)
           VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`
        )
        .bind(
          id,
          input.name,
          input.tenant_type ?? 'BUSINESS',
          input.business_category ?? 'OTHER',
          input.contact_name ?? null,
          input.phone ?? null,
          input.email ?? null,
          input.budget_min ?? null,
          input.budget_max ?? null,
          input.space_need ?? null,
          input.location_preference ?? null,
          input.business_description ?? null,
          input.status ?? 'PROSPECT'
        ),
      auditStmt(this.db, {
        userId: actorId,
        entityType: 'TENANT',
        entityId: id,
        action: 'TENANT_CREATED',
        newValue: { name: input.name, business_category: input.business_category },
        requestId
      })
    ])
    return this.get(id)
  }

  async get(id: string) {
    const tenant = await findOneOrFail<any>(
      this.db,
      `SELECT * FROM tenants WHERE id = ?`,
      [id],
      'Tenant',
      id
    )
    const leads = await findMany(
      this.db,
      `SELECT l.id, l.status, l.temperature, l.score, l.created_at,
              p.id AS property_id, p.name AS property_name
         FROM leads l JOIN properties p ON p.id = l.property_id
        WHERE l.tenant_id = ? ORDER BY l.created_at DESC LIMIT 20`,
      [id]
    )
    const rentals = await findMany(
      this.db,
      `SELECT r.id, r.status, r.start_date, r.end_date, r.price, p.name AS property_name
         FROM rentals r JOIN properties p ON p.id = r.property_id
        WHERE r.tenant_id = ? ORDER BY r.created_at DESC LIMIT 20`,
      [id]
    )
    const matches = await findMany<any>(
      this.db,
      `SELECT m.id, m.fit_score, m.recommendation, m.reasoning, m.created_at,
              p.id AS property_id, p.name AS property_name
         FROM tenant_property_matches m JOIN properties p ON p.id = m.property_id
        WHERE m.tenant_id = ? ORDER BY m.fit_score DESC LIMIT 10`,
      [id]
    )
    return {
      ...tenant,
      leads,
      rentals,
      matches: matches.map((m) => ({ ...m, reasoning: parseJson<string[]>(m.reasoning, []) }))
    }
  }

  async list(params: {
    page: number
    limit: number
    offset: number
    orderBy: string
    search?: string
    business_category?: string
    status?: string
    budget_min?: number
    space_need_max?: number
  }) {
    const f = new FilterBuilder()
      .like(['t.name', 't.contact_name', 't.business_description'], params.search)
      .eq('t.business_category', params.business_category)
      .eq('t.status', params.status)
      .gte('t.budget_max', params.budget_min)
      .lte('t.space_need', params.space_need_max)

    const where = f.where()
    const total = await count(this.db, `SELECT COUNT(*) AS c FROM tenants t ${where}`, f.values())
    const rows = await findMany(
      this.db,
      `SELECT t.*,
              (SELECT COUNT(*) FROM leads l WHERE l.tenant_id = t.id) AS lead_count,
              (SELECT MAX(fit_score) FROM tenant_property_matches m WHERE m.tenant_id = t.id) AS best_fit_score
         FROM tenants t ${where}
        ORDER BY ${params.orderBy.replace(/^/, 't.')}
        LIMIT ? OFFSET ?`,
      [...f.values(), params.limit, params.offset]
    )
    return { rows, total }
  }

  async update(id: string, patch: any, actorId: string, requestId: string) {
    const before = await findOneOrFail<any>(
      this.db,
      `SELECT * FROM tenants WHERE id = ?`,
      [id],
      'Tenant',
      id
    )
    const allowed = [
      'name',
      'tenant_type',
      'business_category',
      'contact_name',
      'phone',
      'email',
      'budget_min',
      'budget_max',
      'space_need',
      'location_preference',
      'business_description',
      'status'
    ]
    const fields: string[] = []
    const values: unknown[] = []
    for (const k of allowed) {
      if (patch[k] !== undefined) {
        fields.push(`${k} = ?`)
        values.push(patch[k])
      }
    }
    if (fields.length === 0) return this.get(id)

    await transaction(this.db, [
      this.db
        .prepare(`UPDATE tenants SET ${fields.join(', ')}, updated_at = datetime('now') WHERE id = ?`)
        .bind(...values, id),
      auditStmt(this.db, {
        userId: actorId,
        entityType: 'TENANT',
        entityId: id,
        action: 'TENANT_UPDATED',
        oldValue: { status: before.status, business_category: before.business_category },
        newValue: patch,
        requestId
      })
    ])
    return this.get(id)
  }

  static get sortable() {
    return SORTABLE
  }
}

export class SegmentService {
  constructor(private readonly db: D1Database) {}

  async list() {
    const rows = await findMany<any>(
      this.db,
      `SELECT * FROM tenant_segments ORDER BY status ASC, name ASC`
    )
    return rows.map((r) => ({ ...r, requirements: parseJson<string[]>(r.requirements, []) }))
  }

  async get(id: string) {
    const row = await findOneOrFail<any>(
      this.db,
      `SELECT * FROM tenant_segments WHERE id = ?`,
      [id],
      'Tenant segment',
      id
    )
    return { ...row, requirements: parseJson<string[]>(row.requirements, []) }
  }

  async create(input: any, actorId: string, requestId: string) {
    const id = ID.segment()
    await transaction(this.db, [
      this.db
        .prepare(
          `INSERT INTO tenant_segments
             (id, name, description, business_category, minimum_space, maximum_space,
              budget_min, budget_max, requirements, status)
           VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, 'ACTIVE')`
        )
        .bind(
          id,
          input.name,
          input.description ?? null,
          input.business_category,
          input.minimum_space ?? null,
          input.maximum_space ?? null,
          input.budget_min ?? null,
          input.budget_max ?? null,
          JSON.stringify(input.requirements ?? [])
        ),
      auditStmt(this.db, {
        userId: actorId,
        entityType: 'TENANT_SEGMENT',
        entityId: id,
        action: 'SEGMENT_CREATED',
        newValue: { name: input.name },
        requestId
      })
    ])
    return this.get(id)
  }
}
