/**
 * Property domain — state machine and business rules.
 * Traceability: PS-TECH-008 §17 (property state machine), §20, BR-001
 *               PS-DATA-009 §12, DR-001, DR-002, DR-008
 *               PS-IMP-011 §8, §19
 *
 * PURE domain logic: no HTTP, no DB, no framework imports.
 */
import { BusinessRuleViolation, InvalidStateTransition } from '../../../shared/errors'

export type Lifecycle =
  | 'DRAFT'
  | 'PENDING_VERIFICATION'
  | 'VERIFIED'
  | 'ACTIVE'
  | 'MARKETED'
  | 'RESERVED'
  | 'RENTED'
  | 'INACTIVE'

export type Availability = 'AVAILABLE' | 'RESERVED' | 'RENTED' | 'UNAVAILABLE'

/**
 * Allowed lifecycle transitions. Lifecycle and availability are deliberately
 * separate fields with different semantics (PS-DATA-009 §12).
 */
export const LIFECYCLE_TRANSITIONS: Record<Lifecycle, readonly Lifecycle[]> = {
  DRAFT: ['PENDING_VERIFICATION', 'VERIFIED', 'INACTIVE'],
  PENDING_VERIFICATION: ['VERIFIED', 'DRAFT', 'INACTIVE'],
  // A VERIFIED property may be put on the market directly: marketing implies
  // activation, so VERIFIED → MARKETED is a legitimate single business step
  // (DR-002 / assertMarketable already treats VERIFIED as marketable).
  VERIFIED: ['ACTIVE', 'MARKETED', 'DRAFT', 'INACTIVE'],
  ACTIVE: ['MARKETED', 'RESERVED', 'RENTED', 'INACTIVE'],
  MARKETED: ['ACTIVE', 'RESERVED', 'RENTED', 'INACTIVE'],
  RESERVED: ['RENTED', 'MARKETED', 'ACTIVE', 'INACTIVE'],
  RENTED: ['ACTIVE', 'MARKETED', 'INACTIVE'],
  INACTIVE: ['DRAFT', 'ACTIVE']
}

export function assertLifecycleTransition(from: Lifecycle, to: Lifecycle): void {
  const allowed = LIFECYCLE_TRANSITIONS[from] ?? []
  if (!allowed.includes(to)) {
    throw new InvalidStateTransition('Property', from, to, allowed)
  }
}

export interface PropertyCore {
  name?: string | null
  property_type?: string | null
  address?: string | null
  price?: number | null
  price_period?: string | null
  width?: number | null
  length?: number | null
  area_size?: number | null
  description?: string | null
}

/**
 * DR-001 / BR-001 — required data before a property may become VERIFIED.
 * Returns the list of missing requirements (empty = complete).
 */
export function verificationGaps(p: PropertyCore): string[] {
  const gaps: string[] = []
  if (!p.name) gaps.push('name')
  if (!p.property_type) gaps.push('property_type')
  if (!p.address) gaps.push('address')
  if (p.price === null || p.price === undefined || p.price <= 0) gaps.push('price')
  if (!p.price_period) gaps.push('price_period')
  const hasSize = (p.width && p.length) || p.area_size
  if (!hasSize) gaps.push('width+length or area_size')
  return gaps
}

export function assertVerifiable(p: PropertyCore): void {
  const gaps = verificationGaps(p)
  if (gaps.length > 0) {
    throw new BusinessRuleViolation(
      'Property is missing required information and cannot be verified.',
      'DR-001',
      { missing: gaps }
    )
  }
}

/**
 * DR-002 / BR-001 — a property may only be marketed once verified/active and
 * while it is not occupied.
 */
export function assertMarketable(lifecycle: Lifecycle, availability: Availability): void {
  if (!['VERIFIED', 'ACTIVE', 'MARKETED'].includes(lifecycle)) {
    throw new BusinessRuleViolation(
      'Property must be verified before it can be marketed.',
      'DR-002',
      { lifecycle_status: lifecycle }
    )
  }
  if (availability === 'RENTED') {
    throw new BusinessRuleViolation(
      'A rented property cannot be marketed as available.',
      'DR-002',
      { availability_status: availability }
    )
  }
}

/**
 * DR-008 — a property that is not available must not accept a new rental.
 */
export function assertRentable(availability: Availability): void {
  if (availability !== 'AVAILABLE' && availability !== 'RESERVED') {
    throw new BusinessRuleViolation(
      'Property is not available for a new rental.',
      'DR-008',
      { availability_status: availability }
    )
  }
}

/** Derived area: width × length wins when both present, else explicit area_size. */
export function computeAreaSize(width?: number | null, length?: number | null, areaSize?: number | null) {
  if (width && length) return Number((width * length).toFixed(2))
  return areaSize ?? null
}

/**
 * Availability transition when a rental becomes ACTIVE / ENDS
 * (PS-IMP-011 §19 — server-authoritative).
 */
export function availabilityAfterRentalActivated(): { availability: Availability; lifecycle: Lifecycle } {
  return { availability: 'RENTED', lifecycle: 'RENTED' }
}

export function availabilityAfterRentalEnded(): { availability: Availability; lifecycle: Lifecycle } {
  return { availability: 'AVAILABLE', lifecycle: 'ACTIVE' }
}
