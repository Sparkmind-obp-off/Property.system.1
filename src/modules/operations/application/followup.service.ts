/**
 * Follow-Up — application service (use cases).
 * Traceability: PS-IMP-011 §15 | PS-MASTER-001 §12 | PS-DATA-009 §27
 *
 * Use cases: CreateFollowUp, CompleteFollowUp, RescheduleFollowUp,
 *            CancelFollowUp, ListFollowUps, FollowUpWorkQueue
 */
import { AnalyticsEvent, activityStmt, analyticsStmt, auditStmt, notificationStmt } from '../../../shared/audit'
import { ID } from '../../../shared/id'
import { FilterBuilder, count, findMany, findOneOrFail, transaction } from '../../../shared/repository'
import {
  assertFollowUpTransition,
  assertLeadOpen,
  bucketFollowUp,
  type FollowUpStatus
} from '../domain/operations.rules'

export interface FollowUpRow {
  id: string
  lead_id: string
  assigned_to: string | null
  action_type: string
  due_at: string
  status: FollowUpStatus
  notes: string | null
  outcome: string | null
  completed_at: string | null
  created_by: string
  created_at: string
  updated_at: string
}

export class FollowUpService {
  constructor(private readonly db: D1Database) {}

  /** UC: CreateFollowUp — first-class operational task (§12). */
  async create(input: any, actorId: string, requestId: string) {
    const lead = await findOneOrFail<any>(
      this.db,
      `SELECT l.*, t.name AS tenant_name FROM leads l JOIN tenants t ON t.id = l.tenant_id WHERE l.id = ?`,
      [input.lead_id],
      'Lead',
      input.lead_id
    )
    assertLeadOpen(lead.status, 'Creating a follow-up')

    const id = ID.followUp()
    const assignedTo = input.assigned_to ?? lead.assigned_to ?? actorId

    const statements: D1PreparedStatement[] = [
      this.db
        .prepare(
          `INSERT INTO follow_ups (id, lead_id, assigned_to, action_type, due_at, status, notes, created_by)
           VALUES (?, ?, ?, ?, ?, 'PENDING', ?, ?)`
        )
        .bind(id, lead.id, assignedTo, input.action_type, input.due_at, input.notes ?? null, actorId),
      // Denormalized pointer powering the "next action" surfaces (§19 dashboard).
      this.db
        .prepare(
          `UPDATE leads
              SET next_follow_up_at = CASE
                    WHEN next_follow_up_at IS NULL OR next_follow_up_at > ? THEN ?
                    ELSE next_follow_up_at END,
                  updated_at = datetime('now')
            WHERE id = ?`
        )
        .bind(input.due_at, input.due_at, lead.id),
      activityStmt(this.db, {
        leadId: lead.id,
        userId: actorId,
        activityType: 'FOLLOW_UP',
        subject: `Follow-up scheduled: ${input.action_type}`,
        description: input.notes ?? null,
        metadata: { follow_up_id: id, due_at: input.due_at }
      }),
      auditStmt(this.db, {
        userId: actorId,
        entityType: 'FOLLOW_UP',
        entityId: id,
        action: 'FOLLOW_UP_CREATED',
        newValue: { lead_id: lead.id, action_type: input.action_type, due_at: input.due_at },
        requestId
      }),
      analyticsStmt(this.db, {
        eventType: AnalyticsEvent.FOLLOW_UP_CREATED,
        entityType: 'FOLLOW_UP',
        entityId: id,
        propertyId: lead.property_id,
        leadId: lead.id
      })
    ]

    if (assignedTo && assignedTo !== actorId) {
      statements.push(
        notificationStmt(this.db, {
          userId: assignedTo,
          type: 'FOLLOW_UP_ASSIGNED',
          title: 'Follow-up assigned',
          message: `${input.action_type} for ${lead.tenant_name} is due ${input.due_at}.`,
          entityType: 'FOLLOW_UP',
          entityId: id
        })
      )
    }

    await transaction(this.db, statements)
    return this.get(id)
  }

  async get(id: string) {
    const row = await findOneOrFail<any>(
      this.db,
      `SELECT f.*, l.status AS lead_status, l.property_id, t.name AS tenant_name,
              p.name AS property_name, u.name AS assigned_to_name
         FROM follow_ups f
         JOIN leads l ON l.id = f.lead_id
         JOIN tenants t ON t.id = l.tenant_id
         JOIN properties p ON p.id = l.property_id
         LEFT JOIN users u ON u.id = f.assigned_to
        WHERE f.id = ?`,
      [id],
      'Follow-up',
      id
    )
    return { ...row, bucket: bucketFollowUp(row.due_at, row.status) }
  }

  /** UC: ListFollowUps — filtered work list. */
  async list(params: {
    page: number
    limit: number
    offset: number
    status?: string
    assigned_to?: string
    lead_id?: string
    bucket?: string
  }) {
    const f = new FilterBuilder()
      .eq('f.status', params.status)
      .eq('f.assigned_to', params.assigned_to)
      .eq('f.lead_id', params.lead_id)

    if (params.bucket === 'OVERDUE') {
      f.raw(`f.status = 'PENDING' AND date(f.due_at) < date('now')`)
    } else if (params.bucket === 'DUE_TODAY') {
      f.raw(`f.status = 'PENDING' AND date(f.due_at) = date('now')`)
    } else if (params.bucket === 'UPCOMING') {
      f.raw(`f.status = 'PENDING' AND date(f.due_at) > date('now')`)
    }

    const where = f.where()
    const total = await count(
      this.db,
      `SELECT COUNT(*) AS c FROM follow_ups f ${where}`,
      f.values()
    )
    const rows = await findMany<any>(
      this.db,
      `SELECT f.*, l.status AS lead_status, l.score AS lead_score, l.property_id,
              t.name AS tenant_name, t.phone AS tenant_phone,
              p.name AS property_name, u.name AS assigned_to_name
         FROM follow_ups f
         JOIN leads l ON l.id = f.lead_id
         JOIN tenants t ON t.id = l.tenant_id
         JOIN properties p ON p.id = l.property_id
         LEFT JOIN users u ON u.id = f.assigned_to
         ${where}
        ORDER BY f.status = 'PENDING' DESC, f.due_at ASC
        LIMIT ? OFFSET ?`,
      [...f.values(), params.limit, params.offset]
    )
    return {
      rows: rows.map((r) => ({ ...r, bucket: bucketFollowUp(r.due_at, r.status) })),
      total
    }
  }

  /**
   * UC: FollowUpWorkQueue — dashboard action center buckets.
   * "ACTION REQUIRED before GENERAL ANALYTICS" (§19)
   */
  async workQueue(assignedTo?: string) {
    const f = new FilterBuilder().eq('f.assigned_to', assignedTo).raw(`f.status = 'PENDING'`)
    const where = f.where()
    const rows = await findMany<any>(
      this.db,
      `SELECT f.id, f.lead_id, f.action_type, f.due_at, f.notes, f.status,
              l.status AS lead_status, l.score AS lead_score, l.temperature,
              t.name AS tenant_name, t.phone AS tenant_phone, p.name AS property_name
         FROM follow_ups f
         JOIN leads l ON l.id = f.lead_id
         JOIN tenants t ON t.id = l.tenant_id
         JOIN properties p ON p.id = l.property_id
         ${where}
        ORDER BY f.due_at ASC
        LIMIT 200`,
      f.values()
    )
    const withBucket = rows.map((r) => ({ ...r, bucket: bucketFollowUp(r.due_at, r.status) }))
    return {
      overdue: withBucket.filter((r) => r.bucket === 'OVERDUE'),
      due_today: withBucket.filter((r) => r.bucket === 'DUE_TODAY'),
      upcoming: withBucket.filter((r) => r.bucket === 'UPCOMING')
    }
  }

  /** UC: CompleteFollowUp — records the outcome and rebuilds the lead pointer. */
  async complete(id: string, input: { outcome: string; notes?: string }, actorId: string, requestId: string) {
    const fu = await findOneOrFail<FollowUpRow>(
      this.db,
      `SELECT * FROM follow_ups WHERE id = ?`,
      [id],
      'Follow-up',
      id
    )
    assertFollowUpTransition(fu.status, 'COMPLETED')

    await transaction(this.db, [
      this.db
        .prepare(
          `UPDATE follow_ups
              SET status = 'COMPLETED', outcome = ?, notes = COALESCE(?, notes),
                  completed_at = datetime('now'), updated_at = datetime('now')
            WHERE id = ?`
        )
        .bind(input.outcome, input.notes ?? null, id),
      activityStmt(this.db, {
        leadId: fu.lead_id,
        userId: actorId,
        activityType: 'FOLLOW_UP',
        subject: `Follow-up completed: ${fu.action_type}`,
        description: input.outcome,
        metadata: { follow_up_id: id }
      }),
      this.db
        .prepare(
          `UPDATE leads
              SET last_contact_at = datetime('now'),
                  next_follow_up_at = (SELECT MIN(due_at) FROM follow_ups
                                        WHERE lead_id = ? AND status = 'PENDING'),
                  updated_at = datetime('now')
            WHERE id = ?`
        )
        .bind(fu.lead_id, fu.lead_id),
      auditStmt(this.db, {
        userId: actorId,
        entityType: 'FOLLOW_UP',
        entityId: id,
        action: 'FOLLOW_UP_COMPLETED',
        oldValue: { status: fu.status },
        newValue: { status: 'COMPLETED', outcome: input.outcome },
        requestId
      }),
      analyticsStmt(this.db, {
        eventType: AnalyticsEvent.FOLLOW_UP_COMPLETED,
        entityType: 'FOLLOW_UP',
        entityId: id,
        leadId: fu.lead_id
      })
    ])
    return this.get(id)
  }

  /** UC: RescheduleFollowUp — creates the replacement task, closes the old one. */
  async reschedule(id: string, input: { due_at: string; reason?: string }, actorId: string, requestId: string) {
    const fu = await findOneOrFail<FollowUpRow>(
      this.db,
      `SELECT * FROM follow_ups WHERE id = ?`,
      [id],
      'Follow-up',
      id
    )
    assertFollowUpTransition(fu.status, 'RESCHEDULED')

    const newId = ID.followUp()
    await transaction(this.db, [
      this.db
        .prepare(
          `UPDATE follow_ups SET status = 'RESCHEDULED', outcome = ?, updated_at = datetime('now') WHERE id = ?`
        )
        .bind(input.reason ?? 'Rescheduled', id),
      this.db
        .prepare(
          `INSERT INTO follow_ups (id, lead_id, assigned_to, action_type, due_at, status, notes, created_by)
           VALUES (?, ?, ?, ?, ?, 'PENDING', ?, ?)`
        )
        .bind(newId, fu.lead_id, fu.assigned_to, fu.action_type, input.due_at, fu.notes, actorId),
      activityStmt(this.db, {
        leadId: fu.lead_id,
        userId: actorId,
        activityType: 'FOLLOW_UP',
        subject: `Follow-up rescheduled to ${input.due_at}`,
        description: input.reason ?? null,
        metadata: { from: id, to: newId }
      }),
      this.db
        .prepare(
          `UPDATE leads
              SET next_follow_up_at = (SELECT MIN(due_at) FROM follow_ups WHERE lead_id = ? AND status = 'PENDING'),
                  updated_at = datetime('now')
            WHERE id = ?`
        )
        .bind(fu.lead_id, fu.lead_id),
      auditStmt(this.db, {
        userId: actorId,
        entityType: 'FOLLOW_UP',
        entityId: id,
        action: 'FOLLOW_UP_RESCHEDULED',
        oldValue: { due_at: fu.due_at },
        newValue: { due_at: input.due_at, replacement_id: newId },
        requestId
      })
    ])
    return this.get(newId)
  }

  /** UC: CancelFollowUp */
  async cancel(id: string, reason: string | undefined, actorId: string, requestId: string) {
    const fu = await findOneOrFail<FollowUpRow>(
      this.db,
      `SELECT * FROM follow_ups WHERE id = ?`,
      [id],
      'Follow-up',
      id
    )
    assertFollowUpTransition(fu.status, 'CANCELLED')

    await transaction(this.db, [
      this.db
        .prepare(
          `UPDATE follow_ups SET status = 'CANCELLED', outcome = ?, updated_at = datetime('now') WHERE id = ?`
        )
        .bind(reason ?? 'Cancelled', id),
      activityStmt(this.db, {
        leadId: fu.lead_id,
        userId: actorId,
        activityType: 'FOLLOW_UP',
        subject: 'Follow-up cancelled',
        description: reason ?? null,
        metadata: { follow_up_id: id }
      }),
      this.db
        .prepare(
          `UPDATE leads
              SET next_follow_up_at = (SELECT MIN(due_at) FROM follow_ups WHERE lead_id = ? AND status = 'PENDING'),
                  updated_at = datetime('now')
            WHERE id = ?`
        )
        .bind(fu.lead_id, fu.lead_id),
      auditStmt(this.db, {
        userId: actorId,
        entityType: 'FOLLOW_UP',
        entityId: id,
        action: 'FOLLOW_UP_CANCELLED',
        oldValue: { status: fu.status },
        newValue: { status: 'CANCELLED', reason: reason ?? null },
        requestId
      })
    ])
    return this.get(id)
  }
}
