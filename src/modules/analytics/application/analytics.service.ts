/**
 * Analytics — application service (read/analysis layer).
 * Traceability: PS-MASTER-001 §20, §54, §55 | PS-DATA-009 §33 | PS-IMP-011 §20
 *
 * Rule (§54): analytics is a READ layer over domain data. It never re-implements
 * a business rule and never mutates domain state.
 */
import { findMany, findOne } from '../../../shared/repository'

const FUNNEL_STAGES = [
  'NEW',
  'CONTACTED',
  'RESPONDED',
  'QUALIFIED',
  'INTERESTED',
  'VISIT_SCHEDULED',
  'VISITED',
  'NEGOTIATION',
  'WON'
] as const

/** Stages a lead must have passed through to have reached `status`. */
const STAGE_ORDER: Record<string, number> = {
  NEW: 0,
  CONTACTED: 1,
  RESPONDED: 2,
  QUALIFIED: 3,
  INTERESTED: 4,
  VISIT_SCHEDULED: 5,
  VISITED: 6,
  NEGOTIATION: 7,
  WON: 8,
  LOST: -1
}

export interface FunnelStep {
  stage: string
  label: string
  reached: number
  conversion_from_previous: number
  conversion_from_top: number
}

export class AnalyticsService {
  constructor(private db: D1Database) {}

  /**
   * Core funnel: LEAD → QUALIFIED → VISIT → NEGOTIATION → RENTAL (§20).
   *
   * "reached" counts leads that got at least this far. Because LOST leads keep
   * their last productive stage in the activity trail, the cumulative count is
   * derived from the furthest stage recorded on each lead.
   */
  async funnel(params: { from?: string; to?: string; property_id?: string } = {}) {
    const rows = await findMany<{ status: string; c: number; max_stage: number }>(
      this.db,
      `SELECT l.status AS status, COUNT(*) AS c,
              MAX(CASE
                WHEN l.status = 'LOST' THEN COALESCE(
                  (SELECT MAX(
                     CASE json_extract(a.metadata, '$.to')
                       WHEN 'NEW' THEN 0 WHEN 'CONTACTED' THEN 1 WHEN 'RESPONDED' THEN 2
                       WHEN 'QUALIFIED' THEN 3 WHEN 'INTERESTED' THEN 4
                       WHEN 'VISIT_SCHEDULED' THEN 5 WHEN 'VISITED' THEN 6
                       WHEN 'NEGOTIATION' THEN 7 ELSE 0 END)
                     FROM activities a
                    WHERE a.lead_id = l.id AND a.activity_type = 'STATUS_CHANGE'), 0)
                ELSE 0 END) AS max_stage
         FROM leads l
        WHERE 1 = 1
          ${params.property_id ? 'AND l.property_id = ?' : ''}
          ${params.from ? 'AND date(l.created_at) >= date(?)' : ''}
          ${params.to ? 'AND date(l.created_at) <= date(?)' : ''}
        GROUP BY l.status`,
      [params.property_id, params.from, params.to].filter((x) => x !== undefined && x !== null) as unknown[]
    )

    // Distribution of leads currently sitting in each status.
    const current = new Map<string, number>()
    let lostFurthest = 0
    for (const r of rows) {
      current.set(r.status, Number(r.c))
      if (r.status === 'LOST') lostFurthest = Number(r.max_stage ?? 0)
    }

    const total = [...current.values()].reduce((a, b) => a + b, 0)
    const lost = current.get('LOST') ?? 0

    // Cumulative "reached at least stage N" — live leads plus lost leads whose
    // furthest recorded stage is at or beyond N.
    const reachedAt = (stage: string) => {
      const idx = STAGE_ORDER[stage]
      let n = 0
      for (const [st, c] of current) {
        if (st === 'LOST') continue
        if (STAGE_ORDER[st] >= idx) n += c
      }
      if (lost > 0 && lostFurthest >= idx) n += lost
      return n
    }

    const labels: Record<string, string> = {
      NEW: 'Lead masuk',
      CONTACTED: 'Dihubungi',
      RESPONDED: 'Merespons',
      QUALIFIED: 'Terkualifikasi',
      INTERESTED: 'Tertarik',
      VISIT_SCHEDULED: 'Visit dijadwalkan',
      VISITED: 'Visit selesai',
      NEGOTIATION: 'Negosiasi',
      WON: 'Rental (won)'
    }

    const steps: FunnelStep[] = []
    let previous = 0
    for (const [i, stage] of FUNNEL_STAGES.entries()) {
      const reached = i === 0 ? total : reachedAt(stage)
      steps.push({
        stage,
        label: labels[stage],
        reached,
        conversion_from_previous: previous > 0 ? Math.round((reached / previous) * 1000) / 10 : i === 0 ? 100 : 0,
        conversion_from_top: total > 0 ? Math.round((reached / total) * 1000) / 10 : 0
      })
      previous = reached
    }

    const won = current.get('WON') ?? 0
    const qualified = reachedAt('QUALIFIED')
    const visited = reachedAt('VISITED')
    const negotiated = reachedAt('NEGOTIATION')

    return {
      steps,
      status_distribution: Object.fromEntries(current),
      rates: {
        total_leads: total,
        qualification_rate: total > 0 ? Math.round((qualified / total) * 1000) / 10 : 0,
        visit_rate: total > 0 ? Math.round((visited / total) * 1000) / 10 : 0,
        negotiation_rate: total > 0 ? Math.round((negotiated / total) * 1000) / 10 : 0,
        rental_conversion_rate: total > 0 ? Math.round((won / total) * 1000) / 10 : 0,
        loss_rate: total > 0 ? Math.round((lost / total) * 1000) / 10 : 0
      }
    }
  }

  /** Time-to-rental: median/average days from lead creation to rental activation. */
  async timeToRental() {
    const rows = await findMany<{ days: number }>(
      this.db,
      `SELECT CAST(julianday(r.activated_at) - julianday(l.created_at) AS INTEGER) AS days
         FROM rentals r
         JOIN leads l ON l.id = r.lead_id
        WHERE r.activated_at IS NOT NULL AND r.lead_id IS NOT NULL
        ORDER BY days ASC`
    )
    const values = rows.map((r) => Number(r.days)).filter((n) => Number.isFinite(n) && n >= 0)
    if (values.length === 0) {
      return { sample_size: 0, average_days: null, median_days: null, fastest_days: null, slowest_days: null }
    }
    const mid = Math.floor(values.length / 2)
    return {
      sample_size: values.length,
      average_days: Math.round((values.reduce((a, b) => a + b, 0) / values.length) * 10) / 10,
      median_days: values.length % 2 === 0 ? (values[mid - 1] + values[mid]) / 2 : values[mid],
      fastest_days: values[0],
      slowest_days: values[values.length - 1]
    }
  }

  /** Per-property commercial performance (§20 property performance). */
  async propertyPerformance(limit = 20) {
    return findMany(
      this.db,
      `SELECT p.id, p.name, p.property_type, p.price, p.price_period,
              p.availability_status, p.lifecycle_status,
              (SELECT overall_score FROM property_analyses pa
                WHERE pa.property_id = p.id ORDER BY pa.created_at DESC LIMIT 1) AS analysis_score,
              (SELECT COUNT(*) FROM leads l WHERE l.property_id = p.id)                  AS total_leads,
              (SELECT COUNT(*) FROM leads l WHERE l.property_id = p.id
                 AND l.status = 'WON')                                                   AS won_leads,
              (SELECT COUNT(*) FROM leads l WHERE l.property_id = p.id
                 AND l.status = 'LOST')                                                  AS lost_leads,
              (SELECT COUNT(*) FROM visits v WHERE v.property_id = p.id
                 AND v.status = 'COMPLETED')                                             AS completed_visits,
              (SELECT COUNT(*) FROM offers o WHERE o.property_id = p.id
                 AND o.status = 'ACTIVE')                                                AS active_offers,
              (SELECT COUNT(*) FROM rentals r WHERE r.property_id = p.id
                 AND r.status IN ('ACTIVE','EXPIRING'))                                  AS active_rentals
         FROM properties p
        WHERE p.lifecycle_status != 'INACTIVE'
        ORDER BY total_leads DESC, p.created_at DESC
        LIMIT ?`,
      [limit]
    )
  }

  /** Campaign / channel performance (§20 campaign performance). */
  async campaignPerformance() {
    const campaigns = await findMany(
      this.db,
      `SELECT c.id, c.name, c.channel, c.status, c.budget, c.start_at, c.end_at,
              o.title AS offer_title, p.name AS property_name,
              (SELECT COUNT(*) FROM leads l WHERE l.campaign_id = c.id)               AS leads,
              (SELECT COUNT(*) FROM leads l WHERE l.campaign_id = c.id
                 AND l.status IN ('QUALIFIED','INTERESTED','VISIT_SCHEDULED','VISITED','NEGOTIATION','WON'))
                                                                                       AS qualified_leads,
              (SELECT COUNT(*) FROM leads l WHERE l.campaign_id = c.id
                 AND l.status = 'WON')                                                 AS won_leads
         FROM campaigns c
         JOIN offers o     ON o.id = c.offer_id
         JOIN properties p ON p.id = o.property_id
        ORDER BY leads DESC, c.created_at DESC`
    )

    const bySource = await findMany(
      this.db,
      `SELECT source,
              COUNT(*) AS leads,
              SUM(CASE WHEN status = 'WON' THEN 1 ELSE 0 END) AS won,
              SUM(CASE WHEN status = 'LOST' THEN 1 ELSE 0 END) AS lost
         FROM leads
        GROUP BY source
        ORDER BY leads DESC`
    )

    return {
      campaigns: campaigns.map((c: Record<string, unknown>) => ({
        ...c,
        conversion_rate:
          Number(c.leads) > 0 ? Math.round((Number(c.won_leads) / Number(c.leads)) * 1000) / 10 : 0,
        cost_per_lead:
          Number(c.budget) > 0 && Number(c.leads) > 0
            ? Math.round((Number(c.budget) / Number(c.leads)) * 100) / 100
            : null
      })),
      by_source: bySource.map((s: Record<string, unknown>) => ({
        ...s,
        conversion_rate: Number(s.leads) > 0 ? Math.round((Number(s.won) / Number(s.leads)) * 1000) / 10 : 0
      }))
    }
  }

  /** Qualification outcome breakdown. */
  async qualificationBreakdown() {
    const rows = await findMany(
      this.db,
      `SELECT qualification_result, COUNT(*) AS c, ROUND(AVG(fit_score), 1) AS avg_fit_score
         FROM lead_qualifications
        GROUP BY qualification_result`
    )
    const visits = await findMany(
      this.db,
      `SELECT result, COUNT(*) AS c
         FROM visits
        WHERE status = 'COMPLETED' AND result IS NOT NULL
        GROUP BY result`
    )
    return { qualification: rows, visit_results: visits }
  }

  /** Monthly trend of leads created vs rentals activated (last 6 months). */
  async trend(months = 6) {
    const leads = await findMany(
      this.db,
      `SELECT strftime('%Y-%m', created_at) AS period, COUNT(*) AS c
         FROM leads
        WHERE created_at >= date('now', ?)
        GROUP BY period ORDER BY period ASC`,
      [`-${months} months`]
    )
    const rentals = await findMany(
      this.db,
      `SELECT strftime('%Y-%m', activated_at) AS period, COUNT(*) AS c, COALESCE(SUM(price), 0) AS revenue
         FROM rentals
        WHERE activated_at IS NOT NULL AND activated_at >= date('now', ?)
        GROUP BY period ORDER BY period ASC`,
      [`-${months} months`]
    )
    const periods = new Set<string>([
      ...leads.map((r: Record<string, unknown>) => String(r.period)),
      ...rentals.map((r: Record<string, unknown>) => String(r.period))
    ])
    return [...periods].sort().map((period) => ({
      period,
      leads: Number(leads.find((r: Record<string, unknown>) => r.period === period)?.c ?? 0),
      rentals: Number(rentals.find((r: Record<string, unknown>) => r.period === period)?.c ?? 0),
      revenue: Number(rentals.find((r: Record<string, unknown>) => r.period === period)?.revenue ?? 0)
    }))
  }

  /** Full analytics overview used by the Analytics screen. */
  async overview() {
    const [funnel, ttr, properties, campaigns, qualification, trend] = await Promise.all([
      this.funnel(),
      this.timeToRental(),
      this.propertyPerformance(10),
      this.campaignPerformance(),
      this.qualificationBreakdown(),
      this.trend()
    ])
    return { funnel, time_to_rental: ttr, property_performance: properties, campaigns, qualification, trend }
  }

  /** Market intelligence read model: who is most likely to rent here? (§21) */
  async marketIntelligence() {
    const areas = await findMany(
      this.db,
      `SELECT ma.id, ma.name, ma.description, ma.market_notes,
              (SELECT COUNT(*) FROM properties p WHERE p.market_area_id = ma.id)  AS properties,
              (SELECT COUNT(*) FROM businesses b WHERE b.market_area_id = ma.id)  AS nearby_businesses,
              (SELECT COUNT(*) FROM leads l
                 JOIN properties p2 ON p2.id = l.property_id
                WHERE p2.market_area_id = ma.id)                                   AS leads
         FROM market_areas ma
        ORDER BY properties DESC, ma.name ASC`
    )
    const categories = await findMany(
      this.db,
      `SELECT b.category, COUNT(*) AS businesses, ROUND(AVG(b.distance_from_property), 0) AS avg_distance
         FROM businesses b
        GROUP BY b.category
        ORDER BY businesses DESC`
    )
    const segments = await findMany(
      this.db,
      `SELECT ts.id, ts.name, ts.business_category, ts.status,
              ts.minimum_space, ts.maximum_space, ts.budget_min, ts.budget_max,
              (SELECT COUNT(*) FROM tenants t
                WHERE t.business_category = ts.business_category)              AS tenants,
              (SELECT COUNT(*) FROM tenant_property_matches m
                WHERE m.tenant_segment_id = ts.id
                  AND m.recommendation IN ('HIGH_FIT','MEDIUM_FIT'))           AS viable_matches,
              (SELECT COUNT(*) FROM offers o WHERE o.tenant_segment_id = ts.id) AS offers
         FROM tenant_segments ts
        ORDER BY viable_matches DESC, tenants DESC, ts.name ASC`
    )
    const demand = await findMany(
      this.db,
      `SELECT t.business_category AS category,
              COUNT(DISTINCT t.id) AS tenants,
              COUNT(l.id)          AS leads,
              SUM(CASE WHEN l.status = 'WON' THEN 1 ELSE 0 END) AS won
         FROM tenants t
         LEFT JOIN leads l ON l.tenant_id = t.id
        GROUP BY t.business_category
        ORDER BY leads DESC, tenants DESC`
    )
    return {
      areas,
      business_categories: categories,
      segments,
      demand_signals: demand.map((d: Record<string, unknown>) => ({
        ...d,
        win_rate: Number(d.leads) > 0 ? Math.round((Number(d.won) / Number(d.leads)) * 1000) / 10 : 0
      }))
    }
  }
}

export async function analyticsHealth(db: D1Database) {
  return findOne(db, 'SELECT COUNT(*) AS c FROM analytics_records')
}
