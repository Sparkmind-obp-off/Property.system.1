/**
 * Negotiation HTTP routes.
 * Traceability: PS-DATA-009 §39, §55 | PS-MASTER-001 §15, §33
 *
 * POST /negotiations/:id/accept is a CRITICAL ACTION (§29) — acceptance must be
 * explicit and never a generic status PATCH.
 */
import { Hono } from 'hono'
import { authenticate, requirePermission } from '../../../shared/middleware'
import { created, ok, paginated, readPagination } from '../../../shared/http'
import { v, validateBody } from '../../../shared/validate'
import { NegotiationService } from '../application/negotiation.service'
import type { Env } from '../../../shared/types'

export const negotiationRoutes = new Hono<Env>()

negotiationRoutes.use('*', authenticate)

/** GET /api/v1/negotiations */
negotiationRoutes.get('/', requirePermission('negotiation.read'), async (c) => {
  const { page, limit, offset } = readPagination(c)
  const { rows, total } = await new NegotiationService(c.env.DB).list({
    page,
    limit,
    offset,
    status: c.req.query('status'),
    property_id: c.req.query('property_id'),
    lead_id: c.req.query('lead_id')
  })
  return paginated(c, rows, page, limit, total)
})

/** POST /api/v1/negotiations */
negotiationRoutes.post('/', requirePermission('negotiation.create'), async (c) => {
  const body = await validateBody(c.req.raw)
  const input = v(body)
    .string('lead_id', { required: true, max: 40 })
    .number('proposed_price', { required: true, min: 0 })
    .number('current_price', { min: 0 })
    .string('visit_id', { max: 40 })
    .string('terms', { max: 2000 })
    .string('notes', { max: 2000 })
    .result<any>()
  return created(c, await new NegotiationService(c.env.DB).create(input, c.var.user!.id, c.var.requestId))
})

/** GET /api/v1/negotiations/:id */
negotiationRoutes.get('/:id', requirePermission('negotiation.read'), async (c) => {
  return ok(c, await new NegotiationService(c.env.DB).get(c.req.param('id')))
})

/** POST /api/v1/negotiations/:id/counter */
negotiationRoutes.post('/:id/counter', requirePermission('negotiation.update'), async (c) => {
  const body = await validateBody(c.req.raw)
  const input = v(body)
    .number('price', { required: true, min: 0 })
    .enum('actor', ['TENANT', 'OWNER'] as const, { default: 'OWNER' })
    .string('terms', { max: 2000 })
    .string('notes', { max: 2000 })
    .result<any>()
  return ok(c, await new NegotiationService(c.env.DB).counter(c.req.param('id'), input, c.var.user!.id, c.var.requestId))
})

/** POST /api/v1/negotiations/:id/accept — CRITICAL ACTION (DR-007). */
negotiationRoutes.post('/:id/accept', requirePermission('negotiation.accept'), async (c) => {
  const body = await validateBody(c.req.raw).catch(() => ({}))
  const input = v(body)
    .number('agreed_price', { min: 0 })
    .string('terms', { max: 2000 })
    .result<any>()
  return ok(c, await new NegotiationService(c.env.DB).accept(c.req.param('id'), input, c.var.user!.id, c.var.requestId))
})

/** POST /api/v1/negotiations/:id/reject */
negotiationRoutes.post('/:id/reject', requirePermission('negotiation.update'), async (c) => {
  const body = await validateBody(c.req.raw)
  const input = v(body).string('reason', { required: true, min: 3, max: 500 }).result<{ reason: string }>()
  return ok(
    c,
    await new NegotiationService(c.env.DB).reject(c.req.param('id'), input.reason, c.var.user!.id, c.var.requestId)
  )
})
