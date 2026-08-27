/**
 * Audit, analytics event and activity-timeline writers.
 * Traceability: PS-DATA-009 §32, §33 | PS-TECH-008 §23 | DR-010 / BR-010
 *
 * Every critical mutation MUST produce an audit event. These helpers return
 * prepared D1 statements so they can join the SAME transactional batch as the
 * business mutation (PS-IMP-011 §32 transaction boundary).
 */
import { ID } from './id'

export interface AuditInput {
  userId?: string | null
  entityType: string
  entityId: string
  action: string
  oldValue?: unknown
  newValue?: unknown
  requestId?: string
  ipReference?: string | null
}

export function auditStmt(db: D1Database, i: AuditInput): D1PreparedStatement {
  return db
    .prepare(
      `INSERT INTO audit_logs
         (id, user_id, entity_type, entity_id, action, old_value, new_value, ip_reference, request_id)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)`
    )
    .bind(
      ID.audit(),
      i.userId ?? null,
      i.entityType,
      i.entityId,
      i.action,
      i.oldValue === undefined ? null : JSON.stringify(i.oldValue),
      i.newValue === undefined ? null : JSON.stringify(i.newValue),
      i.ipReference ?? null,
      i.requestId ?? null
    )
}

/** Analytics event contract (PS-DATA-009 §63). */
export const AnalyticsEvent = {
  PROPERTY_CREATED: 'PROPERTY_CREATED',
  PROPERTY_VERIFIED: 'PROPERTY_VERIFIED',
  PROPERTY_MARKETED: 'PROPERTY_MARKETED',
  PROPERTY_ANALYZED: 'PROPERTY_ANALYZED',
  OFFER_CREATED: 'OFFER_CREATED',
  OFFER_PUBLISHED: 'OFFER_PUBLISHED',
  CAMPAIGN_STARTED: 'CAMPAIGN_STARTED',
  LEAD_CREATED: 'LEAD_CREATED',
  LEAD_CONTACTED: 'LEAD_CONTACTED',
  LEAD_QUALIFIED: 'LEAD_QUALIFIED',
  LEAD_LOST: 'LEAD_LOST',
  LEAD_WON: 'LEAD_WON',
  FOLLOW_UP_CREATED: 'FOLLOW_UP_CREATED',
  FOLLOW_UP_COMPLETED: 'FOLLOW_UP_COMPLETED',
  VISIT_SCHEDULED: 'VISIT_SCHEDULED',
  VISIT_COMPLETED: 'VISIT_COMPLETED',
  NEGOTIATION_STARTED: 'NEGOTIATION_STARTED',
  NEGOTIATION_AGREED: 'NEGOTIATION_AGREED',
  NEGOTIATION_FAILED: 'NEGOTIATION_FAILED',
  MATCH_EXECUTED: 'MATCH_EXECUTED',
  RENTAL_CREATED: 'RENTAL_CREATED',
  RENTAL_ACTIVATED: 'RENTAL_ACTIVATED',
  RENTAL_ENDED: 'RENTAL_ENDED'
} as const

export type AnalyticsEventType = (typeof AnalyticsEvent)[keyof typeof AnalyticsEvent]

export interface AnalyticsInput {
  eventType: AnalyticsEventType
  entityType: string
  entityId: string
  propertyId?: string | null
  leadId?: string | null
  campaignId?: string | null
  value?: number | null
  metadata?: Record<string, unknown>
}

export function analyticsStmt(db: D1Database, i: AnalyticsInput): D1PreparedStatement {
  return db
    .prepare(
      `INSERT INTO analytics_records
         (id, event_type, entity_type, entity_id, property_id, lead_id, campaign_id, value, metadata)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)`
    )
    .bind(
      ID.analytics(),
      i.eventType,
      i.entityType,
      i.entityId,
      i.propertyId ?? null,
      i.leadId ?? null,
      i.campaignId ?? null,
      i.value ?? null,
      JSON.stringify(i.metadata ?? {})
    )
}

export interface ActivityInput {
  leadId: string
  userId?: string | null
  activityType: string
  subject: string
  description?: string | null
  metadata?: Record<string, unknown>
  occurredAt?: string
}

/** Activity timeline = operational memory (PS-MASTER-001 §13). */
export function activityStmt(db: D1Database, i: ActivityInput): D1PreparedStatement {
  return db
    .prepare(
      `INSERT INTO activities
         (id, lead_id, user_id, activity_type, subject, description, occurred_at, metadata)
       VALUES (?, ?, ?, ?, ?, ?, COALESCE(?, datetime('now')), ?)`
    )
    .bind(
      ID.activity(),
      i.leadId,
      i.userId ?? null,
      i.activityType,
      i.subject,
      i.description ?? null,
      i.occurredAt ?? null,
      JSON.stringify(i.metadata ?? {})
    )
}

export interface NotificationInput {
  userId: string
  type: string
  title: string
  message: string
  entityType?: string
  entityId?: string
}

export function notificationStmt(db: D1Database, i: NotificationInput): D1PreparedStatement {
  return db
    .prepare(
      `INSERT INTO notifications (id, user_id, type, title, message, entity_type, entity_id)
       VALUES (?, ?, ?, ?, ?, ?, ?)`
    )
    .bind(
      ID.notification(),
      i.userId,
      i.type,
      i.title,
      i.message,
      i.entityType ?? null,
      i.entityId ?? null
    )
}
