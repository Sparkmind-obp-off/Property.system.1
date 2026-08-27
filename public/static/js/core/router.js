/**
 * Hash router — maps a URL to a screen module.
 * Traceability: PS-UX-010 §7 (information architecture), §46 (screen contract)
 *
 * Navigation follows user workflows, not database entities (MASTER §22).
 */

const routes = []
let current = null
let notFoundHandler = null

/** Register a route: pattern '/leads/:id' → handler({ params, query, mount }). */
export function route(pattern, handler, meta = {}) {
  const keys = []
  const rx = new RegExp(
    '^' +
      pattern
        .replace(/\/:([A-Za-z0-9_]+)/g, (_, k) => {
          keys.push(k)
          return '/([^/]+)'
        })
        .replace(/\//g, '\\/') +
      '$'
  )
  routes.push({ pattern, rx, keys, handler, meta })
}

export function setNotFound(fn) {
  notFoundHandler = fn
}

export function parseHash(hash) {
  const raw = (hash || location.hash || '#/dashboard').replace(/^#/, '')
  const [path, search] = raw.split('?')
  const query = {}
  new URLSearchParams(search || '').forEach((v, k) => {
    query[k] = v
  })
  return { path: path || '/dashboard', query }
}

export function navigate(path, query) {
  const sp = new URLSearchParams()
  for (const [k, v] of Object.entries(query || {})) {
    if (v !== undefined && v !== null && v !== '') sp.append(k, v)
  }
  const s = sp.toString()
  location.hash = `#${path}${s ? `?${s}` : ''}`
}

/** Replace the query string of the current route without adding history noise. */
export function replaceQuery(query) {
  const { path } = parseHash()
  const sp = new URLSearchParams()
  for (const [k, v] of Object.entries(query || {})) {
    if (v !== undefined && v !== null && v !== '') sp.append(k, v)
  }
  const s = sp.toString()
  history.replaceState(null, '', `#${path}${s ? `?${s}` : ''}`)
}

export function currentRoute() {
  return current
}

export function resolve(path) {
  for (const r of routes) {
    const m = path.match(r.rx)
    if (m) {
      const params = {}
      r.keys.forEach((k, i) => {
        params[k] = decodeURIComponent(m[i + 1])
      })
      return { ...r, params }
    }
  }
  return null
}

export async function dispatch() {
  const { path, query } = parseHash()
  const match = resolve(path)
  current = { path, query, match }
  if (!match) {
    if (notFoundHandler) notFoundHandler({ path })
    return
  }
  await match.handler({ params: match.params, query, path, meta: match.meta })
}

export function startRouter() {
  window.addEventListener('hashchange', () => {
    dispatch().catch((e) => console.error('[router]', e))
  })
  return dispatch()
}
