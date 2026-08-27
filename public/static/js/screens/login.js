/**
 * Login screen.
 * Traceability: PS-UX-010 §45 | PS-MASTER-001 §45 (auth) | PS-IMP-011 §9
 */
import { api, errorText } from '../core/api.js'
import { esc } from '../core/dom.js'

const DEMO = [
  { email: 'operator@propertysystem.local', password: 'Operator#2026', role: 'OPERATOR', name: 'Siti Rahayu' },
  { email: 'owner@propertysystem.local', password: 'Owner#2026', role: 'OWNER', name: 'Budi Santoso' },
  { email: 'marketing@propertysystem.local', password: 'Marketing#2026', role: 'MARKETING', name: 'Agus Pratama' },
  { email: 'analyst@propertysystem.local', password: 'Analyst#2026', role: 'ANALYST', name: 'Dewi Lestari' },
  { email: 'admin@propertysystem.local', password: 'Admin#2026', role: 'ADMIN', name: 'System Admin' }
]

export function renderLogin(onSuccess) {
  const app = document.getElementById('app')
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
            <input id="email" name="email" type="email" autocomplete="username" required placeholder="nama@domain.local">
          </div>
          <div class="field">
            <label for="password" class="req">Password</label>
            <input id="password" name="password" type="password" autocomplete="current-password" required>
          </div>
          <button class="btn primary block" type="submit" id="login-btn">
            <i class="fa-solid fa-right-to-bracket"></i> Masuk
          </button>
        </form>
        <div class="demo-users">
          <div class="tiny dim" style="margin-bottom:6px">Akun demo (klik untuk mengisi):</div>
          ${DEMO.map(
            (d, i) => `<div class="demo-user" data-demo="${i}">
              <span class="badge brand">${esc(d.role)}</span>
              <span>${esc(d.name)}</span>
              <span class="dim tiny" style="margin-left:auto">${esc(d.email)}</span>
            </div>`
          ).join('')}
        </div>
      </div>
    </div>`

  const form = document.getElementById('login-form')
  const errBox = document.getElementById('login-error')
  const btn = document.getElementById('login-btn')

  app.querySelectorAll('[data-demo]').forEach((el) => {
    el.addEventListener('click', () => {
      const d = DEMO[Number(el.dataset.demo)]
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
    }
  })
}
