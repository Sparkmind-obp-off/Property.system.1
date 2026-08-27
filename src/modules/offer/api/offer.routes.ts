/**
 * Offer + Campaign HTTP routes.
 * Traceability: PS-DATA-009 §39, §55 | PS-MASTER-001 §9, §33 | PS-UX-010 §46
 *
 * Critical business transitions use explicit endpoints, never arbitrary
 * status PATCHes (§33).
 */
import { Hono } from 'hono'
import { authenticate, requirePermission } from '../../../shared/middleware'
import { created, ok, paginated, readPagination, readSort } from '../../../shared/http'
import { v, validateBody } from '../../../shared/validate'
import { CampaignService, OfferService } from '../application/offer.service'
import { CAMPAIGN_CHANNELS, OFFER_STATUS, type Env } from '../../../shared/types'

export const offerRoutes = new Hono<Env>()
export const campaignRoutes = new Hono<Env>()

offerRoutes.use('*', authenticate)
campaignRoutes.use('*', authenticate)

/* --------------------------------- Offers --------------------------------- */

/** GET /api/v1/offers */
offerRoutes.get('/', requirePermission('offer.read'), async (c) => {
  const { page, limit, offset } = readPagination(c)
  const orderBy = readSort(c, OfferService.sortable, 'created_at DESC')
  const { rows, total } = await new OfferService(c.env.DB).list({
    page,
    limit,
    offset,
    orderBy,
    search: c.req.query('search'),
    status: c.req.query('status'),
    property_id: c.req.query('property_id')
  })
  return paginated(c, rows, page, limit, total)
})

/** POST /api/v1/offers */
offerRoutes.post('/', requirePermission('offer.create'), async (c) => {
  const body = await validateBody(c.req.raw)
  const input = v(body)
    .string('property_id', { required: true, max: 40 })
    .string('title', { required: true, min: 4, max: 200 })
    .string('description', { max: 4000 })
    .string('value_proposition', { max: 1000 })
    .number('price', { min: 0 })
    .string('terms', { max: 2000 })
    .string('cta', { max: 120, default: 'Hubungi Kami' })
    .string('tenant_segment_id', { max: 40 })
    .result<any>()
  return created(c, await new OfferService(c.env.DB).create(input, c.var.user!.id, c.var.requestId))
})

/** GET /api/v1/offers/:id */
offerRoutes.get('/:id', requirePermission('offer.read'), async (c) => {
  return ok(c, await new OfferService(c.env.DB).get(c.req.param('id')))
})

/** PATCH /api/v1/offers/:id — content only. */
offerRoutes.patch('/:id', requirePermission('offer.update'), async (c) => {
  const body = await validateBody(c.req.raw)
  const patch = v(body)
    .string('title', { min: 4, max: 200 })
    .string('description', { max: 4000 })
    .string('value_proposition', { max: 1000 })
    .number('price', { min: 0 })
    .string('terms', { max: 2000 })
    .string('cta', { max: 120 })
    .string('tenant_segment_id', { max: 40 })
    .result<any>()
  return ok(c, await new OfferService(c.env.DB).update(c.req.param('id'), patch, c.var.user!.id, c.var.requestId))
})

/** POST /api/v1/offers/:id/ready — DRAFT → READY. */
offerRoutes.post('/:id/ready', requirePermission('offer.update'), async (c) => {
  return ok(c, await new OfferService(c.env.DB).markReady(c.req.param('id'), c.var.user!.id, c.var.requestId))
})

/** POST /api/v1/offers/:id/publish — CRITICAL ACTION (§29). */
offerRoutes.post('/:id/publish', requirePermission('offer.publish'), async (c) => {
  return ok(c, await new OfferService(c.env.DB).publish(c.req.param('id'), c.var.user!.id, c.var.requestId))
})

/** POST /api/v1/offers/:id/pause */
offerRoutes.post('/:id/pause', requirePermission('offer.publish'), async (c) => {
  return ok(
    c,
    await new OfferService(c.env.DB).changeStatus(c.req.param('id'), 'PAUSED', c.var.user!.id, c.var.requestId)
  )
})

/** POST /api/v1/offers/:id/resume */
offerRoutes.post('/:id/resume', requirePermission('offer.publish'), async (c) => {
  return ok(
    c,
    await new OfferService(c.env.DB).changeStatus(c.req.param('id'), 'ACTIVE', c.var.user!.id, c.var.requestId)
  )
})

/** POST /api/v1/offers/:id/archive — terminal state. */
offerRoutes.post('/:id/archive', requirePermission('offer.update'), async (c) => {
  return ok(
    c,
    await new OfferService(c.env.DB).changeStatus(c.req.param('id'), 'EXPIRED', c.var.user!.id, c.var.requestId)
  )
})

/** POST /api/v1/offers/:id/status — explicit whitelisted transition. */
offerRoutes.post('/:id/status', requirePermission('offer.update'), async (c) => {
  const body = await validateBody(c.req.raw)
  const input = v(body).enum('status', OFFER_STATUS, { required: true }).result<{ status: any }>()
  return ok(
    c,
    await new OfferService(c.env.DB).changeStatus(c.req.param('id'), input.status, c.var.user!.id, c.var.requestId)
  )
})

/* ------------------------------- Campaigns -------------------------------- */

/** GET /api/v1/campaigns */
campaignRoutes.get('/', requirePermission('campaign.read'), async (c) => {
  const { page, limit, offset } = readPagination(c)
  const { rows, total } = await new CampaignService(c.env.DB).list({
    page,
    limit,
    offset,
    status: c.req.query('status'),
    offer_id: c.req.query('offer_id')
  })
  return paginated(c, rows, page, limit, total)
})

/** POST /api/v1/campaigns */
campaignRoutes.post('/', requirePermission('campaign.manage'), async (c) => {
  const body = await validateBody(c.req.raw)
  const input = v(body)
    .string('offer_id', { required: true, max: 40 })
    .string('name', { required: true, min: 3, max: 160 })
    .enum('channel', CAMPAIGN_CHANNELS, { default: 'DIRECT_OUTREACH' })
    .string('objective', { max: 1000 })
    .date('start_at')
    .date('end_at')
    .number('budget', { min: 0 })
    .result<any>()
  return created(c, await new CampaignService(c.env.DB).create(input, c.var.user!.id, c.var.requestId))
})

/** GET /api/v1/campaigns/:id */
campaignRoutes.get('/:id', requirePermission('campaign.read'), async (c) => {
  return ok(c, await new CampaignService(c.env.DB).get(c.req.param('id')))
})

/** POST /api/v1/campaigns/:id/start — requires a published offer. */
campaignRoutes.post('/:id/start', requirePermission('campaign.manage'), async (c) => {
  return ok(
    c,
    await new CampaignService(c.env.DB).changeStatus(c.req.param('id'), 'RUNNING', c.var.user!.id, c.var.requestId)
  )
})

/** POST /api/v1/campaigns/:id/pause */
campaignRoutes.post('/:id/pause', requirePermission('campaign.manage'), async (c) => {
  return ok(
    c,
    await new CampaignService(c.env.DB).changeStatus(c.req.param('id'), 'PAUSED', c.var.user!.id, c.var.requestId)
  )
})

/** POST /api/v1/campaigns/:id/end */
campaignRoutes.post('/:id/end', requirePermission('campaign.manage'), async (c) => {
  return ok(
    c,
    await new CampaignService(c.env.DB).changeStatus(c.req.param('id'), 'ENDED', c.var.user!.id, c.var.requestId)
  )
})
