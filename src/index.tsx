/**
 * Property System — application entry point (Cloudflare Pages / Workers).
 * Traceability: PS-IMP-011 §5, §22 | PS-MASTER-001 §33, §34, §35 | PS-TECH-008 §25
 *
 * API version prefix: /api/v1 (§33). Request pipeline:
 *   REQUEST → REQUEST-ID → AUTHENTICATE → AUTHORIZE → VALIDATE → SERVICE
 *           → DOMAIN RULE → PERSISTENCE → RESPONSE
 */
import { Hono } from 'hono'
import { cors } from 'hono/cors'
import { logger } from 'hono/logger'

import { fail } from './shared/http'
import { requestId } from './shared/middleware'
import { ErrorCode } from './shared/errors'
import { APP_VERSION } from './shared/version'
import type { Bindings, Env } from './shared/types'

import { identityRoutes } from './modules/identity/api/identity.routes'
import { propertyRoutes } from './modules/property/api/property.routes'
import { tenantRoutes, segmentRoutes } from './modules/tenant/api/tenant.routes'
import { offerRoutes, campaignRoutes } from './modules/offer/api/offer.routes'
import { leadRoutes } from './modules/lead/api/lead.routes'
import { followUpRoutes, visitRoutes, activityRoutes } from './modules/operations/api/operations.routes'
import { negotiationRoutes } from './modules/negotiation/api/negotiation.routes'
import { rentalRoutes } from './modules/rental/api/rental.routes'
import { analyticsRoutes, dashboardRoutes, marketRoutes } from './modules/analytics/api/analytics.routes'

const app = new Hono<Env>()

/* ------------------------------ Global stack ------------------------------ */

app.use('*', logger())
app.use('*', requestId)
app.use('/api/*', cors({ origin: '*', allowHeaders: ['Content-Type', 'Authorization', 'x-request-id'] }))

/** Single error boundary — every failure returns the stable error contract (§35). */
app.onError((err, c) => fail(c, err))

app.notFound((c) =>
  c.json(
    { error: { code: ErrorCode.NOT_FOUND, message: 'Endpoint not found.', details: { path: c.req.path } } },
    404
  )
)

/* --------------------------------- API v1 -------------------------------- */

const api = new Hono<Env>()

api.get('/health', (c) =>
  c.json({
    data: {
      status: 'ok',
      system: 'PS-MASTER-001',
      version: 'v1',
      app_version: APP_VERSION,
      request_id: c.var.requestId
    },
    meta: {}
  })
)

api.route('/', identityRoutes) // /auth/*, /users, /roles, /audit-logs
api.route('/properties', propertyRoutes)
api.route('/tenants', tenantRoutes)
api.route('/tenant-segments', segmentRoutes)
api.route('/offers', offerRoutes)
api.route('/campaigns', campaignRoutes)
api.route('/leads', leadRoutes)
api.route('/follow-ups', followUpRoutes)
api.route('/visits', visitRoutes)
api.route('/activities', activityRoutes)
api.route('/negotiations', negotiationRoutes)
api.route('/rentals', rentalRoutes)
api.route('/dashboard', dashboardRoutes)
api.route('/analytics', analyticsRoutes)
api.route('/market', marketRoutes)

app.route('/api/v1', api)

/* --------------------------- Static assets / SPA -------------------------- */

/**
 * Cloudflare Pages serves `dist/` through the ASSETS fetcher. `_routes.json`
 * excludes `/static/*` and `/index.html` so those never reach the Worker, but
 * every SPA deep link (`/dashboard`, `/leads/…`) does — and must resolve to the
 * app shell, not a 404. Fetching `/index.html` through ASSETS keeps a single
 * source of truth for the shell (§22, §27).
 */
async function serveAppShell(c: { env: Bindings; req: { raw: Request } }): Promise<Response> {
  const assets = c.env.ASSETS
  if (assets) {
    const shellUrl = new URL('/index.html', new URL(c.req.raw.url).origin)
    const res = await assets.fetch(new Request(shellUrl.toString(), { headers: c.req.raw.headers }))
    if (res.ok) {
      // Rebuild the response so the status is 200 even on a deep-link fallback.
      return new Response(res.body, {
        status: 200,
        headers: { 'content-type': 'text/html; charset=utf-8', 'cache-control': 'no-cache' }
      })
    }
  }
  return new Response(FALLBACK_SHELL, {
    status: 200,
    headers: { 'content-type': 'text/html; charset=utf-8', 'cache-control': 'no-cache' }
  })
}

/**
 * Minimal shell used only when the ASSETS binding is unavailable (e.g. the
 * Worker running outside Pages). Mirrors public/index.html's mount points.
 */
const FALLBACK_SHELL = `<!DOCTYPE html>
<html lang="id"><head><meta charset="UTF-8">
<meta name="viewport" content="width=device-width, initial-scale=1.0, viewport-fit=cover">
<title>Property System — Operational Console</title>
<link href="https://cdn.jsdelivr.net/npm/@fortawesome/fontawesome-free@6.5.2/css/all.min.css" rel="stylesheet">
<link href="/static/css/app.css" rel="stylesheet"></head>
<body><div id="app"><div class="boot"><div class="boot-title">Property System</div>
<div class="boot-sub">Menyiapkan sesi…</div></div></div><div id="toasts"></div>
<script type="module" src="/static/js/app.js"></script></body></html>`

app.get('/', (c) => serveAppShell(c))

/**
 * SPA deep links (`/dashboard`, `/leads/lead_x`, …) are client-side routes with
 * no file on disk. They must resolve to the app shell so the browser router can
 * render them (§22). Registered as an explicit catch-all — the `notFound`
 * handler stays reserved for genuine API 404s (§35).
 */
app.get('*', (c) => {
  if (c.req.path.startsWith('/api/')) {
    return c.json(
      { error: { code: ErrorCode.NOT_FOUND, message: 'Endpoint not found.', details: { path: c.req.path } } },
      404
    )
  }
  return serveAppShell(c)
})

/**
 * The favicon is an inline SVG data URI in index.html, so no file exists on
 * disk. Answer the browser's implicit /favicon.ico probe with 204 instead of
 * letting the request fall through to the SPA shell.
 */
app.get('/favicon.ico', (c) => c.body(null, 204))

export default app
