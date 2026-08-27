/**
 * Rental domain rules — the most critical domain operation in the system.
 * Traceability: PS-MASTER-001 §16, §17, §18 | PS-DATA-009 §30, §31
 *               PS-IMP-011 §18, §19 | DR-007, DR-008
 *
 * PURE domain logic: no HTTP, no DB, no framework imports.
 *
 * Lifecycle: DRAFT → PENDING → CONFIRMED → ACTIVE → EXPIRING → ENDED
 *            (CANCELLED reachable from DRAFT/PENDING/CONFIRMED)
 */
import { BusinessRuleViolation, InvalidStateTransition } from '../../../shared/errors'

export type RentalStatus =
  | 'DRAFT'
  | 'PENDING'
  | 'CONFIRMED'
  | 'ACTIVE'
  | 'EXPIRING'
  | 'ENDED'
  | 'CANCELLED'

export const RENTAL_TRANSITIONS: Record<RentalStatus, readonly RentalStatus[]> = {
  DRAFT: ['PENDING', 'CONFIRMED', 'ACTIVE', 'CANCELLED'],
  PENDING: ['CONFIRMED', 'ACTIVE', 'CANCELLED'],
  CONFIRMED: ['ACTIVE', 'CANCELLED'],
  ACTIVE: ['EXPIRING', 'ENDED'],
  EXPIRING: ['ACTIVE', 'ENDED'],
  ENDED: [],
  CANCELLED: []
}

/** Statuses that occupy the property — at most ONE per property (DR-008). */
export const OCCUPYING_STATUSES: readonly RentalStatus[] = ['CONFIRMED', 'ACTIVE', 'EXPIRING']

export function assertRentalTransition(from: RentalStatus, to: RentalStatus): void {
  const allowed = RENTAL_TRANSITIONS[from] ?? []
  if (!allowed.includes(to)) {
    throw new InvalidStateTransition('Rental', from, to, allowed)
  }
}

export interface RentalTerms {
  start_date: string
  end_date: string
  price: number
  payment_period: string
  deposit?: number | null
}

/** Required commercial terms before a rental can exist (§16). */
export function termsGaps(t: Partial<RentalTerms>): string[] {
  const gaps: string[] = []
  if (!t.start_date) gaps.push('start_date')
  if (!t.end_date) gaps.push('end_date')
  if (t.price === null || t.price === undefined || t.price <= 0) gaps.push('price')
  if (!t.payment_period) gaps.push('payment_period')
  return gaps
}

export function assertTermsComplete(t: Partial<RentalTerms>): void {
  const gaps = termsGaps(t)
  if (gaps.length > 0) {
    throw new BusinessRuleViolation(
      'Rental terms are incomplete.',
      'DR-007',
      { missing: gaps }
    )
  }
  const start = new Date(t.start_date!)
  const end = new Date(t.end_date!)
  if (Number.isNaN(start.getTime()) || Number.isNaN(end.getTime())) {
    throw new BusinessRuleViolation('Rental dates are invalid.', 'DR-007', {
      start_date: t.start_date,
      end_date: t.end_date
    })
  }
  if (end.getTime() <= start.getTime()) {
    throw new BusinessRuleViolation('Rental end date must be after the start date.', 'DR-007', {
      start_date: t.start_date,
      end_date: t.end_date
    })
  }
}

export interface ActivationFacts {
  /** Property must exist and be available. */
  property_exists: boolean
  property_availability: string
  /** Tenant must be valid. */
  tenant_exists: boolean
  /** Count of other occupying rentals for the same property. */
  other_occupying_rentals: number
  /** Negotiation state when the rental originates from one. */
  negotiation_status?: string | null
  /** Rental's own terms. */
  terms: Partial<RentalTerms>
  current_status: RentalStatus
}

/**
 * §17 RENTAL ACTIVATION RULE — validate ALL preconditions before activation:
 *   1. Property exists
 *   2. Property is available
 *   3. Tenant is valid
 *   4. Required rental terms are complete
 *   5. Negotiation is accepted when required
 *   6. Property does not already have an occupying rental (DR-008)
 */
export function assertActivatable(f: ActivationFacts): void {
  if (!f.property_exists) {
    throw new BusinessRuleViolation('Property does not exist.', 'DR-008', { check: 'property_exists' })
  }
  if (!f.tenant_exists) {
    throw new BusinessRuleViolation('Tenant does not exist.', 'DR-007', { check: 'tenant_exists' })
  }

  assertTermsComplete(f.terms)
  assertRentalTransition(f.current_status, 'ACTIVE')

  // 5. When a negotiation is linked, it MUST be agreed (DR-007).
  if (f.negotiation_status && f.negotiation_status !== 'AGREED') {
    throw new BusinessRuleViolation(
      'The linked negotiation must be agreed before the rental can be activated.',
      'DR-007',
      { negotiation_status: f.negotiation_status }
    )
  }

  // 6. DOUBLE RENTAL PROTECTION (§18) — defence in depth alongside the
  //    partial unique index in migration 0006.
  if (f.other_occupying_rentals > 0) {
    throw new BusinessRuleViolation(
      'Property already has an occupying rental.',
      'DR-008',
      { other_occupying_rentals: f.other_occupying_rentals }
    )
  }

  // 2. Property availability — RESERVED is acceptable (reserved for this deal).
  if (!['AVAILABLE', 'RESERVED'].includes(f.property_availability)) {
    throw new BusinessRuleViolation(
      'Property is not available for a new rental.',
      'DR-008',
      { availability_status: f.property_availability }
    )
  }
}

/** Same invariant applied at creation time (fail fast, before activation). */
export function assertCreatable(f: {
  property_availability: string
  other_occupying_rentals: number
  negotiation_status?: string | null
}): void {
  if (f.other_occupying_rentals > 0) {
    throw new BusinessRuleViolation(
      'Property already has an occupying rental.',
      'DR-008',
      { other_occupying_rentals: f.other_occupying_rentals }
    )
  }
  if (f.property_availability === 'RENTED') {
    throw new BusinessRuleViolation(
      'Property is already rented.',
      'DR-008',
      { availability_status: f.property_availability }
    )
  }
  if (f.negotiation_status && !['AGREED'].includes(f.negotiation_status)) {
    throw new BusinessRuleViolation(
      'A rental can only be created from an agreed negotiation.',
      'DR-007',
      { negotiation_status: f.negotiation_status }
    )
  }
}

/** Ending a rental requires an explicit reason (audit trail §46). */
export function assertEndReason(reason?: string | null): void {
  if (!reason || reason.trim().length < 3) {
    throw new BusinessRuleViolation('Ending a rental requires an explicit reason.', 'DR-007', {
      field: 'end_reason'
    })
  }
}

/** Days until expiry; drives the EXPIRING lifecycle stage. */
export function daysUntil(endDate: string, now = new Date()): number {
  const end = new Date(endDate)
  if (Number.isNaN(end.getTime())) return Number.POSITIVE_INFINITY
  return Math.ceil((end.getTime() - now.getTime()) / 86_400_000)
}

/** A rental within this window is considered EXPIRING (§16 lifecycle). */
export const EXPIRING_WINDOW_DAYS = 30

export function shouldFlagExpiring(status: RentalStatus, endDate: string, now = new Date()): boolean {
  if (status !== 'ACTIVE') return false
  const days = daysUntil(endDate, now)
  return days <= EXPIRING_WINDOW_DAYS && days >= 0
}
