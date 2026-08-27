/**
 * Unit tests — Property domain rules.
 * Traceability: PS-MASTER-001 §5 (property lifecycle), §41 (testing focus:
 *               business rules + state transitions) | DR-001, DR-002, DR-008
 */
import { describe, expect, it } from 'vitest'
import {
  assertLifecycleTransition,
  assertMarketable,
  assertRentable,
  assertVerifiable,
  availabilityAfterRentalActivated,
  availabilityAfterRentalEnded,
  computeAreaSize,
  verificationGaps
} from '../../src/modules/property/domain/property.rules'
import { ErrorCode } from '../../src/shared/errors'

const complete = {
  name: 'Ruko Kota Lama',
  property_type: 'RUKO',
  address: 'Jl. Kota Lama No. 12',
  price: 3_500_000,
  price_period: 'MONTH',
  width: 3,
  length: 6,
  area_size: null,
  description: 'Ruko strategis'
}

describe('property lifecycle state machine (§5)', () => {
  it('permits declared transitions', () => {
    expect(() => assertLifecycleTransition('DRAFT', 'PENDING_VERIFICATION')).not.toThrow()
    expect(() => assertLifecycleTransition('VERIFIED', 'ACTIVE')).not.toThrow()
    expect(() => assertLifecycleTransition('ACTIVE', 'MARKETED')).not.toThrow()
    expect(() => assertLifecycleTransition('RESERVED', 'RENTED')).not.toThrow()
  })

  it('rejects an undeclared transition with a machine-readable code', () => {
    try {
      assertLifecycleTransition('DRAFT', 'RENTED')
      throw new Error('expected a transition violation')
    } catch (e: any) {
      expect(e.code).toBe(ErrorCode.INVALID_STATE_TRANSITION)
      expect(e.details.allowed).toContain('PENDING_VERIFICATION')
    }
  })

  it('treats RENTED and INACTIVE as non-arbitrary exits', () => {
    expect(() => assertLifecycleTransition('RENTED', 'RESERVED')).toThrow()
    expect(() => assertLifecycleTransition('RENTED', 'ACTIVE')).not.toThrow()
  })
})

describe('verification completeness — DR-001', () => {
  it('reports no gaps for a complete property', () => {
    expect(verificationGaps(complete)).toEqual([])
    expect(() => assertVerifiable(complete)).not.toThrow()
  })

  it('names every missing requirement instead of failing opaquely', () => {
    const gaps = verificationGaps({ name: 'X' })
    expect(gaps).toContain('property_type')
    expect(gaps).toContain('address')
    expect(gaps).toContain('price')
    expect(gaps).toContain('price_period')
    expect(gaps).toContain('width+length or area_size')
  })

  it('rejects a non-positive price', () => {
    expect(verificationGaps({ ...complete, price: 0 })).toContain('price')
  })

  it('accepts area_size alone as the size signal', () => {
    const gaps = verificationGaps({ ...complete, width: null, length: null, area_size: 18 })
    expect(gaps).toEqual([])
  })

  it('raises BUSINESS_RULE_VIOLATION carrying the gap list', () => {
    try {
      assertVerifiable({ name: 'Only a name' })
      throw new Error('expected verification to fail')
    } catch (e: any) {
      expect(e.code).toBe(ErrorCode.BUSINESS_RULE_VIOLATION)
      expect(e.details.missing.length).toBeGreaterThan(0)
    }
  })
})

describe('marketability — DR-002', () => {
  it('allows marketing a verified, available property', () => {
    expect(() => assertMarketable('VERIFIED', 'AVAILABLE')).not.toThrow()
    expect(() => assertMarketable('ACTIVE', 'AVAILABLE')).not.toThrow()
  })

  it('blocks marketing an unverified property', () => {
    expect(() => assertMarketable('DRAFT', 'AVAILABLE')).toThrow(/verified/i)
  })

  it('blocks marketing an occupied property', () => {
    expect(() => assertMarketable('ACTIVE', 'RENTED')).toThrow(/rented/i)
  })
})

describe('rentability — DR-008', () => {
  it('accepts AVAILABLE and RESERVED', () => {
    expect(() => assertRentable('AVAILABLE')).not.toThrow()
    expect(() => assertRentable('RESERVED')).not.toThrow()
  })

  it('refuses a property that is already rented or unavailable', () => {
    expect(() => assertRentable('RENTED')).toThrow()
    expect(() => assertRentable('UNAVAILABLE')).toThrow()
  })
})

describe('derived area and rental side effects', () => {
  it('prefers width × length over an explicit area', () => {
    expect(computeAreaSize(3, 6, 99)).toBe(18)
  })

  it('falls back to the explicit area when dimensions are absent', () => {
    expect(computeAreaSize(null, null, 24)).toBe(24)
    expect(computeAreaSize(null, null, null)).toBeNull()
  })

  it('marks the property occupied on activation and free on end (§17)', () => {
    expect(availabilityAfterRentalActivated()).toEqual({ availability: 'RENTED', lifecycle: 'RENTED' })
    expect(availabilityAfterRentalEnded()).toEqual({ availability: 'AVAILABLE', lifecycle: 'ACTIVE' })
  })
})
