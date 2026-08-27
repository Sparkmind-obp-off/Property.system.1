/**
 * Matching — application service.
 * Traceability: PS-IMP-011 §11 | PS-DATA-009 §19, §43 | PS-MASTER-001 §8
 *
 * Matching is decision support only. It MUST NOT create a rental (§8).
 */
import { AnalyticsEvent, analyticsStmt } from '../../../shared/audit'
import { ValidationError } from '../../../shared/errors'
import { ID } from '../../../shared/id'
import { findMany, findOne, findOneOrFail, parseJson, transaction } from '../../../shared/repository'
import { computeFit, type DemandFacts, type FitResult, type PropertyFacts } from '../domain/fit-engine'

interface PropertyJoined {
  id: string
  property_type: string
  price: number
  price_period: string
  area_size: number | null
  width: number | null
  length: number | null
  market_area_id: string | null
  name: string
  address: string
  availability_status: string
  lifecycle_status: string
  access_score: number | null
  visibility_score: number | null
  location_score: number | null
  space_score: number | null
  recommended_uses: string | null
}

export class MatchingService {
  constructor(private readonly db: D1Database) {}

  private async propertyFacts(propertyId: string, category: string): Promise<PropertyFacts & { name: string }> {
    const p = await findOneOrFail<PropertyJoined>(
      this.db,
      `SELECT p.*, a.access_score, a.visibility_score, a.location_score, a.space_score, a.recommended_uses
         FROM properties p
         LEFT JOIN property_analyses a
           ON a.id = (SELECT id FROM property_analyses WHERE property_id = p.id ORDER BY created_at DESC LIMIT 1)
        WHERE p.id = ?`,
      [propertyId],
      'Property',
      propertyId
    )

    // Market signals: nearby businesses in the property's market area.
    let totalNearby = 0
    let sameCategory = 0
    if (p.market_area_id) {
      const agg = await findOne<{ total: number; same: number }>(
        this.db,
        `SELECT COUNT(*) AS total,
                SUM(CASE WHEN category = ? THEN 1 ELSE 0 END) AS same
           FROM businesses WHERE market_area_id = ?`,
        [mapCategoryToBusiness(category), p.market_area_id]
      )
      totalNearby = Number(agg?.total ?? 0)
      sameCategory = Number(agg?.same ?? 0)
    }

    return {
      id: p.id,
      name: p.name,
      property_type: p.property_type,
      price: p.price,
      price_period: p.price_period,
      area_size: p.area_size,
      width: p.width,
      length: p.length,
      access_score: p.access_score,
      visibility_score: p.visibility_score,
      location_score: p.location_score,
      space_score: p.space_score,
      total_nearby: totalNearby,
      same_category_nearby: sameCategory,
      recommended_uses: parseJson<string[]>(p.recommended_uses, [])
    }
  }

  /** UC: MatchTenant — property × (tenant | segment) → persisted match result. */
  async match(
    propertyId: string,
    opts: { tenant_id?: string; tenant_segment_id?: string },
    persist = true
  ) {
    if (!opts.tenant_id && !opts.tenant_segment_id) {
      throw new ValidationError('Provide either tenant_id or tenant_segment_id.', {
        tenant_id: 'required when tenant_segment_id is absent'
      })
    }

    let demand: DemandFacts
    let subjectName: string

    if (opts.tenant_id) {
      const t = await findOneOrFail<any>(
        this.db,
        `SELECT * FROM tenants WHERE id = ?`,
        [opts.tenant_id],
        'Tenant',
        opts.tenant_id
      )
      demand = {
        business_category: t.business_category,
        budget_min: t.budget_min,
        budget_max: t.budget_max,
        space_need: t.space_need,
        location_preference: t.location_preference
      }
      subjectName = t.name
    } else {
      const s = await findOneOrFail<any>(
        this.db,
        `SELECT * FROM tenant_segments WHERE id = ?`,
        [opts.tenant_segment_id],
        'Tenant segment',
        opts.tenant_segment_id
      )
      demand = {
        business_category: s.business_category,
        budget_min: s.budget_min,
        budget_max: s.budget_max,
        space_need: s.minimum_space,
        minimum_space: s.minimum_space,
        maximum_space: s.maximum_space
      }
      subjectName = s.name
    }

    const facts = await this.propertyFacts(propertyId, demand.business_category)
    const result = computeFit(facts, demand)

    if (persist) {
      const id = ID.match()
      await transaction(this.db, [
        this.db
          .prepare(
            `INSERT INTO tenant_property_matches
               (id, property_id, tenant_id, tenant_segment_id, fit_score,
                location_score, demand_score, space_score, price_score, business_score,
                competition_score, operational_score, recommendation, reasoning, risks, mismatches)
             VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`
          )
          .bind(
            id,
            propertyId,
            opts.tenant_id ?? null,
            opts.tenant_segment_id ?? null,
            result.fit_score,
            result.component_scores.location_score,
            result.component_scores.demand_score,
            result.component_scores.space_score,
            result.component_scores.price_score,
            result.component_scores.business_score,
            result.component_scores.competition_score,
            result.component_scores.operational_score,
            result.recommendation,
            JSON.stringify(result.reasoning),
            JSON.stringify(result.risks),
            JSON.stringify(result.mismatches)
          ),
        analyticsStmt(this.db, {
          eventType: AnalyticsEvent.MATCH_EXECUTED,
          entityType: 'TENANT_PROPERTY_MATCH',
          entityId: id,
          propertyId,
          value: result.fit_score,
          metadata: { recommendation: result.recommendation }
        })
      ])
      return { id, property_id: propertyId, property_name: facts.name, subject_name: subjectName, ...result }
    }

    return { property_id: propertyId, property_name: facts.name, subject_name: subjectName, ...result }
  }

  /** UC: Rank all active segments against one property (Target Tenants panel). */
  async rankSegments(propertyId: string): Promise<
    Array<FitResult & { tenant_segment_id: string; segment_name: string; business_category: string }>
  > {
    const segments = await findMany<any>(
      this.db,
      `SELECT * FROM tenant_segments WHERE status = 'ACTIVE' ORDER BY name`
    )
    const out: any[] = []
    for (const s of segments) {
      const facts = await this.propertyFacts(propertyId, s.business_category)
      const result = computeFit(facts, {
        business_category: s.business_category,
        budget_min: s.budget_min,
        budget_max: s.budget_max,
        space_need: s.minimum_space,
        minimum_space: s.minimum_space,
        maximum_space: s.maximum_space
      })
      out.push({
        tenant_segment_id: s.id,
        segment_name: s.name,
        business_category: s.business_category,
        ...result
      })
    }
    return out.sort((a, b) => b.fit_score - a.fit_score)
  }

  /** UC: Rank properties for one tenant (Tenant Detail → matched properties). */
  async rankPropertiesForTenant(tenantId: string, limit = 10) {
    const t = await findOneOrFail<any>(
      this.db,
      `SELECT * FROM tenants WHERE id = ?`,
      [tenantId],
      'Tenant',
      tenantId
    )
    const properties = await findMany<{ id: string }>(
      this.db,
      `SELECT id FROM properties
        WHERE lifecycle_status NOT IN ('INACTIVE')
          AND availability_status IN ('AVAILABLE','RESERVED')
        ORDER BY updated_at DESC LIMIT 50`
    )
    const demand: DemandFacts = {
      business_category: t.business_category,
      budget_min: t.budget_min,
      budget_max: t.budget_max,
      space_need: t.space_need,
      location_preference: t.location_preference
    }
    const results: any[] = []
    for (const p of properties) {
      const facts = await this.propertyFacts(p.id, demand.business_category)
      const fit = computeFit(facts, demand)
      results.push({ property_id: p.id, property_name: facts.name, ...fit })
    }
    return results.sort((a, b) => b.fit_score - a.fit_score).slice(0, limit)
  }

  async history(propertyId: string, limit = 20) {
    const rows = await findMany<any>(
      this.db,
      `SELECT m.*, t.name AS tenant_name, s.name AS segment_name
         FROM tenant_property_matches m
         LEFT JOIN tenants t ON t.id = m.tenant_id
         LEFT JOIN tenant_segments s ON s.id = m.tenant_segment_id
        WHERE m.property_id = ?
        ORDER BY m.created_at DESC LIMIT ?`,
      [propertyId, limit]
    )
    return rows.map((r) => ({
      ...r,
      reasoning: parseJson<string[]>(r.reasoning, []),
      risks: parseJson<string[]>(r.risks, []),
      mismatches: parseJson<string[]>(r.mismatches, [])
    }))
  }
}

/** Map tenant business categories onto the `businesses.category` enum. */
function mapCategoryToBusiness(category: string): string {
  const map: Record<string, string> = {
    UMKM: 'RETAIL',
    BARBER: 'BARBER',
    LAUNDRY: 'LAUNDRY',
    FOOD_BUSINESS: 'FOOD',
    SERVICE_BUSINESS: 'SERVICE',
    RETAIL: 'RETAIL',
    WORKSHOP: 'WORKSHOP',
    OTHER: 'OTHER'
  }
  return map[category] ?? 'OTHER'
}
