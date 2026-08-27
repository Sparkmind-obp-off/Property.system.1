/**
 * Login screen.
 * Traceability: PS-UX-010 §45 | PS-IMP-011 §9
 *              PS-MASTER-001 §5 (password security), §8 (admin first login),
 *              §45 (no credential ever ships in frontend code)
 *
 * §5/§8 rule enforced here: the password exists in exactly one place in the UI —
 * the user's own input field. No credential is embedded in this bundle, no
 * credential is rendered as a hint, and nothing is written to the console.
 *
 * Development convenience is opt-in and host-scoped: seed accounts are listed
 * ONLY when the app is served from localhost AND the operator explicitly stored
 * them in localStorage under `ps.devAccounts`. A production bundle therefore
 * contains no credential at all.
 */
import { api, errorText } from '../core/api.js'
import { esc } from '../core/dom.js'

/** Local-only, opt-in quick-fill. Returns [] in every deployed environment. */
function devAccounts() {
  const host = location.hostname
  const isLocal = host === 'localhost' || host === '127.0.0.1' || host.endsWith('.local')
  if (!isLocal) return []
  try {
    const raw = localStorage.getItem('ps.devAccounts')
    if (!raw) return []
    const list = JSON.parse(raw)
    return Array.isArray(list) ? list.filter((a) => a && a.email && a.password) : []
  } catch {
    return []
  }
}

/**
 * §16 pre-login diagnostic panel + §17 "system unavailable" state.
 *
 * Reads GET /api/v1/system/public-status, whose payload is capped server-side to
 * five non-sensitive facts. The panel therefore cannot render a secret even if
 * the UI were changed carelessly — there is nothing sensitive in the response.
 */
async function renderSystemState(host) {
  if (!host) return
  let s
  try {
    s = (await api.get('/system/public-status')).data
  } catch {
    // A failed probe is itself the diagnostic: the API is not reachable.
    host.innerHTML = `<div class="sys-state degraded">
        <i class="fa-solid fa-triangle-exclamation"></i>
        <span>Sistem tidak dapat dihubungi. Coba lagi beberapa saat.</span>
      </div>`
    return
  }

  const ready = s.application === 'READY' && s.bootstrap === 'COMPLETE'
  const rows = [
    ['Aplikasi', s.application],
    ['Database', s.database],
    ['Autentikasi', s.authentication],
    ['Bootstrap', s.bootstrap === 'COMPLETE' ? 'COMPLETE' : 'NOT CONFIGURED']
  ]

  // Only ADMIN sees the configuration reason (§9); pre-login copy stays generic.
  const notice =
    s.bootstrap !== 'COMPLETE'
      ? 'Akun administrator awal belum tersedia. Administrator harus menyetel ADMIN_EMAIL dan ADMIN_PASSWORD di environment produksi, lalu login pertama akan menyelesaikan bootstrap.'
      : s.database !== 'CONNECTED' || s.authentication !== 'READY'
        ? 'Sebagian layanan belum siap. Login mungkin gagal sampai kondisi sistem normal.'
        : ''

  host.innerHTML = `
    <details class="sys-state ${ready ? 'ok' : 'degraded'}" ${ready ? '' : 'open'}>
      <summary>
        <span class="dot"></span>
        <span>Status sistem: ${esc(ready ? 'SIAP' : 'PERLU PERHATIAN')}</span>
        <span class="tiny dim" style="margin-left:auto">v${esc(s.version)}</span>
      </summary>
      <div class="sys-grid">
        ${rows
          .map(
            ([k, val]) =>
              `<div class="sys-row"><span class="dim">${esc(k)}</span><span class="mono">${esc(val)}</span></div>`
          )
          .join('')}
      </div>
      ${notice ? `<div class="tiny dim sys-note">${esc(notice)}</div>` : ''}
    </details>`
}

export function renderLogin(onSuccess) {
  const app = document.getElementById('app')
  const accounts = devAccounts()

  app.innerHTML = `
    <div class="login-wrap">
      <div class="login-card">
        <div class="lc-brand">
          <div class="n">Property System</div>
          <div class="s">Property → Tenant → Lead → Rental</div>
        </div>
        <div id="login-error"></div>
        <form id="login-form" novalidate>
          <div class="field">
            <label for="email" class="req">Email</label>
            <input id="email" name="email" type="email" autocomplete="username" required placeholder="nama@domain.com">
          </div>
          <div class="field">
            <label for="password" class="req">Password</label>
            <input id="password" name="password" type="password" autocomplete="current-password" required>
          </div>
          <button class="btn primary block" type="submit" id="login-btn">
            <i class="fa-solid fa-right-to-bracket"></i> Masuk
          </button>
        </form>
        ${
          accounts.length
            ? `<div class="demo-users">
                 <div class="tiny dim" style="margin-bottom:6px">Akun pengembangan lokal (klik untuk mengisi):</div>
                 ${accounts
                   .map(
                     (d, i) => `<div class="demo-user" data-demo="${i}">
                        <span class="badge brand">${esc(d.role || 'DEV')}</span>
                        <span class="dim tiny" style="margin-left:auto">${esc(d.email)}</span>
                      </div>`
                   )
                   .join('')}
               </div>`
            : `<div class="tiny dim" style="margin-top:14px;text-align:center">
                 Akun dibuat oleh administrator di dalam aplikasi. Kredensial tidak pernah
                 ditampilkan di layar ini.
               </div>`
        }
        <div id="login-sysstate"></div>
      </div>
    </div>`

  // Fire-and-forget: the diagnostic must never delay or block the login form.
  renderSystemState(document.getElementById('login-sysstate'))

  const form = document.getElementById('login-form')
  const errBox = document.getElementById('login-error')
  const btn = document.getElementById('login-btn')

  app.querySelectorAll('[data-demo]').forEach((el) => {
    el.addEventListener('click', () => {
      const d = accounts[Number(el.dataset.demo)]
      if (!d) return
      form.email.value = d.email
      form.password.value = d.password
      form.password.focus()
    })
  })

  form.addEventListener('submit', async (e) => {
    e.preventDefault()
    errBox.innerHTML = ''
    const email = form.email.value.trim()
    const password = form.password.value
    if (!email || !password) {
      errBox.innerHTML = '<div class="inline-error">Email dan password wajib diisi.</div>'
      return
    }
    btn.disabled = true
    btn.innerHTML = '<i class="fa-solid fa-spinner fa-spin"></i> Memverifikasi…'
    try {
      const user = await api.auth.login(email, password)
      onSuccess(user)
    } catch (err) {
      errBox.innerHTML = `<div class="inline-error">${esc(errorText(err))}</div>`
      btn.disabled = false
      btn.innerHTML = '<i class="fa-solid fa-right-to-bracket"></i> Masuk'
    } finally {
      // The plaintext must not linger in the DOM after the attempt (§5).
      form.password.value = ''
    }
  })
}
