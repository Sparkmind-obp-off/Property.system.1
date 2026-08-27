/**
 * Visit — application service (use cases).
 * Traceability: PS-IMP-011 §16 | PS-MASTER-001 §14 | PS-DATA-009 §28 | DR-005
 *
 * Use cases: ScheduleVisit, ConfirmVisit, CompleteVisit, RescheduleVisit,
 *            CancelVisit, MarkNoShow, ListVisits
 */
import { AnalyticsEvent, activityStmt, analyticsStmt, auditStmt, notificationStmt } from '../../../shared/audit'
import { ID } from '../../../shared/id'
import { FilterBuilder, count, findMany, findOneOrFail, transaction } from '../../../shared/repository'
import { assertLeadTransition } from '../../lead/domain/lead.rules'
import {
  assertFutureSchedule,
  assertLeadOpen,
  assertVisitResult,
  assertVisitTransition,
  assertVisitable,
  type VisitResult,
  type VisitStatus
} from '../domain/operations.rules'

export interface VisitRow {
  id: string
  property_id: string
  lead_id: string
  scheduled_by: string
  scheduled_at: string
  status: VisitStatus
  result: VisitResult | null
  notes: string | null
  completed_at: string | null
  created_at: string
  updated_at: string
}

export class VisitService {
  constructor(private readonly db: D1Database) {}

  /**
   * UC: ScheduleVisit — DR-005: a visit MUST relate to property + lead, and
   * advances the pipeline to VISIT_SCHEDULED.
   */
  async schedule(input: any, actorId: string, requestId: string) {
    const lead = await findOneOrFail<any>(
      this.db,
      `SELECT l.*, t.name AS tenant_name, p.availability_status, p.name AS property_name
         FROM leads l
         JOIN tenants t ON t.id = l.tenant_id
         JOIN properties p ON p.id = l.property_id
        WHERE l.id = ?`,
      [input.lead_id],
      'Lead',
      input.lead_id
    )
    assertLeadOpen(lead.status, 'Scheduling a visit')
    assertVisitable(lead.availability_status)
    assertFutureSchedule(input.scheduled_at)

    // Pipeline: a scheduled visit implies the lead reached VISIT_SCHEDULED.
    let nextStatus = lead.status
    if (lead.status !== 'VISIT_SCHEDULED') {
      assertLeadTransition(lead.status, 'VISIT_SCHEDULED')
      nextStatus = 'VISIT_SCHEDULED'
    }

    const id = ID.visit()
    await transaction(this.db, [
      this.db
        .prepare(
          `INSERT INTO visits (id, property_id, lead_id, scheduled_by, scheduled_at, status, notes)
           VALUES (?, ?, ?, ?, ?, 'SCHEDULED', ?)`
        )
        .bind(id, lead.property_id, lead.id, actorId, input.scheduled_at, input.notes ?? null),
      this.db
        .prepare(`UPDATE leads SET status = ?, updated_at = datetime('now') WHERE id = ?`)
        .bind(nextStatus, lead.id),
      activityStmt(this.db, {
        leadId: lead.id,
        userId: actorId,
        activityType: 'VISIT',
        subject: `Visit scheduled for ${input.scheduled_at}`,
        description: input.notes ?? null,
        metadata: { visit_id: id }
      }),
      auditStmt(this.db, {
        userId: actorId,
        entityType: 'VISIT',
        entityId: id,
        action: 'VISIT_SCHEDULED',
        newValue: { lead_id: lead.id, property_id: lead.property_id, scheduled_at: input.scheduled_at },
        requestId
      }),
      analyticsStmt(this.db, {
        eventType: AnalyticsEvent.VISIT_SCHEDULED,
        entityType: 'VISIT',
        entityId: id,
        propertyId: lead.property_id,
        leadId: lead.id
      }),
      ...(lead.assigned_to && lead.assigned_to !== actorId
        ? [
            notificationStmt(this.db, {
              userId: lead.assigned_to,
              type: 'VISIT_SCHEDULED',
              title: 'Visit scheduled',
              message: `${lead.tenant_name} will visit ${lead.property_name} on ${input.scheduled_at}.`,
              entityType: 'VISIT',
              entityId: id
            })
          ]
        : [])
    ])

    return this.get(id)
  }

  async get(id: string) {
    return findOneOrFail<any>(
      this.db,
      `SELECT v.*, l.status AS lead_status, l.score AS lead_score,
              t.id AS tenant_id, t.name AS tenant_name, t.phone AS tenant_phone,
              p.name AS property_name, p.address AS property_address,
              u.name AS scheduled_by_name
         FROM visits v
         JOIN leads l ON l.id = v.lead_id
         JOIN tenants t ON t.id = l.tenant_id
         JOIN properties p ON p.id = v.property_id
         LEFT JOIN users u ON u.id = v.scheduled_by
        WHERE v.id = ?`,
      [id],
      'Visit',
      id
    )
  }

  async list(params: {
    page: number
    limit: number
    offset: number
    status?: string
    property_id?: string
    lead_id?: string
    scope?: string
  }) {
    const f = new FilterBuilder()
      .eq('v.status', params.status)
      .eq('v.property_id', params.property_id)
      .eq('v.lead_id', params.lead_id)

    if (params.scope === 'TODAY') f.raw(`date(v.scheduled_at) = date('now')`)
    else if (params.scope === 'UPCOMING') {
      f.raw(`v.status IN ('SCHEDULED','CONFIRMED') AND datetime(v.scheduled_at) >= datetime('now')`)
    } else if (params.scope === 'NEEDS_RESULT') {
      f.raw(`v.status IN ('SCHEDULED','CONFIRMED') AND datetime(v.scheduled_at) < datetime('now')`)
    }

    const where = f.where()
    const total = await count(this.db, `SELECT COUNT(*) AS c FROM visits v ${where}`, f.values())
    const rows = await findMany(
      this.db,
      `SELECT v.*, l.status AS lead_status, t.name AS tenant_name, t.phone AS tenant_phone,
              p.name AS property_name, p.address AS property_address
         FROM visits v
         JOIN leads l ON l.id = v.lead_id
         JOIN tenants t ON t.id = l.tenant_id
         JOIN properties p ON p.id = v.property_id
         ${where}
        ORDER BY v.scheduled_at DESC
        LIMIT ? OFFSET ?`,
      [...f.values(), params.limit, params.offset]
    )
    return { rows, total }
  }

  /** UC: ConfirmVisit */
  async confirm(id: string, actorId: string, requestId: string) {
    const visit = await findOneOrFail<VisitRow>(this.db, `SELECT * FROM visits WHERE id = ?`, [id], 'Visit', id)
    assertVisitTransition(visit.status, 'CONFIRMED')

    await transaction(this.db, [
      this.db
        .prepare(`UPDATE visits SET status = 'CONFIRMED', updated_at = datetime('now') WHERE id = ?`)
        .bind(id),
      activityStmt(this.db, {
        leadId: visit.lead_id,
        userId: actorId,
        activityType: 'VISIT',
        subject: 'Visit confirmed by tenant',
        metadata: { visit_id: id }
      }),
      auditStmt(this.db, {
        userId: actorId,
        entityType: 'VISIT',
        entityId: id,
        action: 'VISIT_CONFIRMED',
        oldValue: { status: visit.status },
        newValue: { status: 'CONFIRMED' },
        requestId
      })
    ])
    return this.get(id)
  }

  /**
   * UC: CompleteVisit — DR-005 requires an explicit result. A NO_FIT result
   * does NOT auto-lose the lead: losing requires an explicit human decision
   * with a reason (DR-004).
   */
  async complete(id: string, input: { result: string; notes?: string }, actorId: string, requestId: string) {
    const visit = await findOneOrFail<any>(
      this.db,
      `SELECT v.*, l.status AS lead_status FROM visits v JOIN leads l ON l.id = v.lead_id WHERE v.id = ?`,
      [id],
      'Visit',
      id
    )
    assertVisitTransition(visit.status, 'COMPLETED')
    assertVisitResult(input.result)

    let nextLeadStatus = visit.lead_status
    if (!['WON', 'LOST', 'VISITED', 'NEGOTIATION'].includes(visit.lead_status)) {
      assertLeadTransition(visit.lead_status, 'VISITED')
      nextLeadStatus = 'VISITED'
    }

    await transaction(this.db, [
      this.db
        .prepare(
          `UPDATE visits
              SET status = 'COMPLETED', result = ?, notes = COALESCE(?, notes),
                  completed_at = datetime('now'), updated_at = datetime('now')
            WHERE id = ?`
        )
        .bind(input.result, input.notes ?? null, id),
      this.db
        .prepare(`UPDATE leads SET status = ?, updated_at = datetime('now') WHERE id = ?`)
        .bind(nextLeadStatus, visit.lead_id),
      activityStmt(this.db, {
        leadId: visit.lead_id,
        userId: actorId,
        activityType: 'VISIT',
        subject: `Visit completed — result: ${input.result}`,
        description: input.notes ?? null,
        metadata: { visit_id: id, result: input.result }
      }),
      auditStmt(this.db, {
        userId: actorId,
        entityType: 'VISIT',
        entityId: id,
        action: 'VISIT_COMPLETED',
        oldValue: { status: visit.status },
        newValue: { status: 'COMPLETED', result: input.result },
        requestId
      }),
      analyticsStmt(this.db, {
        eventType: AnalyticsEvent.VISIT_COMPLETED,
        entityType: 'VISIT',
        entityId: id,
        propertyId: visit.property_id,
        leadId: visit.lead_id,
        metadata: { result: input.result }
      })
    ])

    // Visit outcome changes the lead score materially — recompute it.
    const { LeadService } = await import('../../lead/application/lead.service')
    const svc = new LeadService(this.db)
    const breakdown = await svc.scoreBreakdown(visit.lead_id)
    await transaction(this.db, [
      this.db
        .prepare(`UPDATE leads SET score = ?, temperature = ?, updated_at = datetime('now') WHERE id = ?`)
        .bind(breakdown.score, breakdown.temperature, visit.lead_id)
    ])

    return this.get(id)
  }

  /** UC: RescheduleVisit */
  async reschedule(id: string, input: { scheduled_at: string; reason?: string }, actorId: string, requestId: string) {
    const visit = await findOneOrFail<VisitRow>(this.db, `SELECT * FROM visits WHERE id = ?`, [id], 'Visit', id)
    if (!['SCHEDULED', 'CONFIRMED'].includes(visit.status)) {
      assertVisitTransition(visit.status, 'SCHEDULED') // throws with the allowed set
    }
    assertFutureSchedule(input.scheduled_at)

    await transaction(this.db, [
      this.db
        .prepare(
          `UPDATE visits SET scheduled_at = ?, status = 'SCHEDULED', updated_at = datetime('now') WHERE id = ?`
        )
        .bind(input.scheduled_at, id),
      activityStmt(this.db, {
        leadId: visit.lead_id,
        userId: actorId,
        activityType: 'VISIT',
        subject: `Visit rescheduled to ${input.scheduled_at}`,
        description: input.reason ?? null,
        metadata: { visit_id: id, previous: visit.scheduled_at }
      }),
      auditStmt(this.db, {
        userId: actorId,
        entityType: 'VISIT',
        entityId: id,
        action: 'VISIT_RESCHEDULED',
        oldValue: { scheduled_at: visit.scheduled_at },
        newValue: { scheduled_at: input.scheduled_at },
        requestId
      })
    ])
    return this.get(id)
  }

  /** UC: CancelVisit / MarkNoShow */
  async close(id: string, to: 'CANCELLED' | 'NO_SHOW', reason: string | undefined, actorId: string, requestId: string) {
    const visit = await findOneOrFail<VisitRow>(this.db, `SELECT * FROM visits WHERE id = ?`, [id], 'Visit', id)
    assertVisitTransition(visit.status, to)

    await transaction(this.db, [
      this.db
        .prepare(
          `UPDATE visits SET status = ?, notes = COALESCE(?, notes), updated_at = datetime('now') WHERE id = ?`
        )
        .bind(to, reason ?? null, id),
      activityStmt(this.db, {
        leadId: visit.lead_id,
        userId: actorId,
        activityType: 'VISIT',
        subject: to === 'CANCELLED' ? 'Visit cancelled' : 'Tenant did not show up',
        description: reason ?? null,
        metadata: { visit_id: id }
      }),
      auditStmt(this.db, {
        userId: actorId,
        entityType: 'VISIT',
        entityId: id,
        action: to === 'CANCELLED' ? 'VISIT_CANCELLED' : 'VISIT_NO_SHOW',
        oldValue: { status: visit.status },
        newValue: { status: to, reason: reason ?? null },
        requestId
      })
    ])
    return this.get(id)
  }
}
