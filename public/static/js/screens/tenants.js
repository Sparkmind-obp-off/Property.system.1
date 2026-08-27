/**
 * Tenants + Tenant Segments — profiles and property matching.
 * Traceability: PS-MASTER-001 §7, §8, §25 | PS-UX-010 §15, §16, §17
 *
 * A tenant is NOT automatically a lead (§7): converting to a lead is an
 * explicit action from a matched property.
 */
import { api, errorText, session } from '../core/api.js'
import {
  applyFieldErrors,
  attr,
  badge,
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
  moneyShort,
  num,
  openModal,
  pagerHtml,
  readForm,
  scorePill,
  skeletonRows,
  toast,
  truncate
} from '../core/dom.js'
import { replaceQuery } from '../core/router.js'
import { screenEl, setHeader } from '../core/shell.js'

const BUSINESS_CATEGORIES = [
  'UMKM',
  'BARBER',
  'LAUNDRY',
  'FOOD_BUSINESS',
  'SERVICE_BUSINESS',
  'RETAIL',
  'WORKSHOP',
  'OTHER'
]
const TENANT_TYPES = ['INDIVIDUAL', 'BUSINESS', 'ORGANIZATION']
const TENANT_STATUS = ['PROSPECT', 'ACTIVE', 'INACTIVE']

/* ========================================================================== *
 * TENANT LIST
 * ========================================================================== */

export async function tenantListScreen({ query }) {
  const el = screenEl()
  const state = {
    page: Number(query.page) || 1,
    limit: 20,
    search: query.search || '',
    business_category: query.business_category || '',
    status: query.status || '',
    sort: query.sort || 'created_at:desc'
  }

  setHeader({
    title: 'Calon Penyewa',
    subtitle: 'Profil penyewa · kebutuhan · anggaran · kecocokan properti',
    actions: `
      <a class="btn" href="#/segments"><i class="fa-solid fa-layer-group"></i>Segmen</a>
      ${session.can('tenant.create') ? `<button class="btn primary" data-action="new"><i class="fa-solid fa-plus"></i>Tambah Penyewa</button>` : ''}`,
    mobilePrimary: session.can('tenant.create') ? { action: 'new', label: 'Penyewa', icon: 'fa-plus' } : null
  })

  el.innerHTML = `
    <section class="stack">
      <div class="card">
        <div class="card-body tight">
          <div class="filters">
            <input type="search" id="t-search" placeholder="Cari nama, kontak, atau usaha…" value="${attr(state.search)}">
            <select id="t-cat">
              <option value="">Semua kategori usaha</option>
              ${BUSINESS_CATEGORIES.map((c) => `<option value="${c}" ${state.business_category === c ? 'selected' : ''}>${esc(humanEnum(c))}</option>`).join('')}
            </select>
            <select id="t-status">
              <option value="">Semua status</option>
              ${TENANT_STATUS.map((c) => `<option value="${c}" ${state.status === c ? 'selected' : ''}>${esc(humanEnum(c))}</option>`).join('')}
            </select>
            <select id="t-sort">
              <option value="created_at:desc" ${state.sort === 'created_at:desc' ? 'selected' : ''}>Terbaru</option>
              <option value="name:asc" ${state.sort === 'name:asc' ? 'selected' : ''}>Nama A–Z</option>
              <option value="budget_max:desc" ${state.sort === 'budget_max:desc' ? 'selected' : ''}>Anggaran tertinggi</option>
              <option value="space_need:desc" ${state.sort === 'space_need:desc' ? 'selected' : ''}>Kebutuhan ruang terbesar</option>
            </select>
            <button class="btn sm" id="t-reset" title="Reset filter"><i class="fa-solid fa-eraser"></i></button>
          </div>
        </div>
        <div id="t-result"></div>
      </div>
    </section>`

  const result = el.querySelector('#t-result')

  async function load() {
    result.innerHTML = `<div class="table-wrap"><table class="data">
      <thead><tr><th>Penyewa</th><th>Kategori</th><th>Anggaran</th><th>Kebutuhan ruang</th><th>Preferensi lokasi</th><th>Status</th><th class="right">Lead</th></tr></thead>
      <tbody>${skeletonRows(7, 6)}</tbody></table></div>`
    try {
      const res = await api.get('/tenants', {
        page: state.page,
        limit: state.limit,
        search: state.search,
        business_category: state.business_category,
        status: state.status,
        sort: state.sort
      })
      render(res.data, res.meta)
    } catch (err) {
      result.innerHTML = errorState(err)
      result.querySelector('[data-action="retry"]')?.addEventListener('click', load)
    }
  }

  function render(rows, meta) {
    if (rows.length === 0) {
      const filtered = state.search || state.business_category || state.status
      result.innerHTML = emptyState(
        filtered
          ? {
              icon: 'fa-filter-circle-xmark',
              title: 'Tidak ada penyewa yang cocok',
              message: 'Longgarkan filter untuk melihat calon penyewa lainnya.',
              action: { action: 'clear-filter', label: 'Hapus filter', icon: 'fa-eraser' }
            }
          : {
              icon: 'fa-users',
              title: 'Belum ada calon penyewa',
              message: 'Catat calon penyewa beserta anggaran dan kebutuhan ruangnya agar sistem dapat mencocokkan mereka dengan properti Anda.',
              action: session.can('tenant.create') ? { action: 'new', label: 'Tambah Penyewa', icon: 'fa-plus' } : undefined
            }
      )
      bind()
      return
    }

    result.innerHTML = `
      <div class="table-wrap"><table class="data">
        <thead><tr>
          <th>Penyewa</th><th>Kategori</th><th>Anggaran</th><th>Kebutuhan ruang</th>
          <th>Preferensi lokasi</th><th>Status</th><th class="right">Lead</th>
        </tr></thead>
        <tbody>
          ${rows
            .map(
              (t) => `<tr class="clickable" data-id="${attr(t.id)}">
                <td class="cell-main"><span class="strong">${esc(t.name)}</span>
                  <div class="tiny dim">${esc(humanEnum(t.tenant_type))}${t.contact_name ? ` · ${esc(t.contact_name)}` : ''}${t.phone ? ` · ${esc(t.phone)}` : ''}</div></td>
                <td>${badge(t.business_category, { tone: 'brand' })}</td>
                <td class="nowrap">${t.budget_min || t.budget_max ? `${moneyShort(t.budget_min)} – ${moneyShort(t.budget_max)}` : '<span class="dim">—</span>'}</td>
                <td class="nowrap">${t.space_need ? `${num(t.space_need)} m²` : '<span class="dim">—</span>'}</td>
                <td>${t.location_preference ? esc(truncate(t.location_preference, 30)) : '<span class="dim">—</span>'}</td>
                <td>${badge(t.status)}</td>
                <td class="right">${t.lead_count ? `<span class="strong">${num(t.lead_count)}</span>` : '<span class="dim">0</span>'}</td>
              </tr>`
            )
            .join('')}
        </tbody>
      </table></div>
      <div class="card-foot">${pagerHtml(meta)}</div>`
    bind()
  }

  function bind() {
    result.querySelectorAll('tr[data-id]').forEach((tr) =>
      tr.addEventListener('click', () => {
        location.hash = `#/tenants/${tr.dataset.id}`
      })
    )
    result.querySelectorAll('[data-page]').forEach((b) =>
      b.addEventListener('click', () => {
        state.page = Number(b.dataset.page)
        sync()
        load()
      })
    )
    result.querySelector('[data-action="new"]')?.addEventListener('click', () => openTenantForm(null, load))
    result.querySelector('[data-action="clear-filter"]')?.addEventListener('click', () => el.querySelector('#t-reset').click())
    result.querySelector('[data-action="retry"]')?.addEventListener('click', load)
  }

  function sync() {
    replaceQuery({
      page: state.page > 1 ? state.page : '',
      search: state.search,
      business_category: state.business_category,
      status: state.status,
      sort: state.sort !== 'created_at:desc' ? state.sort : ''
    })
  }

  el.querySelector('#t-search').addEventListener(
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
  bindSelect('#t-cat', 'business_category')
  bindSelect('#t-status', 'status')
  bindSelect('#t-sort', 'sort')

  el.querySelector('#t-reset').addEventListener('click', () => {
    Object.assign(state, { search: '', business_category: '', status: '', page: 1 })
    el.querySelector('#t-search').value = ''
    el.querySelector('#t-cat').value = ''
    el.querySelector('#t-status').value = ''
    sync()
    load()
  })

  document.querySelector('#page-actions [data-action="new"]')?.addEventListener('click', () => openTenantForm(null, load))
  document.querySelector('.mobile-primary[data-action="new"]')?.addEventListener('click', () => openTenantForm(null, load))

  await load()
}

/* ========================================================================== *
 * TENANT FORM
 * ========================================================================== */

export function openTenantForm(tenant, onDone) {
  const isEdit = Boolean(tenant)
  openModal({
    title: isEdit ? `Ubah Penyewa — ${tenant.name}` : 'Tambah Calon Penyewa',
    wide: true,
    body: `
      <form id="tn-form" novalidate>
        <div id="tn-error"></div>
        <div class="form-grid">
          ${field({ name: 'name', label: 'Nama penyewa / usaha', required: true, value: tenant?.name, placeholder: 'Warung Bu Ani', full: true })}
          ${field({ name: 'business_category', label: 'Kategori usaha', type: 'select', required: true, value: tenant?.business_category || 'UMKM', options: BUSINESS_CATEGORIES })}
          ${field({ name: 'tenant_type', label: 'Tipe penyewa', type: 'select', value: tenant?.tenant_type || 'BUSINESS', options: TENANT_TYPES })}
          ${field({ name: 'contact_name', label: 'Nama kontak', value: tenant?.contact_name, placeholder: 'Ani Suryani' })}
          ${field({ name: 'phone', label: 'Telepon / WhatsApp', value: tenant?.phone, placeholder: '0812…' })}
          ${field({ name: 'email', label: 'Email', type: 'email', value: tenant?.email, placeholder: 'nama@contoh.id' })}
          ${field({ name: 'status', label: 'Status', type: 'select', value: tenant?.status || 'PROSPECT', options: TENANT_STATUS })}
          ${field({ name: 'budget_min', label: 'Anggaran minimum', type: 'number', value: tenant?.budget_min, min: 0, step: 100000, hint: 'Rupiah per periode sewa' })}
          ${field({ name: 'budget_max', label: 'Anggaran maksimum', type: 'number', value: tenant?.budget_max, min: 0, step: 100000, hint: 'Wajib ≥ anggaran minimum' })}
          ${field({ name: 'space_need', label: 'Kebutuhan ruang (m²)', type: 'number', value: tenant?.space_need, min: 0, step: 1 })}
          ${field({ name: 'location_preference', label: 'Preferensi lokasi', value: tenant?.location_preference, placeholder: 'Kota Lama, dekat pasar' })}
          ${field({ name: 'business_description', label: 'Deskripsi usaha & kebutuhan', type: 'textarea', rows: 3, value: tenant?.business_description, placeholder: 'Jenis usaha, jam operasional, kebutuhan khusus…', full: true })}
        </div>
      </form>`,
    footer: `
      <button class="btn" data-modal-close>Batal</button>
      <button class="btn primary" id="tn-save"><i class="fa-solid fa-floppy-disk"></i>${isEdit ? 'Simpan Perubahan' : 'Simpan Penyewa'}</button>`,
    onMount(root, close) {
      const form = root.querySelector('#tn-form')
      const errBox = root.querySelector('#tn-error')
      const btn = root.querySelector('#tn-save')
      btn.addEventListener('click', async () => {
        errBox.innerHTML = ''
        const body = readForm(form)
        btn.disabled = true
        btn.innerHTML = '<i class="fa-solid fa-spinner fa-spin"></i> Menyimpan…'
        try {
          const res = isEdit ? await api.patch(`/tenants/${tenant.id}`, body) : await api.post('/tenants', body)
          close()
          toast(isEdit ? 'Data penyewa diperbarui.' : 'Calon penyewa ditambahkan. Cocokkan dengan properti untuk membuat lead.', 'ok')
          onDone?.(res.data)
        } catch (err) {
          btn.disabled = false
          btn.innerHTML = `<i class="fa-solid fa-floppy-disk"></i>${isEdit ? 'Simpan Perubahan' : 'Simpan Penyewa'}`
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
 * TENANT DETAIL
 * ========================================================================== */

export async function tenantDetailScreen({ params, query }) {
  const el = screenEl()
  const id = params.id
  setHeader({ title: 'Calon Penyewa', subtitle: '' })
  el.innerHTML = loadingState('Memuat profil penyewa…')

  let t
  try {
    const res = await api.get(`/tenants/${id}`)
    t = res.data
  } catch (err) {
    el.innerHTML = errorState(err)
    el.querySelector('[data-action="retry"]')?.addEventListener('click', () => tenantDetailScreen({ params, query }))
    el.querySelector('[data-action="back"]')?.addEventListener('click', () => {
      location.hash = '#/tenants'
    })
    return
  }

  const reload = () => tenantDetailScreen({ params, query })

  setHeader({
    title: t.name,
    subtitle: `${esc(humanEnum(t.business_category))} · ${esc(humanEnum(t.tenant_type))}`,
    actions: `
      ${session.can('tenant.update') ? `<button class="btn" data-action="edit"><i class="fa-solid fa-pen"></i>Ubah</button>` : ''}
      ${session.can('match.execute') ? `<button class="btn primary" data-action="match"><i class="fa-solid fa-bullseye"></i>Cari Properti Cocok</button>` : ''}`
  })

  el.innerHTML = `
    <section class="stack">
      <a class="tiny" href="#/tenants"><i class="fa-solid fa-arrow-left"></i> Semua calon penyewa</a>
      ${renderTenantGuidance(t)}
      <div class="split">
        <div class="stack">
          <div class="card">
            <div class="card-head"><h2>Profil & Kebutuhan</h2>${badge(t.status)}</div>
            <div class="card-body">
              <dl class="kv">
                <dt>Nama</dt><dd>${esc(t.name)}</dd>
                <dt>Kategori usaha</dt><dd>${esc(humanEnum(t.business_category))}</dd>
                <dt>Tipe</dt><dd>${esc(humanEnum(t.tenant_type))}</dd>
                <dt>Kontak</dt><dd>${esc(t.contact_name || '—')}</dd>
                <dt>Telepon</dt><dd>${t.phone ? `<a href="tel:${attr(t.phone)}">${esc(t.phone)}</a>` : '—'}</dd>
                <dt>Email</dt><dd>${t.email ? `<a href="mailto:${attr(t.email)}">${esc(t.email)}</a>` : '—'}</dd>
                <dt>Anggaran</dt><dd>${t.budget_min || t.budget_max ? `${money(t.budget_min)} – ${money(t.budget_max)}` : '—'}</dd>
                <dt>Kebutuhan ruang</dt><dd>${t.space_need ? `${num(t.space_need)} m²` : '—'}</dd>
                <dt>Preferensi lokasi</dt><dd>${esc(t.location_preference || '—')}</dd>
                <dt>Dibuat</dt><dd>${fmtDate(t.created_at)}</dd>
              </dl>
              ${t.business_description ? `<div style="margin-top:14px"><div class="tiny dim" style="margin-bottom:4px">Deskripsi usaha</div><div class="small">${esc(t.business_description)}</div></div>` : ''}
            </div>
          </div>

          <div class="card">
            <div class="card-head"><h2>Properti Paling Cocok</h2>
              <div class="actions">${session.can('match.execute') ? `<button class="btn sm" data-action="match"><i class="fa-solid fa-bullseye"></i>Hitung ulang</button>` : ''}</div>
            </div>
            <div id="tn-match">
              ${
                session.can('match.execute')
                  ? `<div class="card-body tight"><div class="inline-info">Jalankan pencocokan untuk melihat properti mana yang paling sesuai dengan anggaran, kebutuhan ruang, dan jenis usaha penyewa ini.</div></div>`
                  : `<div class="card-body tight"><div class="inline-info">Peran Anda tidak memiliki izin menjalankan pencocokan.</div></div>`
              }
            </div>
          </div>
        </div>

        <div class="stack">
          <div class="card">
            <div class="card-head"><h2>Lead</h2><span class="badge">${num((t.leads || []).length)}</span></div>
            ${
              (t.leads || []).length === 0
                ? emptyState({
                    icon: 'fa-filter-circle-dollar',
                    title: 'Belum menjadi lead',
                    message: 'Calon penyewa belum dihubungkan ke properti. Jalankan pencocokan lalu buat lead dari properti yang cocok.'
                  })
                : (t.leads || [])
                    .map(
                      (l) => `<div class="list-item clickable" data-lead="${attr(l.id)}">
                        <span class="li-icon ${l.temperature === 'HOT' ? 'danger' : l.temperature === 'WARM' ? 'warn' : 'brand'}">
                          <i class="fa-solid fa-fire"></i></span>
                        <div class="li-main">
                          <div class="li-title">${esc(l.property_name)}</div>
                          <div class="li-sub">${esc(humanEnum(l.status))} · dibuat ${fmtDate(l.created_at)}</div>
                        </div>
                        <div class="li-side">${scorePill(l.score)}${badge(l.temperature)}</div>
                      </div>`
                    )
                    .join('')
            }
          </div>

          <div class="card">
            <div class="card-head"><h2>Riwayat Rental</h2><span class="badge">${num((t.rentals || []).length)}</span></div>
            ${
              (t.rentals || []).length === 0
                ? emptyState({ icon: 'fa-file-signature', title: 'Belum ada rental', message: 'Rental terbentuk setelah negosiasi disetujui dan diaktifkan.' })
                : (t.rentals || [])
                    .map(
                      (r) => `<div class="list-item">
                        <span class="li-icon ${r.status === 'ACTIVE' ? 'ok' : ''}"><i class="fa-solid fa-file-contract"></i></span>
                        <div class="li-main">
                          <div class="li-title">${esc(r.property_name)}</div>
                          <div class="li-sub">${fmtDate(r.start_date)} → ${fmtDate(r.end_date)} · ${money(r.price)}</div>
                        </div>
                        <div class="li-side">${badge(r.status)}</div>
                      </div>`
                    )
                    .join('')
            }
          </div>
        </div>
      </div>
    </section>`

  // Bindings
  const bindAll = (host) => {
    if (!host) return
    host.querySelector('[data-action="edit"]')?.addEventListener('click', () => openTenantForm(t, reload))
    host.querySelector('[data-action="match"]')?.addEventListener('click', () => runTenantMatch(t))
  }
  bindAll(document.getElementById('page-actions'))
  bindAll(el)

  el.querySelectorAll('[data-lead]').forEach((n) =>
    n.addEventListener('click', () => {
      location.hash = `#/leads/${n.dataset.lead}`
    })
  )

  async function runTenantMatch(tenant) {
    const host = el.querySelector('#tn-match')
    host.innerHTML = loadingState('Mencocokkan penyewa dengan seluruh properti…')
    try {
      const res = await api.get(`/tenants/${tenant.id}/matched-properties`, { limit: 8 })
      const rows = res.data || []
      host.innerHTML =
        rows.length === 0
          ? emptyState({
              icon: 'fa-building-circle-xmark',
              title: 'Belum ada properti yang bisa dicocokkan',
              message: 'Tambahkan dan verifikasi properti terlebih dahulu agar pencocokan dapat dijalankan.'
            })
          : rows.map((r) => tenantMatchCard(r, tenant)).join('')
      host.querySelectorAll('[data-open-prop]').forEach((b) =>
        b.addEventListener('click', () => {
          location.hash = `#/properties/${b.dataset.openProp}`
        })
      )
      host.querySelectorAll('[data-make-lead]').forEach((b) =>
        b.addEventListener('click', () =>
          import('./leads.js').then(({ openLeadForm }) =>
            openLeadForm(
              { property_id: b.dataset.makeLead, tenant_id: tenant.id, tenant_name: tenant.name, property_name: b.dataset.propName },
              reload
            )
          )
        )
      )
    } catch (err) {
      host.innerHTML = `<div class="card-body tight"><div class="inline-error">${esc(errorText(err))}</div></div>`
    }
  }
}

/** §25 — always score + why + risk, and an action that moves the business. */
function tenantMatchCard(r, tenant) {
  return `<div class="match-box" style="margin:12px 16px">
    <div class="mb-head">
      <span class="mb-score">${r.fit_score}%</span>
      ${badge(r.recommendation)}
      <span class="strong">${esc(r.property_name)}</span>
      <span style="margin-left:auto" class="row tight">
        <button class="btn sm" data-open-prop="${attr(r.property_id)}"><i class="fa-solid fa-building"></i>Lihat</button>
        ${session.can('lead.create') ? `<button class="btn sm primary" data-make-lead="${attr(r.property_id)}" data-prop-name="${attr(r.property_name)}"><i class="fa-solid fa-user-plus"></i>Buat Lead</button>` : ''}
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

function renderTenantGuidance(t) {
  const openLead = (t.leads || []).find((l) => !['WON', 'LOST'].includes(l.status))
  if (openLead) {
    return `<div class="next-action">
      <div class="na-icon"><i class="fa-solid fa-filter-circle-dollar"></i></div>
      <div class="na-body">
        <div class="na-label">Langkah berikutnya</div>
        <div class="na-text">Lead aktif pada ${esc(openLead.property_name)} — status ${esc(humanEnum(openLead.status))}</div>
        <div class="na-why">Lanjutkan proses pada lead, jangan membuat duplikasi lead untuk properti yang sama.</div>
      </div>
      <a class="btn primary" href="#/leads/${esc(openLead.id)}"><i class="fa-solid fa-arrow-right"></i>Buka lead</a>
    </div>`
  }
  const incomplete = !t.budget_max || !t.space_need
  if (incomplete) {
    return `<div class="next-action">
      <div class="na-icon"><i class="fa-solid fa-pen"></i></div>
      <div class="na-body">
        <div class="na-label">Perlu perhatian</div>
        <div class="na-text">Anggaran atau kebutuhan ruang belum lengkap</div>
        <div class="na-why">Tanpa data ini, skor kecocokan properti menjadi tidak akurat.</div>
      </div>
      ${session.can('tenant.update') ? `<button class="btn primary" data-action="edit"><i class="fa-solid fa-pen"></i>Lengkapi</button>` : ''}
    </div>`
  }
  return `<div class="next-action">
    <div class="na-icon"><i class="fa-solid fa-bullseye"></i></div>
    <div class="na-body">
      <div class="na-label">Langkah berikutnya</div>
      <div class="na-text">Cocokkan penyewa ini dengan properti yang tersedia</div>
      <div class="na-why">Pencocokan menghasilkan alasan, ketidakcocokan, dan risiko — bukan hanya angka.</div>
    </div>
    ${session.can('match.execute') ? `<button class="btn primary" data-action="match"><i class="fa-solid fa-bullseye"></i>Cari properti cocok</button>` : ''}
  </div>`
}

/* ========================================================================== *
 * SEGMENTS
 * ========================================================================== */

export async function segmentScreen() {
  const el = screenEl()
  setHeader({
    title: 'Segmen Penyewa',
    subtitle: 'Kelompok target penyewa yang dipakai mesin pencocokan dan offer',
    actions: `
      <a class="btn" href="#/tenants"><i class="fa-solid fa-users"></i>Calon penyewa</a>
      ${session.can('segment.manage') ? `<button class="btn primary" data-action="new-seg"><i class="fa-solid fa-plus"></i>Tambah Segmen</button>` : ''}`,
    mobilePrimary: session.can('segment.manage') ? { action: 'new-seg', label: 'Segmen', icon: 'fa-plus' } : null
  })
  el.innerHTML = loadingState('Memuat segmen penyewa…')

  async function load() {
    try {
      const res = await api.get('/tenant-segments')
      render(res.data || [])
    } catch (err) {
      el.innerHTML = errorState(err)
      el.querySelector('[data-action="retry"]')?.addEventListener('click', load)
    }
  }

  function render(rows) {
    el.innerHTML = `<section class="stack">
      ${
        rows.length === 0
          ? `<div class="card">${emptyState({
              icon: 'fa-layer-group',
              title: 'Belum ada segmen penyewa',
              message: 'Segmen adalah kelompok target (misal "UMKM Kuliner Kecil") yang dipakai untuk memberi peringkat kecocokan properti dan membuat offer terarah.',
              action: session.can('segment.manage') ? { action: 'new-seg', label: 'Tambah Segmen', icon: 'fa-plus' } : undefined
            })}</div>`
          : `<div class="grid cols-3">
              ${rows
                .map(
                  (s) => `<div class="card">
                    <div class="card-head">
                      <h2>${esc(s.name)}</h2>
                      ${badge(s.status)}
                    </div>
                    <div class="card-body">
                      <div class="chips" style="margin-bottom:9px">
                        <span class="chip brand"><i class="fa-solid fa-store"></i>${esc(humanEnum(s.business_category))}</span>
                        ${s.minimum_space || s.maximum_space ? `<span class="chip"><i class="fa-solid fa-ruler-combined"></i>${num(s.minimum_space)}–${num(s.maximum_space)} m²</span>` : ''}
                        ${s.budget_min || s.budget_max ? `<span class="chip"><i class="fa-solid fa-wallet"></i>${moneyShort(s.budget_min)}–${moneyShort(s.budget_max)}</span>` : ''}
                      </div>
                      ${s.description ? `<div class="small muted">${esc(s.description)}</div>` : ''}
                      ${
                        (s.requirements || []).length
                          ? `<div style="margin-top:10px"><div class="tiny dim" style="margin-bottom:3px">Kebutuhan</div>
                              ${s.requirements.map((r) => `<div class="reason pro"><i class="fa-solid fa-check"></i><span>${esc(r)}</span></div>`).join('')}</div>`
                          : ''
                      }
                    </div>
                    <div class="card-foot row between">
                      <span class="tiny dim">${num(s.tenant_count ?? 0)} penyewa terkait</span>
                      <span class="tiny dim mono">${esc(s.id)}</span>
                    </div>
                  </div>`
                )
                .join('')}
            </div>`
      }
    </section>`
    el.querySelector('[data-action="new-seg"]')?.addEventListener('click', () => openSegmentForm(load))
    el.querySelector('[data-action="retry"]')?.addEventListener('click', load)
  }

  document.querySelector('#page-actions [data-action="new-seg"]')?.addEventListener('click', () => openSegmentForm(load))
  document.querySelector('.mobile-primary[data-action="new-seg"]')?.addEventListener('click', () => openSegmentForm(load))

  await load()
}

function openSegmentForm(onDone) {
  openModal({
    title: 'Tambah Segmen Penyewa',
    wide: true,
    body: `
      <form id="sg-form" novalidate>
        <div id="sg-error"></div>
        <div class="form-grid">
          ${field({ name: 'name', label: 'Nama segmen', required: true, placeholder: 'UMKM Kuliner Kecil', full: true })}
          ${field({ name: 'business_category', label: 'Kategori usaha', type: 'select', required: true, value: 'FOOD_BUSINESS', options: BUSINESS_CATEGORIES })}
          ${field({ name: 'minimum_space', label: 'Ruang minimum (m²)', type: 'number', min: 0, step: 1 })}
          ${field({ name: 'maximum_space', label: 'Ruang maksimum (m²)', type: 'number', min: 0, step: 1 })}
          ${field({ name: 'budget_min', label: 'Anggaran minimum', type: 'number', min: 0, step: 100000 })}
          ${field({ name: 'budget_max', label: 'Anggaran maksimum', type: 'number', min: 0, step: 100000 })}
          ${field({ name: 'description', label: 'Deskripsi segmen', type: 'textarea', rows: 2, full: true, placeholder: 'Karakteristik dan perilaku segmen ini…' })}
        </div>
        <div class="field full">
          <label for="f_requirements">Kebutuhan segmen</label>
          <textarea id="f_requirements" name="requirements" rows="3" placeholder="Satu kebutuhan per baris, misal: Visible frontage"></textarea>
          <div class="hint">Dipakai mesin pencocokan untuk menjelaskan kecocokan dan risiko.</div>
        </div>
      </form>`,
    footer: `
      <button class="btn" data-modal-close>Batal</button>
      <button class="btn primary" id="sg-save"><i class="fa-solid fa-floppy-disk"></i>Simpan Segmen</button>`,
    onMount(root, close) {
      const form = root.querySelector('#sg-form')
      const errBox = root.querySelector('#sg-error')
      const btn = root.querySelector('#sg-save')
      btn.addEventListener('click', async () => {
        errBox.innerHTML = ''
        const raw = readForm(form)
        const body = {
          ...raw,
          requirements: String(raw.requirements || '')
            .split('\n')
            .map((s) => s.trim())
            .filter(Boolean)
        }
        btn.disabled = true
        btn.innerHTML = '<i class="fa-solid fa-spinner fa-spin"></i> Menyimpan…'
        try {
          await api.post('/tenant-segments', body)
          close()
          toast('Segmen penyewa dibuat.', 'ok')
          onDone?.()
        } catch (err) {
          btn.disabled = false
          btn.innerHTML = '<i class="fa-solid fa-floppy-disk"></i>Simpan Segmen'
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
