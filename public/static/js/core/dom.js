/**
 * Tiny DOM/render helpers + shared UI-state renderers.
 * Traceability: PS-UX-010 §27 (UI states), §29 (formatting), §31 (empty states)
 *
 * Every screen must be able to render: LOADING, EMPTY, SUCCESS, ERROR,
 * PARTIAL, DISABLED, PERMISSION DENIED, NOT FOUND (§27).
 */

/* --------------------------------- Escaping ------------------------------- */

export function esc(v) {
  if (v === null || v === undefined) return ''
  return String(v)
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;')
    .replace(/'/g, '&#39;')
}

export function attr(v) {
  return esc(v)
}

/* -------------------------------- Formatting ------------------------------ */

const RUPIAH = new Intl.NumberFormat('id-ID', { style: 'currency', currency: 'IDR', maximumFractionDigits: 0 })
const NUM = new Intl.NumberFormat('id-ID')

export function money(v) {
  if (v === null || v === undefined || v === '') return '—'
  return RUPIAH.format(Number(v))
}

export function moneyShort(v) {
  const n = Number(v || 0)
  if (n >= 1_000_000_000) return `Rp ${(n / 1_000_000_000).toFixed(1).replace('.0', '')} M`
  if (n >= 1_000_000) return `Rp ${(n / 1_000_000).toFixed(1).replace('.0', '')} jt`
  if (n >= 1000) return `Rp ${(n / 1000).toFixed(0)} rb`
  return `Rp ${NUM.format(n)}`
}

export function num(v) {
  if (v === null || v === undefined || v === '') return '—'
  return NUM.format(Number(v))
}

export function pct(v) {
  if (v === null || v === undefined) return '—'
  return `${Number(v)}%`
}

export function period(p) {
  return p === 'YEAR' ? '/tahun' : '/bulan'
}

function toDate(v) {
  if (!v) return null
  // D1 stores "YYYY-MM-DD HH:MM:SS" (UTC). Normalise to ISO for Date parsing.
  const iso = typeof v === 'string' && v.includes(' ') ? v.replace(' ', 'T') + 'Z' : v
  const d = new Date(iso)
  return Number.isNaN(d.getTime()) ? null : d
}

export function fmtDate(v) {
  const d = toDate(v)
  if (!d) return '—'
  return d.toLocaleDateString('id-ID', { day: '2-digit', month: 'short', year: 'numeric' })
}

export function fmtDateTime(v) {
  const d = toDate(v)
  if (!d) return '—'
  return d.toLocaleString('id-ID', {
    day: '2-digit',
    month: 'short',
    year: 'numeric',
    hour: '2-digit',
    minute: '2-digit'
  })
}

export function relTime(v) {
  const d = toDate(v)
  if (!d) return '—'
  const diff = Date.now() - d.getTime()
  const mins = Math.round(diff / 60000)
  if (Math.abs(mins) < 1) return 'baru saja'
  if (Math.abs(mins) < 60) return mins > 0 ? `${mins} menit lalu` : `dalam ${-mins} menit`
  const hrs = Math.round(mins / 60)
  if (Math.abs(hrs) < 24) return hrs > 0 ? `${hrs} jam lalu` : `dalam ${-hrs} jam`
  const days = Math.round(hrs / 24)
  if (Math.abs(days) < 30) return days > 0 ? `${days} hari lalu` : `dalam ${-days} hari`
  return fmtDate(v)
}

/** For <input type="datetime-local"> values. */
export function toLocalInput(v) {
  const d = toDate(v) || new Date()
  const pad = (n) => String(n).padStart(2, '0')
  return `${d.getFullYear()}-${pad(d.getMonth() + 1)}-${pad(d.getDate())}T${pad(d.getHours())}:${pad(d.getMinutes())}`
}

export function todayInput(offsetDays = 0) {
  const d = new Date()
  d.setDate(d.getDate() + offsetDays)
  return d.toISOString().slice(0, 10)
}

/** Convert a datetime-local value to the UTC string the API expects. */
export function fromLocalInput(v) {
  if (!v) return null
  const d = new Date(v)
  if (Number.isNaN(d.getTime())) return null
  return d.toISOString().slice(0, 19).replace('T', ' ')
}

export function humanEnum(v) {
  if (!v) return '—'
  return String(v)
    .toLowerCase()
    .split('_')
    .map((w) => w.charAt(0).toUpperCase() + w.slice(1))
    .join(' ')
}

export function initials(name) {
  return String(name || '?')
    .split(/\s+/)
    .slice(0, 2)
    .map((w) => w.charAt(0).toUpperCase())
    .join('')
}

export function truncate(s, n = 90) {
  const str = String(s || '')
  return str.length > n ? `${str.slice(0, n - 1)}…` : str
}

/* --------------------------------- Badges --------------------------------- */

const TONE = {
  // property
  AVAILABLE: 'ok',
  RESERVED: 'warn',
  RENTED: 'info',
  UNAVAILABLE: '',
  DRAFT: '',
  PENDING_VERIFICATION: 'warn',
  VERIFIED: 'info',
  ACTIVE: 'ok',
  MARKETED: 'brand',
  INACTIVE: '',
  // lead
  NEW: 'info',
  CONTACTED: 'info',
  RESPONDED: 'info',
  QUALIFIED: 'brand',
  INTERESTED: 'brand',
  VISIT_SCHEDULED: 'warn',
  VISITED: 'warn',
  NEGOTIATION: 'warn',
  WON: 'ok',
  LOST: 'danger',
  // temperature
  HOT: 'danger',
  WARM: 'warn',
  COOL: 'info',
  LOW: '',
  // ops
  PENDING: 'warn',
  COMPLETED: 'ok',
  CANCELLED: '',
  RESCHEDULED: 'info',
  SCHEDULED: 'info',
  CONFIRMED: 'brand',
  NO_SHOW: 'danger',
  STRONG_FIT: 'ok',
  POTENTIAL: 'brand',
  WEAK_FIT: 'warn',
  NO_FIT: 'danger',
  // negotiation
  OPEN: 'warn',
  COUNTER_OFFER: 'warn',
  AGREED: 'ok',
  FAILED: 'danger',
  // rental
  EXPIRING: 'warn',
  ENDED: '',
  // offer/campaign
  READY: 'brand',
  PAUSED: '',
  EXPIRED: '',
  RUNNING: 'ok',
  // match
  HIGH_FIT: 'ok',
  MEDIUM_FIT: 'warn',
  LOW_FIT: '',
  // qualification
  PARTIALLY_QUALIFIED: 'warn',
  UNQUALIFIED: 'danger'
}

export function badge(value, { label, tone } = {}) {
  if (!value) return ''
  const t = tone !== undefined ? tone : TONE[value] ?? ''
  return `<span class="badge ${t}">${esc(label || humanEnum(value))}</span>`
}

export function scorePill(score, suffix = '') {
  if (score === null || score === undefined) return '<span class="score-pill">—</span>'
  const n = Number(score)
  const cls = n >= 70 ? 'high' : n >= 45 ? 'mid' : 'low'
  return `<span class="score-pill ${cls}">${n}${suffix}</span>`
}

export function meter(value, max = 100) {
  const n = Math.max(0, Math.min(100, (Number(value || 0) / max) * 100))
  const cls = n >= 70 ? 'high' : n >= 45 ? 'mid' : 'low'
  return `<div class="meter ${cls}"><span style="width:${n}%"></span></div>`
}

/* ------------------------------- UI states -------------------------------- */

export function loadingState(msg = 'Memuat data…') {
  return `
    <div class="card"><div class="card-body">
      <div class="sk-line skeleton" style="width:34%"></div>
      <div class="sk-line skeleton" style="width:82%"></div>
      <div class="sk-line skeleton" style="width:64%"></div>
      <div class="sk-line skeleton" style="width:74%"></div>
      <div class="tiny dim" style="margin-top:10px">${esc(msg)}</div>
    </div></div>`
}

export function skeletonRows(cols = 4, rows = 5) {
  let html = ''
  for (let r = 0; r < rows; r++) {
    html += '<tr>'
    for (let c = 0; c < cols; c++) html += '<td><div class="sk-line skeleton" style="margin:0"></div></td>'
    html += '</tr>'
  }
  return html
}

/** Empty state ALWAYS offers the next action (§31). */
export function emptyState({ icon = 'fa-inbox', title, message, action }) {
  return `
    <div class="state">
      <i class="fa-solid ${icon} state-icon"></i>
      <div class="state-title">${esc(title)}</div>
      <div class="state-msg">${esc(message || '')}</div>
      ${action ? `<button class="btn primary" data-action="${attr(action.action)}" ${action.dataset || ''}>
        ${action.icon ? `<i class="fa-solid ${attr(action.icon)}"></i>` : ''}${esc(action.label)}
      </button>` : ''}
    </div>`
}

export function errorState(err, { retryAction = 'retry' } = {}) {
  const code = err?.code || 'INTERNAL_ERROR'
  if (code === 'FORBIDDEN') return deniedState(err?.message)
  if (code === 'NOT_FOUND') return notFoundState(err?.message)
  return `
    <div class="state error">
      <i class="fa-solid fa-triangle-exclamation state-icon"></i>
      <div class="state-title">Gagal memuat data</div>
      <div class="state-msg">${esc(err?.message || 'Terjadi kesalahan tak terduga.')}</div>
      <div class="row" style="justify-content:center">
        <button class="btn" data-action="${attr(retryAction)}"><i class="fa-solid fa-rotate-right"></i>Coba lagi</button>
      </div>
      <div class="tiny dim" style="margin-top:10px">Kode: ${esc(code)}</div>
    </div>`
}

export function deniedState(message) {
  return `
    <div class="state denied">
      <i class="fa-solid fa-lock state-icon"></i>
      <div class="state-title">Akses ditolak</div>
      <div class="state-msg">${esc(message || 'Peran Anda tidak memiliki izin untuk membuka layar ini.')}</div>
      <a class="btn" href="#/dashboard"><i class="fa-solid fa-gauge-high"></i>Ke Dashboard</a>
    </div>`
}

export function notFoundState(message) {
  return `
    <div class="state">
      <i class="fa-solid fa-magnifying-glass state-icon"></i>
      <div class="state-title">Data tidak ditemukan</div>
      <div class="state-msg">${esc(message || 'Data yang Anda cari sudah dihapus atau tidak pernah ada.')}</div>
      <button class="btn" data-action="back"><i class="fa-solid fa-arrow-left"></i>Kembali</button>
    </div>`
}

export function partialState(message) {
  return `<div class="inline-warn"><i class="fa-solid fa-circle-exclamation"></i> ${esc(message)}</div>`
}

/* --------------------------------- Toasts --------------------------------- */

export function toast(message, kind = '') {
  let host = document.getElementById('toasts')
  if (!host) {
    host = document.createElement('div')
    host.id = 'toasts'
    document.body.appendChild(host)
  }
  const el = document.createElement('div')
  el.className = `toast ${kind}`
  const icon = kind === 'ok' ? 'fa-circle-check' : kind === 'err' ? 'fa-circle-exclamation' : 'fa-circle-info'
  el.innerHTML = `<i class="fa-solid ${icon}"></i><div>${esc(message)}</div>`
  host.appendChild(el)
  setTimeout(() => el.remove(), kind === 'err' ? 6500 : 3800)
}

/* ---------------------------------- Modal --------------------------------- */

let modalHost = null

export function closeModal() {
  if (modalHost) {
    modalHost.remove()
    modalHost = null
  }
}

/**
 * Open a modal. `render` receives a helper `close`. Returns the modal element.
 * Critical actions must explain their consequence (§29 / MASTER §29).
 */
export function openModal({ title, body, footer, wide, onMount }) {
  closeModal()
  modalHost = document.createElement('div')
  modalHost.className = 'modal-backdrop'
  modalHost.innerHTML = `
    <div class="modal ${wide ? 'wide' : ''}" role="dialog" aria-modal="true">
      <div class="modal-head">
        <h2>${esc(title)}</h2>
        <button class="x" data-modal-close aria-label="Tutup"><i class="fa-solid fa-xmark"></i></button>
      </div>
      <div class="modal-body">${body}</div>
      ${footer ? `<div class="modal-foot">${footer}</div>` : ''}
    </div>`
  document.body.appendChild(modalHost)
  modalHost.addEventListener('click', (e) => {
    if (e.target === modalHost || e.target.closest('[data-modal-close]')) closeModal()
  })
  const esch = (e) => {
    if (e.key === 'Escape') {
      closeModal()
      document.removeEventListener('keydown', esch)
    }
  }
  document.addEventListener('keydown', esch)
  if (onMount) onMount(modalHost.querySelector('.modal'), closeModal)
  const firstInput = modalHost.querySelector('input, select, textarea')
  if (firstInput) firstInput.focus()
  return modalHost
}

/** Confirmation dialog that states the consequence (§29). */
export function confirmAction({ title, consequence, confirmLabel = 'Lanjutkan', danger, onConfirm, extraBody = '' }) {
  openModal({
    title,
    body: `${consequence ? `<div class="consequence"><i class="fa-solid fa-circle-exclamation"></i> ${esc(consequence)}</div>` : ''}${extraBody}`,
    footer: `
      <button class="btn" data-modal-close>Batal</button>
      <button class="btn ${danger ? 'danger' : 'primary'}" data-confirm>${esc(confirmLabel)}</button>`,
    onMount(root, close) {
      root.querySelector('[data-confirm]').addEventListener('click', async (e) => {
        const btn = e.currentTarget
        btn.disabled = true
        btn.innerHTML = '<i class="fa-solid fa-spinner fa-spin"></i> Memproses…'
        try {
          await onConfirm(root)
          close()
        } catch (err) {
          btn.disabled = false
          btn.textContent = confirmLabel
          const box = document.createElement('div')
          box.className = 'inline-error'
          box.textContent = err?.message || 'Gagal.'
          root.querySelector('.modal-body').prepend(box)
        }
      })
    }
  })
}

/* --------------------------------- Forms ---------------------------------- */

/** Read a form into a plain object; empty strings become undefined. */
export function readForm(form) {
  const out = {}
  for (const el of form.querySelectorAll('[name]')) {
    if (el.disabled) continue
    const name = el.name
    if (el.type === 'checkbox') {
      out[name] = el.checked
      continue
    }
    let v = el.value
    if (v === '') {
      out[name] = undefined
      continue
    }
    if (el.dataset.type === 'number') v = Number(v)
    if (el.dataset.type === 'datetime') v = fromLocalInput(v)
    out[name] = v
  }
  return out
}

/** Show server-side validation details on the matching fields (§28). */
export function applyFieldErrors(form, details) {
  form.querySelectorAll('.err').forEach((e) => e.remove())
  form.querySelectorAll('.invalid').forEach((e) => e.classList.remove('invalid'))
  let unmatched = []
  for (const [field, msg] of Object.entries(details || {})) {
    const el = form.querySelector(`[name="${field}"]`)
    if (el) {
      el.classList.add('invalid')
      const p = document.createElement('div')
      p.className = 'err'
      p.textContent = String(msg)
      ;(el.closest('.field') || el.parentElement).appendChild(p)
    } else {
      unmatched.push(`${field}: ${msg}`)
    }
  }
  return unmatched
}

export function field({ name, label, type = 'text', value, required, hint, options, placeholder, full, min, max, step, rows, dataType, disabled }) {
  const id = `f_${name}`
  const req = required ? 'required' : ''
  const cls = full ? 'field full' : 'field'
  let control
  if (type === 'select') {
    control = `<select id="${id}" name="${attr(name)}" ${req} ${disabled ? 'disabled' : ''}>
      ${(options || [])
        .map((o) => {
          const val = typeof o === 'string' ? o : o.value
          const lbl = typeof o === 'string' ? humanEnum(o) : o.label
          const sel = String(value ?? '') === String(val) ? 'selected' : ''
          return `<option value="${attr(val)}" ${sel}>${esc(lbl)}</option>`
        })
        .join('')}
    </select>`
  } else if (type === 'textarea') {
    control = `<textarea id="${id}" name="${attr(name)}" rows="${rows || 3}" ${req} placeholder="${attr(placeholder || '')}" ${disabled ? 'disabled' : ''}>${esc(value ?? '')}</textarea>`
  } else {
    const dt = dataType || (type === 'number' ? 'number' : type === 'datetime-local' ? 'datetime' : '')
    control = `<input id="${id}" type="${type}" name="${attr(name)}" value="${attr(value ?? '')}"
      ${req} ${dt ? `data-type="${dt}"` : ''} ${min !== undefined ? `min="${attr(min)}"` : ''}
      ${max !== undefined ? `max="${attr(max)}"` : ''} ${step !== undefined ? `step="${attr(step)}"` : ''}
      placeholder="${attr(placeholder || '')}" ${disabled ? 'disabled' : ''}>`
  }
  return `<div class="${cls}">
    <label for="${id}" class="${required ? 'req' : ''}">${esc(label)}</label>
    ${control}
    ${hint ? `<div class="hint">${esc(hint)}</div>` : ''}
  </div>`
}

/* -------------------------------- Utilities ------------------------------- */

export function debounce(fn, ms = 320) {
  let t
  return (...args) => {
    clearTimeout(t)
    t = setTimeout(() => fn(...args), ms)
  }
}

export function pagerHtml(meta) {
  if (!meta || !meta.total_pages || meta.total_pages <= 1) {
    return meta && meta.total ? `<div class="pager"><span class="tiny dim">${num(meta.total)} data</span></div>` : ''
  }
  return `<div class="pager">
    <span class="tiny dim">Halaman ${meta.page} dari ${meta.total_pages} · ${num(meta.total)} data</span>
    <button class="btn sm" data-page="${meta.page - 1}" ${meta.page <= 1 ? 'disabled' : ''}>
      <i class="fa-solid fa-chevron-left"></i></button>
    <button class="btn sm" data-page="${meta.page + 1}" ${meta.page >= meta.total_pages ? 'disabled' : ''}>
      <i class="fa-solid fa-chevron-right"></i></button>
  </div>`
}
