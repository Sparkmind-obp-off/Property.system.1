/**
 * Admin Setup / System Status.
 * Traceability: PS-MASTER-001 §9 (admin setup dashboard), §7 (user management
 *               happens in the app, not in Cloudflare), §8 (first-login
 *               rotation), §5 (no secret is ever displayed)
 *
 * This screen renders ONLY the status payload returned by
 * GET /api/v1/system/status. That endpoint is built so it cannot carry a secret
 * value, a password hash, a token, or an API key — so there is nothing here to
 * accidentally leak.
 */
import { api, errorText, session } from '../core/api.js'
import {
  badge,
  errorState,
  esc,
  field,
  fmtDateTime,
  loadingState,
  num,
  openModal,
  readForm,
  relTime,
  toast
} from '../core/dom.js'
import { screenEl, setHeader } from '../core/shell.js'

const STATE_COPY = {
  COMPLETE: {
    tone: 'ok',
    label: 'COMPLETE',
    text: 'Akun ADMIN awal sudah ada. Redeploy tidak akan membuat ulang atau menimpa kredensialnya.'
  },
  NOT_CONFIGURED: {
    tone: 'warn',
    label: 'NOT CONFIGURED',
    text: 'ADMIN_EMAIL dan ADMIN_PASSWORD belum diset pada environment ini, sehingga akun ADMIN awal belum dapat dibuat.'
  },
  INVALID_CONFIGURATION: {
    tone: 'danger',
    label: 'INVALID CONFIGURATION',
    text: 'Variabel bootstrap sudah ada tetapi tidak valid. Perbaiki nilainya di Cloudflare lalu coba login kembali.'
  },
  FAILED: {
    tone: 'danger',
    label: 'FAILED',
    text: 'Bootstrap belum berhasil menyelesaikan pembuatan akun ADMIN. Periksa log deployment.'
  }
}

export async function systemStatusScreen() {
  const el = screenEl()

  setHeader({
    title: 'Admin Setup & Status Sistem',
    subtitle: 'Kondisi operasional deployment — nilai rahasia tidak pernah ditampilkan di sini',
    actions: `
      <a class="btn" href="#/settings/users"><i class="fa-solid fa-user-shield"></i>Pengguna</a>
      <button class="btn" data-action="refresh"><i class="fa-solid fa-rotate-right"></i>Muat ulang</button>`
  })
  document
    .querySelector('#page-actions [data-action="refresh"]')
    ?.addEventListener('click', () => systemStatusScreen())

  el.innerHTML = loadingState('Membaca status sistem…')

  let status
  try {
    status = (await api.get('/system/status')).data
  } catch (err) {
    el.innerHTML = errorState(err)
    el.querySelector('[data-action="retry"]')?.addEventListener('click', () => systemStatusScreen())
    return
  }

  const bs = STATE_COPY[status.bootstrap?.status] || STATE_COPY.FAILED
  const dbOk = status.database?.status === 'CONNECTED'
  const authOk = status.authentication?.status === 'ACTIVE'

  el.innerHTML = `
    <section class="stack">
      <div class="grid cols-4">
        ${statusCard('Aplikasi', status.application, status.application === 'READY' ? 'ok' : 'warn', `versi ${esc(status.version || '—')}`)}
        ${statusCard('Database', status.database?.status || '—', dbOk ? 'ok' : 'danger', dbOk ? `${num(status.database.migrations_applied)} tabel` : esc(status.database?.error || 'tidak tersedia'))}
        ${statusCard('Autentikasi', status.authentication?.status || '—', authOk ? 'ok' : 'warn', `token ${num(Math.round((status.authentication?.token_ttl_seconds || 0) / 3600))} jam`)}
        ${statusCard('Bootstrap', bs.label, bs.tone, status.bootstrap?.completed_at ? esc(relTime(status.bootstrap.completed_at)) : 'belum selesai')}
      </div>

      ${status.bootstrap?.password_rotation_pending ? rotationWarning() : ''}
      ${!authOk ? jwtWarning() : ''}

      <div class="card">
        <div class="card-head"><h2>Bootstrap Administrator</h2>${badge(bs.label, { tone: bs.tone })}</div>
        <div class="card-body">
          <div class="inline-info">${esc(bs.text)}</div>
          <div class="kv"><span>Admin bootstrap</span><b>${esc(status.bootstrap?.admin_email || '—')}</b></div>
          <div class="kv"><span>Selesai pada</span><b>${esc(status.bootstrap?.completed_at ? fmtDateTime(status.bootstrap.completed_at) : '—')}</b></div>
          <div class="kv"><span>Jumlah ADMIN aktif</span><b>${num(status.bootstrap?.admin_count || 0)}</b></div>
          ${status.bootstrap?.reason ? `<div class="inline-warn" style="margin-top:10px"><i class="fa-solid fa-circle-exclamation"></i>${esc(status.bootstrap.reason)}</div>` : ''}
        </div>
        <div class="card-foot">
          <span class="tiny dim">
            ADMIN_EMAIL dan ADMIN_PASSWORD adalah input konfigurasi sekali pakai. Nilainya tidak
            disimpan, tidak dikembalikan API, dan tidak dapat dilihat dari aplikasi. Pengelolaan
            pengguna sehari-hari dilakukan di layar Pengguna &amp; Peran, bukan di Cloudflare.
          </span>
        </div>
      </div>

      <div class="card">
        <div class="card-head"><h2>Populasi Pengguna</h2><span class="badge">${num(status.users?.total || 0)} akun</span></div>
        <div class="card-body">
          <div class="kv"><span>Aktif</span><b>${num(status.users?.active || 0)}</b></div>
          <div class="kv"><span>Nonaktif</span><b>${num(status.users?.inactive || 0)}</b></div>
          <div class="sub-head" style="margin-top:12px">Distribusi peran</div>
          <div class="chips">
            ${Object.entries(status.users?.by_role || {})
              .map(([role, count]) => `<span class="chip">${esc(role)} · ${num(count)}</span>`)
              .join('') || '<span class="dim tiny">belum ada peran terisi</span>'}
          </div>
        </div>
      </div>

      <div class="card">
        <div class="card-head"><h2>Keamanan Akun Anda</h2></div>
        <div class="card-body">
          <div class="inline-info">
            Ganti kata sandi Anda sendiri. Kata sandi lama wajib dimasukkan, dan nilai baru
            hanya dikirim sekali ke server lalu disimpan sebagai hash.
          </div>
          <button class="btn primary" id="sys-change-pwd">
            <i class="fa-solid fa-key"></i>Ganti Kata Sandi Saya</button>
        </div>
      </div>
    </section>`

  el.querySelector('#sys-change-pwd')?.addEventListener('click', () =>
    openChangePasswordForm(() => systemStatusScreen())
  )
  el.querySelector('[data-action="rotate-now"]')?.addEventListener('click', () =>
    openChangePasswordForm(() => systemStatusScreen())
  )
}

function statusCard(label, value, tone, sub) {
  return `<div class="kpi">
    <div class="k-label">${esc(label)}</div>
    <div class="k-value" style="font-size:18px">${badge(String(value), { tone })}</div>
    <div class="k-sub">${sub}</div>
  </div>`
}

function rotationWarning() {
  return `<div class="consequence">
    <i class="fa-solid fa-triangle-exclamation"></i>
    Masih ada akun aktif yang memakai kredensial bootstrap/reset dan belum dirotasi.
    Kredensial bootstrap hanya untuk login pertama — ganti sekarang.
    <button class="btn sm" data-action="rotate-now" style="margin-left:10px">
      <i class="fa-solid fa-key"></i>Ganti sekarang</button>
  </div>`
}

function jwtWarning() {
  return `<div class="consequence">
    <i class="fa-solid fa-triangle-exclamation"></i>
    JWT_SECRET belum diset sebagai secret produksi, sehingga sistem memakai kunci
    pengembangan. Set secret tersebut di Cloudflare lalu deploy ulang.
  </div>`
}

/* ------------------------- Self-service rotation (§8) --------------------- */

export function openChangePasswordForm(onDone, { forced = false } = {}) {
  openModal({
    title: forced ? 'Rotasi Kata Sandi Wajib' : 'Ganti Kata Sandi',
    body: `
      <form id="cp-form" novalidate>
        <div id="cp-error"></div>
        ${
          forced
            ? `<div class="consequence"><i class="fa-solid fa-circle-exclamation"></i>
                 Akun ini masih memakai kredensial bootstrap atau hasil reset administrator.
                 Kata sandi harus diganti sebelum melanjutkan.</div>`
            : ''
        }
        <div class="form-grid">
          ${field({ name: 'current_password', label: 'Kata sandi saat ini', type: 'password', required: true, full: true })}
          ${field({
            name: 'new_password',
            label: 'Kata sandi baru',
            type: 'password',
            required: true,
            full: true,
            hint: 'Minimal 12 karakter dan harus berbeda dari kata sandi saat ini.'
          })}
          ${field({ name: 'confirm_password', label: 'Ulangi kata sandi baru', type: 'password', required: true, full: true })}
        </div>
      </form>`,
    footer: `
      ${forced ? '' : '<button class="btn" data-modal-close>Batal</button>'}
      <button class="btn primary" id="cp-save"><i class="fa-solid fa-key"></i>Simpan</button>`,
    onMount(root, close) {
      const form = root.querySelector('#cp-form')
      const errBox = root.querySelector('#cp-error')
      const btn = root.querySelector('#cp-save')

      btn.addEventListener('click', async () => {
        errBox.innerHTML = ''
        const raw = readForm(form)
        if (!raw.new_password || raw.new_password.length < 12) {
          errBox.innerHTML = '<div class="inline-error">Kata sandi baru minimal 12 karakter.</div>'
          return
        }
        if (raw.new_password !== raw.confirm_password) {
          errBox.innerHTML = '<div class="inline-error">Konfirmasi kata sandi tidak sama.</div>'
          return
        }

        btn.disabled = true
        btn.innerHTML = '<i class="fa-solid fa-spinner fa-spin"></i> Menyimpan…'
        try {
          await api.post('/auth/change-password', {
            current_password: raw.current_password,
            new_password: raw.new_password
          })
          // Refresh the cached session so the forced-rotation gate clears.
          try {
            const { data } = await api.auth.me()
            session.save(session.token, data)
          } catch {
            /* the token stays valid; the next request will refresh it */
          }
          toast('Kata sandi diperbarui.', 'ok')
          close()
          onDone?.()
        } catch (err) {
          btn.disabled = false
          btn.innerHTML = '<i class="fa-solid fa-key"></i>Simpan'
          errBox.innerHTML = `<div class="inline-error">${esc(errorText(err))}</div>`
        } finally {
          // Never leave plaintext in the DOM (§5).
          form.querySelectorAll('input[type="password"]').forEach((i) => (i.value = ''))
        }
      })
    }
  })
}
