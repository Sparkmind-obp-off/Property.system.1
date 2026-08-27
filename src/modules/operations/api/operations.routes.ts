/**
 * Follow-Up + Visit + Activity HTTP routes.
 * Traceability: PS-DATA-009 §39, §55 | PS-MASTER-001 §12, §13, §14, §33
 */
import { Hono } from 'hono'
import { authenticate, requirePermission } from '../../../shared/middleware'
import { created, ok, paginated, readPagination } from '../../../shared/http'
import { v, validateBody } from '../../../shared/validate'
import { findMany } from '../../../shared/repository'
import { FollowUpService } from '../application/followup.service'
import { VisitService } from '../application/visit.service'
import { FOLLOW_UP_ACTIONS, VISIT_RESULTS, type Env } from '../../../shared/types'

export const followUpRoutes = new Hono<Env>()
export const visitRoutes = new Hono<Env>()
export const activityRoutes = new Hono<Env>()

followUpRoutes.use('*', authenticate)
visitRoutes.use('*', authenticate)
activityRoutes.use('*', authenticate)

/* ------------------------------- Follow-ups ------------------------------- */

/** GET /api/v1/follow-ups?bucket=OVERDUE|DUE_TODAY|UPCOMING */
followUpRoutes.get('/', requirePermission('followup.read'), async (c) => {
  const { page, limit, offset } = readPagination(c)
  const { rows, total } = await new FollowUpService(c.env.DB).list({
    page,
    limit,
    offset,
    status: c.req.query('status'),
    assigned_to: c.req.query('assigned_to'),
    lead_id: c.req.query('lead_id'),
    bucket: c.req.query('bucket')
  })
  return paginated(c, rows, page, limit, total)
})

/** GET /api/v1/follow-ups/work-queue — action center buckets (§12, §19). */
followUpRoutes.get('/work-queue', requirePermission('followup.read'), async (c) => {
  const mine = c.req.query('mine') === 'true'
  const queue = await new FollowUpService(c.env.DB).workQueue(mine ? c.var.user!.id : undefined)
  return ok(c, queue, {
    counts: {
      overdue: queue.overdue.length,
      due_today: queue.due_today.length,
      upcoming: queue.upcoming.length
    }
  })
})

/** POST /api/v1/follow-ups */
followUpRoutes.post('/', requirePermission('followup.create'), async (c) => {
  const body = await validateBody(c.req.raw)
  const input = v(body)
    .string('lead_id', { required: true, max: 40 })
    .enum('action_type', FOLLOW_UP_ACTIONS, { required: true })
    .date('due_at', { required: true })
    .string('assigned_to', { max: 40 })
    .string('notes', { max: 2000 })
    .result<any>()
  return created(c, await new FollowUpService(c.env.DB).create(input, c.var.user!.id, c.var.requestId))
})

/** GET /api/v1/follow-ups/:id */
followUpRoutes.get('/:id', requirePermission('followup.read'), async (c) => {
  return ok(c, await new FollowUpService(c.env.DB).get(c.req.param('id')))
})

/** POST /api/v1/follow-ups/:id/complete */
followUpRoutes.post('/:id/complete', requirePermission('followup.update'), async (c) => {
  const body = await validateBody(c.req.raw)
  const input = v(body)
    .string('outcome', { required: true, min: 2, max: 1000 })
    .string('notes', { max: 2000 })
    .result<any>()
  return ok(c, await new FollowUpService(c.env.DB).complete(c.req.param('id'), input, c.var.user!.id, c.var.requestId))
})

/** POST /api/v1/follow-ups/:id/reschedule */
followUpRoutes.post('/:id/reschedule', requirePermission('followup.update'), async (c) => {
  const body = await validateBody(c.req.raw)
  const input = v(body)
    .date('due_at', { required: true })
    .string('reason', { max: 500 })
    .result<any>()
  return ok(
    c,
    await new FollowUpService(c.env.DB).reschedule(c.req.param('id'), input, c.var.user!.id, c.var.requestId)
  )
})

/** POST /api/v1/follow-ups/:id/cancel */
followUpRoutes.post('/:id/cancel', requirePermission('followup.update'), async (c) => {
  const body = await validateBody(c.req.raw).catch(() => ({}))
  const input = v(body).string('reason', { max: 500 }).result<any>()
  return ok(
    c,
    await new FollowUpService(c.env.DB).cancel(c.req.param('id'), input.reason, c.var.user!.id, c.var.requestId)
  )
})

/* --------------------------------- Visits --------------------------------- */

/** GET /api/v1/visits?scope=TODAY|UPCOMING|NEEDS_RESULT */
visitRoutes.get('/', requirePermission('visit.read'), async (c) => {
  const { page, limit, offset } = readPagination(c)
  const { rows, total } = await new VisitService(c.env.DB).list({
    page,
    limit,
    offset,
    status: c.req.query('status'),
    property_id: c.req.query('property_id'),
    lead_id: c.req.query('lead_id'),
    scope: c.req.query('scope')
  })
  return paginated(c, rows, page, limit, total)
})

/** POST /api/v1/visits — DR-005 requires property + lead context. */
visitRoutes.post('/', requirePermission('visit.create'), async (c) => {
  const body = await validateBody(c.req.raw)
  const input = v(body)
    .string('lead_id', { required: true, max: 40 })
    .date('scheduled_at', { required: true })
    .string('notes', { max: 2000 })
    .result<any>()
  return created(c, await new VisitService(c.env.DB).schedule(input, c.var.user!.id, c.var.requestId))
})

/** GET /api/v1/visits/:id */
visitRoutes.get('/:id', requirePermission('visit.read'), async (c) => {
  return ok(c, await new VisitService(c.env.DB).get(c.req.param('id')))
})

/** POST /api/v1/visits/:id/confirm */
visitRoutes.post('/:id/confirm', requirePermission('visit.update'), async (c) => {
  return ok(c, await new VisitService(c.env.DB).confirm(c.req.param('id'), c.var.user!.id, c.var.requestId))
})

/** POST /api/v1/visits/:id/complete — DR-005 requires an explicit result. */
visitRoutes.post('/:id/complete', requirePermission('visit.complete'), async (c) => {
  const body = await validateBody(c.req.raw)
  const input = v(body)
    .enum('result', VISIT_RESULTS, { required: true })
    .string('notes', { max: 2000 })
    .result<any>()
  return ok(c, await new VisitService(c.env.DB).complete(c.req.param('id'), input, c.var.user!.id, c.var.requestId))
})

/** POST /api/v1/visits/:id/reschedule */
visitRoutes.post('/:id/reschedule', requirePermission('visit.update'), async (c) => {
  const body = await validateBody(c.req.raw)
  const input = v(body)
    .date('scheduled_at', { required: true })
    .string('reason', { max: 500 })
    .result<any>()
  return ok(c, await new VisitService(c.env.DB).reschedule(c.req.param('id'), input, c.var.user!.id, c.var.requestId))
})

/** POST /api/v1/visits/:id/cancel */
visitRoutes.post('/:id/cancel', requirePermission('visit.update'), async (c) => {
  const body = await validateBody(c.req.raw).catch(() => ({}))
  const input = v(body).string('reason', { max: 500 }).result<any>()
  return ok(
    c,
    await new VisitService(c.env.DB).close(c.req.param('id'), 'CANCELLED', input.reason, c.var.user!.id, c.var.requestId)
  )
})

/** POST /api/v1/visits/:id/no-show */
visitRoutes.post('/:id/no-show', requirePermission('visit.update'), async (c) => {
  const body = await validateBody(c.req.raw).catch(() => ({}))
  const input = v(body).string('reason', { max: 500 }).result<any>()
  return ok(
    c,
    await new VisitService(c.env.DB).close(c.req.param('id'), 'NO_SHOW', input.reason, c.var.user!.id, c.var.requestId)
  )
})

/* ------------------------------- Activities -------------------------------- */

/**
 * GET /api/v1/activities — cross-lead operational feed (ACTIVITIES nav item).
 * Timeline per lead lives at GET /leads/:id (§13).
 */
activityRoutes.get('/', requirePermission('activity.read'), async (c) => {
  const { page, limit, offset } = readPagination(c, 30, 100)
  const leadId = c.req.query('lead_id')
  const type = c.req.query('activity_type')

  const clauses: string[] = []
  const params: unknown[] = []
  if (leadId) {
    clauses.push('a.lead_id = ?')
    params.push(leadId)
  }
  if (type) {
    clauses.push('a.activity_type = ?')
    params.push(type)
  }
  const where = clauses.length ? `WHERE ${clauses.join(' AND ')}` : ''

  const rows = await findMany(
    c.env.DB,
    `SELECT a.id, a.lead_id, a.activity_type, a.subject, a.description, a.occurred_at,
            u.name AS user_name, t.name AS tenant_name, p.name AS property_name
       FROM activities a
       JOIN leads l ON l.id = a.lead_id
       JOIN tenants t ON t.id = l.tenant_id
       JOIN properties p ON p.id = l.property_id
       LEFT JOIN users u ON u.id = a.user_id
       ${where}
      ORDER BY a.occurred_at DESC, a.created_at DESC
      LIMIT ? OFFSET ?`,
    [...params, limit, offset]
  )
  return paginated(c, rows, page, limit, rows.length + offset)
})
