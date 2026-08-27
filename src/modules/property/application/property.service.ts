/**
 * Property — application service (use cases).
 * Traceability: PS-IMP-011 §8, §20 | PS-MASTER-001 §32 | PS-DATA-009 §40, §41
 *
 * Use cases: CreateProperty, UpdateProperty, GetProperty, ListProperties,
 *            VerifyProperty, MarketProperty, DeleteProperty
 */
import { AnalyticsEvent, analyticsStmt, auditStmt } from '../../../shared/audit'
import { BusinessRuleViolation, NotFoundError } from '../../../shared/errors'
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
import {
  assertLifecycleTransition,
  assertMarketable,
  assertVerifiable,
  computeAreaSize,
  verificationGaps,
  type Availability,
  type Lifecycle
} from '../domain/property.rules'

export interface PropertyRow {
  id: string
  owner_id: string
  market_area_id: string | null
  name: string
  property_type: string
  address: string
  latitude: number | null
  longitude: number | null
  width: number | null
  length: number | null
  area_size: number | null
  price: number
  price_period: string
  availability_status: Availability
  lifecycle_status: Lifecycle
  description: string | null
  created_at: string
  updated_at: string
}

export interface CreatePropertyInput {
  name: string
  property_type: string
  address: string
  price: number
  price_period: string
  width?: number
  length?: number
  area_size?: number
  latitude?: number
  longitude?: number
  description?: string
  market_area_id?: string
}

const SORTABLE = ['created_at', 'price', 'name', 'area_size', 'updated_at'] as const

export class PropertyService {
  constructor(private readonly db: D1Database) {}

  /** UC: CreateProperty — always starts as DRAFT / UNAVAILABLE. */
  async create(input: CreatePropertyInput, actorId: string, requestId: string) {
    const id = ID.property()
    const areaSize = computeAreaSize(input.width, input.length, input.area_size)

    await transaction(this.db, [
      this.db
        .prepare(
          `INSERT INTO properties
             (id, owner_id, market_area_id, name, property_type, address, latitude, longitude,
              width, length, area_size, price, price_period, availability_status, lifecycle_status, description)
           VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, 'UNAVAILABLE', 'DRAFT', ?)`
        )
        .bind(
          id,
          actorId,
          input.market_area_id ?? null,
          input.name,
          input.property_type,
          input.address,
          input.latitude ?? null,
          input.longitude ?? null,
          input.width ?? null,
          input.length ?? null,
          areaSize,
          input.price,
          input.price_period,
          input.description ?? null
        ),
      auditStmt(this.db, {
        userId: actorId,
        entityType: 'PROPERTY',
        entityId: id,
        action: 'PROPERTY_CREATED',
        newValue: { name: input.name, price: input.price, lifecycle_status: 'DRAFT' },
        requestId
      }),
      analyticsStmt(this.db, {
        eventType: AnalyticsEvent.PROPERTY_CREATED,
        entityType: 'PROPERTY',
        entityId: id,
        propertyId: id,
        value: input.price
      })
    ])

    return this.get(id)
  }

  /** UC: GetProperty — detail payload per PS-DATA-009 §41. */
  async get(id: string) {
    const property = await findOneOrFail<PropertyRow>(
      this.db,
      `SELECT * FROM properties WHERE id = ?`,
      [id],
      'Property',
      id
    )

    const analysis = await findOne<any>(
      this.db,
      `SELECT * FROM property_analyses WHERE property_id = ? ORDER BY created_at DESC LIMIT 1`,
      [id]
    )

    const offers = await findMany(
      this.db,
      `SELECT id, title, price, status, published_at, created_at
         FROM offers WHERE property_id = ? ORDER BY created_at DESC LIMIT 10`,
      [id]
    )

    const leadSummary = await findOne<any>(
      this.db,
      `SELECT COUNT(*) AS total,
              SUM(CASE WHEN status NOT IN ('WON','LOST') THEN 1 ELSE 0 END) AS open,
              SUM(CASE WHEN temperature = 'HOT' THEN 1 ELSE 0 END) AS hot,
              SUM(CASE WHEN status = 'WON' THEN 1 ELSE 0 END) AS won
         FROM leads WHERE property_id = ?`,
      [id]
    )

    const activeRental = await findOne<any>(
      this.db,
      `SELECT r.id, r.status, r.start_date, r.end_date, r.price, r.payment_period,
              t.id AS tenant_id, t.name AS tenant_name
         FROM rentals r JOIN tenants t ON t.id = r.tenant_id
        WHERE r.property_id = ? AND r.status IN ('CONFIRMED','ACTIVE','EXPIRING')
        ORDER BY r.created_at DESC LIMIT 1`,
      [id]
    )

    const visits = await findMany(
      this.db,
      `SELECT id, scheduled_at, status, result FROM visits WHERE property_id = ?
        ORDER BY scheduled_at DESC LIMIT 5`,
      [id]
    )

    const matches = await findMany<any>(
      this.db,
      `SELECT m.id, m.fit_score, m.recommendation, m.reasoning,
              s.name AS segment_name, t.name AS tenant_name
         FROM tenant_property_matches m
         LEFT JOIN tenant_segments s ON s.id = m.tenant_segment_id
         LEFT JOIN tenants t ON t.id = m.tenant_id
        WHERE m.property_id = ?
        ORDER BY m.fit_score DESC LIMIT 5`,
      [id]
    )

    return {
      ...property,
      verification_gaps: verificationGaps(property),
      analysis: analysis
        ? {
            ...analysis,
            strengths: parseJson<string[]>(analysis.strengths, []),
            weaknesses: parseJson<string[]>(analysis.weaknesses, []),
            opportunities: parseJson<string[]>(analysis.opportunities, []),
            risks: parseJson<string[]>(analysis.risks, []),
            recommended_uses: parseJson<string[]>(analysis.recommended_uses, [])
          }
        : null,
      offers,
      lead_summary: {
        total: Number(leadSummary?.total ?? 0),
        open: Number(leadSummary?.open ?? 0),
        hot: Number(leadSummary?.hot ?? 0),
        won: Number(leadSummary?.won ?? 0)
      },
      visits,
      top_matches: matches.map((m) => ({ ...m, reasoning: parseJson<string[]>(m.reasoning, []) })),
      rental: activeRental ?? null
    }
  }

  /** UC: ListProperties — paginated, filtered, whitelisted sort. */
  async list(params: {
    page: number
    limit: number
    offset: number
    orderBy: string
    search?: string
    lifecycle_status?: string
    availability_status?: string
    property_type?: string
    price_min?: number
    price_max?: number
  }) {
    const f = new FilterBuilder()
      .like(['p.name', 'p.address'], params.search)
      .eq('p.lifecycle_status', params.lifecycle_status)
      .eq('p.availability_status', params.availability_status)
      .eq('p.property_type', params.property_type)
      .gte('p.price', params.price_min)
      .lte('p.price', params.price_max)

    const where = f.where()
    const total = await count(this.db, `SELECT COUNT(*) AS c FROM properties p ${where}`, f.values())

    const orderBy = params.orderBy.replace(/^/, 'p.')
    const rows = await findMany(
      this.db,
      `SELECT p.*,
              (SELECT COUNT(*) FROM leads l WHERE l.property_id = p.id) AS lead_count,
              (SELECT MAX(fit_score) FROM tenant_property_matches m WHERE m.property_id = p.id) AS best_fit_score,
              (SELECT overall_score FROM property_analyses a WHERE a.property_id = p.id
                ORDER BY a.created_at DESC LIMIT 1) AS analysis_score
         FROM properties p
         ${where}
        ORDER BY ${orderBy}
        LIMIT ? OFFSET ?`,
      [...f.values(), params.limit, params.offset]
    )

    return { rows, total }
  }

  /** UC: UpdateProperty — partial update of domain fields only. */
  async update(id: string, patch: Partial<CreatePropertyInput>, actorId: string, requestId: string) {
    const before = await findOneOrFail<PropertyRow>(
      this.db,
      `SELECT * FROM properties WHERE id = ?`,
      [id],
      'Property',
      id
    )

    const fields: string[] = []
    const values: unknown[] = []
    const allowed: (keyof CreatePropertyInput)[] = [
      'name',
      'property_type',
      'address',
      'price',
      'price_period',
      'width',
      'length',
      'area_size',
      'latitude',
      'longitude',
      'description',
      'market_area_id'
    ]
    for (const key of allowed) {
      if (patch[key] !== undefined) {
        fields.push(`${key} = ?`)
        values.push(patch[key])
      }
    }

    // Keep derived area_size consistent when dimensions change.
    const width = patch.width ?? before.width
    const length = patch.length ?? before.length
    if (patch.width !== undefined || patch.length !== undefined) {
      const derived = computeAreaSize(width, length, patch.area_size ?? before.area_size)
      if (derived !== null) {
        fields.push('area_size = ?')
        values.push(derived)
      }
    }

    if (fields.length === 0) return this.get(id)

    await transaction(this.db, [
      this.db
        .prepare(`UPDATE properties SET ${fields.join(', ')}, updated_at = datetime('now') WHERE id = ?`)
        .bind(...values, id),
      auditStmt(this.db, {
        userId: actorId,
        entityType: 'PROPERTY',
        entityId: id,
        action: 'PROPERTY_UPDATED',
        oldValue: pick(before, allowed as string[]),
        newValue: patch,
        requestId
      })
    ])

    return this.get(id)
  }

  /**
   * UC: VerifyProperty — explicit lifecycle action endpoint (DR-001, §55).
   * DRAFT/PENDING_VERIFICATION → VERIFIED, and becomes AVAILABLE.
   */
  async verify(id: string, actorId: string, requestId: string) {
    const p = await findOneOrFail<PropertyRow>(
      this.db,
      `SELECT * FROM properties WHERE id = ?`,
      [id],
      'Property',
      id
    )
    assertVerifiable(p)
    assertLifecycleTransition(p.lifecycle_status, 'VERIFIED')

    await transaction(this.db, [
      this.db
        .prepare(
          `UPDATE properties
              SET lifecycle_status = 'VERIFIED',
                  availability_status = CASE WHEN availability_status = 'RENTED' THEN 'RENTED' ELSE 'AVAILABLE' END,
                  updated_at = datetime('now')
            WHERE id = ?`
        )
        .bind(id),
      auditStmt(this.db, {
        userId: actorId,
        entityType: 'PROPERTY',
        entityId: id,
        action: 'PROPERTY_STATUS_CHANGED',
        oldValue: { lifecycle_status: p.lifecycle_status },
        newValue: { lifecycle_status: 'VERIFIED' },
        requestId
      }),
      analyticsStmt(this.db, {
        eventType: AnalyticsEvent.PROPERTY_VERIFIED,
        entityType: 'PROPERTY',
        entityId: id,
        propertyId: id
      })
    ])

    return this.get(id)
  }

  /** UC: MarketProperty — DR-002. */
  async market(id: string, actorId: string, requestId: string) {
    const p = await findOneOrFail<PropertyRow>(
      this.db,
      `SELECT * FROM properties WHERE id = ?`,
      [id],
      'Property',
      id
    )
    assertMarketable(p.lifecycle_status, p.availability_status)
    if (p.lifecycle_status !== 'MARKETED') {
      assertLifecycleTransition(p.lifecycle_status, 'MARKETED')
    }

    await transaction(this.db, [
      this.db
        .prepare(
          `UPDATE properties
              SET lifecycle_status = 'MARKETED',
                  availability_status = CASE WHEN availability_status = 'UNAVAILABLE' THEN 'AVAILABLE' ELSE availability_status END,
                  updated_at = datetime('now')
            WHERE id = ?`
        )
        .bind(id),
      auditStmt(this.db, {
        userId: actorId,
        entityType: 'PROPERTY',
        entityId: id,
        action: 'PROPERTY_STATUS_CHANGED',
        oldValue: { lifecycle_status: p.lifecycle_status },
        newValue: { lifecycle_status: 'MARKETED' },
        requestId
      }),
      analyticsStmt(this.db, {
        eventType: AnalyticsEvent.PROPERTY_MARKETED,
        entityType: 'PROPERTY',
        entityId: id,
        propertyId: id
      })
    ])

    return this.get(id)
  }

  /**
   * UC: DeleteProperty — refused while commercial history exists, because
   * historical records must not vanish (PS-DATA-009 §58, §59).
   */
  async remove(id: string, actorId: string, requestId: string) {
    const p = await findOneOrFail<PropertyRow>(
      this.db,
      `SELECT * FROM properties WHERE id = ?`,
      [id],
      'Property',
      id
    )

    const occupying = await count(
      this.db,
      `SELECT COUNT(*) AS c FROM rentals WHERE property_id = ? AND status IN ('CONFIRMED','ACTIVE','EXPIRING')`,
      [id]
    )
    if (occupying > 0) {
      throw new BusinessRuleViolation(
        'Property cannot be deleted while it has an occupying rental.',
        'DR-008',
        { property_id: id }
      )
    }

    const leads = await count(this.db, `SELECT COUNT(*) AS c FROM leads WHERE property_id = ?`, [id])
    if (leads > 0) {
      // Preserve history: deactivate instead of destroying commercial records.
      await transaction(this.db, [
        this.db
          .prepare(
            `UPDATE properties SET lifecycle_status = 'INACTIVE', availability_status = 'UNAVAILABLE',
                    updated_at = datetime('now') WHERE id = ?`
          )
          .bind(id),
        auditStmt(this.db, {
          userId: actorId,
          entityType: 'PROPERTY',
          entityId: id,
          action: 'PROPERTY_DEACTIVATED',
          oldValue: { lifecycle_status: p.lifecycle_status },
          newValue: { lifecycle_status: 'INACTIVE', reason: 'has_commercial_history' },
          requestId
        })
      ])
      return { deleted: false, deactivated: true, reason: 'Property has lead history and was archived instead.' }
    }

    await transaction(this.db, [
      this.db.prepare(`DELETE FROM properties WHERE id = ?`).bind(id),
      auditStmt(this.db, {
        userId: actorId,
        entityType: 'PROPERTY',
        entityId: id,
        action: 'PROPERTY_DELETED',
        oldValue: { name: p.name },
        requestId
      })
    ])
    return { deleted: true, deactivated: false }
  }

  static get sortable() {
    return SORTABLE
  }
}

function pick(row: object, keys: string[]) {
  const src = row as Record<string, unknown>
  const out: Record<string, unknown> = {}
  for (const k of keys) if (k in src) out[k] = src[k]
  return out
}
