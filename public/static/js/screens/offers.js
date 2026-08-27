/**
 * Offers & Campaigns — lead-acquisition surface for a property.
 * Traceability: PS-MASTER-001 §9 (offer system), §22 (navigation), §27 (UI
 *               states), §29 (critical action confirmation) | PS-UX-010 §23
 *
 * An offer is the bridge between PROPERTY and LEAD: it never invents its own
 * price/terms truth — the property supplies the baseline and the API owns the
 * DRAFT → READY → ACTIVE → PAUSED → EXPIRED lifecycle.
 */
import { api, errorText, session } from '../core/api.js'
import {
  applyFieldErrors,
  attr,
  badge,
  confirmAction,
  emptyState,
  errorState,
  esc,
  field,
  fmtDate,
  humanEnum,
  loadingState,
  money,
  moneyShort,
  num,
  openModal,
  pagerHtml,
  period,
  readForm,
  skeletonRows,
  toast,
  todayInput,
  truncate
} from '../core/dom.js'
import { replaceQuery } from '../core/router.js'
import { screenEl, setHeader } from '../core/shell.js'

const OFFER_STATUS = ['DRAFT', 'READY', 'ACTIVE', 'PAUSED', 'EXPIRED']
const CAMPAIGN_STATUS = ['DRAFT', 'RUNNING', 'PAUSED', 'ENDED']
const CHANNELS = [
  { value: 'WHATSAPP', label: 'WhatsApp' },
  { value: 'MARKETPLACE', label: 'Marketplace / OLX' },
  { value: 'SOCIAL_MEDIA', label: 'Media Sosial' },
  { value: 'DIRECT_OUTREACH', label: 'Outreach Langsung' },
  { value: 'REFERRAL', label: 'Referral' },
  { value: 'SIGNAGE', label: 'Spanduk / Signage' },
  { value: 'WALK_IN', label: 'Walk-in' }
]

/* ========================================================================== *
 * OFFERS
 * ========================================================================== */

export async function offerListScreen({ query }) {
  const el = screenEl()
  const filters = {
    search: query.search || '',
    status: query.status || '',
    property_id: query.property_id || '',
    page: Number(query.page || 1)
  }

  setHeader({
    title: 'Offer & Campaign',
    subtitle: 'Penawaran properti yang dipublikasikan untuk menarik lead berkualitas',
    actions: `
      <a class="btn" href="#/campaigns"><i class="fa-solid fa-bullhorn"></i>Campaign</a>
      ${session.can('offer.create') ? `<button class="btn primary" data-action="new-offer"><i class="fa-solid fa-plus"></i>Buat Offer</button>` : ''}`,
    mobilePrimary: session.can('offer.create') ? { action: 'new-offer', label: 'Offer', icon: 'fa-plus' } : null
  })

  el.innerHTML = `
    <section class="stack">
      <div id="offer-summary"></div>
      ${renderOfferFilters(filters)}
      <div class="card">
        <div class="card-head">
          <h2>Daftar Offer</h2>
          <span class="badge" id="offer-count">…</span>
        </div>
        <div class="table-wrap">
          <table class="data">
            <thead>
              <tr>
                <th>Offer</th><th>Properti</th><th>Segmen target</th>
                <th class="right">Harga</th><th class="right">Lead</th>
                <th>Status</th><th class="right">Aksi</th>
              </tr>
            </thead>
            <tbody id="offer-body">${skeletonRows(7, 5)}</tbody>
          </table>
        </div>
        <div id="offer-pager"></div>
      </div>
    </section>`

  const reload = () => offerListScreen({ query })
  bindOfferControls(el, filters)
  bindNewOffer(reload)

  let res
  try {
    res = await api.get('/offers', {
      search: filters.search || undefined,
      status: filters.status || undefined,
      property_id: filters.property_id || undefined,
      page: filters.page,
      limit: 20
    })
  } catch (err) {
    document.getElementById('offer-body').innerHTML = `<tr><td colspan="7">${errorState(err)}</td></tr>`
    document.querySelector('#offer-body [data-action="retry"]')?.addEventListener('click', reload)
    return
  }

  const rows = res.data || []
  const body = document.getElementById('offer-body')
  document.getElementById('offer-count').textContent = `${num(res.meta?.total ?? rows.length)} offer`
  document.getElementById('offer-summary').innerHTML = renderOfferSummary(rows, res.meta)

  if (rows.length === 0) {
    body.innerHTML = `<tr><td colspan="7">${emptyState({
      icon: 'fa-bullhorn',
      title: filters.search || filters.status ? 'Tidak ada offer yang cocok' : 'Belum ada offer',
      message:
        filters.search || filters.status
          ? 'Ubah kata kunci atau reset filter untuk melihat offer lain.'
          : 'Offer mengubah properti menjadi penawaran yang siap dipasarkan. Buat offer pertama agar lead mulai masuk dengan konteks yang jelas.',
      action: session.can('offer.create')
        ? { action: 'new-offer-empty', label: 'Buat Offer Pertama', icon: 'fa-plus' }
        : null
    })}</td></tr>`
    body.querySelector('[data-action="new-offer-empty"]')?.addEventListener('click', () => openOfferForm(null, reload))
    document.getElementById('offer-pager').innerHTML = ''
    return
  }

  body.innerHTML = rows.map(renderOfferRow).join('')
  document.getElementById('offer-pager').innerHTML = pagerHtml(res.meta)
  bindOfferRows(body, reload)

  document.querySelectorAll('#offer-pager [data-page]').forEach((b) =>
    b.addEventListener('click', () => {
      const next = { ...query, page: b.dataset.page }
      replaceQuery(next)
      offerListScreen({ query: next })
    })
  )
}

function renderOfferSummary(rows, meta) {
  const active = rows.filter((o) => o.status === 'ACTIVE').length
  const draft = rows.filter((o) => ['DRAFT', 'READY'].includes(o.status)).length
  const leads = rows.reduce((s, o) => s + Number(o.lead_count || 0), 0)
  const unpublished = rows.filter((o) => o.status === 'READY').length

  return `<div class="grid cols-4">
    <div class="kpi">
      <div class="k-label">Offer aktif</div>
      <div class="k-value">${num(active)}</div>
      <div class="k-sub">dari ${num(meta?.total ?? rows.length)} offer</div>
    </div>
    <div class="kpi">
      <div class="k-label">Belum dipublikasi</div>
      <div class="k-value">${num(draft)}</div>
      <div class="k-sub">${unpublished ? `${num(unpublished)} siap publish` : 'masih draft'}</div>
    </div>
    <div class="kpi">
      <div class="k-label">Lead dari offer</div>
      <div class="k-value">${num(leads)}</div>
      <div class="k-sub">akumulasi halaman ini</div>
    </div>
    <div class="kpi">
      <div class="k-label">Lead / offer aktif</div>
      <div class="k-value">${active ? (leads / active).toFixed(1) : '—'}</div>
      <div class="k-sub">indikator daya tarik</div>
    </div>
  </div>`
}

function renderOfferFilters(f) {
  return `<div class="card"><div class="card-body">
    <div class="filters">
      <div class="field grow">
        <label for="flt-search">Cari offer</label>
        <input id="flt-search" value="${attr(f.search)}" placeholder="Judul offer atau properti…">
      </div>
      <div class="field">
        <label for="flt-status">Status</label>
        <select id="flt-status">
          <option value="">Semua status</option>
          ${OFFER_STATUS.map(
            (s) => `<option value="${attr(s)}" ${f.status === s ? 'selected' : ''}>${esc(humanEnum(s))}</option>`
          ).join('')}
        </select>
      </div>
      <div class="field">
        <label for="flt-prop">ID Properti</label>
        <input id="flt-prop" value="${attr(f.property_id)}" placeholder="prp_…">
      </div>
      <div class="field" style="align-self:end">
        <button class="btn" id="flt-reset"><i class="fa-solid fa-eraser"></i>Reset</button>
      </div>
    </div>
  </div></div>`
}

function renderOfferRow(o) {
  return `<tr>
    <td>
      <button class="cell-main link" data-open-offer="${attr(o.id)}">${esc(truncate(o.title, 54))}</button>
      <div class="cell-sub">${esc(truncate(o.value_proposition || o.description || '—', 62))}</div>
    </td>
    <td>
      <a class="cell-main link" href="#/properties/${attr(o.property_id)}">${esc(o.property_name || '—')}</a>
      <div class="cell-sub">${esc(truncate(o.property_address || '', 42))}</div>
    </td>
    <td>${o.segment_name ? esc(o.segment_name) : '<span class="dim tiny">Belum ditentukan</span>'}</td>
    <td class="right nowrap">${esc(moneyShort(o.price))}</td>
    <td class="right">${num(o.lead_count || 0)}</td>
    <td>${badge(o.status)}${o.published_at ? `<div class="cell-sub">${esc(fmtDate(o.published_at))}</div>` : ''}</td>
    <td class="right nowrap">${renderOfferRowActions(o)}</td>
  </tr>`
}

function renderOfferRowActions(o) {
  const canPublish = session.can('offer.publish')
  const canUpdate = session.can('offer.update')
  const btns = []
  if (o.status === 'DRAFT' && canUpdate)
    btns.push(`<button class="btn sm" data-ready="${attr(o.id)}" title="Tandai siap"><i class="fa-solid fa-check-double"></i></button>`)
  if (o.status === 'READY' && canPublish)
    btns.push(`<button class="btn sm primary" data-publish="${attr(o.id)}"><i class="fa-solid fa-paper-plane"></i>Publish</button>`)
  if (o.status === 'ACTIVE' && canPublish)
    btns.push(`<button class="btn sm" data-pause="${attr(o.id)}" title="Jeda"><i class="fa-solid fa-pause"></i></button>`)
  if (o.status === 'PAUSED' && canPublish)
    btns.push(`<button class="btn sm" data-resume="${attr(o.id)}" title="Lanjutkan"><i class="fa-solid fa-play"></i></button>`)
  btns.push(`<button class="btn sm" data-open-offer="${attr(o.id)}" title="Detail"><i class="fa-solid fa-eye"></i></button>`)
  return btns.join('')
}

function bindOfferControls(el, f) {
  const apply = (patch) => {
    const next = { search: f.search, status: f.status, property_id: f.property_id, ...patch, page: 1 }
    replaceQuery(next)
    offerListScreen({ query: next })
  }
  el.querySelector('#flt-search')?.addEventListener('change', (e) => apply({ search: e.target.value.trim() }))
  el.querySelector('#flt-status')?.addEventListener('change', (e) => apply({ status: e.target.value }))
  el.querySelector('#flt-prop')?.addEventListener('change', (e) => apply({ property_id: e.target.value.trim() }))
  el.querySelector('#flt-reset')?.addEventListener('click', () => apply({ search: '', status: '', property_id: '' }))
}

function bindNewOffer(reload) {
  document
    .querySelectorAll('#page-actions [data-action="new-offer"], .mobile-primary[data-action="new-offer"]')
    .forEach((b) => b.addEventListener('click', () => openOfferForm(null, reload)))
}

function bindOfferRows(body, reload) {
  const act = async (btn, path, okMsg) => {
    btn.disabled = true
    try {
      await api.post(path, {})
      toast(okMsg, 'ok')
      reload()
    } catch (err) {
      btn.disabled = false
      toast(errorText(err), 'err')
    }
  }

  body.querySelectorAll('[data-open-offer]').forEach((b) =>
    b.addEventListener('click', () => openOfferDetail(b.dataset.openOffer, reload))
  )
  body.querySelectorAll('[data-ready]').forEach((b) =>
    b.addEventListener('click', () => act(b, `/offers/${b.dataset.ready}/ready`, 'Offer ditandai siap publikasi.'))
  )
  body.querySelectorAll('[data-pause]').forEach((b) =>
    b.addEventListener('click', () => act(b, `/offers/${b.dataset.pause}/pause`, 'Offer dijeda.'))
  )
  body.querySelectorAll('[data-resume]').forEach((b) =>
    b.addEventListener('click', () => act(b, `/offers/${b.dataset.resume}/resume`, 'Offer diaktifkan kembali.'))
  )
  body.querySelectorAll('[data-publish]').forEach((b) =>
    b.addEventListener('click', () => confirmPublish(b.dataset.publish, reload))
  )
}

/** Publishing is a CRITICAL ACTION — the consequence must be stated (§29). */
function confirmPublish(id, onDone) {
  confirmAction({
    title: 'Publikasikan Offer',
    consequence:
      'Offer akan aktif dan mulai dipakai untuk akuisisi lead. Harga dan syarat yang tertulis menjadi acuan komunikasi ke calon penyewa.',
    confirmLabel: 'Publikasikan',
    async onConfirm() {
      await api.post(`/offers/${id}/publish`, {})
      toast('Offer dipublikasikan.', 'ok')
      onDone()
    }
  })
}

/* ------------------------------ Offer detail ------------------------------ */

export function openOfferDetail(id, onDone) {
  openModal({
    title: 'Detail Offer',
    wide: true,
    body: `<div id="od-host">${loadingState('Memuat detail offer…')}</div>`,
    async onMount(root, close) {
      const host = root.querySelector('#od-host')
      let data
      try {
        data = (await api.get(`/offers/${id}`)).data
      } catch (err) {
        host.innerHTML = errorState(err)
        return
      }
      host.innerHTML = renderOfferDetail(data)

      host.querySelector('[data-action="edit-offer"]')?.addEventListener('click', () => {
        close()
        openOfferForm(data, onDone)
      })
      host.querySelector('[data-action="publish-offer"]')?.addEventListener('click', () => {
        close()
        confirmPublish(data.id, onDone)
      })
      host.querySelector('[data-action="new-campaign"]')?.addEventListener('click', () => {
        close()
        openCampaignForm({ offer_id: data.id, offer_title: data.title }, onDone)
      })
      host.querySelector('[data-action="view-leads"]')?.addEventListener('click', () => {
        close()
        location.hash = `#/leads?property_id=${encodeURIComponent(data.property_id)}`
      })
    }
  })
}

function renderOfferDetail(o) {
  const p = o.property || {}
  const gaps = o.publication_gaps || []
  const stats = o.lead_stats || {}
  const canPublish = o.status === 'READY' && session.can('offer.publish')

  return `
    <div class="stack">
      <div class="detail-hero">
        <div>
          <div class="row tight">${badge(o.status)}${o.segment ? badge(o.segment.business_category, { tone: 'brand' }) : ''}</div>
          <h3 style="margin:6px 0 2px">${esc(o.title)}</h3>
          <div class="dim small">${esc(p.name || '—')} · ${esc(p.address || '')}</div>
        </div>
        <div class="right">
          <div class="k-value">${esc(money(o.price ?? p.price))}<span class="dim small">${esc(period(p.price_period))}</span></div>
          ${o.published_at ? `<div class="tiny dim">Dipublikasi ${esc(fmtDate(o.published_at))}</div>` : '<div class="tiny dim">Belum dipublikasi</div>'}
        </div>
      </div>

      ${
        gaps.length
          ? `<div class="inline-warn"><i class="fa-solid fa-circle-exclamation"></i>
              <b>Belum siap publikasi:</b> ${gaps.map((g) => esc(typeof g === 'string' ? g : g.message || g.field)).join(' · ')}</div>`
          : `<div class="inline-ok"><i class="fa-solid fa-circle-check"></i>Konten offer lengkap dan layak dipublikasikan.</div>`
      }

      <div class="grid cols-3">
        <div class="kpi"><div class="k-label">Total lead</div><div class="k-value">${num(stats.total || 0)}</div><div class="k-sub">dari offer ini</div></div>
        <div class="kpi"><div class="k-label">Masih terbuka</div><div class="k-value">${num(stats.open || 0)}</div><div class="k-sub">perlu tindakan</div></div>
        <div class="kpi"><div class="k-label">Menjadi rental</div><div class="k-value">${num(stats.won || 0)}</div><div class="k-sub">konversi akhir</div></div>
      </div>

      <div class="card"><div class="card-head"><h2>Isi Penawaran</h2></div>
        <div class="card-body">
          <div class="kv"><span>Value proposition</span><b>${esc(o.value_proposition || '—')}</b></div>
          <div class="kv"><span>Deskripsi</span><b>${esc(o.description || '—')}</b></div>
          <div class="kv"><span>Syarat</span><b>${esc(o.terms || '—')}</b></div>
          <div class="kv"><span>Call to action</span><b>${esc(o.cta || '—')}</b></div>
          <div class="kv"><span>Segmen target</span><b>${esc(o.segment?.name || 'Belum ditentukan')}</b></div>
        </div>
      </div>

      <div class="card">
        <div class="card-head"><h2>Campaign</h2><span class="badge">${num((o.campaigns || []).length)}</span></div>
        ${
          (o.campaigns || []).length
            ? `<div class="card-body tight">${o.campaigns
                .map(
                  (c) => `<div class="list-item">
                    <div><div class="strong">${esc(c.name)}</div>
                      <div class="tiny dim">${esc(humanEnum(c.channel))} · ${esc(fmtDate(c.start_at))} → ${esc(fmtDate(c.end_at))}${c.budget ? ` · ${esc(moneyShort(c.budget))}` : ''}</div>
                    </div>
                    <div>${badge(c.status)}</div>
                  </div>`
                )
                .join('')}</div>`
            : `<div class="card-body"><div class="dim small">Belum ada campaign. Offer tanpa campaign hanya menunggu lead datang sendiri.</div></div>`
        }
      </div>

      <div class="row" style="justify-content:flex-end;flex-wrap:wrap">
        <button class="btn" data-action="view-leads"><i class="fa-solid fa-filter-circle-dollar"></i>Lead properti ini</button>
        ${session.can('campaign.manage') ? `<button class="btn" data-action="new-campaign"><i class="fa-solid fa-bullhorn"></i>Buat Campaign</button>` : ''}
        ${session.can('offer.update') ? `<button class="btn" data-action="edit-offer"><i class="fa-solid fa-pen"></i>Edit</button>` : ''}
        ${canPublish ? `<button class="btn primary" data-action="publish-offer"><i class="fa-solid fa-paper-plane"></i>Publikasikan</button>` : ''}
      </div>
    </div>`
}

/* ------------------------------- Offer form ------------------------------- */

export function openOfferForm(offer, onDone) {
  const editing = Boolean(offer?.id)

  openModal({
    title: editing ? 'Edit Offer' : 'Buat Offer',
    wide: true,
    body: `<div id="of-host">${loadingState('Menyiapkan formulir…')}</div>`,
    async onMount(root, close) {
      const host = root.querySelector('#of-host')

      // The offer never invents its own commercial truth: properties and
      // segments come from the domain (§9, §40 no-orphan-UI).
      let properties = []
      let segments = []
      try {
        const [pRes, sRes] = await Promise.all([
          api.get('/properties', { limit: 100, availability_status: editing ? undefined : 'AVAILABLE' }),
          session.can('segment.read') ? api.get('/tenant-segments', { limit: 100 }) : Promise.resolve({ data: [] })
        ])
        properties = pRes.data || []
        segments = sRes.data || []
      } catch (err) {
        host.innerHTML = errorState(err)
        return
      }

      if (!editing && properties.length === 0) {
        host.innerHTML = emptyState({
          icon: 'fa-building',
          title: 'Belum ada properti tersedia',
          message: 'Offer selalu melekat pada properti. Tambahkan properti yang tersedia terlebih dahulu.',
          action: { action: 'goto-prop', label: 'Buka Properti', icon: 'fa-building' }
        })
        host.querySelector('[data-action="goto-prop"]')?.addEventListener('click', () => {
          close()
          location.hash = '#/properties'
        })
        return
      }

      const selected = properties.find((p) => p.id === (offer?.property_id || properties[0]?.id))

      host.innerHTML = `
        <form id="of-form" novalidate>
          <div id="of-error"></div>
          <div class="inline-info">Offer diarahkan ke satu segmen agar pesan tetap spesifik. Setelah dibuat, offer berstatus DRAFT sampai Anda tandai siap dan publikasikan.</div>
          <div class="form-grid">
            ${field({
              name: 'property_id',
              label: 'Properti',
              type: 'select',
              required: true,
              value: offer?.property_id || selected?.id,
              disabled: editing,
              hint: editing ? 'Properti offer tidak dapat dipindah setelah dibuat.' : 'Hanya properti tersedia yang dapat ditawarkan.',
              options: properties.map((p) => ({
                value: p.id,
                label: `${p.name} — ${moneyShort(p.price)}${period(p.price_period)}`
              }))
            })}
            ${field({
              name: 'tenant_segment_id',
              label: 'Segmen target',
              type: 'select',
              value: offer?.tenant_segment_id || '',
              hint: 'Kosongkan bila offer bersifat umum.',
              options: [{ value: '', label: '— Tidak ditentukan —' }, ...segments.map((s) => ({ value: s.id, label: s.name }))]
            })}
            ${field({
              name: 'title',
              label: 'Judul offer',
              required: true,
              full: true,
              value: offer?.title,
              placeholder: 'Contoh: Ruko Strategis Depan Pasar — Siap Usaha Kuliner'
            })}
            ${field({
              name: 'value_proposition',
              label: 'Value proposition',
              type: 'textarea',
              rows: 2,
              full: true,
              value: offer?.value_proposition,
              hint: 'Satu alasan kuat mengapa properti ini cocok untuk segmen target.'
            })}
            ${field({
              name: 'description',
              label: 'Deskripsi',
              type: 'textarea',
              rows: 3,
              full: true,
              value: offer?.description
            })}
            ${field({
              name: 'price',
              label: 'Harga penawaran',
              type: 'number',
              min: 0,
              value: offer?.price ?? selected?.price,
              hint: 'Default mengikuti harga properti.'
            })}
            ${field({ name: 'cta', label: 'Call to action', value: offer?.cta || 'Hubungi Kami' })}
            ${field({
              name: 'terms',
              label: 'Syarat penawaran',
              type: 'textarea',
              rows: 2,
              full: true,
              value: offer?.terms,
              placeholder: 'Contoh: Minimum 12 bulan. Deposit 1 bulan.'
            })}
          </div>
        </form>`

      // Keep the price aligned with the chosen property until the user overrides it.
      const form = host.querySelector('#of-form')
      const priceEl = form.querySelector('[name="price"]')
      let priceTouched = editing
      priceEl?.addEventListener('input', () => {
        priceTouched = true
      })
      form.querySelector('[name="property_id"]')?.addEventListener('change', (e) => {
        if (priceTouched) return
        const p = properties.find((x) => x.id === e.target.value)
        if (p && priceEl) priceEl.value = p.price ?? ''
      })

      const foot = document.createElement('div')
      foot.className = 'modal-foot'
      foot.innerHTML = `
        <button class="btn" data-modal-close>Batal</button>
        <button class="btn primary" id="of-save"><i class="fa-solid fa-floppy-disk"></i>${editing ? 'Simpan Perubahan' : 'Buat Offer'}</button>`
      root.appendChild(foot)

      const btn = foot.querySelector('#of-save')
      const errBox = host.querySelector('#of-error')
      btn.addEventListener('click', async () => {
        errBox.innerHTML = ''
        btn.disabled = true
        btn.innerHTML = '<i class="fa-solid fa-spinner fa-spin"></i> Menyimpan…'
        try {
          const body = readForm(form)
          if (editing) {
            delete body.property_id
            await api.patch(`/offers/${offer.id}`, body)
            toast('Offer diperbarui.', 'ok')
          } else {
            await api.post('/offers', body)
            toast('Offer dibuat sebagai DRAFT.', 'ok')
          }
          close()
          onDone()
        } catch (err) {
          btn.disabled = false
          btn.innerHTML = `<i class="fa-solid fa-floppy-disk"></i>${editing ? 'Simpan Perubahan' : 'Buat Offer'}`
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
 * CAMPAIGNS
 * ========================================================================== */

export async function campaignListScreen({ query }) {
  const el = screenEl()
  const filters = {
    status: query.status || '',
    offer_id: query.offer_id || '',
    page: Number(query.page || 1)
  }

  setHeader({
    title: 'Campaign',
    subtitle: 'Eksekusi kanal pemasaran untuk offer yang sudah dipublikasikan',
    actions: `
      <a class="btn" href="#/offers"><i class="fa-solid fa-tag"></i>Offer</a>
      ${session.can('campaign.manage') ? `<button class="btn primary" data-action="new-campaign"><i class="fa-solid fa-plus"></i>Buat Campaign</button>` : ''}`,
    mobilePrimary: session.can('campaign.manage') ? { action: 'new-campaign', label: 'Campaign', icon: 'fa-plus' } : null
  })

  el.innerHTML = `
    <section class="stack">
      <div id="cmp-summary"></div>
      <div class="card"><div class="card-body">
        <div class="filters">
          <div class="field">
            <label for="cf-status">Status</label>
            <select id="cf-status">
              <option value="">Semua status</option>
              ${CAMPAIGN_STATUS.map(
                (s) => `<option value="${attr(s)}" ${filters.status === s ? 'selected' : ''}>${esc(humanEnum(s))}</option>`
              ).join('')}
            </select>
          </div>
          <div class="field">
            <label for="cf-offer">ID Offer</label>
            <input id="cf-offer" value="${attr(filters.offer_id)}" placeholder="ofr_…">
          </div>
          <div class="field" style="align-self:end">
            <button class="btn" id="cf-reset"><i class="fa-solid fa-eraser"></i>Reset</button>
          </div>
        </div>
      </div></div>
      <div class="card">
        <div class="card-head"><h2>Daftar Campaign</h2><span class="badge" id="cmp-count">…</span></div>
        <div class="table-wrap">
          <table class="data">
            <thead>
              <tr>
                <th>Campaign</th><th>Offer / Properti</th><th>Kanal</th>
                <th>Periode</th><th class="right">Lead</th><th>Status</th><th class="right">Aksi</th>
              </tr>
            </thead>
            <tbody id="cmp-body">${skeletonRows(7, 5)}</tbody>
          </table>
        </div>
        <div id="cmp-pager"></div>
      </div>
    </section>`

  const reload = () => campaignListScreen({ query })

  const apply = (patch) => {
    const next = { status: filters.status, offer_id: filters.offer_id, ...patch, page: 1 }
    replaceQuery(next)
    campaignListScreen({ query: next })
  }
  el.querySelector('#cf-status')?.addEventListener('change', (e) => apply({ status: e.target.value }))
  el.querySelector('#cf-offer')?.addEventListener('change', (e) => apply({ offer_id: e.target.value.trim() }))
  el.querySelector('#cf-reset')?.addEventListener('click', () => apply({ status: '', offer_id: '' }))
  document
    .querySelectorAll('#page-actions [data-action="new-campaign"], .mobile-primary[data-action="new-campaign"]')
    .forEach((b) => b.addEventListener('click', () => openCampaignForm(null, reload)))

  let res
  try {
    res = await api.get('/campaigns', {
      status: filters.status || undefined,
      offer_id: filters.offer_id || undefined,
      page: filters.page,
      limit: 20
    })
  } catch (err) {
    document.getElementById('cmp-body').innerHTML = `<tr><td colspan="7">${errorState(err)}</td></tr>`
    document.querySelector('#cmp-body [data-action="retry"]')?.addEventListener('click', reload)
    return
  }

  const rows = res.data || []
  const body = document.getElementById('cmp-body')
  document.getElementById('cmp-count').textContent = `${num(res.meta?.total ?? rows.length)} campaign`
  document.getElementById('cmp-summary').innerHTML = renderCampaignSummary(rows)

  if (rows.length === 0) {
    body.innerHTML = `<tr><td colspan="7">${emptyState({
      icon: 'fa-bullhorn',
      title: 'Belum ada campaign',
      message:
        'Campaign menjalankan offer di kanal nyata (WhatsApp, marketplace, spanduk) dan membuat sumber lead dapat diukur.',
      action: session.can('campaign.manage')
        ? { action: 'new-cmp-empty', label: 'Buat Campaign', icon: 'fa-plus' }
        : null
    })}</td></tr>`
    body.querySelector('[data-action="new-cmp-empty"]')?.addEventListener('click', () => openCampaignForm(null, reload))
    document.getElementById('cmp-pager').innerHTML = ''
    return
  }

  body.innerHTML = rows.map(renderCampaignRow).join('')
  document.getElementById('cmp-pager').innerHTML = pagerHtml(res.meta)
  bindCampaignRows(body, reload)

  document.querySelectorAll('#cmp-pager [data-page]').forEach((b) =>
    b.addEventListener('click', () => {
      const next = { ...query, page: b.dataset.page }
      replaceQuery(next)
      campaignListScreen({ query: next })
    })
  )
}

function renderCampaignSummary(rows) {
  const running = rows.filter((c) => c.status === 'RUNNING').length
  const leads = rows.reduce((s, c) => s + Number(c.lead_count || 0), 0)
  const won = rows.reduce((s, c) => s + Number(c.won_count || 0), 0)
  const budget = rows.reduce((s, c) => s + Number(c.budget || 0), 0)
  const cpl = leads > 0 && budget > 0 ? budget / leads : null

  return `<div class="grid cols-4">
    <div class="kpi"><div class="k-label">Campaign berjalan</div><div class="k-value">${num(running)}</div><div class="k-sub">dari ${num(rows.length)} campaign</div></div>
    <div class="kpi"><div class="k-label">Lead masuk</div><div class="k-value">${num(leads)}</div><div class="k-sub">${num(won)} menjadi rental</div></div>
    <div class="kpi"><div class="k-label">Total budget</div><div class="k-value">${esc(moneyShort(budget))}</div><div class="k-sub">akumulasi halaman ini</div></div>
    <div class="kpi"><div class="k-label">Biaya per lead</div><div class="k-value">${cpl ? esc(moneyShort(cpl)) : '—'}</div><div class="k-sub">${cpl ? 'budget ÷ lead' : 'butuh budget & lead'}</div></div>
  </div>`
}

function renderCampaignRow(c) {
  const conv = c.lead_count > 0 ? Math.round((Number(c.won_count || 0) / Number(c.lead_count)) * 100) : null
  return `<tr>
    <td>
      <div class="cell-main">${esc(truncate(c.name, 48))}</div>
      <div class="cell-sub">${esc(truncate(c.objective || '—', 56))}</div>
    </td>
    <td>
      <div class="cell-main">${esc(truncate(c.offer_title || '—', 42))}</div>
      <div class="cell-sub">${esc(c.property_name || '')}</div>
    </td>
    <td>${badge(c.channel, { tone: 'info' })}</td>
    <td class="nowrap">
      <div class="cell-main">${esc(fmtDate(c.start_at))}</div>
      <div class="cell-sub">→ ${esc(fmtDate(c.end_at))}</div>
    </td>
    <td class="right">
      <div class="cell-main">${num(c.lead_count || 0)}</div>
      <div class="cell-sub">${conv === null ? '—' : `${conv}% won`}</div>
    </td>
    <td>${badge(c.status)}</td>
    <td class="right nowrap">${renderCampaignActions(c)}</td>
  </tr>`
}

function renderCampaignActions(c) {
  if (!session.can('campaign.manage')) return '<span class="dim tiny">—</span>'
  const btns = []
  if (['DRAFT', 'PAUSED'].includes(c.status))
    btns.push(`<button class="btn sm primary" data-start="${attr(c.id)}" title="Jalankan"><i class="fa-solid fa-play"></i></button>`)
  if (c.status === 'RUNNING')
    btns.push(`<button class="btn sm" data-pause-cmp="${attr(c.id)}" title="Jeda"><i class="fa-solid fa-pause"></i></button>`)
  if (c.status !== 'ENDED')
    btns.push(`<button class="btn sm danger" data-end="${attr(c.id)}" title="Akhiri"><i class="fa-solid fa-flag-checkered"></i></button>`)
  return btns.join('') || '<span class="dim tiny">—</span>'
}

function bindCampaignRows(body, reload) {
  const act = async (btn, path, okMsg) => {
    btn.disabled = true
    try {
      await api.post(path, {})
      toast(okMsg, 'ok')
      reload()
    } catch (err) {
      btn.disabled = false
      toast(errorText(err), 'err')
    }
  }
  body.querySelectorAll('[data-start]').forEach((b) =>
    b.addEventListener('click', () => act(b, `/campaigns/${b.dataset.start}/start`, 'Campaign dijalankan.'))
  )
  body.querySelectorAll('[data-pause-cmp]').forEach((b) =>
    b.addEventListener('click', () => act(b, `/campaigns/${b.dataset.pauseCmp}/pause`, 'Campaign dijeda.'))
  )
  body.querySelectorAll('[data-end]').forEach((b) =>
    b.addEventListener('click', () =>
      confirmAction({
        title: 'Akhiri Campaign',
        consequence:
          'Campaign berhenti permanen dan tidak dapat dijalankan lagi. Lead yang sudah masuk tetap tersimpan beserta atribusinya.',
        confirmLabel: 'Akhiri Campaign',
        danger: true,
        async onConfirm() {
          await api.post(`/campaigns/${b.dataset.end}/end`, {})
          toast('Campaign diakhiri.')
          reload()
        }
      })
    )
  )
}

/* ------------------------------ Campaign form ----------------------------- */

export function openCampaignForm(prefill, onDone) {
  openModal({
    title: 'Buat Campaign',
    body: `<div id="cf-host">${loadingState('Memuat offer yang dapat dipasarkan…')}</div>`,
    async onMount(root, close) {
      const host = root.querySelector('#cf-host')

      // A campaign requires a published offer (domain rule enforced server-side);
      // the UI surfaces only eligible offers so the user is not led into an error.
      let offers = []
      try {
        offers = (await api.get('/offers', { limit: 100 })).data || []
      } catch (err) {
        host.innerHTML = errorState(err)
        return
      }
      const eligible = offers.filter((o) => ['ACTIVE', 'READY'].includes(o.status))

      if (eligible.length === 0) {
        host.innerHTML = emptyState({
          icon: 'fa-tag',
          title: 'Belum ada offer siap dipasarkan',
          message:
            'Campaign membutuhkan offer berstatus READY atau ACTIVE. Tandai offer siap lalu publikasikan terlebih dahulu.',
          action: { action: 'goto-offers', label: 'Buka Offer', icon: 'fa-tag' }
        })
        host.querySelector('[data-action="goto-offers"]')?.addEventListener('click', () => {
          close()
          location.hash = '#/offers'
        })
        return
      }

      host.innerHTML = `
        <form id="cmp-form" novalidate>
          <div id="cmp-error"></div>
          <div class="inline-info">Campaign hanya boleh dijalankan pada offer yang sudah dipublikasikan, sehingga setiap lead punya sumber yang dapat diukur.</div>
          <div class="form-grid">
            ${field({
              name: 'offer_id',
              label: 'Offer',
              type: 'select',
              required: true,
              value: prefill?.offer_id || eligible[0]?.id,
              full: true,
              options: eligible.map((o) => ({ value: o.id, label: `${truncate(o.title, 52)} — ${humanEnum(o.status)}` }))
            })}
            ${field({
              name: 'name',
              label: 'Nama campaign',
              required: true,
              full: true,
              placeholder: 'Contoh: WhatsApp Outreach — UMKM Kuliner Kota Lama'
            })}
            ${field({ name: 'channel', label: 'Kanal', type: 'select', value: 'WHATSAPP', options: CHANNELS })}
            ${field({ name: 'budget', label: 'Budget (opsional)', type: 'number', min: 0, placeholder: '500000' })}
            ${field({ name: 'start_at', label: 'Mulai', type: 'date', value: todayInput() })}
            ${field({ name: 'end_at', label: 'Berakhir', type: 'date', value: todayInput(30) })}
            ${field({
              name: 'objective',
              label: 'Tujuan campaign',
              type: 'textarea',
              rows: 2,
              full: true,
              placeholder: 'Contoh: Menghasilkan 10 lead terkualifikasi dari usaha kuliner'
            })}
          </div>
        </form>`

      const foot = document.createElement('div')
      foot.className = 'modal-foot'
      foot.innerHTML = `
        <button class="btn" data-modal-close>Batal</button>
        <button class="btn primary" id="cmp-save"><i class="fa-solid fa-floppy-disk"></i>Buat Campaign</button>`
      root.appendChild(foot)

      const form = host.querySelector('#cmp-form')
      const errBox = host.querySelector('#cmp-error')
      const btn = foot.querySelector('#cmp-save')
      btn.addEventListener('click', async () => {
        errBox.innerHTML = ''
        btn.disabled = true
        btn.innerHTML = '<i class="fa-solid fa-spinner fa-spin"></i> Menyimpan…'
        try {
          await api.post('/campaigns', readForm(form))
          toast('Campaign dibuat.', 'ok')
          close()
          onDone()
        } catch (err) {
          btn.disabled = false
          btn.innerHTML = '<i class="fa-solid fa-floppy-disk"></i>Buat Campaign'
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
