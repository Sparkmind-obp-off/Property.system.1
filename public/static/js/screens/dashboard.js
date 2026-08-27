/**
 * Dashboard — the ACTION CENTER, not a statistics page.
 * Traceability: PS-MASTER-001 §19 | PS-UX-010 §12, §13 | API: GET /dashboard
 *
 * Priority: ACTION REQUIRED before GENERAL ANALYTICS (§19).
 */
import { api, session } from '../core/api.js'
import {
  badge,
  emptyState,
  errorState,
  esc,
  fmtDateTime,
  humanEnum,
  loadingState,
  money,
  moneyShort,
  num,
  pct,
  relTime,
  truncate
} from '../core/dom.js'
import { screenEl, setHeader, setNavBadges } from '../core/shell.js'

export async function dashboardScreen() {
  const el = screenEl()
  setHeader({
    title: 'Dashboard',
    subtitle: 'Apa yang terjadi · apa yang perlu perhatian · apa langkah berikutnya',
    actions: `<button class="btn" data-action="refresh"><i class="fa-solid fa-rotate-right"></i>Muat ulang</button>`
  })
  el.innerHTML = loadingState('Menghitung KPI dan work queue…')

  let payload
  try {
    const res = await api.get('/dashboard')
    payload = res.data
  } catch (err) {
    el.innerHTML = errorState(err)
    el.querySelector('[data-action="retry"]')?.addEventListener('click', dashboardScreen)
    return
  }

  const { action_center: actions, kpis, recent_activity: activity } = payload

  // Feed the sidebar counters from the same action center (single source).
  const followUps = actions
    .filter((a) => a.kind.startsWith('FOLLOW_UP'))
    .reduce((s, a) => s + a.count, 0)
  const leadsNew = actions.find((a) => a.kind === 'LEAD_UNCONTACTED')?.count || 0
  setNavBadges({
    '/activities': followUps ? { count: followUps, alert: actions.some((a) => a.kind === 'FOLLOW_UP_OVERDUE') } : null,
    '/leads': leadsNew ? { count: leadsNew } : null
  })

  el.innerHTML = `
    <section class="stack">
      ${renderActionCenter(actions)}
      ${renderKpis(kpis)}
      <div class="grid side">
        ${renderPipelineCard(kpis)}
        ${renderActivityCard(activity)}
      </div>
    </section>`

  bindDashboard(el)
}

function renderActionCenter(actions) {
  const total = actions.reduce((s, a) => s + a.count, 0)
  if (actions.length === 0) {
    return `<div class="card">
      <div class="card-head"><h2>Perlu Tindakan</h2></div>
      ${emptyState({
        icon: 'fa-circle-check',
        title: 'Tidak ada tindakan tertunda',
        message: 'Semua follow-up, kunjungan, dan negosiasi sudah ditangani. Tambah properti atau lead baru untuk mengisi pipeline.',
        action: { action: 'goto-leads', label: 'Buka Pipeline Leads', icon: 'fa-filter-circle-dollar' }
      })}
    </div>`
  }
  return `<div class="card">
    <div class="card-head">
      <h2>Perlu Tindakan</h2>
      <span class="badge ${actions.some((a) => a.severity === 'CRITICAL') ? 'danger' : 'warn'}">${num(total)} item</span>
      <div class="actions"><span class="tiny dim">Diurutkan berdasarkan urgensi</span></div>
    </div>
    <div>
      ${actions
        .map(
          (a) => `<div class="action-item" data-goto="${esc(a.href)}">
            <span class="sev ${a.severity}"></span>
            <span class="a-count">${num(a.count)}</span>
            <span class="a-label">${esc(a.label)}</span>
            <span style="margin-left:auto" class="row tight">
              ${badge(a.severity, { tone: a.severity === 'CRITICAL' ? 'danger' : a.severity === 'WARNING' ? 'warn' : 'info', label: a.severity === 'CRITICAL' ? 'Kritis' : a.severity === 'WARNING' ? 'Segera' : 'Info' })}
              <i class="fa-solid fa-chevron-right dim"></i>
            </span>
          </div>`
        )
        .join('')}
    </div>
  </div>`
}

function renderKpis(k) {
  const cards = [
    {
      label: 'Properti aktif',
      value: num(k.properties.total),
      sub: `${num(k.properties.available)} tersedia · ${num(k.properties.rented)} tersewa`
    },
    {
      label: 'Okupansi',
      value: pct(k.properties.occupancy_rate),
      sub: `${num(k.properties.marketed)} sedang dipasarkan`
    },
    {
      label: 'Lead terbuka',
      value: num(k.leads.open),
      sub: `${num(k.leads.hot)} hot · ${num(k.leads.new)} baru`
    },
    {
      label: 'Rental aktif',
      value: num(k.rentals.active),
      sub: `${moneyShort(k.rentals.monthly_revenue)} / bulan`
    }
  ]
  return `<div class="grid cols-4">
    ${cards
      .map(
        (c) => `<div class="kpi">
          <div class="k-label">${esc(c.label)}</div>
          <div class="k-value">${c.value}</div>
          <div class="k-sub">${esc(c.sub)}</div>
        </div>`
      )
      .join('')}
  </div>`
}

function renderPipelineCard(k) {
  const rows = [
    { label: 'Lead baru', value: k.leads.new, href: '/leads?status=NEW', icon: 'fa-inbox' },
    { label: 'Lead hot', value: k.leads.hot, href: '/leads?temperature=HOT', icon: 'fa-fire' },
    { label: 'Follow-up tertunda', value: k.operations.pending_follow_ups, href: '/activities', icon: 'fa-list-check' },
    { label: 'Kunjungan terjadwal', value: k.operations.scheduled_visits, href: '/visits', icon: 'fa-calendar-check' },
    { label: 'Negosiasi berjalan', value: k.operations.open_negotiations, href: '/negotiations', icon: 'fa-handshake' },
    { label: 'Lead menjadi rental', value: k.leads.won, href: '/leads?status=WON', icon: 'fa-trophy' }
  ]
  return `<div class="card">
    <div class="card-head">
      <h2>Ringkasan Pipeline</h2>
      <div class="actions"><a class="btn sm" href="#/leads"><i class="fa-solid fa-diagram-project"></i>Buka pipeline</a></div>
    </div>
    <div class="table-wrap">
      <table class="data">
        <tbody>
          ${rows
            .map(
              (r) => `<tr class="clickable" data-goto="${esc(r.href)}">
                <td style="width:34px"><i class="fa-solid ${r.icon} dim"></i></td>
                <td class="cell-main">${esc(r.label)}</td>
                <td class="right strong">${num(r.value)}</td>
                <td style="width:26px"><i class="fa-solid fa-chevron-right dim tiny"></i></td>
              </tr>`
            )
            .join('')}
        </tbody>
      </table>
    </div>
    <div class="card-foot row between">
      <span class="tiny dim">Pemasaran aktif</span>
      <span class="tiny">${num(k.marketing.active_offers)} offer · ${num(k.marketing.active_campaigns)} campaign</span>
    </div>
  </div>`
}

function renderActivityCard(items) {
  return `<div class="card">
    <div class="card-head"><h2>Aktivitas Terbaru</h2></div>
    ${
      items.length === 0
        ? emptyState({
            icon: 'fa-clock-rotate-left',
            title: 'Belum ada aktivitas',
            message: 'Aktivitas akan tercatat otomatis ketika Anda menghubungi lead, menjadwalkan kunjungan, atau membuat negosiasi.'
          })
        : `<div class="card-body">
            <div class="timeline">
              ${items
                .map(
                  (a) => `<div class="tl-item">
                    <div class="tl-when">${esc(relTime(a.occurred_at))} · ${esc(a.actor_name || 'Sistem')}</div>
                    <div class="tl-what">${esc(a.subject)}</div>
                    <div class="tl-desc">
                      ${badge(a.activity_type, { label: humanEnum(a.activity_type) })}
                      ${a.property_name ? `<span class="dim"> · ${esc(a.property_name)}</span>` : ''}
                      ${a.tenant_name ? `<span class="dim"> · ${esc(a.tenant_name)}</span>` : ''}
                    </div>
                    ${a.description ? `<div class="tl-desc">${esc(truncate(a.description, 110))}</div>` : ''}
                    ${a.lead_id ? `<a class="tiny" href="#/leads/${esc(a.lead_id)}">Buka lead <i class="fa-solid fa-arrow-right"></i></a>` : ''}
                  </div>`
                )
                .join('')}
            </div>
          </div>`
    }
  </div>`
}

function bindDashboard(el) {
  el.querySelectorAll('[data-goto]').forEach((n) => {
    n.addEventListener('click', () => {
      location.hash = `#${n.dataset.goto}`
    })
  })
  el.querySelector('[data-action="goto-leads"]')?.addEventListener('click', () => {
    location.hash = '#/leads'
  })
  document.querySelector('#page-actions [data-action="refresh"]')?.addEventListener('click', dashboardScreen)
}
