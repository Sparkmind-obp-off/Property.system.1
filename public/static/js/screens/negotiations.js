/**
 * Negotiations — list + detail with round history and explicit acceptance.
 * Traceability: PS-MASTER-001 §15 (negotiation), §29 (critical action),
 *               §27 (UI states) | PS-UX-010 §26
 *
 * Acceptance is a CRITICAL ACTION: it is never a status dropdown, always an
 * explicit confirmed operation stating its consequence (§29).
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
  fmtDate,
  fmtDateTime,
  humanEnum,
  loadingState,
  money,
  moneyShort,
  num,
  openModal,
  pagerHtml,
  pct,
  readForm,
  relTime,
  scorePill,
  skeletonRows,
  toast,
  truncate
} from '../core/dom.js'
import { replaceQuery } from '../core/router.js'
import { screenEl, setHeader } from '../core/shell.js'

const NEGOTIATION_STATUS = ['OPEN', 'COUNTER_OFFER', 'AGREED', 'REJECTED', 'FAILED', 'CANCELLED']

/* ========================================================================== *
 * LIST
 * ========================================================================== */

export async function negotiationListScreen({ query }) {
  const el = screenEl()

  // A negotiation id in the query opens the detail panel (single-screen drill-in).
  if (query.id) return negotiationDetail(query.id, query)

  const filters = {
    status: query.status || '',
    property_id: query.property_id || '',
    page: Number(query.page || 1)
  }

  setHeader({
    title: 'Negosiasi',
    subtitle: 'Tawar-menawar harga dan ketentuan sebelum rental dibuat',
    actions: `<button class="btn" data-action="refresh"><i class="fa-solid fa-rotate-right"></i>Muat ulang</button>`
  })

  el.innerHTML = `
    <section class="stack">
      ${renderFilters(filters)}
      <div class="card">
        <div class="card-head">
          <h2>Daftar Negosiasi</h2>
          <span class="badge" id="ngt-count">…</span>
        </div>
        <div class="table-wrap">
          <table class="data">
            <thead>
              <tr>
                <th>Properti</th><th>Calon penyewa</th><th>Harga minta</th>
                <th>Usulan / Sepakat</th><th>Putaran</th><th>Status</th><th class="right">Aksi</th>
              </tr>
            </thead>
            <tbody id="ngt-body">${skeletonRows(7, 6)}</tbody>
          </table>
        </div>
        <div id="ngt-pager"></div>
      </div>
    </section>`

  bindFilters(el, filters)
  document
    .getElementById('page-actions')
    ?.querySelector('[data-action="refresh"]')
    ?.addEventListener('click', () => negotiationListScreen({ query }))

  let res
  try {
    res = await api.get('/negotiations', {
      status: filters.status || undefined,
      property_id: filters.property_id || undefined,
      page: filters.page,
      limit: 20
    })
  } catch (err) {
    document.getElementById('ngt-body').innerHTML = `<tr><td colspan="7">${errorState(err)}</td></tr>`
    document
      .querySelector('#ngt-body [data-action="retry"]')
      ?.addEventListener('click', () => negotiationListScreen({ query }))
    return
  }

  const rows = res.data || []
  const body = document.getElementById('ngt-body')
  document.getElementById('ngt-count').textContent = `${num(res.meta?.total ?? rows.length)} negosiasi`

  if (rows.length === 0) {
    body.innerHTML = `<tr><td colspan="7">${emptyState({
      icon: 'fa-handshake',
      title: 'Belum ada negosiasi',
      message:
        'Negosiasi dibuka dari detail lead setelah kunjungan menunjukkan kecocokan. Buka pipeline leads untuk melanjutkan lead yang siap bernegosiasi.',
      action: { action: 'goto-leads', label: 'Buka Pipeline Leads', icon: 'fa-filter-circle-dollar' }
    })}</td></tr>`
    body.querySelector('[data-action="goto-leads"]')?.addEventListener('click', () => {
      location.hash = '#/leads'
    })
    document.getElementById('ngt-pager').innerHTML = ''
    return
  }

  body.innerHTML = rows.map(renderRow).join('')
  document.getElementById('ngt-pager').innerHTML = pagerHtml(res.meta)

  body.querySelectorAll('[data-open]').forEach((b) =>
    b.addEventListener('click', () => {
      const next = { ...query, id: b.dataset.open }
      replaceQuery(next)
      negotiationDetail(b.dataset.open, next)
    })
  )
  document.querySelectorAll('#ngt-pager [data-page]').forEach((b) =>
    b.addEventListener('click', () => {
      const next = { ...query, page: b.dataset.page }
      replaceQuery(next)
      negotiationListScreen({ query: next })
    })
  )
}

function renderFilters(f) {
  return `<div class="card">
    <div class="card-body">
      <div class="filters">
        <div class="field">
          <label for="flt-status">Status</label>
          <select id="flt-status">
            <option value="">Semua status</option>
            ${NEGOTIATION_STATUS.map(
              (s) => `<option value="${attr(s)}" ${f.status === s ? 'selected' : ''}>${esc(humanEnum(s))}</option>`
            ).join('')}
          </select>
        </div>
        <div class="field">
          <label for="flt-prop">ID Properti</label>
          <input id="flt-prop" value="${attr(f.property_id)}" placeholder="Contoh: prp_ruko_3x6">
        </div>
        <div class="field" style="align-self:end">
          <button class="btn" id="flt-reset"><i class="fa-solid fa-eraser"></i>Reset filter</button>
        </div>
      </div>
    </div>
  </div>`
}

function bindFilters(el, f) {
  const apply = (patch) => {
    const next = { status: f.status, property_id: f.property_id, ...patch, page: 1 }
    replaceQuery(next)
    negotiationListScreen({ query: next })
  }
  el.querySelector('#flt-status')?.addEventListener('change', (e) => apply({ status: e.target.value }))
  el.querySelector('#flt-prop')?.addEventListener('change', (e) => apply({ property_id: e.target.value.trim() }))
  el.querySelector('#flt-reset')?.addEventListener('click', () => apply({ status: '', property_id: '' }))
}

function renderRow(n) {
  const gap = Number(n.property_list_price || 0) - Number(n.agreed_price ?? n.proposed_price ?? 0)
  return `<tr>
    <td>
      <a class="cell-main link" href="#/properties/${attr(n.property_id)}">${esc(n.property_name)}</a>
      <div class="cell-sub">${esc(n.id)}</div>
    </td>
    <td>
      <a class="cell-main link" href="#/leads/${attr(n.lead_id)}">${esc(n.tenant_name)}</a>
      <div class="cell-sub">${badge(n.lead_status)}</div>
    </td>
    <td class="nowrap">${money(n.property_list_price ?? n.current_price)}</td>
    <td class="nowrap">
      <div class="cell-main">${money(n.agreed_price ?? n.proposed_price)}</div>
      <div class="cell-sub ${gap > 0 ? 'warn-text' : ''}">${gap > 0 ? `turun ${moneyShort(gap)}` : 'sesuai harga minta'}</div>
    </td>
    <td class="right">${num(n.round_count ?? 0)}</td>
    <td>${badge(n.status)}</td>
    <td class="right nowrap">
      <button class="btn sm primary" data-open="${attr(n.id)}"><i class="fa-solid fa-folder-open"></i>Detail</button>
    </td>
  </tr>`
}

/* ========================================================================== *
 * DETAIL
 * ========================================================================== */

async function negotiationDetail(id, query) {
  const el = screenEl()
  setHeader({ title: 'Negosiasi', subtitle: 'Memuat detail…' })
  el.innerHTML = loadingState('Memuat riwayat negosiasi…')

  let n
  try {
    const res = await api.get(`/negotiations/${id}`)
    n = res.data
  } catch (err) {
    el.innerHTML = errorState(err)
    el.querySelector('[data-action="retry"]')?.addEventListener('click', () => negotiationDetail(id, query))
    el.querySelector('[data-action="back"]')?.addEventListener('click', () => backToList(query))
    return
  }

  const reload = () => negotiationDetail(id, query)
  const open = ['OPEN', 'COUNTER_OFFER'].includes(n.status)

  setHeader({
    title: `Negosiasi — ${n.tenant_name}`,
    subtitle: `${esc(n.property_name)} · ${badge(n.status)}`,
    actions: `
      <button class="btn" data-action="back"><i class="fa-solid fa-arrow-left"></i>Daftar</button>
      ${open && session.can('negotiation.update') ? `<button class="btn" data-action="counter"><i class="fa-solid fa-arrow-right-arrow-left"></i>Penawaran balik</button>` : ''}
      ${open && session.can('negotiation.accept') ? `<button class="btn primary" data-action="accept"><i class="fa-solid fa-handshake-simple"></i>Terima kesepakatan</button>` : ''}
      ${open && session.can('negotiation.update') ? `<button class="btn danger" data-action="reject"><i class="fa-solid fa-ban"></i>Tolak</button>` : ''}`
  })

  el.innerHTML = `
    <section class="stack">
      ${renderNextStep(n)}
      ${renderPriceCards(n)}
      <div class="grid side">
        ${renderRounds(n)}
        <div class="stack">
          ${renderContext(n)}
          ${renderDiscount(n)}
          ${renderRentalLink(n)}
        </div>
      </div>
    </section>`

  bindDetail(el, n, reload, query)
}

function backToList(query) {
  const next = { ...query }
  delete next.id
  replaceQuery(next)
  negotiationListScreen({ query: next })
}

/** §24 spirit: the next action must always be obvious. */
function renderNextStep(n) {
  if (n.status === 'AGREED') {
    if (n.rental) {
      return `<div class="next-action ok">
        <i class="fa-solid fa-file-signature"></i>
        <div>
          <div class="na-label">Langkah berikutnya</div>
          <div class="na-title">Rental sudah dibuat (${esc(humanEnum(n.rental.status))})</div>
          <div class="na-reason">Lanjutkan aktivasi rental agar properti berpindah status.</div>
        </div>
        <a class="btn primary" href="#/rentals?id=${attr(n.rental.id)}">Buka rental</a>
      </div>`
    }
    return `<div class="next-action ok">
      <i class="fa-solid fa-file-signature"></i>
      <div>
        <div class="na-label">Langkah berikutnya</div>
        <div class="na-title">Buat rental dari kesepakatan ini</div>
        <div class="na-reason">Harga sepakat ${money(n.agreed_price)} sudah terkunci. Rental dibuat dari detail lead.</div>
      </div>
      <a class="btn primary" href="#/leads/${attr(n.lead_id)}">Buka lead</a>
    </div>`
  }
  if (['REJECTED', 'FAILED', 'CANCELLED'].includes(n.status)) {
    return `<div class="next-action">
      <i class="fa-solid fa-circle-xmark"></i>
      <div>
        <div class="na-label">Status akhir</div>
        <div class="na-title">Negosiasi ${esc(humanEnum(n.status))}</div>
        <div class="na-reason">${esc(n.notes || 'Tidak ada kesepakatan tercapai.')}</div>
      </div>
      <a class="btn" href="#/leads/${attr(n.lead_id)}">Buka lead</a>
    </div>`
  }
  const lastActor = n.rounds?.length ? n.rounds[n.rounds.length - 1].actor : null
  return `<div class="next-action warn">
    <i class="fa-solid fa-hourglass-half"></i>
    <div>
      <div class="na-label">Langkah berikutnya</div>
      <div class="na-title">${lastActor === 'OWNER' ? 'Menunggu jawaban calon penyewa' : 'Beri penawaran balik atau terima usulan'}</div>
      <div class="na-reason">Selisih terhadap harga minta: ${moneyShort(Math.max(0, Number(n.property_list_price || 0) - Number(n.proposed_price || 0)))}.</div>
    </div>
    ${session.can('negotiation.update') ? `<button class="btn primary" data-action="counter">Penawaran balik</button>` : ''}
  </div>`
}

function renderPriceCards(n) {
  const cards = [
    { label: 'Harga minta', value: money(n.property_list_price ?? n.current_price), sub: `Periode ${humanEnum(n.price_period || 'MONTH')}` },
    { label: 'Usulan penyewa', value: money(n.proposed_price), sub: 'Putaran pertama' },
    { label: 'Harga berjalan', value: money(n.current_price), sub: 'Posisi terakhir pemilik' },
    { label: 'Harga sepakat', value: n.agreed_price ? money(n.agreed_price) : '—', sub: n.agreed_at ? fmtDate(n.agreed_at) : 'Belum sepakat' }
  ]
  return `<div class="grid cols-4">
    ${cards
      .map(
        (c) => `<div class="kpi">
          <div class="k-label">${esc(c.label)}</div>
          <div class="k-value" style="font-size:1.15rem">${c.value}</div>
          <div class="k-sub">${esc(c.sub)}</div>
        </div>`
      )
      .join('')}
  </div>`
}

function renderRounds(n) {
  const rounds = n.rounds || []
  return `<div class="card">
    <div class="card-head">
      <h2>Riwayat Putaran</h2>
      <span class="badge">${num(rounds.length)} putaran</span>
    </div>
    ${
      rounds.length === 0
        ? emptyState({
            icon: 'fa-arrow-right-arrow-left',
            title: 'Belum ada putaran tercatat',
            message: 'Setiap usulan dan penawaran balik akan muncul di sini sebagai riwayat negosiasi.'
          })
        : `<div class="card-body">
            <div class="timeline">
              ${rounds
                .map(
                  (r) => `<div class="tl-item">
                    <div class="tl-when">${esc(fmtDateTime(r.created_at))} · ${esc(r.created_by_name || 'Sistem')}</div>
                    <div class="tl-what">
                      ${badge(r.actor, { tone: r.actor === 'OWNER' ? 'brand' : 'info', label: r.actor === 'OWNER' ? 'Pemilik' : 'Penyewa' })}
                      ${badge(r.round_type)}
                      <strong style="margin-left:6px">${money(r.price)}</strong>
                    </div>
                    ${r.terms ? `<div class="tl-desc">Ketentuan: ${esc(truncate(r.terms, 130))}</div>` : ''}
                    ${r.notes ? `<div class="tl-desc dim">${esc(truncate(r.notes, 130))}</div>` : ''}
                  </div>`
                )
                .join('')}
            </div>
          </div>`
    }
  </div>`
}

function renderContext(n) {
  return `<div class="card">
    <div class="card-head"><h2>Konteks</h2></div>
    <div class="card-body">
      <dl class="kv">
        <dt>Properti</dt><dd><a class="link" href="#/properties/${attr(n.property_id)}">${esc(n.property_name)}</a></dd>
        <dt>Ketersediaan</dt><dd>${badge(n.property_availability)}</dd>
        <dt>Calon penyewa</dt><dd>${esc(n.tenant_name)}</dd>
        <dt>Telepon</dt><dd>${esc(n.tenant_phone || '—')}</dd>
        <dt>Lead</dt><dd><a class="link" href="#/leads/${attr(n.lead_id)}">${esc(n.lead_id)}</a> ${badge(n.lead_status)}</dd>
        <dt>Skor lead</dt><dd>${scorePill(n.lead_score)}</dd>
        <dt>Kunjungan</dt><dd>${n.visit_id ? esc(n.visit_id) : '<span class="dim">Tanpa kunjungan</span>'}</dd>
        <dt>Dibuka</dt><dd>${esc(fmtDateTime(n.started_at))} · ${esc(n.created_by_name || '—')}</dd>
        ${n.closed_at ? `<dt>Ditutup</dt><dd>${esc(fmtDateTime(n.closed_at))}</dd>` : ''}
      </dl>
      ${n.terms ? `<div class="note"><div class="note-label">Ketentuan berjalan</div>${esc(n.terms)}</div>` : ''}
      ${n.notes ? `<div class="note"><div class="note-label">Catatan</div>${esc(n.notes)}</div>` : ''}
    </div>
  </div>`
}

function renderDiscount(n) {
  const d = n.discount_analysis
  if (!d) return ''
  const tone = d.severity === 'HIGH' ? 'danger' : d.severity === 'MEDIUM' ? 'warn' : 'ok'
  return `<div class="card">
    <div class="card-head">
      <h2>Analisis Konsesi</h2>
      ${badge(d.severity, { tone })}
    </div>
    <div class="card-body">
      <dl class="kv">
        <dt>Potongan</dt><dd>${money(d.discount_amount)}</dd>
        <dt>Persentase</dt><dd>${pct(d.discount_percent)}</dd>
      </dl>
      <div class="tiny dim">${esc(d.note || '')}</div>
    </div>
  </div>`
}

function renderRentalLink(n) {
  if (!n.rental) return ''
  const r = n.rental
  return `<div class="card">
    <div class="card-head"><h2>Rental Terkait</h2>${badge(r.status)}</div>
    <div class="card-body">
      <dl class="kv">
        <dt>Harga</dt><dd>${money(r.price)}</dd>
        <dt>Mulai</dt><dd>${esc(fmtDate(r.start_date))}</dd>
        <dt>Berakhir</dt><dd>${esc(fmtDate(r.end_date))}</dd>
      </dl>
      <a class="btn sm" href="#/rentals?id=${attr(r.id)}"><i class="fa-solid fa-file-signature"></i>Buka rental</a>
    </div>
  </div>`
}

function bindDetail(el, n, reload, query) {
  const host = document.getElementById('page-actions')
  host?.querySelector('[data-action="back"]')?.addEventListener('click', () => backToList(query))
  const counter = () => openCounterForm(n, reload)
  host?.querySelector('[data-action="counter"]')?.addEventListener('click', counter)
  el.querySelector('[data-action="counter"]')?.addEventListener('click', counter)
  host?.querySelector('[data-action="accept"]')?.addEventListener('click', () => openAcceptForm(n, reload))
  host?.querySelector('[data-action="reject"]')?.addEventListener('click', () => openRejectForm(n, reload))
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

function openCounterForm(n, onDone) {
  formModal({
    title: 'Penawaran Balik',
    bodyHtml: `
      <div class="inline-info">Harga minta <strong>${money(n.property_list_price ?? n.current_price)}</strong> ·
        posisi berjalan <strong>${money(n.current_price)}</strong> ·
        usulan penyewa <strong>${money(n.proposed_price)}</strong>.</div>
      <div class="form-grid">
        ${field({ name: 'price', label: 'Harga penawaran', type: 'number', required: true, value: n.current_price, min: 0, step: 50000 })}
        ${field({
          name: 'actor',
          label: 'Pihak yang menawar',
          type: 'select',
          value: 'OWNER',
          options: [
            { value: 'OWNER', label: 'Pemilik / pengelola' },
            { value: 'TENANT', label: 'Calon penyewa' }
          ],
          hint: 'Pilih TENANT bila Anda mencatat tawaran baru dari penyewa.'
        })}
        ${field({ name: 'terms', label: 'Ketentuan', type: 'textarea', rows: 2, full: true, value: n.terms, placeholder: 'Durasi, deposit, pembayaran…' })}
        ${field({ name: 'notes', label: 'Catatan', type: 'textarea', rows: 2, full: true })}
      </div>`,
    submitLabel: 'Kirim Penawaran',
    submitIcon: 'fa-arrow-right-arrow-left',
    async onSubmit(body) {
      await api.post(`/negotiations/${n.id}/counter`, body)
      toast('Penawaran balik tercatat.', 'ok')
      onDone()
    }
  })
}

function openAcceptForm(n, onDone) {
  const suggested = n.current_price ?? n.proposed_price
  formModal({
    title: 'Terima Kesepakatan',
    bodyHtml: `
      <div class="consequence"><i class="fa-solid fa-circle-exclamation"></i>
        Menerima kesepakatan mengunci harga sewa dan mengizinkan pembuatan rental untuk properti
        <strong>${esc(n.property_name)}</strong>. Tindakan ini tidak dapat dibatalkan.
      </div>
      <div class="form-grid">
        ${field({ name: 'agreed_price', label: 'Harga sepakat', type: 'number', required: true, value: suggested, min: 0, step: 50000, hint: `Harga minta: ${money(n.property_list_price ?? n.current_price)}` })}
        ${field({ name: 'terms', label: 'Ketentuan final', type: 'textarea', rows: 3, full: true, value: n.terms, placeholder: 'Durasi sewa, deposit, jadwal pembayaran…' })}
      </div>`,
    submitLabel: 'Terima Kesepakatan',
    submitIcon: 'fa-handshake-simple',
    async onSubmit(body) {
      await api.post(`/negotiations/${n.id}/accept`, body)
      toast('Kesepakatan diterima. Lanjutkan pembuatan rental.', 'ok')
      onDone()
    }
  })
}

function openRejectForm(n, onDone) {
  formModal({
    title: 'Tolak Negosiasi',
    danger: true,
    bodyHtml: `
      <div class="consequence"><i class="fa-solid fa-circle-exclamation"></i>
        Negosiasi ditutup sebagai REJECTED. Lead tetap ada, tetapi rental tidak dapat dibuat dari negosiasi ini.
      </div>
      <div class="form-grid">
        ${field({ name: 'reason', label: 'Alasan penolakan', required: true, full: true, placeholder: 'Contoh: usulan harga di bawah batas pemilik' })}
      </div>`,
    submitLabel: 'Tolak Negosiasi',
    submitIcon: 'fa-ban',
    async onSubmit(body) {
      await api.post(`/negotiations/${n.id}/reject`, body)
      toast('Negosiasi ditolak.')
      onDone()
    }
  })
}
