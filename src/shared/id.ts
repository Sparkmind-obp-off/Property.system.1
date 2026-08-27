/**
 * ULID-like sortable identifier generation using Web Crypto only
 * (no Node APIs — Cloudflare Workers runtime).
 * Traceability: PS-DATA-009 §3 (ID may be UUID/ULID)
 */

const ENCODING = '0123456789ABCDEFGHJKMNPQRSTVWXYZ' // Crockford base32

function encodeTime(now: number, len = 10): string {
  let out = ''
  let t = now
  for (let i = len - 1; i >= 0; i--) {
    out = ENCODING[t % 32] + out
    t = Math.floor(t / 32)
  }
  return out
}

function encodeRandom(len = 16): string {
  const bytes = new Uint8Array(len)
  crypto.getRandomValues(bytes)
  let out = ''
  for (let i = 0; i < len; i++) out += ENCODING[bytes[i] % 32]
  return out
}

/** Monotonic-ish, lexicographically sortable 26-char ID. */
export function ulid(): string {
  return encodeTime(Date.now()) + encodeRandom()
}

/** Prefixed id for readability in logs/URLs, e.g. prp_01H... */
export function newId(prefix: string): string {
  return `${prefix}_${ulid()}`
}

export const ID = {
  user: () => newId('usr'),
  role: () => newId('rol'),
  userRole: () => newId('url'),
  permission: () => newId('prm'),
  rolePermission: () => newId('rpm'),
  property: () => newId('prp'),
  analysis: () => newId('ana'),
  marketArea: () => newId('mkt'),
  business: () => newId('biz'),
  segment: () => newId('seg'),
  tenant: () => newId('tnt'),
  match: () => newId('mtc'),
  offer: () => newId('ofr'),
  campaign: () => newId('cmp'),
  lead: () => newId('led'),
  qualification: () => newId('qlf'),
  activity: () => newId('act'),
  followUp: () => newId('fup'),
  visit: () => newId('vst'),
  negotiation: () => newId('ngt'),
  negotiationRound: () => newId('nrd'),
  rental: () => newId('rnt'),
  audit: () => newId('adt'),
  analytics: () => newId('anl'),
  notification: () => newId('ntf'),
  request: () => newId('req')
}
