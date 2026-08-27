/**
 * Unit tests — Follow-up and Visit domain rules.
 * Traceability: PS-MASTER-001 §12 (follow-up first-class), §14 (visit), §19
 *               (dashboard buckets), §41 | DR-005, DR-009
 */
import { describe, expect, it } from 'vitest'
import {
  assertFollowUpTransition,
  assertFutureSchedule,
  assertLeadOpen,
  assertVisitResult,
  assertVisitTransition,
  assertVisitable,
  bucketFollowUp,
  leadStageAfterVisit
} from '../../src/modules/operations/domain/operations.rules'

describe('follow-up state machine (§12)', () => {
  it('allows completion, reschedule and cancellation from PENDING', () => {
    expect(() => assertFollowUpTransition('PENDING', 'COMPLETED')).not.toThrow()
    expect(() => assertFollowUpTransition('PENDING', 'RESCHEDULED')).not.toThrow()
    expect(() => assertFollowUpTransition('PENDING', 'CANCELLED')).not.toThrow()
  })

  it('does not reopen a completed or cancelled follow-up', () => {
    expect(() => assertFollowUpTransition('COMPLETED', 'PENDING')).toThrow()
    expect(() => assertFollowUpTransition('CANCELLED', 'PENDING')).toThrow()
  })
})

describe('operational work belongs to open leads — DR-009', () => {
  it('allows work on an in-flight lead', () => {
    for (const s of ['NEW', 'CONTACTED', 'QUALIFIED', 'VISITED', 'NEGOTIATION']) {
      expect(() => assertLeadOpen(s, 'Follow-up'), s).not.toThrow()
    }
  })

  it('refuses work on a closed lead', () => {
    expect(() => assertLeadOpen('WON', 'Follow-up')).toThrow(/closed lead/i)
    expect(() => assertLeadOpen('LOST', 'Visit')).toThrow(/closed lead/i)
  })
})

describe('dashboard bucketing (§19 — action required before analytics)', () => {
  const now = new Date('2026-08-27T10:00:00Z')

  it('classifies a past due date as OVERDUE', () => {
    expect(bucketFollowUp('2026-08-25 09:00:00', 'PENDING', now)).toBe('OVERDUE')
  })

  it('classifies today as DUE_TODAY regardless of the hour', () => {
    expect(bucketFollowUp('2026-08-27 08:00:00', 'PENDING', now)).toBe('DUE_TODAY')
    expect(bucketFollowUp('2026-08-27 23:00:00', 'PENDING', now)).toBe('DUE_TODAY')
  })

  it('classifies a future date as UPCOMING', () => {
    expect(bucketFollowUp('2026-08-30 09:00:00', 'PENDING', now)).toBe('UPCOMING')
  })

  it('never nags about resolved work', () => {
    expect(bucketFollowUp('2026-08-01 09:00:00', 'COMPLETED', now)).toBe('DONE')
    expect(bucketFollowUp('2026-08-01 09:00:00', 'CANCELLED', now)).toBe('DONE')
  })

  it('accepts both the D1 "space" format and ISO input', () => {
    expect(bucketFollowUp('2026-08-25 09:00:00', 'PENDING', now)).toBe('OVERDUE')
    expect(bucketFollowUp('2026-08-25T09:00:00Z', 'PENDING', now)).toBe('OVERDUE')
  })
})

describe('visit state machine (§14)', () => {
  it('allows the operational path SCHEDULED → CONFIRMED → COMPLETED', () => {
    expect(() => assertVisitTransition('SCHEDULED', 'CONFIRMED')).not.toThrow()
    expect(() => assertVisitTransition('CONFIRMED', 'COMPLETED')).not.toThrow()
  })

  it('allows a direct completion and the no-show outcome', () => {
    expect(() => assertVisitTransition('SCHEDULED', 'COMPLETED')).not.toThrow()
    expect(() => assertVisitTransition('SCHEDULED', 'NO_SHOW')).not.toThrow()
  })

  it('treats COMPLETED / CANCELLED / NO_SHOW as terminal', () => {
    expect(() => assertVisitTransition('COMPLETED', 'SCHEDULED')).toThrow()
    expect(() => assertVisitTransition('CANCELLED', 'CONFIRMED')).toThrow()
    expect(() => assertVisitTransition('NO_SHOW', 'COMPLETED')).toThrow()
  })
})

describe('visit result and scheduling guards — DR-005', () => {
  it('requires one of the four declared results', () => {
    for (const r of ['STRONG_FIT', 'POTENTIAL', 'WEAK_FIT', 'NO_FIT']) {
      expect(() => assertVisitResult(r), r).not.toThrow()
    }
  })

  it('refuses a missing or invented result', () => {
    expect(() => assertVisitResult(null)).toThrow()
    expect(() => assertVisitResult('')).toThrow()
    expect(() => assertVisitResult('MAYBE')).toThrow()
  })

  it('refuses new visits on a rented property', () => {
    expect(() => assertVisitable('AVAILABLE')).not.toThrow()
    expect(() => assertVisitable('RESERVED')).not.toThrow()
    expect(() => assertVisitable('RENTED')).toThrow(/rented/i)
  })

  it('refuses a schedule in the past but tolerates clock skew', () => {
    const now = new Date('2026-08-27T10:00:00Z')
    expect(() => assertFutureSchedule('2026-08-28T10:00:00Z', now)).not.toThrow()
    expect(() => assertFutureSchedule('2026-08-27T09:58:00Z', now)).not.toThrow() // grace window
    expect(() => assertFutureSchedule('2026-08-20T10:00:00Z', now)).toThrow(/past/i)
    expect(() => assertFutureSchedule('bukan-tanggal', now)).toThrow(/valid date/i)
  })

  it('maps a visit result onto the implied pipeline stage', () => {
    expect(leadStageAfterVisit('STRONG_FIT')).toBe('VISITED')
    expect(leadStageAfterVisit('POTENTIAL')).toBe('VISITED')
    expect(leadStageAfterVisit('WEAK_FIT')).toBe('VISITED')
    expect(leadStageAfterVisit('NO_FIT')).toBe('LOST_CANDIDATE')
  })
})
