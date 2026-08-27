/**
 * Password hashing (PBKDF2-SHA256) and JWT (HS256) using Web Crypto only.
 * Traceability: PS-TECH-008 §13, §28 | PS-MASTER-001 §45
 *
 * No Node crypto, no external deps — runs inside Cloudflare Workers.
 */
import { UnauthorizedError } from './errors'

const PBKDF2_ITERATIONS = 100_000
const enc = new TextEncoder()
const dec = new TextDecoder()

/* ------------------------------- base64url ------------------------------- */

function bytesToB64url(bytes: Uint8Array): string {
  let bin = ''
  for (const b of bytes) bin += String.fromCharCode(b)
  return btoa(bin).replace(/\+/g, '-').replace(/\//g, '_').replace(/=+$/, '')
}

function b64urlToBytes(s: string): Uint8Array {
  const pad = s.length % 4 === 0 ? '' : '='.repeat(4 - (s.length % 4))
  const bin = atob(s.replace(/-/g, '+').replace(/_/g, '/') + pad)
  const out = new Uint8Array(bin.length)
  for (let i = 0; i < bin.length; i++) out[i] = bin.charCodeAt(i)
  return out
}

/* ---------------------------- password hashing ---------------------------- */

/** Returns "pbkdf2$<iterations>$<saltB64>$<hashB64>". */
export async function hashPassword(password: string): Promise<string> {
  const salt = new Uint8Array(16)
  crypto.getRandomValues(salt)
  const bits = await deriveBits(password, salt, PBKDF2_ITERATIONS)
  return `pbkdf2$${PBKDF2_ITERATIONS}$${bytesToB64url(salt)}$${bytesToB64url(new Uint8Array(bits))}`
}

export async function verifyPassword(password: string, stored: string): Promise<boolean> {
  const parts = stored.split('$')
  if (parts.length !== 4 || parts[0] !== 'pbkdf2') return false
  const iterations = Number(parts[1])
  const salt = b64urlToBytes(parts[2])
  const expected = b64urlToBytes(parts[3])
  const bits = new Uint8Array(await deriveBits(password, salt, iterations))
  return timingSafeEqual(bits, expected)
}

async function deriveBits(password: string, salt: Uint8Array, iterations: number): Promise<ArrayBuffer> {
  const key = await crypto.subtle.importKey('raw', enc.encode(password), 'PBKDF2', false, ['deriveBits'])
  return crypto.subtle.deriveBits(
    { name: 'PBKDF2', salt, iterations, hash: 'SHA-256' },
    key,
    256
  )
}

function timingSafeEqual(a: Uint8Array, b: Uint8Array): boolean {
  if (a.length !== b.length) return false
  let diff = 0
  for (let i = 0; i < a.length; i++) diff |= a[i] ^ b[i]
  return diff === 0
}

/* ---------------------------------- JWT ---------------------------------- */

export interface JwtPayload {
  sub: string
  email: string
  name: string
  roles: string[]
  permissions: string[]
  iat: number
  exp: number
}

async function hmacKey(secret: string): Promise<CryptoKey> {
  return crypto.subtle.importKey('raw', enc.encode(secret), { name: 'HMAC', hash: 'SHA-256' }, false, [
    'sign',
    'verify'
  ])
}

export async function signJwt(
  payload: Omit<JwtPayload, 'iat' | 'exp'>,
  secret: string,
  ttlSeconds: number
): Promise<string> {
  const now = Math.floor(Date.now() / 1000)
  const full: JwtPayload = { ...payload, iat: now, exp: now + ttlSeconds }
  const header = bytesToB64url(enc.encode(JSON.stringify({ alg: 'HS256', typ: 'JWT' })))
  const body = bytesToB64url(enc.encode(JSON.stringify(full)))
  const data = `${header}.${body}`
  const sig = await crypto.subtle.sign('HMAC', await hmacKey(secret), enc.encode(data))
  return `${data}.${bytesToB64url(new Uint8Array(sig))}`
}

export async function verifyJwt(token: string, secret: string): Promise<JwtPayload> {
  const parts = token.split('.')
  if (parts.length !== 3) throw new UnauthorizedError('Malformed token.')
  const data = `${parts[0]}.${parts[1]}`
  const valid = await crypto.subtle.verify(
    'HMAC',
    await hmacKey(secret),
    b64urlToBytes(parts[2]),
    enc.encode(data)
  )
  if (!valid) throw new UnauthorizedError('Invalid token signature.')

  let payload: JwtPayload
  try {
    payload = JSON.parse(dec.decode(b64urlToBytes(parts[1])))
  } catch {
    throw new UnauthorizedError('Malformed token payload.')
  }
  if (payload.exp <= Math.floor(Date.now() / 1000)) {
    throw new UnauthorizedError('Session expired. Please sign in again.')
  }
  return payload
}
