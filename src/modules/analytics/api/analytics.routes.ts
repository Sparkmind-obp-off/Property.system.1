/**
 * Dashboard + Analytics + Market Intelligence HTTP routes.
 * Traceability: PS-MASTER-001 §19, §20, §21, §33 | PS-DATA-009 §39 | PS-UX-010 §12
 *
 * Every route is read-only: authenticate → authorize (analytics.read /
 * market.read) → query → response. No domain mutation happens here (§54).
 */
import { Hono } from 'hono'

import { ok } from '../../../shared/http'
import { authenticate, requirePermission } from '../../../shared/middleware'
import type { Env } from '../../../shared/types'
import { AnalyticsService } from '../application/analytics.service'
import { DashboardService } from '../application/dashboard.service'

export const dashboardRoutes = new Hono<Env>()
export const analyticsRoutes = new Hono<Env>()
export const marketRoutes = new Hono<Env>()

/* -------------------------------- Dashboard ------------------------------- */

dashboardRoutes.use('*', authenticate)

/** GET /api/v1/dashboard — action center + KPI + recent activity (§19). */
dashboardRoutes.get('/', requirePermission('analytics.read'), async (c) => {
  const svc = new DashboardService(c.env.DB)
  const [actions, kpis, activity] = await Promise.all([
    svc.actionCenter(c.var.user!.id),
    svc.kpis(),
    svc.recentActivity(12)
  ])
  return ok(c, {
    action_center: actions,
    kpis,
    recent_activity: activity
  })
})

/** GET /api/v1/dashboard/action-center — just the work queue. */
dashboardRoutes.get('/action-center', requirePermission('analytics.read'), async (c) =>
  ok(c, await new DashboardService(c.env.DB).actionCenter(c.var.user!.id))
)

/* -------------------------------- Analytics ------------------------------- */

analyticsRoutes.use('*', authenticate)
analyticsRoutes.use('*', requirePermission('analytics.read'))

/** GET /api/v1/analytics/overview — everything the Analytics screen needs. */
analyticsRoutes.get('/overview', async (c) => ok(c, await new AnalyticsService(c.env.DB).overview()))

/** GET /api/v1/analytics/funnel?from&to&property_id — the core commercial funnel. */
analyticsRoutes.get('/funnel', async (c) =>
  ok(
    c,
    await new AnalyticsService(c.env.DB).funnel({
      from: c.req.query('from'),
      to: c.req.query('to'),
      property_id: c.req.query('property_id')
    })
  )
)

analyticsRoutes.get('/time-to-rental', async (c) =>
  ok(c, await new AnalyticsService(c.env.DB).timeToRental())
)

analyticsRoutes.get('/properties', async (c) =>
  ok(c, await new AnalyticsService(c.env.DB).propertyPerformance(Number(c.req.query('limit') ?? 20)))
)

analyticsRoutes.get('/campaigns', async (c) =>
  ok(c, await new AnalyticsService(c.env.DB).campaignPerformance())
)

analyticsRoutes.get('/qualification', async (c) =>
  ok(c, await new AnalyticsService(c.env.DB).qualificationBreakdown())
)

analyticsRoutes.get('/trend', async (c) =>
  ok(c, await new AnalyticsService(c.env.DB).trend(Number(c.req.query('months') ?? 6)))
)

/* --------------------------- Market intelligence -------------------------- */

marketRoutes.use('*', authenticate)

/** GET /api/v1/market — who is most likely to rent here? (§21) */
marketRoutes.get('/', requirePermission('market.read'), async (c) =>
  ok(c, await new AnalyticsService(c.env.DB).marketIntelligence())
)
