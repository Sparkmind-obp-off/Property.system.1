/**
 * Tenant Fit Engine — PURE domain service.
 * Traceability: PS-TECH-008 §21 (weights) | PS-IMP-011 §11 | PS-MASTER-001 §8
 *               PS-DATA-009 §19, §62
 *
 * Semantics: FIT SCORE = DECISION SUPPORT, never a guaranteed rental (§62).
 * Every score MUST carry reasons; scoring weights are configurable.
 */

/** Baseline weights (PS-TECH-008 §21). Must sum to 1.0. */
export const DEFAULT_WEIGHTS = {
  location: 0.2,
  demand: 0.2,
  property: 0.15,
  price: 0.15,
  business: 0.15,
  competition: 0.1,
  operational: 0.05
} as const

export type FitWeights = typeof DEFAULT_WEIGHTS

export interface PropertyFacts {
  id: string
  property_type: string
  price: number
  price_period: string
  area_size: number | null
  width: number | null
  length: number | null
  location_score?: number | null
  access_score?: number | null
  visibility_score?: number | null
  space_score?: number | null
  /** Count of nearby businesses in the same category (competition signal). */
  same_category_nearby?: number
  /** Count of nearby businesses overall (demand signal). */
  total_nearby?: number
  recommended_uses?: string[]
}

export interface DemandFacts {
  business_category: string
  budget_min: number | null
  budget_max: number | null
  space_need: number | null
  minimum_space?: number | null
  maximum_space?: number | null
  location_preference?: string | null
  /** Property types the segment/tenant considers acceptable. */
  acceptable_types?: string[]
}

export interface FitComponent {
  key: keyof FitWeights
  score: number
  weight: number
  reason: string
  positive: boolean
}

export interface FitResult {
  fit_score: number
  recommendation: 'HIGH_FIT' | 'MEDIUM_FIT' | 'LOW_FIT' | 'NO_FIT'
  components: FitComponent[]
  component_scores: {
    location_score: number
    demand_score: number
    space_score: number
    price_score: number
    business_score: number
    competition_score: number
    operational_score: number
  }
  reasoning: string[]
  mismatches: string[]
  risks: string[]
}

/** Normalize a monthly-equivalent price so MONTH vs YEAR compare correctly. */
export function monthlyEquivalent(price: number, period: string): number {
  return period === 'YEAR' ? price / 12 : price
}

function clamp(n: number): number {
  return Math.max(0, Math.min(100, Math.round(n)))
}

/** Business-category ↔ property-type suitability matrix. */
const CATEGORY_TYPE_FIT: Record<string, string[]> = {
  UMKM: ['SHOPHOUSE', 'KIOSK', 'COMMERCIAL_SPACE'],
  BARBER: ['SHOPHOUSE', 'KIOSK', 'COMMERCIAL_SPACE'],
  LAUNDRY: ['SHOPHOUSE', 'COMMERCIAL_SPACE', 'HOUSE'],
  FOOD_BUSINESS: ['SHOPHOUSE', 'KIOSK', 'COMMERCIAL_SPACE'],
  SERVICE_BUSINESS: ['SHOPHOUSE', 'KIOSK', 'COMMERCIAL_SPACE', 'HOUSE'],
  RETAIL: ['SHOPHOUSE', 'KIOSK', 'COMMERCIAL_SPACE'],
  WORKSHOP: ['WAREHOUSE', 'COMMERCIAL_SPACE', 'LAND'],
  OTHER: ['SHOPHOUSE', 'KIOSK', 'HOUSE', 'COMMERCIAL_SPACE', 'WAREHOUSE', 'LAND', 'OTHER']
}

/**
 * Compute the fit between a property and a demand profile (tenant or segment).
 */
export function computeFit(
  property: PropertyFacts,
  demand: DemandFacts,
  weights: FitWeights = DEFAULT_WEIGHTS
): FitResult {
  const components: FitComponent[] = []
  const reasoning: string[] = []
  const mismatches: string[] = []
  const risks: string[] = []

  /* ---------------------------- 1. Location fit --------------------------- */
  const locationRaw = property.location_score ?? null
  const locationScore = locationRaw !== null ? clamp(locationRaw * 10) : 60
  if (locationRaw === null) {
    risks.push('Location not yet analyzed — score uses a neutral baseline')
  } else if (locationScore >= 70) {
    reasoning.push('Location compatible with target demand')
  } else {
    mismatches.push('Location strength below target expectation')
  }
  components.push({
    key: 'location',
    score: locationScore,
    weight: weights.location,
    reason: locationRaw === null ? 'No location analysis available' : `Location score ${locationRaw}/10`,
    positive: locationScore >= 70
  })

  /* ----------------------------- 2. Demand fit ---------------------------- */
  const nearby = property.total_nearby ?? 0
  const demandScore = nearby === 0 ? 50 : clamp(50 + Math.min(50, nearby * 8))
  if (nearby > 0) {
    reasoning.push(`Area activity compatible (${nearby} nearby business${nearby > 1 ? 'es' : ''})`)
  } else {
    risks.push('No surrounding business data recorded — demand is unverified')
  }
  components.push({
    key: 'demand',
    score: demandScore,
    weight: weights.demand,
    reason: nearby === 0 ? 'No market data recorded' : `${nearby} nearby businesses indicate economic activity`,
    positive: demandScore >= 70
  })

  /* ------------------- 3. Property/space fit (size match) ----------------- */
  const size = property.area_size ?? (property.width && property.length ? property.width * property.length : null)
  const need = demand.space_need ?? demand.minimum_space ?? null
  let spaceScore = 60
  if (size === null) {
    risks.push('Property size not recorded — space fit unverified')
    spaceScore = 50
  } else if (need === null) {
    spaceScore = 70
  } else if (size >= need) {
    const ratio = need / size
    // Ideal band: property is big enough but not wastefully oversized.
    spaceScore = ratio >= 0.6 ? 100 : ratio >= 0.35 ? 85 : 70
    reasoning.push(`Space compatible (${size} m² available for ${need} m² need)`)
  } else {
    const deficit = ((need - size) / need) * 100
    spaceScore = clamp(100 - deficit * 2)
    mismatches.push(`Space below requirement (${size} m² vs ${need} m² needed)`)
  }
  if (demand.maximum_space && size && size > demand.maximum_space) {
    mismatches.push(`Property larger than segment maximum (${size} m² > ${demand.maximum_space} m²)`)
    spaceScore = Math.min(spaceScore, 60)
  }
  components.push({
    key: 'property',
    score: spaceScore,
    weight: weights.property,
    reason: size === null ? 'Size unknown' : `Property ${size} m² vs requirement ${need ?? 'unspecified'} m²`,
    positive: spaceScore >= 70
  })

  /* ------------------------------ 4. Price fit ---------------------------- */
  const propMonthly = monthlyEquivalent(property.price, property.price_period)
  const budgetMax = demand.budget_max
  const budgetMin = demand.budget_min
  let priceScore = 60
  if (budgetMax === null || budgetMax === undefined) {
    priceScore = 60
    risks.push('Budget not recorded — price fit unverified')
  } else {
    const maxMonthly = monthlyEquivalent(budgetMax, property.price_period)
    if (propMonthly <= maxMonthly) {
      const headroom = (maxMonthly - propMonthly) / maxMonthly
      priceScore = headroom >= 0.3 ? 100 : 90
      reasoning.push('Budget compatible')
    } else {
      const over = (propMonthly - maxMonthly) / maxMonthly
      priceScore = clamp(100 - over * 180)
      mismatches.push(`Price exceeds budget by ${Math.round(over * 100)}%`)
    }
    if (budgetMin !== null && budgetMin !== undefined) {
      const minMonthly = monthlyEquivalent(budgetMin, property.price_period)
      if (propMonthly < minMonthly * 0.5) {
        risks.push('Price far below the segment budget — verify positioning')
      }
    }
  }
  components.push({
    key: 'price',
    score: priceScore,
    weight: weights.price,
    reason: `Property ${Math.round(propMonthly)}/month vs budget ${budgetMax ? Math.round(monthlyEquivalent(budgetMax, property.price_period)) : 'unknown'}/month`,
    positive: priceScore >= 70
  })

  /* ---------------------- 5. Business category fit ------------------------ */
  const acceptable = demand.acceptable_types?.length
    ? demand.acceptable_types
    : CATEGORY_TYPE_FIT[demand.business_category] ?? CATEGORY_TYPE_FIT.OTHER
  const typeMatch = acceptable.includes(property.property_type)
  const recommendedMatch = (property.recommended_uses ?? []).some((u) =>
    u.toUpperCase().replace(/\s+/g, '_').includes(demand.business_category)
  )
  const businessScore = typeMatch ? (recommendedMatch ? 100 : 85) : 40
  if (typeMatch) reasoning.push('Business category compatible with property type')
  else mismatches.push(`${demand.business_category} is a weak fit for ${property.property_type}`)
  components.push({
    key: 'business',
    score: businessScore,
    weight: weights.business,
    reason: typeMatch
      ? `${demand.business_category} suits ${property.property_type}`
      : `${demand.business_category} does not typically operate in ${property.property_type}`,
    positive: typeMatch
  })

  /* ------------------------- 6. Competition fit --------------------------- */
  const sameCat = property.same_category_nearby ?? 0
  let competitionScore = 100
  if (sameCat === 1) competitionScore = 75
  else if (sameCat === 2) competitionScore = 55
  else if (sameCat >= 3) competitionScore = 35
  if (sameCat >= 2) {
    risks.push(`${sameCat} competing ${demand.business_category} businesses already operate nearby`)
  } else if (sameCat === 0) {
    reasoning.push('No direct competitor recorded in the area')
  }
  components.push({
    key: 'competition',
    score: competitionScore,
    weight: weights.competition,
    reason: sameCat === 0 ? 'No direct competitor nearby' : `${sameCat} competitor(s) nearby`,
    positive: competitionScore >= 70
  })

  /* ------------------------- 7. Operational fit --------------------------- */
  const access = property.access_score ?? null
  const visibility = property.visibility_score ?? null
  let operationalScore = 60
  if (access !== null || visibility !== null) {
    const vals = [access, visibility].filter((x): x is number => x !== null)
    operationalScore = clamp((vals.reduce((a, b) => a + b, 0) / vals.length) * 10)
  }
  if (visibility !== null && visibility <= 5) {
    risks.push('Visibility may require a signage strategy')
  }
  components.push({
    key: 'operational',
    score: operationalScore,
    weight: weights.operational,
    reason:
      access === null && visibility === null
        ? 'Access/visibility not analyzed'
        : `Access ${access ?? '-'}/10, visibility ${visibility ?? '-'}/10`,
    positive: operationalScore >= 70
  })

  /* ------------------------------- Aggregate ------------------------------ */
  const fit = components.reduce((sum, c) => sum + c.score * c.weight, 0)
  const fitScore = clamp(fit)

  const recommendation: FitResult['recommendation'] =
    fitScore >= 80 ? 'HIGH_FIT' : fitScore >= 65 ? 'MEDIUM_FIT' : fitScore >= 45 ? 'LOW_FIT' : 'NO_FIT'

  return {
    fit_score: fitScore,
    recommendation,
    components,
    component_scores: {
      location_score: components.find((c) => c.key === 'location')!.score,
      demand_score: components.find((c) => c.key === 'demand')!.score,
      space_score: components.find((c) => c.key === 'property')!.score,
      price_score: components.find((c) => c.key === 'price')!.score,
      business_score: components.find((c) => c.key === 'business')!.score,
      competition_score: components.find((c) => c.key === 'competition')!.score,
      operational_score: components.find((c) => c.key === 'operational')!.score
    },
    reasoning,
    mismatches,
    risks
  }
}
