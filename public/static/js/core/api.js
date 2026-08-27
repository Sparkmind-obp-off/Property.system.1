/**
 * API client — the single boundary between UI and /api/v1.
 * Traceability: PS-UX-010 §46 (screen→API contract) | PS-MASTER-001 §35, §39
 *
 * Rule: the frontend reacts to stable machine-readable error CODES, never to
 * parsed message text (§35).
 */
const BASE = '/api/v1'
const TOKEN_KEY = 'ps.token'
const USER_KEY = 'ps.user'

export const ErrorCodes = {
  VALIDATION_ERROR: 'VALIDATION_ERROR',
  UNAUTHORIZED: 'UNAUTHORIZED',
  FORBIDDEN: 'FORBIDDEN',
  NOT_FOUND: 'NOT_FOUND',
  CONFLICT: 'CONFLICT',
  BUSINESS_RULE_VIOLATION: 'BUSINESS_RULE_VIOLATION',
  INTERNAL_ERROR: 'INTERNAL_ERROR',
  NETWORK_ERROR: 'NETWORK_ERROR'
}

export class ApiError extends Error {
  constructor(code, message, details, status, rule) {
    super(message || 'Request failed')
    this.code = code || ErrorCodes.INTERNAL_ERROR
    this.details = details || {}
    this.status = status || 0
    this.rule = rule || null
  }

  get isAuth() {
    return this.code === ErrorCodes.UNAUTHORIZED
  }
  get isForbidden() {
    return this.code === ErrorCodes.FORBIDDEN
  }
  get isNotFound() {
    return this.code === ErrorCodes.NOT_FOUND
  }
  get isValidation() {
    return this.code === ErrorCodes.VALIDATION_ERROR
  }
  get isBusinessRule() {
    return this.code === ErrorCodes.BUSINESS_RULE_VIOLATION || this.code === ErrorCodes.CONFLICT
  }
}

export const session = {
  get token() {
    return localStorage.getItem(TOKEN_KEY)
  },
  get user() {
    try {
      return JSON.parse(localStorage.getItem(USER_KEY) || 'null')
    } catch {
      return null
    }
  },
  save(token, user) {
    localStorage.setItem(TOKEN_KEY, token)
    localStorage.setItem(USER_KEY, JSON.stringify(user))
  },
  clear() {
    localStorage.removeItem(TOKEN_KEY)
    localStorage.removeItem(USER_KEY)
  },
  /** UI permission check — a usability layer only; the server is authority. */
  can(...perms) {
    const u = this.user
    if (!u) return false
    return perms.every((p) => (u.permissions || []).includes(p))
  },
  canAny(...perms) {
    const u = this.user
    if (!u) return false
    return perms.some((p) => (u.permissions || []).includes(p))
  },
  hasRole(...roles) {
    const u = this.user
    if (!u) return false
    return (u.roles || []).some((r) => roles.includes(r))
  }
}

let onUnauthorized = () => {}
export function setUnauthorizedHandler(fn) {
  onUnauthorized = fn
}

function qs(params) {
  if (!params) return ''
  const sp = new URLSearchParams()
  for (const [k, v] of Object.entries(params)) {
    if (v === undefined || v === null || v === '') continue
    if (Array.isArray(v)) v.forEach((x) => sp.append(k, x))
    else sp.append(k, v)
  }
  const s = sp.toString()
  return s ? `?${s}` : ''
}

async function request(method, path, { body, params, silent } = {}) {
  const headers = { Accept: 'application/json' }
  if (body !== undefined) headers['Content-Type'] = 'application/json'
  const token = session.token
  if (token) headers.Authorization = `Bearer ${token}`

  let res
  try {
    res = await fetch(`${BASE}${path}${qs(params)}`, {
      method,
      headers,
      body: body === undefined ? undefined : JSON.stringify(body)
    })
  } catch (e) {
    throw new ApiError(ErrorCodes.NETWORK_ERROR, 'Tidak dapat menghubungi server.', {}, 0)
  }

  let payload = null
  const text = await res.text()
  if (text) {
    try {
      payload = JSON.parse(text)
    } catch {
      payload = null
    }
  }

  if (!res.ok) {
    const err = payload && payload.error ? payload.error : {}
    const apiErr = new ApiError(err.code, err.message, err.details, res.status, err.rule)
    if (apiErr.isAuth && !silent) {
      session.clear()
      onUnauthorized()
    }
    throw apiErr
  }

  return payload || { data: null, meta: {} }
}

export const api = {
  get: (path, params) => request('GET', path, { params }),
  post: (path, body, params) => request('POST', path, { body: body ?? {}, params }),
  patch: (path, body) => request('PATCH', path, { body: body ?? {} }),
  put: (path, body) => request('PUT', path, { body: body ?? {} }),
  del: (path) => request('DELETE', path),

  /* --------------------------------- Auth -------------------------------- */
  auth: {
    async login(email, password) {
      const { data } = await request('POST', '/auth/login', { body: { email, password }, silent: true })
      session.save(data.token, data.user)
      return data.user
    },
    async logout() {
      try {
        await request('POST', '/auth/logout', { body: {}, silent: true })
      } catch {
        /* logout is best-effort; the local session is cleared regardless */
      }
      session.clear()
    },
    me: () => request('GET', '/auth/me', { silent: true })
  }
}

/** Human-readable label for an ApiError, used by inline error blocks. */
export function errorText(err) {
  if (!(err instanceof ApiError)) return err?.message || 'Terjadi kesalahan.'
  switch (err.code) {
    case ErrorCodes.NETWORK_ERROR:
      return 'Koneksi ke server gagal. Periksa jaringan lalu coba lagi.'
    case ErrorCodes.FORBIDDEN:
      return err.message || 'Anda tidak memiliki izin untuk tindakan ini.'
    case ErrorCodes.NOT_FOUND:
      return err.message || 'Data tidak ditemukan.'
    case ErrorCodes.VALIDATION_ERROR: {
      const fields = Object.entries(err.details || {})
        .map(([k, v]) => `${k}: ${v}`)
        .join(' · ')
      return fields ? `${err.message} (${fields})` : err.message
    }
    default:
      return err.message || 'Terjadi kesalahan.'
  }
}
