/**
 * Settings — user & role governance and the audit trail.
 * Traceability: PS-MASTER-001 §3 (roles), §22 (administration navigation),
 *               §29 (critical action), §45 (security), §46 (audit) | PS-UX-010 §45
 *
 * Authorization shown here is a MIRROR of the server-side matrix fetched from
 * /roles and /permissions — the UI never hardcodes who can do what (§3, §54).
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
  initials,
  loadingState,
  num,
  openModal,
  readForm,
  relTime,
  skeletonRows,
  toast,
  truncate
} from '../core/dom.js'
import { replaceQuery } from '../core/router.js'
import { screenEl, setHeader } from '../core/shell.js'

const ASSIGNABLE_ROLES = ['OWNER', 'OPERATOR', 'MARKETING', 'ANALYST', 'ADMIN']

const AUDIT_ENTITIES = [
  'PROPERTY',
  'TENANT',
  'OFFER',
  'CAMPAIGN',
  'LEAD',
  'FOLLOW_UP',
  'VISIT',
  'NEGOTIATION',
  'RENTAL',
  'USER'
]

/** Actions whose audit record represents an irreversible commercial commitment. */
const CRITICAL_ACTIONS = new Set([
  'RENTAL_ACTIVATED',
  'RENTAL_ENDED',
  'NEGOTIATION_ACCEPTED',
  'OFFER_PUBLISHED',
  'LEAD_LOST',
  'PROPERTY_DELETED',
  'USER_CREATED'
])

/* ========================================================================== *
 * USERS & ROLES
 * ========================================================================== */

export async function usersScreen() {
  const el = screenEl()

  setHeader({
    title: 'Pengguna & Peran',
    subtitle: 'Kelola akses sistem — otorisasi ditegakkan di server, layar ini hanya cermin',
    actions: `
      <a class="btn" href="#/settings/audit"><i class="fa-solid fa-clipboard-list"></i>Audit Log</a>
      ${session.can('user.manage') ? `<button class="btn primary" data-action="new-user"><i class="fa-solid fa-user-plus"></i>Tambah Pengguna</button>` : ''}`,
    mobilePrimary: session.can('user.manage') ? { action: 'new-user', label: 'Pengguna', icon: 'fa-user-plus' } : null
  })

  el.innerHTML = `
    <section class="stack">
      <div id="us-summary"></div>
      <div class="card">
        <div class="card-head"><h2>Pengguna</h2><span class="badge" id="us-count">…</span></div>
        <div class="table-wrap">
          <table class="data">
            <thead>
              <tr><th>Pengguna</th><th>Email</th><th>Peran</th><th>Status</th><th>Dibuat</th><th class="right">Izin</th></tr>
            </thead>
            <tbody id="us-body">${skeletonRows(6, 5)}</tbody>
          </table>
        </div>
      </div>
      <div id="roles-host"></div>
    </section>`

  const reload = () => usersScreen()
  document
    .querySelectorAll('#page-actions [data-action="new-user"], .mobile-primary[data-action="new-user"]')
    .forEach((b) => b.addEventListener('click', () => openUserForm(reload)))

  let users = []
  let roles = []
  try {
    const [uRes, rRes] = await Promise.all([api.get('/users'), api.get('/roles')])
    users = uRes.data || []
    roles = rRes.data || []
  } catch (err) {
    document.getElementById('us-body').innerHTML = `<tr><td colspan="6">${errorState(err)}</td></tr>`
    document.querySelector('#us-body [data-action="retry"]')?.addEventListener('click', reload)
    return
  }

  const permByRole = new Map(roles.map((r) => [r.name, r.permissions || []]))
  document.getElementById('us-count').textContent = `${num(users.length)} pengguna`
  document.getElementById('us-summary').innerHTML = renderUserSummary(users, roles)

  const body = document.getElementById('us-body')
  if (users.length === 0) {
    body.innerHTML = `<tr><td colspan="6">${emptyState({
      icon: 'fa-user-shield',
      title: 'Belum ada pengguna',
      message: 'Setiap operator membutuhkan akun tersendiri agar jejak audit dapat ditelusuri per orang.',
      action: session.can('user.manage') ? { action: 'new-user-empty', label: 'Tambah Pengguna', icon: 'fa-user-plus' } : null
    })}</td></tr>`
    body.querySelector('[data-action="new-user-empty"]')?.addEventListener('click', () => openUserForm(reload))
  } else {
    body.innerHTML = users.map((u) => renderUserRow(u, permByRole)).join('')
    body.querySelectorAll('[data-perms]').forEach((b) =>
      b.addEventListener('click', () => {
        const u = users.find((x) => x.id === b.dataset.perms)
        if (u) openEffectivePermissions(u, permByRole)
      })
    )
  }

  document.getElementById('roles-host').innerHTML = renderRoles(roles)
  document.querySelectorAll('#roles-host [data-role-perms]').forEach((b) =>
    b.addEventListener('click', () => {
      const r = roles.find((x) => x.name === b.dataset.rolePerms)
      if (r) openRolePermissions(r)
    })
  )
}

function renderUserSummary(users, roles) {
  const active = users.filter((u) => u.status === 'ACTIVE').length
  const admins = users.filter((u) => (u.roles || []).includes('ADMIN')).length
  const noRole = users.filter((u) => (u.roles || []).length === 0).length

  return `<div class="grid cols-4">
    <div class="kpi"><div class="k-label">Pengguna aktif</div><div class="k-value">${num(active)}</div>
      <div class="k-sub">dari ${num(users.length)} akun</div></div>
    <div class="kpi"><div class="k-label">Administrator</div><div class="k-value">${num(admins)}</div>
      <div class="k-sub">akses penuh sistem</div></div>
    <div class="kpi"><div class="k-label">Peran tersedia</div><div class="k-value">${num(roles.length)}</div>
      <div class="k-sub">matriks izin server</div></div>
    <div class="kpi"><div class="k-label">Tanpa peran</div><div class="k-value">${num(noRole)}</div>
      <div class="k-sub">${noRole ? 'tidak dapat mengakses apa pun' : 'semua akun terkonfigurasi'}</div></div>
  </div>`
}

function renderUserRow(u, permByRole) {
  const perms = new Set()
  ;(u.roles || []).forEach((r) => (permByRole.get(r) || []).forEach((p) => perms.add(p)))
  const isSelf = session.user?.id === u.id

  return `<tr>
    <td>
      <div class="row tight">
        <div class="avatar" style="width:28px;height:28px;font-size:11px">${esc(initials(u.name))}</div>
        <div>
          <div class="cell-main">${esc(u.name)}${isSelf ? ' <span class="badge info">Anda</span>' : ''}</div>
          <div class="cell-sub mono">${esc(u.id)}</div>
        </div>
      </div>
    </td>
    <td class="cell-sub">${esc(u.email)}</td>
    <td>${
      (u.roles || []).length
        ? u.roles.map((r) => badge(r, { tone: r === 'ADMIN' ? 'danger' : 'brand' })).join(' ')
        : '<span class="badge warn">tanpa peran</span>'
    }</td>
    <td>${badge(u.status)}</td>
    <td class="cell-sub nowrap">${esc(fmtDateTime(u.created_at))}</td>
    <td class="right">
      <button class="btn sm" data-perms="${attr(u.id)}">
        <i class="fa-solid fa-key"></i>${num(perms.size)}</button>
    </td>
  </tr>`
}

function renderRoles(roles) {
  if (roles.length === 0) return ''
  return `
    <div class="card">
      <div class="card-head">
        <h2>Peran & Izin</h2>
        <span class="badge">ditegakkan server-side</span>
      </div>
      <div class="card-body tight">
        ${roles
          .map(
            (r) => `<div class="list-item">
              <div>
                <div class="strong">${esc(r.name)} ${r.assignable === false ? '<span class="badge">tidak dapat ditugaskan</span>' : ''}</div>
                <div class="tiny dim">${esc(r.description || '—')}</div>
              </div>
              <div class="row tight nowrap">
                <span class="chip"><i class="fa-solid fa-users"></i> ${num(r.members || 0)} pengguna</span>
                <button class="btn sm" data-role-perms="${attr(r.name)}">
                  <i class="fa-solid fa-shield-halved"></i>${num(r.permission_count ?? (r.permissions || []).length)} izin</button>
              </div>
            </div>`
          )
          .join('')}
      </div>
      <div class="card-foot">
        <span class="tiny dim">Menyembunyikan tombol di UI bukan kontrol keamanan — setiap permintaan tetap divalidasi API.</span>
      </div>
    </div>`
}

/* ---------------------------- Permission viewers -------------------------- */

/** Group permissions by their domain prefix so the matrix stays readable. */
function groupPermissions(list) {
  const groups = new Map()
  for (const p of [...list].sort()) {
    const [domain] = String(p).split('.')
    if (!groups.has(domain)) groups.set(domain, [])
    groups.get(domain).push(p)
  }
  return [...groups.entries()]
}

function permissionGroupsHtml(list) {
  const groups = groupPermissions(list)
  if (groups.length === 0) {
    return '<div class="inline-warn"><i class="fa-solid fa-circle-exclamation"></i>Tidak ada izin — akun ini tidak dapat membuka layar apa pun.</div>'
  }
  return groups
    .map(
      ([domain, perms]) => `<div style="margin-bottom:10px">
        <div class="sub-head">${esc(humanEnum(domain))}</div>
        <div class="chips">${perms.map((p) => `<span class="chip mono">${esc(p)}</span>`).join('')}</div>
      </div>`
    )
    .join('')
}

function openEffectivePermissions(user, permByRole) {
  const perms = new Set()
  ;(user.roles || []).forEach((r) => (permByRole.get(r) || []).forEach((p) => perms.add(p)))

  openModal({
    title: `Izin Efektif — ${user.name}`,
    wide: true,
    body: `
      <div class="inline-info">
        Izin efektif adalah gabungan dari peran: ${
          (user.roles || []).length ? user.roles.map((r) => esc(r)).join(', ') : 'tidak ada peran'
        }. Total ${num(perms.size)} izin.
      </div>
      ${permissionGroupsHtml([...perms])}`,
    footer: `<button class="btn" data-modal-close>Tutup</button>`
  })
}

function openRolePermissions(role) {
  openModal({
    title: `Izin Peran — ${role.name}`,
    wide: true,
    body: `
      <div class="inline-info">${esc(role.description || '—')} · ${num((role.permissions || []).length)} izin · ${num(role.members || 0)} pengguna memakai peran ini.</div>
      ${permissionGroupsHtml(role.permissions || [])}`,
    footer: `<button class="btn" data-modal-close>Tutup</button>`
  })
}

/* -------------------------------- User form ------------------------------- */

export function openUserForm(onDone) {
  openModal({
    title: 'Tambah Pengguna',
    body: `
      <form id="uf-form" novalidate>
        <div id="uf-error"></div>
        <div class="consequence"><i class="fa-solid fa-circle-exclamation"></i>
          Pengguna baru langsung dapat masuk dan bertindak sesuai peran yang diberikan. Semua tindakannya tercatat pada audit log atas namanya.
        </div>
        <div class="form-grid">
          ${field({ name: 'name', label: 'Nama lengkap', required: true, full: true, placeholder: 'Contoh: Budi Santoso' })}
          ${field({ name: 'email', label: 'Email', type: 'email', required: true, full: true, placeholder: 'nama@perusahaan.com' })}
          ${field({
            name: 'password',
            label: 'Kata sandi awal',
            type: 'password',
            required: true,
            full: true,
            hint: 'Minimal 8 karakter. Sampaikan melalui kanal aman dan minta segera diganti.'
          })}
          ${field({
            name: 'role',
            label: 'Peran',
            type: 'select',
            required: true,
            value: 'OPERATOR',
            full: true,
            hint: 'Satu peran utama. ADMIN memiliki akses penuh termasuk audit dan manajemen pengguna.',
            options: ASSIGNABLE_ROLES.map((r) => ({ value: r, label: r }))
          })}
        </div>
      </form>`,
    footer: `
      <button class="btn" data-modal-close>Batal</button>
      <button class="btn primary" id="uf-save"><i class="fa-solid fa-user-plus"></i>Buat Pengguna</button>`,
    onMount(root, close) {
      const form = root.querySelector('#uf-form')
      const errBox = root.querySelector('#uf-error')
      const btn = root.querySelector('#uf-save')
      btn.addEventListener('click', async () => {
        errBox.innerHTML = ''
        btn.disabled = true
        btn.innerHTML = '<i class="fa-solid fa-spinner fa-spin"></i> Menyimpan…'
        try {
          const raw = readForm(form)
          // The API contract expects `roles` as an array (§33).
          const body = { name: raw.name, email: raw.email, password: raw.password, roles: [raw.role] }
          await api.post('/users', body)
          toast('Pengguna dibuat.', 'ok')
          close()
          onDone()
        } catch (err) {
          btn.disabled = false
          btn.innerHTML = '<i class="fa-solid fa-user-plus"></i>Buat Pengguna'
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
 * AUDIT LOG
 * ========================================================================== */

export async function auditScreen({ query = {} } = {}) {
  const el = screenEl()
  const filters = {
    entity_type: query.entity_type || '',
    limit: Number(query.limit || 50)
  }

  setHeader({
    title: 'Audit Log',
    subtitle: 'Jejak tindakan bisnis — siapa, apa, kapan, entitas, dan hasilnya',
    actions: `
      <a class="btn" href="#/settings/users"><i class="fa-solid fa-user-shield"></i>Pengguna</a>
      <button class="btn" data-action="refresh"><i class="fa-solid fa-rotate-right"></i>Muat ulang</button>`
  })
  document
    .querySelector('#page-actions [data-action="refresh"]')
    ?.addEventListener('click', () => auditScreen({ query }))

  el.innerHTML = `
    <section class="stack">
      <div class="card"><div class="card-body">
        <div class="filters">
          <div class="field">
            <label for="af-entity">Jenis entitas</label>
            <select id="af-entity">
              <option value="">Semua entitas</option>
              ${AUDIT_ENTITIES.map(
                (e) => `<option value="${attr(e)}" ${filters.entity_type === e ? 'selected' : ''}>${esc(humanEnum(e))}</option>`
              ).join('')}
            </select>
          </div>
          <div class="field">
            <label for="af-limit">Jumlah baris</label>
            <select id="af-limit">
              ${[25, 50, 100, 200].map(
                (n) => `<option value="${n}" ${filters.limit === n ? 'selected' : ''}>${n} terbaru</option>`
              ).join('')}
            </select>
          </div>
          <div class="field" style="align-self:end">
            <button class="btn" id="af-reset"><i class="fa-solid fa-eraser"></i>Reset</button>
          </div>
        </div>
      </div></div>
      <div id="audit-host">${loadingState('Memuat jejak audit…')}</div>
    </section>`

  const apply = (patch) => {
    const next = { entity_type: filters.entity_type, limit: filters.limit, ...patch }
    replaceQuery(next)
    auditScreen({ query: next })
  }
  el.querySelector('#af-entity')?.addEventListener('change', (e) => apply({ entity_type: e.target.value }))
  el.querySelector('#af-limit')?.addEventListener('change', (e) => apply({ limit: Number(e.target.value) }))
  el.querySelector('#af-reset')?.addEventListener('click', () => apply({ entity_type: '', limit: 50 }))

  const host = document.getElementById('audit-host')
  let rows = []
  try {
    rows = (
      await api.get('/audit-logs', {
        entity_type: filters.entity_type || undefined,
        limit: filters.limit
      })
    ).data || []
  } catch (err) {
    host.innerHTML = errorState(err)
    host.querySelector('[data-action="retry"]')?.addEventListener('click', () => auditScreen({ query }))
    return
  }

  if (rows.length === 0) {
    host.innerHTML = emptyState({
      icon: 'fa-clipboard-list',
      title: filters.entity_type ? 'Tidak ada jejak untuk entitas ini' : 'Belum ada jejak audit',
      message: filters.entity_type
        ? 'Belum ada tindakan tercatat pada jenis entitas yang dipilih. Reset filter untuk melihat seluruh jejak.'
        : 'Audit terisi otomatis saat tindakan bisnis penting dijalankan, seperti aktivasi rental atau penerimaan negosiasi.',
      action: { action: 'goto-dash', label: 'Ke Dashboard', icon: 'fa-gauge-high' }
    })
    host.querySelector('[data-action="goto-dash"]')?.addEventListener('click', () => {
      location.hash = '#/dashboard'
    })
    return
  }

  host.innerHTML = `
    ${renderAuditSummary(rows)}
    <div class="card">
      <div class="card-head"><h2>Jejak Tindakan</h2><span class="badge">${num(rows.length)} catatan</span></div>
      <div class="table-wrap">
        <table class="data">
          <thead>
            <tr><th>Waktu</th><th>Pelaku</th><th>Tindakan</th><th>Entitas</th><th>Perubahan</th><th>Request</th></tr>
          </thead>
          <tbody>${rows.map(renderAuditRow).join('')}</tbody>
        </table>
      </div>
      <div class="card-foot">
        <span class="tiny dim">Audit bersifat append-only: catatan tidak dapat diubah atau dihapus dari aplikasi.</span>
      </div>
    </div>`

  host.querySelectorAll('[data-audit-detail]').forEach((b) =>
    b.addEventListener('click', () => {
      const r = rows.find((x) => x.id === b.dataset.auditDetail)
      if (r) openAuditDetail(r)
    })
  )
}

function renderAuditSummary(rows) {
  const critical = rows.filter((r) => CRITICAL_ACTIONS.has(r.action)).length
  const actors = new Set(rows.map((r) => r.user_email).filter(Boolean)).size
  const entities = new Set(rows.map((r) => r.entity_type)).size
  const latest = rows[0]

  return `<div class="grid cols-4">
    <div class="kpi"><div class="k-label">Catatan dimuat</div><div class="k-value">${num(rows.length)}</div>
      <div class="k-sub">terbaru lebih dahulu</div></div>
    <div class="kpi"><div class="k-label">Tindakan kritis</div><div class="k-value">${num(critical)}</div>
      <div class="k-sub">komitmen komersial</div></div>
    <div class="kpi"><div class="k-label">Pelaku unik</div><div class="k-value">${num(actors)}</div>
      <div class="k-sub">${num(entities)} jenis entitas</div></div>
    <div class="kpi"><div class="k-label">Aktivitas terakhir</div><div class="k-value" style="font-size:16px">${esc(relTime(latest?.created_at))}</div>
      <div class="k-sub">${esc(truncate(latest?.action || '—', 28))}</div></div>
  </div>`
}

function renderAuditRow(r) {
  const critical = CRITICAL_ACTIONS.has(r.action)
  const changed = r.old_value || r.new_value
  return `<tr>
    <td class="nowrap">
      <div class="cell-main">${esc(fmtDateTime(r.created_at))}</div>
      <div class="cell-sub">${esc(relTime(r.created_at))}</div>
    </td>
    <td>
      <div class="cell-main">${esc(r.user_name || 'Sistem')}</div>
      <div class="cell-sub">${esc(r.user_email || '—')}</div>
    </td>
    <td>${badge(r.action, { tone: critical ? 'danger' : 'info' })}</td>
    <td>
      <div class="cell-main">${esc(humanEnum(r.entity_type))}</div>
      <div class="cell-sub mono">${esc(truncate(r.entity_id || '—', 26))}</div>
    </td>
    <td>${
      changed
        ? `<button class="btn sm" data-audit-detail="${attr(r.id)}"><i class="fa-solid fa-code-compare"></i>Lihat</button>`
        : '<span class="dim tiny">tanpa perubahan nilai</span>'
    }</td>
    <td class="cell-sub mono">${esc(truncate(r.request_id || '—', 18))}</td>
  </tr>`
}

function openAuditDetail(r) {
  const pretty = (v) => {
    if (v === null || v === undefined || v === '') return '—'
    try {
      return JSON.stringify(JSON.parse(v), null, 2)
    } catch {
      return String(v)
    }
  }

  openModal({
    title: `Audit — ${humanEnum(r.action)}`,
    wide: true,
    body: `
      <div class="kv"><span>Waktu</span><b>${esc(fmtDateTime(r.created_at))}</b></div>
      <div class="kv"><span>Pelaku</span><b>${esc(r.user_name || 'Sistem')} · ${esc(r.user_email || '—')}</b></div>
      <div class="kv"><span>Entitas</span><b>${esc(humanEnum(r.entity_type))} <span class="mono">${esc(r.entity_id || '—')}</span></b></div>
      <div class="kv"><span>Request ID</span><b class="mono">${esc(r.request_id || '—')}</b></div>
      <div class="split" style="margin-top:12px">
        <div>
          <div class="sub-head">Nilai sebelum</div>
          <pre class="mono" style="background:var(--surface-2);padding:10px;border-radius:8px;overflow:auto;max-height:260px;font-size:12px">${esc(pretty(r.old_value))}</pre>
        </div>
        <div>
          <div class="sub-head">Nilai sesudah</div>
          <pre class="mono" style="background:var(--surface-2);padding:10px;border-radius:8px;overflow:auto;max-height:260px;font-size:12px">${esc(pretty(r.new_value))}</pre>
        </div>
      </div>`,
    footer: `<button class="btn" data-modal-close>Tutup</button>`
  })
}
