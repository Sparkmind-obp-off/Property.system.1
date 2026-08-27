/**
 * Unit tests — Lead pipeline, scoring and qualification.
 * Traceability: PS-MASTER-001 §10 (lead lifecycle), §11 (explainable
 *               qualification), §24, §41 | DR-003, DR-004
 */
import { describe, expect, it } from 'vitest'
import {
  assertLeadContext,
  assertLeadTransition,
  assertLostReason,
  computeLeadScore,
  evaluateQualification,
  temperatureFor,
  type QualificationFacts
} from '../../src/modules/lead/domain/lead.rules'
import { ErrorCode } from '../../src/shared/errors'

describe('lead pipeline state machine (§10)', () => {
  it('walks the golden path NEW → … → WON', () => {
    const path = [
      ['NEW', 'CONTACTED'],
      ['CONTACTED', 'QUALIFIED'],
      ['QUALIFIED', 'VISIT_SCHEDULED'],
      ['VISIT_SCHEDULED', 'VISITED'],
      ['VISITED', 'NEGOTIATION'],
      ['NEGOTIATION', 'WON']
    ] as const
    for (const [from, to] of path) {
      expect(() => assertLeadTransition(from, to), `${from}→${to}`).not.toThrow()
    }
  })

  it('reaches LOST from every non-terminal stage', () => {
    const stages = [
      'NEW',
      'CONTACTED',
      'RESPONDED',
      'QUALIFIED',
      'INTERESTED',
      'VISIT_SCHEDULED',
      'VISITED',
      'NEGOTIATION'
    ] as const
    for (const s of stages) {
      expect(() => assertLeadTransition(s, 'LOST'), s).not.toThrow()
    }
  })

  it('only allows WON from NEGOTIATION — a rental needs an agreed position', () => {
    expect(() => assertLeadTransition('NEW', 'WON')).toThrow()
    expect(() => assertLeadTransition('QUALIFIED', 'WON')).toThrow()
    expect(() => assertLeadTransition('VISITED', 'WON')).toThrow()
    expect(() => assertLeadTransition('NEGOTIATION', 'WON')).not.toThrow()
  })

  it('treats WON and LOST as terminal', () => {
    expect(() => assertLeadTransition('WON', 'NEGOTIATION')).toThrow()
    expect(() => assertLeadTransition('LOST', 'NEW')).toThrow()
  })

  it('is idempotent for a same-state write', () => {
    expect(() => assertLeadTransition('QUALIFIED', 'QUALIFIED')).not.toThrow()
  })
})

describe('lead context and loss reason — DR-003 / DR-004', () => {
  it('requires both property and tenant context', () => {
    expect(() => assertLeadContext('prp_1', 'tnt_1')).not.toThrow()
    expect(() => assertLeadContext(null, 'tnt_1')).toThrow(/property/i)
    expect(() => assertLeadContext('prp_1', null)).toThrow(/tenant/i)
  })

  it('refuses to lose a lead without an explicit reason', () => {
    expect(() => assertLostReason('Budget terlalu jauh di bawah harga')).not.toThrow()
    expect(() => assertLostReason('')).toThrow()
    expect(() => assertLostReason('  ')).toThrow()
    expect(() => assertLostReason('no')).toThrow()
  })
})

describe('lead scoring is explainable (§11)', () => {
  it('never returns a score without reasons', () => {
    const r = computeLeadScore({ status: 'NEW' })
    expect(r.reasons.length).toBeGreaterThan(0)
  })

  it('rises monotonically as evidence accumulates', () => {
    const cold = computeLeadScore({ status: 'NEW' })
    const contacted = computeLeadScore({ status: 'CONTACTED', responded: true, engagement_count: 2 })
    const qualified = computeLeadScore({
      status: 'QUALIFIED',
      fit_score: 84,
      qualification_result: 'QUALIFIED',
      responded: true,
      engagement_count: 3
    })
    const negotiating = computeLeadScore({
      status: 'NEGOTIATION',
      fit_score: 90,
      qualification_result: 'QUALIFIED',
      responded: true,
      engagement_count: 4,
      visit_result: 'STRONG_FIT'
    })
    expect(cold.score).toBeLessThan(contacted.score)
    expect(contacted.score).toBeLessThan(qualified.score)
    expect(qualified.score).toBeLessThan(negotiating.score)
  })

  it('caps the score at 100', () => {
    const r = computeLeadScore({
      status: 'WON',
      fit_score: 100,
      qualification_result: 'QUALIFIED',
      responded: true,
      engagement_count: 99,
      visit_result: 'STRONG_FIT'
    })
    expect(r.score).toBeLessThanOrEqual(100)
  })

  it('forces a LOST lead to zero and says so', () => {
    const r = computeLeadScore({ status: 'LOST', fit_score: 95, qualification_result: 'QUALIFIED' })
    expect(r.score).toBe(0)
    expect(r.temperature).toBe('LOW')
    expect(r.reasons.join(' ')).toMatch(/LOST/)
  })

  it('maps score bands to temperature', () => {
    expect(temperatureFor(80)).toBe('HOT')
    expect(temperatureFor(60)).toBe('WARM')
    expect(temperatureFor(30)).toBe('COOL')
    expect(temperatureFor(10)).toBe('LOW')
  })
})

describe('qualification evaluation (§11)', () => {
  const base: QualificationFacts = {
    budget: 4_000_000,
    timeline: 'IMMEDIATE',
    space_need: 16,
    business_type: 'FOOD',
    decision_status: 'DECISION_MAKER',
    property_price: 3_500_000,
    property_price_period: 'MONTH',
    property_area_size: 18,
    property_type: 'RUKO',
    recommended_uses: ['FOOD', 'RETAIL']
  }

  it('qualifies a strong candidate with reasons', () => {
    const r = evaluateQualification(base)
    expect(r.qualification_result).toBe('QUALIFIED')
    expect(r.fit_score).toBeGreaterThanOrEqual(70)
    expect(r.reasoning.length).toBeGreaterThan(3)
    expect(r.blockers).toEqual([])
  })

  it('disqualifies an incompatible budget regardless of other strengths', () => {
    const r = evaluateQualification({ ...base, budget: 1_000_000 })
    expect(r.qualification_result).toBe('UNQUALIFIED')
    expect(r.blockers.join(' ')).toMatch(/Budget is incompatible/)
  })

  it('disqualifies when the property is structurally too small', () => {
    const r = evaluateQualification({ ...base, space_need: 60 })
    expect(r.qualification_result).toBe('UNQUALIFIED')
    expect(r.blockers.join(' ')).toMatch(/too small/)
  })

  it('flags a negotiable budget gap without disqualifying', () => {
    const r = evaluateQualification({ ...base, budget: 3_150_000 })
    expect(r.qualification_result).not.toBe('UNQUALIFIED')
    expect(r.reasoning.join(' ')).toMatch(/negotiable/)
  })

  it('normalises a yearly asking price to a monthly comparison', () => {
    const r = evaluateQualification({
      ...base,
      budget: 4_000_000,
      property_price: 42_000_000,
      property_price_period: 'YEAR'
    })
    // 42M/year = 3.5M/month → budget covers it.
    expect(r.reasoning.join(' ')).toMatch(/covers the asking price/)
  })

  it('downgrades an unknown timeline as unclear intent', () => {
    const r = evaluateQualification({ ...base, timeline: 'UNKNOWN' })
    expect(r.blockers.join(' ')).toMatch(/Timeline unknown/)
    expect(r.fit_score).toBeLessThan(evaluateQualification(base).fit_score)
  })

  it('applies a neutral baseline when space data is missing', () => {
    const r = evaluateQualification({ ...base, space_need: null, property_area_size: null })
    expect(r.reasoning.join(' ')).toMatch(/Space compatibility unknown/)
  })

  it('keeps the score inside 0..100', () => {
    const r = evaluateQualification({ ...base, budget: 999_000_000 })
    expect(r.fit_score).toBeGreaterThanOrEqual(0)
    expect(r.fit_score).toBeLessThanOrEqual(100)
  })
})

describe('error contract', () => {
  it('uses stable codes the frontend can branch on (§35)', () => {
    try {
      assertLostReason('')
    } catch (e: any) {
      expect(e.code).toBe(ErrorCode.BUSINESS_RULE_VIOLATION)
      expect(e.rule).toBe('DR-004')
    }
  })
})
