/**
 * Unit tests — Tenant Fit Engine.
 * Traceability: PS-MASTER-001 §6 (no score without reasons), §8 (matching is
 *               decision support), §25, §41 | PS-TECH-008 §21 (weights)
 */
import { describe, expect, it } from 'vitest'
import {
  computeFit,
  DEFAULT_WEIGHTS,
  monthlyEquivalent,
  type DemandFacts,
  type PropertyFacts
} from '../../src/modules/matching/domain/fit-engine'

const property: PropertyFacts = {
  id: 'prp_1',
  property_type: 'SHOPHOUSE',
  price: 3_500_000,
  price_period: 'MONTH',
  area_size: 18,
  width: 3,
  length: 6,
  location_score: 8,
  access_score: 8,
  visibility_score: 7,
  space_score: 7,
  same_category_nearby: 1,
  total_nearby: 5,
  recommended_uses: ['FOOD_BUSINESS', 'RETAIL']
}

const demand: DemandFacts = {
  business_category: 'FOOD_BUSINESS',
  budget_min: 3_000_000,
  budget_max: 4_000_000,
  space_need: 16,
  minimum_space: 12,
  maximum_space: 24,
  location_preference: 'HIGH',
  acceptable_types: ['SHOPHOUSE', 'KIOSK']
}

describe('weight configuration (PS-TECH-008 §21)', () => {
  it('sums to 1.0 so the weighted score stays on a 0–100 scale', () => {
    const total = Object.values(DEFAULT_WEIGHTS).reduce((a, b) => a + b, 0)
    expect(Number(total.toFixed(6))).toBe(1)
  })
})

describe('price period normalisation', () => {
  it('converts a yearly price to its monthly equivalent', () => {
    expect(monthlyEquivalent(42_000_000, 'YEAR')).toBe(3_500_000)
    expect(monthlyEquivalent(3_500_000, 'MONTH')).toBe(3_500_000)
  })
})

describe('fit output contract (§6 — never a score without reasons)', () => {
  const r = computeFit(property, demand)

  it('returns a bounded score', () => {
    expect(r.fit_score).toBeGreaterThanOrEqual(0)
    expect(r.fit_score).toBeLessThanOrEqual(100)
  })

  it('always carries explanatory components', () => {
    expect(r.components.length).toBe(Object.keys(DEFAULT_WEIGHTS).length)
    for (const c of r.components) {
      expect(c.reason.length).toBeGreaterThan(0)
      expect(c.score).toBeGreaterThanOrEqual(0)
      expect(c.score).toBeLessThanOrEqual(100)
    }
  })

  it('exposes reasoning, mismatches and risks separately (§25)', () => {
    expect(Array.isArray(r.reasoning)).toBe(true)
    expect(Array.isArray(r.mismatches)).toBe(true)
    expect(Array.isArray(r.risks)).toBe(true)
    expect(r.reasoning.length).toBeGreaterThan(0)
  })

  it('emits a recommendation band, not a bare number', () => {
    expect(['HIGH_FIT', 'MEDIUM_FIT', 'LOW_FIT', 'NO_FIT']).toContain(r.recommendation)
  })

  it('exposes per-dimension component scores for the UI', () => {
    const cs = r.component_scores
    for (const key of [
      'location_score',
      'demand_score',
      'space_score',
      'price_score',
      'business_score',
      'competition_score',
      'operational_score'
    ] as const) {
      expect(typeof cs[key]).toBe('number')
    }
  })
})

describe('fit discrimination', () => {
  it('scores an aligned tenant above a misaligned one', () => {
    const good = computeFit(property, demand)
    const bad = computeFit(property, {
      ...demand,
      business_category: 'WORKSHOP',
      budget_min: 500_000,
      budget_max: 900_000,
      space_need: 200,
      acceptable_types: ['WAREHOUSE']
    })
    expect(good.fit_score).toBeGreaterThan(bad.fit_score)
    expect(bad.mismatches.length).toBeGreaterThan(0)
  })

  it('records a mismatch when the budget cannot reach the asking price', () => {
    const r = computeFit(property, { ...demand, budget_min: 500_000, budget_max: 1_000_000 })
    expect(r.mismatches.join(' ').toLowerCase()).toMatch(/budget|price/)
  })

  it('records a mismatch when the space requirement exceeds the property', () => {
    const r = computeFit(property, { ...demand, space_need: 120, minimum_space: 100 })
    expect(r.mismatches.join(' ').toLowerCase()).toMatch(/space|size|small/)
  })

  it('raises a risk instead of guessing when analysis data is absent', () => {
    const r = computeFit(
      {
        ...property,
        location_score: null,
        access_score: null,
        visibility_score: null,
        space_score: null,
        total_nearby: 0,
        same_category_nearby: 0,
        recommended_uses: []
      },
      demand
    )
    expect(r.risks.length).toBeGreaterThan(0)
    expect(r.risks.join(' ')).toMatch(/not yet analyzed|unverified|no /i)
  })

  it('penalises a saturated category (competition signal)', () => {
    const low = computeFit({ ...property, same_category_nearby: 0 }, demand)
    const high = computeFit({ ...property, same_category_nearby: 9 }, demand)
    expect(high.component_scores.competition_score).toBeLessThan(
      low.component_scores.competition_score
    )
  })

  it('is deterministic — the same facts always yield the same score', () => {
    expect(computeFit(property, demand).fit_score).toBe(computeFit(property, demand).fit_score)
  })
})
