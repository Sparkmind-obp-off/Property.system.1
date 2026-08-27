/**
 * Property + Property Intelligence + Tenant-Fit HTTP routes.
 * Traceability: PS-DATA-009 §40–§43, §55 | PS-UX-010 §46 | PS-IMP-011 §23, §24
 */
import { Hono } from 'hono'
import { authenticate, requirePermission } from '../../../shared/middleware'
import { created, ok, paginated, readPagination, readSort } from '../../../shared/http'
import { v, validateBody } from '../../../shared/validate'
import { PropertyService } from '../application/property.service'
import { AnalysisService } from '../../intelligence/application/analysis.service'
import { MatchingService } from '../../matching/application/matching.service'
import { PRICE_PERIODS, PROPERTY_TYPES, type Env } from '../../../shared/types'

export const propertyRoutes = new Hono<Env>()

propertyRoutes.use('*', authenticate)

/** GET /api/v1/properties */
propertyRoutes.get('/', requirePermission('property.read'), async (c) => {
  const { page, limit, offset } = readPagination(c)
  const orderBy = readSort(c, PropertyService.sortable, 'created_at DESC')
  const svc = new PropertyService(c.env.DB)
  const { rows, total } = await svc.list({
    page,
    limit,
    offset,
    orderBy,
    search: c.req.query('search'),
    lifecycle_status: c.req.query('lifecycle_status'),
    availability_status: c.req.query('availability_status'),
    property_type: c.req.query('property_type'),
    price_min: c.req.query('price_min') ? Number(c.req.query('price_min')) : undefined,
    price_max: c.req.query('price_max') ? Number(c.req.query('price_max')) : undefined
  })
  return paginated(c, rows, page, limit, total)
})

/** POST /api/v1/properties */
propertyRoutes.post('/', requirePermission('property.create'), async (c) => {
  const body = await validateBody(c.req.raw)
  const input = v(body)
    .string('name', { required: true, min: 2, max: 160 })
    .enum('property_type', PROPERTY_TYPES, { required: true })
    .string('address', { required: true, min: 4, max: 500 })
    .number('price', { required: true, min: 0 })
    .enum('price_period', PRICE_PERIODS, { required: true })
    .number('width', { min: 0 })
    .number('length', { min: 0 })
    .number('area_size', { min: 0 })
    .number('latitude', { min: -90, max: 90 })
    .number('longitude', { min: -180, max: 180 })
    .string('description', { max: 4000 })
    .string('market_area_id', { max: 40 })
    .result<any>()

  const svc = new PropertyService(c.env.DB)
  const property = await svc.create(input, c.var.user!.id, c.var.requestId)
  return created(c, property)
})

/** GET /api/v1/properties/:id */
propertyRoutes.get('/:id', requirePermission('property.read'), async (c) => {
  const svc = new PropertyService(c.env.DB)
  return ok(c, await svc.get(c.req.param('id')))
})

/** PATCH /api/v1/properties/:id */
propertyRoutes.patch('/:id', requirePermission('property.update'), async (c) => {
  const body = await validateBody(c.req.raw)
  const patch = v(body)
    .string('name', { min: 2, max: 160 })
    .enum('property_type', PROPERTY_TYPES)
    .string('address', { min: 4, max: 500 })
    .number('price', { min: 0 })
    .enum('price_period', PRICE_PERIODS)
    .number('width', { min: 0 })
    .number('length', { min: 0 })
    .number('area_size', { min: 0 })
    .number('latitude', { min: -90, max: 90 })
    .number('longitude', { min: -180, max: 180 })
    .string('description', { max: 4000 })
    .string('market_area_id', { max: 40 })
    .result<any>()

  const svc = new PropertyService(c.env.DB)
  return ok(c, await svc.update(c.req.param('id'), patch, c.var.user!.id, c.var.requestId))
})

/**
 * POST /api/v1/properties/:id/verify — explicit lifecycle action (§55).
 * Status transitions with business rules never go through PATCH.
 */
propertyRoutes.post('/:id/verify', requirePermission('property.verify'), async (c) => {
  const svc = new PropertyService(c.env.DB)
  return ok(c, await svc.verify(c.req.param('id'), c.var.user!.id, c.var.requestId))
})

/** POST /api/v1/properties/:id/market */
propertyRoutes.post('/:id/market', requirePermission('property.market'), async (c) => {
  const svc = new PropertyService(c.env.DB)
  return ok(c, await svc.market(c.req.param('id'), c.var.user!.id, c.var.requestId))
})

/** DELETE /api/v1/properties/:id — critical action, archives when history exists. */
propertyRoutes.delete('/:id', requirePermission('property.delete'), async (c) => {
  const svc = new PropertyService(c.env.DB)
  return ok(c, await svc.remove(c.req.param('id'), c.var.user!.id, c.var.requestId))
})

/* ----------------------- Property Intelligence ---------------------------- */

/** POST /api/v1/properties/:id/analysis */
propertyRoutes.post('/:id/analysis', requirePermission('property.analyze'), async (c) => {
  const body = await validateBody(c.req.raw)
  const input = v(body)
    .integer('access_score', { required: true, min: 0, max: 10 })
    .integer('visibility_score', { required: true, min: 0, max: 10 })
    .integer('location_score', { required: true, min: 0, max: 10 })
    .integer('space_score', { required: true, min: 0, max: 10 })
    .stringArray('strengths', { maxItems: 20 })
    .stringArray('weaknesses', { maxItems: 20 })
    .stringArray('opportunities', { maxItems: 20 })
    .stringArray('risks', { maxItems: 20 })
    .stringArray('recommended_uses', { maxItems: 20 })
    .result<any>()

  const svc = new AnalysisService(c.env.DB)
  const analysis = await svc.analyze(c.req.param('id'), input, c.var.user!.id, c.var.requestId)
  return created(c, analysis)
})

/** GET /api/v1/properties/:id/analysis */
propertyRoutes.get('/:id/analysis', requirePermission('property.read'), async (c) => {
  const svc = new AnalysisService(c.env.DB)
  return ok(c, await svc.history(c.req.param('id')))
})

/* --------------------------- Tenant Fit / Matching ------------------------ */

/**
 * POST /api/v1/properties/:id/tenant-fit
 * Body: { tenant_segment_id } | { tenant_id } | {} → rank all segments.
 */
propertyRoutes.post('/:id/tenant-fit', requirePermission('match.execute'), async (c) => {
  const body = (await c.req.raw
    .clone()
    .json()
    .catch(() => ({}))) as any
  const svc = new MatchingService(c.env.DB)
  const propertyId = c.req.param('id')

  if (body?.tenant_id || body?.tenant_segment_id) {
    const result = await svc.match(propertyId, {
      tenant_id: body.tenant_id,
      tenant_segment_id: body.tenant_segment_id
    })
    return ok(c, result)
  }

  // No subject → decision-support ranking across all active segments.
  const ranked = await svc.rankSegments(propertyId)
  return ok(c, ranked, { mode: 'SEGMENT_RANKING', count: ranked.length })
})

/** GET /api/v1/properties/:id/matches — persisted match history. */
propertyRoutes.get('/:id/matches', requirePermission('property.read'), async (c) => {
  const svc = new MatchingService(c.env.DB)
  return ok(c, await svc.history(c.req.param('id')))
})

/** GET /api/v1/properties/:id/leads — property pipeline panel. */
propertyRoutes.get('/:id/leads', requirePermission('lead.read'), async (c) => {
  const rows = await c.env.DB.prepare(
    `SELECT l.id, l.status, l.temperature, l.score, l.source, l.created_at,
            t.name AS tenant_name, t.business_category
       FROM leads l JOIN tenants t ON t.id = l.tenant_id
      WHERE l.property_id = ?
      ORDER BY l.created_at DESC LIMIT 100`
  )
    .bind(c.req.param('id'))
    .all()
  return ok(c, rows.results ?? [])
})
