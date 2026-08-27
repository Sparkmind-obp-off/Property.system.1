/**
 * Offer + Campaign — application service (use cases).
 * Traceability: PS-IMP-011 §12 | PS-MASTER-001 §9, §32 | PS-DATA-009 §20, §21
 *
 * Use cases: CreateOffer, UpdateOffer, PublishOffer, PauseOffer, ArchiveOffer,
 *            CreateCampaign, StartCampaign, EndCampaign
 */
import { AnalyticsEvent, analyticsStmt, auditStmt } from '../../../shared/audit'
import { ID } from '../../../shared/id'
import {
  FilterBuilder,
  count,
  findMany,
  findOne,
  findOneOrFail,
  transaction
} from '../../../shared/repository'
import {
  assertCampaignRunnable,
  assertCampaignTransition,
  assertOfferTransition,
  assertPublishable,
  publicationGaps,
  type CampaignStatus,
  type OfferStatus
} from '../domain/offer.rules'

const SORTABLE = ['created_at', 'price', 'title', 'status', 'published_at'] as const

export interface OfferRow {
  id: string
  property_id: string
  tenant_segment_id: string | null
  title: string
  description: string | null
  value_proposition: string | null
  price: number
  terms: string | null
  cta: string
  status: OfferStatus
  published_at: string | null
  created_by: string
  created_at: string
  updated_at: string
}

export class OfferService {
  constructor(private readonly db: D1Database) {}

  static get sortable() {
    return SORTABLE
  }

  /** UC: CreateOffer — always starts as DRAFT. */
  async create(input: any, actorId: string, requestId: string) {
    // Property must exist (referential + domain context).
    const property = await findOneOrFail<any>(
      this.db,
      `SELECT id, name, price, price_period, lifecycle_status, availability_status FROM properties WHERE id = ?`,
      [input.property_id],
      'Property',
      input.property_id
    )

    const id = ID.offer()
    await transaction(this.db, [
      this.db
        .prepare(
          `INSERT INTO offers
             (id, property_id, tenant_segment_id, title, description, value_proposition,
              price, terms, cta, status, created_by)
           VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, 'DRAFT', ?)`
        )
        .bind(
          id,
          property.id,
          input.tenant_segment_id ?? null,
          input.title,
          input.description ?? null,
          input.value_proposition ?? null,
          input.price ?? property.price,
          input.terms ?? null,
          input.cta ?? 'Hubungi Kami',
          actorId
        ),
      auditStmt(this.db, {
        userId: actorId,
        entityType: 'OFFER',
        entityId: id,
        action: 'OFFER_CREATED',
        newValue: { property_id: property.id, title: input.title, status: 'DRAFT' },
        requestId
      }),
      analyticsStmt(this.db, {
        eventType: AnalyticsEvent.OFFER_CREATED,
        entityType: 'OFFER',
        entityId: id,
        propertyId: property.id,
        value: input.price ?? property.price
      })
    ])

    return this.get(id)
  }

  async get(id: string) {
    const offer = await findOneOrFail<OfferRow>(
      this.db,
      `SELECT * FROM offers WHERE id = ?`,
      [id],
      'Offer',
      id
    )
    const property = await findOne<any>(
      this.db,
      `SELECT id, name, address, property_type, price, price_period, area_size,
              lifecycle_status, availability_status
         FROM properties WHERE id = ?`,
      [offer.property_id]
    )
    const segment = offer.tenant_segment_id
      ? await findOne<any>(this.db, `SELECT id, name, business_category FROM tenant_segments WHERE id = ?`, [
          offer.tenant_segment_id
        ])
      : null
    const campaigns = await findMany(
      this.db,
      `SELECT id, name, channel, status, start_at, end_at, budget FROM campaigns
        WHERE offer_id = ? ORDER BY created_at DESC`,
      [id]
    )
    const leadStats = await findOne<any>(
      this.db,
      `SELECT COUNT(*) AS total,
              SUM(CASE WHEN status = 'WON' THEN 1 ELSE 0 END) AS won,
              SUM(CASE WHEN status NOT IN ('WON','LOST') THEN 1 ELSE 0 END) AS open
         FROM leads WHERE offer_id = ?`,
      [id]
    )

    return {
      ...offer,
      property,
      segment,
      campaigns,
      publication_gaps: publicationGaps({
        title: offer.title,
        value_proposition: offer.value_proposition,
        price: offer.price,
        cta: offer.cta,
        property_lifecycle: property?.lifecycle_status ?? 'DRAFT',
        property_availability: property?.availability_status ?? 'UNAVAILABLE'
      }),
      lead_stats: {
        total: Number(leadStats?.total ?? 0),
        won: Number(leadStats?.won ?? 0),
        open: Number(leadStats?.open ?? 0)
      }
    }
  }

  async list(params: {
    page: number
    limit: number
    offset: number
    orderBy: string
    search?: string
    status?: string
    property_id?: string
  }) {
    const f = new FilterBuilder()
      .like(['o.title', 'o.value_proposition'], params.search)
      .eq('o.status', params.status)
      .eq('o.property_id', params.property_id)

    const where = f.where()
    const total = await count(this.db, `SELECT COUNT(*) AS c FROM offers o ${where}`, f.values())
    const rows = await findMany(
      this.db,
      `SELECT o.*, p.name AS property_name, p.address AS property_address,
              s.name AS segment_name,
              (SELECT COUNT(*) FROM leads l WHERE l.offer_id = o.id) AS lead_count
         FROM offers o
         JOIN properties p ON p.id = o.property_id
         LEFT JOIN tenant_segments s ON s.id = o.tenant_segment_id
         ${where}
        ORDER BY o.${params.orderBy}
        LIMIT ? OFFSET ?`,
      [...f.values(), params.limit, params.offset]
    )
    return { rows, total }
  }

  /** UC: UpdateOffer — content only; status changes use explicit endpoints (§33). */
  async update(id: string, patch: any, actorId: string, requestId: string) {
    const before = await findOneOrFail<OfferRow>(
      this.db,
      `SELECT * FROM offers WHERE id = ?`,
      [id],
      'Offer',
      id
    )
    if (before.status === 'EXPIRED') {
      assertOfferTransition(before.status, 'READY') // always throws — expired is terminal
    }

    const allowed = [
      'title',
      'description',
      'value_proposition',
      'price',
      'terms',
      'cta',
      'tenant_segment_id'
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
        .prepare(`UPDATE offers SET ${fields.join(', ')}, updated_at = datetime('now') WHERE id = ?`)
        .bind(...values, id),
      auditStmt(this.db, {
        userId: actorId,
        entityType: 'OFFER',
        entityId: id,
        action: 'OFFER_UPDATED',
        oldValue: { title: before.title, price: before.price },
        newValue: patch,
        requestId
      })
    ])
    return this.get(id)
  }

  /** UC: MarkOfferReady — DRAFT → READY. */
  async markReady(id: string, actorId: string, requestId: string) {
    const offer = await findOneOrFail<OfferRow>(
      this.db,
      `SELECT * FROM offers WHERE id = ?`,
      [id],
      'Offer',
      id
    )
    assertOfferTransition(offer.status, 'READY')
    await transaction(this.db, [
      this.db
        .prepare(`UPDATE offers SET status = 'READY', updated_at = datetime('now') WHERE id = ?`)
        .bind(id),
      auditStmt(this.db, {
        userId: actorId,
        entityType: 'OFFER',
        entityId: id,
        action: 'OFFER_STATUS_CHANGED',
        oldValue: { status: offer.status },
        newValue: { status: 'READY' },
        requestId
      })
    ])
    return this.get(id)
  }

  /**
   * UC: PublishOffer — critical action (§29). Requires content completeness and
   * a publishable property (DR-002). Also marks the property as MARKETED.
   */
  async publish(id: string, actorId: string, requestId: string) {
    const offer = await findOneOrFail<OfferRow>(
      this.db,
      `SELECT * FROM offers WHERE id = ?`,
      [id],
      'Offer',
      id
    )
    const property = await findOneOrFail<any>(
      this.db,
      `SELECT id, lifecycle_status, availability_status FROM properties WHERE id = ?`,
      [offer.property_id],
      'Property',
      offer.property_id
    )

    assertPublishable({
      title: offer.title,
      value_proposition: offer.value_proposition,
      price: offer.price,
      cta: offer.cta,
      property_lifecycle: property.lifecycle_status,
      property_availability: property.availability_status
    })

    // §9 locks the lifecycle DRAFT → READY → ACTIVE(published). READY is an
    // explicit review gate, so publication is never allowed straight from
    // DRAFT — the transition table is the single source of truth here.
    assertOfferTransition(offer.status, 'ACTIVE')

    const statements: D1PreparedStatement[] = [
      this.db
        .prepare(
          `UPDATE offers SET status = 'ACTIVE', published_at = datetime('now'),
                  updated_at = datetime('now') WHERE id = ?`
        )
        .bind(id),
      auditStmt(this.db, {
        userId: actorId,
        entityType: 'OFFER',
        entityId: id,
        action: 'OFFER_PUBLISHED',
        oldValue: { status: offer.status },
        newValue: { status: 'ACTIVE' },
        requestId
      }),
      analyticsStmt(this.db, {
        eventType: AnalyticsEvent.OFFER_PUBLISHED,
        entityType: 'OFFER',
        entityId: id,
        propertyId: offer.property_id,
        value: offer.price
      })
    ]

    // Publishing an offer markets the property (business chain §9 → §10).
    if (['VERIFIED', 'ACTIVE'].includes(property.lifecycle_status)) {
      statements.push(
        this.db
          .prepare(
            `UPDATE properties SET lifecycle_status = 'MARKETED',
                    availability_status = CASE WHEN availability_status = 'UNAVAILABLE' THEN 'AVAILABLE' ELSE availability_status END,
                    updated_at = datetime('now') WHERE id = ?`
          )
          .bind(property.id),
        analyticsStmt(this.db, {
          eventType: AnalyticsEvent.PROPERTY_MARKETED,
          entityType: 'PROPERTY',
          entityId: property.id,
          propertyId: property.id
        })
      )
    }

    await transaction(this.db, statements)
    return this.get(id)
  }

  /** UC: PauseOffer / ResumeOffer / ArchiveOffer. */
  async changeStatus(id: string, to: OfferStatus, actorId: string, requestId: string) {
    const offer = await findOneOrFail<OfferRow>(
      this.db,
      `SELECT * FROM offers WHERE id = ?`,
      [id],
      'Offer',
      id
    )
    assertOfferTransition(offer.status, to)

    const statements: D1PreparedStatement[] = [
      this.db
        .prepare(`UPDATE offers SET status = ?, updated_at = datetime('now') WHERE id = ?`)
        .bind(to, id),
      auditStmt(this.db, {
        userId: actorId,
        entityType: 'OFFER',
        entityId: id,
        action: 'OFFER_STATUS_CHANGED',
        oldValue: { status: offer.status },
        newValue: { status: to },
        requestId
      })
    ]

    // Archiving/expiring an offer ends its running campaigns.
    if (to === 'EXPIRED') {
      statements.push(
        this.db
          .prepare(
            `UPDATE campaigns SET status = 'ENDED', end_at = COALESCE(end_at, datetime('now')),
                    updated_at = datetime('now')
              WHERE offer_id = ? AND status IN ('DRAFT','RUNNING','PAUSED')`
          )
          .bind(id)
      )
    }

    await transaction(this.db, statements)
    return this.get(id)
  }
}

/* -------------------------------- Campaign -------------------------------- */

export class CampaignService {
  constructor(private readonly db: D1Database) {}

  async create(input: any, actorId: string, requestId: string) {
    const offer = await findOneOrFail<OfferRow>(
      this.db,
      `SELECT * FROM offers WHERE id = ?`,
      [input.offer_id],
      'Offer',
      input.offer_id
    )
    const id = ID.campaign()
    await transaction(this.db, [
      this.db
        .prepare(
          `INSERT INTO campaigns (id, offer_id, name, channel, objective, status, start_at, end_at, budget, created_by)
           VALUES (?, ?, ?, ?, ?, 'DRAFT', ?, ?, ?, ?)`
        )
        .bind(
          id,
          offer.id,
          input.name,
          input.channel ?? 'DIRECT_OUTREACH',
          input.objective ?? null,
          input.start_at ?? null,
          input.end_at ?? null,
          input.budget ?? null,
          actorId
        ),
      auditStmt(this.db, {
        userId: actorId,
        entityType: 'CAMPAIGN',
        entityId: id,
        action: 'CAMPAIGN_CREATED',
        newValue: { offer_id: offer.id, name: input.name, channel: input.channel },
        requestId
      })
    ])
    return this.get(id)
  }

  async get(id: string) {
    const campaign = await findOneOrFail<any>(
      this.db,
      `SELECT c.*, o.title AS offer_title, o.status AS offer_status, o.property_id,
              p.name AS property_name
         FROM campaigns c
         JOIN offers o ON o.id = c.offer_id
         JOIN properties p ON p.id = o.property_id
        WHERE c.id = ?`,
      [id],
      'Campaign',
      id
    )
    const stats = await findOne<any>(
      this.db,
      `SELECT COUNT(*) AS leads,
              SUM(CASE WHEN status = 'QUALIFIED' OR status IN ('INTERESTED','VISIT_SCHEDULED','VISITED','NEGOTIATION','WON') THEN 1 ELSE 0 END) AS qualified,
              SUM(CASE WHEN status = 'WON' THEN 1 ELSE 0 END) AS won
         FROM leads WHERE campaign_id = ?`,
      [id]
    )
    return {
      ...campaign,
      performance: {
        leads: Number(stats?.leads ?? 0),
        qualified: Number(stats?.qualified ?? 0),
        won: Number(stats?.won ?? 0),
        conversion_rate:
          Number(stats?.leads ?? 0) > 0
            ? Number((((stats?.won ?? 0) / stats.leads) * 100).toFixed(1))
            : 0
      }
    }
  }

  async list(params: { status?: string; offer_id?: string; limit: number; offset: number; page: number }) {
    const f = new FilterBuilder().eq('c.status', params.status).eq('c.offer_id', params.offer_id)
    const where = f.where()
    const total = await count(this.db, `SELECT COUNT(*) AS c FROM campaigns c ${where}`, f.values())
    const rows = await findMany(
      this.db,
      `SELECT c.*, o.title AS offer_title, p.name AS property_name,
              (SELECT COUNT(*) FROM leads l WHERE l.campaign_id = c.id) AS lead_count,
              (SELECT COUNT(*) FROM leads l WHERE l.campaign_id = c.id AND l.status = 'WON') AS won_count
         FROM campaigns c
         JOIN offers o ON o.id = c.offer_id
         JOIN properties p ON p.id = o.property_id
         ${where}
        ORDER BY c.created_at DESC
        LIMIT ? OFFSET ?`,
      [...f.values(), params.limit, params.offset]
    )
    return { rows, total }
  }

  /** UC: StartCampaign — requires a published offer. */
  async changeStatus(id: string, to: CampaignStatus, actorId: string, requestId: string) {
    const campaign = await findOneOrFail<any>(
      this.db,
      `SELECT c.*, o.status AS offer_status FROM campaigns c JOIN offers o ON o.id = c.offer_id WHERE c.id = ?`,
      [id],
      'Campaign',
      id
    )
    assertCampaignTransition(campaign.status as CampaignStatus, to)
    if (to === 'RUNNING') assertCampaignRunnable(campaign.offer_status)

    const statements: D1PreparedStatement[] = [
      this.db
        .prepare(
          `UPDATE campaigns
              SET status = ?,
                  start_at = CASE WHEN ? = 'RUNNING' AND start_at IS NULL THEN datetime('now') ELSE start_at END,
                  end_at   = CASE WHEN ? = 'ENDED' THEN COALESCE(end_at, datetime('now')) ELSE end_at END,
                  updated_at = datetime('now')
            WHERE id = ?`
        )
        .bind(to, to, to, id),
      auditStmt(this.db, {
        userId: actorId,
        entityType: 'CAMPAIGN',
        entityId: id,
        action: 'CAMPAIGN_STATUS_CHANGED',
        oldValue: { status: campaign.status },
        newValue: { status: to },
        requestId
      })
    ]
    if (to === 'RUNNING') {
      statements.push(
        analyticsStmt(this.db, {
          eventType: AnalyticsEvent.CAMPAIGN_STARTED,
          entityType: 'CAMPAIGN',
          entityId: id,
          propertyId: campaign.property_id ?? null,
          campaignId: id
        })
      )
    }
    await transaction(this.db, statements)
    return this.get(id)
  }
}
