/**
 * Rental HTTP routes.
 * Traceability: PS-DATA-009 §39, §55 | PS-MASTER-001 §16, §17, §29, §33
 *
 * Critical business transitions get EXPLICIT endpoints — never a generic
 * status PATCH (§33):
 *   POST /rentals/:id/confirm
 *   POST /rentals/:id/activate   ← CRITICAL ACTION (§29)
 *   POST /rentals/:id/end
 *   POST /rentals/:id/cancel
 */
import { Hono } from 'hono'
import { authenticate, requirePermission } from '../../../shared/middleware'
import { created, ok, paginated, readPagination } from '../../../shared/http'
import { v, validateBody } from '../../../shared/validate'
import { PRICE_PERIODS, RENTAL_STATUS, type Env } from '../../../shared/types'
import { RentalService } from '../application/rental.service'

export const rentalRoutes = new Hono<Env>()

rentalRoutes.use('*', authenticate)

/** GET /api/v1/rentals — list with pagination + whitelisted filters. */
rentalRoutes.get('/', requirePermission('rental.read'), async (c) => {
  const { page, limit, offset } = readPagination(c)
  const { rows, total } = await new RentalService(c.env.DB).list({
    page,
    limit,
    offset,
    status: c.req.query('status'),
    property_id: c.req.query('property_id'),
    tenant_id: c.req.query('tenant_id'),
    expiring: c.req.query('expiring') === 'true',
    search: c.req.query('search')
  })
  return paginated(c, rows, page, limit, total, { filters: { status: RENTAL_STATUS } })
})

/**
 * POST /api/v1/rentals — CreateRental.
 * Accepts a negotiation_id / lead_id as commercial context so agreed terms are
 * never retyped; property_id + tenant_id may also be supplied directly.
 */
rentalRoutes.post('/', requirePermission('rental.create'), async (c) => {
  const body = await validateBody(c.req.raw)
  const input = v(body)
    .string('property_id', { max: 40 })
    .string('tenant_id', { max: 40 })
    .string('lead_id', { max: 40 })
    .string('negotiation_id', { max: 40 })
    .date('start_date', { required: true })
    .date('end_date', { required: true })
    .number('price', { min: 0 })
    .enum('payment_period', PRICE_PERIODS)
    .number('deposit', { min: 0, default: 0 })
    .string('terms', { max: 4000 })
    .string('idempotency_key', { max: 80 })
    .result<any>()
  return created(c, await new RentalService(c.env.DB).create(input, c.var.user!.id, c.var.requestId))
})

/** GET /api/v1/rentals/:id — includes explainable activation readiness. */
rentalRoutes.get('/:id', requirePermission('rental.read'), async (c) => {
  return ok(c, await new RentalService(c.env.DB).get(c.req.param('id')))
})

/** POST /api/v1/rentals/:id/confirm — reserves the property for this deal. */
rentalRoutes.post('/:id/confirm', requirePermission('rental.update'), async (c) => {
  return ok(c, await new RentalService(c.env.DB).confirm(c.req.param('id'), c.var.user!.id, c.var.requestId))
})

/**
 * POST /api/v1/rentals/:id/activate — CRITICAL ACTION (§29).
 * Consequence: the property becomes unavailable and the lead becomes WON.
 */
rentalRoutes.post('/:id/activate', requirePermission('rental.activate'), async (c) => {
  return ok(c, await new RentalService(c.env.DB).activate(c.req.param('id'), c.var.user!.id, c.var.requestId))
})

/** POST /api/v1/rentals/:id/end — releases the property back to the market. */
rentalRoutes.post('/:id/end', requirePermission('rental.end'), async (c) => {
  const body = await validateBody(c.req.raw)
  const input = v(body)
    .string('reason', { required: true, min: 3, max: 500 })
    .date('ended_at')
    .result<{ reason: string; ended_at?: string }>()
  return ok(c, await new RentalService(c.env.DB).end(c.req.param('id'), input, c.var.user!.id, c.var.requestId))
})

/** POST /api/v1/rentals/:id/cancel — abandons a rental that never activated. */
rentalRoutes.post('/:id/cancel', requirePermission('rental.update'), async (c) => {
  const body = await validateBody(c.req.raw)
  const input = v(body).string('reason', { required: true, min: 3, max: 500 }).result<{ reason: string }>()
  return ok(
    c,
    await new RentalService(c.env.DB).cancel(c.req.param('id'), input.reason, c.var.user!.id, c.var.requestId)
  )
})

/**
 * POST /api/v1/rentals/flag-expiring — operational maintenance task moving
 * ACTIVE rentals inside the 30-day window to EXPIRING. Idempotent.
 */
rentalRoutes.post('/flag-expiring', requirePermission('rental.update'), async (c) => {
  return ok(c, await new RentalService(c.env.DB).flagExpiring(c.var.user!.id, c.var.requestId))
})
