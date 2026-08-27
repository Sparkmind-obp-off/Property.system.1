/**
 * Unit tests — Offer and Campaign domain rules.
 * Traceability: PS-MASTER-001 §9 (offer lifecycle), §29 (publish confirmation),
 *               §41 | DR-002
 */
import { describe, expect, it } from 'vitest'
import {
  assertCampaignRunnable,
  assertCampaignTransition,
  assertOfferTransition,
  assertPublishable,
  publicationGaps,
  type OfferPublishFacts
} from '../../src/modules/offer/domain/offer.rules'

const facts: OfferPublishFacts = {
  title: 'Ruko strategis Kota Lama',
  value_proposition: 'Lokasi ramai, cocok untuk kuliner harian',
  price: 3_500_000,
  cta: 'Hubungi kami untuk survei',
  property_lifecycle: 'VERIFIED',
  property_availability: 'AVAILABLE'
}

describe('offer lifecycle (§9)', () => {
  it('allows DRAFT → READY → ACTIVE', () => {
    expect(() => assertOfferTransition('DRAFT', 'READY')).not.toThrow()
    expect(() => assertOfferTransition('READY', 'ACTIVE')).not.toThrow()
  })

  it('allows pausing and resuming a published offer', () => {
    expect(() => assertOfferTransition('ACTIVE', 'PAUSED')).not.toThrow()
    expect(() => assertOfferTransition('PAUSED', 'ACTIVE')).not.toThrow()
  })

  it('refuses publishing straight from DRAFT — READY is the review gate', () => {
    expect(() => assertOfferTransition('DRAFT', 'ACTIVE')).toThrow()
  })

  it('treats EXPIRED as terminal', () => {
    expect(() => assertOfferTransition('EXPIRED', 'ACTIVE')).toThrow()
  })
})

describe('publication requirements — DR-002', () => {
  it('reports no gaps for a complete offer', () => {
    expect(publicationGaps(facts)).toEqual([])
    expect(() => assertPublishable(facts)).not.toThrow()
  })

  it('names every missing field', () => {
    const gaps = publicationGaps({ ...facts, title: null, cta: null, price: 0 })
    expect(gaps).toContain('title')
    expect(gaps).toContain('cta')
    expect(gaps).toContain('price')
  })

  it('requires a value proposition — an offer without one cannot acquire leads', () => {
    expect(publicationGaps({ ...facts, value_proposition: '' })).toContain('value_proposition')
  })

  it('refuses publication while the property is unverified', () => {
    expect(() => assertPublishable({ ...facts, property_lifecycle: 'DRAFT' })).toThrow(/verified/i)
    expect(() =>
      assertPublishable({ ...facts, property_lifecycle: 'PENDING_VERIFICATION' })
    ).toThrow(/verified/i)
  })

  it('accepts every commercially publishable lifecycle', () => {
    for (const lc of ['VERIFIED', 'ACTIVE', 'MARKETED', 'RESERVED']) {
      expect(() => assertPublishable({ ...facts, property_lifecycle: lc }), lc).not.toThrow()
    }
  })

  it('refuses publication for an already rented property', () => {
    expect(() =>
      assertPublishable({ ...facts, property_lifecycle: 'ACTIVE', property_availability: 'RENTED' })
    ).toThrow(/rented/i)
  })
})

describe('campaign lifecycle', () => {
  it('allows DRAFT → RUNNING → PAUSED → RUNNING → ENDED', () => {
    expect(() => assertCampaignTransition('DRAFT', 'RUNNING')).not.toThrow()
    expect(() => assertCampaignTransition('RUNNING', 'PAUSED')).not.toThrow()
    expect(() => assertCampaignTransition('PAUSED', 'RUNNING')).not.toThrow()
    expect(() => assertCampaignTransition('RUNNING', 'ENDED')).not.toThrow()
  })

  it('treats ENDED as terminal', () => {
    expect(() => assertCampaignTransition('ENDED', 'RUNNING')).toThrow()
  })

  it('only runs a campaign on a published offer', () => {
    expect(() => assertCampaignRunnable('ACTIVE')).not.toThrow()
    for (const s of ['DRAFT', 'READY', 'PAUSED', 'EXPIRED'] as const) {
      expect(() => assertCampaignRunnable(s), s).toThrow(/published/i)
    }
  })
})
