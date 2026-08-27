/**
 * Lead HTTP routes.
 * Traceability: PS-DATA-009 §39, §55 | PS-MASTER-001 §10, §11, §24, §33
 *
 * Critical transitions are explicit endpoints:
 *   POST /leads/:id/contact
 *   POST /leads/:id/qualify
 *   POST /leads/:id/assign
 *   POST /leads/:id/lose
 */
import { Hono } from 'hono'
import { authenticate, requirePermission } from '../../../shared/middleware'
import { created, ok, paginated, readPagination, readSort } from '../../../shared/http'
import { v, validateBody } from '../../../shared/validate'
import { LeadService } from '../application/lead.service'
import {
  ACTIVITY_TYPES,
  LEAD_SOURCES,
  LEAD_STATUS,
  LEAD_TEMPERATURE,
  QUALIFICATION_TIMELINES,
  type Env
} from '../../../shared/types'

export const leadRoutes = new Hono<Env>()

leadRoutes.use('*', authenticate)

/** GET /api/v1/leads */
leadRoutes.get('/', requirePermission('lead.read'), async (c) => {
  const { page, limit, offset } = readPagination(c)
  const orderBy = readSort(c, LeadService.sortable, 'created_at DESC')
  const { rows, total } = await new LeadService(c.env.DB).list({
    page,
    limit,
    offset,
    orderBy,
    search: c.req.query('search'),
    status: c.req.query('status'),
    temperature: c.req.query('temperature'),
    property_id: c.req.query('property_id'),
    tenant_id: c.req.query('tenant_id'),
    assigned_to: c.req.query('assigned_to'),
    source: c.req.query('source')
  })
  return paginated(c, rows, page, limit, total)
})

/** GET /api/v1/leads/pipeline — kanban board (§24). Declared before /:id. */
leadRoutes.get('/pipeline', requirePermission('lead.read'), async (c) => {
  const result = await new LeadService(c.env.DB).pipeline({
    property_id: c.req.query('property_id'),
    assigned_to: c.req.query('assigned_to'),
    limitPerStage: Math.min(100, Number(c.req.query('limit') ?? 50) || 50)
  })
  return ok(c, result.stages, { total: result.total })
})

/** POST /api/v1/leads */
leadRoutes.post('/', requirePermission('lead.create'), async (c) => {
  const body = await validateBody(c.req.raw)
  const input = v(body)
    .string('property_id', { required: true, max: 40 })
    .string('tenant_id', { required: true, max: 40 })
    .string('offer_id', { max: 40 })
    .string('campaign_id', { max: 40 })
    .enum('source', LEAD_SOURCES, { default: 'INBOUND' })
    .string('assigned_to', { max: 40 })
    .result<any>()
  return created(c, await new LeadService(c.env.DB).create(input, c.var.user!.id, c.var.requestId))
})

/** GET /api/v1/leads/:id */
leadRoutes.get('/:id', requirePermission('lead.read'), async (c) => {
  return ok(c, await new LeadService(c.env.DB).get(c.req.param('id')))
})

/** GET /api/v1/leads/:id/score — explainable score breakdown. */
leadRoutes.get('/:id/score', requirePermission('lead.read'), async (c) => {
  return ok(c, await new LeadService(c.env.DB).scoreBreakdown(c.req.param('id')))
})

/** POST /api/v1/leads/:id/contact */
leadRoutes.post('/:id/contact', requirePermission('lead.update'), async (c) => {
  const body = await validateBody(c.req.raw)
  const input = v(body)
    .enum('channel', ['CALL', 'MESSAGE', 'EMAIL', 'VISIT', 'OTHER'] as const, { required: true })
    .string('notes', { max: 2000 })
    .result<any>()
  return ok(c, await new LeadService(c.env.DB).contact(c.req.param('id'), input, c.var.user!.id, c.var.requestId))
})

/** POST /api/v1/leads/:id/activities — timeline entry (§13). */
leadRoutes.post('/:id/activities', requirePermission('activity.create'), async (c) => {
  const body = await validateBody(c.req.raw)
  const input = v(body)
    .enum('activity_type', ACTIVITY_TYPES, { required: true })
    .string('subject', { required: true, min: 2, max: 200 })
    .string('description', { max: 4000 })
    .date('occurred_at')
    .boolean('tenant_responded', { default: false })
    .result<any>()
  return created(
    c,
    await new LeadService(c.env.DB).recordActivity(c.req.param('id'), input, c.var.user!.id, c.var.requestId)
  )
})

/** POST /api/v1/leads/:id/qualify — explicit domain operation (§33). */
leadRoutes.post('/:id/qualify', requirePermission('lead.qualify'), async (c) => {
  const body = await validateBody(c.req.raw)
  const input = v(body)
    .string('business_type', { required: true, min: 2, max: 120 })
    .number('budget', { required: true, min: 0 })
    .enum('timeline', QUALIFICATION_TIMELINES, { required: true })
    .number('space_need', { min: 0 })
    .enum('location_need', ['HIGH', 'MEDIUM', 'LOW'] as const)
    .string('intended_use', { max: 500 })
    .enum('decision_status', ['DECISION_MAKER', 'INFLUENCER', 'UNKNOWN'] as const, { default: 'UNKNOWN' })
    .string('notes', { max: 2000 })
    .result<any>()
  return ok(c, await new LeadService(c.env.DB).qualify(c.req.param('id'), input, c.var.user!.id, c.var.requestId))
})

/** POST /api/v1/leads/:id/assign */
leadRoutes.post('/:id/assign', requirePermission('lead.assign'), async (c) => {
  const body = await validateBody(c.req.raw)
  const input = v(body).string('user_id', { required: true, max: 40 }).result<{ user_id: string }>()
  return ok(
    c,
    await new LeadService(c.env.DB).assign(c.req.param('id'), input.user_id, c.var.user!.id, c.var.requestId)
  )
})

/** POST /api/v1/leads/:id/lose — CRITICAL ACTION, requires a reason (DR-004). */
leadRoutes.post('/:id/lose', requirePermission('lead.update'), async (c) => {
  const body = await validateBody(c.req.raw)
  const input = v(body).string('reason', { required: true, min: 3, max: 500 }).result<{ reason: string }>()
  return ok(
    c,
    await new LeadService(c.env.DB).changeStatus(
      c.req.param('id'),
      'LOST',
      input.reason,
      c.var.user!.id,
      c.var.requestId
    )
  )
})

/** POST /api/v1/leads/:id/status — guarded transition (WON is refused here). */
leadRoutes.post('/:id/status', requirePermission('lead.update'), async (c) => {
  const body = await validateBody(c.req.raw)
  const input = v(body)
    .enum('status', LEAD_STATUS, { required: true })
    .string('reason', { max: 500 })
    .result<any>()
  return ok(
    c,
    await new LeadService(c.env.DB).changeStatus(
      c.req.param('id'),
      input.status,
      input.reason,
      c.var.user!.id,
      c.var.requestId
    )
  )
})

export const LEAD_FILTER_ENUMS = { LEAD_STATUS, LEAD_TEMPERATURE, LEAD_SOURCES }
