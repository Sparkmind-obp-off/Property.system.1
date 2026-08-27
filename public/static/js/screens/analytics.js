/**
 * Analytics — commercial funnel, conversion rates, property & campaign performance.
 * Traceability: PS-MASTER-001 §20 (analytics), §42 (golden funnel), §27 (UI
 *               states), §54 (analytics is a read layer) | PS-UX-010 §12
 *
 * Core funnel: LEAD → QUALIFIED → VISIT → NEGOTIATION → RENTAL.
 * Read-only by contract: no duplicate business logic lives here, and every
 * weak number is paired with the operational screen that can fix it.
 */
import { api } from '../core/api.js'
import {
  attr,
  badge,
  emptyState,
  errorState,
  esc,
  humanEnum,
  loadingState,
  moneyShort,
  num,
  scorePill,
  truncate
} from '../core/dom.js'
import { replaceQuery } from '../core/router.js'
import { screenEl, setHeader } from '../core/shell.js'

/** The five funnel stages the business contract measures (§42). */
const CORE_STAGES = ['NEW', 'QUALIFIED', 'VISITED', 'NEGOTIATION', 'WON']

export async function analyticsScreen({ query = {} } = {}) {
  const el = screenEl()
  const view = query.view === 'detail' ? 'detail' : 'core'

  setHeader({
    title: 'Analytics',
    subtitle: 'Konversi funnel komersial, performa properti, dan efektivitas campaign',
    actions: `<button class="btn" data-action="refresh"><i class="fa-solid fa-rotate-right"></i>Muat ulang</button>`
  })
  document
    .querySelector('#page-actions [data-action="refresh"]')
    ?.addEventListener('click', () => analyticsScreen({ query }))

  el.innerHTML = loadingState('Menghitung metrik konversi…')

  let data
  try {
    data = (await api.get('/analytics/overview')).data
  } catch (err) {
    el.innerHTML = errorState(err)
    el.querySelector('[data-action="retry"]')?.addEventListener('click', () => analyticsScreen({ query }))
    return
  }

  const funnel = data.funnel || {}
  const rates = funnel.rates || {}
  const steps = funnel.steps || []

  if (!Number(rates.total_leads)) {
    el.innerHTML = emptyState({
      icon: 'fa-chart-line',
      title: 'Belum ada data konversi',
      message:
        'Analytics dihitung dari lead nyata. Buat lead pertama dari offer atau matching agar funnel mulai terukur.',
      action: { action: 'goto-leads', label: 'Buka Pipeline Leads', icon: 'fa-filter-circle-dollar' }
    })
    el.querySelector('[data-action="goto-leads"]')?.addEventListener('click', () => {
      location.hash = '#/leads'
    })
    return
  }

  el.innerHTML = `
    <section class="stack">
      ${renderRates(rates, data.time_to_rental || {})}
      ${renderDiagnosis(rates, data.time_to_rental || {})}
      ${renderFunnel(steps, view)}
      ${renderTrend(data.trend || [])}
      ${renderProperties(data.property_performance || [])}
      <div class="split">
        ${renderSources((data.campaigns || {}).by_source || [])}
        ${renderQualification(data.qualification || {})}
      </div>
      ${renderCampaigns((data.campaigns || {}).campaigns || [])}
    </section>`

  bindActions(el, query, view)
}

/* -------------------------------- KPI rates ------------------------------- */

function renderRates(r, ttr) {
  const cards = [
    {
      label: 'Total lead',
      value: num(r.total_leads),
      sub: `${num(r.loss_rate)}% berakhir hilang`,
      href: '#/leads'
    },
    {
      label: 'Qualification rate',
      value: `${num(r.qualification_rate)}%`,
      sub: 'lead lolos kualifikasi',
      href: '#/leads?status=QUALIFIED'
    },
    {
      label: 'Visit rate',
      value: `${num(r.visit_rate)}%`,
      sub: 'lead sampai survei',
      href: '#/visits'
    },
    {
      label: 'Negotiation rate',
      value: `${num(r.negotiation_rate)}%`,
      sub: 'lead masuk negosiasi',
      href: '#/negotiations'
    },
    {
      label: 'Rental conversion',
      value: `${num(r.rental_conversion_rate)}%`,
      sub: 'lead menjadi rental',
      href: '#/rentals'
    },
    {
      label: 'Time to rental',
      value: ttr.average_days === null || ttr.average_days === undefined ? '—' : `${num(ttr.average_days)} hr`,
      sub: ttr.sample_size ? `rata-rata dari ${num(ttr.sample_size)} rental` : 'belum ada rental selesai',
      href: '#/rentals'
    }
  ]

  return `<div class="grid cols-3">
    ${cards
      .map(
        (c) => `<a class="kpi" href="${attr(c.href)}" style="text-decoration:none;color:inherit;display:block">
          <div class="k-label">${esc(c.label)}</div>
          <div class="k-value">${c.value}</div>
          <div class="k-sub">${esc(c.sub)}</div>
        </a>`
      )
      .join('')}
  </div>`
}

/* ------------------------------- Diagnosis -------------------------------- */

/**
 * Turn rates into an operational verdict. Analytics that does not name the
 * bottleneck (and the screen that fixes it) is only decoration (§19, §20).
 */
function renderDiagnosis(r, ttr) {
  const findings = []

  const contactGap = 100 - Number(r.qualification_rate || 0)
  if (Number(r.qualification_rate) < 50) {
    findings.push({
      tone: 'risk',
      icon: 'fa-triangle-exclamation',
      text: `Hanya ${num(r.qualification_rate)}% lead lolos kualifikasi — ${num(contactGap)}% pipeline berhenti sebelum dinilai layak. Prioritaskan kualifikasi lead yang belum tersentuh.`,
      action: { label: 'Kualifikasi lead', href: '#/leads' }
    })
  } else {
    findings.push({
      tone: 'pro',
      icon: 'fa-check',
      text: `Kualifikasi sehat: ${num(r.qualification_rate)}% lead dinilai layak.`
    })
  }

  if (Number(r.qualification_rate) > 0 && Number(r.visit_rate) / Number(r.qualification_rate) < 0.6) {
    findings.push({
      tone: 'risk',
      icon: 'fa-calendar-xmark',
      text: `Lead terkualifikasi banyak yang tidak sampai survei (visit rate ${num(r.visit_rate)}%). Jadwalkan kunjungan dari detail lead agar momentum tidak hilang.`,
      action: { label: 'Kelola kunjungan', href: '#/visits' }
    })
  }

  if (Number(r.negotiation_rate) > 0 && Number(r.rental_conversion_rate) === 0) {
    findings.push({
      tone: 'con',
      icon: 'fa-handshake-slash',
      text: `Ada ${num(r.negotiation_rate)}% lead masuk negosiasi tetapi belum satu pun menjadi rental. Negosiasi yang menggantung adalah kebocoran nilai terbesar.`,
      action: { label: 'Tutup negosiasi', href: '#/negotiations' }
    })
  }

  if (Number(r.loss_rate) >= 20) {
    findings.push({
      tone: 'risk',
      icon: 'fa-arrow-trend-down',
      text: `Loss rate ${num(r.loss_rate)}%. Periksa alasan kehilangan pada lead berstatus LOST untuk memperbaiki penargetan segmen.`,
      action: { label: 'Lihat lead hilang', href: '#/leads?status=LOST' }
    })
  }

  if (!ttr.sample_size) {
    findings.push({
      tone: 'risk',
      icon: 'fa-hourglass-half',
      text: 'Belum ada rental yang selesai diaktifkan, sehingga time-to-rental belum dapat diukur sebagai baseline.',
      action: { label: 'Buka rental', href: '#/rentals' }
    })
  }

  return `
    <div class="card">
      <div class="card-head">
        <h2><i class="fa-solid fa-stethoscope"></i> Diagnosis Funnel</h2>
        <span class="badge ${findings.some((f) => f.tone !== 'pro') ? 'warn' : 'ok'}">
          ${findings.filter((f) => f.tone !== 'pro').length} perlu perhatian</span>
      </div>
      <div class="card-body">
        <div class="reasons">
          ${findings
            .map(
              (f) => `<div class="reason ${f.tone}">
                <i class="fa-solid ${f.icon}"></i>
                <span>${esc(f.text)}
                ${f.action ? ` <a class="link" href="${attr(f.action.href)}">${esc(f.action.label)} →</a>` : ''}</span>
              </div>`
            )
            .join('')}
        </div>
      </div>
    </div>`
}

/* --------------------------------- Funnel --------------------------------- */

function renderFunnel(steps, view) {
  const shown = view === 'detail' ? steps : steps.filter((s) => CORE_STAGES.includes(s.stage))
  const top = Number(steps[0]?.reached || 0) || 1

  // The biggest single-step drop is where the pipeline actually leaks.
  let worst = null
  for (let i = 1; i < shown.length; i++) {
    const drop = Number(shown[i - 1].reached) - Number(shown[i].reached)
    if (drop > 0 && (!worst || drop > worst.drop)) {
      worst = { drop, from: shown[i - 1], to: shown[i] }
    }
  }

  return `
    <div class="card">
      <div class="card-head">
        <h2>Funnel Komersial</h2>
        <div class="tabs" style="margin:0">
          <button class="tab ${view === 'core' ? 'active' : ''}" data-view="core">5 tahap inti</button>
          <button class="tab ${view === 'detail' ? 'active' : ''}" data-view="detail">Semua tahap</button>
        </div>
      </div>
      <div class="card-body">
        ${shown
          .map(
            (s) => `<div class="funnel-step">
              <div class="f-label">${esc(s.label || humanEnum(s.stage))}</div>
              <div class="f-bar"><span style="width:${Math.round((Number(s.reached || 0) / top) * 100)}%"></span></div>
              <div class="f-nums"><b>${num(s.reached)}</b> · ${num(s.conversion_from_top)}% dari puncak</div>
            </div>`
          )
          .join('')}
      </div>
      ${
        worst
          ? `<div class="card-foot">
              <span class="tiny"><b>Kebocoran terbesar:</b>
                ${esc(worst.from.label || humanEnum(worst.from.stage))} → ${esc(worst.to.label || humanEnum(worst.to.stage))}
                kehilangan ${num(worst.drop)} lead (tersisa ${num(worst.to.conversion_from_previous)}%).</span>
              <a class="btn sm" href="#/leads"><i class="fa-solid fa-filter-circle-dollar"></i>Perbaiki di pipeline</a>
            </div>`
          : ''
      }
    </div>`
}

/* ---------------------------------- Trend --------------------------------- */

function renderTrend(trend) {
  if (trend.length === 0) return ''
  const maxLeads = Math.max(1, ...trend.map((t) => Number(t.leads || 0)))

  return `
    <div class="card">
      <div class="card-head"><h2>Tren Bulanan</h2><span class="badge">${num(trend.length)} periode</span></div>
      <div class="card-body">
        ${trend
          .map(
            (t) => `<div class="bar-row">
              <span class="mono">${esc(t.period)}</span>
              <span class="bar-track">
                <span class="bar-fill ${Number(t.rentals) > 0 ? 'ok' : ''}"
                  style="width:${Math.round((Number(t.leads || 0) / maxLeads) * 100)}%"></span>
              </span>
              <span class="right tiny">${num(t.leads)} lead</span>
            </div>
            <div class="tiny dim" style="margin:-2px 0 6px">
              ${num(t.rentals)} rental${Number(t.revenue) > 0 ? ` · ${esc(moneyShort(t.revenue))} nilai rental` : ''}
            </div>`
          )
          .join('')}
      </div>
    </div>`
}

/* ---------------------------- Property performance ------------------------ */

function renderProperties(rows) {
  if (rows.length === 0) return ''

  return `
    <div class="card">
      <div class="card-head"><h2>Performa Properti</h2><span class="badge">${num(rows.length)} properti</span></div>
      <div class="table-wrap">
        <table class="data">
          <thead>
            <tr>
              <th>Properti</th><th>Status</th><th class="right">Skor</th>
              <th class="right">Lead</th><th class="right">Survei</th>
              <th class="right">Won / Lost</th><th class="right">Offer aktif</th><th>Catatan</th>
            </tr>
          </thead>
          <tbody>
            ${rows.map(renderPropertyRow).join('')}
          </tbody>
        </table>
      </div>
      <div class="card-foot">
        <span class="tiny dim">Properti tanpa offer aktif dan tanpa lead adalah aset diam yang tidak menghasilkan.</span>
      </div>
    </div>`
}

function renderPropertyRow(p) {
  const note = propertyNote(p)
  return `<tr>
    <td>
      <a class="cell-main link" href="#/properties/${attr(p.id)}">${esc(truncate(p.name, 40))}</a>
      <div class="cell-sub">${esc(humanEnum(p.property_type))} · ${esc(moneyShort(p.price))}</div>
    </td>
    <td>${badge(p.availability_status)}<div class="cell-sub">${badge(p.lifecycle_status)}</div></td>
    <td class="right">${p.analysis_score === null || p.analysis_score === undefined ? '<span class="dim tiny">belum</span>' : scorePill(p.analysis_score)}</td>
    <td class="right">${num(p.total_leads)}</td>
    <td class="right">${num(p.completed_visits)}</td>
    <td class="right nowrap">${num(p.won_leads)} / ${num(p.lost_leads)}</td>
    <td class="right">${Number(p.active_offers) > 0 ? num(p.active_offers) : '<span class="badge warn">0</span>'}</td>
    <td>${note ? `<span class="tiny ${note.tone}">${esc(note.text)}</span>` : '<span class="tiny dim">—</span>'}</td>
  </tr>`
}

function propertyNote(p) {
  if (Number(p.active_rentals) > 0) return { tone: 'dim', text: 'Sudah tersewa aktif.' }
  if (Number(p.total_leads) === 0 && Number(p.active_offers) === 0)
    return { tone: 'danger-text', text: 'Tidak dipasarkan dan tanpa lead — butuh offer.' }
  if (Number(p.total_leads) > 0 && Number(p.completed_visits) === 0)
    return { tone: 'danger-text', text: 'Ada lead tetapi belum ada survei.' }
  if (Number(p.lost_leads) > 0 && Number(p.won_leads) === 0)
    return { tone: 'danger-text', text: 'Semua lead hilang — periksa kesesuaian harga/segmen.' }
  if (p.analysis_score === null || p.analysis_score === undefined)
    return { tone: 'dim', text: 'Belum dianalisis.' }
  return null
}

/* --------------------------------- Sources -------------------------------- */

function renderSources(rows) {
  if (rows.length === 0) return ''
  const max = Math.max(1, ...rows.map((s) => Number(s.leads || 0)))

  return `
    <div class="card">
      <div class="card-head"><h2>Sumber Lead</h2><span class="badge">${num(rows.length)} sumber</span></div>
      <div class="card-body">
        ${rows
          .map(
            (s) => `<div class="bar-row">
              <span>${esc(humanEnum(s.source))}</span>
              <span class="bar-track">
                <span class="bar-fill ${Number(s.won) > 0 ? 'ok' : ''}"
                  style="width:${Math.round((Number(s.leads || 0) / max) * 100)}%"></span>
              </span>
              <span class="right tiny">${num(s.leads)}</span>
            </div>
            <div class="tiny dim" style="margin:-2px 0 6px">
              ${num(s.won)} won · ${num(s.lost)} lost · konversi ${esc(s.conversion_rate)}%
            </div>`
          )
          .join('')}
      </div>
    </div>`
}

/* ------------------------------ Qualification ----------------------------- */

function renderQualification(q) {
  const quals = q.qualification || []
  const visits = q.visit_results || []
  if (quals.length === 0 && visits.length === 0) return ''

  return `
    <div class="card">
      <div class="card-head"><h2>Kualitas Lead</h2></div>
      <div class="card-body">
        <div class="sub-head">Hasil kualifikasi</div>
        ${
          quals.length
            ? quals
                .map(
                  (r) => `<div class="row between" style="padding:4px 0">
                    <span>${badge(r.qualification_result)}</span>
                    <span class="tiny dim">${num(r.c)} lead · rata-rata fit ${r.avg_fit_score === null ? '—' : num(r.avg_fit_score)}</span>
                  </div>`
                )
                .join('')
            : '<div class="dim small">Belum ada lead yang dikualifikasi.</div>'
        }
        <div class="sub-head" style="margin-top:12px">Hasil kunjungan</div>
        ${
          visits.length
            ? visits
                .map(
                  (r) => `<div class="row between" style="padding:4px 0">
                    <span>${badge(r.result)}</span>
                    <span class="tiny dim">${num(r.c)} kunjungan</span>
                  </div>`
                )
                .join('')
            : '<div class="dim small">Belum ada kunjungan yang diselesaikan.</div>'
        }
      </div>
      <div class="card-foot">
        <a class="btn sm" href="#/leads"><i class="fa-solid fa-filter-circle-dollar"></i>Pipeline</a>
        <a class="btn sm" href="#/visits"><i class="fa-solid fa-calendar-check"></i>Kunjungan</a>
      </div>
    </div>`
}

/* -------------------------------- Campaigns ------------------------------- */

function renderCampaigns(rows) {
  if (rows.length === 0) return ''

  return `
    <div class="card">
      <div class="card-head"><h2>Performa Campaign</h2><span class="badge">${num(rows.length)} campaign</span></div>
      <div class="table-wrap">
        <table class="data">
          <thead>
            <tr>
              <th>Campaign</th><th>Kanal</th><th>Offer / Properti</th>
              <th class="right">Lead</th><th class="right">Terkualifikasi</th>
              <th class="right">Won</th><th class="right">Biaya / lead</th><th>Status</th>
            </tr>
          </thead>
          <tbody>
            ${rows
              .map(
                (c) => `<tr>
                  <td><div class="cell-main">${esc(truncate(c.name, 40))}</div>
                    <div class="cell-sub">${c.budget ? esc(moneyShort(c.budget)) : 'tanpa budget'}</div></td>
                  <td>${badge(c.channel, { tone: 'info' })}</td>
                  <td><div class="cell-main">${esc(truncate(c.offer_title || '—', 34))}</div>
                    <div class="cell-sub">${esc(c.property_name || '')}</div></td>
                  <td class="right">${num(c.leads)}</td>
                  <td class="right">${num(c.qualified_leads)}</td>
                  <td class="right">${num(c.won_leads)}</td>
                  <td class="right nowrap">${c.cost_per_lead ? esc(moneyShort(c.cost_per_lead)) : '—'}</td>
                  <td>${badge(c.status)}</td>
                </tr>`
              )
              .join('')}
          </tbody>
        </table>
      </div>
      <div class="card-foot">
        <span class="tiny dim">Biaya per lead tinggi dengan konversi 0% menandakan kanal atau segmen yang salah.</span>
        <a class="btn sm" href="#/campaigns"><i class="fa-solid fa-bullhorn"></i>Kelola campaign</a>
      </div>
    </div>`
}

/* -------------------------------- Bindings -------------------------------- */

function bindActions(el, query) {
  el.querySelectorAll('[data-view]').forEach((b) =>
    b.addEventListener('click', () => {
      const next = { ...query, view: b.dataset.view }
      replaceQuery(next)
      analyticsScreen({ query: next })
    })
  )
}
