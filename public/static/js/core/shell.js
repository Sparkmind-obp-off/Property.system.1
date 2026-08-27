/**
 * Application shell — sidebar navigation, top bar, mobile bottom nav.
 * Traceability: PS-MASTER-001 §22, §26 | PS-UX-010 §7, §8, §44
 *
 * Navigation mirrors the operational workflow, and every item is gated by the
 * user's permissions (UI hiding is a usability layer only).
 */
import { session } from './api.js'
import { esc, initials, num } from './dom.js'
import { navigate, parseHash } from './router.js'

export const NAV = [
  {
    group: 'Operasional',
    items: [
      { path: '/dashboard', label: 'Dashboard', icon: 'fa-gauge-high', perm: 'analytics.read', mobile: true },
      { path: '/properties', label: 'Properti', icon: 'fa-building', perm: 'property.read', mobile: true },
      { path: '/tenants', label: 'Calon Penyewa', icon: 'fa-users', perm: 'tenant.read' },
      { path: '/leads', label: 'Leads', icon: 'fa-filter-circle-dollar', perm: 'lead.read', mobile: true },
      { path: '/activities', label: 'Follow-Up', icon: 'fa-list-check', perm: 'followup.read', mobile: true },
      { path: '/visits', label: 'Kunjungan', icon: 'fa-calendar-check', perm: 'visit.read' },
      { path: '/negotiations', label: 'Negosiasi', icon: 'fa-handshake', perm: 'negotiation.read' },
      { path: '/rentals', label: 'Rental', icon: 'fa-file-signature', perm: 'rental.read' }
    ]
  },
  {
    group: 'Pemasaran & Pasar',
    items: [
      { path: '/offers', label: 'Offer & Campaign', icon: 'fa-bullhorn', perm: 'offer.read' },
      { path: '/market', label: 'Market Intelligence', icon: 'fa-map-location-dot', perm: 'market.read' },
      { path: '/analytics', label: 'Analytics', icon: 'fa-chart-line', perm: 'analytics.read' }
    ]
  },
  {
    group: 'Administrasi',
    items: [
      { path: '/settings/users', label: 'Pengguna & Peran', icon: 'fa-user-shield', perm: 'user.read' },
      { path: '/settings/audit', label: 'Audit Log', icon: 'fa-clipboard-list', perm: 'audit.read' }
    ]
  }
]

let badgeCounts = {}

export function setNavBadges(counts) {
  badgeCounts = counts || {}
  const host = document.getElementById('sidebar-nav')
  if (host) renderNav(host)
}

function navItemHtml(item, activePath) {
  if (item.perm && !session.can(item.perm)) return ''
  const active = activePath === item.path || activePath.startsWith(`${item.path}/`)
  const badge = badgeCounts[item.path]
  return `<a class="nav-item ${active ? 'active' : ''}" href="#${item.path}">
    <i class="fa-solid ${item.icon}"></i><span>${esc(item.label)}</span>
    ${badge ? `<span class="badge-count ${badge.alert ? 'alert' : ''}">${num(badge.count)}</span>` : ''}
  </a>`
}

function renderNav(host) {
  const { path } = parseHash()
  host.innerHTML = NAV.map((g) => {
    const items = g.items.map((i) => navItemHtml(i, path)).join('')
    if (!items.trim()) return ''
    return `<div class="nav-group-label">${esc(g.group)}</div>${items}`
  }).join('')
}

function renderBottomNav(activePath) {
  const items = NAV.flatMap((g) => g.items)
    .filter((i) => i.mobile && (!i.perm || session.can(i.perm)))
    .slice(0, 4)
  return `<nav class="bottom-nav">
    ${items
      .map(
        (i) => `<a class="bn-item ${activePath.startsWith(i.path) ? 'active' : ''}" href="#${i.path}">
          <i class="fa-solid ${i.icon}"></i><span>${esc(i.label)}</span></a>`
      )
      .join('')}
  </nav>`
}

/** Build the shell once; screens then render into #screen. */
export function mountShell() {
  const user = session.user
  const app = document.getElementById('app')
  const { path } = parseHash()
  app.innerHTML = `
    <div class="shell">
      <aside class="sidebar" id="sidebar">
        <div class="sidebar-brand">
          <div class="name">Property System</div>
          <div class="sub">PS-MASTER-001</div>
        </div>
        <nav class="nav" id="sidebar-nav"></nav>
        <div class="sidebar-user">
          <div class="avatar">${esc(initials(user?.name))}</div>
          <div class="who">
            <div class="n">${esc(user?.name || '')}</div>
            <div class="r">${esc((user?.roles || []).join(', '))}</div>
          </div>
          <button id="btn-logout" title="Keluar"><i class="fa-solid fa-right-from-bracket"></i></button>
        </div>
      </aside>
      <div class="main">
        <header class="topbar">
          <button class="hamburger" id="btn-menu" aria-label="Menu"><i class="fa-solid fa-bars"></i></button>
          <div class="title-block">
            <h1 id="page-title">—</h1>
            <div class="subtitle" id="page-subtitle"></div>
          </div>
          <div class="topbar-actions" id="page-actions"></div>
        </header>
        <main class="content" id="screen"></main>
      </div>
    </div>
    ${renderBottomNav(path)}
    <div id="toasts"></div>`

  renderNav(document.getElementById('sidebar-nav'))

  document.getElementById('btn-menu').addEventListener('click', () => {
    const sb = document.getElementById('sidebar')
    sb.classList.add('open')
    const scrim = document.createElement('div')
    scrim.className = 'scrim'
    scrim.addEventListener('click', () => {
      sb.classList.remove('open')
      scrim.remove()
    })
    document.body.appendChild(scrim)
  })

  document.getElementById('btn-logout').addEventListener('click', async () => {
    const { api } = await import('./api.js')
    await api.auth.logout()
    location.hash = '#/login'
    location.reload()
  })

  // Close the mobile drawer whenever navigation happens.
  window.addEventListener('hashchange', () => {
    document.getElementById('sidebar')?.classList.remove('open')
    document.querySelector('.scrim')?.remove()
    const nav = document.getElementById('sidebar-nav')
    if (nav) renderNav(nav)
    const bn = document.querySelector('.bottom-nav')
    if (bn) bn.outerHTML = renderBottomNav(parseHash().path)
  })
}

/** Set the page header. `actions` is raw HTML for the top-right button row. */
export function setHeader({ title, subtitle, actions, mobilePrimary }) {
  const t = document.getElementById('page-title')
  const s = document.getElementById('page-subtitle')
  const a = document.getElementById('page-actions')
  if (t) t.textContent = title || ''
  if (s) s.innerHTML = subtitle || ''
  if (a) a.innerHTML = actions || ''
  document.querySelector('.mobile-primary')?.remove()
  if (mobilePrimary) {
    const btn = document.createElement('button')
    btn.className = 'btn primary mobile-primary'
    btn.dataset.action = mobilePrimary.action
    btn.innerHTML = `<i class="fa-solid ${mobilePrimary.icon || 'fa-plus'}"></i> ${esc(mobilePrimary.label)}`
    document.body.appendChild(btn)
  }
}

export function screenEl() {
  return document.getElementById('screen')
}

export function goto(path, query) {
  navigate(path, query)
}
