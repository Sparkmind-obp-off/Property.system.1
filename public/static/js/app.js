/**
 * Application bootstrap — session gate, route registry, shell mounting.
 * Traceability: PS-UX-010 §7 (information architecture), §46 (screen contract)
 *              PS-MASTER-001 §22 (navigation follows workflow), §27 (UI states)
 *
 * Screens are lazily imported so a screen's cost is only paid when visited
 * (MASTER §55 performance).
 */
import { api, session, setUnauthorizedHandler } from './core/api.js'
import { deniedState, notFoundState, toast } from './core/dom.js'
import { dispatch, route, setNotFound, startRouter, parseHash } from './core/router.js'
import { mountShell, screenEl, setHeader } from './core/shell.js'
import { renderLogin } from './screens/login.js'

/* ---------------------------------------------------------------------------
 * Route table. Each entry declares the permission the screen needs so an
 * unauthorised deep-link renders PERMISSION DENIED instead of a broken screen.
 * ------------------------------------------------------------------------- */
const SCREENS = [
  { path: '/dashboard', perm: 'analytics.read', load: () => import('./screens/dashboard.js'), fn: 'dashboardScreen' },

  { path: '/properties', perm: 'property.read', load: () => import('./screens/properties.js'), fn: 'propertyListScreen' },
  { path: '/properties/:id', perm: 'property.read', load: () => import('./screens/properties.js'), fn: 'propertyDetailScreen' },

  { path: '/tenants', perm: 'tenant.read', load: () => import('./screens/tenants.js'), fn: 'tenantListScreen' },
  { path: '/tenants/:id', perm: 'tenant.read', load: () => import('./screens/tenants.js'), fn: 'tenantDetailScreen' },
  { path: '/segments', perm: 'segment.read', load: () => import('./screens/tenants.js'), fn: 'segmentScreen' },

  { path: '/leads', perm: 'lead.read', load: () => import('./screens/leads.js'), fn: 'leadPipelineScreen' },
  { path: '/leads/:id', perm: 'lead.read', load: () => import('./screens/leads.js'), fn: 'leadDetailScreen' },

  { path: '/activities', perm: 'followup.read', load: () => import('./screens/activities.js'), fn: 'workQueueScreen' },
  { path: '/activities/log', perm: 'activity.read', load: () => import('./screens/activities.js'), fn: 'activityLogScreen' },

  { path: '/visits', perm: 'visit.read', load: () => import('./screens/visits.js'), fn: 'visitListScreen' },
  { path: '/negotiations', perm: 'negotiation.read', load: () => import('./screens/negotiations.js'), fn: 'negotiationListScreen' },
  { path: '/rentals', perm: 'rental.read', load: () => import('./screens/rentals.js'), fn: 'rentalListScreen' },

  { path: '/offers', perm: 'offer.read', load: () => import('./screens/offers.js'), fn: 'offerListScreen' },
  { path: '/campaigns', perm: 'campaign.read', load: () => import('./screens/offers.js'), fn: 'campaignListScreen' },

  { path: '/market', perm: 'market.read', load: () => import('./screens/market.js'), fn: 'marketScreen' },
  { path: '/analytics', perm: 'analytics.read', load: () => import('./screens/analytics.js'), fn: 'analyticsScreen' },

  { path: '/settings/users', perm: 'user.read', load: () => import('./screens/settings.js'), fn: 'usersScreen' },
  { path: '/settings/audit', perm: 'audit.read', load: () => import('./screens/settings.js'), fn: 'auditScreen' },
  { path: '/settings/system', perm: 'user.manage', load: () => import('./screens/system.js'), fn: 'systemStatusScreen' }
]

function registerRoutes() {
  for (const s of SCREENS) {
    route(s.path, async (ctx) => {
      const el = screenEl()
      if (!el) return

      // UI permission gate — usability layer; the API enforces authority (§3).
      if (s.perm && !session.can(s.perm)) {
        setHeader({ title: 'Akses ditolak', subtitle: '' })
        el.innerHTML = deniedState(
          `Layar ini memerlukan izin "${s.perm}". Peran Anda: ${(session.user?.roles || []).join(', ') || '—'}.`
        )
        return
      }

      try {
        const mod = await s.load()
        const fn = mod[s.fn]
        if (typeof fn !== 'function') throw new Error(`Screen ${s.fn} tidak tersedia.`)
        await fn(ctx)
      } catch (err) {
        console.error('[screen]', s.path, err)
        setHeader({ title: 'Gagal memuat layar', subtitle: '' })
        el.innerHTML = `
          <div class="state error">
            <i class="fa-solid fa-triangle-exclamation state-icon"></i>
            <div class="state-title">Layar gagal dimuat</div>
            <div class="state-msg">${String(err?.message || err)}</div>
            <button class="btn" onclick="location.reload()">
              <i class="fa-solid fa-rotate-right"></i>Muat ulang aplikasi</button>
          </div>`
      }
    })
  }

  setNotFound(({ path }) => {
    const el = screenEl()
    if (!el) return
    setHeader({ title: 'Halaman tidak ditemukan', subtitle: '' })
    el.innerHTML = notFoundState(`Rute "${path}" tidak dikenal.`)
    el.querySelector('[data-action="back"]')?.addEventListener('click', () => {
      location.hash = '#/dashboard'
    })
  })
}

/**
 * Forced credential rotation (§8). A bootstrap or admin-reset password is a
 * one-time entry ticket, so the app blocks further use until it is replaced.
 * The dialog is not dismissible and reappears on every navigation until done.
 */
async function enforcePasswordRotation() {
  if (!session.user?.must_change_password) return
  const { openChangePasswordForm } = await import('./screens/system.js')
  openChangePasswordForm(
    () => {
      toast('Kredensial bootstrap telah dirotasi.', 'ok')
      dispatch()
    },
    { forced: true }
  )
}

/** First screen after login: the highest-privilege landing the role can open. */
function landingPath() {
  if (session.can('analytics.read')) return '/dashboard'
  if (session.can('property.read')) return '/properties'
  if (session.can('lead.read')) return '/leads'
  if (session.can('user.read')) return '/settings/users'
  return '/dashboard'
}

async function enterApp() {
  mountShell()
  const { path } = parseHash()
  if (!path || path === '/' || path === '/login') {
    location.hash = `#${landingPath()}`
    // hashchange will dispatch; but if the hash was already identical, force it.
    await dispatch()
  } else {
    await startRouter()
  }
  await enforcePasswordRotation()
}

function showLogin() {
  document.querySelector('.mobile-primary')?.remove()
  renderLogin(async () => {
    location.hash = `#${landingPath()}`
    await enterApp()
    toast(`Selamat datang, ${session.user?.name || ''}`, 'ok')
  })
}

async function boot() {
  registerRoutes()

  setUnauthorizedHandler(() => {
    toast('Sesi berakhir. Silakan masuk kembali.', 'err')
    showLogin()
  })

  if (!session.token) {
    showLogin()
    return
  }

  // Validate the stored token and refresh permissions before mounting (§45).
  try {
    const { data } = await api.auth.me()
    session.save(session.token, data)
    await enterApp()
  } catch {
    session.clear()
    showLogin()
  }
}

boot().catch((err) => {
  console.error('[boot]', err)
  document.getElementById('app').innerHTML = `
    <div class="state error" style="margin:40px auto;max-width:520px">
      <i class="fa-solid fa-triangle-exclamation state-icon"></i>
      <div class="state-title">Aplikasi gagal dijalankan</div>
      <div class="state-msg">${String(err?.message || err)}</div>
      <button class="btn" onclick="location.reload()">Muat ulang</button>
    </div>`
})
