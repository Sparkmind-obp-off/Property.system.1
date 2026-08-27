/**
 * Negotiation domain rules.
 * Traceability: PS-MASTER-001 §15 | PS-DATA-009 §29 | DR-006, DR-007
 *
 * PURE domain logic: no HTTP, no DB, no framework imports.
 *
 * Lifecycle: OPEN → COUNTER_OFFER → AGREED  |  OPEN/COUNTER_OFFER → FAILED
 */
import { BusinessRuleViolation, InvalidStateTransition } from '../../../shared/errors'

export type NegotiationStatus = 'OPEN' | 'COUNTER_OFFER' | 'AGREED' | 'FAILED'

export const NEGOTIATION_TRANSITIONS: Record<NegotiationStatus, readonly NegotiationStatus[]> = {
  OPEN: ['COUNTER_OFFER', 'AGREED', 'FAILED'],
  COUNTER_OFFER: ['COUNTER_OFFER', 'AGREED', 'FAILED'],
  AGREED: [],
  FAILED: []
}

export function assertNegotiationTransition(from: NegotiationStatus, to: NegotiationStatus): void {
  const allowed = NEGOTIATION_TRANSITIONS[from] ?? []
  if (!allowed.includes(to)) {
    throw new InvalidStateTransition('Negotiation', from, to, allowed)
  }
}

/**
 * DR-006 — a negotiation requires an actual commercial opportunity: the lead
 * must have progressed to at least a qualified/visited stage.
 */
const NEGOTIABLE_LEAD_STAGES = ['QUALIFIED', 'INTERESTED', 'VISITED', 'NEGOTIATION']

export function assertNegotiable(leadStatus: string): void {
  if (!NEGOTIABLE_LEAD_STAGES.includes(leadStatus)) {
    throw new BusinessRuleViolation(
      'Negotiation requires a qualified or visited lead.',
      'DR-006',
      { lead_status: leadStatus, allowed: NEGOTIABLE_LEAD_STAGES }
    )
  }
}

/** A property that is already occupied cannot be negotiated for. */
export function assertNegotiableProperty(availability: string): void {
  if (availability === 'RENTED') {
    throw new BusinessRuleViolation(
      'Property is already rented — negotiation is not possible.',
      'DR-008',
      { availability_status: availability }
    )
  }
}

/** Only one live negotiation may exist per lead (avoids conflicting prices). */
export function assertNoOpenNegotiation(openCount: number): void {
  if (openCount > 0) {
    throw new BusinessRuleViolation(
      'This lead already has an open negotiation.',
      'DR-006',
      { open_negotiations: openCount }
    )
  }
}

export interface PriceProposal {
  current_price: number
  proposed_price: number
}

/** Prices must be positive and commercially sane. */
export function assertPriceProposal(p: PriceProposal): void {
  if (p.current_price <= 0) {
    throw new BusinessRuleViolation('Current price must be greater than zero.', 'DR-006', {
      field: 'current_price'
    })
  }
  if (p.proposed_price <= 0) {
    throw new BusinessRuleViolation('Proposed price must be greater than zero.', 'DR-006', {
      field: 'proposed_price'
    })
  }
}

/**
 * DR-007 — acceptance must be explicit and must carry an agreed price.
 * The agreed price becomes the rental price.
 */
export function assertAgreement(agreedPrice: number | null | undefined): number {
  if (agreedPrice === null || agreedPrice === undefined || agreedPrice <= 0) {
    throw new BusinessRuleViolation(
      'Accepting a negotiation requires an explicit agreed price.',
      'DR-007',
      { field: 'agreed_price' }
    )
  }
  return agreedPrice
}

export interface DiscountAnalysis {
  discount_amount: number
  discount_percent: number
  severity: 'NONE' | 'LOW' | 'MODERATE' | 'HIGH'
  note: string
}

/** Explainable concession analysis shown on the negotiation screen. */
export function analyzeDiscount(listPrice: number, agreedPrice: number): DiscountAnalysis {
  const amount = Math.max(0, listPrice - agreedPrice)
  const percent = listPrice > 0 ? Number(((amount / listPrice) * 100).toFixed(1)) : 0
  let severity: DiscountAnalysis['severity'] = 'NONE'
  if (percent > 20) severity = 'HIGH'
  else if (percent > 10) severity = 'MODERATE'
  else if (percent > 0) severity = 'LOW'

  const note =
    severity === 'NONE'
      ? 'Agreed at or above the listed price.'
      : `Concession of ${percent}% against the listed price.`
  return { discount_amount: amount, discount_percent: percent, severity, note }
}
