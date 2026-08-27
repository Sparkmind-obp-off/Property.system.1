/**
 * Rentals — list + detail with explainable activation readiness.
 * Traceability: PS-MASTER-001 §16 (rental), §17 (activation rule),
 *               §18 (double-rental protection), §29 (critical action)
 *
 * Activation is the system's most critical domain operation. The UI never
 * "sets a status": it calls POST /rentals/:id/activate after showing the
 * server-computed readiness checks and the consequence of the action (§17, §29).
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
  readForm,
  scorePill,
  skeletonRows,
  todayInput,
  toast,
  truncate
} from '../core/dom.js'
import { replaceQuery } from '../core/router.js'
import { screenEl, setHeader } from '../core/shell.js'

const PAYMENT_PERIODS = [
  { value: 'MONTH', label: 'Per bulan' },
  { value: 'YEAR', label: 'Per tahun' }
]

/* ========================================================================== *
 * LIST
 * ========================================================================== */

export async function rentalListScreen({ query }) {
  const el = screenEl()
  if (query.id) return rentalDetail(query.id, query)

  const filters = {
    status: query.status || '',
    expiring: query.expiring === 'true',
    search: query.search || '',
    page: Number(query.page || 1)
  }

  setHeader({
    title: 'Rental',
    subtitle: 'Komitmen komersial — draft, aktif, akan berakhir, dan selesai',
    actions: `
      ${session.can('rental.update') ? `<button class="btn" data-action="flag-expiring"><i class="fa-solid fa-hourglass-end"></i>Tandai akan berakhir</button>` : ''}
      <button class="btn" data-action="refresh"><i class="fa-solid fa-rotate-right"></i>Muat ulang</button>`
  })

  el.innerHTML = `
    <section class="stack">
      ${renderFilters(filters)}
      <div class="card">
        <div class="card-head">
          <h2>Daftar Rental</h2>
          <span class="badge" id="rnt-count">…</span>
        </div>
        <div class="table-wrap">
          <table class="data">
            <thead>
              <tr>
                <th>Properti</th><th>Penyewa</th><th>Harga</th>
                <th>Periode sewa</th><th>Sisa</th><th>Status</th><th class="right">Aksi</th>
              </tr>
            </thead>
            <tbody id="rnt-body">${skeletonRows(7, 6)}</tbody>
          </table>
        </div>
        <div id="rnt-pager"></div>
      </div>
    </section>`

  bindFilters(el, filters)
  const host = document.getElementById('page-actions')
  host?.querySelector('[data-action="refresh"]')?.addEventListener('click', () => rentalListScreen({ query }))
  host?.querySelector('[data-action="flag-expiring"]')?.addEventListener('click', async (e) => {
    e.currentTarget.disabled = true
    try {
      const res = await api.post('/rentals/flag-expiring', {})
      toast(`${num(res.data?.flagged ?? 0)} rental ditandai akan berakhir.`, 'ok')
      rentalListScreen({ query })
    } catch (err) {
      e.currentTarget.disabled = false
      toast(errorText(err), 'err')
    }
  })

  let res
  try {
    res = await api.get('/rentals', {
      status: filters.status || undefined,
      expiring: filters.expiring ? 'true' : undefined,
      search: filters.search || undefined,
      page: filters.page,
      limit: 20
    })
  } catch (err) {
    document.getElementById('rnt-body').innerHTML = `<tr><td colspan="7">${errorState(err)}</td></tr>`
    document
      .querySelector('#rnt-body [data-action="retry"]')
      ?.addEventListener('click', () => rentalListScreen({ query }))
    return
  }

  const rows = res.data || []
  const body = document.getElementById('rnt-body')
  document.getElementById('rnt-count').textContent = `${num(res.meta?.total ?? rows.length)} rental`

  if (rows.length === 0) {
    body.innerHTML = `<tr><td colspan="7">${emptyState({
      icon: 'fa-file-signature',
      title: 'Belum ada rental',
      message:
        'Rental dibuat dari negosiasi yang sudah disepakati agar harga dan ketentuan tidak diketik ulang. Buka pipeline leads untuk melanjutkan kesepakatan.',
      action: { action: 'goto-leads', label: 'Buka Pipeline Leads', icon: 'fa-filter-circle-dollar' }
    })}</td></tr>`
    body.querySelector('[data-action="goto-leads"]')?.addEventListener('click', () => {
      location.hash = '#/leads'
    })
    document.getElementById('rnt-pager').innerHTML = ''
    return
  }

  body.innerHTML = rows.map(renderRow).join('')
  document.getElementById('rnt-pager').innerHTML = pagerHtml(res.meta)

  body.querySelectorAll('[data-open]').forEach((b) =>
    b.addEventListener('click', () => {
      const next = { ...query, id: b.dataset.open }
      replaceQuery(next)
      rentalDetail(b.dataset.open, next)
    })
  )
  document.querySelectorAll('#rnt-pager [data-page]').forEach((b) =>
    b.addEventListener('click', () => {
      const next = { ...query, page: b.dataset.page }
      replaceQuery(next)
      rentalListScreen({ query: next })
    })
  )
}

function renderFilters(f) {
  const statuses = ['DRAFT', 'PENDING', 'CONFIRMED', 'ACTIVE', 'EXPIRING', 'ENDED', 'CANCELLED']
  return `<div class="card">
    <div class="card-body">
      <div class="filters">
        <div class="field">
          <label for="flt-search">Cari</label>
          <input id="flt-search" value="${attr(f.search)}" placeholder="Nama properti atau penyewa…">
        </div>
        <div class="field">
          <label for="flt-status">Status</label>
          <select id="flt-status">
            <option value="">Semua status</option>
            ${statuses
              .map((s) => `<option value="${attr(s)}" ${f.status === s ? 'selected' : ''}>${esc(humanEnum(s))}</option>`)
              .join('')}
          </select>
        </div>
        <div class="field" style="align-self:end">
          <label style="display:flex;align-items:center;gap:8px;font-weight:500">
            <input type="checkbox" id="flt-expiring" style="width:auto" ${f.expiring ? 'checked' : ''}>
            Hanya akan berakhir (≤30 hari)
          </label>
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
    const next = {
      status: f.status,
      search: f.search,
      expiring: f.expiring ? 'true' : '',
      ...patch,
      page: 1
    }
    replaceQuery(next)
    rentalListScreen({ query: next })
  }
  el.querySelector('#flt-search')?.addEventListener('change', (e) => apply({ search: e.target.value.trim() }))
  el.querySelector('#flt-status')?.addEventListener('change', (e) => apply({ status: e.target.value }))
  el.querySelector('#flt-expiring')?.addEventListener('change', (e) => apply({ expiring: e.target.checked ? 'true' : '' }))
  el.querySelector('#flt-reset')?.addEventListener('click', () => apply({ status: '', search: '', expiring: '' }))
}

function renderRow(r) {
  const remaining = r.days_until_end
  const tone = remaining !== null && remaining !== undefined && remaining <= 30 ? 'warn-text' : ''
  return `<tr>
    <td>
      <a class="cell-main link" href="#/properties/${attr(r.property_id)}">${esc(r.property_name)}</a>
      <div class="cell-sub">${esc(truncate(r.property_address || '', 44))}</div>
    </td>
    <td>
      <div class="cell-main">${esc(r.tenant_name)}</div>
      <div class="cell-sub">${esc(r.contact_name || '—')}</div>
    </td>
    <td class="nowrap">
      <div class="cell-main">${money(r.price)}</div>
      <div class="cell-sub">${esc(humanEnum(r.payment_period))}</div>
    </td>
    <td class="nowrap">
      <div class="cell-main">${esc(fmtDate(r.start_date))}</div>
      <div class="cell-sub">s/d ${esc(fmtDate(r.end_date))}</div>
    </td>
    <td class="right ${tone}">${remaining === null || remaining === undefined ? '—' : `${num(remaining)} hari`}</td>
    <td>${badge(r.status)}</td>
    <td class="right nowrap">
      <button class="btn sm primary" data-open="${attr(r.id)}"><i class="fa-solid fa-folder-open"></i>Detail</button>
    </td>
  </tr>`
}

/* ========================================================================== *
 * DETAIL
 * ========================================================================== */

async function rentalDetail(id, query) {
  const el = screenEl()
  setHeader({ title: 'Rental', subtitle: 'Memuat detail…' })
  el.innerHTML = loadingState('Memuat rental dan kesiapan aktivasi…')

  let r
  try {
    const res = await api.get(`/rentals/${id}`)
    r = res.data
  } catch (err) {
    el.innerHTML = errorState(err)
    el.querySelector('[data-action="retry"]')?.addEventListener('click', () => rentalDetail(id, query))
    el.querySelector('[data-action="back"]')?.addEventListener('click', () => backToList(query))
    return
  }

  const reload = () => rentalDetail(id, query)
  const preActive = ['DRAFT', 'PENDING', 'CONFIRMED'].includes(r.status)
  const live = ['ACTIVE', 'EXPIRING'].includes(r.status)

  setHeader({
    title: `Rental — ${r.property_name}`,
    subtitle: `${esc(r.tenant_name)} · ${badge(r.status)}`,
    actions: `
      <button class="btn" data-action="back"><i class="fa-solid fa-arrow-left"></i>Daftar</button>
      ${preActive && r.status === 'DRAFT' && session.can('rental.update') ? `<button class="btn" data-action="confirm"><i class="fa-solid fa-lock"></i>Konfirmasi</button>` : ''}
      ${preActive && session.can('rental.activate') ? `<button class="btn primary" data-action="activate" ${r.activation_readiness?.ready ? '' : 'disabled title="Syarat aktivasi belum lengkap"'}><i class="fa-solid fa-circle-play"></i>Aktifkan rental</button>` : ''}
      ${live && session.can('rental.end') ? `<button class="btn danger" data-action="end"><i class="fa-solid fa-stop"></i>Akhiri rental</button>` : ''}
      ${preActive && session.can('rental.update') ? `<button class="btn danger" data-action="cancel"><i class="fa-solid fa-xmark"></i>Batalkan</button>` : ''}`
  })

  el.innerHTML = `
    <section class="stack">
      ${renderStatusStrip(r)}
      ${renderRentalKpis(r)}
      <div class="grid side">
        <div class="stack">
          ${renderReadiness(r)}
          ${renderTerms(r)}
        </div>
        <div class="stack">
          ${renderPartiesCard(r)}
          ${renderCommercialContext(r)}
        </div>
      </div>
    </section>`

  bindDetail(el, r, reload, query)
}

function backToList(query) {
  const next = { ...query }
  delete next.id
  replaceQuery(next)
  rentalListScreen({ query: next })
}

function renderStatusStrip(r) {
  if (['ACTIVE', 'EXPIRING'].includes(r.status)) {
    const expiring = r.status === 'EXPIRING' || r.is_expiring
    return `<div class="next-action ${expiring ? 'warn' : 'ok'}">
      <i class="fa-solid ${expiring ? 'fa-hourglass-end' : 'fa-circle-check'}"></i>
      <div>
        <div class="na-label">Status rental</div>
        <div class="na-title">${expiring ? 'Rental akan berakhir' : 'Rental aktif'}</div>
        <div class="na-reason">
          ${expiring
            ? `Sisa ${num(r.days_until_end)} hari. Siapkan perpanjangan atau pasarkan kembali properti sebelum kosong.`
            : `Properti tidak tersedia untuk rental lain sampai ${esc(fmtDate(r.end_date))}.`}
        </div>
      </div>
      ${expiring ? `<a class="btn primary" href="#/properties/${attr(r.property_id)}">Buka properti</a>` : ''}
    </div>`
  }
  if (r.status === 'ENDED') {
    return `<div class="next-action">
      <i class="fa-solid fa-flag-checkered"></i>
      <div>
        <div class="na-label">Status rental</div>
        <div class="na-title">Rental selesai ${esc(fmtDate(r.ended_at))}</div>
        <div class="na-reason">${esc(r.end_reason || 'Properti dikembalikan ke pasar sesuai aturan domain.')}</div>
      </div>
      <a class="btn" href="#/properties/${attr(r.property_id)}">Buka properti</a>
    </div>`
  }
  if (r.status === 'CANCELLED') {
    return `<div class="next-action">
      <i class="fa-solid fa-circle-xmark"></i>
      <div>
        <div class="na-label">Status rental</div>
        <div class="na-title">Rental dibatalkan</div>
        <div class="na-reason">${esc(r.end_reason || 'Rental tidak pernah diaktifkan.')}</div>
      </div>
    </div>`
  }
  const ready = r.activation_readiness?.ready
  return `<div class="next-action ${ready ? 'ok' : 'warn'}">
    <i class="fa-solid ${ready ? 'fa-circle-play' : 'fa-triangle-exclamation'}"></i>
    <div>
      <div class="na-label">Langkah berikutnya</div>
      <div class="na-title">${ready ? 'Rental siap diaktifkan' : 'Lengkapi syarat aktivasi'}</div>
      <div class="na-reason">
        ${ready
          ? 'Aktivasi akan menandai properti tidak tersedia dan lead menjadi WON dalam satu transaksi.'
          : 'Beberapa pemeriksaan domain belum lolos. Periksa daftar kesiapan aktivasi di bawah.'}
      </div>
    </div>
    ${ready && session.can('rental.activate') ? `<button class="btn primary" data-action="activate">Aktifkan rental</button>` : ''}
  </div>`
}

function renderRentalKpis(r) {
  const cards = [
    { label: 'Harga sewa', value: money(r.price), sub: humanEnum(r.payment_period) },
    { label: 'Deposit', value: money(r.deposit), sub: r.deposit ? 'Tercatat' : 'Belum ada deposit' },
    {
      label: 'Durasi',
      value: `${esc(fmtDate(r.start_date))}`,
      sub: `s/d ${esc(fmtDate(r.end_date))}`
    },
    {
      label: 'Sisa masa sewa',
      value: r.days_until_end === null || r.days_until_end === undefined ? '—' : `${num(r.days_until_end)} hari`,
      sub: r.is_expiring ? 'Dalam jendela 30 hari' : 'Di luar jendela akhir'
    }
  ]
  return `<div class="grid cols-4">
    ${cards
      .map(
        (c) => `<div class="kpi">
          <div class="k-label">${esc(c.label)}</div>
          <div class="k-value" style="font-size:1.1rem">${c.value}</div>
          <div class="k-sub">${c.sub}</div>
        </div>`
      )
      .join('')}
  </div>`
}

/** §17: activation validation must be explainable — never a silent failure. */
function renderReadiness(r) {
  const rd = r.activation_readiness
  if (!rd) return ''
  const checks = rd.checks || []
  return `<div class="card">
    <div class="card-head">
      <h2>Kesiapan Aktivasi</h2>
      ${badge(rd.ready ? 'READY' : 'PENDING', { tone: rd.ready ? 'ok' : 'warn', label: rd.ready ? 'Siap' : 'Belum siap' })}
      <div class="actions"><span class="tiny dim">Aturan domain DR-008 / §17</span></div>
    </div>
    <div class="card-body">
      <ul class="reason-list">
        ${checks
          .map(
            (c) => `<li class="${c.ok ? 'pos' : 'neg'}">
              <i class="fa-solid ${c.ok ? 'fa-circle-check' : 'fa-circle-xmark'}"></i>
              <span>${esc(c.label || humanEnum(c.check))}</span>
              ${c.detail ? `<span class="dim tiny"> — ${esc(c.detail)}</span>` : ''}
            </li>`
          )
          .join('')}
      </ul>
      ${
        (r.terms_gaps || []).length
          ? `<div class="inline-warn"><i class="fa-solid fa-circle-exclamation"></i>
              Ketentuan belum lengkap: ${esc((r.terms_gaps || []).map(humanEnum).join(', '))}</div>`
          : ''
      }
      ${
        rd.blockers && rd.blockers.length
          ? `<div class="inline-error">Penghambat: ${esc(rd.blockers.join(' · '))}</div>`
          : ''
      }
    </div>
  </div>`
}

function renderTerms(r) {
  return `<div class="card">
    <div class="card-head"><h2>Ketentuan Sewa</h2></div>
    <div class="card-body">
      ${
        r.terms
          ? `<div class="note"><div class="note-label">Isi ketentuan</div>${esc(r.terms)}</div>`
          : `<div class="tiny dim">Belum ada ketentuan tertulis. Ketentuan wajib lengkap sebelum aktivasi (§17).</div>`
      }
      <dl class="kv">
        <dt>Dibuat oleh</dt><dd>${esc(r.created_by_name || '—')}</dd>
        <dt>Dibuat</dt><dd>${esc(fmtDateTime(r.created_at))}</dd>
        ${r.activated_at ? `<dt>Diaktifkan</dt><dd>${esc(fmtDateTime(r.activated_at))}</dd>` : ''}
        ${r.ended_at ? `<dt>Diakhiri</dt><dd>${esc(fmtDateTime(r.ended_at))}</dd>` : ''}
        ${r.end_reason ? `<dt>Alasan akhir</dt><dd>${esc(r.end_reason)}</dd>` : ''}
      </dl>
    </div>
  </div>`
}

function renderPartiesCard(r) {
  return `<div class="card">
    <div class="card-head"><h2>Pihak Terkait</h2></div>
    <div class="card-body">
      <dl class="kv">
        <dt>Properti</dt><dd><a class="link" href="#/properties/${attr(r.property_id)}">${esc(r.property_name)}</a></dd>
        <dt>Alamat</dt><dd>${esc(r.property_address || '—')}</dd>
        <dt>Tipe</dt><dd>${esc(humanEnum(r.property_type))}</dd>
        <dt>Ketersediaan</dt><dd>${badge(r.property_availability)}</dd>
        <dt>Siklus properti</dt><dd>${badge(r.property_lifecycle)}</dd>
        <dt>Penyewa</dt><dd><a class="link" href="#/tenants/${attr(r.tenant_id)}">${esc(r.tenant_name)}</a></dd>
        <dt>Kontak</dt><dd>${esc(r.contact_name || '—')} · ${esc(r.tenant_phone || '—')}</dd>
        <dt>Kategori usaha</dt><dd>${esc(humanEnum(r.business_category))}</dd>
      </dl>
    </div>
  </div>`
}

function renderCommercialContext(r) {
  return `<div class="card">
    <div class="card-head"><h2>Konteks Komersial</h2></div>
    <div class="card-body">
      <dl class="kv">
        <dt>Harga minta properti</dt><dd>${money(r.property_list_price)}</dd>
        <dt>Harga sepakat</dt><dd>${r.agreed_price ? money(r.agreed_price) : '—'}</dd>
        <dt>Selisih</dt><dd>${
          r.property_list_price && r.price
            ? moneyShort(Math.max(0, Number(r.property_list_price) - Number(r.price)))
            : '—'
        }</dd>
        <dt>Lead</dt><dd>${
          r.lead_id ? `<a class="link" href="#/leads/${attr(r.lead_id)}">${esc(r.lead_id)}</a> ${badge(r.lead_status)}` : '<span class="dim">Tanpa lead</span>'
        }</dd>
        <dt>Skor lead</dt><dd>${scorePill(r.lead_score)}</dd>
        <dt>Negosiasi</dt><dd>${
          r.negotiation_id
            ? `<a class="link" href="#/negotiations?id=${attr(r.negotiation_id)}">${esc(r.negotiation_id)}</a> ${badge(r.negotiation_status)}`
            : '<span class="dim">Tanpa negosiasi</span>'
        }</dd>
      </dl>
    </div>
  </div>`
}

function bindDetail(el, r, reload, query) {
  const host = document.getElementById('page-actions')
  host?.querySelector('[data-action="back"]')?.addEventListener('click', () => backToList(query))
  host?.querySelector('[data-action="confirm"]')?.addEventListener('click', () => openConfirmForm(r, reload))
  const activate = () => openActivateForm(r, reload)
  host?.querySelector('[data-action="activate"]')?.addEventListener('click', activate)
  el.querySelector('[data-action="activate"]')?.addEventListener('click', activate)
  host?.querySelector('[data-action="end"]')?.addEventListener('click', () => openEndForm(r, reload))
  host?.querySelector('[data-action="cancel"]')?.addEventListener('click', () => openCancelForm(r, reload))
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

/** Rental creation from an agreed negotiation (§16). Exported for lead detail. */
export function openRentalForm(prefill, onDone) {
  const start = prefill.start_date || todayInput(7)
  const end = prefill.end_date || todayInput(372)
  formModal({
    title: 'Buat Rental',
    bodyHtml: `
      <div class="inline-info">
        Rental dibuat dari kesepakatan${prefill.property_name ? ` untuk <strong>${esc(prefill.property_name)}</strong>` : ''}.
        Harga dan ketentuan diambil dari negosiasi bila tersedia.
      </div>
      <div class="form-grid">
        ${field({ name: 'start_date', label: 'Tanggal mulai', type: 'date', required: true, value: start })}
        ${field({ name: 'end_date', label: 'Tanggal berakhir', type: 'date', required: true, value: end })}
        ${field({ name: 'price', label: 'Harga sewa', type: 'number', value: prefill.price, min: 0, step: 50000, hint: 'Kosongkan untuk memakai harga sepakat negosiasi.' })}
        ${field({ name: 'payment_period', label: 'Periode pembayaran', type: 'select', value: prefill.payment_period || 'MONTH', options: PAYMENT_PERIODS })}
        ${field({ name: 'deposit', label: 'Deposit', type: 'number', value: prefill.deposit ?? 0, min: 0, step: 50000 })}
        ${field({ name: 'terms', label: 'Ketentuan sewa', type: 'textarea', rows: 3, full: true, value: prefill.terms, placeholder: 'Durasi, deposit, jadwal pembayaran, kewajiban perawatan…' })}
      </div>`,
    submitLabel: 'Buat Rental',
    submitIcon: 'fa-file-signature',
    async onSubmit(body) {
      const res = await api.post('/rentals', {
        ...body,
        lead_id: prefill.lead_id,
        property_id: prefill.property_id,
        tenant_id: prefill.tenant_id,
        negotiation_id: prefill.negotiation_id
      })
      toast('Rental dibuat sebagai DRAFT.', 'ok')
      onDone?.(res.data)
    }
  })
}

function openConfirmForm(r, onDone) {
  formModal({
    title: 'Konfirmasi Rental',
    bodyHtml: `
      <div class="consequence"><i class="fa-solid fa-circle-exclamation"></i>
        Konfirmasi memesan properti <strong>${esc(r.property_name)}</strong> untuk kesepakatan ini
        (properti menjadi RESERVED) sehingga tidak dapat dipesan rental lain.
      </div>`,
    submitLabel: 'Konfirmasi Rental',
    submitIcon: 'fa-lock',
    async onSubmit() {
      await api.post(`/rentals/${r.id}/confirm`, {})
      toast('Rental dikonfirmasi. Properti dipesan.', 'ok')
      onDone()
    }
  })
}

/** §29: activation must state its consequence explicitly. */
function openActivateForm(r, onDone) {
  const checks = r.activation_readiness?.checks || []
  formModal({
    title: 'Aktifkan Rental',
    bodyHtml: `
      <div class="consequence"><i class="fa-solid fa-circle-exclamation"></i>
        Mengaktifkan rental ini akan menandai properti <strong>${esc(r.property_name)}</strong>
        sebagai tersewa (tidak tersedia) dan menutup lead sebagai WON. Sistem menolak rental aktif kedua
        untuk properti yang sama.
      </div>
      <ul class="reason-list">
        ${checks
          .map(
            (c) => `<li class="${c.ok ? 'pos' : 'neg'}">
              <i class="fa-solid ${c.ok ? 'fa-circle-check' : 'fa-circle-xmark'}"></i>
              <span>${esc(c.label || humanEnum(c.check))}</span></li>`
          )
          .join('')}
      </ul>
      <div class="tiny dim">Harga ${money(r.price)} ${esc(humanEnum(r.payment_period))} · ${esc(fmtDate(r.start_date))} — ${esc(fmtDate(r.end_date))}</div>`,
    submitLabel: 'Aktifkan Rental',
    submitIcon: 'fa-circle-play',
    async onSubmit() {
      await api.post(`/rentals/${r.id}/activate`, {})
      toast('Rental aktif. Properti kini tersewa.', 'ok')
      onDone()
    }
  })
}

function openEndForm(r, onDone) {
  formModal({
    title: 'Akhiri Rental',
    danger: true,
    bodyHtml: `
      <div class="consequence"><i class="fa-solid fa-circle-exclamation"></i>
        Mengakhiri rental mengembalikan properti <strong>${esc(r.property_name)}</strong> ke pasar
        sesuai aturan domain, sehingga dapat dipasarkan dan disewakan kembali.
      </div>
      <div class="form-grid">
        ${field({ name: 'reason', label: 'Alasan berakhir', required: true, full: true, placeholder: 'Contoh: masa sewa selesai dan tidak diperpanjang' })}
        ${field({ name: 'ended_at', label: 'Tanggal berakhir', type: 'date', value: todayInput(0), hint: 'Kosongkan untuk memakai tanggal hari ini.' })}
      </div>`,
    submitLabel: 'Akhiri Rental',
    submitIcon: 'fa-stop',
    async onSubmit(body) {
      await api.post(`/rentals/${r.id}/end`, body)
      toast('Rental diakhiri. Properti kembali ke pasar.', 'ok')
      onDone()
    }
  })
}

function openCancelForm(r, onDone) {
  formModal({
    title: 'Batalkan Rental',
    danger: true,
    bodyHtml: `
      <div class="consequence"><i class="fa-solid fa-circle-exclamation"></i>
        Rental yang belum aktif akan dibatalkan dan properti dibebaskan dari pemesanan.
        Kesepakatan harus dibuat ulang bila ingin dilanjutkan.
      </div>
      <div class="form-grid">
        ${field({ name: 'reason', label: 'Alasan pembatalan', required: true, full: true, placeholder: 'Contoh: penyewa membatalkan rencana usaha' })}
      </div>`,
    submitLabel: 'Batalkan Rental',
    submitIcon: 'fa-xmark',
    async onSubmit(body) {
      await api.post(`/rentals/${r.id}/cancel`, body)
      toast('Rental dibatalkan.')
      onDone()
    }
  })
}
