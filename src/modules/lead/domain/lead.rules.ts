/**
 * Lead domain — pipeline state machine, scoring, qualification.
 * Traceability: PS-MASTER-001 §10, §11, §24 | PS-DATA-009 §22–§25
 *               DR-003, DR-004, DR-009 | PS-TECH-008 §18 (lead state machine)
 *
 * PURE domain logic: no HTTP, no DB, no framework imports.
 */
import { BusinessRuleViolation, InvalidStateTransition } from '../../../shared/errors'

export type LeadStatus =
  | 'NEW'
  | 'CONTACTED'
  | 'RESPONDED'
  | 'QUALIFIED'
  | 'INTERESTED'
  | 'VISIT_SCHEDULED'
  | 'VISITED'
  | 'NEGOTIATION'
  | 'WON'
  | 'LOST'

export type Temperature = 'HOT' | 'WARM' | 'COOL' | 'LOW'

/**
 * Allowed pipeline transitions (PS-TECH-008 §18).
 * LOST is reachable from every non-terminal stage. WON is only reachable from
 * NEGOTIATION because a rental requires an agreed commercial position (DR-007).
 */
export const LEAD_TRANSITIONS: Record<LeadStatus, readonly LeadStatus[]> = {
  NEW: ['CONTACTED', 'LOST'],
  CONTACTED: ['RESPONDED', 'QUALIFIED', 'LOST'],
  RESPONDED: ['QUALIFIED', 'INTERESTED', 'LOST'],
  QUALIFIED: ['INTERESTED', 'VISIT_SCHEDULED', 'NEGOTIATION', 'LOST'],
  INTERESTED: ['VISIT_SCHEDULED', 'NEGOTIATION', 'LOST'],
  VISIT_SCHEDULED: ['VISITED', 'INTERESTED', 'LOST'],
  VISITED: ['NEGOTIATION', 'INTERESTED', 'LOST'],
  NEGOTIATION: ['WON', 'LOST', 'VISITED'],
  WON: [],
  LOST: []
}

/** Ordered pipeline stages used by the kanban board (§24). */
export const PIPELINE_STAGES: readonly LeadStatus[] = [
  'NEW',
  'CONTACTED',
  'RESPONDED',
  'QUALIFIED',
  'INTERESTED',
  'VISIT_SCHEDULED',
  'VISITED',
  'NEGOTIATION',
  'WON',
  'LOST'
]

export function assertLeadTransition(from: LeadStatus, to: LeadStatus): void {
  if (from === to) return
  const allowed = LEAD_TRANSITIONS[from] ?? []
  if (!allowed.includes(to)) {
    throw new InvalidStateTransition('Lead', from, to, allowed)
  }
}

/** DR-004 — losing a lead requires an explicit reason (traceability). */
export function assertLostReason(reason?: string | null): void {
  if (!reason || reason.trim().length < 3) {
    throw new BusinessRuleViolation(
      'A lost lead requires an explicit reason.',
      'DR-004',
      { field: 'lost_reason' }
    )
  }
}

/* --------------------------- Lead scoring model --------------------------- */

export interface LeadScoreFacts {
  /** Property↔tenant fit score (0-100) when known. */
  fit_score?: number | null
  /** Qualification result when the lead has been qualified. */
  qualification_result?: 'QUALIFIED' | 'PARTIALLY_QUALIFIED' | 'UNQUALIFIED' | null
  status: LeadStatus
  /** Number of recorded two-way activities. */
  engagement_count?: number
  /** Whether the tenant has responded at least once. */
  responded?: boolean
  /** Latest visit result when a visit has been completed. */
  visit_result?: 'STRONG_FIT' | 'POTENTIAL' | 'WEAK_FIT' | 'NO_FIT' | null
}

export interface LeadScoreResult {
  score: number
  temperature: Temperature
  reasons: string[]
}

const STAGE_WEIGHT: Record<LeadStatus, number> = {
  NEW: 0,
  CONTACTED: 5,
  RESPONDED: 10,
  QUALIFIED: 18,
  INTERESTED: 22,
  VISIT_SCHEDULED: 26,
  VISITED: 30,
  NEGOTIATION: 35,
  WON: 40,
  LOST: 0
}

/**
 * Lead score = explainable composite (never an opaque number — §6/§11).
 * Components: fit (40) + qualification (25) + stage progress (delegated) +
 * engagement (10) + visit outcome (15), capped at 100.
 */
export function computeLeadScore(f: LeadScoreFacts): LeadScoreResult {
  const reasons: string[] = []
  let score = 0

  // 1. Property fit (decision support carried over from the matching engine)
  if (f.fit_score !== null && f.fit_score !== undefined) {
    const part = Math.round((f.fit_score / 100) * 40)
    score += part
    reasons.push(`Property fit ${f.fit_score}% contributes ${part} points`)
  } else {
    reasons.push('Property fit not yet computed — no fit contribution')
  }

  // 2. Qualification outcome
  if (f.qualification_result === 'QUALIFIED') {
    score += 25
    reasons.push('Lead is fully qualified (+25)')
  } else if (f.qualification_result === 'PARTIALLY_QUALIFIED') {
    score += 12
    reasons.push('Lead is partially qualified (+12)')
  } else if (f.qualification_result === 'UNQUALIFIED') {
    reasons.push('Lead is unqualified — no qualification contribution')
  } else {
    reasons.push('Lead not yet qualified')
  }

  // 3. Pipeline progress
  const stage = STAGE_WEIGHT[f.status] ?? 0
  if (stage > 0) {
    score += Math.round(stage * 0.5)
    reasons.push(`Pipeline stage ${f.status} (+${Math.round(stage * 0.5)})`)
  }

  // 4. Engagement
  if (f.responded) {
    score += 6
    reasons.push('Tenant has responded (+6)')
  }
  const engagement = Math.min(4, f.engagement_count ?? 0)
  if (engagement > 0) {
    score += engagement
    reasons.push(`${engagement} recorded interaction(s) (+${engagement})`)
  }

  // 5. Visit outcome
  const visitPoints: Record<string, number> = {
    STRONG_FIT: 15,
    POTENTIAL: 8,
    WEAK_FIT: 2,
    NO_FIT: 0
  }
  if (f.visit_result) {
    const pts = visitPoints[f.visit_result] ?? 0
    score += pts
    reasons.push(`Visit result ${f.visit_result} (+${pts})`)
  }

  if (f.status === 'LOST') {
    reasons.push('Lead is LOST — score forced to 0')
    return { score: 0, temperature: 'LOW', reasons }
  }

  const final = Math.max(0, Math.min(100, score))
  return { score: final, temperature: temperatureFor(final), reasons }
}

export function temperatureFor(score: number): Temperature {
  if (score >= 75) return 'HOT'
  if (score >= 50) return 'WARM'
  if (score >= 25) return 'COOL'
  return 'LOW'
}

/* ------------------------- Qualification evaluation ----------------------- */

export interface QualificationFacts {
  budget: number
  timeline: 'IMMEDIATE' | 'WITHIN_30_DAYS' | 'WITHIN_90_DAYS' | 'LATER' | 'UNKNOWN'
  space_need?: number | null
  business_type: string
  location_need?: 'HIGH' | 'MEDIUM' | 'LOW' | null
  decision_status?: 'DECISION_MAKER' | 'INFLUENCER' | 'UNKNOWN' | null
  /** Property being qualified against. */
  property_price: number
  property_price_period: string
  property_area_size?: number | null
  property_type: string
  /** Business categories the property is suited for. */
  recommended_uses?: string[]
}

export interface QualificationResult {
  fit_score: number
  qualification_result: 'QUALIFIED' | 'PARTIALLY_QUALIFIED' | 'UNQUALIFIED'
  reasoning: string[]
  blockers: string[]
}

function monthly(price: number, period: string): number {
  return period === 'YEAR' ? price / 12 : price
}

/**
 * Qualification evaluates budget, timeline, space, business type, property fit,
 * readiness and intent — and MUST be explainable (§11).
 */
export function evaluateQualification(f: QualificationFacts): QualificationResult {
  const reasoning: string[] = []
  const blockers: string[] = []
  let score = 0

  // 1. Budget (30) — hard commercial constraint
  const askMonthly = monthly(f.property_price, f.property_price_period)
  if (f.budget >= askMonthly) {
    score += 30
    reasoning.push(`✓ Budget ${fmt(f.budget)} covers the asking price ${fmt(askMonthly)}/month`)
  } else if (f.budget >= askMonthly * 0.85) {
    score += 18
    reasoning.push(`~ Budget ${fmt(f.budget)} is within 15% of the asking price — negotiable`)
  } else if (f.budget >= askMonthly * 0.7) {
    score += 8
    reasoning.push(`⚠ Budget ${fmt(f.budget)} is 15–30% below the asking price`)
    blockers.push('Budget gap requires a price concession')
  } else {
    reasoning.push(`✗ Budget ${fmt(f.budget)} is far below the asking price ${fmt(askMonthly)}`)
    blockers.push('Budget is incompatible with the asking price')
  }

  // 2. Timeline (20) — readiness
  const timelinePoints: Record<string, number> = {
    IMMEDIATE: 20,
    WITHIN_30_DAYS: 16,
    WITHIN_90_DAYS: 9,
    LATER: 3,
    UNKNOWN: 0
  }
  const tp = timelinePoints[f.timeline] ?? 0
  score += tp
  if (tp >= 16) reasoning.push(`✓ Timeline ${f.timeline} indicates high readiness`)
  else if (tp >= 9) reasoning.push(`~ Timeline ${f.timeline} indicates medium readiness`)
  else {
    reasoning.push(`⚠ Timeline ${f.timeline} indicates low readiness`)
    if (f.timeline === 'UNKNOWN') blockers.push('Timeline unknown — intent unclear')
  }

  // 3. Space (20)
  if (f.space_need && f.property_area_size) {
    const ratio = f.space_need / f.property_area_size
    if (ratio <= 1 && ratio >= 0.5) {
      score += 20
      reasoning.push(`✓ Space requirement ${f.space_need}m² fits ${f.property_area_size}m²`)
    } else if (ratio <= 1) {
      score += 14
      reasoning.push(`~ Property (${f.property_area_size}m²) is larger than required (${f.space_need}m²)`)
    } else if (ratio <= 1.15) {
      score += 8
      reasoning.push(`⚠ Space requirement slightly exceeds the property size`)
      blockers.push('Space requirement marginally exceeds available area')
    } else {
      reasoning.push(`✗ Space requirement ${f.space_need}m² exceeds ${f.property_area_size}m²`)
      blockers.push('Property is too small for the stated requirement')
    }
  } else {
    score += 10
    reasoning.push('~ Space compatibility unknown — neutral baseline applied')
  }

  // 4. Business type ↔ property suitability (20)
  const uses = (f.recommended_uses ?? []).map((u) => u.toUpperCase())
  const bt = f.business_type.toUpperCase()
  if (uses.length > 0 && uses.some((u) => u.includes(bt) || bt.includes(u))) {
    score += 20
    reasoning.push(`✓ Business type ${f.business_type} matches the property's recommended uses`)
  } else if (uses.length === 0) {
    score += 12
    reasoning.push('~ Property has no analyzed recommended uses — neutral business fit')
  } else {
    score += 6
    reasoning.push(`⚠ Business type ${f.business_type} is not in the property's recommended uses`)
  }

  // 5. Decision authority (10) — intent quality
  if (f.decision_status === 'DECISION_MAKER') {
    score += 10
    reasoning.push('✓ Contact is the decision maker')
  } else if (f.decision_status === 'INFLUENCER') {
    score += 5
    reasoning.push('~ Contact influences but does not decide')
  } else {
    reasoning.push('⚠ Decision authority unknown')
  }

  const fit = Math.max(0, Math.min(100, score))

  // Blockers on budget/space are disqualifying regardless of the numeric score.
  const hardBlocked = blockers.some(
    (b) => b.startsWith('Budget is incompatible') || b.startsWith('Property is too small')
  )

  let result: QualificationResult['qualification_result']
  if (hardBlocked) result = 'UNQUALIFIED'
  else if (fit >= 70) result = 'QUALIFIED'
  else if (fit >= 45) result = 'PARTIALLY_QUALIFIED'
  else result = 'UNQUALIFIED'

  return { fit_score: fit, qualification_result: result, reasoning, blockers }
}

function fmt(n: number): string {
  return new Intl.NumberFormat('id-ID', { maximumFractionDigits: 0 }).format(Math.round(n))
}

/**
 * DR-003 — a lead must always carry property context. Enforced at the DB level
 * too (leads.property_id NOT NULL), this keeps the rule explicit in the domain.
 */
export function assertLeadContext(propertyId?: string | null, tenantId?: string | null): void {
  if (!propertyId) {
    throw new BusinessRuleViolation('A lead requires property context.', 'DR-003', {
      field: 'property_id'
    })
  }
  if (!tenantId) {
    throw new BusinessRuleViolation('A lead requires a tenant.', 'DR-003', { field: 'tenant_id' })
  }
}
