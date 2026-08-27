/**
 * Tenant + Tenant Segment HTTP routes.
 * Traceability: PS-DATA-009 §39 | PS-UX-010 §15, §16, §17
 */
import { Hono } from 'hono'
import { authenticate, requirePermission } from '../../../shared/middleware'
import { created, ok, paginated, readPagination, readSort } from '../../../shared/http'
import { v, validateBody } from '../../../shared/validate'
import { SegmentService, TenantService } from '../application/tenant.service'
import { MatchingService } from '../../matching/application/matching.service'
import { BUSINESS_CATEGORIES, TENANT_STATUS, TENANT_TYPES, type Env } from '../../../shared/types'

export const tenantRoutes = new Hono<Env>()
export const segmentRoutes = new Hono<Env>()

tenantRoutes.use('*', authenticate)
segmentRoutes.use('*', authenticate)

/* --------------------------------- Tenants -------------------------------- */

tenantRoutes.get('/', requirePermission('tenant.read'), async (c) => {
  const { page, limit, offset } = readPagination(c)
  const orderBy = readSort(c, TenantService.sortable, 'created_at DESC')
  const svc = new TenantService(c.env.DB)
  const { rows, total } = await svc.list({
    page,
    limit,
    offset,
    orderBy,
    search: c.req.query('search'),
    business_category: c.req.query('business_category'),
    status: c.req.query('status'),
    budget_min: c.req.query('budget_min') ? Number(c.req.query('budget_min')) : undefined,
    space_need_max: c.req.query('space_need_max') ? Number(c.req.query('space_need_max')) : undefined
  })
  return paginated(c, rows, page, limit, total)
})

tenantRoutes.post('/', requirePermission('tenant.create'), async (c) => {
  const body = await validateBody(c.req.raw)
  const input = v(body)
    .string('name', { required: true, min: 2, max: 160 })
    .enum('tenant_type', TENANT_TYPES, { default: 'BUSINESS' })
    .enum('business_category', BUSINESS_CATEGORIES, { required: true })
    .string('contact_name', { max: 120 })
    .string('phone', { max: 40 })
    .email('email')
    .number('budget_min', { min: 0 })
    .number('budget_max', { min: 0 })
    .number('space_need', { min: 0 })
    .string('location_preference', { max: 200 })
    .string('business_description', { max: 2000 })
    .enum('status', TENANT_STATUS, { default: 'PROSPECT' })
    .result<any>()

  v(input)
    .check(
      input.budget_min === undefined ||
        input.budget_max === undefined ||
        input.budget_min <= input.budget_max,
      'budget_min',
      'must be less than or equal to budget_max'
    )
    .result()

  const svc = new TenantService(c.env.DB)
  return created(c, await svc.create(input, c.var.user!.id, c.var.requestId))
})

tenantRoutes.get('/:id', requirePermission('tenant.read'), async (c) => {
  const svc = new TenantService(c.env.DB)
  return ok(c, await svc.get(c.req.param('id')))
})

tenantRoutes.patch('/:id', requirePermission('tenant.update'), async (c) => {
  const body = await validateBody(c.req.raw)
  const patch = v(body)
    .string('name', { min: 2, max: 160 })
    .enum('tenant_type', TENANT_TYPES)
    .enum('business_category', BUSINESS_CATEGORIES)
    .string('contact_name', { max: 120 })
    .string('phone', { max: 40 })
    .email('email')
    .number('budget_min', { min: 0 })
    .number('budget_max', { min: 0 })
    .number('space_need', { min: 0 })
    .string('location_preference', { max: 200 })
    .string('business_description', { max: 2000 })
    .enum('status', TENANT_STATUS)
    .result<any>()
  const svc = new TenantService(c.env.DB)
  return ok(c, await svc.update(c.req.param('id'), patch, c.var.user!.id, c.var.requestId))
})

/** GET /api/v1/tenants/:id/matched-properties — decision support for this tenant. */
tenantRoutes.get('/:id/matched-properties', requirePermission('match.execute'), async (c) => {
  const svc = new MatchingService(c.env.DB)
  const limit = Math.min(20, Math.max(1, Number(c.req.query('limit') ?? 10) || 10))
  const rows = await svc.rankPropertiesForTenant(c.req.param('id'), limit)
  return ok(c, rows, { count: rows.length })
})

/* ------------------------------- Segments --------------------------------- */

segmentRoutes.get('/', requirePermission('segment.read'), async (c) => {
  const svc = new SegmentService(c.env.DB)
  return ok(c, await svc.list())
})

segmentRoutes.post('/', requirePermission('segment.manage'), async (c) => {
  const body = await validateBody(c.req.raw)
  const input = v(body)
    .string('name', { required: true, min: 2, max: 120 })
    .string('description', { max: 1000 })
    .enum('business_category', BUSINESS_CATEGORIES, { required: true })
    .number('minimum_space', { min: 0 })
    .number('maximum_space', { min: 0 })
    .number('budget_min', { min: 0 })
    .number('budget_max', { min: 0 })
    .stringArray('requirements', { maxItems: 20 })
    .result<any>()
  const svc = new SegmentService(c.env.DB)
  return created(c, await svc.create(input, c.var.user!.id, c.var.requestId))
})

segmentRoutes.get('/:id', requirePermission('segment.read'), async (c) => {
  const svc = new SegmentService(c.env.DB)
  return ok(c, await svc.get(c.req.param('id')))
})
