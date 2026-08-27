/**
 * Unit tests — Rental lifecycle, activation rule and double-rental protection.
 * This is the most critical domain area in the system.
 * Traceability: PS-MASTER-001 §16, §17, §18, §41 | DR-007, DR-008
 */
import { describe, expect, it } from 'vitest'
import {
  assertActivatable,
  assertCreatable,
  assertEndReason,
  assertRentalTransition,
  assertTermsComplete,
  daysUntil,
  EXPIRING_WINDOW_DAYS,
  OCCUPYING_STATUSES,
  shouldFlagExpiring,
  termsGaps,
  type ActivationFacts
} from '../../src/modules/rental/domain/rental.rules'
import { ErrorCode } from '../../src/shared/errors'

const terms = {
  start_date: '2026-09-01',
  end_date: '2027-08-31',
  price: 3_500_000,
  payment_period: 'MONTH',
  deposit: 3_500_000
}

const facts: ActivationFacts = {
  property_exists: true,
  property_availability: 'AVAILABLE',
  tenant_exists: true,
  other_occupying_rentals: 0,
  negotiation_status: 'AGREED',
  terms,
  current_status: 'DRAFT'
}

describe('rental lifecycle (§16)', () => {
  it('permits DRAFT → PENDING → CONFIRMED → ACTIVE → EXPIRING → ENDED', () => {
    const path = [
      ['DRAFT', 'PENDING'],
      ['PENDING', 'CONFIRMED'],
      ['CONFIRMED', 'ACTIVE'],
      ['ACTIVE', 'EXPIRING'],
      ['EXPIRING', 'ENDED']
    ] as const
    for (const [from, to] of path) {
      expect(() => assertRentalTransition(from, to), `${from}→${to}`).not.toThrow()
    }
  })

  it('never resurrects an ENDED or CANCELLED rental', () => {
    expect(() => assertRentalTransition('ENDED', 'ACTIVE')).toThrow()
    expect(() => assertRentalTransition('CANCELLED', 'ACTIVE')).toThrow()
  })

  it('cannot cancel an active rental — it must be ended', () => {
    expect(() => assertRentalTransition('ACTIVE', 'CANCELLED')).toThrow()
    expect(() => assertRentalTransition('ACTIVE', 'ENDED')).not.toThrow()
  })

  it('declares exactly which statuses occupy a property (§18)', () => {
    expect([...OCCUPYING_STATUSES]).toEqual(['CONFIRMED', 'ACTIVE', 'EXPIRING'])
    expect(OCCUPYING_STATUSES).not.toContain('DRAFT')
    expect(OCCUPYING_STATUSES).not.toContain('ENDED')
  })
})

describe('commercial terms — DR-007', () => {
  it('accepts complete terms', () => {
    expect(termsGaps(terms)).toEqual([])
    expect(() => assertTermsComplete(terms)).not.toThrow()
  })

  it('names every missing term', () => {
    const gaps = termsGaps({ price: 0 })
    expect(gaps).toContain('start_date')
    expect(gaps).toContain('end_date')
    expect(gaps).toContain('price')
    expect(gaps).toContain('payment_period')
  })

  it('rejects an end date that is not after the start date', () => {
    expect(() => assertTermsComplete({ ...terms, end_date: '2026-09-01' })).toThrow(/after the start/i)
    expect(() => assertTermsComplete({ ...terms, end_date: '2026-08-01' })).toThrow(/after the start/i)
  })

  it('rejects an unparseable date', () => {
    expect(() => assertTermsComplete({ ...terms, start_date: 'not-a-date' })).toThrow(/invalid/i)
  })
})

describe('§17 RENTAL ACTIVATION RULE — all six preconditions', () => {
  it('activates when every precondition holds', () => {
    expect(() => assertActivatable(facts)).not.toThrow()
  })

  it('1. refuses a missing property', () => {
    expect(() => assertActivatable({ ...facts, property_exists: false })).toThrow(/Property does not exist/)
  })

  it('2. refuses an unavailable property', () => {
    expect(() => assertActivatable({ ...facts, property_availability: 'UNAVAILABLE' })).toThrow(
      /not available/i
    )
  })

  it('2b. accepts a property RESERVED for this deal', () => {
    expect(() => assertActivatable({ ...facts, property_availability: 'RESERVED' })).not.toThrow()
  })

  it('3. refuses a missing tenant', () => {
    expect(() => assertActivatable({ ...facts, tenant_exists: false })).toThrow(/Tenant does not exist/)
  })

  it('4. refuses incomplete terms', () => {
    expect(() => assertActivatable({ ...facts, terms: { price: 1 } })).toThrow(/terms are incomplete/i)
  })

  it('5. refuses activation while a linked negotiation is unresolved', () => {
    for (const status of ['OPEN', 'COUNTER_OFFER', 'FAILED']) {
      expect(() => assertActivatable({ ...facts, negotiation_status: status }), status).toThrow(
        /negotiation must be agreed/i
      )
    }
  })

  it('5b. allows activation with no negotiation linked at all', () => {
    expect(() => assertActivatable({ ...facts, negotiation_status: null })).not.toThrow()
  })

  it('6. DOUBLE RENTAL PROTECTION — refuses a second occupying rental (§18)', () => {
    try {
      assertActivatable({ ...facts, other_occupying_rentals: 1 })
      throw new Error('expected double-rental protection to trigger')
    } catch (e: any) {
      expect(e.code).toBe(ErrorCode.BUSINESS_RULE_VIOLATION)
      expect(e.rule).toBe('DR-008')
      expect(e.message).toMatch(/already has an occupying rental/i)
    }
  })

  it('refuses activation from a terminal status', () => {
    expect(() => assertActivatable({ ...facts, current_status: 'ENDED' })).toThrow()
    expect(() => assertActivatable({ ...facts, current_status: 'CANCELLED' })).toThrow()
  })
})

describe('creation-time invariant (fail fast) — DR-008', () => {
  it('accepts a clean property', () => {
    expect(() =>
      assertCreatable({ property_availability: 'AVAILABLE', other_occupying_rentals: 0 })
    ).not.toThrow()
  })

  it('blocks creation on an already rented property', () => {
    expect(() =>
      assertCreatable({ property_availability: 'RENTED', other_occupying_rentals: 0 })
    ).toThrow(/already rented/i)
  })

  it('blocks creation when another occupying rental exists', () => {
    expect(() =>
      assertCreatable({ property_availability: 'AVAILABLE', other_occupying_rentals: 1 })
    ).toThrow(/occupying rental/i)
  })

  it('blocks creation from a non-agreed negotiation', () => {
    expect(() =>
      assertCreatable({
        property_availability: 'AVAILABLE',
        other_occupying_rentals: 0,
        negotiation_status: 'OPEN'
      })
    ).toThrow(/agreed negotiation/i)
  })
})

describe('ending a rental and the expiry window', () => {
  it('requires an explicit end reason (§46 audit)', () => {
    expect(() => assertEndReason('Kontrak selesai sesuai jangka waktu')).not.toThrow()
    expect(() => assertEndReason('')).toThrow()
    expect(() => assertEndReason('x')).toThrow()
  })

  it('computes days until expiry', () => {
    const now = new Date('2026-08-01T00:00:00Z')
    expect(daysUntil('2026-08-31', now)).toBe(30)
    expect(daysUntil('2026-07-01', now)).toBeLessThan(0)
  })

  it('flags only ACTIVE rentals inside the expiry window', () => {
    const now = new Date('2026-08-01T00:00:00Z')
    expect(shouldFlagExpiring('ACTIVE', '2026-08-20', now)).toBe(true)
    expect(shouldFlagExpiring('ACTIVE', '2027-08-20', now)).toBe(false)
    expect(shouldFlagExpiring('DRAFT', '2026-08-20', now)).toBe(false)
    expect(shouldFlagExpiring('ACTIVE', '2026-07-01', now)).toBe(false)
    expect(EXPIRING_WINDOW_DAYS).toBe(30)
  })
})
