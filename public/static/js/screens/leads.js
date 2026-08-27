/**
 * Leads — pipeline board + lead detail (operational memory & next action).
 * Traceability: PS-MASTER-001 §10, §11, §13, §24, §29 | PS-UX-010 §19–§22
 *
 * §24: the next action must ALWAYS be obvious. The lead detail therefore leads
 * with a next-action strip driven by the server's `next_action` contract.
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
  fmtDateTime,
  humanEnum,
  loadingState,
  meter,
  money,
  moneyShort,
  num,
  openModal,
  readForm,
  relTime,
  scorePill,
  toLocalInput,
  toast,
  truncate
} from '../core/dom.js'
import { replaceQuery } from '../core/router.js'
import { screenEl, setHeader } from '../core/shell.js'

/** Board columns per §24. RESPONDED/INTERESTED/VISITED fold into their stage. */
const COLUMNS = [
  { key: 'NEW', label: 'Baru', icon: 'fa-inbox', merge: [] },
  { key: 'CONTACTED', label: 'Dihubungi', icon: 'fa-comment-dots', merge: ['RESPONDED'] },
  { key: 'QUALIFIED', label: 'Terkualifikasi', icon: 'fa-clipboard-check', merge: ['INTERESTED'] },
  { key: 'VISIT_SCHEDULED', label: 'Kunjungan', icon: 'fa-calendar-check', merge: ['VISITED'] },
  { key: 'NEGOTIATION', label: 'Negosiasi', icon: 'fa-handshake', merge: [] },
  { key: 'WON', label: 'Menjadi Rental', icon: 'fa-trophy', merge: [] },
  { key: 'LOST', label: 'Hilang', icon: 'fa-circle-xmark', merge: [] }
]

const LEAD_SOURCES = ['INBOUND', 'OUTBOUND', 'REFERRAL', 'ORGANIC', 'CAMPAIGN', 'OTHER']
const TEMPERATURES = ['HOT', 'WARM', 'COOL', 'LOW']
const TIMELINES = ['IMMEDIATE', 'WITHIN_30_DAYS', 'WITHIN_90_DAYS', 'LATER', 'UNKNOWN']
const ACTIVITY_TYPES = ['CALL', 'MESSAGE', 'EMAIL', 'NOTE', 'VISIT', 'NEGOTIATION', 'OTHER']
const FOLLOW_UP_ACTIONS = ['CALL', 'MESSAGE', 'EMAIL', 'VISIT_REMINDER', 'SEND_DETAILS', 'OTHER']

/* ========================================================================== *
 * PIPELINE (KANBAN)
 * ========================================================================== */

export async function leadPipelineScreen({ query }) {
  const el = screenEl()
  const filters = {
    property_id: query.property_id || '',
    temperature: query.temperature || '',
    status: query.status || '',
    mine: query.mine === 'true'
  }

  setHeader({
    title: 'Pipeline Leads',
    subtitle: 'Setiap lead punya tahap, skor, dan tindakan berikutnya yang jelas',
    actions: `
      <button class="btn" data-action="toggle-mine"><i class="fa-solid fa-user-check"></i>${filters.mine ? 'Semua lead' : 'Lead saya'}</button>
      <button class="btn" data-action="refresh"><i class="fa-solid fa-rotate-right"></i></button>
      ${session.can('lead.create') ? `<button class="btn primary" data-action="new"><i class="fa-solid fa-plus"></i>Buat Lead</button>` : ''}`,
    mobilePrimary: session.can('lead.create') ? { action: 'new', label: 'Lead', icon: 'fa-plus' } : null
  })

  el.innerHTML = loadingState('Memuat pipeline…')

  async function load() {
    el.innerHTML = loadingState('Memuat pipeline…')
    try {
      const res = await api.get('/leads/pipeline', {
        property_id: filters.property_id,
        assigned_to: filters.mine ? session.user?.id : '',
        limit: 50
      })
      render(res.data || [], res.meta || {})
    } catch (err) {
      el.innerHTML = errorState(err)
      el.querySelector('[data-action="retry"]')?.addEventListener('click', load)
    }
  }

  function render(stages, meta) {
    const byStage = Object.fromEntries(stages.map((s) => [s.stage, s]))

    // Fold merged statuses into their board column (§24).
    const cols = COLUMNS.map((c) => {
      const own = byStage[c.key]
      let leads = own?.leads ? [...own.leads] : []
      let count = own?.count || 0
      for (const m of c.merge) {
        const extra = byStage[m]
        if (extra) {
          leads = leads.concat(extra.leads || [])
          count += extra.count || 0
        }
      }
      if (filters.temperature) leads = leads.filter((l) => l.temperature === filters.temperature)
      leads.sort((a, b) => (b.score || 0) - (a.score || 0))
      return { ...c, leads, count: filters.temperature ? leads.length : count }
    })

    const totalShown = cols.reduce((s, c) => s + c.leads.length, 0)

    if (totalShown === 0 && !filters.temperature && !filters.property_id) {
      el.innerHTML = `<div class="card">${emptyState({
        icon: 'fa-filter-circle-dollar',
        title: 'Belum ada lead',
        message: 'Lead adalah peluang komersial yang menghubungkan properti dengan calon penyewa. Buat lead dari properti yang dipasarkan atau dari hasil pencocokan penyewa.',
        action: session.can('lead.create') ? { action: 'new', label: 'Buat Lead', icon: 'fa-plus' } : undefined
      })}</div>`
      el.querySelector('[data-action="new"]')?.addEventListener('click', () => openLeadForm({}, load))
      return
    }

    el.innerHTML = `
      <section class="stack">
        <div class="card">
          <div class="card-body tight">
            <div class="row between" style="flex-wrap:wrap;gap:10px">
              <div class="chips">
                <span class="chip selectable ${!filters.temperature ? 'on' : ''}" data-temp="">Semua suhu</span>
                ${TEMPERATURES.map((t) => `<span class="chip selectable ${filters.temperature === t ? 'on' : ''}" data-temp="${t}">${esc(humanEnum(t))}</span>`).join('')}
              </div>
              <span class="tiny dim">${num(meta.total || totalShown)} lead dalam pipeline${filters.mine ? ' · hanya lead saya' : ''}</span>
            </div>
            ${filters.property_id ? `<div class="inline-info" style="margin-top:10px">Difilter untuk satu properti. <a href="#/leads">Tampilkan semua</a></div>` : ''}
          </div>
        </div>
        <div class="kanban">
          ${cols.map(renderColumn).join('')}
        </div>
      </section>`

    el.querySelectorAll('[data-lead-card]').forEach((c) =>
      c.addEventListener('click', () => {
        location.hash = `#/leads/${c.dataset.leadCard}`
      })
    )
    el.querySelectorAll('[data-temp]').forEach((c) =>
      c.addEventListener('click', () => {
        filters.temperature = c.dataset.temp
        replaceQuery({ ...query, temperature: filters.temperature, mine: filters.mine ? 'true' : '' })
        render(stages, meta)
      })
    )
  }

  function renderColumn(c) {
    return `<div class="kanban-col">
      <div class="kanban-col-head">
        <i class="fa-solid ${c.icon} dim"></i>
        <span class="strong">${esc(c.label)}</span>
        <span class="badge" style="margin-left:auto">${num(c.count)}</span>
      </div>
      <div class="kanban-col-body">
        ${
          c.leads.length === 0
            ? `<div class="tiny dim center" style="padding:16px 8px">Tidak ada lead di tahap ini</div>`
            : c.leads.map(leadCard).join('')
        }
      </div>
    </div>`
  }

  function leadCard(l) {
    const overdue = l.next_follow_up_at && new Date(String(l.next_follow_up_at).replace(' ', 'T') + 'Z') < new Date()
    return `<div class="lead-card" data-lead-card="${attr(l.id)}">
      <div class="row between">
        <span class="strong">${esc(truncate(l.tenant_name, 26))}</span>
        ${scorePill(l.score)}
      </div>
      <div class="tiny dim">${esc(truncate(l.property_name, 34))}</div>
      <div class="row tight" style="margin-top:6px;flex-wrap:wrap">
        ${badge(l.temperature)}
        <span class="chip">${esc(humanEnum(l.business_category))}</span>
      </div>
      <div class="row between tiny dim" style="margin-top:6px">
        <span><i class="fa-solid fa-tag"></i> ${esc(humanEnum(l.source))}</span>
        ${
          l.next_follow_up_at
            ? `<span class="${overdue ? 'strong' : ''}" style="${overdue ? 'color:var(--danger)' : ''}">
                <i class="fa-solid fa-clock"></i> ${esc(relTime(l.next_follow_up_at))}</span>`
            : `<span>${esc(relTime(l.created_at))}</span>`
        }
      </div>
    </div>`
  }

  const bindHeader = () => {
    const host = document.getElementById('page-actions')
    host?.querySelector('[data-action="refresh"]')?.addEventListener('click', load)
    host?.querySelector('[data-action="new"]')?.addEventListener('click', () => openLeadForm({}, load))
    host?.querySelector('[data-action="toggle-mine"]')?.addEventListener('click', () => {
      filters.mine = !filters.mine
      replaceQuery({ ...query, mine: filters.mine ? 'true' : '' })
      setHeader({
        title: 'Pipeline Leads',
        subtitle: 'Setiap lead punya tahap, skor, dan tindakan berikutnya yang jelas',
        actions: `
          <button class="btn" data-action="toggle-mine"><i class="fa-solid fa-user-check"></i>${filters.mine ? 'Semua lead' : 'Lead saya'}</button>
          <button class="btn" data-action="refresh"><i class="fa-solid fa-rotate-right"></i></button>
          ${session.can('lead.create') ? `<button class="btn primary" data-action="new"><i class="fa-solid fa-plus"></i>Buat Lead</button>` : ''}`
      })
      bindHeader()
      load()
    })
    document.querySelector('.mobile-primary[data-action="new"]')?.addEventListener('click', () => openLeadForm({}, load))
  }
  bindHeader()

  await load()
}

/* ========================================================================== *
 * CREATE LEAD  (tenant + property are mandatory context — §10)
 * ========================================================================== */

export function openLeadForm(prefill = {}, onDone) {
  openModal({
    title: 'Buat Lead',
    wide: true,
    body: `
      <form id="ld-form" novalidate>
        <div id="ld-error"></div>
        <div class="inline-info">Lead menghubungkan <strong>properti</strong> dengan <strong>calon penyewa</strong>. Keduanya wajib agar sistem dapat menghitung kecocokan dan skor.</div>
        <div class="form-grid">
          <div class="field full">
            <label for="f_property_id" class="req">Properti</label>
            <select id="f_property_id" name="property_id" required><option value="">Memuat properti…</option></select>
            <div class="hint">Hanya properti yang dapat dipasarkan yang relevan untuk lead baru.</div>
          </div>
          <div class="field full">
            <label for="f_tenant_id" class="req">Calon penyewa</label>
            <select id="f_tenant_id" name="tenant_id" required><option value="">Memuat calon penyewa…</option></select>
          </div>
          ${field({ name: 'source', label: 'Sumber lead', type: 'select', value: prefill.source || 'INBOUND', options: LEAD_SOURCES })}
        </div>
      </form>`,
    footer: `
      <button class="btn" data-modal-close>Batal</button>
      <button class="btn primary" id="ld-save"><i class="fa-solid fa-user-plus"></i>Buat Lead</button>`,
    async onMount(root, close) {
      const form = root.querySelector('#ld-form')
      const errBox = root.querySelector('#ld-error')
      const btn = root.querySelector('#ld-save')
      const propSel = root.querySelector('#f_property_id')
      const tenSel = root.querySelector('#f_tenant_id')

      // Load selectable domain objects (§28 forms need real domain context).
      try {
        const [props, tenants] = await Promise.all([
          api.get('/properties', { limit: 100, sort: 'name:asc' }),
          api.get('/tenants', { limit: 100, sort: 'name:asc' })
        ])
        propSel.innerHTML =
          `<option value="">— pilih properti —</option>` +
          (props.data || [])
            .map(
              (p) =>
                `<option value="${attr(p.id)}" ${prefill.property_id === p.id ? 'selected' : ''}>${esc(p.name)} · ${moneyShort(p.price)} · ${esc(humanEnum(p.availability_status))}</option>`
            )
            .join('')
        tenSel.innerHTML =
          `<option value="">— pilih calon penyewa —</option>` +
          (tenants.data || [])
            .map(
              (t) =>
                `<option value="${attr(t.id)}" ${prefill.tenant_id === t.id ? 'selected' : ''}>${esc(t.name)} · ${esc(humanEnum(t.business_category))}</option>`
            )
            .join('')
      } catch (err) {
        errBox.innerHTML = `<div class="inline-error">${esc(errorText(err))}</div>`
      }

      btn.addEventListener('click', async () => {
        errBox.innerHTML = ''
        const body = readForm(form)
        if (!body.property_id || !body.tenant_id) {
          errBox.innerHTML = '<div class="inline-error">Properti dan calon penyewa wajib dipilih.</div>'
          return
        }
        btn.disabled = true
        btn.innerHTML = '<i class="fa-solid fa-spinner fa-spin"></i> Membuat…'
        try {
          const res = await api.post('/leads', body)
          close()
          toast('Lead dibuat. Langkah berikutnya: hubungi calon penyewa.', 'ok')
          if (onDone) onDone(res.data)
          else location.hash = `#/leads/${res.data.id}`
        } catch (err) {
          btn.disabled = false
          btn.innerHTML = '<i class="fa-solid fa-user-plus"></i>Buat Lead'
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
 * LEAD DETAIL
 * ========================================================================== */

export async function leadDetailScreen({ params, query }) {
  const el = screenEl()
  const id = params.id
  setHeader({ title: 'Lead', subtitle: '' })
  el.innerHTML = loadingState('Memuat lead…')

  let l
  try {
    const res = await api.get(`/leads/${id}`)
    l = res.data
  } catch (err) {
    el.innerHTML = errorState(err)
    el.querySelector('[data-action="retry"]')?.addEventListener('click', () => leadDetailScreen({ params, query }))
    el.querySelector('[data-action="back"]')?.addEventListener('click', () => {
      location.hash = '#/leads'
    })
    return
  }

  const reload = () => leadDetailScreen({ params, query })

  setHeader({
    title: l.tenant_name,
    subtitle: `${esc(l.property_name)} · ${esc(humanEnum(l.status))} · sumber ${esc(humanEnum(l.source))}`,
    actions: renderLeadActions(l)
  })

  el.innerHTML = `
    <section class="stack">
      <a class="tiny" href="#/leads"><i class="fa-solid fa-arrow-left"></i> Pipeline leads</a>
      ${renderNextAction(l)}
      ${renderLeadKpis(l)}
      <div class="split">
        <div class="stack">
          ${renderQualification(l)}
          ${renderTimeline(l)}
        </div>
        <div class="stack">
          ${renderScoreCard(l)}
          ${renderContext(l)}
          ${renderOpsPanels(l)}
        </div>
      </div>
    </section>`

  bindLeadActions(l, reload)
}

/** Contextual actions driven by lead status (§24, §29). */
function renderLeadActions(l) {
  const a = []
  const closed = ['WON', 'LOST'].includes(l.status)

  if (!closed && session.can('lead.update')) {
    a.push(`<button class="btn" data-action="contact"><i class="fa-solid fa-comment-dots"></i>Catat Kontak</button>`)
  }
  if (!closed && !l.qualification && session.can('lead.qualify')) {
    a.push(`<button class="btn primary" data-action="qualify"><i class="fa-solid fa-clipboard-check"></i>Kualifikasi</button>`)
  }
  if (!closed && l.qualification && session.can('visit.create') && !(l.visits || []).some((v) => ['SCHEDULED', 'CONFIRMED'].includes(v.status))) {
    a.push(`<button class="btn primary" data-action="schedule-visit"><i class="fa-solid fa-calendar-plus"></i>Jadwalkan Kunjungan</button>`)
  }
  if (!closed && session.can('followup.create')) {
    a.push(`<button class="btn" data-action="follow-up"><i class="fa-solid fa-list-check"></i>Follow-Up</button>`)
  }
  if (!closed && session.can('negotiation.create') && !(l.negotiations || []).some((n) => ['OPEN', 'COUNTER_OFFER'].includes(n.status))) {
    a.push(`<button class="btn" data-action="negotiate"><i class="fa-solid fa-handshake"></i>Negosiasi</button>`)
  }
  if (!closed && session.can('lead.assign')) {
    a.push(`<button class="btn" data-action="assign" title="Alihkan pemilik lead"><i class="fa-solid fa-user-gear"></i></button>`)
  }
  if (!closed && session.can('lead.update')) {
    a.push(`<button class="btn danger" data-action="lose"><i class="fa-solid fa-circle-xmark"></i>Tandai Hilang</button>`)
  }
  return a.join('')
}

/** The server tells us the domain-correct next step; we render it prominently. */
function renderNextAction(l) {
  const na = l.next_action
  if (!na) return ''

  const MAP = {
    CONTACT_LEAD: { icon: 'fa-comment-dots', action: 'contact', label: 'Catat kontak sekarang' },
    QUALIFY_LEAD: { icon: 'fa-clipboard-check', action: 'qualify', label: 'Kualifikasi lead' },
    SCHEDULE_VISIT: { icon: 'fa-calendar-plus', action: 'schedule-visit', label: 'Jadwalkan kunjungan' },
    COMPLETE_VISIT: { icon: 'fa-calendar-check', action: 'complete-visit', label: 'Catat hasil kunjungan' },
    START_NEGOTIATION: { icon: 'fa-handshake', action: 'negotiate', label: 'Buka negosiasi' },
    RESPOND_NEGOTIATION: { icon: 'fa-handshake', action: 'goto-negotiation', label: 'Tanggapi negosiasi' },
    ACTIVATE_RENTAL: { icon: 'fa-file-signature', action: 'goto-rental', label: 'Buat & aktifkan rental' },
    FOLLOW_UP: { icon: 'fa-list-check', action: 'follow-up', label: 'Buat follow-up' }
  }
  const m = MAP[na.action] || { icon: 'fa-arrow-right', action: '', label: na.label }
  const closed = ['WON', 'LOST'].includes(l.status)

  return `<div class="next-action">
    <div class="na-icon"><i class="fa-solid ${closed ? (l.status === 'WON' ? 'fa-trophy' : 'fa-circle-xmark') : m.icon}"></i></div>
    <div class="na-body">
      <div class="na-label">${closed ? 'Status akhir' : 'Tindakan berikutnya'}</div>
      <div class="na-text">${esc(na.label)}</div>
      <div class="na-why">${esc(na.reason || '')}</div>
    </div>
    ${!closed && m.action ? `<button class="btn primary" data-action="${attr(m.action)}"><i class="fa-solid ${m.icon}"></i>${esc(m.label)}</button>` : ''}
  </div>`
}

function renderLeadKpis(l) {
  return `<div class="grid cols-4">
    <div class="kpi">
      <div class="k-label">Skor lead</div>
      <div class="k-value">${num(l.score)}</div>
      <div class="k-sub">${badge(l.temperature)}</div>
    </div>
    <div class="kpi">
      <div class="k-label">Tahap</div>
      <div class="k-value" style="font-size:17px">${esc(humanEnum(l.status))}</div>
      <div class="k-sub">${l.assigned_to_name ? `Pemilik: ${esc(l.assigned_to_name)}` : 'Belum ditugaskan'}</div>
    </div>
    <div class="kpi">
      <div class="k-label">Kualifikasi</div>
      <div class="k-value" style="font-size:17px">${l.qualification ? esc(humanEnum(l.qualification.qualification_result)) : 'Belum'}</div>
      <div class="k-sub">${l.qualification ? `Fit ${l.qualification.fit_score}%` : 'Kualifikasi menentukan kelayakan lanjut'}</div>
    </div>
    <div class="kpi">
      <div class="k-label">Kontak terakhir</div>
      <div class="k-value" style="font-size:17px">${l.last_contact_at ? esc(relTime(l.last_contact_at)) : '—'}</div>
      <div class="k-sub">${l.next_follow_up_at ? `Follow-up ${esc(relTime(l.next_follow_up_at))}` : 'Tidak ada follow-up terjadwal'}</div>
    </div>
  </div>`
}

function renderScoreCard(l) {
  const sb = l.score_breakdown
  return `<div class="card">
    <div class="card-head"><h2>Mengapa Skor Ini?</h2>${scorePill(sb?.score ?? l.score)}</div>
    <div class="card-body">
      ${meter(sb?.score ?? l.score)}
      <div style="margin-top:10px">
        ${
          (sb?.reasons || []).length
            ? sb.reasons.map((r) => `<div class="reason pro"><i class="fa-solid fa-check"></i><span>${esc(r)}</span></div>`).join('')
            : '<div class="dim small">Skor belum memiliki komponen penjelas.</div>'
        }
      </div>
      <div class="tiny dim" style="margin-top:10px">Skor dihitung dari kecocokan properti, kualifikasi, tahap pipeline, respons penyewa, dan hasil kunjungan. Bukan angka manual.</div>
    </div>
  </div>`
}

function renderQualification(l) {
  const q = l.qualification
  if (!q) {
    return `<div class="card">
      <div class="card-head"><h2>Kualifikasi Lead</h2></div>
      ${emptyState({
        icon: 'fa-clipboard-question',
        title: 'Lead belum dikualifikasi',
        message: 'Kualifikasi mengevaluasi anggaran, timeline, kebutuhan ruang, jenis usaha, kecocokan properti, dan kesiapan — hasilnya wajib dapat dijelaskan.',
        action: session.can('lead.qualify') ? { action: 'qualify', label: 'Kualifikasi Lead', icon: 'fa-clipboard-check' } : undefined
      })}
    </div>`
  }
  return `<div class="card">
    <div class="card-head">
      <h2>Hasil Kualifikasi</h2>
      ${badge(q.qualification_result)}
      <div class="actions">
        <span class="tiny dim">oleh ${esc(q.qualified_by_name || '—')} · ${fmtDate(q.qualified_at)}</span>
        ${session.can('lead.qualify') ? `<button class="btn sm" data-action="qualify"><i class="fa-solid fa-rotate"></i>Ulangi</button>` : ''}
      </div>
    </div>
    <div class="card-body">
      <div class="grid cols-2">
        <dl class="kv">
          <dt>Jenis usaha</dt><dd>${esc(humanEnum(q.business_type))}</dd>
          <dt>Anggaran</dt><dd>${money(q.budget)}</dd>
          <dt>Timeline</dt><dd>${esc(humanEnum(q.timeline))}</dd>
          <dt>Kebutuhan ruang</dt><dd>${q.space_need ? `${num(q.space_need)} m²` : '—'}</dd>
          <dt>Kepentingan lokasi</dt><dd>${esc(humanEnum(q.location_need))}</dd>
          <dt>Otoritas keputusan</dt><dd>${esc(humanEnum(q.decision_status))}</dd>
        </dl>
        <div>
          <div class="row between" style="margin-bottom:6px">
            <span class="strong">Kecocokan properti</span>${scorePill(q.fit_score, '%')}
          </div>
          ${meter(q.fit_score)}
          <div style="margin-top:9px">
            ${(q.reasoning || []).map((r) => `<div class="reason pro"><i class="fa-solid fa-check"></i><span>${esc(r)}</span></div>`).join('') || '<div class="dim tiny">—</div>'}
          </div>
        </div>
      </div>
      ${q.intended_use ? `<div style="margin-top:12px"><div class="tiny dim">Rencana penggunaan</div><div class="small">${esc(q.intended_use)}</div></div>` : ''}
      ${q.notes ? `<div style="margin-top:10px"><div class="tiny dim">Catatan</div><div class="small">${esc(q.notes)}</div></div>` : ''}
    </div>
  </div>`
}

/** §13 — the timeline is operational memory. */
function renderTimeline(l) {
  const items = l.timeline || []
  return `<div class="card">
    <div class="card-head">
      <h2>Riwayat Aktivitas</h2><span class="badge">${num(items.length)}</span>
      <div class="actions">${session.can('activity.create') ? `<button class="btn sm" data-action="add-activity"><i class="fa-solid fa-plus"></i>Catat aktivitas</button>` : ''}</div>
    </div>
    ${
      items.length === 0
        ? emptyState({
            icon: 'fa-clock-rotate-left',
            title: 'Belum ada aktivitas',
            message: 'Setiap kontak, kunjungan, dan perubahan status akan tercatat di sini sebagai memori operasional.',
            action: session.can('lead.update') ? { action: 'contact', label: 'Catat Kontak Pertama', icon: 'fa-comment-dots' } : undefined
          })
        : `<div class="card-body"><div class="timeline">
            ${items
              .map(
                (a) => `<div class="tl-item">
                  <div class="tl-when">${esc(fmtDateTime(a.occurred_at))} · ${esc(a.user_name || 'Sistem')}</div>
                  <div class="tl-what">${esc(a.subject)}</div>
                  <div class="tl-desc">${badge(a.activity_type, { label: humanEnum(a.activity_type) })}</div>
                  ${a.description ? `<div class="tl-desc">${esc(a.description)}</div>` : ''}
                </div>`
              )
              .join('')}
          </div></div>`
    }
  </div>`
}

function renderContext(l) {
  return `<div class="card">
    <div class="card-head"><h2>Konteks Komersial</h2></div>
    <div class="card-body">
      <dl class="kv">
        <dt>Properti</dt><dd><a href="#/properties/${esc(l.property_id)}">${esc(l.property_name)}</a></dd>
        <dt>Alamat</dt><dd class="small">${esc(l.property_address)}</dd>
        <dt>Harga minta</dt><dd>${money(l.property_price)}</dd>
        <dt>Luas properti</dt><dd>${l.property_area_size ? `${num(l.property_area_size)} m²` : '—'}</dd>
        <dt>Ketersediaan</dt><dd>${badge(l.property_availability)}</dd>
        <dt>Penyewa</dt><dd><a href="#/tenants/${esc(l.tenant_id)}">${esc(l.tenant_name)}</a></dd>
        <dt>Telepon</dt><dd>${l.tenant_phone ? `<a href="tel:${attr(l.tenant_phone)}">${esc(l.tenant_phone)}</a>` : '—'}</dd>
        <dt>Anggaran penyewa</dt><dd>${l.budget_min || l.budget_max ? `${moneyShort(l.budget_min)} – ${moneyShort(l.budget_max)}` : '—'}</dd>
        <dt>Kebutuhan ruang</dt><dd>${l.space_need ? `${num(l.space_need)} m²` : '—'}</dd>
        ${l.offer_title ? `<dt>Offer</dt><dd class="small">${esc(l.offer_title)}</dd>` : ''}
        ${l.campaign_name ? `<dt>Campaign</dt><dd class="small">${esc(l.campaign_name)}</dd>` : ''}
      </dl>
      ${l.lost_reason ? `<div class="inline-warn" style="margin-top:12px">Alasan hilang: ${esc(l.lost_reason)}</div>` : ''}
    </div>
  </div>`
}

function renderOpsPanels(l) {
  const fups = l.follow_ups || []
  const visits = l.visits || []
  const negs = l.negotiations || []

  return `<div class="card">
    <div class="card-head"><h2>Operasional Lead</h2></div>

    <div class="sub-head">Follow-Up <span class="count">${num(fups.length)}</span>
      ${session.can('followup.create') ? `<button class="btn sm" data-action="follow-up" style="margin-left:auto"><i class="fa-solid fa-plus"></i></button>` : ''}</div>
    ${
      fups.length === 0
        ? `<div class="list-item"><div class="li-main"><div class="li-sub">Belum ada follow-up terjadwal.</div></div></div>`
        : fups
            .map(
              (f) => `<div class="list-item">
                <span class="li-icon ${f.status === 'COMPLETED' ? 'ok' : f.status === 'CANCELLED' ? '' : 'warn'}"><i class="fa-solid fa-list-check"></i></span>
                <div class="li-main">
                  <div class="li-title">${esc(humanEnum(f.action_type))} · ${esc(fmtDateTime(f.due_at))}</div>
                  <div class="li-sub">${esc(f.notes || f.outcome || '—')}</div>
                </div>
                <div class="li-side">
                  ${badge(f.status)}
                  ${
                    f.status === 'PENDING' && session.can('followup.update')
                      ? `<button class="btn sm" data-complete-fup="${attr(f.id)}"><i class="fa-solid fa-check"></i>Selesai</button>`
                      : ''
                  }
                </div>
              </div>`
            )
            .join('')
    }

    <div class="sub-head">Kunjungan <span class="count">${num(visits.length)}</span></div>
    ${
      visits.length === 0
        ? `<div class="list-item"><div class="li-main"><div class="li-sub">Belum ada kunjungan.</div></div></div>`
        : visits
            .map(
              (v) => `<div class="list-item">
                <span class="li-icon ${v.status === 'COMPLETED' ? 'ok' : ['CANCELLED', 'NO_SHOW'].includes(v.status) ? 'danger' : 'brand'}">
                  <i class="fa-solid fa-calendar-day"></i></span>
                <div class="li-main">
                  <div class="li-title">${esc(fmtDateTime(v.scheduled_at))}</div>
                  <div class="li-sub">${v.result ? `Hasil: ${esc(humanEnum(v.result))}` : 'Hasil belum dicatat'}${v.notes ? ` · ${esc(truncate(v.notes, 44))}` : ''}</div>
                </div>
                <div class="li-side">
                  ${badge(v.status)}
                  ${
                    ['SCHEDULED', 'CONFIRMED'].includes(v.status) && session.can('visit.complete')
                      ? `<button class="btn sm primary" data-complete-visit="${attr(v.id)}"><i class="fa-solid fa-check"></i>Catat hasil</button>`
                      : ''
                  }
                </div>
              </div>`
            )
            .join('')
    }

    <div class="sub-head">Negosiasi <span class="count">${num(negs.length)}</span></div>
    ${
      negs.length === 0
        ? `<div class="list-item"><div class="li-main"><div class="li-sub">Belum ada negosiasi.</div></div></div>`
        : negs
            .map(
              (n) => `<div class="list-item clickable" data-goto-neg="${attr(n.id)}">
                <span class="li-icon ${n.status === 'AGREED' ? 'ok' : n.status === 'FAILED' ? 'danger' : 'warn'}"><i class="fa-solid fa-handshake"></i></span>
                <div class="li-main">
                  <div class="li-title">${money(n.agreed_price || n.proposed_price)} ${n.agreed_price ? '(disetujui)' : '(usulan penyewa)'}</div>
                  <div class="li-sub">Harga awal ${money(n.current_price)} · mulai ${fmtDate(n.started_at)}</div>
                </div>
                <div class="li-side">${badge(n.status)}</div>
              </div>`
            )
            .join('')
    }

    ${
      l.rental
        ? `<div class="sub-head">Rental</div>
           <div class="list-item clickable" data-goto-rental="1">
             <span class="li-icon ${l.rental.status === 'ACTIVE' ? 'ok' : 'brand'}"><i class="fa-solid fa-file-signature"></i></span>
             <div class="li-main">
               <div class="li-title">${money(l.rental.price)} · ${fmtDate(l.rental.start_date)} → ${fmtDate(l.rental.end_date)}</div>
               <div class="li-sub">${l.rental.activated_at ? `Diaktifkan ${fmtDate(l.rental.activated_at)}` : 'Belum diaktifkan'}</div>
             </div>
             <div class="li-side">${badge(l.rental.status)}</div>
           </div>`
        : ''
    }
  </div>`
}

/* ------------------------------ Action binding ---------------------------- */

function bindLeadActions(l, reload) {
  const hosts = [document.getElementById('page-actions'), screenEl()].filter(Boolean)

  const on = (sel, fn) =>
    hosts.forEach((h) => h.querySelectorAll(sel).forEach((n) => n.addEventListener('click', fn)))

  on('[data-action="contact"]', () => openContactForm(l, reload))
  on('[data-action="qualify"]', () => openQualifyForm(l, reload))
  on('[data-action="add-activity"]', () => openActivityForm(l, reload))
  on('[data-action="follow-up"]', () => openFollowUpForm(l, reload))
  on('[data-action="schedule-visit"]', () => openVisitForm(l, reload))
  on('[data-action="negotiate"]', () => openNegotiationForm(l, reload))
  on('[data-action="assign"]', () => openAssignForm(l, reload))
  on('[data-action="lose"]', () => openLoseForm(l, reload))
  on('[data-action="goto-negotiation"]', () => {
    location.hash = '#/negotiations'
  })
  on('[data-action="goto-rental"]', () => {
    location.hash = `#/rentals?lead_id=${l.id}`
  })
  on('[data-action="complete-visit"]', () => {
    const v = (l.visits || []).find((x) => ['SCHEDULED', 'CONFIRMED'].includes(x.status))
    if (v) openVisitResultForm(v, reload)
    else toast('Tidak ada kunjungan yang menunggu hasil.', 'err')
  })

  screenEl()
    .querySelectorAll('[data-complete-fup]')
    .forEach((b) =>
      b.addEventListener('click', (e) => {
        e.stopPropagation()
        openCompleteFollowUp(b.dataset.completeFup, reload)
      })
    )
  screenEl()
    .querySelectorAll('[data-complete-visit]')
    .forEach((b) =>
      b.addEventListener('click', (e) => {
        e.stopPropagation()
        openVisitResultForm({ id: b.dataset.completeVisit }, reload)
      })
    )
  screenEl()
    .querySelectorAll('[data-goto-neg]')
    .forEach((n) =>
      n.addEventListener('click', () => {
        location.hash = `#/negotiations?highlight=${n.dataset.gotoNeg}`
      })
    )
  screenEl()
    .querySelector('[data-goto-rental]')
    ?.addEventListener('click', () => {
      location.hash = '#/rentals'
    })
}

/* --------------------------------- Forms ---------------------------------- */

/** Small helper: modal form with submit + validation plumbing. */
function formModal({ title, wide, bodyHtml, submitLabel, submitIcon = 'fa-check', danger, onSubmit, onMount }) {
  openModal({
    title,
    wide,
    body: `<form id="mf-form" novalidate><div id="mf-error"></div>${bodyHtml}</form>`,
    footer: `
      <button class="btn" data-modal-close>Batal</button>
      <button class="btn ${danger ? 'danger' : 'primary'}" id="mf-save"><i class="fa-solid ${submitIcon}"></i>${esc(submitLabel)}</button>`,
    onMount(root, close) {
      const form = root.querySelector('#mf-form')
      const errBox = root.querySelector('#mf-error')
      const btn = root.querySelector('#mf-save')
      onMount?.(root, form)
      btn.addEventListener('click', async () => {
        errBox.innerHTML = ''
        btn.disabled = true
        btn.innerHTML = '<i class="fa-solid fa-spinner fa-spin"></i> Memproses…'
        try {
          await onSubmit(readForm(form), form)
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

function openContactForm(l, onDone) {
  formModal({
    title: `Catat Kontak — ${l.tenant_name}`,
    bodyHtml: `
      <div class="inline-info">Mencatat kontak memindahkan lead ke tahap CONTACTED dan menambah entri pada riwayat aktivitas.</div>
      <div class="form-grid">
        ${field({ name: 'channel', label: 'Kanal kontak', type: 'select', required: true, value: 'MESSAGE', options: ['CALL', 'MESSAGE', 'EMAIL', 'VISIT', 'OTHER'] })}
        ${field({ name: 'notes', label: 'Catatan percakapan', type: 'textarea', rows: 3, full: true, placeholder: 'Apa yang disampaikan dan bagaimana respons penyewa…' })}
      </div>`,
    submitLabel: 'Simpan Kontak',
    submitIcon: 'fa-comment-dots',
    async onSubmit(body) {
      await api.post(`/leads/${l.id}/contact`, body)
      toast('Kontak tercatat.', 'ok')
      onDone()
    }
  })
}

function openQualifyForm(l, onDone) {
  const q = l.qualification
  formModal({
    title: `Kualifikasi Lead — ${l.tenant_name}`,
    wide: true,
    bodyHtml: `
      <div class="inline-info">Kualifikasi menilai anggaran, timeline, kebutuhan ruang, jenis usaha, dan otoritas keputusan. Sistem menghitung kecocokan serta hasil kualifikasi beserta alasannya.</div>
      <div class="form-grid">
        ${field({ name: 'business_type', label: 'Jenis usaha', required: true, value: q?.business_type || l.business_category, full: true })}
        ${field({ name: 'budget', label: 'Anggaran nyata penyewa', type: 'number', required: true, value: q?.budget ?? l.budget_max ?? '', min: 0, step: 100000, hint: `Harga minta properti: ${money(l.property_price)}` })}
        ${field({ name: 'timeline', label: 'Timeline kebutuhan', type: 'select', required: true, value: q?.timeline || 'WITHIN_30_DAYS', options: TIMELINES })}
        ${field({ name: 'space_need', label: 'Kebutuhan ruang (m²)', type: 'number', value: q?.space_need ?? l.space_need ?? '', min: 0, hint: `Luas properti: ${l.property_area_size ? `${num(l.property_area_size)} m²` : '—'}` })}
        ${field({ name: 'location_need', label: 'Kepentingan lokasi', type: 'select', value: q?.location_need || 'MEDIUM', options: [{ value: 'HIGH', label: 'Tinggi' }, { value: 'MEDIUM', label: 'Sedang' }, { value: 'LOW', label: 'Rendah' }] })}
        ${field({ name: 'decision_status', label: 'Otoritas keputusan', type: 'select', value: q?.decision_status || 'UNKNOWN', options: [{ value: 'DECISION_MAKER', label: 'Pengambil keputusan' }, { value: 'INFLUENCER', label: 'Mempengaruhi' }, { value: 'UNKNOWN', label: 'Belum diketahui' }] })}
        ${field({ name: 'intended_use', label: 'Rencana penggunaan', value: q?.intended_use, full: true, placeholder: 'Contoh: warung makan pagi sampai sore' })}
        ${field({ name: 'notes', label: 'Catatan kualifikasi', type: 'textarea', rows: 2, value: q?.notes, full: true })}
      </div>`,
    submitLabel: 'Simpan Kualifikasi',
    submitIcon: 'fa-clipboard-check',
    async onSubmit(body) {
      const res = await api.post(`/leads/${l.id}/qualify`, body)
      const r = res.data?.qualification?.qualification_result || res.data?.qualification_result
      toast(`Kualifikasi selesai${r ? `: ${humanEnum(r)}` : ''}.`, 'ok')
      onDone()
    }
  })
}

function openActivityForm(l, onDone) {
  formModal({
    title: `Catat Aktivitas — ${l.tenant_name}`,
    bodyHtml: `
      <div class="form-grid">
        ${field({ name: 'activity_type', label: 'Jenis aktivitas', type: 'select', required: true, value: 'NOTE', options: ACTIVITY_TYPES })}
        ${field({ name: 'occurred_at', label: 'Waktu kejadian', type: 'datetime-local', value: toLocalInput(new Date()) })}
        ${field({ name: 'subject', label: 'Ringkasan', required: true, full: true, placeholder: 'Contoh: WhatsApp menanyakan harga akhir' })}
        ${field({ name: 'description', label: 'Detail', type: 'textarea', rows: 3, full: true })}
      </div>
      <div class="field">
        <label style="display:flex;align-items:center;gap:8px;font-weight:500">
          <input type="checkbox" name="tenant_responded" style="width:auto"> Penyewa merespons pada aktivitas ini
        </label>
        <div class="hint">Respons penyewa menaikkan skor lead.</div>
      </div>`,
    submitLabel: 'Simpan Aktivitas',
    submitIcon: 'fa-plus',
    async onSubmit(body) {
      await api.post(`/leads/${l.id}/activities`, body)
      toast('Aktivitas tercatat.', 'ok')
      onDone()
    }
  })
}

function openFollowUpForm(l, onDone) {
  formModal({
    title: `Buat Follow-Up — ${l.tenant_name}`,
    bodyHtml: `
      <div class="inline-info">Follow-up muncul di work queue dan dashboard sebagai item yang perlu tindakan.</div>
      <div class="form-grid">
        ${field({ name: 'action_type', label: 'Tindakan', type: 'select', required: true, value: 'CALL', options: FOLLOW_UP_ACTIONS })}
        ${field({ name: 'due_at', label: 'Jatuh tempo', type: 'datetime-local', required: true, value: toLocalInput(new Date(Date.now() + 86400000)) })}
        ${field({ name: 'notes', label: 'Catatan / tujuan', type: 'textarea', rows: 2, full: true, placeholder: 'Apa yang harus dilakukan dan dicapai…' })}
      </div>`,
    submitLabel: 'Buat Follow-Up',
    submitIcon: 'fa-list-check',
    async onSubmit(body) {
      await api.post('/follow-ups', { ...body, lead_id: l.id })
      toast('Follow-up dijadwalkan.', 'ok')
      onDone()
    }
  })
}

export function openCompleteFollowUp(followUpId, onDone) {
  formModal({
    title: 'Selesaikan Follow-Up',
    bodyHtml: `
      <div class="inline-info">Hasil follow-up wajib dicatat agar riwayat operasional tetap dapat dilacak.</div>
      <div class="form-grid">
        ${field({ name: 'outcome', label: 'Hasil', required: true, full: true, placeholder: 'Contoh: penyewa setuju survei hari Sabtu' })}
        ${field({ name: 'notes', label: 'Catatan tambahan', type: 'textarea', rows: 2, full: true })}
      </div>`,
    submitLabel: 'Tandai Selesai',
    async onSubmit(body) {
      await api.post(`/follow-ups/${followUpId}/complete`, body)
      toast('Follow-up selesai.', 'ok')
      onDone()
    }
  })
}

function openVisitForm(l, onDone) {
  formModal({
    title: `Jadwalkan Kunjungan — ${l.tenant_name}`,
    bodyHtml: `
      <div class="inline-info">Kunjungan terhubung ke properti <strong>${esc(l.property_name)}</strong> dan lead ini. Lead akan berpindah ke tahap VISIT_SCHEDULED.</div>
      <div class="form-grid">
        ${field({ name: 'scheduled_at', label: 'Waktu kunjungan', type: 'datetime-local', required: true, value: toLocalInput(new Date(Date.now() + 2 * 86400000)) })}
        ${field({ name: 'notes', label: 'Catatan survei', type: 'textarea', rows: 2, full: true, placeholder: 'Titik temu, hal yang perlu ditunjukkan…' })}
      </div>`,
    submitLabel: 'Jadwalkan',
    submitIcon: 'fa-calendar-plus',
    async onSubmit(body) {
      await api.post('/visits', { ...body, lead_id: l.id })
      toast('Kunjungan dijadwalkan.', 'ok')
      onDone()
    }
  })
}

export function openVisitResultForm(visit, onDone) {
  formModal({
    title: 'Catat Hasil Kunjungan',
    bodyHtml: `
      <div class="inline-info">Hasil kunjungan wajib eksplisit karena memengaruhi skor lead dan langkah berikutnya.</div>
      <div class="form-grid">
        ${field({
          name: 'result',
          label: 'Hasil kunjungan',
          type: 'select',
          required: true,
          value: 'POTENTIAL',
          options: [
            { value: 'STRONG_FIT', label: 'Sangat cocok' },
            { value: 'POTENTIAL', label: 'Berpotensi' },
            { value: 'WEAK_FIT', label: 'Kurang cocok' },
            { value: 'NO_FIT', label: 'Tidak cocok' }
          ]
        })}
        ${field({ name: 'notes', label: 'Catatan hasil', type: 'textarea', rows: 3, full: true, placeholder: 'Reaksi penyewa, keberatan, permintaan…' })}
      </div>`,
    submitLabel: 'Simpan Hasil',
    async onSubmit(body) {
      await api.post(`/visits/${visit.id}/complete`, body)
      toast('Hasil kunjungan tersimpan.', 'ok')
      onDone()
    }
  })
}

function openNegotiationForm(l, onDone) {
  formModal({
    title: `Buka Negosiasi — ${l.tenant_name}`,
    bodyHtml: `
      <div class="inline-info">Harga awal diambil dari properti: <strong>${money(l.property_price)}</strong>. Catat usulan harga dari penyewa.</div>
      <div class="form-grid">
        ${field({ name: 'proposed_price', label: 'Usulan harga penyewa', type: 'number', required: true, value: l.property_price, min: 0, step: 50000 })}
        ${field({ name: 'proposed_terms', label: 'Usulan ketentuan', type: 'textarea', rows: 2, full: true, placeholder: 'Durasi, deposit, pembayaran, permintaan perbaikan…' })}
        ${field({ name: 'notes', label: 'Catatan negosiasi', type: 'textarea', rows: 2, full: true })}
      </div>`,
    submitLabel: 'Buka Negosiasi',
    submitIcon: 'fa-handshake',
    async onSubmit(body) {
      await api.post('/negotiations', { ...body, lead_id: l.id })
      toast('Negosiasi dibuka.', 'ok')
      onDone()
    }
  })
}

function openAssignForm(l, onDone) {
  formModal({
    title: 'Alihkan Pemilik Lead',
    bodyHtml: `
      <div class="field full">
        <label for="f_user_id" class="req">Tugaskan kepada</label>
        <select id="f_user_id" name="user_id" required><option value="">Memuat pengguna…</option></select>
        <div class="hint">Pemilik lead bertanggung jawab atas follow-up dan konversinya.</div>
      </div>`,
    submitLabel: 'Tugaskan',
    submitIcon: 'fa-user-gear',
    async onMount(root) {
      const sel = root.querySelector('#f_user_id')
      try {
        const res = await api.get('/users', { limit: 100 })
        sel.innerHTML =
          `<option value="">— pilih pengguna —</option>` +
          (res.data || [])
            .map(
              (u) =>
                `<option value="${attr(u.id)}" ${u.id === l.assigned_to ? 'selected' : ''}>${esc(u.name)} · ${esc((u.roles || []).join(', '))}</option>`
            )
            .join('')
      } catch {
        // ANALYST/MARKETING may not read users — fall back to self-assign.
        sel.innerHTML = `<option value="${attr(session.user?.id)}">${esc(session.user?.name || 'Saya')}</option>`
      }
    },
    async onSubmit(body) {
      await api.post(`/leads/${l.id}/assign`, body)
      toast('Lead dialihkan.', 'ok')
      onDone()
    }
  })
}

function openLoseForm(l, onDone) {
  formModal({
    title: `Tandai Lead Hilang — ${l.tenant_name}`,
    danger: true,
    bodyHtml: `
      <div class="consequence"><i class="fa-solid fa-circle-exclamation"></i>
        Lead akan ditutup dengan status LOST dan keluar dari pipeline aktif. Follow-up yang tertunda akan dibatalkan. Tindakan ini tidak dapat dibatalkan tanpa membuat lead baru.</div>
      <div class="form-grid" style="margin-top:12px">
        ${field({ name: 'reason', label: 'Alasan hilang', required: true, full: true, placeholder: 'Contoh: anggaran tidak mencukupi / memilih lokasi lain' })}
      </div>`,
    submitLabel: 'Tandai Hilang',
    submitIcon: 'fa-circle-xmark',
    async onSubmit(body) {
      await api.post(`/leads/${l.id}/lose`, body)
      toast('Lead ditandai hilang.', 'ok')
      onDone()
    }
  })
}
