/**
 * Visits — scheduling, confirmation, completion with explicit result.
 * Traceability: PS-MASTER-001 §14 (visit management), §27 (UI states),
 *               §29 (critical action confirmation) | PS-UX-010 §25
 *
 * A visit always connects PROPERTY + TENANT + LEAD (DR-005), so it is never
 * created here without lead context — the lead supplies the property.
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
  num,
  openModal,
  pagerHtml,
  readForm,
  relTime,
  skeletonRows,
  toLocalInput,
  toast,
  truncate
} from '../core/dom.js'
import { replaceQuery } from '../core/router.js'
import { screenEl, setHeader } from '../core/shell.js'

const VISIT_STATUS = ['SCHEDULED', 'CONFIRMED', 'COMPLETED', 'CANCELLED', 'NO_SHOW', 'RESCHEDULED']

const SCOPES = [
  { key: '', label: 'Semua', icon: 'fa-list' },
  { key: 'TODAY', label: 'Hari ini', icon: 'fa-calendar-day' },
  { key: 'UPCOMING', label: 'Akan datang', icon: 'fa-calendar-plus' },
  { key: 'NEEDS_RESULT', label: 'Perlu hasil', icon: 'fa-clipboard-question' }
]

const RESULTS = [
  { value: 'STRONG_FIT', label: 'Sangat cocok' },
  { value: 'POTENTIAL', label: 'Berpotensi' },
  { value: 'WEAK_FIT', label: 'Kurang cocok' },
  { value: 'NO_FIT', label: 'Tidak cocok' }
]

export async function visitListScreen({ query }) {
  const el = screenEl()
  const filters = {
    scope: query.scope || '',
    status: query.status || '',
    property_id: query.property_id || '',
    page: Number(query.page || 1)
  }

  setHeader({
    title: 'Kunjungan',
    subtitle: 'Survei properti — jadwal, konfirmasi, dan hasil kunjungan',
    actions: `<button class="btn" data-action="refresh"><i class="fa-solid fa-rotate-right"></i>Muat ulang</button>`
  })

  el.innerHTML = `
    <section class="stack">
      ${renderScopeTabs(filters)}
      ${renderFilters(filters)}
      <div class="card">
        <div class="card-head">
          <h2>Daftar Kunjungan</h2>
          <span class="badge" id="visit-count">…</span>
        </div>
        <div class="table-wrap">
          <table class="data">
            <thead>
              <tr>
                <th>Jadwal</th><th>Properti</th><th>Calon penyewa</th>
                <th>Status</th><th>Hasil</th><th class="right">Aksi</th>
              </tr>
            </thead>
            <tbody id="visit-body">${skeletonRows(6, 6)}</tbody>
          </table>
        </div>
        <div id="visit-pager"></div>
      </div>
    </section>`

  bindControls(el, filters, query)
  document
    .getElementById('page-actions')
    ?.querySelector('[data-action="refresh"]')
    ?.addEventListener('click', () => visitListScreen({ query }))

  let res
  try {
    res = await api.get('/visits', {
      scope: filters.scope || undefined,
      status: filters.status || undefined,
      property_id: filters.property_id || undefined,
      page: filters.page,
      limit: 20
    })
  } catch (err) {
    document.getElementById('visit-body').innerHTML = `<tr><td colspan="6">${errorState(err)}</td></tr>`
    document
      .querySelector('#visit-body [data-action="retry"]')
      ?.addEventListener('click', () => visitListScreen({ query }))
    return
  }

  const rows = res.data || []
  const body = document.getElementById('visit-body')
  document.getElementById('visit-count').textContent = `${num(res.meta?.total ?? rows.length)} kunjungan`

  if (rows.length === 0) {
    body.innerHTML = `<tr><td colspan="6">${emptyState({
      icon: 'fa-calendar-check',
      title: 'Belum ada kunjungan',
      message:
        'Kunjungan dijadwalkan dari detail lead agar selalu terhubung ke properti dan calon penyewa yang benar. Buka pipeline leads untuk menjadwalkan survei pertama.',
      action: { action: 'goto-leads', label: 'Buka Pipeline Leads', icon: 'fa-filter-circle-dollar' }
    })}</td></tr>`
    body.querySelector('[data-action="goto-leads"]')?.addEventListener('click', () => {
      location.hash = '#/leads'
    })
    document.getElementById('visit-pager').innerHTML = ''
    return
  }

  body.innerHTML = rows.map(renderRow).join('')
  document.getElementById('visit-pager').innerHTML = pagerHtml(res.meta)

  bindRows(body, () => visitListScreen({ query }))
  document.querySelectorAll('#visit-pager [data-page]').forEach((b) =>
    b.addEventListener('click', () => {
      const next = { ...query, page: b.dataset.page }
      replaceQuery(next)
      visitListScreen({ query: next })
    })
  )
}

function renderScopeTabs(f) {
  return `<div class="tabs">
    ${SCOPES.map(
      (s) => `<button class="tab ${f.scope === s.key ? 'active' : ''}" data-scope="${attr(s.key)}">
        <i class="fa-solid ${s.icon}"></i>${esc(s.label)}</button>`
    ).join('')}
  </div>`
}

function renderFilters(f) {
  return `<div class="card">
    <div class="card-body">
      <div class="filters">
        <div class="field">
          <label for="flt-status">Status</label>
          <select id="flt-status">
            <option value="">Semua status</option>
            ${VISIT_STATUS.map(
              (s) => `<option value="${attr(s)}" ${f.status === s ? 'selected' : ''}>${esc(humanEnum(s))}</option>`
            ).join('')}
          </select>
        </div>
        <div class="field">
          <label for="flt-prop">ID Properti</label>
          <input id="flt-prop" value="${attr(f.property_id)}" placeholder="Contoh: prp_kios_2x3">
        </div>
        <div class="field" style="align-self:end">
          <button class="btn" id="flt-reset"><i class="fa-solid fa-eraser"></i>Reset filter</button>
        </div>
      </div>
    </div>
  </div>`
}

/** Overdue = still open but the scheduled time has passed. */
function isOverdue(v) {
  if (!['SCHEDULED', 'CONFIRMED'].includes(v.status)) return false
  const t = new Date(String(v.scheduled_at).replace(' ', 'T') + 'Z').getTime()
  return Number.isFinite(t) && t < Date.now()
}

function renderRow(v) {
  const open = ['SCHEDULED', 'CONFIRMED'].includes(v.status)
  const overdue = isOverdue(v)
  return `<tr>
    <td>
      <div class="cell-main ${overdue ? 'danger-text' : ''}">${esc(fmtDateTime(v.scheduled_at))}</div>
      <div class="cell-sub">${esc(relTime(v.scheduled_at))}${overdue ? ' · lewat jadwal' : ''}</div>
    </td>
    <td>
      <a class="cell-main link" href="#/properties/${attr(v.property_id)}">${esc(v.property_name)}</a>
      <div class="cell-sub">${esc(truncate(v.property_address || '', 46))}</div>
    </td>
    <td>
      <a class="cell-main link" href="#/leads/${attr(v.lead_id)}">${esc(v.tenant_name)}</a>
      <div class="cell-sub">${esc(v.tenant_phone || '—')} · ${badge(v.lead_status)}</div>
    </td>
    <td>${badge(v.status)}</td>
    <td>
      ${v.result ? badge(v.result) : '<span class="dim tiny">Belum ada hasil</span>'}
      ${v.notes ? `<div class="cell-sub">${esc(truncate(v.notes, 60))}</div>` : ''}
    </td>
    <td class="right nowrap">
      ${renderRowActions(v, open)}
    </td>
  </tr>`
}

function renderRowActions(v, open) {
  if (!open) {
    return `<a class="btn sm" href="#/leads/${attr(v.lead_id)}"><i class="fa-solid fa-arrow-right"></i>Lead</a>`
  }
  const canUpdate = session.can('visit.update')
  const canComplete = session.can('visit.complete')
  if (!canUpdate && !canComplete) {
    return `<a class="btn sm" href="#/leads/${attr(v.lead_id)}">Buka lead</a>`
  }
  return `
    ${v.status === 'SCHEDULED' && canUpdate ? `<button class="btn sm" data-confirm-visit="${attr(v.id)}" title="Konfirmasi"><i class="fa-solid fa-thumbs-up"></i></button>` : ''}
    ${canComplete ? `<button class="btn sm primary" data-complete="${attr(v.id)}"><i class="fa-solid fa-clipboard-check"></i>Hasil</button>` : ''}
    ${canUpdate ? `<button class="btn sm" data-reschedule="${attr(v.id)}" title="Jadwalkan ulang"><i class="fa-solid fa-calendar-days"></i></button>` : ''}
    ${canUpdate ? `<button class="btn sm" data-noshow="${attr(v.id)}" title="Tidak hadir"><i class="fa-solid fa-user-slash"></i></button>` : ''}
    ${canUpdate ? `<button class="btn sm danger" data-cancel="${attr(v.id)}" title="Batalkan"><i class="fa-solid fa-xmark"></i></button>` : ''}`
}

function bindControls(el, f, query) {
  el.querySelectorAll('[data-scope]').forEach((b) =>
    b.addEventListener('click', () => {
      const next = { scope: b.dataset.scope, status: f.status, property_id: f.property_id, page: 1 }
      replaceQuery(next)
      visitListScreen({ query: next })
    })
  )
  const apply = (patch) => {
    const next = { scope: f.scope, status: f.status, property_id: f.property_id, ...patch, page: 1 }
    replaceQuery(next)
    visitListScreen({ query: next })
  }
  el.querySelector('#flt-status')?.addEventListener('change', (e) => apply({ status: e.target.value }))
  el.querySelector('#flt-prop')?.addEventListener('change', (e) => apply({ property_id: e.target.value.trim() }))
  el.querySelector('#flt-reset')?.addEventListener('click', () => apply({ scope: '', status: '', property_id: '' }))
}

function bindRows(body, reload) {
  body.querySelectorAll('[data-confirm-visit]').forEach((b) =>
    b.addEventListener('click', async () => {
      b.disabled = true
      try {
        await api.post(`/visits/${b.dataset.confirmVisit}/confirm`, {})
        toast('Kunjungan dikonfirmasi.', 'ok')
        reload()
      } catch (err) {
        b.disabled = false
        toast(errorText(err), 'err')
      }
    })
  )
  body.querySelectorAll('[data-complete]').forEach((b) =>
    b.addEventListener('click', () => openResultForm(b.dataset.complete, reload))
  )
  body.querySelectorAll('[data-reschedule]').forEach((b) =>
    b.addEventListener('click', () => openRescheduleForm(b.dataset.reschedule, reload))
  )
  body.querySelectorAll('[data-noshow]').forEach((b) =>
    b.addEventListener('click', () => openCloseForm(b.dataset.noshow, 'no-show', reload))
  )
  body.querySelectorAll('[data-cancel]').forEach((b) =>
    b.addEventListener('click', () => openCloseForm(b.dataset.cancel, 'cancel', reload))
  )
}

/* --------------------------------- Forms ---------------------------------- */

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

export function openResultForm(id, onDone) {
  formModal({
    title: 'Catat Hasil Kunjungan',
    bodyHtml: `
      <div class="inline-info">Hasil kunjungan wajib eksplisit (§14) karena memengaruhi skor lead dan langkah berikutnya.</div>
      <div class="form-grid">
        ${field({ name: 'result', label: 'Hasil kunjungan', type: 'select', required: true, value: 'POTENTIAL', options: RESULTS })}
        ${field({ name: 'notes', label: 'Catatan hasil', type: 'textarea', rows: 3, full: true, placeholder: 'Reaksi penyewa, keberatan, permintaan…' })}
      </div>`,
    submitLabel: 'Simpan Hasil',
    submitIcon: 'fa-clipboard-check',
    async onSubmit(body) {
      await api.post(`/visits/${id}/complete`, body)
      toast('Hasil kunjungan tersimpan.', 'ok')
      onDone()
    }
  })
}

export function openRescheduleForm(id, onDone) {
  formModal({
    title: 'Jadwalkan Ulang Kunjungan',
    bodyHtml: `
      <div class="inline-info">Kunjungan lama ditandai RESCHEDULED dan kunjungan baru dibuat pada waktu yang dipilih.</div>
      <div class="form-grid">
        ${field({
          name: 'scheduled_at',
          label: 'Waktu kunjungan baru',
          type: 'datetime-local',
          required: true,
          value: toLocalInput(new Date(Date.now() + 2 * 86400000))
        })}
        ${field({ name: 'reason', label: 'Alasan', full: true, placeholder: 'Contoh: penyewa berhalangan' })}
      </div>`,
    submitLabel: 'Jadwalkan Ulang',
    submitIcon: 'fa-calendar-days',
    async onSubmit(body) {
      await api.post(`/visits/${id}/reschedule`, body)
      toast('Kunjungan dijadwalkan ulang.', 'ok')
      onDone()
    }
  })
}

export function openCloseForm(id, kind, onDone) {
  const isCancel = kind === 'cancel'
  formModal({
    title: isCancel ? 'Batalkan Kunjungan' : 'Tandai Tidak Hadir',
    danger: true,
    bodyHtml: `
      <div class="consequence"><i class="fa-solid fa-circle-exclamation"></i>
        ${
          isCancel
            ? 'Kunjungan dibatalkan dan tidak dapat diselesaikan lagi. Jadwalkan kunjungan baru dari detail lead bila diperlukan.'
            : 'Kunjungan ditandai NO_SHOW. Ini tercatat pada riwayat lead dan menurunkan kualitas lead.'
        }
      </div>
      <div class="form-grid">
        ${field({ name: 'reason', label: 'Alasan', full: true, placeholder: isCancel ? 'Contoh: properti sudah tersewa' : 'Contoh: penyewa tidak datang tanpa kabar' })}
      </div>`,
    submitLabel: isCancel ? 'Batalkan Kunjungan' : 'Tandai Tidak Hadir',
    submitIcon: isCancel ? 'fa-xmark' : 'fa-user-slash',
    async onSubmit(body) {
      await api.post(`/visits/${id}/${isCancel ? 'cancel' : 'no-show'}`, body)
      toast(isCancel ? 'Kunjungan dibatalkan.' : 'Kunjungan ditandai tidak hadir.')
      onDone()
    }
  })
}
