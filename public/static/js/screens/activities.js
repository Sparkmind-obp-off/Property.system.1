/**
 * Activities — follow-up work queue + cross-lead activity log.
 * Traceability: PS-MASTER-001 §12 (follow-up first-class), §13 (timeline),
 *               §19 (action center), §27 (UI states) | PS-UX-010 §23, §24
 *
 * The work queue is the operator's daily driver: OVERDUE → DUE TODAY →
 * UPCOMING, and every actionable row exposes a direct action (§12).
 */
import { api, errorText, session } from '../core/api.js'
import {
  applyFieldErrors,
  attr,
  badge,
  emptyState,
  errorState,
  esc,
  field,
  fmtDateTime,
  humanEnum,
  loadingState,
  num,
  openModal,
  pagerHtml,
  readForm,
  relTime,
  scorePill,
  skeletonRows,
  toLocalInput,
  toast,
  truncate
} from '../core/dom.js'
import { replaceQuery } from '../core/router.js'
import { screenEl, setHeader, setNavBadges } from '../core/shell.js'

const ACTIVITY_TYPES = ['CALL', 'MESSAGE', 'EMAIL', 'NOTE', 'VISIT', 'NEGOTIATION', 'SYSTEM', 'OTHER']

const BUCKETS = [
  {
    key: 'overdue',
    label: 'Terlambat',
    icon: 'fa-triangle-exclamation',
    tone: 'danger',
    hint: 'Sudah melewati jatuh tempo — tangani lebih dulu.'
  },
  {
    key: 'due_today',
    label: 'Jatuh tempo hari ini',
    icon: 'fa-bell',
    tone: 'warn',
    hint: 'Harus diselesaikan hari ini.'
  },
  {
    key: 'upcoming',
    label: 'Akan datang',
    icon: 'fa-calendar-day',
    tone: 'info',
    hint: 'Dijadwalkan 7 hari ke depan.'
  }
]

/* ========================================================================== *
 * WORK QUEUE
 * ========================================================================== */

export async function workQueueScreen({ query }) {
  const el = screenEl()
  const mine = query.mine === 'true'

  setHeader({
    title: 'Follow-Up',
    subtitle: 'Pusat tindakan harian · terlambat, jatuh tempo, dan akan datang',
    actions: `
      <button class="btn ${mine ? 'primary' : ''}" data-action="toggle-mine">
        <i class="fa-solid fa-user-check"></i>${mine ? 'Tugas saya' : 'Semua tugas'}</button>
      <a class="btn" href="#/activities/log"><i class="fa-solid fa-clock-rotate-left"></i>Log Aktivitas</a>
      <button class="btn" data-action="refresh"><i class="fa-solid fa-rotate-right"></i>Muat ulang</button>`
  })
  el.innerHTML = loadingState('Menyusun work queue…')

  let queue
  let counts
  try {
    const res = await api.get('/follow-ups/work-queue', { mine: mine ? 'true' : undefined })
    queue = res.data
    counts = res.meta?.counts || {}
  } catch (err) {
    el.innerHTML = errorState(err)
    el.querySelector('[data-action="retry"]')?.addEventListener('click', () => workQueueScreen({ query }))
    bindHeader(query)
    return
  }

  const total = BUCKETS.reduce((s, b) => s + (queue[b.key]?.length || 0), 0)
  setNavBadges({
    '/activities': total ? { count: total, alert: (counts.overdue || 0) > 0 } : null
  })

  if (total === 0) {
    el.innerHTML = `
      <section class="stack">
        ${renderQueueKpis(counts)}
        <div class="card">
          <div class="card-head"><h2>Work Queue</h2></div>
          ${emptyState({
            icon: 'fa-circle-check',
            title: 'Tidak ada follow-up tertunda',
            message:
              'Semua tindakan sudah diselesaikan. Buka pipeline leads untuk menjadwalkan follow-up berikutnya agar pipeline tetap bergerak.',
            action: { action: 'goto-leads', label: 'Buka Pipeline Leads', icon: 'fa-filter-circle-dollar' }
          })}
        </div>
      </section>`
    el.querySelector('[data-action="goto-leads"]')?.addEventListener('click', () => {
      location.hash = '#/leads'
    })
    bindHeader(query)
    return
  }

  el.innerHTML = `
    <section class="stack">
      ${renderQueueKpis(counts)}
      ${BUCKETS.map((b) => renderBucket(b, queue[b.key] || [])).join('')}
    </section>`

  bindQueue(el, query)
  bindHeader(query)
}

function renderQueueKpis(counts) {
  const cards = [
    { label: 'Terlambat', value: counts.overdue || 0, sub: 'Perlu tindakan segera' },
    { label: 'Jatuh tempo hari ini', value: counts.due_today || 0, sub: 'Selesaikan hari ini' },
    { label: 'Akan datang', value: counts.upcoming || 0, sub: '7 hari ke depan' }
  ]
  return `<div class="grid cols-3">
    ${cards
      .map(
        (c) => `<div class="kpi">
          <div class="k-label">${esc(c.label)}</div>
          <div class="k-value">${num(c.value)}</div>
          <div class="k-sub">${esc(c.sub)}</div>
        </div>`
      )
      .join('')}
  </div>`
}

function renderBucket(bucket, items) {
  if (items.length === 0) {
    return `<div class="card">
      <div class="card-head">
        <h2><i class="fa-solid ${bucket.icon}"></i> ${esc(bucket.label)}</h2>
        <span class="badge">0</span>
      </div>
      <div class="card-body"><div class="tiny dim">Tidak ada item pada kelompok ini.</div></div>
    </div>`
  }
  return `<div class="card">
    <div class="card-head">
      <h2><i class="fa-solid ${bucket.icon}"></i> ${esc(bucket.label)}</h2>
      <span class="badge ${bucket.tone}">${num(items.length)}</span>
      <div class="actions"><span class="tiny dim">${esc(bucket.hint)}</span></div>
    </div>
    <div class="table-wrap">
      <table class="data">
        <thead>
          <tr>
            <th>Tindakan</th>
            <th>Lead</th>
            <th>Properti</th>
            <th>Jatuh tempo</th>
            <th>Tahap</th>
            <th class="right">Aksi</th>
          </tr>
        </thead>
        <tbody>
          ${items.map((f) => renderQueueRow(f, bucket)).join('')}
        </tbody>
      </table>
    </div>
  </div>`
}

function renderQueueRow(f, bucket) {
  return `<tr>
    <td>
      <div class="cell-main">${esc(humanEnum(f.action_type))}</div>
      ${f.notes ? `<div class="cell-sub">${esc(truncate(f.notes, 70))}</div>` : ''}
    </td>
    <td>
      <a class="cell-main link" href="#/leads/${attr(f.lead_id)}">${esc(f.tenant_name)}</a>
      <div class="cell-sub row tight">
        ${scorePill(f.lead_score)}${badge(f.temperature)}
      </div>
    </td>
    <td>
      <div class="cell-main">${esc(f.property_name || '—')}</div>
      ${f.tenant_phone ? `<div class="cell-sub">${esc(f.tenant_phone)}</div>` : ''}
    </td>
    <td>
      <div class="cell-main ${bucket.key === 'overdue' ? 'danger-text' : ''}">${esc(relTime(f.due_at))}</div>
      <div class="cell-sub">${esc(fmtDateTime(f.due_at))}</div>
    </td>
    <td>${badge(f.lead_status)}</td>
    <td class="right nowrap">
      ${
        session.can('followup.update')
          ? `<button class="btn sm primary" data-complete="${attr(f.id)}" title="Selesaikan">
               <i class="fa-solid fa-check"></i>Selesai</button>
             <button class="btn sm" data-reschedule="${attr(f.id)}" title="Jadwalkan ulang">
               <i class="fa-solid fa-calendar-days"></i></button>
             <button class="btn sm danger" data-cancel="${attr(f.id)}" title="Batalkan">
               <i class="fa-solid fa-xmark"></i></button>`
          : `<a class="btn sm" href="#/leads/${attr(f.lead_id)}">Buka lead</a>`
      }
    </td>
  </tr>`
}

function bindQueue(el, query) {
  const reload = () => workQueueScreen({ query })

  el.querySelectorAll('[data-complete]').forEach((b) =>
    b.addEventListener('click', () => openCompleteForm(b.dataset.complete, reload))
  )
  el.querySelectorAll('[data-reschedule]').forEach((b) =>
    b.addEventListener('click', () => openRescheduleForm(b.dataset.reschedule, reload))
  )
  el.querySelectorAll('[data-cancel]').forEach((b) =>
    b.addEventListener('click', () => openCancelForm(b.dataset.cancel, reload))
  )
}

function bindHeader(query) {
  const host = document.getElementById('page-actions')
  host?.querySelector('[data-action="refresh"]')?.addEventListener('click', () => workQueueScreen({ query }))
  host?.querySelector('[data-action="toggle-mine"]')?.addEventListener('click', () => {
    const next = query.mine === 'true' ? {} : { mine: 'true' }
    replaceQuery(next)
    workQueueScreen({ query: next })
  })
}

/* ========================================================================== *
 * ACTIVITY LOG
 * ========================================================================== */

export async function activityLogScreen({ query }) {
  const el = screenEl()
  const filters = {
    activity_type: query.activity_type || '',
    lead_id: query.lead_id || '',
    page: Number(query.page || 1)
  }

  setHeader({
    title: 'Log Aktivitas',
    subtitle: 'Memori operasional lintas lead — siapa melakukan apa dan kapan',
    actions: `
      <a class="btn" href="#/activities"><i class="fa-solid fa-list-check"></i>Work Queue</a>
      <button class="btn" data-action="refresh"><i class="fa-solid fa-rotate-right"></i>Muat ulang</button>`
  })

  el.innerHTML = `
    <section class="stack">
      ${renderLogFilters(filters)}
      <div class="card">
        <div class="card-head"><h2>Aktivitas</h2></div>
        <div class="table-wrap">
          <table class="data">
            <thead><tr><th>Waktu</th><th>Jenis</th><th>Ringkasan</th><th>Lead</th><th>Oleh</th></tr></thead>
            <tbody id="log-body">${skeletonRows(5, 6)}</tbody>
          </table>
        </div>
        <div id="log-pager"></div>
      </div>
    </section>`

  bindLogFilters(el, filters)
  document
    .getElementById('page-actions')
    ?.querySelector('[data-action="refresh"]')
    ?.addEventListener('click', () => activityLogScreen({ query }))

  let res
  try {
    res = await api.get('/activities', {
      activity_type: filters.activity_type || undefined,
      lead_id: filters.lead_id || undefined,
      page: filters.page,
      limit: 30
    })
  } catch (err) {
    document.getElementById('log-body').innerHTML =
      `<tr><td colspan="5">${errorState(err)}</td></tr>`
    document
      .querySelector('#log-body [data-action="retry"]')
      ?.addEventListener('click', () => activityLogScreen({ query }))
    return
  }

  const rows = res.data || []
  const body = document.getElementById('log-body')

  if (rows.length === 0) {
    body.innerHTML = `<tr><td colspan="5">${emptyState({
      icon: 'fa-clock-rotate-left',
      title: 'Belum ada aktivitas tercatat',
      message:
        'Aktivitas tercatat otomatis saat Anda menghubungi lead, mengkualifikasi, menjadwalkan kunjungan, atau bernegosiasi.',
      action: { action: 'goto-leads', label: 'Buka Pipeline Leads', icon: 'fa-filter-circle-dollar' }
    })}</td></tr>`
    body.querySelector('[data-action="goto-leads"]')?.addEventListener('click', () => {
      location.hash = '#/leads'
    })
    document.getElementById('log-pager').innerHTML = ''
    return
  }

  body.innerHTML = rows
    .map(
      (a) => `<tr>
        <td>
          <div class="cell-main">${esc(relTime(a.occurred_at))}</div>
          <div class="cell-sub">${esc(fmtDateTime(a.occurred_at))}</div>
        </td>
        <td>${badge(a.activity_type, { label: humanEnum(a.activity_type) })}</td>
        <td>
          <div class="cell-main">${esc(a.subject || '—')}</div>
          ${a.description ? `<div class="cell-sub">${esc(truncate(a.description, 90))}</div>` : ''}
        </td>
        <td>
          <a class="cell-main link" href="#/leads/${attr(a.lead_id)}">${esc(a.tenant_name)}</a>
          <div class="cell-sub">${esc(a.property_name || '—')}</div>
        </td>
        <td class="dim">${esc(a.user_name || 'Sistem')}</td>
      </tr>`
    )
    .join('')

  document.getElementById('log-pager').innerHTML = pagerHtml(res.meta)
  document.querySelectorAll('#log-pager [data-page]').forEach((b) =>
    b.addEventListener('click', () => {
      const next = { ...query, page: b.dataset.page }
      replaceQuery(next)
      activityLogScreen({ query: next })
    })
  )
}

function renderLogFilters(f) {
  return `<div class="card">
    <div class="card-body">
      <div class="filters">
        <div class="field">
          <label for="flt-type">Jenis aktivitas</label>
          <select id="flt-type">
            <option value="">Semua jenis</option>
            ${ACTIVITY_TYPES.map(
              (t) => `<option value="${attr(t)}" ${f.activity_type === t ? 'selected' : ''}>${esc(humanEnum(t))}</option>`
            ).join('')}
          </select>
        </div>
        <div class="field">
          <label for="flt-lead">ID Lead</label>
          <input id="flt-lead" value="${attr(f.lead_id)}" placeholder="Contoh: led_ani_ruko">
        </div>
        <div class="field" style="align-self:end">
          <button class="btn" id="flt-reset"><i class="fa-solid fa-eraser"></i>Reset filter</button>
        </div>
      </div>
    </div>
  </div>`
}

function bindLogFilters(el, f) {
  const apply = (patch) => {
    const next = { activity_type: f.activity_type, lead_id: f.lead_id, ...patch, page: 1 }
    replaceQuery(next)
    activityLogScreen({ query: next })
  }
  el.querySelector('#flt-type')?.addEventListener('change', (e) => apply({ activity_type: e.target.value }))
  el.querySelector('#flt-lead')?.addEventListener('change', (e) => apply({ lead_id: e.target.value.trim() }))
  el.querySelector('#flt-reset')?.addEventListener('click', () => apply({ activity_type: '', lead_id: '' }))
}

/* ========================================================================== *
 * FORMS — follow-up lifecycle (PENDING → COMPLETED / RESCHEDULED / CANCELLED)
 * ========================================================================== */

function formModal({ title, bodyHtml, submitLabel, submitIcon = 'fa-check', danger, onSubmit }) {
  openModal({
    title,
    body: `<form id="mf-form" novalidate><div id="mf-error"></div>${bodyHtml}</form>`,
    footer: `
      <button class="btn" data-modal-close>Batal</button>
      <button class="btn ${danger ? 'danger' : 'primary'}" id="mf-save">
        <i class="fa-solid ${submitIcon}"></i>${esc(submitLabel)}</button>`,
    onMount(root, close) {
      const form = root.querySelector('#mf-form')
      const errBox = root.querySelector('#mf-error')
      const btn = root.querySelector('#mf-save')
      btn.addEventListener('click', async () => {
        errBox.innerHTML = ''
        btn.disabled = true
        btn.innerHTML = '<i class="fa-solid fa-spinner fa-spin"></i> Memproses…'
        try {
          await onSubmit(readForm(form))
          close()
        } catch (err) {
          btn.disabled = false
          btn.innerHTML = `<i class="fa-solid ${submitIcon}"></i>${esc(submitLabel)}`
          if (err.isValidation) {
            const rest = applyFieldErrors(form, err.details)
            errBox.innerHTML = `<div class="inline-error">${esc(err.message)}${rest.length ? ` — ${esc(rest.join(' · '))}` : ''}</div>`
          } else {
            errBox.innerHTML = `<div class="inline-error">${esc(errorText(err))}</div>`
          }
        }
      })
    }
  })
}

export function openCompleteForm(id, onDone) {
  formModal({
    title: 'Selesaikan Follow-Up',
    bodyHtml: `
      <div class="inline-info">Hasil wajib dicatat agar jejak operasional tetap dapat dilacak (§46 audit).</div>
      <div class="form-grid">
        ${field({ name: 'outcome', label: 'Hasil', required: true, full: true, placeholder: 'Contoh: penyewa setuju survei hari Sabtu' })}
        ${field({ name: 'notes', label: 'Catatan tambahan', type: 'textarea', rows: 2, full: true })}
      </div>`,
    submitLabel: 'Tandai Selesai',
    async onSubmit(body) {
      await api.post(`/follow-ups/${id}/complete`, body)
      toast('Follow-up selesai.', 'ok')
      onDone()
    }
  })
}

export function openRescheduleForm(id, onDone) {
  formModal({
    title: 'Jadwalkan Ulang Follow-Up',
    bodyHtml: `
      <div class="inline-info">Follow-up lama ditandai RESCHEDULED dan follow-up baru dibuat pada waktu yang dipilih.</div>
      <div class="form-grid">
        ${field({
          name: 'due_at',
          label: 'Jatuh tempo baru',
          type: 'datetime-local',
          required: true,
          value: toLocalInput(new Date(Date.now() + 86400000))
        })}
        ${field({ name: 'reason', label: 'Alasan', full: true, placeholder: 'Contoh: penyewa minta dihubungi pekan depan' })}
      </div>`,
    submitLabel: 'Jadwalkan Ulang',
    submitIcon: 'fa-calendar-days',
    async onSubmit(body) {
      await api.post(`/follow-ups/${id}/reschedule`, body)
      toast('Follow-up dijadwalkan ulang.', 'ok')
      onDone()
    }
  })
}

export function openCancelForm(id, onDone) {
  formModal({
    title: 'Batalkan Follow-Up',
    danger: true,
    bodyHtml: `
      <div class="consequence"><i class="fa-solid fa-circle-exclamation"></i>
        Follow-up ini dibatalkan dan hilang dari work queue. Lead tidak akan lagi mengingatkan tindakan ini.
      </div>
      <div class="form-grid">
        ${field({ name: 'reason', label: 'Alasan pembatalan', full: true, placeholder: 'Contoh: lead sudah dihubungi lewat kanal lain' })}
      </div>`,
    submitLabel: 'Batalkan Follow-Up',
    submitIcon: 'fa-xmark',
    async onSubmit(body) {
      await api.post(`/follow-ups/${id}/cancel`, body)
      toast('Follow-up dibatalkan.')
      onDone()
    }
  })
}
