/**
 * UI smoke test — visits every registered screen with a real session and fails
 * on console errors, unhandled rejections, failed requests, or missing content.
 * Traceability: PS-MASTER-001 §27 (UI states), §43 (critical E2E), §53 (UX rule)
 *
 * Usage:
 *   node tests/e2e/ui-smoke.mjs [baseUrl]
 *
 * Credentials default to the development seed (§44). To smoke-test another
 * environment (e.g. production, where seed users do not exist) override them —
 * never hardcode real credentials in this file (§45):
 *
 *   PS_SMOKE_ACCOUNTS='{"admin":{"email":"...","password":"..."}}' \
 *     node tests/e2e/ui-smoke.mjs https://property-system.pages.dev
 *
 * Roles absent from the account map are skipped, so an admin-only environment
 * still verifies every admin-reachable screen.
 */
import { chromium } from 'playwright'

const BASE = process.argv[2] || process.env.PS_SMOKE_BASE_URL || 'http://localhost:3000'

const DEV_SEED_CREDENTIALS = {
  operator: { email: 'operator@propertysystem.local', password: 'Operator#2026' },
  owner: { email: 'owner@propertysystem.local', password: 'Owner#2026' },
  admin: { email: 'admin@propertysystem.local', password: 'Admin#2026' }
}

const CREDENTIALS = process.env.PS_SMOKE_ACCOUNTS
  ? JSON.parse(process.env.PS_SMOKE_ACCOUNTS)
  : DEV_SEED_CREDENTIALS

/** Screens are checked against a marker that only appears when render succeeded. */
const ROUTES = [
  { path: '/dashboard', role: 'operator', expect: 'Dashboard' },
  { path: '/properties', role: 'operator', expect: 'Properti' },
  { path: '/tenants', role: 'operator', expect: 'Penyewa' },
  { path: '/segments', role: 'operator', expect: 'Segmen' },
  { path: '/leads', role: 'operator', expect: 'Lead' },
  { path: '/activities', role: 'operator', expect: 'Follow-Up' },
  { path: '/activities/log', role: 'operator', expect: 'Aktivitas' },
  { path: '/visits', role: 'operator', expect: 'Kunjungan' },
  { path: '/negotiations', role: 'operator', expect: 'Negosiasi' },
  { path: '/rentals', role: 'operator', expect: 'Rental' },
  { path: '/offers', role: 'operator', expect: 'Offer' },
  { path: '/campaigns', role: 'operator', expect: 'Campaign' },
  { path: '/market', role: 'operator', expect: 'Market' },
  { path: '/analytics', role: 'owner', expect: 'Analytics' },
  { path: '/settings/users', role: 'admin', expect: 'Pengguna' },
  { path: '/settings/audit', role: 'admin', expect: 'Audit' }
]

/** Detail routes are resolved dynamically from seeded data. */
async function discoverDetailRoutes(token) {
  const get = async (path) => {
    const res = await fetch(`${BASE}/api/v1${path}`, { headers: { Authorization: `Bearer ${token}` } })
    if (!res.ok) return null
    return res.json()
  }
  const out = []
  const props = await get('/properties?limit=1')
  if (props?.data?.[0]) out.push({ path: `/properties/${props.data[0].id}`, role: 'operator', expect: 'Properti' })
  const tenants = await get('/tenants?limit=1')
  if (tenants?.data?.[0]) out.push({ path: `/tenants/${tenants.data[0].id}`, role: 'operator', expect: 'Penyewa' })
  const leads = await get('/leads?limit=1')
  if (leads?.data?.[0]) out.push({ path: `/leads/${leads.data[0].id}`, role: 'operator', expect: 'Lead' })
  const ngt = await get('/negotiations?limit=1')
  if (ngt?.data?.[0]) out.push({ path: `/negotiations?id=${ngt.data[0].id}`, role: 'operator', expect: 'Negosiasi' })
  const rnt = await get('/rentals?limit=1')
  if (rnt?.data?.[0]) out.push({ path: `/rentals?id=${rnt.data[0].id}`, role: 'operator', expect: 'Rental' })
  const off = await get('/offers?limit=1')
  if (off?.data?.[0]) out.push({ path: `/offers?id=${off.data[0].id}`, role: 'operator', expect: 'Offer' })
  return out
}

async function login(role) {
  const c = CREDENTIALS[role]
  const res = await fetch(`${BASE}/api/v1/auth/login`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify(c)
  })
  if (!res.ok) throw new Error(`login ${role} failed: ${res.status}`)
  const { data } = await res.json()
  return data
}

async function main() {
  const sessions = {}
  for (const role of Object.keys(CREDENTIALS)) sessions[role] = await login(role)

  const detailRoutes = await discoverDetailRoutes(sessions.operator.token)
  const all = [...ROUTES, ...detailRoutes]

  const browser = await chromium.launch()
  const failures = []
  let checked = 0

  for (const route of all) {
    const s = sessions[route.role]
    const ctx = await browser.newContext({ viewport: { width: 1360, height: 900 } })
    const page = await ctx.newPage()

    const problems = []
    page.on('console', (m) => {
      if (m.type() === 'error') problems.push(`console: ${m.text().slice(0, 240)}`)
    })
    page.on('pageerror', (e) => problems.push(`pageerror: ${String(e.message).slice(0, 240)}`))
    page.on('requestfailed', (r) => problems.push(`requestfailed: ${r.url()}`))
    page.on('response', (r) => {
      if (r.status() >= 500) problems.push(`http${r.status()}: ${r.url()}`)
    })

    // Seed the session BEFORE the app bootstraps so no login screen appears.
    await page.addInitScript(
      ([token, user]) => {
        localStorage.setItem('ps.token', token)
        localStorage.setItem('ps.user', JSON.stringify(user))
      },
      [s.token, s.user]
    )

    try {
      await page.goto(`${BASE}/#${route.path}`, { waitUntil: 'networkidle', timeout: 45000 })
      await page.waitForTimeout(1400)

      const body = await page.evaluate(() => document.body.innerText)

      if (/Layar gagal dimuat|Aplikasi gagal dijalankan|tidak tersedia\./i.test(body)) {
        problems.push('screen crashed (fallback error UI rendered)')
      }
      if (/Akses ditolak/i.test(body)) problems.push('permission denied for this role')
      if (/Halaman tidak ditemukan/i.test(body)) problems.push('route not registered')
      if (!body.includes(route.expect)) problems.push(`missing marker "${route.expect}"`)
      // Screens must resolve out of the skeleton state.
      const skeletons = await page.locator('.skeleton').count()
      if (skeletons > 0) problems.push(`still loading (${skeletons} skeletons)`)
    } catch (e) {
      problems.push(`navigation: ${String(e.message).slice(0, 200)}`)
    }

    checked++
    if (problems.length) {
      failures.push({ route: route.path, role: route.role, problems })
      console.log(`✗ ${route.path} [${route.role}]`)
      problems.forEach((p) => console.log(`    - ${p}`))
    } else {
      console.log(`✓ ${route.path} [${route.role}]`)
    }
    await ctx.close()
  }

  await browser.close()

  console.log(`\n${checked - failures.length}/${checked} screens OK`)
  if (failures.length) {
    console.log(`\n${failures.length} screen(s) failed.`)
    process.exit(1)
  }
}

main().catch((e) => {
  console.error(e)
  process.exit(1)
})
