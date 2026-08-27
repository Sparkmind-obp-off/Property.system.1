/**
 * Rental — application service. THE critical domain operation of the system.
 * Traceability: PS-IMP-011 §18, §19 | PS-MASTER-001 §16, §17, §18, §29
 *               PS-DATA-009 §30, §31 | DR-007, DR-008
 *
 * Use cases: CreateRental, ConfirmRental, ActivateRental, EndRental,
 *            CancelRental, GetRental, ListRentals, FlagExpiringRentals
 *
 * Invariants enforced here (defence in depth alongside the partial unique index
 * `uq_rentals_one_occupying_per_property` in migration 0006):
 *   - a property never holds two occupying rentals simultaneously (§18)
 *   - activation is transactional: rental + property + lead + audit in ONE batch
 *   - a lead may only reach WON through rental activation (DR-007)
 */
import { AnalyticsEvent, activityStmt, analyticsStmt, auditStmt, notificationStmt } from '../../../shared/audit'
import { BusinessRuleViolation } from '../../../shared/errors'
import { ID } from '../../../shared/id'
import {
  FilterBuilder,
  count,
  findMany,
  findOne,
  findOneOrFail,
  transaction
} from '../../../shared/repository'
import { assertLeadTransition } from '../../lead/domain/lead.rules'
import {
  availabilityAfterRentalActivated,
  availabilityAfterRentalEnded
} from '../../property/domain/property.rules'
import {
  EXPIRING_WINDOW_DAYS,
  OCCUPYING_STATUSES,
  assertActivatable,
  assertCreatable,
  assertEndReason,
  assertRentalTransition,
  assertTermsComplete,
  daysUntil,
  shouldFlagExpiring,
  termsGaps,
  type RentalStatus
} from '../domain/rental.rules'

export interface RentalRow {
  id: string
  property_id: string
  tenant_id: string
  lead_id: string | null
  negotiation_id: string | null
  start_date: string
  end_date: string
  price: number
  payment_period: string
  deposit: number
  terms: string | null
  status: RentalStatus
  activated_at: string | null
  ended_at: string | null
  end_reason: string | null
  idempotency_key: string | null
  created_by: string
  created_at: string
  updated_at: string
}

export interface CreateRentalInput {
  property_id?: string
  tenant_id?: string
  lead_id?: string
  negotiation_id?: string
  start_date: string
  end_date: string
  price?: number
  payment_period?: string
  deposit?: number
  terms?: string
  idempotency_key?: string
}

const OCCUPYING_SQL = OCCUPYING_STATUSES.map((s) => `'${s}'`).join(',')

export class RentalService {
  constructor(private readonly db: D1Database) {}

  /* ------------------------------ Queries ------------------------------ */

  /** Count OTHER rentals currently occupying the property (DR-008). */
  private async occupyingCount(propertyId: string, excludeRentalId?: string): Promise<number> {
    return count(
      this.db,
      `SELECT COUNT(*) AS c FROM rentals
        WHERE property_id = ? AND status IN (${OCCUPYING_SQL})
          ${excludeRentalId ? 'AND id <> ?' : ''}`,
      excludeRentalId ? [propertyId, excludeRentalId] : [propertyId]
    )
  }

  async get(id: string) {
    const rental = await findOneOrFail<any>(
      this.db,
      `SELECT r.*,
              p.name AS property_name, p.address AS property_address,
              p.property_type, p.price AS property_list_price,
              p.availability_status AS property_availability,
              p.lifecycle_status AS property_lifecycle,
              t.name AS tenant_name, t.phone AS tenant_phone, t.contact_name,
              t.business_category,
              l.status AS lead_status, l.score AS lead_score,
              n.status AS negotiation_status, n.agreed_price,
              u.name AS created_by_name
         FROM rentals r
         JOIN properties p ON p.id = r.property_id
         JOIN tenants t ON t.id = r.tenant_id
         LEFT JOIN leads l ON l.id = r.lead_id
         LEFT JOIN negotiations n ON n.id = r.negotiation_id
         LEFT JOIN users u ON u.id = r.created_by
        WHERE r.id = ?`,
      [id],
      'Rental',
      id
    )

    const otherOccupying = await this.occupyingCount(rental.property_id, id)
    const gaps = termsGaps(rental)
    const days = daysUntil(rental.end_date)

    return {
      ...rental,
      days_until_end: Number.isFinite(days) ? days : null,
      is_expiring: shouldFlagExpiring(rental.status, rental.end_date),
      terms_gaps: gaps,
      /** Explainable activation readiness (§6: never a bare flag without reasons). */
      activation_readiness: this.readiness(rental, otherOccupying, gaps),
      can_confirm: ['DRAFT', 'PENDING'].includes(rental.status),
      can_activate: ['DRAFT', 'PENDING', 'CONFIRMED'].includes(rental.status),
      can_end: ['ACTIVE', 'EXPIRING'].includes(rental.status),
      can_cancel: ['DRAFT', 'PENDING', 'CONFIRMED'].includes(rental.status),
      allowed_transitions: this.allowedTransitions(rental.status)
    }
  }

  private allowedTransitions(status: RentalStatus): readonly string[] {
    const map: Record<RentalStatus, readonly string[]> = {
      DRAFT: ['PENDING', 'CONFIRMED', 'ACTIVE', 'CANCELLED'],
      PENDING: ['CONFIRMED', 'ACTIVE', 'CANCELLED'],
      CONFIRMED: ['ACTIVE', 'CANCELLED'],
      ACTIVE: ['EXPIRING', 'ENDED'],
      EXPIRING: ['ACTIVE', 'ENDED'],
      ENDED: [],
      CANCELLED: []
    }
    return map[status] ?? []
  }

  /**
   * Explainable pre-flight for §17 activation rules. Returns every check with a
   * pass/fail so the UI can show WHY activation is blocked (§27 error states).
   */
  private readiness(rental: any, otherOccupying: number, gaps: string[]) {
    const checks = [
      { check: 'property_exists', ok: Boolean(rental.property_id), label: 'Property exists' },
      {
        check: 'property_available',
        ok: ['AVAILABLE', 'RESERVED'].includes(rental.property_availability),
        label: `Property availability is ${rental.property_availability}`
      },
      { check: 'tenant_valid', ok: Boolean(rental.tenant_id), label: 'Tenant is valid' },
      {
        check: 'terms_complete',
        ok: gaps.length === 0,
        label: gaps.length === 0 ? 'Commercial terms are complete' : `Missing terms: ${gaps.join(', ')}`
      },
      {
        check: 'negotiation_agreed',
        ok: !rental.negotiation_id || rental.negotiation_status === 'AGREED',
        label: rental.negotiation_id
          ? `Linked negotiation is ${rental.negotiation_status}`
          : 'No negotiation linked (not required)'
      },
      {
        check: 'no_double_rental',
        ok: otherOccupying === 0,
        label:
          otherOccupying === 0
            ? 'Property has no other occupying rental'
            : `Property already has ${otherOccupying} occupying rental(s)`
      },
      {
        check: 'status_allows_activation',
        ok: ['DRAFT', 'PENDING', 'CONFIRMED'].includes(rental.status),
        label: `Rental status is ${rental.status}`
      }
    ]
    const blockers = checks.filter((c) => !c.ok)
    return {
      ready: blockers.length === 0,
      checks,
      blockers: blockers.map((b) => b.check),
      reasons: checks.filter((c) => c.ok).map((c) => c.label),
      risks: blockers.map((b) => b.label)
    }
  }

  async list(params: {
    page: number
    limit: number
    offset: number
    status?: string
    property_id?: string
    tenant_id?: string
    expiring?: boolean
    search?: string
  }) {
    const f = new FilterBuilder()
      .eq('r.status', params.status)
      .eq('r.property_id', params.property_id)
      .eq('r.tenant_id', params.tenant_id)
      .like(["p.name", "t.name", "t.contact_name"], params.search)

    if (params.expiring) {
      f.raw(
        `r.status IN ('ACTIVE','EXPIRING') AND date(r.end_date) <= date('now', ?)`,
        `+${EXPIRING_WINDOW_DAYS} days`
      )
    }

    const where = f.where()
    const total = await count(
      this.db,
      `SELECT COUNT(*) AS c FROM rentals r
         JOIN properties p ON p.id = r.property_id
         JOIN tenants t ON t.id = r.tenant_id ${where}`,
      f.values()
    )
    const rows = await findMany(
      this.db,
      `SELECT r.id, r.property_id, r.tenant_id, r.lead_id, r.status, r.price, r.payment_period,
              r.deposit, r.start_date, r.end_date, r.activated_at, r.ended_at, r.created_at,
              p.name AS property_name, p.address AS property_address,
              t.name AS tenant_name, t.contact_name,
              CAST(julianday(r.end_date) - julianday('now') AS INTEGER) AS days_until_end
         FROM rentals r
         JOIN properties p ON p.id = r.property_id
         JOIN tenants t ON t.id = r.tenant_id
         ${where}
        ORDER BY
          CASE r.status WHEN 'EXPIRING' THEN 0 WHEN 'ACTIVE' THEN 1 WHEN 'CONFIRMED' THEN 2
                        WHEN 'PENDING' THEN 3 WHEN 'DRAFT' THEN 4 ELSE 5 END,
          r.end_date ASC
        LIMIT ? OFFSET ?`,
      [...f.values(), params.limit, params.offset]
    )
    return { rows, total }
  }

  /* ------------------------------ Use cases ----------------------------- */

  /**
   * UC: CreateRental — resolves the commercial context from a negotiation or a
   * lead when available, so the operator never re-types agreed terms.
   * Fails fast on the double-rental invariant (§18) before persisting anything.
   */
  async create(input: CreateRentalInput, actorId: string, requestId: string) {
    // Idempotency guard (§56) — replay returns the original rental.
    if (input.idempotency_key) {
      const existing = await findOne<{ id: string }>(
        this.db,
        `SELECT id FROM rentals WHERE idempotency_key = ?`,
        [input.idempotency_key]
      )
      if (existing) return this.get(existing.id)
    }

    let propertyId = input.property_id ?? null
    let tenantId = input.tenant_id ?? null
    let leadId = input.lead_id ?? null
    let negotiationStatus: string | null = null
    let price = input.price ?? null

    // 1. Negotiation is the strongest source of commercial truth (DR-007).
    if (input.negotiation_id) {
      const n = await findOneOrFail<any>(
        this.db,
        `SELECT n.*, l.tenant_id, l.status AS lead_status
           FROM negotiations n JOIN leads l ON l.id = n.lead_id
          WHERE n.id = ?`,
        [input.negotiation_id],
        'Negotiation',
        input.negotiation_id
      )
      negotiationStatus = n.status
      propertyId = propertyId ?? n.property_id
      tenantId = tenantId ?? n.tenant_id
      leadId = leadId ?? n.lead_id
      price = price ?? n.agreed_price ?? n.proposed_price

      // A negotiation may back only ONE rental.
      const already = await findOne<{ id: string; status: string }>(
        this.db,
        `SELECT id, status FROM rentals WHERE negotiation_id = ? AND status <> 'CANCELLED' LIMIT 1`,
        [input.negotiation_id]
      )
      if (already) {
        throw new BusinessRuleViolation(
          'This negotiation already has a rental.',
          'DR-007',
          { negotiation_id: input.negotiation_id, rental_id: already.id, status: already.status }
        )
      }
    }

    // 2. Lead context (property + tenant) when no negotiation was supplied.
    if (leadId) {
      const lead = await findOneOrFail<any>(
        this.db,
        `SELECT id, property_id, tenant_id, status, assigned_to FROM leads WHERE id = ?`,
        [leadId],
        'Lead',
        leadId
      )
      propertyId = propertyId ?? lead.property_id
      tenantId = tenantId ?? lead.tenant_id
      if (lead.status === 'LOST') {
        throw new BusinessRuleViolation('A lost lead cannot produce a rental.', 'DR-009', {
          lead_status: lead.status
        })
      }
    }

    if (!propertyId || !tenantId) {
      throw new BusinessRuleViolation(
        'A rental requires a property and a tenant (directly or via a lead/negotiation).',
        'DR-007',
        { property_id: propertyId, tenant_id: tenantId }
      )
    }

    const property = await findOneOrFail<any>(
      this.db,
      `SELECT id, name, price, price_period, availability_status, lifecycle_status, owner_id
         FROM properties WHERE id = ?`,
      [propertyId],
      'Property',
      propertyId
    )
    const tenant = await findOneOrFail<any>(
      this.db,
      `SELECT id, name, status FROM tenants WHERE id = ?`,
      [tenantId],
      'Tenant',
      tenantId
    )

    price = price ?? property.price
    const paymentPeriod = input.payment_period ?? property.price_period

    // Domain validation BEFORE any write (§34 request flow).
    assertTermsComplete({
      start_date: input.start_date,
      end_date: input.end_date,
      price: price ?? undefined,
      payment_period: paymentPeriod
    })

    const otherOccupying = await this.occupyingCount(propertyId)
    assertCreatable({
      property_availability: property.availability_status,
      other_occupying_rentals: otherOccupying,
      negotiation_status: negotiationStatus
    })

    const id = ID.rental()
    await transaction(this.db, [
      this.db
        .prepare(
          `INSERT INTO rentals
             (id, property_id, tenant_id, lead_id, negotiation_id, start_date, end_date,
              price, payment_period, deposit, terms, status, idempotency_key, created_by)
           VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, 'DRAFT', ?, ?)`
        )
        .bind(
          id,
          propertyId,
          tenantId,
          leadId,
          input.negotiation_id ?? null,
          input.start_date,
          input.end_date,
          price,
          paymentPeriod,
          input.deposit ?? 0,
          input.terms ?? null,
          input.idempotency_key ?? null,
          actorId
        ),
      ...(leadId
        ? [
            activityStmt(this.db, {
              leadId,
              userId: actorId,
              activityType: 'RENTAL',
              subject: `Rental draft created for ${property.name}`,
              description: `${input.start_date} → ${input.end_date} at ${price} / ${paymentPeriod}`,
              metadata: { rental_id: id, price, payment_period: paymentPeriod }
            })
          ]
        : []),
      auditStmt(this.db, {
        userId: actorId,
        entityType: 'RENTAL',
        entityId: id,
        action: 'RENTAL_CREATED',
        newValue: {
          property_id: propertyId,
          tenant_id: tenantId,
          lead_id: leadId,
          negotiation_id: input.negotiation_id ?? null,
          start_date: input.start_date,
          end_date: input.end_date,
          price,
          payment_period: paymentPeriod,
          status: 'DRAFT'
        },
        requestId
      }),
      analyticsStmt(this.db, {
        eventType: AnalyticsEvent.RENTAL_CREATED,
        entityType: 'RENTAL',
        entityId: id,
        propertyId,
        leadId,
        value: price
      })
    ])

    return this.get(id)
  }

  /**
   * UC: ConfirmRental — commits the deal commercially and RESERVES the property.
   * CONFIRMED is an occupying status, so the unique index already blocks a
   * second confirmed/active rental for the same property here (§18).
   */
  async confirm(id: string, actorId: string, requestId: string) {
    const rental = await findOneOrFail<any>(
      this.db,
      `SELECT r.*, p.availability_status, p.lifecycle_status, n.status AS negotiation_status
         FROM rentals r
         JOIN properties p ON p.id = r.property_id
         LEFT JOIN negotiations n ON n.id = r.negotiation_id
        WHERE r.id = ?`,
      [id],
      'Rental',
      id
    )
    assertRentalTransition(rental.status, 'CONFIRMED')
    assertTermsComplete(rental)

    const otherOccupying = await this.occupyingCount(rental.property_id, id)
    if (otherOccupying > 0) {
      throw new BusinessRuleViolation('Property already has an occupying rental.', 'DR-008', {
        other_occupying_rentals: otherOccupying
      })
    }
    if (rental.negotiation_id && rental.negotiation_status !== 'AGREED') {
      throw new BusinessRuleViolation(
        'The linked negotiation must be agreed before the rental can be confirmed.',
        'DR-007',
        { negotiation_status: rental.negotiation_status }
      )
    }

    const statements: D1PreparedStatement[] = [
      this.db
        .prepare(`UPDATE rentals SET status = 'CONFIRMED', updated_at = datetime('now') WHERE id = ?`)
        .bind(id),
      // Property is now reserved for this deal — availability is server-authoritative.
      this.db
        .prepare(
          `UPDATE properties
              SET availability_status = 'RESERVED',
                  lifecycle_status = CASE WHEN lifecycle_status IN ('RENTED','INACTIVE')
                                          THEN lifecycle_status ELSE 'RESERVED' END,
                  updated_at = datetime('now')
            WHERE id = ?`
        )
        .bind(rental.property_id),
      auditStmt(this.db, {
        userId: actorId,
        entityType: 'RENTAL',
        entityId: id,
        action: 'RENTAL_CONFIRMED',
        oldValue: { status: rental.status, property_availability: rental.availability_status },
        newValue: { status: 'CONFIRMED', property_availability: 'RESERVED' },
        requestId
      })
    ]
    if (rental.lead_id) {
      statements.push(
        activityStmt(this.db, {
          leadId: rental.lead_id,
          userId: actorId,
          activityType: 'RENTAL',
          subject: 'Rental confirmed — property reserved',
          metadata: { rental_id: id }
        })
      )
    }

    await transaction(this.db, statements)
    return this.get(id)
  }

  /**
   * UC: ActivateRental — §17 RENTAL ACTIVATION RULE.
   *
   * Validates ALL six preconditions, then performs ONE atomic batch that:
   *   rental → ACTIVE, property → RENTED/unavailable, lead → WON,
   *   pending follow-ups closed, audit + analytics + activity + notification.
   *
   * Concurrency: even if two requests pass validation simultaneously, the
   * partial unique index `uq_rentals_one_occupying_per_property` makes the
   * second batch fail atomically — surfaced as DR-008 by shared/http.fail.
   */
  async activate(id: string, actorId: string, requestId: string) {
    const rental = await findOneOrFail<any>(
      this.db,
      `SELECT r.*,
              p.id AS p_id, p.name AS property_name, p.availability_status, p.lifecycle_status,
              p.owner_id,
              t.id AS t_id, t.name AS tenant_name,
              l.id AS l_id, l.status AS lead_status, l.assigned_to,
              n.status AS negotiation_status
         FROM rentals r
         LEFT JOIN properties p ON p.id = r.property_id
         LEFT JOIN tenants t ON t.id = r.tenant_id
         LEFT JOIN leads l ON l.id = r.lead_id
         LEFT JOIN negotiations n ON n.id = r.negotiation_id
        WHERE r.id = ?`,
      [id],
      'Rental',
      id
    )

    const otherOccupying = await this.occupyingCount(rental.property_id, id)

    // Single domain gate covering §17 checks 1-6 + the state machine.
    assertActivatable({
      property_exists: Boolean(rental.p_id),
      property_availability: rental.availability_status,
      tenant_exists: Boolean(rental.t_id),
      other_occupying_rentals: otherOccupying,
      negotiation_status: rental.negotiation_id ? rental.negotiation_status : null,
      terms: rental,
      current_status: rental.status as RentalStatus
    })

    const nextProperty = availabilityAfterRentalActivated()

    const statements: D1PreparedStatement[] = [
      // 1. Rental becomes ACTIVE. The WHERE clause re-checks the status so a
      //    concurrent activation cannot double-apply the transition.
      this.db
        .prepare(
          `UPDATE rentals
              SET status = 'ACTIVE', activated_at = datetime('now'), updated_at = datetime('now')
            WHERE id = ? AND status IN ('DRAFT','PENDING','CONFIRMED')`
        )
        .bind(id),
      // 2. Property becomes unavailable/rented (§17: mandatory consequence).
      this.db
        .prepare(
          `UPDATE properties
              SET availability_status = ?, lifecycle_status = ?, updated_at = datetime('now')
            WHERE id = ?`
        )
        .bind(nextProperty.availability, nextProperty.lifecycle, rental.property_id),
      auditStmt(this.db, {
        userId: actorId,
        entityType: 'RENTAL',
        entityId: id,
        action: 'RENTAL_ACTIVATED',
        oldValue: {
          status: rental.status,
          property_availability: rental.availability_status,
          lead_status: rental.lead_status ?? null
        },
        newValue: {
          status: 'ACTIVE',
          property_availability: nextProperty.availability,
          lead_status: rental.l_id ? 'WON' : null
        },
        requestId
      }),
      analyticsStmt(this.db, {
        eventType: AnalyticsEvent.RENTAL_ACTIVATED,
        entityType: 'RENTAL',
        entityId: id,
        propertyId: rental.property_id,
        leadId: rental.lead_id,
        value: rental.price,
        metadata: {
          start_date: rental.start_date,
          end_date: rental.end_date,
          payment_period: rental.payment_period
        }
      }),
      auditStmt(this.db, {
        userId: actorId,
        entityType: 'PROPERTY',
        entityId: rental.property_id,
        action: 'PROPERTY_RENTED',
        oldValue: { availability_status: rental.availability_status, lifecycle_status: rental.lifecycle_status },
        newValue: { availability_status: nextProperty.availability, lifecycle_status: nextProperty.lifecycle },
        requestId
      })
    ]

    // 3. Lead conversion — the ONLY path to WON (DR-007).
    if (rental.l_id && rental.lead_status !== 'WON') {
      assertLeadTransition(rental.lead_status, 'WON')
      statements.push(
        this.db
          .prepare(`UPDATE leads SET status = 'WON', updated_at = datetime('now') WHERE id = ?`)
          .bind(rental.l_id),
        // Operational hygiene: no pending work remains on a won lead.
        this.db
          .prepare(
            `UPDATE follow_ups
                SET status = 'CANCELLED', updated_at = datetime('now')
              WHERE lead_id = ? AND status IN ('PENDING','RESCHEDULED')`
          )
          .bind(rental.l_id),
        activityStmt(this.db, {
          leadId: rental.l_id,
          userId: actorId,
          activityType: 'RENTAL',
          subject: `Rental activated — ${rental.property_name} rented to ${rental.tenant_name}`,
          description: `${rental.start_date} → ${rental.end_date} at ${rental.price} / ${rental.payment_period}`,
          metadata: { rental_id: id, price: rental.price }
        }),
        auditStmt(this.db, {
          userId: actorId,
          entityType: 'LEAD',
          entityId: rental.l_id,
          action: 'LEAD_WON',
          oldValue: { status: rental.lead_status },
          newValue: { status: 'WON', rental_id: id },
          requestId
        }),
        analyticsStmt(this.db, {
          eventType: AnalyticsEvent.LEAD_WON,
          entityType: 'LEAD',
          entityId: rental.l_id,
          propertyId: rental.property_id,
          leadId: rental.l_id,
          value: rental.price
        })
      )
    }

    // 4. Tenant becomes an ACTIVE tenant (was PROSPECT).
    statements.push(
      this.db
        .prepare(`UPDATE tenants SET status = 'ACTIVE', updated_at = datetime('now') WHERE id = ?`)
        .bind(rental.tenant_id)
    )

    // 5. Notify stakeholders (owner + lead assignee) — operational awareness.
    const notifyTargets = new Set<string>()
    if (rental.owner_id && rental.owner_id !== actorId) notifyTargets.add(rental.owner_id)
    if (rental.assigned_to && rental.assigned_to !== actorId) notifyTargets.add(rental.assigned_to)
    for (const userId of notifyTargets) {
      statements.push(
        notificationStmt(this.db, {
          userId,
          type: 'RENTAL_ACTIVATED',
          title: 'Rental activated',
          message: `${rental.property_name} is now rented to ${rental.tenant_name} until ${rental.end_date}.`,
          entityType: 'RENTAL',
          entityId: id
        })
      )
    }

    // ONE transaction — all or nothing (§17 activation must be transactional).
    await transaction(this.db, statements)

    // Post-condition assertion: the invariant must hold after the write (§18).
    const occupyingAfter = await this.occupyingCount(rental.property_id)
    if (occupyingAfter > 1) {
      throw new BusinessRuleViolation(
        'Double rental detected after activation.',
        'DR-008',
        { property_id: rental.property_id, occupying: occupyingAfter }
      )
    }

    return this.get(id)
  }

  /**
   * UC: EndRental — releases the property back to the market.
   * Requires an explicit reason (audit §46).
   */
  async end(id: string, input: { reason: string; ended_at?: string }, actorId: string, requestId: string) {
    const rental = await findOneOrFail<any>(
      this.db,
      `SELECT r.*, p.availability_status, p.lifecycle_status, p.name AS property_name, p.owner_id
         FROM rentals r JOIN properties p ON p.id = r.property_id
        WHERE r.id = ?`,
      [id],
      'Rental',
      id
    )
    assertRentalTransition(rental.status as RentalStatus, 'ENDED')
    assertEndReason(input.reason)

    const nextProperty = availabilityAfterRentalEnded()

    await transaction(this.db, [
      this.db
        .prepare(
          `UPDATE rentals
              SET status = 'ENDED', end_reason = ?, ended_at = COALESCE(?, datetime('now')),
                  updated_at = datetime('now')
            WHERE id = ? AND status IN ('ACTIVE','EXPIRING')`
        )
        .bind(input.reason, input.ended_at ?? null, id),
      // Property returns to AVAILABLE per domain rules (§17 end of lifecycle).
      this.db
        .prepare(
          `UPDATE properties
              SET availability_status = ?, lifecycle_status = ?, updated_at = datetime('now')
            WHERE id = ?`
        )
        .bind(nextProperty.availability, nextProperty.lifecycle, rental.property_id),
      auditStmt(this.db, {
        userId: actorId,
        entityType: 'RENTAL',
        entityId: id,
        action: 'RENTAL_ENDED',
        oldValue: { status: rental.status },
        newValue: { status: 'ENDED', end_reason: input.reason },
        requestId
      }),
      auditStmt(this.db, {
        userId: actorId,
        entityType: 'PROPERTY',
        entityId: rental.property_id,
        action: 'PROPERTY_RELEASED',
        oldValue: { availability_status: rental.availability_status, lifecycle_status: rental.lifecycle_status },
        newValue: { availability_status: nextProperty.availability, lifecycle_status: nextProperty.lifecycle },
        requestId
      }),
      analyticsStmt(this.db, {
        eventType: AnalyticsEvent.RENTAL_ENDED,
        entityType: 'RENTAL',
        entityId: id,
        propertyId: rental.property_id,
        leadId: rental.lead_id,
        value: rental.price,
        metadata: { reason: input.reason }
      }),
      ...(rental.lead_id
        ? [
            activityStmt(this.db, {
              leadId: rental.lead_id,
              userId: actorId,
              activityType: 'RENTAL',
              subject: 'Rental ended',
              description: input.reason,
              metadata: { rental_id: id }
            })
          ]
        : []),
      ...(rental.owner_id && rental.owner_id !== actorId
        ? [
            notificationStmt(this.db, {
              userId: rental.owner_id,
              type: 'RENTAL_ENDED',
              title: 'Rental ended',
              message: `${rental.property_name} is available again.`,
              entityType: 'RENTAL',
              entityId: id
            })
          ]
        : [])
    ])

    return this.get(id)
  }

  /**
   * UC: CancelRental — abandons a rental that never became active. The property
   * is released from its RESERVED hold when no other rental occupies it.
   */
  async cancel(id: string, reason: string, actorId: string, requestId: string) {
    const rental = await findOneOrFail<any>(
      this.db,
      `SELECT r.*, p.availability_status, p.lifecycle_status
         FROM rentals r JOIN properties p ON p.id = r.property_id
        WHERE r.id = ?`,
      [id],
      'Rental',
      id
    )
    assertRentalTransition(rental.status as RentalStatus, 'CANCELLED')
    assertEndReason(reason)

    const statements: D1PreparedStatement[] = [
      this.db
        .prepare(
          `UPDATE rentals
              SET status = 'CANCELLED', end_reason = ?, updated_at = datetime('now')
            WHERE id = ? AND status IN ('DRAFT','PENDING','CONFIRMED')`
        )
        .bind(reason, id),
      auditStmt(this.db, {
        userId: actorId,
        entityType: 'RENTAL',
        entityId: id,
        action: 'RENTAL_CANCELLED',
        oldValue: { status: rental.status },
        newValue: { status: 'CANCELLED', reason },
        requestId
      })
    ]

    // Release the reservation only when this rental was the one holding it.
    const otherOccupying = await this.occupyingCount(rental.property_id, id)
    if (rental.status === 'CONFIRMED' && otherOccupying === 0 && rental.availability_status === 'RESERVED') {
      statements.push(
        this.db
          .prepare(
            `UPDATE properties
                SET availability_status = 'AVAILABLE',
                    lifecycle_status = CASE WHEN lifecycle_status = 'RESERVED' THEN 'ACTIVE' ELSE lifecycle_status END,
                    updated_at = datetime('now')
              WHERE id = ?`
          )
          .bind(rental.property_id),
        auditStmt(this.db, {
          userId: actorId,
          entityType: 'PROPERTY',
          entityId: rental.property_id,
          action: 'PROPERTY_RELEASED',
          oldValue: { availability_status: rental.availability_status },
          newValue: { availability_status: 'AVAILABLE' },
          requestId
        })
      )
    }

    if (rental.lead_id) {
      statements.push(
        activityStmt(this.db, {
          leadId: rental.lead_id,
          userId: actorId,
          activityType: 'RENTAL',
          subject: 'Rental cancelled',
          description: reason,
          metadata: { rental_id: id }
        })
      )
    }

    await transaction(this.db, statements)
    return this.get(id)
  }

  /**
   * UC: FlagExpiringRentals — moves ACTIVE rentals inside the expiry window to
   * EXPIRING and notifies owners. Idempotent: safe to call repeatedly.
   */
  async flagExpiring(actorId: string, requestId: string) {
    const due = await findMany<any>(
      this.db,
      `SELECT r.id, r.property_id, r.end_date, p.name AS property_name, p.owner_id
         FROM rentals r JOIN properties p ON p.id = r.property_id
        WHERE r.status = 'ACTIVE'
          AND date(r.end_date) <= date('now', ?)
          AND date(r.end_date) >= date('now')`,
      [`+${EXPIRING_WINDOW_DAYS} days`]
    )
    if (due.length === 0) return { flagged: 0, rentals: [] }

    const statements: D1PreparedStatement[] = []
    for (const r of due) {
      statements.push(
        this.db
          .prepare(`UPDATE rentals SET status = 'EXPIRING', updated_at = datetime('now') WHERE id = ? AND status = 'ACTIVE'`)
          .bind(r.id),
        auditStmt(this.db, {
          userId: actorId,
          entityType: 'RENTAL',
          entityId: r.id,
          action: 'RENTAL_EXPIRING',
          oldValue: { status: 'ACTIVE' },
          newValue: { status: 'EXPIRING', end_date: r.end_date },
          requestId
        })
      )
      if (r.owner_id) {
        statements.push(
          notificationStmt(this.db, {
            userId: r.owner_id,
            type: 'RENTAL_EXPIRING',
            title: 'Rental expiring soon',
            message: `${r.property_name} rental ends on ${r.end_date}. Plan the next tenant now.`,
            entityType: 'RENTAL',
            entityId: r.id
          })
        )
      }
    }

    await transaction(this.db, statements)
    return { flagged: due.length, rentals: due.map((r) => ({ id: r.id, end_date: r.end_date })) }
  }

  /** Rentals of one property — used by the property detail screen (§23). */
  async byProperty(propertyId: string) {
    return findMany(
      this.db,
      `SELECT r.id, r.status, r.price, r.payment_period, r.start_date, r.end_date,
              r.activated_at, r.ended_at, t.name AS tenant_name, t.contact_name
         FROM rentals r JOIN tenants t ON t.id = r.tenant_id
        WHERE r.property_id = ?
        ORDER BY r.created_at DESC`,
      [propertyId]
    )
  }
}
