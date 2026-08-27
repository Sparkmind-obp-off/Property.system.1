/**
 * Follow-Up + Visit domain rules.
 * Traceability: PS-MASTER-001 §12, §14 | PS-DATA-009 §27, §28 | DR-005
 *
 * PURE domain logic: no HTTP, no DB, no framework imports.
 */
import { BusinessRuleViolation, InvalidStateTransition } from '../../../shared/errors'

/* -------------------------------- Follow-up -------------------------------- */

export type FollowUpStatus = 'PENDING' | 'COMPLETED' | 'CANCELLED' | 'RESCHEDULED'

export const FOLLOW_UP_TRANSITIONS: Record<FollowUpStatus, readonly FollowUpStatus[]> = {
  PENDING: ['COMPLETED', 'CANCELLED', 'RESCHEDULED'],
  RESCHEDULED: ['COMPLETED', 'CANCELLED', 'RESCHEDULED'],
  COMPLETED: [],
  CANCELLED: []
}

export function assertFollowUpTransition(from: FollowUpStatus, to: FollowUpStatus): void {
  const allowed = FOLLOW_UP_TRANSITIONS[from] ?? []
  if (!allowed.includes(to)) {
    throw new InvalidStateTransition('Follow-up', from, to, allowed)
  }
}

/** Follow-ups belong to open leads only — closed leads need no operational work. */
export function assertLeadOpen(leadStatus: string, operation: string): void {
  if (['WON', 'LOST'].includes(leadStatus)) {
    throw new BusinessRuleViolation(
      `${operation} is not allowed on a closed lead.`,
      'DR-009',
      { lead_status: leadStatus }
    )
  }
}

export type FollowUpBucket = 'OVERDUE' | 'DUE_TODAY' | 'UPCOMING' | 'DONE'

/**
 * Dashboard bucketing (§12: dashboard must surface OVERDUE / DUE TODAY / UPCOMING).
 * All comparisons are date-only in UTC to match the D1 `datetime('now')` format.
 */
export function bucketFollowUp(dueAt: string, status: FollowUpStatus, now = new Date()): FollowUpBucket {
  if (status === 'COMPLETED' || status === 'CANCELLED') return 'DONE'
  const due = new Date(dueAt.replace(' ', 'T') + (dueAt.includes('Z') ? '' : 'Z'))
  const today = new Date(Date.UTC(now.getUTCFullYear(), now.getUTCMonth(), now.getUTCDate()))
  const dueDay = new Date(Date.UTC(due.getUTCFullYear(), due.getUTCMonth(), due.getUTCDate()))
  if (dueDay.getTime() < today.getTime()) return 'OVERDUE'
  if (dueDay.getTime() === today.getTime()) return 'DUE_TODAY'
  return 'UPCOMING'
}

/* ---------------------------------- Visit ---------------------------------- */

export type VisitStatus = 'SCHEDULED' | 'CONFIRMED' | 'COMPLETED' | 'CANCELLED' | 'NO_SHOW'
export type VisitResult = 'STRONG_FIT' | 'POTENTIAL' | 'WEAK_FIT' | 'NO_FIT'

export const VISIT_TRANSITIONS: Record<VisitStatus, readonly VisitStatus[]> = {
  SCHEDULED: ['CONFIRMED', 'COMPLETED', 'CANCELLED', 'NO_SHOW'],
  CONFIRMED: ['COMPLETED', 'CANCELLED', 'NO_SHOW'],
  COMPLETED: [],
  CANCELLED: [],
  NO_SHOW: []
}

export function assertVisitTransition(from: VisitStatus, to: VisitStatus): void {
  const allowed = VISIT_TRANSITIONS[from] ?? []
  if (!allowed.includes(to)) {
    throw new InvalidStateTransition('Visit', from, to, allowed)
  }
}

/** DR-005 — completing a visit requires an explicit result. */
export function assertVisitResult(result?: string | null): void {
  const valid: VisitResult[] = ['STRONG_FIT', 'POTENTIAL', 'WEAK_FIT', 'NO_FIT']
  if (!result || !valid.includes(result as VisitResult)) {
    throw new BusinessRuleViolation(
      'Completing a visit requires an explicit result.',
      'DR-005',
      { field: 'result', allowed: valid }
    )
  }
}

/**
 * DR-005 — a visit may only be scheduled on a property that is still
 * commercially viewable (not already rented out).
 */
export function assertVisitable(availability: string): void {
  if (availability === 'RENTED') {
    throw new BusinessRuleViolation(
      'A rented property cannot receive new visits.',
      'DR-005',
      { availability_status: availability }
    )
  }
}

/** Visits must be scheduled in the future (operational sanity). */
export function assertFutureSchedule(scheduledAt: string, now = new Date()): void {
  const when = new Date(scheduledAt)
  if (Number.isNaN(when.getTime())) {
    throw new BusinessRuleViolation('Visit schedule is not a valid date.', 'DR-005', {
      field: 'scheduled_at'
    })
  }
  // Allow a 5-minute grace window for clock skew / immediate walk-ins.
  if (when.getTime() < now.getTime() - 5 * 60 * 1000) {
    throw new BusinessRuleViolation('A visit cannot be scheduled in the past.', 'DR-005', {
      field: 'scheduled_at',
      scheduled_at: scheduledAt
    })
  }
}

/** Lead stage implied by a completed visit result (feeds the pipeline). */
export function leadStageAfterVisit(result: VisitResult): 'VISITED' | 'LOST_CANDIDATE' {
  return result === 'NO_FIT' ? 'LOST_CANDIDATE' : 'VISITED'
}
