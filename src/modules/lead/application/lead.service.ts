/**
 * Lead — application service (use cases).
 * Traceability: PS-IMP-011 §13, §14 | PS-MASTER-001 §10, §11, §24
 *               PS-DATA-009 §22–§25 | DR-003, DR-004, DR-009
 *
 * Use cases: CreateLead, GetLead, ListLeads, PipelineView, ContactLead,
 *            QualifyLead, AssignLead, ChangeLeadStatus, LoseLead, RecordActivity
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
  parseJson,
  transaction
} from '../../../shared/repository'
import { computeFit } from '../../matching/domain/fit-engine'
import {
  PIPELINE_STAGES,
  assertLeadContext,
  assertLeadTransition,
  assertLostReason,
  computeLeadScore,
  evaluateQualification,
  type LeadStatus
} from '../domain/lead.rules'

const SORTABLE = ['created_at', 'score', 'updated_at', 'status', 'last_contact_at'] as const

export interface LeadRow {
  id: string
  property_id: string
  tenant_id: string
  offer_id: string | null
  campaign_id: string | null
  source: string
  status: LeadStatus
  score: number
  temperature: string
  lost_reason: string | null
  assigned_to: string | null
  first_contact_at: string | null
  last_contact_at: string | null
  next_follow_up_at: string | null
  created_at: string
  updated_at: string
}

export class LeadService {
  constructor(private readonly db: D1Database) {}

  static get sortable() {
    return SORTABLE
  }

  /* ------------------------------ score model ----------------------------- */

  /**
   * Recompute the lead score from persisted facts. Score is DERIVED, never
   * client-supplied (§54 — business truth belongs to the domain).
   */
  private async scoreFacts(leadId: string) {
    const lead = await findOneOrFail<LeadRow>(
      this.db,
      `SELECT * FROM leads WHERE id = ?`,
      [leadId],
      'Lead',
      leadId
    )
    const match = await findOne<{ fit_score: number }>(
      this.db,
      `SELECT fit_score FROM tenant_property_matches
        WHERE property_id = ? AND tenant_id = ?
        ORDER BY created_at DESC LIMIT 1`,
      [lead.property_id, lead.tenant_id]
    )
    const qualification = await findOne<{ qualification_result: any; fit_score: number }>(
      this.db,
      `SELECT qualification_result, fit_score FROM lead_qualifications
        WHERE lead_id = ? ORDER BY qualified_at DESC LIMIT 1`,
      [leadId]
    )
    const engagement = await count(
      this.db,
      `SELECT COUNT(*) AS c FROM activities WHERE lead_id = ? AND activity_type IN ('CALL','MESSAGE','EMAIL','FOLLOW_UP')`,
      [leadId]
    )
    const visit = await findOne<{ result: any }>(
      this.db,
      `SELECT result FROM visits WHERE lead_id = ? AND status = 'COMPLETED' AND result IS NOT NULL
        ORDER BY completed_at DESC LIMIT 1`,
      [leadId]
    )

    return {
      lead,
      facts: {
        fit_score: match?.fit_score ?? qualification?.fit_score ?? null,
        qualification_result: qualification?.qualification_result ?? null,
        status: lead.status,
        engagement_count: engagement,
        responded: ['RESPONDED', 'QUALIFIED', 'INTERESTED', 'VISIT_SCHEDULED', 'VISITED', 'NEGOTIATION', 'WON'].includes(
          lead.status
        ),
        visit_result: visit?.result ?? null
      }
    }
  }

  /** Returns the statements that persist a recomputed score (joins a batch). */
  private async rescoreStatements(leadId: string): Promise<D1PreparedStatement[]> {
    const { facts } = await this.scoreFacts(leadId)
    const scored = computeLeadScore(facts)
    return [
      this.db
        .prepare(`UPDATE leads SET score = ?, temperature = ?, updated_at = datetime('now') WHERE id = ?`)
        .bind(scored.score, scored.temperature, leadId)
    ]
  }

  /** Public: explainable score breakdown for the Lead detail screen. */
  async scoreBreakdown(leadId: string) {
    const { facts } = await this.scoreFacts(leadId)
    return { ...computeLeadScore(facts), inputs: facts }
  }

  /* -------------------------------- use cases ----------------------------- */

  /** UC: CreateLead — DR-003 requires property + tenant context. */
  async create(input: any, actorId: string, requestId: string) {
    assertLeadContext(input.property_id, input.tenant_id)

    const property = await findOneOrFail<any>(
      this.db,
      `SELECT id, name, price, price_period, area_size, property_type, lifecycle_status,
              availability_status, market_area_id
         FROM properties WHERE id = ?`,
      [input.property_id],
      'Property',
      input.property_id
    )
    const tenant = await findOneOrFail<any>(
      this.db,
      `SELECT * FROM tenants WHERE id = ?`,
      [input.tenant_id],
      'Tenant',
      input.tenant_id
    )

    // A lead against an already-occupied property is commercially meaningless.
    if (property.availability_status === 'RENTED') {
      throw new BusinessRuleViolation(
        'Property is already rented — a new lead cannot be created for it.',
        'DR-003',
        { property_id: property.id, availability_status: property.availability_status }
      )
    }

    if (input.offer_id) {
      await findOneOrFail(
        this.db,
        `SELECT id FROM offers WHERE id = ? AND property_id = ?`,
        [input.offer_id, property.id],
        'Offer',
        input.offer_id
      )
    }
    if (input.campaign_id) {
      await findOneOrFail(this.db, `SELECT id FROM campaigns WHERE id = ?`, [input.campaign_id], 'Campaign', input.campaign_id)
    }

    // Duplicate guard: one open lead per tenant × property (§56 idempotency).
    const existingOpen = await findOne<{ id: string }>(
      this.db,
      `SELECT id FROM leads WHERE property_id = ? AND tenant_id = ? AND status NOT IN ('WON','LOST')`,
      [property.id, tenant.id]
    )
    if (existingOpen) {
      throw new BusinessRuleViolation(
        'An open lead already exists for this tenant and property.',
        'DR-003',
        { existing_lead_id: existingOpen.id }
      )
    }

    const id = ID.lead()
    const assignedTo = input.assigned_to ?? actorId

    // Initial score uses property↔tenant fit as decision support.
    const analysis = await findOne<any>(
      this.db,
      `SELECT access_score, visibility_score, location_score, space_score, recommended_uses
         FROM property_analyses WHERE property_id = ? ORDER BY created_at DESC LIMIT 1`,
      [property.id]
    )
    const fit = computeFit(
      {
        id: property.id,
        property_type: property.property_type,
        price: property.price,
        price_period: property.price_period,
        area_size: property.area_size,
        width: null,
        length: null,
        access_score: analysis?.access_score ?? null,
        visibility_score: analysis?.visibility_score ?? null,
        location_score: analysis?.location_score ?? null,
        space_score: analysis?.space_score ?? null,
        recommended_uses: parseJson<string[]>(analysis?.recommended_uses, [])
      },
      {
        business_category: tenant.business_category,
        budget_min: tenant.budget_min,
        budget_max: tenant.budget_max,
        space_need: tenant.space_need,
        location_preference: tenant.location_preference
      }
    )
    const scored = computeLeadScore({ fit_score: fit.fit_score, status: 'NEW' })

    await transaction(this.db, [
      this.db
        .prepare(
          `INSERT INTO leads
             (id, property_id, tenant_id, offer_id, campaign_id, source, status, score, temperature, assigned_to)
           VALUES (?, ?, ?, ?, ?, ?, 'NEW', ?, ?, ?)`
        )
        .bind(
          id,
          property.id,
          tenant.id,
          input.offer_id ?? null,
          input.campaign_id ?? null,
          input.source ?? 'INBOUND',
          scored.score,
          scored.temperature,
          assignedTo
        ),
      activityStmt(this.db, {
        leadId: id,
        userId: actorId,
        activityType: 'STATUS_CHANGE',
        subject: 'Lead created',
        description: `Lead created for ${tenant.name} on ${property.name} (source: ${input.source ?? 'INBOUND'})`,
        metadata: { fit_score: fit.fit_score, score: scored.score }
      }),
      auditStmt(this.db, {
        userId: actorId,
        entityType: 'LEAD',
        entityId: id,
        action: 'LEAD_CREATED',
        newValue: { property_id: property.id, tenant_id: tenant.id, status: 'NEW', score: scored.score },
        requestId
      }),
      analyticsStmt(this.db, {
        eventType: AnalyticsEvent.LEAD_CREATED,
        entityType: 'LEAD',
        entityId: id,
        propertyId: property.id,
        leadId: id,
        campaignId: input.campaign_id ?? null,
        value: scored.score
      })
    ])

    return this.get(id)
  }

  /** UC: GetLead — full operational context incl. timeline (§13, §24). */
  async get(id: string) {
    const lead = await findOneOrFail<any>(
      this.db,
      `SELECT l.*,
              t.name AS tenant_name, t.business_category, t.phone AS tenant_phone,
              t.email AS tenant_email, t.budget_min, t.budget_max, t.space_need,
              p.name AS property_name, p.address AS property_address, p.price AS property_price,
              p.price_period AS property_price_period, p.area_size AS property_area_size,
              p.availability_status AS property_availability,
              o.title AS offer_title, cmp.name AS campaign_name,
              u.name AS assigned_to_name
         FROM leads l
         JOIN tenants t ON t.id = l.tenant_id
         JOIN properties p ON p.id = l.property_id
         LEFT JOIN offers o ON o.id = l.offer_id
         LEFT JOIN campaigns cmp ON cmp.id = l.campaign_id
         LEFT JOIN users u ON u.id = l.assigned_to
        WHERE l.id = ?`,
      [id],
      'Lead',
      id
    )

    const qualification = await findOne<any>(
      this.db,
      `SELECT q.*, u.name AS qualified_by_name
         FROM lead_qualifications q LEFT JOIN users u ON u.id = q.qualified_by
        WHERE q.lead_id = ? ORDER BY q.qualified_at DESC LIMIT 1`,
      [id]
    )

    const timeline = await findMany<any>(
      this.db,
      `SELECT a.id, a.activity_type, a.subject, a.description, a.occurred_at, a.metadata,
              u.name AS user_name
         FROM activities a LEFT JOIN users u ON u.id = a.user_id
        WHERE a.lead_id = ? ORDER BY a.occurred_at DESC, a.created_at DESC LIMIT 100`,
      [id]
    )

    const followUps = await findMany<any>(
      this.db,
      `SELECT f.*, u.name AS assigned_to_name
         FROM follow_ups f LEFT JOIN users u ON u.id = f.assigned_to
        WHERE f.lead_id = ? ORDER BY f.due_at ASC`,
      [id]
    )

    const visits = await findMany<any>(
      this.db,
      `SELECT id, scheduled_at, status, result, notes, completed_at
         FROM visits WHERE lead_id = ? ORDER BY scheduled_at DESC`,
      [id]
    )

    const negotiations = await findMany<any>(
      this.db,
      `SELECT id, current_price, proposed_price, agreed_price, status, started_at, agreed_at
         FROM negotiations WHERE lead_id = ? ORDER BY created_at DESC`,
      [id]
    )

    const rental = await findOne<any>(
      this.db,
      `SELECT id, status, start_date, end_date, price, payment_period, activated_at
         FROM rentals WHERE lead_id = ? ORDER BY created_at DESC LIMIT 1`,
      [id]
    )

    const scoreDetail = await this.scoreBreakdown(id)

    return {
      ...lead,
      qualification: qualification
        ? { ...qualification, reasoning: parseJson<string[]>(qualification.reasoning, []) }
        : null,
      score_breakdown: scoreDetail,
      timeline: timeline.map((t) => ({ ...t, metadata: parseJson<Record<string, unknown>>(t.metadata, {}) })),
      follow_ups: followUps,
      visits,
      negotiations,
      rental: rental ?? null,
      allowed_transitions: [...(await this.allowedTransitions(lead.status))],
      next_action: nextAction(lead.status, followUps, visits, negotiations, qualification)
    }
  }

  private async allowedTransitions(status: LeadStatus) {
    const { LEAD_TRANSITIONS } = await import('../domain/lead.rules')
    return LEAD_TRANSITIONS[status] ?? []
  }

  /** UC: ListLeads — paginated + filtered. */
  async list(params: {
    page: number
    limit: number
    offset: number
    orderBy: string
    search?: string
    status?: string
    temperature?: string
    property_id?: string
    tenant_id?: string
    assigned_to?: string
    source?: string
  }) {
    const f = new FilterBuilder()
      .like(['t.name', 'p.name'], params.search)
      .eq('l.status', params.status)
      .eq('l.temperature', params.temperature)
      .eq('l.property_id', params.property_id)
      .eq('l.tenant_id', params.tenant_id)
      .eq('l.assigned_to', params.assigned_to)
      .eq('l.source', params.source)

    const where = f.where()
    const total = await count(
      this.db,
      `SELECT COUNT(*) AS c FROM leads l JOIN tenants t ON t.id = l.tenant_id JOIN properties p ON p.id = l.property_id ${where}`,
      f.values()
    )
    const rows = await findMany(
      this.db,
      `SELECT l.*, t.name AS tenant_name, t.business_category, t.phone AS tenant_phone,
              p.name AS property_name, u.name AS assigned_to_name,
              (SELECT COUNT(*) FROM follow_ups fu WHERE fu.lead_id = l.id AND fu.status = 'PENDING') AS pending_follow_ups
         FROM leads l
         JOIN tenants t ON t.id = l.tenant_id
         JOIN properties p ON p.id = l.property_id
         LEFT JOIN users u ON u.id = l.assigned_to
         ${where}
        ORDER BY l.${params.orderBy}
        LIMIT ? OFFSET ?`,
      [...f.values(), params.limit, params.offset]
    )
    return { rows, total }
  }

  /** UC: PipelineView — kanban board grouped by stage (§24). */
  async pipeline(params: { property_id?: string; assigned_to?: string; limitPerStage?: number }) {
    const limit = params.limitPerStage ?? 50
    const f = new FilterBuilder().eq('l.property_id', params.property_id).eq('l.assigned_to', params.assigned_to)
    const where = f.where()

    const rows = await findMany<any>(
      this.db,
      `SELECT l.id, l.status, l.score, l.temperature, l.source, l.created_at, l.next_follow_up_at,
              t.name AS tenant_name, t.business_category, p.name AS property_name,
              u.name AS assigned_to_name
         FROM leads l
         JOIN tenants t ON t.id = l.tenant_id
         JOIN properties p ON p.id = l.property_id
         LEFT JOIN users u ON u.id = l.assigned_to
         ${where}
        ORDER BY l.score DESC, l.created_at DESC`,
      f.values()
    )

    const stages = PIPELINE_STAGES.map((stage) => {
      const items = rows.filter((r) => r.status === stage)
      return { stage, count: items.length, leads: items.slice(0, limit) }
    })
    return { stages, total: rows.length }
  }

  /** UC: ContactLead — NEW → CONTACTED with an activity record. */
  async contact(id: string, input: { channel: string; notes?: string }, actorId: string, requestId: string) {
    const lead = await findOneOrFail<LeadRow>(this.db, `SELECT * FROM leads WHERE id = ?`, [id], 'Lead', id)
    assertLeadTransition(lead.status, lead.status === 'NEW' ? 'CONTACTED' : lead.status)

    const nextStatus: LeadStatus = lead.status === 'NEW' ? 'CONTACTED' : lead.status

    await transaction(this.db, [
      this.db
        .prepare(
          `UPDATE leads
              SET status = ?,
                  first_contact_at = COALESCE(first_contact_at, datetime('now')),
                  last_contact_at = datetime('now'),
                  updated_at = datetime('now')
            WHERE id = ?`
        )
        .bind(nextStatus, id),
      activityStmt(this.db, {
        leadId: id,
        userId: actorId,
        activityType: input.channel === 'CALL' ? 'CALL' : input.channel === 'EMAIL' ? 'EMAIL' : 'MESSAGE',
        subject: `Contacted via ${input.channel}`,
        description: input.notes ?? null,
        metadata: { channel: input.channel }
      }),
      auditStmt(this.db, {
        userId: actorId,
        entityType: 'LEAD',
        entityId: id,
        action: 'LEAD_CONTACTED',
        oldValue: { status: lead.status },
        newValue: { status: nextStatus },
        requestId
      }),
      analyticsStmt(this.db, {
        eventType: AnalyticsEvent.LEAD_CONTACTED,
        entityType: 'LEAD',
        entityId: id,
        propertyId: lead.property_id,
        leadId: id
      })
    ])

    await transaction(this.db, await this.rescoreStatements(id))
    return this.get(id)
  }

  /** UC: RecordActivity — free-form timeline entry (§13). */
  async recordActivity(id: string, input: any, actorId: string, requestId: string) {
    const lead = await findOneOrFail<LeadRow>(this.db, `SELECT * FROM leads WHERE id = ?`, [id], 'Lead', id)

    const statements: D1PreparedStatement[] = [
      activityStmt(this.db, {
        leadId: id,
        userId: actorId,
        activityType: input.activity_type,
        subject: input.subject,
        description: input.description ?? null,
        occurredAt: input.occurred_at ?? undefined,
        metadata: {}
      }),
      auditStmt(this.db, {
        userId: actorId,
        entityType: 'LEAD',
        entityId: id,
        action: 'ACTIVITY_RECORDED',
        newValue: { activity_type: input.activity_type, subject: input.subject },
        requestId
      })
    ]

    // A tenant response is a domain-meaningful signal: CONTACTED → RESPONDED.
    if (input.tenant_responded && lead.status === 'CONTACTED') {
      assertLeadTransition(lead.status, 'RESPONDED')
      statements.push(
        this.db
          .prepare(
            `UPDATE leads SET status = 'RESPONDED', last_contact_at = datetime('now'),
                    updated_at = datetime('now') WHERE id = ?`
          )
          .bind(id)
      )
    } else if (['CALL', 'MESSAGE', 'EMAIL'].includes(input.activity_type)) {
      statements.push(
        this.db
          .prepare(`UPDATE leads SET last_contact_at = datetime('now'), updated_at = datetime('now') WHERE id = ?`)
          .bind(id)
      )
    }

    await transaction(this.db, statements)
    await transaction(this.db, await this.rescoreStatements(id))
    return this.get(id)
  }

  /**
   * UC: QualifyLead — explicit endpoint (§33). Evaluates budget/timeline/space/
   * business type/property fit/readiness/intent and stores an explainable result.
   */
  async qualify(id: string, input: any, actorId: string, requestId: string) {
    const lead = await findOneOrFail<LeadRow>(this.db, `SELECT * FROM leads WHERE id = ?`, [id], 'Lead', id)
    if (['WON', 'LOST'].includes(lead.status)) {
      throw new BusinessRuleViolation('A closed lead cannot be qualified.', 'DR-009', { status: lead.status })
    }

    const property = await findOneOrFail<any>(
      this.db,
      `SELECT p.*, a.recommended_uses
         FROM properties p
         LEFT JOIN property_analyses a
           ON a.id = (SELECT id FROM property_analyses WHERE property_id = p.id ORDER BY created_at DESC LIMIT 1)
        WHERE p.id = ?`,
      [lead.property_id],
      'Property',
      lead.property_id
    )

    const evaluation = evaluateQualification({
      budget: input.budget,
      timeline: input.timeline,
      space_need: input.space_need ?? null,
      business_type: input.business_type,
      location_need: input.location_need ?? null,
      decision_status: input.decision_status ?? null,
      property_price: property.price,
      property_price_period: property.price_period,
      property_area_size: property.area_size,
      property_type: property.property_type,
      recommended_uses: parseJson<string[]>(property.recommended_uses, [])
    })

    // QUALIFIED result advances the pipeline; a poor result keeps the stage but
    // records the evaluation (traceability over silent discard).
    const advance = evaluation.qualification_result === 'QUALIFIED'
    let nextStatus: LeadStatus = lead.status
    if (advance && lead.status !== 'QUALIFIED') {
      assertLeadTransition(lead.status, 'QUALIFIED')
      nextStatus = 'QUALIFIED'
    }

    const qualificationId = ID.qualification()
    const statements: D1PreparedStatement[] = [
      this.db
        .prepare(
          `INSERT INTO lead_qualifications
             (id, lead_id, business_type, budget, timeline, space_need, location_need, intended_use,
              decision_status, fit_score, qualification_result, reasoning, notes, qualified_by)
           VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`
        )
        .bind(
          qualificationId,
          id,
          input.business_type,
          input.budget,
          input.timeline,
          input.space_need ?? null,
          input.location_need ?? null,
          input.intended_use ?? null,
          input.decision_status ?? 'UNKNOWN',
          evaluation.fit_score,
          evaluation.qualification_result,
          JSON.stringify(evaluation.reasoning),
          input.notes ?? null,
          actorId
        ),
      this.db
        .prepare(`UPDATE leads SET status = ?, updated_at = datetime('now') WHERE id = ?`)
        .bind(nextStatus, id),
      activityStmt(this.db, {
        leadId: id,
        userId: actorId,
        activityType: 'QUALIFICATION',
        subject: `Qualification: ${evaluation.qualification_result} (${evaluation.fit_score}%)`,
        description: evaluation.reasoning.join(' | '),
        metadata: { fit_score: evaluation.fit_score, blockers: evaluation.blockers }
      }),
      auditStmt(this.db, {
        userId: actorId,
        entityType: 'LEAD',
        entityId: id,
        action: 'LEAD_QUALIFIED',
        oldValue: { status: lead.status },
        newValue: {
          status: nextStatus,
          qualification_result: evaluation.qualification_result,
          fit_score: evaluation.fit_score
        },
        requestId
      }),
      analyticsStmt(this.db, {
        eventType: AnalyticsEvent.LEAD_QUALIFIED,
        entityType: 'LEAD',
        entityId: id,
        propertyId: lead.property_id,
        leadId: id,
        value: evaluation.fit_score,
        metadata: { result: evaluation.qualification_result }
      })
    ]

    await transaction(this.db, statements)
    await transaction(this.db, await this.rescoreStatements(id))
    return this.get(id)
  }

  /** UC: AssignLead — ownership + notification. */
  async assign(id: string, userId: string, actorId: string, requestId: string) {
    const lead = await findOneOrFail<LeadRow>(this.db, `SELECT * FROM leads WHERE id = ?`, [id], 'Lead', id)
    const user = await findOneOrFail<any>(
      this.db,
      `SELECT id, name FROM users WHERE id = ? AND status = 'ACTIVE'`,
      [userId],
      'User',
      userId
    )

    await transaction(this.db, [
      this.db
        .prepare(`UPDATE leads SET assigned_to = ?, updated_at = datetime('now') WHERE id = ?`)
        .bind(user.id, id),
      activityStmt(this.db, {
        leadId: id,
        userId: actorId,
        activityType: 'NOTE',
        subject: `Lead assigned to ${user.name}`,
        metadata: { assigned_to: user.id }
      }),
      notificationStmt(this.db, {
        userId: user.id,
        type: 'LEAD_ASSIGNED',
        title: 'New lead assigned',
        message: 'A lead has been assigned to you.',
        entityType: 'LEAD',
        entityId: id
      }),
      auditStmt(this.db, {
        userId: actorId,
        entityType: 'LEAD',
        entityId: id,
        action: 'LEAD_ASSIGNED',
        oldValue: { assigned_to: lead.assigned_to },
        newValue: { assigned_to: user.id },
        requestId
      })
    ])
    return this.get(id)
  }

  /**
   * UC: ChangeLeadStatus — guarded generic transition for stages without a
   * dedicated domain operation (e.g. RESPONDED → INTERESTED).
   * WON is NOT reachable here: only rental activation may win a lead (DR-007).
   */
  async changeStatus(id: string, to: LeadStatus, reason: string | undefined, actorId: string, requestId: string) {
    const lead = await findOneOrFail<LeadRow>(this.db, `SELECT * FROM leads WHERE id = ?`, [id], 'Lead', id)

    if (to === 'WON') {
      throw new BusinessRuleViolation(
        'A lead becomes WON only through rental activation.',
        'DR-007',
        { lead_id: id }
      )
    }
    assertLeadTransition(lead.status, to)
    if (to === 'LOST') assertLostReason(reason)

    const statements: D1PreparedStatement[] = [
      this.db
        .prepare(
          `UPDATE leads SET status = ?, lost_reason = ?, updated_at = datetime('now') WHERE id = ?`
        )
        .bind(to, to === 'LOST' ? reason! : lead.lost_reason, id),
      activityStmt(this.db, {
        leadId: id,
        userId: actorId,
        activityType: 'STATUS_CHANGE',
        subject: `Status changed: ${lead.status} → ${to}`,
        description: reason ?? null,
        metadata: { from: lead.status, to }
      }),
      auditStmt(this.db, {
        userId: actorId,
        entityType: 'LEAD',
        entityId: id,
        action: to === 'LOST' ? 'LEAD_LOST' : 'LEAD_STATUS_CHANGED',
        oldValue: { status: lead.status },
        newValue: { status: to, lost_reason: reason ?? null },
        requestId
      })
    ]

    if (to === 'LOST') {
      statements.push(
        analyticsStmt(this.db, {
          eventType: AnalyticsEvent.LEAD_LOST,
          entityType: 'LEAD',
          entityId: id,
          propertyId: lead.property_id,
          leadId: id,
          metadata: { reason }
        }),
        // Cancel outstanding operational work on a lost lead.
        this.db
          .prepare(
            `UPDATE follow_ups SET status = 'CANCELLED', updated_at = datetime('now')
              WHERE lead_id = ? AND status = 'PENDING'`
          )
          .bind(id),
        this.db
          .prepare(
            `UPDATE visits SET status = 'CANCELLED', updated_at = datetime('now')
              WHERE lead_id = ? AND status IN ('SCHEDULED','CONFIRMED')`
          )
          .bind(id)
      )
    }

    await transaction(this.db, statements)
    if (to !== 'LOST') await transaction(this.db, await this.rescoreStatements(id))
    return this.get(id)
  }
}

/**
 * Compute the single most important next action for a lead.
 * "The next action must always be obvious." (§24)
 */
function nextAction(
  status: LeadStatus,
  followUps: any[],
  visits: any[],
  negotiations: any[],
  qualification: any
): { action: string; label: string; reason: string } {
  const pendingFollowUp = followUps.find((f) => f.status === 'PENDING')
  const openVisit = visits.find((v) => ['SCHEDULED', 'CONFIRMED'].includes(v.status))
  const openNegotiation = negotiations.find((n) => ['OPEN', 'COUNTER_OFFER'].includes(n.status))
  const agreedNegotiation = negotiations.find((n) => n.status === 'AGREED')

  switch (status) {
    case 'NEW':
      return { action: 'CONTACT_LEAD', label: 'Contact this lead', reason: 'Lead has never been contacted' }
    case 'CONTACTED':
      return pendingFollowUp
        ? { action: 'COMPLETE_FOLLOW_UP', label: 'Complete the follow-up', reason: 'A follow-up is pending' }
        : { action: 'CREATE_FOLLOW_UP', label: 'Schedule a follow-up', reason: 'Awaiting tenant response' }
    case 'RESPONDED':
      return { action: 'QUALIFY_LEAD', label: 'Qualify this lead', reason: 'Tenant responded but is not qualified yet' }
    case 'QUALIFIED':
    case 'INTERESTED':
      return openVisit
        ? { action: 'COMPLETE_VISIT', label: 'Complete the visit', reason: 'A visit is scheduled' }
        : { action: 'SCHEDULE_VISIT', label: 'Schedule a visit', reason: 'Qualified lead should see the property' }
    case 'VISIT_SCHEDULED':
      return { action: 'COMPLETE_VISIT', label: 'Record the visit result', reason: 'Visit is scheduled' }
    case 'VISITED':
      return { action: 'CREATE_NEGOTIATION', label: 'Start negotiation', reason: 'Visit completed — discuss terms' }
    case 'NEGOTIATION':
      if (agreedNegotiation) {
        return { action: 'ACTIVATE_RENTAL', label: 'Create & activate rental', reason: 'Negotiation agreed' }
      }
      return openNegotiation
        ? { action: 'RESPOND_NEGOTIATION', label: 'Respond to the negotiation', reason: 'Negotiation is open' }
        : { action: 'CREATE_NEGOTIATION', label: 'Start negotiation', reason: 'Lead is in the negotiation stage' }
    case 'WON':
      return { action: 'VIEW_RENTAL', label: 'View the rental', reason: 'Lead converted into a rental' }
    case 'LOST':
      return { action: 'NONE', label: 'No action required', reason: 'Lead is closed as lost' }
    default:
      return { action: 'NONE', label: 'No action required', reason: 'Unknown stage' }
  }
}
