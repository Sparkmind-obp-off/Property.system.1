/**
 * Properties — list + detail (intelligence, matching, offers, leads, rental).
 * Traceability: PS-MASTER-001 §5, §6, §23, §29 | PS-UX-010 §14–§18
 *
 * Contextual actions only (§23): an action is rendered when the domain state
 * makes it meaningful, never "every action all the time".
 */
import { api, errorText, session } from '../core/api.js'
import {
  attr,
  badge,
  confirmAction,
  debounce,
  emptyState,
  errorState,
  esc,
  field,
  fmtDate,
  humanEnum,
  loadingState,
  meter,
  money,
  num,
  openModal,
  pagerHtml,
  period,
  readForm,
  applyFieldErrors,
  scorePill,
  skeletonRows,
  toast,
  truncate
} from '../core/dom.js'
import { replaceQuery } from '../core/router.js'
import { screenEl, setHeader } from '../core/shell.js'

const PROPERTY_TYPES = [
  'SHOPHOUSE',
  'KIOSK',
  'HOUSE',
  'BOARDING_HOUSE',
  'COMMERCIAL_SPACE',
  'WAREHOUSE',
  'LAND',
  'OTHER'
]
const LIFECYCLE = ['DRAFT', 'PENDING_VERIFICATION', 'VERIFIED', 'ACTIVE', 'MARKETED', 'RESERVED', 'RENTED', 'INACTIVE']
const AVAILABILITY = ['AVAILABLE', 'RESERVED', 'RENTED', 'UNAVAILABLE']

const TYPE_ICON = {
  SHOPHOUSE: 'fa-store',
  KIOSK: 'fa-shop',
  HOUSE: 'fa-house',
  BOARDING_HOUSE: 'fa-bed',
  COMMERCIAL_SPACE: 'fa-building',
  WAREHOUSE: 'fa-warehouse',
  LAND: 'fa-mountain-sun',
  OTHER: 'fa-cube'
}

/* ========================================================================== *
 * LIST
 * ========================================================================== */

export async function propertyListScreen({ query }) {
  const el = screenEl()
  const state = {
    page: Number(query.page) || 1,
    limit: 20,
    search: query.search || '',
    lifecycle_status: query.lifecycle_status || '',
    availability_status: query.availability_status || '',
    property_type: query.property_type || '',
    sort: query.sort || 'created_at:desc'
  }

  setHeader({
    title: 'Properti',
    subtitle: 'Inventori properti · potensi komersial · status pemasaran',
    actions: session.can('property.create')
      ? `<button class="btn primary" data-action="new"><i class="fa-solid fa-plus"></i>Tambah Properti</button>`
      : '',
    mobilePrimary: session.can('property.create')
      ? { action: 'new', label: 'Properti', icon: 'fa-plus' }
      : null
  })

  el.innerHTML = `
    <section class="stack">
      <div class="card">
        <div class="card-body tight">
          <div class="filters" id="p-filters">
            <input type="search" id="f-search" placeholder="Cari nama atau alamat…" value="${attr(state.search)}">
            <select id="f-type">
              <option value="">Semua tipe</option>
              ${PROPERTY_TYPES.map((t) => `<option value="${t}" ${state.property_type === t ? 'selected' : ''}>${esc(humanEnum(t))}</option>`).join('')}
            </select>
            <select id="f-lifecycle">
              <option value="">Semua status</option>
              ${LIFECYCLE.map((t) => `<option value="${t}" ${state.lifecycle_status === t ? 'selected' : ''}>${esc(humanEnum(t))}</option>`).join('')}
            </select>
            <select id="f-avail">
              <option value="">Semua ketersediaan</option>
              ${AVAILABILITY.map((t) => `<option value="${t}" ${state.availability_status === t ? 'selected' : ''}>${esc(humanEnum(t))}</option>`).join('')}
            </select>
            <select id="f-sort">
              <option value="created_at:desc" ${state.sort === 'created_at:desc' ? 'selected' : ''}>Terbaru</option>
              <option value="price:asc" ${state.sort === 'price:asc' ? 'selected' : ''}>Harga terendah</option>
              <option value="price:desc" ${state.sort === 'price:desc' ? 'selected' : ''}>Harga tertinggi</option>
              <option value="name:asc" ${state.sort === 'name:asc' ? 'selected' : ''}>Nama A–Z</option>
              <option value="area_size:desc" ${state.sort === 'area_size:desc' ? 'selected' : ''}>Luas terbesar</option>
            </select>
            <button class="btn sm" id="f-reset" title="Reset filter"><i class="fa-solid fa-eraser"></i></button>
          </div>
        </div>
        <div id="p-result"></div>
      </div>
    </section>`

  const result = el.querySelector('#p-result')

  async function load() {
    result.innerHTML = `<div class="table-wrap"><table class="data">
      <thead><tr><th>Properti</th><th>Harga</th><th>Ukuran</th><th>Ketersediaan</th><th>Status</th><th class="right">Lead</th><th class="right">Fit</th></tr></thead>
      <tbody>${skeletonRows(7, 6)}</tbody></table></div>`
    try {
      const res = await api.get('/properties', {
        page: state.page,
        limit: state.limit,
        search: state.search,
        property_type: state.property_type,
        lifecycle_status: state.lifecycle_status,
        availability_status: state.availability_status,
        sort: state.sort
      })
      renderTable(res.data, res.meta)
    } catch (err) {
      result.innerHTML = errorState(err)
      result.querySelector('[data-action="retry"]')?.addEventListener('click', load)
    }
  }

  function renderTable(rows, meta) {
    if (rows.length === 0) {
      const filtered = state.search || state.property_type || state.lifecycle_status || state.availability_status
      result.innerHTML = emptyState(
        filtered
          ? {
              icon: 'fa-filter-circle-xmark',
              title: 'Tidak ada properti yang cocok',
              message: 'Longgarkan filter atau kata kunci pencarian untuk melihat properti lain.',
              action: { action: 'clear-filter', label: 'Hapus filter', icon: 'fa-eraser' }
            }
          : {
              icon: 'fa-building',
              title: 'Belum ada properti',
              message: 'Tambahkan properti pertama Anda untuk mulai menganalisis potensi dan mencari penyewa.',
              action: session.can('property.create')
                ? { action: 'new', label: 'Tambah Properti', icon: 'fa-plus' }
                : undefined
            }
      )
      bindResult()
      return
    }

    result.innerHTML = `
      <div class="table-wrap">
        <table class="data">
          <thead><tr>
            <th>Properti</th><th>Harga</th><th>Ukuran</th>
            <th>Ketersediaan</th><th>Status</th><th class="right">Lead</th><th class="right">Fit pasar</th>
          </tr></thead>
          <tbody>
            ${rows
              .map(
                (p) => `<tr class="clickable" data-id="${attr(p.id)}">
                  <td class="cell-main">
                    <div class="row tight">
                      <span class="thumb"><i class="fa-solid ${TYPE_ICON[p.property_type] || 'fa-cube'}"></i></span>
                      <span>
                        <span class="strong">${esc(p.name)}</span>
                        <div class="tiny dim">${esc(humanEnum(p.property_type))} · ${esc(truncate(p.address, 52))}</div>
                      </span>
                    </div>
                  </td>
                  <td class="nowrap">${money(p.price)}<span class="tiny dim">${esc(period(p.price_period))}</span></td>
                  <td class="nowrap">${p.area_size ? `${num(p.area_size)} m²` : '—'}
                    ${p.width && p.length ? `<div class="tiny dim">${num(p.width)}×${num(p.length)} m</div>` : ''}</td>
                  <td>${badge(p.availability_status)}</td>
                  <td>${badge(p.lifecycle_status)}</td>
                  <td class="right">${p.lead_count ? `<span class="strong">${num(p.lead_count)}</span>` : '<span class="dim">0</span>'}</td>
                  <td class="right">${p.best_fit_score !== null && p.best_fit_score !== undefined ? scorePill(p.best_fit_score) : '<span class="dim tiny">belum dianalisis</span>'}</td>
                </tr>`
              )
              .join('')}
          </tbody>
        </table>
      </div>
      <div class="card-foot">${pagerHtml(meta)}</div>`
    bindResult()
  }

  function bindResult() {
    result.querySelectorAll('tr[data-id]').forEach((tr) =>
      tr.addEventListener('click', () => {
        location.hash = `#/properties/${tr.dataset.id}`
      })
    )
    result.querySelectorAll('[data-page]').forEach((b) =>
      b.addEventListener('click', () => {
        state.page = Number(b.dataset.page)
        sync()
        load()
      })
    )
    result.querySelector('[data-action="new"]')?.addEventListener('click', () => openPropertyForm(null, load))
    result.querySelector('[data-action="clear-filter"]')?.addEventListener('click', () => {
      el.querySelector('#f-reset').click()
    })
    result.querySelector('[data-action="retry"]')?.addEventListener('click', load)
  }

  function sync() {
    replaceQuery({
      page: state.page > 1 ? state.page : '',
      search: state.search,
      property_type: state.property_type,
      lifecycle_status: state.lifecycle_status,
      availability_status: state.availability_status,
      sort: state.sort !== 'created_at:desc' ? state.sort : ''
    })
  }

  el.querySelector('#f-search').addEventListener(
    'input',
    debounce((e) => {
      state.search = e.target.value.trim()
      state.page = 1
      sync()
      load()
    })
  )
  const bindSelect = (id, key) =>
    el.querySelector(id).addEventListener('change', (e) => {
      state[key] = e.target.value
      state.page = 1
      sync()
      load()
    })
  bindSelect('#f-type', 'property_type')
  bindSelect('#f-lifecycle', 'lifecycle_status')
  bindSelect('#f-avail', 'availability_status')
  bindSelect('#f-sort', 'sort')

  el.querySelector('#f-reset').addEventListener('click', () => {
    Object.assign(state, { search: '', property_type: '', lifecycle_status: '', availability_status: '', page: 1 })
    el.querySelector('#f-search').value = ''
    el.querySelector('#f-type').value = ''
    el.querySelector('#f-lifecycle').value = ''
    el.querySelector('#f-avail').value = ''
    sync()
    load()
  })

  document.querySelector('#page-actions [data-action="new"]')?.addEventListener('click', () => openPropertyForm(null, load))
  document.querySelector('.mobile-primary[data-action="new"]')?.addEventListener('click', () => openPropertyForm(null, load))

  await load()
}

/* ========================================================================== *
 * CREATE / EDIT FORM  (§28 context → minimum input → optional → validate)
 * ========================================================================== */

export function openPropertyForm(property, onDone) {
  const isEdit = Boolean(property)
  openModal({
    title: isEdit ? `Ubah Properti — ${property.name}` : 'Tambah Properti',
    wide: true,
    body: `
      <form id="prop-form" novalidate>
        <div id="prop-form-error"></div>
        <div class="form-grid">
          ${field({ name: 'name', label: 'Nama properti', required: true, value: property?.name, placeholder: 'Ruko 3x6 Kota Lama', full: true })}
          ${field({ name: 'property_type', label: 'Tipe properti', type: 'select', required: true, value: property?.property_type || 'SHOPHOUSE', options: PROPERTY_TYPES })}
          ${field({ name: 'price', label: 'Harga sewa', type: 'number', required: true, value: property?.price, min: 0, step: 100000, hint: 'Dalam Rupiah' })}
          ${field({ name: 'price_period', label: 'Periode harga', type: 'select', required: true, value: property?.price_period || 'MONTH', options: [{ value: 'MONTH', label: 'Per bulan' }, { value: 'YEAR', label: 'Per tahun' }] })}
          ${field({ name: 'address', label: 'Alamat', required: true, value: property?.address, placeholder: 'Jl. Contoh No. 10, Kota', full: true })}
          ${field({ name: 'width', label: 'Lebar (m)', type: 'number', value: property?.width, min: 0, step: 0.5 })}
          ${field({ name: 'length', label: 'Panjang (m)', type: 'number', value: property?.length, min: 0, step: 0.5 })}
          ${field({ name: 'area_size', label: 'Luas (m²)', type: 'number', value: property?.area_size, min: 0, step: 0.5, hint: 'Kosongkan untuk hitung otomatis' })}
          ${field({ name: 'description', label: 'Deskripsi komersial', type: 'textarea', rows: 3, value: property?.description, placeholder: 'Posisi, keunggulan, catatan komersial…', full: true })}
        </div>
        <details style="margin-top:6px">
          <summary class="tiny dim" style="cursor:pointer">Detail opsional (koordinat & area pasar)</summary>
          <div class="form-grid" style="margin-top:10px">
            ${field({ name: 'latitude', label: 'Latitude', type: 'number', value: property?.latitude, step: 0.000001, min: -90, max: 90 })}
            ${field({ name: 'longitude', label: 'Longitude', type: 'number', value: property?.longitude, step: 0.000001, min: -180, max: 180 })}
            ${field({ name: 'market_area_id', label: 'Market area ID', value: property?.market_area_id, hint: 'Opsional — hubungkan ke area pasar' })}
          </div>
        </details>
      </form>`,
    footer: `
      <button class="btn" data-modal-close>Batal</button>
      <button class="btn primary" id="prop-save"><i class="fa-solid fa-floppy-disk"></i>${isEdit ? 'Simpan Perubahan' : 'Simpan Properti'}</button>`,
    onMount(root, close) {
      const form = root.querySelector('#prop-form')
      const errBox = root.querySelector('#prop-form-error')
      const btn = root.querySelector('#prop-save')
      btn.addEventListener('click', async () => {
        errBox.innerHTML = ''
        const body = readForm(form)
        btn.disabled = true
        btn.innerHTML = '<i class="fa-solid fa-spinner fa-spin"></i> Menyimpan…'
        try {
          const res = isEdit
            ? await api.patch(`/properties/${property.id}`, body)
            : await api.post('/properties', body)
          close()
          toast(isEdit ? 'Properti diperbarui.' : 'Properti dibuat sebagai DRAFT — verifikasi untuk memasarkan.', 'ok')
          onDone?.(res.data)
        } catch (err) {
          btn.disabled = false
          btn.innerHTML = `<i class="fa-solid fa-floppy-disk"></i>${isEdit ? 'Simpan Perubahan' : 'Simpan Properti'}`
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

/* ========================================================================== *
 * DETAIL
 * ========================================================================== */

export async function propertyDetailScreen({ params, query }) {
  const el = screenEl()
  const id = params.id
  let tab = query.tab || 'overview'

  setHeader({ title: 'Properti', subtitle: '' })
  el.innerHTML = loadingState('Memuat detail properti…')

  let p
  try {
    const res = await api.get(`/properties/${id}`)
    p = res.data
  } catch (err) {
    el.innerHTML = errorState(err)
    el.querySelector('[data-action="retry"]')?.addEventListener('click', () => propertyDetailScreen({ params, query }))
    el.querySelector('[data-action="back"]')?.addEventListener('click', () => {
      location.hash = '#/properties'
    })
    return
  }

  const reload = () => propertyDetailScreen({ params, query: { ...query, tab } })

  setHeader({
    title: p.name,
    subtitle: `${esc(humanEnum(p.property_type))} · ${esc(p.address)}`,
    actions: renderHeaderActions(p)
  })

  el.innerHTML = `
    <section class="stack">
      <a class="tiny" href="#/properties"><i class="fa-solid fa-arrow-left"></i> Semua properti</a>
      ${renderGuidance(p)}
      ${renderHero(p)}
      <div class="tabs" id="p-tabs">
        ${tabBtn('overview', 'Ringkasan', tab)}
        ${tabBtn('intelligence', 'Intelligence', tab)}
        ${tabBtn('matching', 'Target Penyewa', tab)}
        ${tabBtn('pipeline', `Leads${p.lead_summary.total ? ` (${p.lead_summary.total})` : ''}`, tab)}
        ${tabBtn('commercial', 'Offer & Rental', tab)}
      </div>
      <div id="p-tab-body"></div>
    </section>`

  const body = el.querySelector('#p-tab-body')

  function renderTab() {
    if (tab === 'overview') body.innerHTML = renderOverview(p)
    else if (tab === 'intelligence') body.innerHTML = renderIntelligence(p)
    else if (tab === 'matching') {
      body.innerHTML = renderMatchingShell(p)
      bindMatching(body, p, reload)
    } else if (tab === 'pipeline') {
      body.innerHTML = loadingState('Memuat leads properti…')
      loadPipeline(body, p)
    } else if (tab === 'commercial') body.innerHTML = renderCommercial(p)
    bindTabBody(body, p, reload)
  }

  el.querySelectorAll('#p-tabs .tab').forEach((t) =>
    t.addEventListener('click', () => {
      tab = t.dataset.tab
      el.querySelectorAll('#p-tabs .tab').forEach((x) => x.classList.toggle('active', x.dataset.tab === tab))
      replaceQuery({ tab: tab === 'overview' ? '' : tab })
      renderTab()
    })
  )

  renderTab()
  bindHeaderActions(p, reload)
}

function tabBtn(key, label, active) {
  return `<div class="tab ${active === key ? 'active' : ''}" data-tab="${key}">${esc(label)}</div>`
}

/** Contextual action set — only what the current domain state allows (§23). */
function renderHeaderActions(p) {
  const a = []
  if (session.can('property.update')) a.push(`<button class="btn" data-action="edit"><i class="fa-solid fa-pen"></i>Ubah</button>`)
  if (session.can('property.analyze')) a.push(`<button class="btn" data-action="analyze"><i class="fa-solid fa-brain"></i>Analisis</button>`)

  const canVerify = ['DRAFT', 'PENDING_VERIFICATION'].includes(p.lifecycle_status)
  if (canVerify && session.can('property.verify')) {
    a.push(`<button class="btn primary" data-action="verify"><i class="fa-solid fa-circle-check"></i>Verifikasi</button>`)
  }
  const canMarket = ['VERIFIED', 'ACTIVE'].includes(p.lifecycle_status) && p.availability_status === 'AVAILABLE'
  if (canMarket && session.can('property.market')) {
    a.push(`<button class="btn primary" data-action="market"><i class="fa-solid fa-bullhorn"></i>Pasarkan</button>`)
  }
  if (p.lifecycle_status === 'MARKETED' && session.can('offer.create')) {
    a.push(`<button class="btn primary" data-action="offer"><i class="fa-solid fa-tags"></i>Buat Offer</button>`)
  }
  if (p.availability_status === 'AVAILABLE' && session.can('lead.create')) {
    a.push(`<button class="btn" data-action="new-lead"><i class="fa-solid fa-user-plus"></i>Buat Lead</button>`)
  }
  if (session.can('property.delete')) {
    a.push(`<button class="btn danger" data-action="delete"><i class="fa-solid fa-trash"></i></button>`)
  }
  return a.join('')
}

/** "What needs attention / what can I do next" for this property (§2). */
function renderGuidance(p) {
  if (p.rental) {
    return `<div class="next-action">
      <div class="na-icon"><i class="fa-solid fa-file-signature"></i></div>
      <div class="na-body">
        <div class="na-label">Status komersial</div>
        <div class="na-text">Properti terikat rental ${esc(humanEnum(p.rental.status))} oleh ${esc(p.rental.tenant_name)}</div>
        <div class="na-why">${fmtDate(p.rental.start_date)} → ${fmtDate(p.rental.end_date)} · ${money(p.rental.price)}${esc(period(p.rental.payment_period))}</div>
      </div>
      <a class="btn" href="#/rentals"><i class="fa-solid fa-arrow-right"></i>Buka rental</a>
    </div>`
  }
  if (['DRAFT', 'PENDING_VERIFICATION'].includes(p.lifecycle_status)) {
    const gaps = p.verification_gaps || []
    return `<div class="next-action">
      <div class="na-icon"><i class="fa-solid fa-circle-check"></i></div>
      <div class="na-body">
        <div class="na-label">Langkah berikutnya</div>
        <div class="na-text">Verifikasi properti agar dapat dipasarkan</div>
        <div class="na-why">${gaps.length ? `Lengkapi dulu: ${esc(gaps.join(', '))}` : 'Data minimum sudah lengkap — properti siap diverifikasi.'}</div>
      </div>
      ${gaps.length === 0 && session.can('property.verify') ? `<button class="btn primary" data-action="verify"><i class="fa-solid fa-circle-check"></i>Verifikasi</button>` : session.can('property.update') ? `<button class="btn" data-action="edit"><i class="fa-solid fa-pen"></i>Lengkapi data</button>` : ''}
    </div>`
  }
  if (!p.analysis && session.can('property.analyze')) {
    return `<div class="next-action">
      <div class="na-icon"><i class="fa-solid fa-brain"></i></div>
      <div class="na-body">
        <div class="na-label">Langkah berikutnya</div>
        <div class="na-text">Analisis properti untuk menemukan target penyewa yang tepat</div>
        <div class="na-why">Tanpa analisis, skor kecocokan penyewa tidak dapat dijelaskan.</div>
      </div>
      <button class="btn primary" data-action="analyze"><i class="fa-solid fa-brain"></i>Analisis sekarang</button>
    </div>`
  }
  if (['VERIFIED', 'ACTIVE'].includes(p.lifecycle_status) && session.can('property.market')) {
    return `<div class="next-action">
      <div class="na-icon"><i class="fa-solid fa-bullhorn"></i></div>
      <div class="na-body">
        <div class="na-label">Langkah berikutnya</div>
        <div class="na-text">Pasarkan properti untuk mulai menangkap lead</div>
        <div class="na-why">Status saat ini ${esc(humanEnum(p.lifecycle_status))} — belum tampil sebagai properti yang dipasarkan.</div>
      </div>
      <button class="btn primary" data-action="market"><i class="fa-solid fa-bullhorn"></i>Pasarkan</button>
    </div>`
  }
  if (p.lifecycle_status === 'MARKETED' && p.lead_summary.open === 0) {
    return `<div class="next-action">
      <div class="na-icon"><i class="fa-solid fa-user-plus"></i></div>
      <div class="na-body">
        <div class="na-label">Langkah berikutnya</div>
        <div class="na-text">Properti dipasarkan tetapi belum ada lead terbuka</div>
        <div class="na-why">Buat offer untuk segmen target, atau catat lead dari calon penyewa yang sudah menghubungi.</div>
      </div>
      ${session.can('offer.create') ? `<button class="btn primary" data-action="offer"><i class="fa-solid fa-tags"></i>Buat Offer</button>` : ''}
    </div>`
  }
  if (p.lead_summary.hot > 0) {
    return `<div class="next-action">
      <div class="na-icon"><i class="fa-solid fa-fire"></i></div>
      <div class="na-body">
        <div class="na-label">Perlu perhatian</div>
        <div class="na-text">${num(p.lead_summary.hot)} lead HOT menunggu tindakan pada properti ini</div>
        <div class="na-why">Lead hot punya peluang konversi tertinggi — tangani lebih dulu.</div>
      </div>
      <a class="btn primary" href="#/leads?temperature=HOT"><i class="fa-solid fa-arrow-right"></i>Buka lead</a>
    </div>`
  }
  return ''
}

function renderHero(p) {
  const fit = p.top_matches?.[0]
  return `<div class="grid cols-4">
    <div class="kpi">
      <div class="k-label">Harga sewa</div>
      <div class="k-value" style="font-size:19px">${money(p.price)}</div>
      <div class="k-sub">${esc(period(p.price_period))}</div>
    </div>
    <div class="kpi">
      <div class="k-label">Ukuran</div>
      <div class="k-value" style="font-size:19px">${p.area_size ? `${num(p.area_size)} m²` : '—'}</div>
      <div class="k-sub">${p.width && p.length ? `${num(p.width)} × ${num(p.length)} m` : 'Dimensi belum lengkap'}</div>
    </div>
    <div class="kpi">
      <div class="k-label">Pipeline</div>
      <div class="k-value" style="font-size:19px">${num(p.lead_summary.open)}</div>
      <div class="k-sub">${num(p.lead_summary.total)} total · ${num(p.lead_summary.hot)} hot · ${num(p.lead_summary.won)} menjadi rental</div>
    </div>
    <div class="kpi">
      <div class="k-label">Fit pasar terbaik</div>
      <div class="k-value" style="font-size:19px">${fit ? `${fit.fit_score}%` : '—'}</div>
      <div class="k-sub">${fit ? esc(fit.segment_name || fit.tenant_name || 'Segmen') : 'Belum ada analisis kecocokan'}</div>
    </div>
  </div>`
}

function renderOverview(p) {
  return `<div class="split">
    <div class="stack">
      <div class="card">
        <div class="card-head"><h2>Data Properti</h2></div>
        <div class="card-body">
          <dl class="kv">
            <dt>Nama</dt><dd>${esc(p.name)}</dd>
            <dt>Tipe</dt><dd>${esc(humanEnum(p.property_type))}</dd>
            <dt>Alamat</dt><dd>${esc(p.address)}</dd>
            <dt>Harga</dt><dd>${money(p.price)} ${esc(period(p.price_period))}</dd>
            <dt>Lebar × Panjang</dt><dd>${p.width && p.length ? `${num(p.width)} × ${num(p.length)} m` : '—'}</dd>
            <dt>Luas</dt><dd>${p.area_size ? `${num(p.area_size)} m²` : '—'}</dd>
            <dt>Ketersediaan</dt><dd>${badge(p.availability_status)}</dd>
            <dt>Status</dt><dd>${badge(p.lifecycle_status)}</dd>
            <dt>Koordinat</dt><dd>${p.latitude && p.longitude ? `<span class="mono">${p.latitude}, ${p.longitude}</span>` : '—'}</dd>
            <dt>Area pasar</dt><dd>${p.market_area_id ? `<span class="mono">${esc(p.market_area_id)}</span>` : '—'}</dd>
            <dt>Dibuat</dt><dd>${fmtDate(p.created_at)}</dd>
            <dt>Diperbarui</dt><dd>${fmtDate(p.updated_at)}</dd>
          </dl>
          ${p.description ? `<div style="margin-top:14px"><div class="tiny dim" style="margin-bottom:4px">Deskripsi komersial</div><div class="small">${esc(p.description)}</div></div>` : ''}
        </div>
      </div>
    </div>
    <div class="stack">
      ${
        (p.verification_gaps || []).length
          ? `<div class="card"><div class="card-head"><h2>Kelengkapan Data</h2></div>
              <div class="card-body">
                <div class="inline-warn">Properti belum memenuhi syarat verifikasi.</div>
                ${p.verification_gaps.map((g) => `<div class="reason con"><i class="fa-solid fa-xmark"></i><span>${esc(g)}</span></div>`).join('')}
              </div></div>`
          : `<div class="card"><div class="card-head"><h2>Kelengkapan Data</h2></div>
              <div class="card-body"><div class="inline-ok">Data minimum properti sudah lengkap.</div></div></div>`
      }
      <div class="card">
        <div class="card-head"><h2>Kunjungan Terakhir</h2>
          <div class="actions"><a class="btn sm" href="#/visits"><i class="fa-solid fa-calendar-check"></i>Semua</a></div></div>
        ${
          (p.visits || []).length === 0
            ? emptyState({ icon: 'fa-calendar-xmark', title: 'Belum ada kunjungan', message: 'Kunjungan dijadwalkan dari lead yang sudah terkualifikasi.' })
            : (p.visits || [])
                .map(
                  (v) => `<div class="list-item">
                    <span class="li-icon ${v.status === 'COMPLETED' ? 'ok' : v.status === 'CANCELLED' || v.status === 'NO_SHOW' ? 'danger' : 'brand'}">
                      <i class="fa-solid fa-calendar-day"></i></span>
                    <div class="li-main">
                      <div class="li-title">${fmtDate(v.scheduled_at)}</div>
                      <div class="li-sub">${v.result ? esc(humanEnum(v.result)) : 'Belum ada hasil'}</div>
                    </div>
                    <div class="li-side">${badge(v.status)}</div>
                  </div>`
                )
                .join('')
        }
      </div>
    </div>
  </div>`
}

function renderIntelligence(p) {
  const a = p.analysis
  if (!a) {
    return `<div class="card">
      <div class="card-head"><h2>Property Intelligence</h2></div>
      ${emptyState({
        icon: 'fa-brain',
        title: 'Properti belum dianalisis',
        message: 'Analisis menghasilkan kekuatan, kelemahan, peluang, dan risiko yang menjadi dasar skor kecocokan penyewa. Skor tanpa alasan tidak diperbolehkan.',
        action: session.can('property.analyze') ? { action: 'analyze', label: 'Analisis Properti', icon: 'fa-brain' } : undefined
      })}
    </div>`
  }

  const dims = [
    { label: 'Akses', v: a.access_score },
    { label: 'Visibilitas', v: a.visibility_score },
    { label: 'Lokasi', v: a.location_score },
    { label: 'Ruang', v: a.space_score }
  ]

  const bucket = (title, items, kind, icon) => `
    <div class="card">
      <div class="card-head"><h2>${esc(title)}</h2><span class="badge">${num(items.length)}</span></div>
      <div class="card-body">
        ${
          items.length
            ? items.map((s) => `<div class="reason ${kind}"><i class="fa-solid ${icon}"></i><span>${esc(s)}</span></div>`).join('')
            : '<div class="dim small">Belum dicatat.</div>'
        }
      </div>
    </div>`

  return `<div class="stack">
    <div class="card">
      <div class="card-head">
        <h2>Skor Analisis</h2>
        ${badge(a.commercial_potential || 'POTENTIAL', { label: `Potensi: ${humanEnum(a.commercial_potential || 'POTENTIAL')}` })}
        <div class="actions">
          <span class="tiny dim">Dianalisis ${fmtDate(a.created_at)}</span>
          ${session.can('property.analyze') ? `<button class="btn sm" data-action="analyze"><i class="fa-solid fa-rotate"></i>Analisis ulang</button>` : ''}
        </div>
      </div>
      <div class="card-body">
        <div class="grid cols-2">
          <div>
            <div class="row between" style="margin-bottom:6px">
              <span class="strong">Skor keseluruhan</span>
              <span>${scorePill(a.overall_score)}</span>
            </div>
            ${meter(a.overall_score)}
            <div class="tiny dim" style="margin-top:6px">Dihitung dari empat dimensi di samping — bukan angka manual.</div>
          </div>
          <div>
            ${dims
              .map(
                (d) => `<div class="bar-row">
                  <span>${esc(d.label)}</span>
                  <span class="bar-track"><span class="bar-fill ${d.v >= 7 ? 'ok' : d.v >= 5 ? 'warn' : 'danger'}" style="width:${(Number(d.v || 0) / 10) * 100}%"></span></span>
                  <span class="right strong">${num(d.v)}/10</span>
                </div>`
              )
              .join('')}
          </div>
        </div>
      </div>
    </div>
    <div class="grid cols-2">
      ${bucket('Kekuatan', a.strengths || [], 'pro', 'fa-check')}
      ${bucket('Kelemahan', a.weaknesses || [], 'con', 'fa-xmark')}
      ${bucket('Peluang', a.opportunities || [], 'pro', 'fa-lightbulb')}
      ${bucket('Risiko', a.risks || [], 'risk', 'fa-triangle-exclamation')}
    </div>
    ${
      (a.recommended_uses || []).length
        ? `<div class="card"><div class="card-head"><h2>Peruntukan yang Disarankan</h2></div>
            <div class="card-body"><div class="chips">
              ${a.recommended_uses.map((u) => `<span class="chip brand"><i class="fa-solid fa-store"></i>${esc(humanEnum(u))}</span>`).join('')}
            </div></div></div>`
        : ''
    }
  </div>`
}

/* ------------------------------ Matching tab ------------------------------ */

function renderMatchingShell(p) {
  return `<div class="stack">
    <div class="card">
      <div class="card-head">
        <h2>Siapa yang paling mungkin menyewa properti ini?</h2>
        <div class="actions">
          ${session.can('match.execute') ? `<button class="btn primary" data-action="rank"><i class="fa-solid fa-ranking-star"></i>Peringkat segmen</button>` : ''}
        </div>
      </div>
      <div class="card-body tight" id="rank-host">
        ${
          session.can('match.execute')
            ? `<div class="inline-info">Jalankan peringkat segmen untuk melihat kecocokan properti ini terhadap seluruh segmen penyewa aktif — dengan alasan, ketidakcocokan, dan risiko.</div>`
            : `<div class="inline-info">Peran Anda hanya dapat melihat riwayat kecocokan yang sudah tersimpan.</div>`
        }
      </div>
    </div>
    <div class="card">
      <div class="card-head"><h2>Riwayat Kecocokan Tersimpan</h2><span class="badge">${num((p.top_matches || []).length)}</span></div>
      <div id="match-history">
        ${
          (p.top_matches || []).length === 0
            ? emptyState({
                icon: 'fa-people-arrows',
                title: 'Belum ada kecocokan tersimpan',
                message: 'Jalankan peringkat segmen atau cocokkan penyewa tertentu untuk menyimpan hasil kecocokan.'
              })
            : (p.top_matches || [])
                .map(
                  (m) => `<div class="list-item">
                    <span class="li-icon ${m.recommendation === 'HIGH_FIT' ? 'ok' : m.recommendation === 'MEDIUM_FIT' ? 'warn' : ''}">
                      <i class="fa-solid fa-bullseye"></i></span>
                    <div class="li-main">
                      <div class="li-title">${esc(m.tenant_name || m.segment_name || 'Segmen')}</div>
                      <div class="li-sub">${esc((m.reasoning || []).slice(0, 2).join(' · ') || 'Tanpa alasan tercatat')}</div>
                    </div>
                    <div class="li-side">${scorePill(m.fit_score, '%')}${badge(m.recommendation)}</div>
                  </div>`
                )
                .join('')
        }
      </div>
    </div>
  </div>`
}

function bindMatching(body, p, reload) {
  body.querySelector('[data-action="rank"]')?.addEventListener('click', async (e) => {
    const btn = e.currentTarget
    const host = body.querySelector('#rank-host')
    btn.disabled = true
    btn.innerHTML = '<i class="fa-solid fa-spinner fa-spin"></i> Menghitung…'
    host.innerHTML = loadingState('Mencocokkan properti dengan seluruh segmen…')
    try {
      const res = await api.post(`/properties/${p.id}/tenant-fit`, {})
      const ranked = res.data || []
      host.innerHTML = ranked.length === 0
        ? emptyState({
            icon: 'fa-users-slash',
            title: 'Belum ada segmen penyewa aktif',
            message: 'Tambahkan segmen penyewa terlebih dahulu agar sistem dapat memberi rekomendasi target.',
            action: session.can('segment.manage') ? { action: 'goto-segments', label: 'Kelola Segmen', icon: 'fa-users' } : undefined
          })
        : ranked.map((r) => matchCard(r, p)).join('')
      bindMatchCards(host, p, reload)
    } catch (err) {
      host.innerHTML = `<div class="inline-error">${esc(errorText(err))}</div>`
    } finally {
      btn.disabled = false
      btn.innerHTML = '<i class="fa-solid fa-ranking-star"></i>Peringkat segmen'
    }
  })
  bindMatchCards(body, p, reload)
}

/** §25 — score is ALWAYS shown with reasons, mismatches and risks. */
function matchCard(r, p) {
  const name = r.segment_name || r.tenant_name || r.subject_name || 'Segmen'
  return `<div class="match-box" style="margin:12px 16px">
    <div class="mb-head">
      <span class="mb-score">${r.fit_score}%</span>
      ${badge(r.recommendation)}
      <span class="strong">${esc(name)}</span>
      <span style="margin-left:auto" class="row tight">
        ${
          r.tenant_id && session.can('lead.create')
            ? `<button class="btn sm primary" data-make-lead="${attr(r.tenant_id)}"><i class="fa-solid fa-user-plus"></i>Buat Lead</button>`
            : r.tenant_segment_id && session.can('offer.create')
              ? `<button class="btn sm" data-make-offer="${attr(r.tenant_segment_id)}"><i class="fa-solid fa-tags"></i>Buat Offer</button>`
              : ''
        }
      </span>
    </div>
    ${meter(r.fit_score)}
    <div class="grid cols-3" style="margin-top:11px">
      <div>
        <div class="tiny dim" style="margin-bottom:3px">Alasan cocok</div>
        ${(r.reasoning || []).length ? r.reasoning.map((x) => `<div class="reason pro"><i class="fa-solid fa-check"></i><span>${esc(x)}</span></div>`).join('') : '<div class="dim tiny">—</div>'}
      </div>
      <div>
        <div class="tiny dim" style="margin-bottom:3px">Ketidakcocokan</div>
        ${(r.mismatches || []).length ? r.mismatches.map((x) => `<div class="reason con"><i class="fa-solid fa-xmark"></i><span>${esc(x)}</span></div>`).join('') : '<div class="dim tiny">Tidak ada</div>'}
      </div>
      <div>
        <div class="tiny dim" style="margin-bottom:3px">Risiko</div>
        ${(r.risks || []).length ? r.risks.map((x) => `<div class="reason risk"><i class="fa-solid fa-triangle-exclamation"></i><span>${esc(x)}</span></div>`).join('') : '<div class="dim tiny">Tidak ada</div>'}
      </div>
    </div>
  </div>`
}

function bindMatchCards(host, p, reload) {
  host.querySelectorAll('[data-make-lead]').forEach((b) =>
    b.addEventListener('click', () => createLeadFor(p, b.dataset.makeLead, reload))
  )
  host.querySelectorAll('[data-make-offer]').forEach((b) =>
    b.addEventListener('click', () =>
      import('./offers.js').then(({ openOfferForm }) =>
        openOfferForm({ property_id: p.id, tenant_segment_id: b.dataset.makeOffer, property: p }, reload)
      )
    )
  )
  host.querySelector('[data-action="goto-segments"]')?.addEventListener('click', () => {
    location.hash = '#/segments'
  })
}

/* ------------------------------ Pipeline tab ------------------------------ */

async function loadPipeline(body, p) {
  try {
    const res = await api.get(`/properties/${p.id}/leads`)
    const rows = res.data || []
    body.innerHTML = `<div class="card">
      <div class="card-head"><h2>Leads Properti Ini</h2><span class="badge">${num(rows.length)}</span>
        <div class="actions">
          ${session.can('lead.create') ? `<button class="btn sm primary" data-action="new-lead"><i class="fa-solid fa-user-plus"></i>Buat Lead</button>` : ''}
          <a class="btn sm" href="#/leads"><i class="fa-solid fa-diagram-project"></i>Pipeline penuh</a>
        </div>
      </div>
      ${
        rows.length === 0
          ? emptyState({
              icon: 'fa-filter-circle-dollar',
              title: 'Belum ada lead untuk properti ini',
              message: 'Pasarkan properti, buat offer, atau catat calon penyewa yang sudah menghubungi Anda.',
              action: session.can('lead.create') ? { action: 'new-lead', label: 'Buat Lead', icon: 'fa-user-plus' } : undefined
            })
          : `<div class="table-wrap"><table class="data">
              <thead><tr><th>Calon penyewa</th><th>Status</th><th>Suhu</th><th class="right">Skor</th><th>Sumber</th><th>Dibuat</th></tr></thead>
              <tbody>
                ${rows
                  .map(
                    (l) => `<tr class="clickable" data-lead="${attr(l.id)}">
                      <td class="cell-main"><span class="strong">${esc(l.tenant_name)}</span>
                        <div class="tiny dim">${esc(humanEnum(l.business_category))}</div></td>
                      <td>${badge(l.status)}</td>
                      <td>${badge(l.temperature)}</td>
                      <td class="right">${scorePill(l.score)}</td>
                      <td>${esc(humanEnum(l.source))}</td>
                      <td class="nowrap tiny dim">${fmtDate(l.created_at)}</td>
                    </tr>`
                  )
                  .join('')}
              </tbody></table></div>`
      }
    </div>`
    body.querySelectorAll('tr[data-lead]').forEach((tr) =>
      tr.addEventListener('click', () => {
        location.hash = `#/leads/${tr.dataset.lead}`
      })
    )
  } catch (err) {
    body.innerHTML = errorState(err)
  }
}

/* ----------------------------- Commercial tab ----------------------------- */

function renderCommercial(p) {
  return `<div class="split">
    <div class="card">
      <div class="card-head"><h2>Offer</h2><span class="badge">${num((p.offers || []).length)}</span>
        <div class="actions">${session.can('offer.create') ? `<button class="btn sm primary" data-action="offer"><i class="fa-solid fa-plus"></i>Offer baru</button>` : ''}</div>
      </div>
      ${
        (p.offers || []).length === 0
          ? emptyState({
              icon: 'fa-tags',
              title: 'Belum ada offer',
              message: 'Offer mengubah properti menjadi penawaran terarah untuk satu segmen penyewa, dan menjadi mesin akuisisi lead.',
              action: session.can('offer.create') ? { action: 'offer', label: 'Buat Offer', icon: 'fa-tags' } : undefined
            })
          : (p.offers || [])
              .map(
                (o) => `<div class="list-item clickable" data-offer="${attr(o.id)}">
                  <span class="li-icon brand"><i class="fa-solid fa-tag"></i></span>
                  <div class="li-main">
                    <div class="li-title">${esc(o.title)}</div>
                    <div class="li-sub">${money(o.price)} · dibuat ${fmtDate(o.created_at)}${o.published_at ? ` · publish ${fmtDate(o.published_at)}` : ''}</div>
                  </div>
                  <div class="li-side">${badge(o.status)}</div>
                </div>`
              )
              .join('')
      }
    </div>
    <div class="card">
      <div class="card-head"><h2>Rental</h2></div>
      ${
        p.rental
          ? `<div class="card-body">
              <dl class="kv">
                <dt>Penyewa</dt><dd>${esc(p.rental.tenant_name)}</dd>
                <dt>Status</dt><dd>${badge(p.rental.status)}</dd>
                <dt>Mulai</dt><dd>${fmtDate(p.rental.start_date)}</dd>
                <dt>Berakhir</dt><dd>${fmtDate(p.rental.end_date)}</dd>
                <dt>Harga</dt><dd>${money(p.rental.price)} ${esc(period(p.rental.payment_period))}</dd>
              </dl>
              <div class="row" style="margin-top:12px"><a class="btn" href="#/rentals"><i class="fa-solid fa-file-signature"></i>Kelola rental</a></div>
            </div>`
          : emptyState({
              icon: 'fa-file-signature',
              title: 'Belum ada rental aktif',
              message: 'Rental terbentuk dari negosiasi yang disetujui. Properti ini masih dapat dipasarkan.'
            })
      }
    </div>
  </div>`
}

/* ------------------------------ Action binding ---------------------------- */

function bindTabBody(body, p, reload) {
  bindActions(body, p, reload)
  body.querySelectorAll('[data-offer]').forEach((n) =>
    n.addEventListener('click', () => {
      location.hash = `#/offers?highlight=${n.dataset.offer}`
    })
  )
}

function bindHeaderActions(p, reload) {
  bindActions(document.getElementById('page-actions'), p, reload)
  bindActions(screenEl(), p, reload)
}

function bindActions(host, p, reload) {
  if (!host) return

  host.querySelector('[data-action="edit"]')?.addEventListener('click', () => openPropertyForm(p, reload))
  host.querySelector('[data-action="analyze"]')?.addEventListener('click', () => openAnalysisForm(p, reload))

  host.querySelector('[data-action="verify"]')?.addEventListener('click', () =>
    confirmAction({
      title: 'Verifikasi properti',
      consequence: 'Properti akan berstatus VERIFIED dan menjadi AVAILABLE sehingga siap dipasarkan.',
      confirmLabel: 'Verifikasi',
      async onConfirm() {
        await api.post(`/properties/${p.id}/verify`)
        toast('Properti diverifikasi dan tersedia.', 'ok')
        reload()
      }
    })
  )

  host.querySelector('[data-action="market"]')?.addEventListener('click', () =>
    confirmAction({
      title: 'Pasarkan properti',
      consequence: 'Properti akan berstatus MARKETED dan dihitung sebagai properti yang sedang dipasarkan pada dashboard.',
      confirmLabel: 'Pasarkan',
      async onConfirm() {
        await api.post(`/properties/${p.id}/market`)
        toast('Properti kini dipasarkan.', 'ok')
        reload()
      }
    })
  )

  host.querySelector('[data-action="offer"]')?.addEventListener('click', () =>
    import('./offers.js').then(({ openOfferForm }) => openOfferForm({ property_id: p.id, property: p }, reload))
  )

  host.querySelector('[data-action="new-lead"]')?.addEventListener('click', () => createLeadFor(p, null, reload))

  host.querySelector('[data-action="delete"]')?.addEventListener('click', () =>
    confirmAction({
      title: `Hapus properti — ${p.name}`,
      consequence:
        'Jika properti sudah memiliki riwayat lead, kunjungan, atau rental, properti tidak dihapus permanen melainkan diarsipkan (INACTIVE) demi integritas data historis.',
      confirmLabel: 'Hapus properti',
      danger: true,
      async onConfirm() {
        await api.del(`/properties/${p.id}`)
        toast('Properti dihapus/diarsipkan.', 'ok')
        location.hash = '#/properties'
      }
    })
  )
}

/* --------------------------- Analysis input form -------------------------- */

function openAnalysisForm(p, onDone) {
  const a = p.analysis
  const listField = (name, label, value, hint) => `
    <div class="field full">
      <label for="f_${name}">${esc(label)}</label>
      <textarea id="f_${name}" name="${name}" rows="3" placeholder="Satu poin per baris">${esc((value || []).join('\n'))}</textarea>
      <div class="hint">${esc(hint)}</div>
    </div>`

  openModal({
    title: `Analisis Properti — ${p.name}`,
    wide: true,
    body: `
      <form id="an-form" novalidate>
        <div id="an-error"></div>
        <div class="inline-info">Skor 0–10 per dimensi. Sistem menghitung skor keseluruhan dan potensi komersial — bukan input manual. Setiap skor wajib punya alasan.</div>
        <div class="form-grid">
          ${field({ name: 'access_score', label: 'Akses (0–10)', type: 'number', required: true, value: a?.access_score ?? 6, min: 0, max: 10, hint: 'Kemudahan dijangkau kendaraan/pejalan' })}
          ${field({ name: 'visibility_score', label: 'Visibilitas (0–10)', type: 'number', required: true, value: a?.visibility_score ?? 6, min: 0, max: 10, hint: 'Terlihat dari jalan / lalu-lintas' })}
          ${field({ name: 'location_score', label: 'Lokasi (0–10)', type: 'number', required: true, value: a?.location_score ?? 6, min: 0, max: 10, hint: 'Kekuatan aktivitas ekonomi sekitar' })}
          ${field({ name: 'space_score', label: 'Ruang (0–10)', type: 'number', required: true, value: a?.space_score ?? 6, min: 0, max: 10, hint: 'Kesesuaian bentuk & luas untuk usaha' })}
        </div>
        <div class="form-grid" style="margin-top:4px">
          ${listField('strengths', 'Kekuatan', a?.strengths, 'Contoh: berada di jalur ramai pejalan kaki')}
          ${listField('weaknesses', 'Kelemahan', a?.weaknesses, 'Contoh: tidak ada lahan parkir')}
          ${listField('opportunities', 'Peluang', a?.opportunities, 'Contoh: belum ada laundry di radius 300 m')}
          ${listField('risks', 'Risiko', a?.risks, 'Contoh: visibilitas perlu strategi signage')}
          ${listField('recommended_uses', 'Peruntukan disarankan', a?.recommended_uses, 'Contoh: FOOD_BUSINESS, LAUNDRY, RETAIL')}
        </div>
      </form>`,
    footer: `
      <button class="btn" data-modal-close>Batal</button>
      <button class="btn primary" id="an-save"><i class="fa-solid fa-brain"></i>Simpan Analisis</button>`,
    onMount(root, close) {
      const form = root.querySelector('#an-form')
      const errBox = root.querySelector('#an-error')
      const btn = root.querySelector('#an-save')
      btn.addEventListener('click', async () => {
        errBox.innerHTML = ''
        const raw = readForm(form)
        const lines = (v) =>
          String(v || '')
            .split('\n')
            .map((s) => s.trim())
            .filter(Boolean)
        const body = {
          access_score: Number(raw.access_score),
          visibility_score: Number(raw.visibility_score),
          location_score: Number(raw.location_score),
          space_score: Number(raw.space_score),
          strengths: lines(raw.strengths),
          weaknesses: lines(raw.weaknesses),
          opportunities: lines(raw.opportunities),
          risks: lines(raw.risks),
          recommended_uses: lines(raw.recommended_uses).map((s) => s.toUpperCase().replace(/\s+/g, '_'))
        }
        btn.disabled = true
        btn.innerHTML = '<i class="fa-solid fa-spinner fa-spin"></i> Menganalisis…'
        try {
          await api.post(`/properties/${p.id}/analysis`, body)
          close()
          toast('Analisis properti tersimpan.', 'ok')
          onDone?.()
        } catch (err) {
          btn.disabled = false
          btn.innerHTML = '<i class="fa-solid fa-brain"></i>Simpan Analisis'
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

/** Bridge to the lead module so "find tenant → create lead" stays one flow. */
function createLeadFor(p, tenantId, onDone) {
  import('./leads.js').then(({ openLeadForm }) =>
    openLeadForm({ property_id: p.id, tenant_id: tenantId, property_name: p.name }, onDone)
  )
}
