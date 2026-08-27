/**
 * Unit tests — Negotiation domain rules.
 * Traceability: PS-MASTER-001 §15 (negotiation lifecycle, explicit acceptance),
 *               §29, §41 | DR-006, DR-007, DR-008
 */
import { describe, expect, it } from 'vitest'
import {
  analyzeDiscount,
  assertAgreement,
  assertNegotiable,
  assertNegotiableProperty,
  assertNegotiationTransition,
  assertNoOpenNegotiation,
  assertPriceProposal
} from '../../src/modules/negotiation/domain/negotiation.rules'
import { ErrorCode } from '../../src/shared/errors'

describe('negotiation lifecycle (§15)', () => {
  it('allows OPEN → COUNTER_OFFER → AGREED', () => {
    expect(() => assertNegotiationTransition('OPEN', 'COUNTER_OFFER')).not.toThrow()
    expect(() => assertNegotiationTransition('COUNTER_OFFER', 'AGREED')).not.toThrow()
  })

  it('allows direct agreement and direct failure', () => {
    expect(() => assertNegotiationTransition('OPEN', 'AGREED')).not.toThrow()
    expect(() => assertNegotiationTransition('OPEN', 'FAILED')).not.toThrow()
  })

  it('treats AGREED and FAILED as terminal — no silent re-opening', () => {
    expect(() => assertNegotiationTransition('AGREED', 'OPEN')).toThrow()
    expect(() => assertNegotiationTransition('AGREED', 'COUNTER_OFFER')).toThrow()
    expect(() => assertNegotiationTransition('FAILED', 'OPEN')).toThrow()
  })
})

describe('negotiation preconditions — DR-006', () => {
  it('requires a qualified or visited lead', () => {
    for (const s of ['QUALIFIED', 'INTERESTED', 'VISITED', 'NEGOTIATION']) {
      expect(() => assertNegotiable(s), s).not.toThrow()
    }
  })

  it('refuses a negotiation on an unqualified lead', () => {
    for (const s of ['NEW', 'CONTACTED', 'RESPONDED', 'WON', 'LOST']) {
      expect(() => assertNegotiable(s), s).toThrow(/qualified or visited/i)
    }
  })

  it('refuses a negotiation on an already rented property', () => {
    expect(() => assertNegotiableProperty('AVAILABLE')).not.toThrow()
    expect(() => assertNegotiableProperty('RESERVED')).not.toThrow()
    expect(() => assertNegotiableProperty('RENTED')).toThrow(/already rented/i)
  })

  it('allows only one live negotiation per lead', () => {
    expect(() => assertNoOpenNegotiation(0)).not.toThrow()
    expect(() => assertNoOpenNegotiation(1)).toThrow(/already has an open negotiation/i)
  })
})

describe('price proposals', () => {
  it('accepts positive prices', () => {
    expect(() => assertPriceProposal({ current_price: 3_500_000, proposed_price: 3_200_000 })).not.toThrow()
  })

  it('rejects non-positive prices on either side', () => {
    expect(() => assertPriceProposal({ current_price: 0, proposed_price: 3_000_000 })).toThrow()
    expect(() => assertPriceProposal({ current_price: 3_000_000, proposed_price: 0 })).toThrow()
    expect(() => assertPriceProposal({ current_price: 3_000_000, proposed_price: -1 })).toThrow()
  })
})

describe('explicit acceptance — DR-007 (§15)', () => {
  it('returns the agreed price that becomes the rental price', () => {
    expect(assertAgreement(3_200_000)).toBe(3_200_000)
  })

  it('refuses acceptance without an explicit agreed price', () => {
    for (const v of [null, undefined, 0, -5]) {
      try {
        assertAgreement(v as any)
        throw new Error(`expected rejection for ${String(v)}`)
      } catch (e: any) {
        expect(e.code).toBe(ErrorCode.BUSINESS_RULE_VIOLATION)
        expect(e.rule).toBe('DR-007')
      }
    }
  })
})

describe('concession analysis is explainable', () => {
  it('reports no discount when agreed at or above list', () => {
    const r = analyzeDiscount(3_500_000, 3_500_000)
    expect(r.discount_amount).toBe(0)
    expect(r.discount_percent).toBe(0)
    expect(r.severity).toBe('NONE')
    expect(r.note).toMatch(/at or above/i)
  })

  it('clamps a premium (above-list) agreement to zero discount', () => {
    const r = analyzeDiscount(3_000_000, 3_300_000)
    expect(r.discount_amount).toBe(0)
    expect(r.severity).toBe('NONE')
  })

  it('grades severity by concession band', () => {
    expect(analyzeDiscount(1_000_000, 950_000).severity).toBe('LOW') // 5%
    expect(analyzeDiscount(1_000_000, 850_000).severity).toBe('MODERATE') // 15%
    expect(analyzeDiscount(1_000_000, 700_000).severity).toBe('HIGH') // 30%
  })

  it('always carries a human-readable note', () => {
    const r = analyzeDiscount(3_500_000, 3_000_000)
    expect(r.discount_amount).toBe(500_000)
    expect(r.discount_percent).toBeCloseTo(14.3, 1)
    expect(r.note.length).toBeGreaterThan(0)
  })

  it('does not divide by zero on a zero list price', () => {
    expect(analyzeDiscount(0, 0).discount_percent).toBe(0)
  })
})
