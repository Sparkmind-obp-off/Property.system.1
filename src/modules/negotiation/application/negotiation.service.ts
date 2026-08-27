/**
 * Negotiation — application service (use cases).
 * Traceability: PS-IMP-011 §17 | PS-MASTER-001 §15 | PS-DATA-009 §29
 *               DR-006, DR-007
 *
 * Use cases: CreateNegotiation, CounterOffer, AcceptNegotiation,
 *            RejectNegotiation, GetNegotiation, ListNegotiations
 */
import { AnalyticsEvent, activityStmt, analyticsStmt, auditStmt } from '../../../shared/audit'
import { ID } from '../../../shared/id'
import {
  FilterBuilder,
  count,
  findMany,
  findOneOrFail,
  transaction
} from '../../../shared/repository'
import { assertLeadTransition } from '../../lead/domain/lead.rules'
import {
  analyzeDiscount,
  assertAgreement,
  assertNegotiable,
  assertNegotiableProperty,
  assertNegotiationTransition,
  assertNoOpenNegotiation,
  assertPriceProposal,
  type NegotiationStatus
} from '../domain/negotiation.rules'

export interface NegotiationRow {
  id: string
  property_id: string
  lead_id: string
  visit_id: string | null
  created_by: string
  current_price: number
  proposed_price: number
  agreed_price: number | null
  terms: string | null
  status: NegotiationStatus
  started_at: string
  agreed_at: string | null
  closed_at: string | null
  notes: string | null
}

export class NegotiationService {
  constructor(private readonly db: D1Database) {}

  /** UC: CreateNegotiation — DR-006 requires property + qualified lead. */
  async create(input: any, actorId: string, requestId: string) {
    const lead = await findOneOrFail<any>(
      this.db,
      `SELECT l.*, p.price AS property_price, p.availability_status, p.name AS property_name,
              t.name AS tenant_name
         FROM leads l
         JOIN properties p ON p.id = l.property_id
         JOIN tenants t ON t.id = l.tenant_id
        WHERE l.id = ?`,
      [input.lead_id],
      'Lead',
      input.lead_id
    )

    assertNegotiable(lead.status)
    assertNegotiableProperty(lead.availability_status)

    const openCount = await count(
      this.db,
      `SELECT COUNT(*) AS c FROM negotiations WHERE lead_id = ? AND status IN ('OPEN','COUNTER_OFFER')`,
      [lead.id]
    )
    assertNoOpenNegotiation(openCount)

    const currentPrice = input.current_price ?? lead.property_price
    assertPriceProposal({ current_price: currentPrice, proposed_price: input.proposed_price })

    if (input.visit_id) {
      await findOneOrFail(
        this.db,
        `SELECT id FROM visits WHERE id = ? AND lead_id = ?`,
        [input.visit_id, lead.id],
        'Visit',
        input.visit_id
      )
    }

    // Pipeline: opening a negotiation moves the lead to NEGOTIATION.
    let nextLeadStatus = lead.status
    if (lead.status !== 'NEGOTIATION') {
      assertLeadTransition(lead.status, 'NEGOTIATION')
      nextLeadStatus = 'NEGOTIATION'
    }

    const id = ID.negotiation()
    await transaction(this.db, [
      this.db
        .prepare(
          `INSERT INTO negotiations
             (id, property_id, lead_id, visit_id, created_by, current_price, proposed_price, terms, status, notes)
           VALUES (?, ?, ?, ?, ?, ?, ?, ?, 'OPEN', ?)`
        )
        .bind(
          id,
          lead.property_id,
          lead.id,
          input.visit_id ?? null,
          actorId,
          currentPrice,
          input.proposed_price,
          input.terms ?? null,
          input.notes ?? null
        ),
      this.db
        .prepare(
          `INSERT INTO negotiation_rounds (id, negotiation_id, actor, round_type, price, terms, notes, created_by)
           VALUES (?, ?, 'TENANT', 'PROPOSAL', ?, ?, ?, ?)`
        )
        .bind(ID.negotiationRound(), id, input.proposed_price, input.terms ?? null, input.notes ?? null, actorId),
      this.db
        .prepare(`UPDATE leads SET status = ?, updated_at = datetime('now') WHERE id = ?`)
        .bind(nextLeadStatus, lead.id),
      activityStmt(this.db, {
        leadId: lead.id,
        userId: actorId,
        activityType: 'NEGOTIATION',
        subject: `Negotiation opened — tenant proposed ${input.proposed_price}`,
        description: input.notes ?? null,
        metadata: { negotiation_id: id, current_price: currentPrice, proposed_price: input.proposed_price }
      }),
      auditStmt(this.db, {
        userId: actorId,
        entityType: 'NEGOTIATION',
        entityId: id,
        action: 'NEGOTIATION_CREATED',
        newValue: {
          lead_id: lead.id,
          property_id: lead.property_id,
          current_price: currentPrice,
          proposed_price: input.proposed_price
        },
        requestId
      }),
      analyticsStmt(this.db, {
        eventType: AnalyticsEvent.NEGOTIATION_STARTED,
        entityType: 'NEGOTIATION',
        entityId: id,
        propertyId: lead.property_id,
        leadId: lead.id,
        value: input.proposed_price
      })
    ])

    return this.get(id)
  }

  async get(id: string) {
    const negotiation = await findOneOrFail<any>(
      this.db,
      `SELECT n.*, l.status AS lead_status, l.score AS lead_score,
              t.id AS tenant_id, t.name AS tenant_name, t.phone AS tenant_phone,
              p.name AS property_name, p.price AS property_list_price, p.price_period,
              p.availability_status AS property_availability,
              u.name AS created_by_name
         FROM negotiations n
         JOIN leads l ON l.id = n.lead_id
         JOIN tenants t ON t.id = l.tenant_id
         JOIN properties p ON p.id = n.property_id
         LEFT JOIN users u ON u.id = n.created_by
        WHERE n.id = ?`,
      [id],
      'Negotiation',
      id
    )

    const rounds = await findMany<any>(
      this.db,
      `SELECT r.*, u.name AS created_by_name
         FROM negotiation_rounds r LEFT JOIN users u ON u.id = r.created_by
        WHERE r.negotiation_id = ? ORDER BY r.created_at ASC`,
      [id]
    )

    const rental = await findMany<any>(
      this.db,
      `SELECT id, status, price, start_date, end_date FROM rentals WHERE negotiation_id = ? LIMIT 1`,
      [id]
    )

    const referencePrice = negotiation.agreed_price ?? negotiation.proposed_price
    return {
      ...negotiation,
      rounds,
      rental: rental[0] ?? null,
      discount_analysis: analyzeDiscount(negotiation.property_list_price, referencePrice),
      can_accept: ['OPEN', 'COUNTER_OFFER'].includes(negotiation.status),
      can_activate_rental: negotiation.status === 'AGREED' && !rental[0]
    }
  }

  async list(params: {
    page: number
    limit: number
    offset: number
    status?: string
    property_id?: string
    lead_id?: string
  }) {
    const f = new FilterBuilder()
      .eq('n.status', params.status)
      .eq('n.property_id', params.property_id)
      .eq('n.lead_id', params.lead_id)
    const where = f.where()
    const total = await count(this.db, `SELECT COUNT(*) AS c FROM negotiations n ${where}`, f.values())
    const rows = await findMany(
      this.db,
      `SELECT n.*, t.name AS tenant_name, p.name AS property_name, p.price AS property_list_price,
              l.status AS lead_status,
              (SELECT COUNT(*) FROM negotiation_rounds r WHERE r.negotiation_id = n.id) AS round_count
         FROM negotiations n
         JOIN leads l ON l.id = n.lead_id
         JOIN tenants t ON t.id = l.tenant_id
         JOIN properties p ON p.id = n.property_id
         ${where}
        ORDER BY n.created_at DESC
        LIMIT ? OFFSET ?`,
      [...f.values(), params.limit, params.offset]
    )
    return { rows, total }
  }

  /** UC: CounterOffer — owner side responds with a new price. */
  async counter(id: string, input: any, actorId: string, requestId: string) {
    const n = await findOneOrFail<NegotiationRow>(
      this.db,
      `SELECT * FROM negotiations WHERE id = ?`,
      [id],
      'Negotiation',
      id
    )
    assertNegotiationTransition(n.status, 'COUNTER_OFFER')
    assertPriceProposal({ current_price: n.current_price, proposed_price: input.price })

    await transaction(this.db, [
      this.db
        .prepare(
          `UPDATE negotiations
              SET status = 'COUNTER_OFFER', current_price = ?, terms = COALESCE(?, terms),
                  updated_at = datetime('now')
            WHERE id = ?`
        )
        .bind(input.price, input.terms ?? null, id),
      this.db
        .prepare(
          `INSERT INTO negotiation_rounds (id, negotiation_id, actor, round_type, price, terms, notes, created_by)
           VALUES (?, ?, ?, 'COUNTER_OFFER', ?, ?, ?, ?)`
        )
        .bind(
          ID.negotiationRound(),
          id,
          input.actor ?? 'OWNER',
          input.price,
          input.terms ?? null,
          input.notes ?? null,
          actorId
        ),
      activityStmt(this.db, {
        leadId: n.lead_id,
        userId: actorId,
        activityType: 'NEGOTIATION',
        subject: `Counter offer: ${input.price}`,
        description: input.notes ?? null,
        metadata: { negotiation_id: id, price: input.price }
      }),
      auditStmt(this.db, {
        userId: actorId,
        entityType: 'NEGOTIATION',
        entityId: id,
        action: 'NEGOTIATION_COUNTERED',
        oldValue: { status: n.status, current_price: n.current_price },
        newValue: { status: 'COUNTER_OFFER', current_price: input.price },
        requestId
      })
    ])
    return this.get(id)
  }

  /**
   * UC: AcceptNegotiation — CRITICAL ACTION (§29). Requires an explicit agreed
   * price (DR-007). Acceptance does NOT create a rental: rental activation is a
   * separate, explicit domain operation (§8, §16).
   */
  async accept(id: string, input: { agreed_price?: number; terms?: string }, actorId: string, requestId: string) {
    const n = await findOneOrFail<any>(
      this.db,
      `SELECT n.*, l.status AS lead_status, p.availability_status
         FROM negotiations n
         JOIN leads l ON l.id = n.lead_id
         JOIN properties p ON p.id = n.property_id
        WHERE n.id = ?`,
      [id],
      'Negotiation',
      id
    )
    assertNegotiationTransition(n.status, 'AGREED')
    assertNegotiableProperty(n.availability_status)

    // Default to the latest proposed price when the caller does not override it.
    const agreed = assertAgreement(input.agreed_price ?? n.proposed_price)

    await transaction(this.db, [
      this.db
        .prepare(
          `UPDATE negotiations
              SET status = 'AGREED', agreed_price = ?, terms = COALESCE(?, terms),
                  agreed_at = datetime('now'), closed_at = datetime('now'), updated_at = datetime('now')
            WHERE id = ?`
        )
        .bind(agreed, input.terms ?? null, id),
      this.db
        .prepare(
          `INSERT INTO negotiation_rounds (id, negotiation_id, actor, round_type, price, terms, created_by)
           VALUES (?, ?, 'OWNER', 'ACCEPT', ?, ?, ?)`
        )
        .bind(ID.negotiationRound(), id, agreed, input.terms ?? null, actorId),
      activityStmt(this.db, {
        leadId: n.lead_id,
        userId: actorId,
        activityType: 'NEGOTIATION',
        subject: `Negotiation agreed at ${agreed}`,
        metadata: { negotiation_id: id, agreed_price: agreed }
      }),
      auditStmt(this.db, {
        userId: actorId,
        entityType: 'NEGOTIATION',
        entityId: id,
        action: 'NEGOTIATION_AGREED',
        oldValue: { status: n.status },
        newValue: { status: 'AGREED', agreed_price: agreed },
        requestId
      }),
      analyticsStmt(this.db, {
        eventType: AnalyticsEvent.NEGOTIATION_AGREED,
        entityType: 'NEGOTIATION',
        entityId: id,
        propertyId: n.property_id,
        leadId: n.lead_id,
        value: agreed
      })
    ])
    return this.get(id)
  }

  /** UC: RejectNegotiation — explicit failure with a reason. */
  async reject(id: string, reason: string, actorId: string, requestId: string) {
    const n = await findOneOrFail<NegotiationRow>(
      this.db,
      `SELECT * FROM negotiations WHERE id = ?`,
      [id],
      'Negotiation',
      id
    )
    assertNegotiationTransition(n.status, 'FAILED')

    await transaction(this.db, [
      this.db
        .prepare(
          `UPDATE negotiations
              SET status = 'FAILED', notes = COALESCE(?, notes), closed_at = datetime('now'),
                  updated_at = datetime('now')
            WHERE id = ?`
        )
        .bind(reason, id),
      this.db
        .prepare(
          `INSERT INTO negotiation_rounds (id, negotiation_id, actor, round_type, notes, created_by)
           VALUES (?, ?, 'OWNER', 'REJECT', ?, ?)`
        )
        .bind(ID.negotiationRound(), id, reason, actorId),
      activityStmt(this.db, {
        leadId: n.lead_id,
        userId: actorId,
        activityType: 'NEGOTIATION',
        subject: 'Negotiation failed',
        description: reason,
        metadata: { negotiation_id: id }
      }),
      auditStmt(this.db, {
        userId: actorId,
        entityType: 'NEGOTIATION',
        entityId: id,
        action: 'NEGOTIATION_FAILED',
        oldValue: { status: n.status },
        newValue: { status: 'FAILED', reason },
        requestId
      }),
      analyticsStmt(this.db, {
        eventType: AnalyticsEvent.NEGOTIATION_FAILED,
        entityType: 'NEGOTIATION',
        entityId: id,
        propertyId: n.property_id,
        leadId: n.lead_id,
        metadata: { reason }
      })
    ])
    return this.get(id)
  }
}
