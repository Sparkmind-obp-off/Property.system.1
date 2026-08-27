/**
 * Offer domain — lifecycle and publication rules.
 * Traceability: PS-MASTER-001 §9 | PS-DATA-009 §20, §21 | DR-002
 *
 * PURE domain logic: no HTTP, no DB, no framework imports.
 *
 * Offer lifecycle (spec §9):
 *   DRAFT → READY → ACTIVE(published) → PAUSED → EXPIRED
 */
import { BusinessRuleViolation, InvalidStateTransition } from '../../../shared/errors'

export type OfferStatus = 'DRAFT' | 'READY' | 'ACTIVE' | 'PAUSED' | 'EXPIRED'

export const OFFER_TRANSITIONS: Record<OfferStatus, readonly OfferStatus[]> = {
  DRAFT: ['READY', 'EXPIRED'],
  READY: ['ACTIVE', 'DRAFT', 'EXPIRED'],
  ACTIVE: ['PAUSED', 'EXPIRED'],
  PAUSED: ['ACTIVE', 'EXPIRED'],
  EXPIRED: []
}

export function assertOfferTransition(from: OfferStatus, to: OfferStatus): void {
  const allowed = OFFER_TRANSITIONS[from] ?? []
  if (!allowed.includes(to)) {
    throw new InvalidStateTransition('Offer', from, to, allowed)
  }
}

export interface OfferPublishFacts {
  title?: string | null
  value_proposition?: string | null
  price?: number | null
  cta?: string | null
  property_lifecycle: string
  property_availability: string
}

/** Requirements before an offer can be published (DR-002 + §9). */
export function publicationGaps(f: OfferPublishFacts): string[] {
  const gaps: string[] = []
  if (!f.title) gaps.push('title')
  if (!f.value_proposition) gaps.push('value_proposition')
  if (f.price === null || f.price === undefined || f.price <= 0) gaps.push('price')
  if (!f.cta) gaps.push('cta')
  return gaps
}

/**
 * An offer may only be published when its property is commercially
 * publishable — verified and not occupied (DR-002).
 */
export function assertPublishable(f: OfferPublishFacts): void {
  const gaps = publicationGaps(f)
  if (gaps.length > 0) {
    throw new BusinessRuleViolation(
      'Offer is missing required information and cannot be published.',
      'DR-002',
      { missing: gaps }
    )
  }
  if (!['VERIFIED', 'ACTIVE', 'MARKETED', 'RESERVED'].includes(f.property_lifecycle)) {
    throw new BusinessRuleViolation(
      'Property must be verified before its offer can be published.',
      'DR-002',
      { property_lifecycle: f.property_lifecycle }
    )
  }
  if (f.property_availability === 'RENTED') {
    throw new BusinessRuleViolation(
      'A rented property cannot have a published offer.',
      'DR-002',
      { property_availability: f.property_availability }
    )
  }
}

export type CampaignStatus = 'DRAFT' | 'RUNNING' | 'PAUSED' | 'ENDED'

export const CAMPAIGN_TRANSITIONS: Record<CampaignStatus, readonly CampaignStatus[]> = {
  DRAFT: ['RUNNING', 'ENDED'],
  RUNNING: ['PAUSED', 'ENDED'],
  PAUSED: ['RUNNING', 'ENDED'],
  ENDED: []
}

export function assertCampaignTransition(from: CampaignStatus, to: CampaignStatus): void {
  const allowed = CAMPAIGN_TRANSITIONS[from] ?? []
  if (!allowed.includes(to)) {
    throw new InvalidStateTransition('Campaign', from, to, allowed)
  }
}

/** A campaign can only run on a published (ACTIVE) offer. */
export function assertCampaignRunnable(offerStatus: OfferStatus): void {
  if (offerStatus !== 'ACTIVE') {
    throw new BusinessRuleViolation(
      'Campaign requires a published (ACTIVE) offer.',
      'DR-002',
      { offer_status: offerStatus }
    )
  }
}
